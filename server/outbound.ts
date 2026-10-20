import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import { authorize } from "./policy";
import { resolveContact } from "./people";
import { compileSegment, contactFacts } from "./segments";
import { effectiveSubscriptions } from "./subscriptions";
import { matches, PREDEFINED, type SegmentDefinition } from "../lib/segments";
import { blankDefinition, bucket, goalReadout, inQuietHours, outboundProblems, sendTimeMatches, type OutboundDefinition, type PageContext } from "../lib/outbound";

/**
 * The outbound engine (phase 13, step O2; docs/OUTBOUND_STEP2.md), behind `outbound_v1` (and
 * `segments_v1`), with its first type, the in-app chat message.
 *
 * Every message type goes through `admit`, one transaction per contact:
 * 1. the contact's lock row is taken (`FOR UPDATE`), so caps hold when many messages match at once;
 * 2. an entry already decided by its re-entry key isn't decided again;
 * 3. the holdout (a stable bucket) is entered but never sent;
 * 4. the subscription type must be theirs (no bypass);
 * 5. quiet hours in their timezone, the workspace's cap and the message's cap are respected
 *    (the entry waits);
 * 6. then the type delivers it, and the ledger says so.
 *
 * In-app messages are delivered when the messenger asks what's due (`dueInApp`): a page view, with
 * its send-time rules. Audiences: a one-off's is fixed when it goes live (`outbound.launch`, in
 * batches), an ongoing one's is whoever matches when they visit, an event's is each event (after
 * its delay), a recurring one's is each occurrence (the sweep). A contact who entered stays on
 * that version.
 */
const DAY = 86_400_000;
type Live = { id: string; title: string; version: number; def: OutboundDefinition; effective_at: Date };
type Settings = { cap_count: number; cap_days: number; quiet_start: string; quiet_end: string; timezone: string };

