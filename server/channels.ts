import { assert, digest, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import { authorize } from "./policy";
import { resolveContact } from "./people";
import type { Capabilities, DeliveryStatus } from "../lib/channels";

/**
 * The channel contract (phase 12, step E1; docs/OMNICHANNEL_STEP1.md). Every channel is an
 * adapter: it says what it can do (`capabilities`), turns what its provider sends into a message
 * (`receive`), sends an outbound part and reports how it went (`send`), and normalises a customer's
 * address (`address`). Everything else (the inbox, workflows, Zoe, reporting) asks the adapter, never
 * which channel it is.
 *
 * - **Identity:** a customer on a channel is an identity of kind `channel` with its address kept
 *   (`identity_addresses`). Its contact is shared with another channel's only when the address is
 *   verified (the channel vouched for it): an unverified address never joins a signed-in user.
 * - **In:** `receiveInbound` threads a message by the adapter's keys, records each provider
 *   message once (a retried webhook adds nothing), and appends it as the customer's on its channel.
 * - **Out:** every public part from the team, Zoe or a workflow on a conversation whose current
 *   channel isn't the messenger becomes a delivery, sent by the `channel.deliver` job through
 *   `mayDeliver`, the single gate (the suppression list; the channel's own rules, like a window).
 * - **The messenger** is the first adapter: its customers have a session, and its parts are
 *   delivered as they're written (realtime), so it has no delivery rows.
 */
export type Inbound = {
  /** The provider's id for this message: received once. */
  externalId: string;
  /** The customer's address on the channel, and whether the channel vouches for it. */
  address: string;
  verified: boolean;
  name?: string;
  text: string;
  /** Keys that find its conversation (for email: Message-ID, In-Reply-To, References). */
  threadKeys: string[];
  /** Keys later messages may refer to (for email: its own Message-ID). */
  ownKeys?: string[];
  /** A looser key (email: subject and sender), used only when no thread key matches, within `days`. */
  fallback?: { key: string; days: number } | null;
  /** The brand it was sent to. */
  brandId: string;
  /** Anything the inbox shows beside it (a subject, the original before quotes were stripped). */
  data?: Record<string, unknown>;
  /** Not a customer's reply (an auto-reply, a bounce): recorded for teammates only. */
  automatic?: boolean;
};
export type Outbound = {
  workspaceId: string;
  deliveryId: string;
  conversationId: string;
  partId: string;
  /** A reply on its channel, or (email, E3) an away email for a messenger conversation. */
  purpose: "reply" | "away";
  address: string;
  text: string;
  /** Reply buttons, which an adapter without buttons writes out. */
  options?: string[];
  data: Record<string, unknown>;
  /** What the adapter's `prepare` read from the database, inside the gate's transaction. */
  prepared?: Record<string, unknown>;
};
export type SendResult =
  | { status: "sent" | "delivered"; providerId?: string }
  /** A failure retrying won't fix (an invalid address); a thrown error is retried. */
  | { status: "failed"; error: string; permanent: true; suppress?: "hard_bounce" | "complaint" | "opt_out" };
export type ChannelAdapter = {
  id: string;
  /** Its own flag (besides `channels_v1`), when it has one. */
  flag?: string;
  capabilities: Capabilities;
  /** The address as kept (lower-case email, an E.164 number), or null when it isn't one. */
  address(raw: string): string | null;
  /** Its provider's payload as a message (the messenger's arrive through its own session API). */
  receive?(payload: unknown): Promise<Inbound | null>;
  /** Sends; a thrown error is retried by the job, then dead-lettered. */
  send?(out: Outbound, env: ChannelEnvironment): Promise<SendResult>;
  /** The channel's own rule on sending now (a closed window), or null. */
  refuses?(db: Sql, w: string, conversationId: string): Promise<string | null>;
  /**
   * Inside the gate's transaction, after `mayDeliver`: what sending needs from the database
   * (`out.prepared`), a later time to try (a rate limit), or why it can't go. `send` runs after,
   * outside any transaction.
   */
  prepare?(db: Sql, w: string, out: Outbound, env: ChannelEnvironment): Promise<{ data: Record<string, unknown> } | { defer: Date } | { refuse: string }>;
  /** What the composer says about a reply on this channel (email: its subject). */
  replyDetails?(db: Sql, w: string, conversationId: string): Promise<Record<string, string>>;
};
/** What adapters need from the runtime: provider credentials, by channel. */
export type ChannelEnvironment = { providers?: Record<string, unknown> };

/* ------------------------------------------------------------------------------------------ */
/* The registry                                                                                */

/** The messenger: a signed session per customer, delivered as it's written (realtime). */
export const messenger: ChannelAdapter = {
  id: "messenger",
  capabilities: { richText: true, attachments: true, buttons: true, maxLength: 5000, windowHours: null, ai: true, receipts: "read", address: "session" },
  address: () => null,
};
const adapters = new Map<string, ChannelAdapter>([["messenger", messenger]]);
/** A channel joins Relay (each phase 12 step registers its own; tests register stand-ins). */
export function registerChannel(a: ChannelAdapter) {
  adapters.set(a.id, a);
  return () => void (a.id !== "messenger" && adapters.delete(a.id));
}
export function adapterOf(channel: string | null | undefined): ChannelAdapter {
  const a = adapters.get(channel ?? "messenger");
  if (!a) throw new DomainError("CHANNEL_UNAVAILABLE", `The ${channel} channel isn't available.`, 503);
  return a;
}
export const capabilitiesOf = (channel: string | null | undefined) => adapterOf(channel).capabilities;
export const channels = () => [...adapters.values()];

export async function channelsEnabled(db: Sql, w: string) {
  return (await db.query("SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='channels_v1' AND enabled", [w])).rows.length > 0;
}
/** The channels a workspace has on: the messenger, and each adapter whose flag is on. */
export async function enabledChannels(db: Sql, w: string) {
  if (!(await channelsEnabled(db, w))) return [messenger];
  const flags = new Set(
    (await db.query<{ name: string }>("SELECT name FROM workspace_features WHERE workspace_id=$1 AND enabled", [w])).rows.map((r) => r.name),
  );
  return channels().filter((a) => !a.flag || flags.has(a.flag));
}

/* ------------------------------------------------------------------------------------------ */
/* Identity                                                                                    */

/**
 * The identity for a customer's address on a channel, and its contact. A verified address joins
 * the contact that already has it verified (one person across channels); an unverified one gets
 * its own contact, so a forged sender can't join anyone's history.
 */
export async function channelIdentity(db: Sql, w: string, a: ChannelAdapter, raw: string, verified: boolean, name = "") {
  const address = a.address(raw);
  assert(address, "INVALID_ADDRESS", `That isn't a ${a.id} address.`, 400);
  const hash = await digest(`${a.id}:${address}`);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${w}:channel:${hash}`]);
  const existing = (
    await db.query<{ id: string; contact_id: string; verified: boolean }>(
      `SELECT i.id,m.contact_id,x.verified FROM identities i
       JOIN identity_contact_mappings m ON m.workspace_id=i.workspace_id AND m.identity_id=i.id
       JOIN identity_addresses x ON x.workspace_id=i.workspace_id AND x.identity_id=i.id
       WHERE i.workspace_id=$1 AND i.kind='channel' AND i.identifier_hash=$2`,
      [w, hash],
    )
  ).rows[0];
  if (existing) {
    // Verified now: the address is marked so (merging contacts is phase 01's, with its controls).
    if (verified && !existing.verified)
      await db.query("UPDATE identity_addresses SET verified=true WHERE workspace_id=$1 AND identity_id=$2", [w, existing.id]);
    return { identityId: existing.id, contactId: await resolveContact(db, w, existing.contact_id), address, verified: verified || existing.verified };
  }
  const email = a.capabilities.address === "email";
  const phone = a.capabilities.address === "phone";
  const known = verified
    ? (
        await db.query<{ contact_id: string }>(
          email
            ? "SELECT contact_id FROM contact_emails WHERE workspace_id=$1 AND lower(email)=$2 AND verified ORDER BY contact_id LIMIT 1"
            : phone
              ? "SELECT contact_id FROM contact_phones WHERE workspace_id=$1 AND phone=$2 AND verified ORDER BY contact_id LIMIT 1"
              : "SELECT NULL::text AS contact_id WHERE false",
          [w, address],
        )
      ).rows[0]?.contact_id
    : undefined;
  let contactId = known ? await resolveContact(db, w, known) : null;
  if (!contactId) {
    contactId = crypto.randomUUID();
    await db.query("INSERT INTO contacts(workspace_id,id,role,name) VALUES($1,$2,'lead',$3)", [w, contactId, name.slice(0, 200)]);
    if (email) await db.query("INSERT INTO contact_emails(workspace_id,contact_id,email,verified) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [w, contactId, address, verified]);
    if (phone) await db.query("INSERT INTO contact_phones(workspace_id,contact_id,phone,verified) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [w, contactId, address, verified]);
  }
  const identityId = crypto.randomUUID();
  await db.query("INSERT INTO identities(workspace_id,id,kind,identifier_hash) VALUES($1,$2,'channel',$3)", [w, identityId, hash]);
  await db.query("INSERT INTO identity_contact_mappings(workspace_id,identity_id,contact_id) VALUES($1,$2,$3)", [w, identityId, contactId]);
  await db.query("INSERT INTO identity_addresses(workspace_id,identity_id,channel,address,verified) VALUES($1,$2,$3,$4,$5)", [w, identityId, a.id, address, verified]);
  return { identityId, contactId, address, verified };
}

/* ------------------------------------------------------------------------------------------ */
/* In                                                                                          */

/**
 * A message from a channel: received once, threaded into its conversation (or a new one), and
 * written as the customer's on that channel. An automatic message (an auto-reply, a bounce) is
 * kept for teammates and changes nothing else.
 */
export async function receiveInbound(db: Sql, w: string, a: ChannelAdapter, m: Inbound) {
  assert(await channelsEnabled(db, w), "CHANNELS_DISABLED", "Channels are not enabled for this workspace.", 404);
  assert((await enabledChannels(db, w)).includes(a), "CHANNEL_DISABLED", `The ${a.id} channel is not enabled for this workspace.`, 404);
  const seen = (
    await db.query<{ part_id: string; conversation_id: string }>(
      "SELECT part_id,conversation_id FROM channel_messages WHERE workspace_id=$1 AND channel=$2 AND external_id=$3",
      [w, a.id, m.externalId],
    )
  ).rows[0];
  if (seen) return { conversationId: seen.conversation_id, partId: seen.part_id, duplicate: true, identityId: null };
  const { command, conversation } = await import("./conversations");
  const who = await channelIdentity(db, w, a, m.address, m.verified, m.name);
  const thread =
    (m.threadKeys.length
      ? (
          await db.query<{ conversation_id: string }>(
            `SELECT t.conversation_id FROM channel_threads t JOIN conversations c ON c.workspace_id=t.workspace_id AND c.id=t.conversation_id
             WHERE t.workspace_id=$1 AND t.channel=$2 AND t.thread_key=ANY($3::text[]) AND c.merged_into_id IS NULL ORDER BY t.created_at DESC LIMIT 1`,
            [w, a.id, m.threadKeys],
          )
        ).rows[0]?.conversation_id
      : undefined) ??
    (m.fallback
      ? (
          await db.query<{ conversation_id: string }>(
            `SELECT t.conversation_id FROM channel_threads t JOIN conversations c ON c.workspace_id=t.workspace_id AND c.id=t.conversation_id
             WHERE t.workspace_id=$1 AND t.channel=$2 AND t.thread_key=$3 AND c.merged_into_id IS NULL AND c.updated_at>now()-make_interval(days=>$4)
             ORDER BY c.updated_at DESC LIMIT 1`,
            [w, a.id, m.fallback.key, m.fallback.days],
          )
        ).rows[0]?.conversation_id
      : undefined);
  const actor = { type: "contact" as const, identityId: who.identityId, brandId: m.brandId, verified: who.verified, channel: a.id };
  let conversationId: string;
  let partId: string;
  if (m.automatic) {
    // Nothing to answer: a note for teammates where it belongs, or nowhere.
    if (!thread) return { conversationId: null, partId: null, automatic: true, identityId: who.identityId };
    const { append } = await import("./conversations");
    const c = await conversation(db, w, thread);
    const part = await append(db, w, c, { type: "contact", id: who.identityId }, "system_event", "", { event: "automatic_reply", channel: a.id, ...m.data }, "internal", null, a.id);
    conversationId = thread;
    partId = part.id;
  } else if (thread) {
    const r = (await command(db, w, actor, `channel:${a.id}:${m.externalId}`, { action: "reply", conversationId: thread, text: m.text, channelData: m.data })) as {
      conversationId: string;
      partId: string;
    };
    conversationId = r.conversationId;
    partId = r.partId;
  } else {
    const r = (await command(db, w, actor, `channel:${a.id}:${m.externalId}`, { action: "start", text: m.text, channelData: m.data })) as { conversationId: string };
    conversationId = r.conversationId;
    partId = (
      await db.query<{ id: string }>(
        "SELECT id FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND kind='customer_message' ORDER BY seq LIMIT 1",
        [w, conversationId],
      )
    ).rows[0].id;
  }
  for (const key of [...m.threadKeys, ...(m.ownKeys ?? []), ...(m.fallback ? [m.fallback.key] : [])])
    await db.query("INSERT INTO channel_threads(workspace_id,channel,thread_key,conversation_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [w, a.id, key, conversationId]);
  await db.query("INSERT INTO channel_messages(workspace_id,channel,external_id,part_id,conversation_id) VALUES($1,$2,$3,$4,$5)", [w, a.id, m.externalId, partId, conversationId]);
  return { conversationId, partId, duplicate: false, identityId: who.identityId };
}

/* ------------------------------------------------------------------------------------------ */
/* Out                                                                                         */

const OUTBOUND = new Set(["teammate_reply", "ai_reply", "workflow_message", "attachment"]);

/**
 * Called by `append` for every part: a public part from the team, Zoe or a workflow, on a
 * conversation whose current channel isn't the messenger, becomes a delivery and a job.
 */
export async function queueDelivery(
  db: Sql,
  w: string,
  c: { id: string; current_channel?: string | null; visibility?: string },
  part: { id: string; kind: string; audience: string; author_type: string },
) {
  if (!OUTBOUND.has(part.kind) || part.audience !== "public" || part.author_type === "contact" || c.visibility === "internal") return;
  const channel = c.current_channel ?? "messenger";
  if (channel === "messenger") return;
  // To the address the customer last wrote from on this channel.
  const to = (
    await db.query<{ identity_id: string; address: string }>(
      `SELECT x.identity_id,x.address FROM conversation_parts p
       JOIN identity_addresses x ON x.workspace_id=p.workspace_id AND x.identity_id=p.author_id AND x.channel=$3
       WHERE p.workspace_id=$1 AND p.conversation_id=$2 AND p.kind='customer_message' AND p.channel=$3 ORDER BY p.seq DESC LIMIT 1`,
      [w, c.id, channel],
    )
  ).rows[0];
  if (!to) return;
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO channel_deliveries(workspace_id,id,part_id,conversation_id,channel,identity_id,address) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
    [w, id, part.id, c.id, channel, to.identity_id, to.address],
  );
  await enqueueJob(db, w, "channel.deliver", { deliveryId: id }, {});
}

/**
 * The single gate every send passes: nothing goes to a suppressed address, or when the channel's
 * own rules refuse (a closed window). TODO(phase 13): subscription types and consent.
 */
export async function mayDeliver(db: Sql, w: string, channel: string, address: string, conversationId: string | null) {
  const blocked = (
    await db.query<{ reason: string }>("SELECT reason FROM suppressions WHERE workspace_id=$1 AND channel=$2 AND address=$3 AND lifted_at IS NULL", [w, channel, address])
  ).rows[0];
  if (blocked) return { ok: false as const, status: "suppressed" as const, reason: `The address is suppressed (${blocked.reason.replace("_", " ")}).` };
  const refused = conversationId ? await adapterOf(channel).refuses?.(db, w, conversationId) : null;
  if (refused) return { ok: false as const, status: "failed" as const, reason: refused };
  return { ok: true as const };
}

export const DELIVERY_ATTEMPTS = 5;

/** The `channel.deliver` job: one delivery, through `mayDeliver`, by its adapter. */
export async function runDelivery(connect: Connect, env: ChannelEnvironment, job: Job) {
  const w = job.workspace_id;
  const { deliveryId } = job.payload as { deliveryId: string };
  const ready = await tenant(connect, w, async (db) => {
    const d = (
      await db.query<{
        id: string;
        status: string;
        channel: string;
        address: string;
        conversation_id: string;
        part_id: string;
        purpose: "reply" | "away";
        not_before: string | null;
        body: string;
        data: Record<string, unknown>;
      }>(
        `SELECT d.id,d.status,d.channel,d.address,d.conversation_id,d.part_id,d.purpose,d.not_before,p.body,p.data FROM channel_deliveries d
         JOIN conversation_parts p ON p.workspace_id=d.workspace_id AND p.id=d.part_id WHERE d.workspace_id=$1 AND d.id=$2 FOR UPDATE OF d`,
        [w, deliveryId],
      )
    ).rows[0];
    // Not yet (a rate limit): the sweep queues it again when its time comes.
    if (!d || d.status !== "queued" || d.not_before) return null;
    if (!(await channelsEnabled(db, w))) {
      await setStatus(db, w, d.id, "failed", "Channels were turned off.");
      return null;
    }
    const gate = await mayDeliver(db, w, d.channel, d.address, d.conversation_id);
    if (!gate.ok) {
      await setStatus(db, w, d.id, gate.status, gate.reason);
      return null;
    }
    const a = adapterOf(d.channel);
    // A channel that can receive but not send: said once, not retried.
    if (!a.send) {
      await setStatus(db, w, d.id, "failed", `Replies can't be sent by ${a.id} yet.`);
      return null;
    }
    const out: Outbound = {
      workspaceId: w,
      deliveryId: d.id,
      conversationId: d.conversation_id,
      partId: d.part_id,
      purpose: d.purpose,
      address: d.address,
      text: d.body,
      options: Array.isArray(d.data.options) ? (d.data.options as string[]) : undefined,
      data: d.data,
    };
    if (a.prepare) {
      const p = await a.prepare(db, w, out, env);
      if ("defer" in p) {
        await db.query("UPDATE channel_deliveries SET not_before=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, d.id, p.defer.toISOString()]);
        return null;
      }
      if ("refuse" in p) {
        await setStatus(db, w, d.id, "failed", p.refuse);
        return null;
      }
      out.prepared = p.data;
    }
    await db.query("UPDATE channel_deliveries SET attempts=attempts+1,updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, d.id]);
    return { a, out };
  });
  if (!ready) return { done: true, result: { sent: false } };
  const { a, out } = ready;
  let result: SendResult;
  try {
    result = await a.send!(out, env);
  } catch (e) {
    // Retried by the job; on its last attempt, the delivery is marked as not delivered.
    if (job.attempts >= DELIVERY_ATTEMPTS)
      await tenant(connect, w, (db) => setStatus(db, w, deliveryId, "failed", `Gave up after ${DELIVERY_ATTEMPTS} attempts: ${(e as Error).message}`.slice(0, 500)));
    throw e;
  }
  await tenant(connect, w, async (db) => {
    if (result.status === "failed") {
      await setStatus(db, w, deliveryId, "failed", result.error);
      if (result.suppress) await suppress(db, w, a.id, out.address, result.suppress, `delivery:${deliveryId}`);
    } else await setStatus(db, w, deliveryId, result.status, "", result.providerId);
  });
  return { done: true, result: { sent: result.status !== "failed" } };
}