export async function outboundOn(db: Sql, w: string) {
  return (
    (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_features WHERE workspace_id=$1 AND enabled AND name IN ('segments_v1','outbound_v1')", [w])).rows[0].n === 2
  );
}
async function settingsOf(db: Sql, w: string): Promise<Settings> {
  await db.query("INSERT INTO outbound_settings(workspace_id) VALUES($1) ON CONFLICT DO NOTHING", [w]);
  return (await db.query<Settings>("SELECT cap_count,cap_days,quiet_start,quiet_end,timezone FROM outbound_settings WHERE workspace_id=$1", [w])).rows[0];
}

/** Live messages, each at the version in force `now` (an edit can be scheduled), within start and stop. */
async function liveMessages(db: Sql, w: string, now: Date, id?: string): Promise<Live[]> {
  const rows = (
    await db.query<{ id: string; title: string; version: number; definition: OutboundDefinition; effective_at: Date }>(
      `SELECT m.id,m.title,v.version,v.definition,v.effective_at FROM outbound_messages m
       JOIN LATERAL (SELECT version,definition,effective_at FROM outbound_versions v WHERE v.workspace_id=m.workspace_id AND v.message_id=m.id AND v.effective_at<=$2 ORDER BY version DESC LIMIT 1) v ON true
       WHERE m.workspace_id=$1 AND m.state='live' AND ($3::text IS NULL OR m.id=$3) ORDER BY m.created_at,m.id`,
      [w, now.toISOString(), id ?? null],
    )
  ).rows;
  return rows
    .map((r) => ({ id: r.id, title: r.title, version: r.version, def: r.definition, effective_at: r.effective_at }))
    .filter((m) => (!m.def.startAt || Date.parse(m.def.startAt) <= now.getTime()) && (!m.def.stopAt || Date.parse(m.def.stopAt) > now.getTime()));
}
async function versionOf(db: Sql, w: string, messageId: string, version: number) {
  return (await db.query<{ definition: OutboundDefinition }>("SELECT definition FROM outbound_versions WHERE workspace_id=$1 AND message_id=$2 AND version=$3", [w, messageId, version])).rows[0]?.definition;
}

/** The audience's two halves: its segment (predefined or saved) and its own rules. */
async function audienceOf(db: Sql, w: string, def: OutboundDefinition): Promise<SegmentDefinition[]> {
  const out: SegmentDefinition[] = [def.audience.rules];
  const id = def.audience.segmentId;
  if (id) {
    const pre = PREDEFINED.find((s) => s.id === id)?.definition;
    const saved = pre ? null : (await db.query<{ definition: SegmentDefinition }>("SELECT definition FROM segments WHERE workspace_id=$1 AND id=$2", [w, id])).rows[0]?.definition;
    // An archived segment's message reaches nobody, rather than everybody.
    out.push(pre ?? saved ?? { match: "all", rules: [{ field: "role", op: "is", value: "nobody" }] });
  }
  return out;
}
async function inAudience(db: Sql, w: string, def: OutboundDefinition, contactId: string, now: number) {
  for (const part of await audienceOf(db, w, def)) if (!matches(part, await contactFacts(db, w, contactId, part), now)) return false;
  return true;
}
/** The contacts an audience reaches now, as SQL (for the live size, and a fixed audience's snapshot). */
async function audienceWhere(db: Sql, w: string, def: OutboundDefinition, params: unknown[], now: number) {
  const parts = await audienceOf(db, w, def);
  return `c.workspace_id=$1 AND c.merged_into_contact_id IS NULL AND ${parts.map((p) => compileSegment(p, params, now)).join(" AND ")}`;
}

/** Each entry's key: once ever, once a period, or every occurrence. */
export function entryKey(def: OutboundDefinition, contactId: string, occurrence: string, now: number) {
  if (def.reentry.mode === "once") return `c:${contactId}`;
  if (def.reentry.mode === "period") return `c:${contactId}:p:${Math.floor(now / ((def.reentry.days ?? 1) * DAY))}`;
  return `c:${contactId}:o:${occurrence || crypto.randomUUID()}`;
}

export type Admitted = { status: "sent" | "held_out" | "suppressed" | "later" | "already"; reason: string; entryId?: string; conversationId?: string };
type Deliver = (db: Sql, entryId: string) => Promise<{ channel: string; conversationId: string | null; partId: string | null } | { refused: string }>;

/** The one decision, per contact and entry (see above). `deliver` is the type's. */
export async function admit(db: Sql, w: string, m: Live, def: OutboundDefinition, version: number, contactId: string, key: string, deliver: Deliver, now = new Date(), occurrence = ""): Promise<Admitted> {
  await db.query("INSERT INTO outbound_contact_locks(workspace_id,contact_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [w, contactId]);
  await db.query("SELECT 1 FROM outbound_contact_locks WHERE workspace_id=$1 AND contact_id=$2 FOR UPDATE", [w, contactId]);
  const existing = (await db.query<{ id: string; status: string }>("SELECT id,status FROM outbound_entries WHERE workspace_id=$1 AND message_id=$2 AND entry_key=$3", [w, m.id, key])).rows[0];
  if (existing && existing.status !== "pending") return { status: "already", reason: "", entryId: existing.id };
  const entryId = existing?.id ?? crypto.randomUUID();
  const write = async (status: string, reason: string, extra: { channel?: string; conversationId?: string; partId?: string; variant?: string } = {}) => {
    if (existing)
      await db.query(
        "UPDATE outbound_entries SET status=$3,reason=$4,channel=$5,conversation_id=$6,part_id=$7,entered_at=CASE WHEN $3 IN ('sent','held_out') THEN $8::timestamptz ELSE entered_at END WHERE workspace_id=$1 AND id=$2",
        [w, entryId, status, reason, extra.channel ?? null, extra.conversationId ?? null, extra.partId ?? null, now.toISOString()],
      );
    else
      await db.query(
        `INSERT INTO outbound_entries(workspace_id,id,message_id,version,contact_id,entry_key,variant,status,reason,occurrence,channel,conversation_id,part_id,entered_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CASE WHEN $8 IN ('sent','held_out') THEN $14::timestamptz END)`,
        [w, entryId, m.id, version, contactId, key, extra.variant ?? "message", status, reason, occurrence, extra.channel ?? null, extra.conversationId ?? null, extra.partId ?? null, now.toISOString()],
      );
  };
  // The control group: entered (its goal is counted), never sent.
  if (def.holdoutPercent > 0 && (await bucket(contactId, m.id)) < def.holdoutPercent) {
    await write("held_out", "In the control group.", { variant: "control" });
    return { status: "held_out", reason: "In the control group.", entryId };
  }
  const type = (await db.query<{ name: string }>("SELECT name FROM subscription_types WHERE workspace_id=$1 AND id=$2", [w, def.subscriptionTypeId])).rows[0];
  if (!type || (await effectiveSubscriptions(db, w, contactId, [def.subscriptionTypeId]))[def.subscriptionTypeId] !== "opted_in") {
    const reason = `Not subscribed to ${type?.name ?? "its subscription"}.`;
    await write("suppressed", reason);
    return { status: "suppressed", reason, entryId };
  }
  const s = await settingsOf(db, w);
  const later = async (reason: string): Promise<Admitted> => {
    if (existing) await db.query("UPDATE outbound_entries SET reason=$3 WHERE workspace_id=$1 AND id=$2", [w, entryId, reason]);
    return { status: "later", reason };
  };
  if (def.quietHours) {
    const tz = (await db.query<{ origin_timezone: string | null }>("SELECT origin_timezone FROM contacts WHERE workspace_id=$1 AND id=$2", [w, contactId])).rows[0]?.origin_timezone || s.timezone;
    if (inQuietHours(now, tz, s.quiet_start, s.quiet_end)) return later("Quiet hours where they are.");
  }
  const sentSince = async (days: number, messageId: string | null) =>
    (
      await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM outbound_entries WHERE workspace_id=$1 AND contact_id=$2 AND status='sent' AND entered_at>$3 AND ($4::text IS NULL OR message_id=$4)",
        [w, contactId, new Date(now.getTime() - days * DAY).toISOString(), messageId],
      )
    ).rows[0].n;
  if ((await sentSince(s.cap_days, null)) >= s.cap_count) return later(`Over the workspace's cap (${s.cap_count} in ${s.cap_days} days).`);
  if (def.cap && (await sentSince(def.cap.days, m.id)) >= def.cap.count) return later(`Over this message's cap (${def.cap.count} in ${def.cap.days} days).`);
  // The entry exists before delivery, so what's delivered can point back to it.
  if (!existing) await write("pending", "");
  const d = await deliver(db, entryId);
  if ("refused" in d) {
    await db.query("UPDATE outbound_entries SET status='suppressed',reason=$3 WHERE workspace_id=$1 AND id=$2", [w, entryId, d.refused]);
    return { status: "suppressed", reason: d.refused, entryId };
  }
  await db.query("UPDATE outbound_entries SET status='sent',reason='',channel=$3,conversation_id=$4,part_id=$5,entered_at=$6 WHERE workspace_id=$1 AND id=$2", [
    w,
    entryId,
    d.channel,
    d.conversationId,
    d.partId,
    now.toISOString(),
  ]);
  return { status: "sent", reason: "", entryId, conversationId: d.conversationId ?? undefined };
}

/** The in-app chat: a conversation from its sender, closed until they reply (then it's the team's). */
function chatDelivery(w: string, m: Live, def: OutboundDefinition, version: number, identityId: string, brandId: string): Deliver {
  return async (db, entryId) => {
    const sender = (await db.query<{ id: string; name: string }>("SELECT id,name FROM teammates WHERE workspace_id=$1 AND id=$2", [w, def.content.senderId])).rows[0];
    if (!sender) return { refused: "Its sender isn't a teammate any more." };
    const { append } = await import("./conversations");
    const { customerReply } = await import("./unread");
    const id = crypto.randomUUID();
    const c = (
      await db.query(
        `INSERT INTO conversations(workspace_id,id,brand_id,primary_identity_id,token_hash,name,email,title,channel,current_channel,status,outbound_message_id,created_at,updated_at)
         VALUES($1,$2,$3,$4,'','Customer','',$5,'messenger','messenger','closed',$6,now(),now()) RETURNING *`,
        [w, id, brandId, identityId, (m.title || def.content.text).slice(0, 70), m.id],
      )
    ).rows[0];
    const part = await append(db, w, c as never, { type: "teammate", id: sender.id, name: sender.name }, "teammate_reply", def.content.text, { outbound: { messageId: m.id, version, entryId } });
    await customerReply(db, w, c as never, part.seq);
    return { channel: "in_app", conversationId: id, partId: part.id };
  };
}

type Try = { m: Live; def: OutboundDefinition; version: number; key: string; occurrence: string };
/** Who's asking, on what page, and the live messages of a type they could get, in order. */
async function prepare(db: Sql, w: string, identityId: string, type: OutboundDefinition["type"], ctx: Omit<PageContext, "openConversation">, now: Date) {
  if (!(await outboundOn(db, w))) return null;
  const mapping = (await db.query<{ contact_id: string }>("SELECT contact_id FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2", [w, identityId])).rows[0];
  if (!mapping) return null;
  const contactId = await resolveContact(db, w, mapping.contact_id);
  const live = (await liveMessages(db, w, now)).filter((m) => m.def.type === type);
  if (!live.length) return null;
  const open =
    (
      await db.query(
        `SELECT 1 FROM conversations c JOIN identity_contact_mappings x ON x.workspace_id=c.workspace_id AND x.identity_id=c.primary_identity_id
         WHERE c.workspace_id=$1 AND x.contact_id=$2 AND c.status='open' AND c.merged_into_id IS NULL LIMIT 1`,
        [w, contactId],
      )
    ).rows.length > 0;
  return { contactId, live, page: { ...ctx, openConversation: open } as PageContext };
}
/** Entries waiting for them (on the version they entered) first, then ongoing messages they match now. */
async function tries(db: Sql, w: string, contactId: string, live: Live[], now: Date) {
  const pending = (
    await db.query<{ message_id: string; version: number; entry_key: string; occurrence: string }>(
      "SELECT message_id,version,entry_key,occurrence FROM outbound_entries WHERE workspace_id=$1 AND contact_id=$2 AND status='pending' AND due_at<=$3 AND message_id=ANY($4::text[]) ORDER BY due_at,id",
      [w, contactId, now.toISOString(), live.map((m) => m.id)],
    )
  ).rows;
  const out: Try[] = [];
  for (const e of pending) {
    const m = live.find((x) => x.id === e.message_id)!;
    const def = e.version === m.version ? m.def : await versionOf(db, w, m.id, e.version);
    if (def) out.push({ m, def, version: e.version, key: e.entry_key, occurrence: e.occurrence });
  }
  for (const m of live.filter((x) => x.def.delivery.mode === "ongoing"))
    if (await inAudience(db, w, m.def, contactId, now.getTime())) out.push({ m, def: m.def, version: m.version, key: entryKey(m.def, contactId, "", now.getTime()), occurrence: "" });
  return out;
}

/**
 * What the messenger shows now: at most one chat a page view. Entries waiting for this contact
 * (a fixed audience, an event, an occurrence) come first, on the version they entered; then
 * ongoing messages they match now. Send-time rules are checked against the page.
 */
export async function dueInApp(db: Sql, w: string, session: { identityId: string; brandId: string }, ctx: Omit<PageContext, "openConversation">, now = new Date()) {
  const p = await prepare(db, w, session.identityId, "chat", ctx, now);
  if (!p) return [];
  for (const t of await tries(db, w, p.contactId, p.live, now)) {
    if (!sendTimeMatches(t.def.audience.sendTime, p.page)) continue;
    const r = await admit(db, w, t.m, t.def, t.version, p.contactId, t.key, chatDelivery(w, t.m, t.def, t.version, session.identityId, session.brandId), now, t.occurrence);
    if (r.status === "sent") return [{ conversationId: r.conversationId!, entryId: r.entryId! }];
  }
  return [];
}

export type ShownBanner = { entryId: string; text: string; position: "top" | "bottom"; dismissible: boolean; action: { label: string; url: string } | null };
const shown = (entryId: string, def: OutboundDefinition): ShownBanner => ({
  entryId,
  text: def.content.text,
  position: def.content.position ?? "top",
  dismissible: def.content.dismissible !== false,
  action: def.content.action ?? null,
});
/**
 * O3: the banner for this page, at most one. A banner already shown to them stays on every page
 * its send-time rules allow until they close it (or it stops being live): shown once, counted
 * once. Otherwise a new one goes through `admit` (caps, quiet hours, subscription and all).
 */
export async function dueBanner(db: Sql, w: string, session: { identityId: string }, ctx: Omit<PageContext, "openConversation">, now = new Date()): Promise<ShownBanner[]> {
  const p = await prepare(db, w, session.identityId, "banner", ctx, now);
  if (!p) return [];
  const showing = (
    await db.query<{ id: string; message_id: string; version: number }>(
      "SELECT id,message_id,version FROM outbound_entries WHERE workspace_id=$1 AND contact_id=$2 AND status='sent' AND dismissed_at IS NULL AND message_id=ANY($3::text[]) ORDER BY entered_at DESC,id",
      [w, p.contactId, p.live.map((m) => m.id)],
    )
  ).rows;
  for (const e of showing) {
    const m = p.live.find((x) => x.id === e.message_id)!;
    const def = e.version === m.version ? m.def : await versionOf(db, w, m.id, e.version);
    if (def && sendTimeMatches(def.audience.sendTime, p.page)) return [shown(e.id, def)];
  }
  for (const t of await tries(db, w, p.contactId, p.live, now)) {
    if (!sendTimeMatches(t.def.audience.sendTime, p.page)) continue;
    const r = await admit(db, w, t.m, t.def, t.version, p.contactId, t.key, async () => ({ channel: "in_app", conversationId: null, partId: null }), now, t.occurrence);
    if (r.status === "sent") {
      await db.query("UPDATE outbound_entries SET seen_at=$3 WHERE workspace_id=$1 AND id=$2", [w, r.entryId, now.toISOString()]);
      return [shown(r.entryId!, t.def)];
    }
  }
  return [];
}

/**
 * O3: what the person did with an in-app message (`/v1/messenger/outbound`): clicked its action,
 * or closed it. Only their own entries; each is recorded once.
 */
export async function outboundAction(db: Sql, w: string, identityId: string, entryId: string, action: string) {
  assert(action === "clicked" || action === "dismissed", "INVALID_OUTBOUND", "Say clicked or dismissed.", 400);
  const mapping = (await db.query<{ contact_id: string }>("SELECT contact_id FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2", [w, identityId])).rows[0];
  const contactId = mapping ? await resolveContact(db, w, mapping.contact_id) : "";
  const e = (await db.query<{ id: string; message_id: string; version: number }>("SELECT id,message_id,version FROM outbound_entries WHERE workspace_id=$1 AND id=$2 AND contact_id=$3 AND status='sent'", [w, entryId, contactId])).rows[0];
  assert(e, "OUTBOUND_NOT_FOUND", "That message isn't yours.", 404);
  if (action === "dismissed") {
    const def = await versionOf(db, w, e.message_id, e.version);
    assert(def?.content.dismissible !== false, "OUTBOUND_NOT_DISMISSIBLE", "That banner can't be closed.", 409);
  }
  const column = action === "clicked" ? "clicked_at" : "dismissed_at";
  await db.query(`UPDATE outbound_entries SET ${column}=COALESCE(${column},now()) WHERE workspace_id=$1 AND id=$2`, [w, e.id]);
  return { ok: true };
}

/** Each entry starts pending, or in the control group (entered now, never sent). */
async function enter(db: Sql, w: string, m: { id: string }, def: OutboundDefinition, version: number, contactId: string, occurrence: string, dueAt: Date, now: Date) {
  const control = def.holdoutPercent > 0 && (await bucket(contactId, m.id)) < def.holdoutPercent;
  await db.query(
    `INSERT INTO outbound_entries(workspace_id,id,message_id,version,contact_id,entry_key,variant,status,reason,occurrence,due_at,entered_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (workspace_id,message_id,entry_key) DO NOTHING`,
    [
      w,
      crypto.randomUUID(),
      m.id,
      version,
      contactId,
      entryKey(def, contactId, occurrence, now.getTime()),
      control ? "control" : "message",
      control ? "held_out" : "pending",
      control ? "In the control group." : "",
      occurrence,
      dueAt.toISOString(),
      control ? now.toISOString() : null,
    ],
  );
}

/** `outbound.launch`: a fixed audience (a one-off, or one occurrence) entered, 500 at a time. */
export async function launchJob(connect: Connect, job: Job) {
  const w = job.workspace_id;
  const { messageId, version, occurrence } = job.payload as { messageId: string; version: number; occurrence: string };
  const after = String((job.result as { after?: string } | null)?.after ?? "");
  return tenant(connect, w, async (db) => {
    const def = await versionOf(db, w, messageId, version);
    if (!def || !(await outboundOn(db, w))) return { done: true, result: { entered: 0 } };
    const now = new Date();
    const params: unknown[] = [w];
    const where = await audienceWhere(db, w, def, params, now.getTime());
    params.push(after);
    const ids = (await db.query<{ id: string }>(`SELECT c.id FROM contacts c WHERE ${where} AND c.id>$${params.length} ORDER BY c.id LIMIT 500`, params)).rows.map((r) => r.id);
    for (const id of ids) await enter(db, w, { id: messageId }, def, version, id, occurrence, now, now);
    const entered = Number((job.result as { entered?: number } | null)?.entered ?? 0) + ids.length;
    return { done: ids.length < 500, result: { after: ids.at(-1) ?? after, entered } };
  });
}

/** Phase 13 O2: an event enters its contact into the live messages it sends (after their delay). */
export async function outboundOnEvent(db: Sql, w: string, contactId: string, name: string, eventId: string, occurredAt: Date) {
  if (!(await outboundOn(db, w))) return;
  const now = new Date();
  for (const m of await liveMessages(db, w, now))
    if (m.def.delivery.mode === "event" && m.def.delivery.event?.name === name && (await inAudience(db, w, m.def, contactId, now.getTime())))
      await enter(db, w, m, m.def, m.version, contactId, `event:${eventId}`, new Date(occurredAt.getTime() + m.def.delivery.event.delayMinutes * 60_000), now);
}

/** The local offset (minutes east of UTC) of `timezone` at `at`. */
function offsetMinutes(at: Date, timezone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000;
}
/** The latest daily or weekly slot at or before `now`, in `timezone`. */
export function lastSlot(every: NonNullable<OutboundDefinition["delivery"]["every"]>, timezone: string, now: Date) {
  const [hh, mm] = every.at.split(":").map(Number);
  for (let back = 0; back <= 8; back++) {
    const day = new Date(now.getTime() - back * DAY);
    const local = new Date(day.getTime() + offsetMinutes(day, timezone) * 60_000);
    const guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hh, mm);
    const slot = new Date(guess - offsetMinutes(new Date(guess), timezone) * 60_000);
    if (slot > now) continue;
    if (every.unit === "week" && local.getUTCDay() !== every.weekday) continue;
    return slot;
  }
  return null;
}

/**
 * The sweep: a one-off's audience is entered once it starts; each recurring occurrence once its
 * slot comes (never one from before its version went live).
 */
export async function outboundSweep(connect: Connect, w: string, now = new Date()) {
  return tenant(connect, w, async (db) => {
    if (!(await outboundOn(db, w))) return 0;
    const tz = (await settingsOf(db, w)).timezone;
    let launched = 0;
    for (const m of await liveMessages(db, w, now)) {
      let occurrence: string | null = null;
      if (m.def.delivery.mode === "once") occurrence = "launch";
      if (m.def.delivery.mode === "recurring") {
        const slot = lastSlot(m.def.delivery.every!, tz, now);
        if (slot && slot >= m.effective_at) occurrence = "at:" + slot.toISOString();
      }
      if (!occurrence) continue;
      const fresh = await db.query("INSERT INTO outbound_occurrences(workspace_id,message_id,occurrence,version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING occurrence", [w, m.id, occurrence, m.version]);
      if (!fresh.rows.length) continue;
      await enqueueJob(db, w, "outbound.launch", { messageId: m.id, version: m.version, occurrence }, {});
      launched++;
    }
    return launched;
  });
}

/** What the messenger tells: a chat seen (its conversation read), or replied to. */
export async function outboundSeen(db: Sql, w: string, conversationId: string) {
  await db.query("UPDATE outbound_entries SET seen_at=now() WHERE workspace_id=$1 AND conversation_id=$2 AND seen_at IS NULL", [w, conversationId]);
}
export async function outboundReplied(db: Sql, w: string, conversationId: string) {
  await db.query("UPDATE outbound_entries SET replied_at=now(),seen_at=COALESCE(seen_at,now()) WHERE workspace_id=$1 AND conversation_id=$2 AND replied_at IS NULL", [w, conversationId]);
}