/** The sweep: deliveries that waited for a rate limit, queued again once their minute comes. */
export async function releaseDeferred(connect: Connect, w: string) {
  await tenant(connect, w, async (db) => {
    const due = (
      await db.query<{ id: string }>(
        "UPDATE channel_deliveries SET not_before=NULL,updated_at=now() WHERE workspace_id=$1 AND status='queued' AND not_before<=now() RETURNING id",
        [w],
      )
    ).rows;
    for (const d of due) await enqueueJob(db, w, "channel.deliver", { deliveryId: d.id }, {});
  });
}

/** What the composer shows: where a reply on this conversation goes (null on the messenger). */
export async function readReplyTarget(db: Sql, w: string, principal: string, conversationId: string) {
  await authorize(db, w, principal, "conversations.read");
  const c = (await db.query<{ current_channel: string | null }>("SELECT current_channel FROM conversations WHERE workspace_id=$1 AND id=$2", [w, conversationId])).rows[0];
  assert(c, "CONVERSATION_NOT_FOUND", "Conversation unavailable.", 404);
  const channel = c.current_channel ?? "messenger";
  if (channel === "messenger") return { target: null };
  const to = (
    await db.query<{ address: string }>(
      `SELECT x.address FROM conversation_parts p JOIN identity_addresses x ON x.workspace_id=p.workspace_id AND x.identity_id=p.author_id AND x.channel=$3
       WHERE p.workspace_id=$1 AND p.conversation_id=$2 AND p.kind='customer_message' AND p.channel=$3 ORDER BY p.seq DESC LIMIT 1`,
      [w, conversationId, channel],
    )
  ).rows[0];
  const a = adapterOf(channel);
  return { target: { channel, address: to?.address ?? null, ...(a.replyDetails ? await a.replyDetails(db, w, conversationId) : {}) } };
}