/* ------------------------------------------------------------------------------------------ */
/* Managing messages (the Outbound area arrives in O3; O2 is the API)                          */

async function managed(db: Sql, w: string, principal: string) {
  const t = await authorize(db, w, principal, "workspace.manage");
  assert(await outboundOn(db, w), "OUTBOUND_DISABLED", "Outbound is not enabled for this workspace.", 404);
  return t;
}
/** What's wrong with a definition here (on top of its own checks): its type, sender and segment. */
async function problemsHere(db: Sql, w: string, def: OutboundDefinition) {
  const out = outboundProblems(def);
  if (out.length) return out;
  const type = (await db.query<{ channel: string; archived_at: string | null }>("SELECT channel,archived_at FROM subscription_types WHERE workspace_id=$1 AND id=$2", [w, def.subscriptionTypeId])).rows[0];
  if (!type || type.archived_at) out.push("Its subscription type isn't available.");
  else if (type.channel !== "in_app") out.push("An in-app message needs an in-app subscription type.");
  if (def.type === "chat" && !(await db.query("SELECT 1 FROM teammates WHERE workspace_id=$1 AND id=$2", [w, def.content.senderId])).rows.length) out.push("Choose a teammate to send it.");
  const seg = def.audience.segmentId;
  if (seg && !PREDEFINED.some((s) => s.id === seg) && !(await db.query("SELECT 1 FROM segments WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL", [w, seg])).rows.length)
    out.push("Its segment isn't available.");
  return out;
}