async function setStatus(db: Sql, w: string, id: string, status: DeliveryStatus, error = "", providerId?: string) {
  await db.query(
    "UPDATE channel_deliveries SET status=$3,error=$4,provider_id=COALESCE($5,provider_id),updated_at=now() WHERE workspace_id=$1 AND id=$2",
    [w, id, status, error, providerId ?? null],
  );
}

const ORDER: DeliveryStatus[] = ["queued", "sent", "delivered", "read"];
/**
 * A provider's report (a webhook): a delivery moves forward only (a late "delivered" never undoes
 * "read"); a bounce or complaint fails it and suppresses the address.
 */
export async function deliveryReport(
  db: Sql,
  w: string,
  channel: string,
  providerId: string,
  report: { status: "delivered" | "read" } | { status: "failed"; error: string; suppress?: "hard_bounce" | "complaint" | "opt_out" },
) {
  const d = (
    await db.query<{ id: string; status: DeliveryStatus; address: string }>(
      "SELECT id,status,address FROM channel_deliveries WHERE workspace_id=$1 AND channel=$2 AND provider_id=$3 FOR UPDATE",
      [w, channel, providerId],
    )
  ).rows[0];
  if (!d) return false;
  if (report.status === "failed") {
    await setStatus(db, w, d.id, "failed", report.error);
    if (report.suppress) await suppress(db, w, channel, d.address, report.suppress, `delivery:${d.id}`);
  } else if (ORDER.indexOf(report.status) > ORDER.indexOf(d.status)) await setStatus(db, w, d.id, report.status);
  return true;
}