async function stats(db: Sql, w: string, messageId: string, goal: OutboundDefinition["goal"]) {
  const r = (
    await db.query<{ status: string; variant: string; n: number; seen: number; replied: number; clicked: number; dismissed: number }>(
      "SELECT status,variant,count(*)::int AS n,count(seen_at)::int AS seen,count(replied_at)::int AS replied,count(clicked_at)::int AS clicked,count(dismissed_at)::int AS dismissed FROM outbound_entries WHERE workspace_id=$1 AND message_id=$2 GROUP BY status,variant",
      [w, messageId],
    )
  ).rows;
  const n = (status: string) => r.filter((x) => x.status === status).reduce((a, x) => a + x.n, 0);
  const out = {
    sent: n("sent"),
    seen: r.filter((x) => x.status === "sent").reduce((a, x) => a + x.seen, 0),
    replied: r.filter((x) => x.status === "sent").reduce((a, x) => a + x.replied, 0),
    clicked: r.filter((x) => x.status === "sent").reduce((a, x) => a + x.clicked, 0),
    dismissed: r.filter((x) => x.status === "sent").reduce((a, x) => a + x.dismissed, 0),
    heldOut: n("held_out"),
    suppressed: n("suppressed"),
    pending: n("pending"),
    goal: null as null | ReturnType<typeof goalReadout> & { event: string; days: number; sent: { n: number; converted: number }; control: { n: number; converted: number } },
  };
  if (goal) {
    const g = (
      await db.query<{ variant: string; n: number; converted: number }>(
        `SELECT e.variant,count(*)::int AS n,count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM contact_events ev WHERE ev.workspace_id=e.workspace_id AND ev.contact_id=e.contact_id AND ev.name=$3
            AND ev.occurred_at>=e.entered_at AND ev.occurred_at<e.entered_at+make_interval(days=>$4)))::int AS converted
         FROM outbound_entries e WHERE e.workspace_id=$1 AND e.message_id=$2 AND e.status IN ('sent','held_out') GROUP BY e.variant`,
        [w, messageId, goal.event, goal.days],
      )
    ).rows;
    const sent = g.find((x) => x.variant === "message") ?? { n: 0, converted: 0 };
    const control = g.find((x) => x.variant === "control") ?? { n: 0, converted: 0 };
    out.goal = { event: goal.event, days: goal.days, sent: { n: sent.n, converted: sent.converted }, control: { n: control.n, converted: control.converted }, ...goalReadout(sent, control) };
  }
  return out;
}