/** A conversation's deliveries, by part (for the inbox). */
export async function readDeliveries(db: Sql, w: string, principal: string, conversationId: string) {
  await authorize(db, w, principal, "conversations.read");
  assert(
    (await db.query("SELECT 1 FROM conversations WHERE workspace_id=$1 AND id=$2", [w, conversationId])).rows.length,
    "CONVERSATION_NOT_FOUND",
    "Conversation unavailable.",
    404,
  );
  const rows = (
    await db.query<{ part_id: string; channel: string; status: DeliveryStatus; error: string; updated_at: string }>(
      "SELECT part_id,channel,status,error,updated_at FROM channel_deliveries WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY created_at",
      [w, conversationId],
    )
  ).rows;
  return { deliveries: rows.map((r) => ({ partId: r.part_id, channel: r.channel, status: r.status, error: r.error, updatedAt: new Date(r.updated_at).toISOString() })) };
}

/* ------------------------------------------------------------------------------------------ */
/* The suppression list                                                                        */

/** An address added (idempotent: an active entry stays as it is). */
export async function suppress(db: Sql, w: string, channel: string, address: string, reason: "manual" | "hard_bounce" | "complaint" | "opt_out", source: string, by: string | null = null, note = "") {
  await db.query(
    `INSERT INTO suppressions(workspace_id,id,channel,address,reason,source,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (workspace_id,channel,address) WHERE lifted_at IS NULL DO NOTHING`,
    [w, crypto.randomUUID(), channel, address, reason, source, note.slice(0, 500), by],
  );
}

/** Settings › Suppression list: active entries first, then lifted ones (history). */
export async function readSuppressions(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "workspace.manage");
  assert(await channelsEnabled(db, w), "CHANNELS_DISABLED", "Channels are not enabled for this workspace.", 404);
  const rows = (
    await db.query<{
      id: string;
      channel: string;
      address: string;
      reason: string;
      source: string;
      note: string;
      created_at: string;
      created_name: string | null;
      lifted_at: string | null;
      lifted_name: string | null;
    }>(
      `SELECT s.id,s.channel,s.address,s.reason,s.source,s.note,s.created_at,c.name AS created_name,s.lifted_at,l.name AS lifted_name FROM suppressions s
       LEFT JOIN teammates c ON c.workspace_id=s.workspace_id AND c.id=s.created_by
       LEFT JOIN teammates l ON l.workspace_id=s.workspace_id AND l.id=s.lifted_by
       WHERE s.workspace_id=$1 ORDER BY (s.lifted_at IS NULL) DESC,s.created_at DESC LIMIT 500`,
      [w],
    )
  ).rows;
  return {
    entries: rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      address: r.address,
      reason: r.reason,
      source: r.source,
      note: r.note,
      createdAt: new Date(r.created_at).toISOString(),
      createdBy: r.created_name,
      liftedAt: r.lifted_at ? new Date(r.lifted_at).toISOString() : null,
      liftedBy: r.lifted_name,
      liftable: !r.lifted_at && (r.reason === "manual" || r.reason === "hard_bounce"),
    })),
    channels: (await enabledChannels(db, w))
      .filter((a) => a.capabilities.address !== "session")
      .map((a) => ({ id: a.id, address: a.capabilities.address })),
  };
}