export async function readOutbound(db: Sql, w: string, principal: string) {
  await managed(db, w, principal);
  const s = await settingsOf(db, w);
  const messages = (
    await db.query<{ id: string; title: string; type: string; state: string; live_version: number | null; updated_at: Date; draft: OutboundDefinition }>(
      "SELECT id,title,type,state,live_version,updated_at,draft FROM outbound_messages WHERE workspace_id=$1 AND state<>'archived' ORDER BY updated_at DESC,id",
      [w],
    )
  ).rows;
  const out = [];
  for (const m of messages) {
    const live = m.live_version ? await versionOf(db, w, m.id, m.live_version) : null;
    out.push({ id: m.id, title: m.title, type: m.type, state: m.state, liveVersion: m.live_version, updatedAt: new Date(m.updated_at).toISOString(), stats: await stats(db, w, m.id, (live ?? m.draft).goal) });
  }
  const rows = async <T,>(text: string) => (await db.query<T>(text, [w])).rows;
  return {
    settings: { capCount: s.cap_count, capDays: s.cap_days, quietStart: s.quiet_start, quietEnd: s.quiet_end, timezone: s.timezone },
    messages: out,
    // O3: what the editor offers: senders, in-app subscription types, segments, events and attributes.
    choices: {
      teammates: await rows<{ id: string; name: string }>("SELECT id,name FROM teammates WHERE workspace_id=$1 ORDER BY name,id"),
      subscriptions: await rows<{ id: string; name: string }>("SELECT id,name FROM subscription_types WHERE workspace_id=$1 AND channel='in_app' AND archived_at IS NULL ORDER BY lower(name),id"),
      segments: [...PREDEFINED.map((x) => ({ id: x.id, name: x.name })), ...(await rows<{ id: string; name: string }>("SELECT id,name FROM segments WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY lower(name),id"))],
      events: (await rows<{ name: string }>("SELECT name FROM event_definitions WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY lower(name)")).map((r) => r.name),
      attributes: (
        await rows<{ key: string }>(
          "SELECT DISTINCT k AS key FROM (SELECT jsonb_object_keys(profile) AS k FROM contacts WHERE workspace_id=$1 AND merged_into_contact_id IS NULL AND jsonb_typeof(profile)='object') x ORDER BY 1 LIMIT 200",
        )
      ).map((r) => r.key),
    },
  };
}

export async function readOutboundMessage(db: Sql, w: string, principal: string, id: string) {
  await managed(db, w, principal);
  const m = (
    await db.query<{ id: string; title: string; type: string; state: string; live_version: number | null; draft: OutboundDefinition }>(
      "SELECT id,title,type,state,live_version,draft FROM outbound_messages WHERE workspace_id=$1 AND id=$2",
      [w, id],
    )
  ).rows[0];
  assert(m, "OUTBOUND_NOT_FOUND", "That message isn't available.", 404);
  const live = m.live_version ? await versionOf(db, w, m.id, m.live_version) : null;
  return {
    message: { id: m.id, title: m.title, type: m.type, state: m.state, liveVersion: m.live_version },
    draft: m.draft,
    problems: await problemsHere(db, w, m.draft),
    versions: (
      await db.query<{ version: number; effective_at: Date; published_by: string }>("SELECT version,effective_at,published_by FROM outbound_versions WHERE workspace_id=$1 AND message_id=$2 ORDER BY version", [w, m.id])
    ).rows.map((v) => ({ version: v.version, effectiveAt: new Date(v.effective_at).toISOString(), publishedBy: v.published_by })),
    stats: await stats(db, w, m.id, (live ?? m.draft).goal),
    entries: (
      await db.query<{ id: string; contact_id: string; name: string; email: string | null; version: number; variant: string; status: string; reason: string; entered_at: Date | null; seen_at: Date | null; replied_at: Date | null; clicked_at: Date | null; dismissed_at: Date | null; conversation_id: string | null }>(
        `SELECT e.id,e.contact_id,c.name,(SELECT min(email) FROM contact_emails x WHERE x.workspace_id=e.workspace_id AND x.contact_id=e.contact_id) AS email,
                e.version,e.variant,e.status,e.reason,e.entered_at,e.seen_at,e.replied_at,e.clicked_at,e.dismissed_at,e.conversation_id
         FROM outbound_entries e JOIN contacts c ON c.workspace_id=e.workspace_id AND c.id=e.contact_id
         WHERE e.workspace_id=$1 AND e.message_id=$2 ORDER BY e.created_at DESC,e.id LIMIT 50`,
        [w, m.id],
      )
    ).rows.map((e) => ({
      id: e.id,
      contactId: e.contact_id,
      name: e.name,
      email: e.email,
      version: e.version,
      variant: e.variant,
      status: e.status,
      reason: e.reason,
      enteredAt: e.entered_at ? new Date(e.entered_at).toISOString() : null,
      seenAt: e.seen_at ? new Date(e.seen_at).toISOString() : null,
      repliedAt: e.replied_at ? new Date(e.replied_at).toISOString() : null,
      clickedAt: e.clicked_at ? new Date(e.clicked_at).toISOString() : null,
      dismissedAt: e.dismissed_at ? new Date(e.dismissed_at).toISOString() : null,
      conversationId: e.conversation_id,
    })),
  };
}

/**
 * `outbound-message` actions: `create`, `save` (the draft), `audience` (the live size: nothing is
 * written), `publish` (a new version, now or at a time; contacts already in keep theirs), `pause`,
 * `resume` and `archive`.
 */