/** Add a manual block, or lift a manual block or hard bounce (never an opt-out or complaint). */
export async function changeSuppression(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>) {
  const t = await authorize(db, w, principal, "workspace.manage");
  assert(await channelsEnabled(db, w), "CHANNELS_DISABLED", "Channels are not enabled for this workspace.", 404);
  return once(db, w, "suppression:" + principal, key, p, async () => {
    if (p.action === "add") {
      const a = (await enabledChannels(db, w)).find((x) => x.id === String(p.channel ?? ""));
      assert(a && a.capabilities.address !== "session", "INVALID_CHANNEL", "Choose a channel with addresses.", 400);
      const address = a.address(String(p.address ?? ""));
      assert(address, "INVALID_ADDRESS", `That isn't a ${a.id} address.`, 400);
      await suppress(db, w, a.id, address, "manual", "teammate", t.id, typeof p.note === "string" ? p.note : "");
      return readSuppressions(db, w, principal);
    }
    if (p.action === "lift") {
      const row = (
        await db.query<{ reason: string; lifted_at: string | null }>("SELECT reason,lifted_at FROM suppressions WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [w, String(p.id ?? "")])
      ).rows[0];
      assert(row && !row.lifted_at, "SUPPRESSION_NOT_FOUND", "That entry isn't on the list.", 404);
      assert(
        row.reason === "manual" || row.reason === "hard_bounce",
        "SUPPRESSION_PERMANENT",
        row.reason === "opt_out" ? "The customer opted out: only they can opt back in." : "The customer complained: their address stays suppressed.",
        409,
      );
      await db.query("UPDATE suppressions SET lifted_at=now(),lifted_by=$3 WHERE workspace_id=$1 AND id=$2", [w, String(p.id), t.id]);
      return readSuppressions(db, w, principal);
    }
    throw new DomainError("INVALID_SUPPRESSION", "Unknown change.", 400);
  });
}