export async function changeOutboundMessage(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>) {
  const t = await managed(db, w, principal);
  if (p.action === "audience") {
    const def = p.definition as OutboundDefinition;
    const problems = outboundProblems(def).filter((x) => x.startsWith("Audience"));
    if (problems.length) throw new DomainError("INVALID_OUTBOUND", problems[0], 400);
    const params: unknown[] = [w];
    const where = await audienceWhere(db, w, def, params, Date.now());
    return { count: (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM contacts c WHERE ${where}`, params)).rows[0].n, sendTimeRules: def.audience.sendTime.length };
  }
  return once(db, w, "outbound:" + principal, key, p, async () => {
    const invalid = (m: string): never => {
      throw new DomainError("INVALID_OUTBOUND", m, 400);
    };
    const title = typeof p.title === "string" ? p.title.trim() : undefined;
    if (title !== undefined && (!title || title.length > 120)) invalid("Name the message (120 characters at most).");
    if (p.action === "create") {
      if (p.type !== "chat" && p.type !== "banner") invalid("Choose the message type: chat or banner.");
      const type = p.type as "chat" | "banner";
      const id = crypto.randomUUID();
      await db.query("INSERT INTO outbound_messages(workspace_id,id,type,title,draft,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)", [
        w,
        id,
        type,
        title || "Untitled",
        JSON.stringify(blankDefinition(type, t.id)),
        t.id,
      ]);
      return readOutboundMessage(db, w, principal, id);
    }
    const id = String(p.id ?? "");
    const m = (await db.query<{ state: string; type: string; draft: OutboundDefinition; live_version: number | null }>("SELECT state,type,draft,live_version FROM outbound_messages WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [w, id])).rows[0];
    assert(m && m.state !== "archived", "OUTBOUND_NOT_FOUND", "That message isn't available.", 404);
    if (p.action === "save") {
      const def = (p.definition ?? m.draft) as OutboundDefinition;
      if (!def || typeof def !== "object" || def.type !== m.type) invalid("A message's type stays as it was made.");
      if (JSON.stringify(def).length > 50_000) invalid("That message is too large.");
      await db.query("UPDATE outbound_messages SET draft=$3,title=COALESCE($4,title),updated_by=$5,updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, id, JSON.stringify(def), title ?? null, t.id]);
    } else if (p.action === "publish") {
      const problems = await problemsHere(db, w, m.draft);
      if (problems.length) invalid(problems[0]);
      const at = p.at ? new Date(String(p.at)) : new Date();
      if (!Number.isFinite(at.getTime()) || at.getTime() < Date.now() - 60_000) invalid("Schedule the change for a time to come.");
      const version = ((await db.query<{ v: number | null }>("SELECT max(version) AS v FROM outbound_versions WHERE workspace_id=$1 AND message_id=$2", [w, id])).rows[0].v ?? 0) + 1;
      await db.query("INSERT INTO outbound_versions(workspace_id,message_id,version,definition,effective_at,published_by) VALUES($1,$2,$3,$4,$5,$6)", [
        w,
        id,
        version,
        JSON.stringify(m.draft),
        at.toISOString(),
        t.id,
      ]);
      await db.query("UPDATE outbound_messages SET state='live',live_version=$3,updated_by=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, id, version, t.id]);
    } else if (p.action === "pause") {
      if (m.state !== "live") invalid("Only a live message can be paused.");
      await db.query("UPDATE outbound_messages SET state='paused',updated_by=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, id, t.id]);
    } else if (p.action === "resume") {
      if (m.state !== "paused") invalid("Only a paused message can be resumed.");
      await db.query("UPDATE outbound_messages SET state='live',updated_by=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, id, t.id]);
    } else if (p.action === "archive") {
      await db.query("UPDATE outbound_messages SET state='archived',updated_by=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, id, t.id]);
      return { archived: true };
    } else invalid("Unknown change.");
    return readOutboundMessage(db, w, principal, id);
  });
}

/** Settings › Outbound: the cap across all outbound, quiet hours, and the workspace's timezone. */
export async function changeOutboundSettings(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>) {
  const t = await managed(db, w, principal);
  return once(db, w, "outbound-settings:" + principal, key, p, async () => {
    const invalid = (m: string): never => {
      throw new DomainError("INVALID_OUTBOUND", m, 400);
    };
    const count = Number(p.capCount);
    const days = Number(p.capDays);
    if (!Number.isInteger(count) || count < 1 || count > 50 || !Number.isInteger(days) || days < 1 || days > 30) invalid("The cap is 1 to 50 messages in 1 to 30 days.");
    for (const k of ["quietStart", "quietEnd"]) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(p[k]))) invalid("Quiet hours are times (HH:MM).");
    try {
      new Intl.DateTimeFormat("en", { timeZone: String(p.timezone) });
    } catch {
      invalid("Choose a timezone (Europe/London).");
    }
    await settingsOf(db, w);
    await db.query("UPDATE outbound_settings SET cap_count=$2,cap_days=$3,quiet_start=$4,quiet_end=$5,timezone=$6,updated_by=$7,updated_at=now() WHERE workspace_id=$1", [
      w,
      count,
      days,
      p.quietStart,
      p.quietEnd,
      p.timezone,
      t.id,
    ]);
    return readOutbound(db, w, principal);
  });
}
