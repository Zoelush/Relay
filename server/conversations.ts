import { resolveWake } from "./snooze";
import {
  assertClosable,
  assertFieldAllowed,
  assertMergeable,
  changeTicketType,
  convertToTicket,
  setTicketState,
} from "./tickets";
import { linkToTracker, unlinkFromTracker } from "./ticket-links";
import { verifyInlineImages } from "./attachments";
import { resolveMentions, recordMentions } from "./mentions";
import {
  normalizeDoc,
  plainText,
  isPlain,
  imageIds,
  mentions,
  RichDocError,
  type RichDoc,
} from "../lib/rich-doc";
import { assert, once, DomainError, type Sql } from "./db";
import { authorize, type Capability } from "./policy";
import { resolveContact } from "./people";
import { customerReply, refreshCustomerUnread } from "./unread";
import { enqueueJob } from "./jobs";
import { customerVisiblePart } from "./delivery-policy";

export type Actor = (
  | { type: "teammate"; principal: string }
  | { type: "contact"; identityId: string; brandId: string; verified?: boolean }
) & { originTimezone?: string };
export interface Conversation {
  id: string;
  workspace_id: string;
  brand_id: string;
  primary_identity_id: string;
  /** "internal" for back-office and tracker tickets, which no customer can see. */
  visibility?: "customer" | "internal";
  status: string;
  assigned: string;
  team_id: string | null;
  priority: boolean;
  next_seq: string;
  merged_into_id: string | null;
  timeline_revision: string;
  created_at: string;
  updated_at: string;
  title: string;
  snooze_version: string;
  snooze_unassign?: boolean;
  snooze_timezone?: string | null;
  [key: string]: unknown;
}
export interface Part {
  id: string;
  conversation_id: string;
  seq: string;
  kind: string;
  author_type: string;
  author_id: string;
  audience: string;
  body: string;
  data: Record<string, unknown>;
  created_at: string;
  supersedes_id: string | null;
  [key: string]: unknown;
}
export interface Command {
  action: string;
  conversationId?: string;
  text?: string;
  title?: string;
  value?: unknown;
  participantId?: string;
  targetId?: string;
  partId?: string;
  wakeAt?: string;
  preset?: string;
  doc?: unknown;
  timezone?: string;
  unassignOnWake?: boolean;
  expectedVersion?: number;
  teammateId?: string;
  teamId?: string;
  attributeId?: string;
  tagId?: string;
  attributes?: Record<string, unknown>;
  typeId?: string;
  stateId?: string;
  mapping?: Record<string, string>;
  token?: string;
  trackerId?: string;
}
export function agentConversation(c: Conversation, personalData: boolean) {
  const {
    id,
    brand_id,
    title,
    status,
    assigned,
    team_id,
    priority,
    channel,
    created_at,
    updated_at,
    snooze_until,
    snooze_unassign,
    snooze_timezone,
    first_response_ms,
    first_response_business_ms,
    last_contact_reply_at,
    last_teammate_reply_at,
    rating,
    topics,
    attributes,
    timeline_revision,
  } = c;
  return {
    id,
    brand_id,
    title,
    status,
    assigned,
    team_id,
    priority,
    channel,
    created_at,
    updated_at,
    snooze_until,
    snooze_unassign,
    snooze_timezone,
    first_response_ms,
    first_response_business_ms,
    last_contact_reply_at,
    last_teammate_reply_at,
    rating,
    topics,
    attributes,
    timeline_revision,
    ...(personalData ? { name: c.name, email: c.email } : {}),
  };
}

export async function conversation(
  db: Sql,
  w: string,
  id: string,
  lock = false,
): Promise<Conversation> {
  const visited = new Set<string>();
  while (!visited.has(id) && visited.size < 32) {
    visited.add(id);
    const c = (
      await db.query<Conversation>(
        "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2" +
          (lock ? " FOR UPDATE" : ""),
        [w, id],
      )
    ).rows[0];
    assert(c, "CONVERSATION_NOT_FOUND", "Conversation unavailable.", 404);
    if (!c.merged_into_id) return c;
    id = c.merged_into_id;
  }
  throw new Error("Conversation alias cycle");
}
async function identityContact(db: Sql, w: string, id: string) {
  const row = (
    await db.query<{ contact_id: string }>(
      "SELECT contact_id FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2",
      [w, id],
    )
  ).rows[0];
  assert(row, "IDENTITY_NOT_FOUND", "Identity unavailable.", 404);
  return resolveContact(db, w, row.contact_id);
}
export async function access(
  db: Sql,
  w: string,
  c: Conversation,
  actor: Actor,
  cap: Capability = "conversations.read",
) {
  if (actor.type === "teammate") {
    const t = await authorize(db, w, actor.principal, cap);
    return {
      type: "teammate",
      id: t.id,
      name: t.name,
      originTimezone: actor.originTimezone,
    };
  }
  // Back-office and tracker tickets have no customer; no customer can ever open one.
  assert(
    c.brand_id === actor.brandId && c.visibility !== "internal",
    "CONVERSATION_NOT_FOUND",
    "Conversation unavailable.",
    404,
  );
  const participants = (
    await db.query<{ identity_id: string }>(
      "SELECT identity_id FROM conversation_participants WHERE workspace_id=$1 AND conversation_id=$2",
      [w, c.id],
    )
  ).rows;
  const identities = [
    c.primary_identity_id,
    ...participants.map((p) => p.identity_id),
  ];
  let valid = identities.includes(actor.identityId);
  if (actor.verified) {
    const expected = await identityContact(db, w, actor.identityId);
    for (const id of identities)
      if ((await identityContact(db, w, id)) === expected) valid = true;
  }
  assert(valid, "CONVERSATION_NOT_FOUND", "Conversation unavailable.", 404);
  return {
    type: "contact",
    id: actor.identityId,
    name: "You",
    originTimezone: actor.originTimezone,
  };
}
export async function append(
  db: Sql,
  w: string,
  c: Conversation,
  author: { type: string; id: string; name?: string; originTimezone?: string },
  kind: string,
  body = "",
  data: Record<string, unknown> = {},
  audience = "public",
  supersedes: string | null = null,
): Promise<Part> {
  const version = (
    await db.query<{ next_seq: string; updated_at: string }>(
      "UPDATE conversations SET next_seq=next_seq+1,updated_at=GREATEST(clock_timestamp(),updated_at) WHERE workspace_id=$1 AND id=$2 RETURNING next_seq,updated_at",
      [w, c.id],
    )
  ).rows[0];
  const id = crypto.randomUUID();
  const part = (
    await db.query<Part>(
      `INSERT INTO conversation_parts(workspace_id,id,conversation_id,seq,kind,author_type,author_id,audience,channel,body,data,supersedes_id,created_at,origin_timezone)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        w,
        id,
        c.id,
        version.next_seq,
        kind,
        author.type,
        author.id,
        audience,
        c.channel ?? "messenger",
        body,
        JSON.stringify({
          ...data,
          ...(author.type === "teammate" && author.name
            ? { authorName: author.name }
            : {}),
        }),
        supersedes,
        version.updated_at,
        author.originTimezone ?? (author.type === "system" ? "UTC" : null),
      ],
    )
  ).rows[0];
  await db.query(
    "INSERT INTO outbox(workspace_id,id,kind,resource_id,payload) VALUES($1,$2,$3,$4,$5)",
    [
      w,
      id,
      "conversation",
      c.id,
      JSON.stringify({ conversationId: c.id, seq: version.next_seq }),
    ],
  );
  if (body)
    await db.query(
      "INSERT INTO conversation_search_documents(workspace_id,conversation_id,part_id,audience,document,revision) VALUES($1,$2,$3,$4,to_tsvector('simple',$5),$6)",
      [w, c.id, id, audience, body, version.next_seq],
    );
  c.next_seq = version.next_seq;
  return part;
}
async function transition(
  db: Sql,
  w: string,
  c: Conversation,
  author: { type: string; id: string },
  state: string,
  detail: Record<string, unknown> = {},
) {
  if (c.status === state && state !== "snoozed") return;
  const part = await append(db, w, c, author, "state_change", "", {
    from: c.status,
    to: state,
    ...detail,
  });
  if (state === "closed")
    await db.query(
      "UPDATE conversation_cycles SET closed_at=$3,closed_seq=$4 WHERE workspace_id=$1 AND conversation_id=$2 AND closed_at IS NULL",
      [w, c.id, part.created_at, part.seq],
    );
  if (state === "open" && c.status === "closed")
    await db.query(
      "INSERT INTO conversation_cycles(workspace_id,conversation_id,opened_seq,opened_at) VALUES($1,$2,$3,$4)",
      [w, c.id, part.seq, part.created_at],
    );
  await db.query(
    "UPDATE conversations SET status=$3,snooze_until=CASE WHEN $3='snoozed' THEN snooze_until ELSE NULL END,snooze_unassign=CASE WHEN $3='snoozed' THEN snooze_unassign ELSE false END,snooze_timezone=CASE WHEN $3='snoozed' THEN snooze_timezone ELSE NULL END,snooze_version=snooze_version+1 WHERE workspace_id=$1 AND id=$2",
    [w, c.id, state],
  );
  c.status = state;
}
function views(c: Conversation, t: string, teams: string[]) {
  return [
    "all",
    c.status,
    ...(c.assigned === t ? ["mine"] : []),
    ...(!c.assigned ? ["unassigned"] : []),
    ...(c.priority ? ["priority"] : []),
    ...(c.team_id && teams.includes(c.team_id) ? ["team:" + c.team_id] : []),
  ];
}
export async function syncUnread(
  db: Sql,
  w: string,
  c: Conversation,
  markUnread: boolean | ReadonlySet<string> = false,
  readBy?: string,
) {
  const old = (
    await db.query<{ teammate_id: string; views: string[] }>(
      "SELECT teammate_id,views FROM conversation_unread WHERE workspace_id=$1 AND conversation_id=$2",
      [w, c.id],
    )
  ).rows;
  const agents = (
    await db.query<{ id: string; teams: string[] }>(
      "SELECT t.id,ARRAY(SELECT team_id FROM teammate_teams WHERE workspace_id=t.workspace_id AND teammate_id=t.id) AS teams FROM teammates t WHERE t.workspace_id=$1",
      [w],
    )
  ).rows;
  const deltas: { teammate: string; view: string; delta: number }[] = [];
  const desired: { teammate_id: string; views: string[] }[] = [];
  for (const t of agents) {
    const before = old.find((x) => x.teammate_id === t.id)?.views ?? [],
      mark =
        typeof markUnread === "boolean" ? markUnread : markUnread.has(t.id);
    const after =
      t.id === readBy
        ? []
        : mark || before.length
          ? views(c, t.id, t.teams)
          : [];
    for (const v of before)
      if (!after.includes(v))
        deltas.push({ teammate: t.id, view: v, delta: -1 });
    for (const v of after)
      if (!before.includes(v))
        deltas.push({ teammate: t.id, view: v, delta: 1 });
    if (after.length) desired.push({ teammate_id: t.id, views: after });
  }
  if (deltas.length) {
    await db.query(
      `INSERT INTO inbox_counters(workspace_id,teammate_id,view,count,version)
  SELECT $1,x.teammate,x.view,0,0 FROM jsonb_to_recordset($2::jsonb) AS x(teammate text,view text,delta int)
  ORDER BY x.teammate,x.view ON CONFLICT DO NOTHING`,
      [w, JSON.stringify(deltas)],
    );
    await db.query(
      `UPDATE inbox_counters c SET count=c.count+x.delta,version=c.version+1 FROM jsonb_to_recordset($2::jsonb) AS x(teammate text,view text,delta int) WHERE c.workspace_id=$1 AND c.teammate_id=x.teammate AND c.view=x.view`,
      [w, JSON.stringify(deltas)],
    );
    await db.query(
      "DELETE FROM conversation_unread WHERE workspace_id=$1 AND conversation_id=$2",
      [w, c.id],
    );
    if (desired.length)
      await db.query(
        "INSERT INTO conversation_unread(workspace_id,conversation_id,teammate_id,views) SELECT $1,$2,x.teammate_id,x.views FROM jsonb_to_recordset($3::jsonb) AS x(teammate_id text,views text[])",
        [w, c.id, JSON.stringify(desired)],
      );
  }
}

/**
 * Message content from a command: plain `text`, or a rich `doc` (teammates only) that is
 * validated, rebuilt from allowed content and flattened to the plain-text `body`. A document
 * without formatting is stored as plain text only.
 */
function messageContent(
  p: Command,
  actor: Actor,
): { text: string; doc?: RichDoc } {
  if (p.doc === undefined) {
    assert(
      typeof p.text === "string" &&
        p.text.trim().length > 0 &&
        p.text.length <= 5000,
      "INVALID_MESSAGE",
      "Write a message of up to 5,000 characters.",
    );
    return { text: p.text.trim() };
  }
  assert(
    actor.type === "teammate",
    "FORBIDDEN",
    "Formatted messages are for teammates.",
    403,
  );
  let doc: RichDoc;
  try {
    doc = normalizeDoc(p.doc);
  } catch (e) {
    if (e instanceof RichDocError)
      throw new DomainError(e.code, e.message, 400);
    throw e;
  }
  const text = plainText(doc);
  assert(text.length > 0, "INVALID_MESSAGE", "Write a message.");
  return isPlain(doc) ? { text } : { text, doc };
}
/** Records which images a sent part places, after `verifyInlineImages` accepted them. */
async function recordImages(db: Sql, w: string, partId: string, doc?: RichDoc) {
  const ids = doc ? imageIds(doc) : [];
  if (ids.length)
    await db.query(
      "INSERT INTO conversation_part_images(workspace_id,part_id,attachment_id) SELECT $1,$2,unnest($3::text[]) ON CONFLICT DO NOTHING",
      [w, partId, ids],
    );
}
/**
 * Resolves mentions in a message: refused in customer replies; in notes, labels are rewritten
 * from the directory and the text re-derived. Returns the teammates to notify.
 */
async function prepareMentions(
  db: Sql,
  w: string,
  content: { text: string; doc?: RichDoc },
  note: boolean,
) {
  if (!content.doc || !mentions(content.doc).length) return [];
  assert(
    note,
    "MENTION_IN_REPLY",
    "Mention teammates in an internal note, not in a reply the customer sees.",
  );
  const resolved = await resolveMentions(db, w, content.doc);
  content.doc = resolved.doc;
  content.text = plainText(resolved.doc);
  return resolved.recipients;
}
export async function command(
  db: Sql,
  w: string,
  actor: Actor,
  key: string,
  p: Command,
) {
  const scope =
    actor.type === "contact"
      ? "contact:" + actor.identityId
      : "teammate:" + actor.principal;
  return once(db, w, scope, key, p, async () => {
    if (p.action === "start") {
      assert(
        actor.type === "contact",
        "FORBIDDEN",
        "Only a customer can start through this endpoint.",
        403,
      );
      assert(
        typeof p.text === "string" &&
          p.text.trim().length > 0 &&
          p.text.length <= 5000,
        "INVALID_MESSAGE",
        "Write a message of up to 5,000 characters.",
      );
      const brand = (
        await db.query<{ settings: Record<string, unknown> }>(
          "SELECT settings FROM brands WHERE workspace_id=$1 AND id=$2",
          [w, actor.brandId],
        )
      ).rows[0];
      assert(brand, "BRAND_NOT_FOUND", "Brand unavailable.", 404);
      assert(
        brand.settings.allowVisitors !== false || actor.verified === true,
        "VISITORS_DISABLED",
        "Sign in to your account to start a conversation.",
        403,
      );
      assert(
        !brand.settings.requireSearch,
        "HELP_SEARCH_REQUIRED",
        "Search the help center before starting a conversation.",
        409,
      );
      const id = crypto.randomUUID();
      const c = (
        await db.query<Conversation>(
          `INSERT INTO conversations(workspace_id,id,brand_id,primary_identity_id,token_hash,name,email,title,created_at,updated_at) VALUES($1,$2,$3,$4,'','Customer','',$5,now(),now()) RETURNING *`,
          [w, id, actor.brandId, actor.identityId, p.text.slice(0, 70)],
        )
      ).rows[0];
      if (brand.settings.calendarId)
        await db.query(
          "UPDATE conversations SET calendar_id=$3,calendar_version=$4,origin_timezone=$5 WHERE workspace_id=$1 AND id=$2",
          [
            w,
            id,
            brand.settings.calendarId,
            brand.settings.calendarVersion,
            actor.originTimezone ?? null,
          ],
        );
      const opened = await append(
        db,
        w,
        c,
        { type: "system", id: "relay" },
        "state_change",
        "",
        { from: null, to: "open" },
      );
      await db.query(
        "INSERT INTO conversation_cycles(workspace_id,conversation_id,opened_seq,opened_at) VALUES($1,$2,$3,$4)",
        [w, id, opened.seq, opened.created_at],
      );
      await append(
        db,
        w,
        c,
        {
          type: "contact",
          id: actor.identityId,
          originTimezone: actor.originTimezone,
        },
        "customer_message",
        p.text.trim(),
      );
      await db.query(
        "UPDATE conversations SET last_contact_reply_at=updated_at WHERE workspace_id=$1 AND id=$2",
        [w, id],
      );
      await syncUnread(db, w, c, true);
      return { conversationId: id };
    }
    assert(p.conversationId, "CONVERSATION_REQUIRED", "Choose a conversation.");
    // Merges lock both roots in stable order to avoid inconsistent interleavings.
    if (p.action === "merge") {
      assert(
        actor.type === "teammate" && p.targetId,
        "FORBIDDEN",
        "Choose a target conversation.",
        403,
      );
      const roots = [
        await conversation(db, w, p.conversationId),
        await conversation(db, w, p.targetId),
      ].sort((a, b) => a.id.localeCompare(b.id));
      for (const root of roots) await conversation(db, w, root.id, true);
      const source = await conversation(db, w, p.conversationId, true),
        target = await conversation(db, w, p.targetId, true);
      const who = await access(db, w, source, actor, "conversations.manage");
      await access(db, w, target, actor, "conversations.manage");
      await assertMergeable(db, w, source);
      assert(
        source.visibility !== "internal" && target.visibility !== "internal",
        "INTERNAL_TICKET",
        "Back-office and tracker tickets cannot be merged.",
        409,
      );
      assert(
        source.id !== target.id,
        "ALREADY_MERGED",
        "These conversations already share a timeline.",
        409,
      );
      assert(
        source.brand_id === target.brand_id &&
          (await identityContact(db, w, source.primary_identity_id)) ===
            (await identityContact(db, w, target.primary_identity_id)),
        "MERGE_CONTACT_MISMATCH",
        "Merge requires the same brand and primary contact.",
        409,
      );
      await append(db, w, source, who, "merge_marker", "", { into: target.id });
      await append(db, w, target, who, "merge_marker", "", { from: source.id });
      await db.query(
        "UPDATE conversations SET merged_into_id=$3,timeline_revision=timeline_revision+1 WHERE workspace_id=$1 AND id=$2",
        [w, source.id, target.id],
      );
      await db.query(
        "UPDATE conversations SET timeline_revision=timeline_revision+1 WHERE workspace_id=$1 AND id=$2",
        [w, target.id],
      );
      await db.query(
        "INSERT INTO conversation_participants(workspace_id,conversation_id,identity_id) SELECT $1,$2,identity_id FROM conversation_participants WHERE workspace_id=$1 AND conversation_id=$3 UNION SELECT $1,$2,$4 ON CONFLICT DO NOTHING",
        [w, target.id, source.id, source.primary_identity_id],
      );
      // Move per-agent unread state without double-counting either original timeline.
      const unread = (
        await db.query<{ teammate_id: string; views: string[] }>(
          "DELETE FROM conversation_unread WHERE workspace_id=$1 AND conversation_id=$2 RETURNING teammate_id,views",
          [w, source.id],
        )
      ).rows;
      const remove = unread.flatMap((row) =>
        row.views.map((view) => ({ teammate: row.teammate_id, view })),
      );
      if (remove.length)
        await db.query(
          "UPDATE inbox_counters c SET count=c.count-1,version=c.version+1 FROM jsonb_to_recordset($2::jsonb) AS x(teammate text,view text) WHERE c.workspace_id=$1 AND c.teammate_id=x.teammate AND c.view=x.view",
          [w, JSON.stringify(remove)],
        );
      if (unread.length)
        await syncUnread(
          db,
          w,
          target,
          new Set(unread.map((row) => row.teammate_id)),
        );
      await refreshCustomerUnread(db, w, [target.id]);
      return {
        conversationId: target.id,
        aliases: [source.id, target.id],
        reset: true,
      };
    }
    const c = await conversation(db, w, p.conversationId, true);
    const capability: Capability =
      p.action === "reply"
        ? "conversations.reply"
        : p.action === "note"
          ? "conversations.note"
          : p.action === "assign"
            ? "conversations.assign"
            : p.action === "read"
              ? "conversations.read"
              : "conversations.manage";
    const who = await access(db, w, c, actor, capability);
    if (p.action === "reply" || p.action === "note") {
      assert(
        p.action !== "note" || actor.type === "teammate",
        "FORBIDDEN",
        "Customers cannot add internal notes.",
        403,
      );
      assert(
        p.action === "note" || c.visibility !== "internal",
        "INTERNAL_TICKET",
        "This ticket has no customer to reply to. Add an internal note instead.",
        409,
      );
      const content = messageContent(p, actor);
      const mentioned = await prepareMentions(
        db,
        w,
        content,
        p.action === "note",
      );
      if (content.doc)
        await verifyInlineImages(
          db,
          w,
          c,
          who.id,
          imageIds(content.doc),
          p.action === "note" ? "internal" : "public",
        );
      if (actor.type === "contact" && c.status !== "open")
        await transition(db, w, c, who, "open");
      const kind =
        p.action === "note"
          ? "internal_note"
          : actor.type === "contact"
            ? "customer_message"
            : "teammate_reply";
      const part = await append(
        db,
        w,
        c,
        who,
        kind,
        content.text,
        {
          ...(actor.type === "teammate" && /^[0-9a-f-]{36}$/i.test(key)
            ? { clientMutationId: key }
            : {}),
          ...(content.doc ? { doc: content.doc } : {}),
        },
        p.action === "note" ? "internal" : "public",
      );
      await recordImages(db, w, part.id, content.doc);
      if (mentioned.length)
        await recordMentions(
          db,
          w,
          c.id,
          part,
          who.id,
          mentioned,
          content.doc!,
        );
      // Sending consumes the author's draft for this mode, in the same transaction.
      if (actor.type === "teammate")
        await db.query(
          "DELETE FROM conversation_drafts WHERE workspace_id=$1 AND conversation_id=$2 AND teammate_id=$3 AND mode=$4",
          [w, c.id, who.id, p.action],
        );
      if (kind === "customer_message")
        await db.query(
          "UPDATE conversations SET last_contact_reply_at=$3 WHERE workspace_id=$1 AND id=$2",
          [w, c.id, part.created_at],
        );
      let metricsJobId: string | undefined;
      if (kind === "teammate_reply") {
        await db.query(
          "UPDATE conversations SET last_teammate_reply_at=$3,first_response_ms=COALESCE(first_response_ms,(extract(epoch from ($3::timestamptz-created_at))*1000)::bigint) WHERE workspace_id=$1 AND id=$2",
          [w, c.id, part.created_at],
        );
        await customerReply(db, w, c, part.seq);
        if (c.first_response_ms === null)
          metricsJobId = await enqueueJob(
            db,
            w,
            "conversation.metrics",
            { conversationId: c.id },
            { teammateId: who.id },
          );
      }
      await syncUnread(
        db,
        w,
        c,
        kind === "customer_message",
        actor.type === "teammate" ? who.id : undefined,
      );
      return {
        conversationId: c.id,
        partId: part.id,
        ...(metricsJobId ? { metricsJobId } : {}),
      };
    }
    if (p.action === "read") {
      assert(
        actor.type === "teammate",
        "FORBIDDEN",
        "Use the customer session read endpoint.",
        403,
      );
      await db.query(
        "INSERT INTO conversation_reads(workspace_id,conversation_id,teammate_id,read_seq) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,conversation_id,teammate_id) DO UPDATE SET read_seq=GREATEST(conversation_reads.read_seq,EXCLUDED.read_seq)",
        [w, c.id, who.id, c.next_seq],
      );
      await syncUnread(db, w, c, false, who.id);
      return { ok: true };
    }
    assert(
      actor.type === "teammate" || p.action === "rating",
      "FORBIDDEN",
      "This action requires a teammate.",
      403,
    );
    if (["close", "reopen", "wake", "snooze"].includes(p.action)) {
      let detail: Record<string, unknown> = {};
      if (p.action === "snooze") {
        // Presets resolve on the server in the teammate's timezone; the client never sends a
        // computed instant for them. A custom wakeAt must carry an explicit offset.
        const wake = resolveWake(p);
        assert(
          p.unassignOnWake === undefined ||
            typeof p.unassignOnWake === "boolean",
          "INVALID_SNOOZE",
          "Choose whether waking unassigns.",
        );
        await db.query(
          "UPDATE conversations SET snooze_until=$3,snooze_unassign=$4,snooze_timezone=$5 WHERE workspace_id=$1 AND id=$2",
          [
            w,
            c.id,
            wake.wakeAt.toISOString(),
            p.unassignOnWake === true,
            wake.timeZone,
          ],
        );
        detail = {
          until: wake.wakeAt.toISOString(),
          timezone: wake.timeZone,
          ...(p.preset ? { preset: p.preset } : {}),
          ...(p.unassignOnWake ? { unassignOnWake: true } : {}),
        };
      }
      if (p.action === "wake" && p.expectedVersion !== undefined)
        assert(
          Number(c.snooze_version) === p.expectedVersion,
          "STALE_TIMER",
          "This wake timer has been replaced.",
          409,
        );
      if (p.action === "close") await assertClosable(db, w, c);
      await transition(
        db,
        w,
        c,
        who,
        p.action === "close"
          ? "closed"
          : p.action === "snooze"
            ? "snoozed"
            : "open",
        detail,
      );
    } else if (p.action === "priority") {
      assert(
        typeof p.value === "boolean",
        "INVALID_PRIORITY",
        "Priority must be true or false.",
      );
      await append(db, w, c, who, "priority_change", "", {
        before: c.priority,
        after: p.value,
      });
      await db.query(
        "UPDATE conversations SET priority=$3 WHERE workspace_id=$1 AND id=$2",
        [w, c.id, p.value],
      );
      c.priority = p.value;
    } else if (p.action === "assign") {
      if (p.teammateId)
        assert(
          (
            await db.query(
              "SELECT id FROM teammates WHERE workspace_id=$1 AND id=$2",
              [w, p.teammateId],
            )
          ).rows.length,
          "INVALID_ASSIGNEE",
          "Teammate unavailable.",
          404,
        );
      if (p.teamId)
        assert(
          (
            await db.query(
              "SELECT id FROM teams WHERE workspace_id=$1 AND id=$2",
              [w, p.teamId],
            )
          ).rows.length,
          "INVALID_TEAM",
          "Team unavailable.",
          404,
        );
      if (p.teammateId && !c.assigned)
        await append(db, w, c, who, "system_event", "", {
          event: "human_joined",
          teammateId: p.teammateId,
        });
      await append(
        db,
        w,
        c,
        who,
        "assignment_change",
        "",
        {
          before: { teammate: c.assigned, team: c.team_id },
          after: { teammate: p.teammateId ?? "", team: p.teamId ?? null },
        },
        "internal",
      );
      await db.query(
        "UPDATE conversations SET assigned=$3,team_id=$4 WHERE workspace_id=$1 AND id=$2",
        [w, c.id, p.teammateId ?? "", p.teamId ?? null],
      );
      c.assigned = p.teammateId ?? "";
      c.team_id = p.teamId ?? null;
    } else if (
      p.action === "participant_add" ||
      p.action === "participant_remove"
    ) {
      assert(p.participantId, "INVALID_PARTICIPANT", "Choose a participant.");
      assert(
        c.visibility !== "internal",
        "INTERNAL_TICKET",
        "Customers cannot be added to back-office or tracker tickets.",
        409,
      );
      await identityContact(db, w, p.participantId);
      if (p.action === "participant_add")
        await db.query(
          "INSERT INTO conversation_participants(workspace_id,conversation_id,identity_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [w, c.id, p.participantId],
        );
      else
        await db.query(
          "DELETE FROM conversation_participants WHERE workspace_id=$1 AND conversation_id=$2 AND identity_id=$3",
          [w, c.id, p.participantId],
        );
      await append(
        db,
        w,
        c,
        who,
        "participant_change",
        "",
        { action: p.action, identityId: p.participantId },
        "internal",
      );
      await refreshCustomerUnread(db, w, [c.id]);
    } else if (p.action === "edit" || p.action === "delete") {
      const part = (
        await db.query<Part>(
          "SELECT * FROM conversation_parts WHERE workspace_id=$1 AND id=$2",
          [w, p.partId],
        )
      ).rows[0];
      assert(
        part &&
          ["internal_note", "teammate_reply"].includes(part.kind) &&
          (await conversation(db, w, part.conversation_id)).id === c.id,
        "EDIT_NOT_ALLOWED",
        "Only notes and teammate replies in this timeline can be superseded.",
      );
      if (p.action === "delete")
        await authorize(
          db,
          w,
          actor.type === "teammate" ? actor.principal : "",
          part.kind === "internal_note"
            ? "conversations.delete_note"
            : "conversations.delete_reply",
        );
      assert(
        !(
          await db.query(
            "SELECT id FROM conversation_parts WHERE workspace_id=$1 AND supersedes_id=$2",
            [w, p.partId],
          )
        ).rows.length,
        "EDIT_CONFLICT",
        "This part has a newer version.",
        409,
      );
      const content: { text: string; doc?: RichDoc } =
        p.action === "delete" ? { text: "" } : messageContent(p, actor);
      const mentioned = await prepareMentions(
        db,
        w,
        content,
        part.kind === "internal_note",
      );
      if (content.doc)
        await verifyInlineImages(
          db,
          w,
          c,
          who.id,
          imageIds(content.doc),
          part.audience === "internal" ? "internal" : "public",
        );
      const replacement = await append(
        db,
        w,
        c,
        who,
        part.kind,
        content.text,
        {
          deleted: p.action === "delete",
          ...(content.doc ? { doc: content.doc } : {}),
        },
        part.audience,
        part.id,
      );
      await recordImages(db, w, replacement.id, content.doc);
      if (mentioned.length)
        await recordMentions(
          db,
          w,
          c.id,
          { id: replacement.id, supersedes_id: part.id },
          who.id,
          mentioned,
          content.doc!,
        );
      await db.query(
        "DELETE FROM conversation_search_documents WHERE workspace_id=$1 AND part_id=$2",
        [w, part.id],
      );
    } else if (p.action === "title") {
      assert(
        p.title && p.title.length <= 200,
        "INVALID_TITLE",
        "Enter a title of up to 200 characters.",
      );
      await append(
        db,
        w,
        c,
        who,
        "attribute_change",
        "",
        { attribute: "title", before: c.title, after: p.title },
        "internal",
      );
      await db.query(
        "UPDATE conversations SET title=$3,title_source='human' WHERE workspace_id=$1 AND id=$2",
        [w, c.id, p.title],
      );
    } else if (p.action === "tag_add" || p.action === "tag_remove") {
      assert(
        p.tagId &&
          (
            await db.query(
              "SELECT id FROM tags WHERE workspace_id=$1 AND id=$2",
              [w, p.tagId],
            )
          ).rows.length,
        "TAG_NOT_FOUND",
        "Tag unavailable.",
        404,
      );
      if (p.action === "tag_add")
        await db.query(
          "INSERT INTO conversation_tags(workspace_id,conversation_id,tag_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [w, c.id, p.tagId],
        );
      else
        await db.query(
          "DELETE FROM conversation_tags WHERE workspace_id=$1 AND conversation_id=$2 AND tag_id=$3",
          [w, c.id, p.tagId],
        );
      await append(
        db,
        w,
        c,
        who,
        "tag_change",
        "",
        { action: p.action, tagId: p.tagId },
        "internal",
      );
    } else if (p.action === "topics") {
      assert(
        Array.isArray(p.value) &&
          p.value.length <= 20 &&
          p.value.every(
            (x) => typeof x === "string" && x.length > 0 && x.length <= 100,
          ),
        "INVALID_TOPICS",
        "Choose up to 20 topic labels.",
      );
      const values = [...new Set(p.value)].sort();
      await append(
        db,
        w,
        c,
        who,
        "attribute_change",
        "",
        { attribute: "topics", before: c.topics, after: values },
        "internal",
      );
      await db.query(
        "UPDATE conversations SET topics=$3 WHERE workspace_id=$1 AND id=$2",
        [w, c.id, values],
      );
    } else if (p.action === "attribute_set") {
      const definition = (
        await db.query<{
          value_type: string;
          options: string[] | null;
          archived_at: string | null;
        }>(
          "SELECT value_type,options,archived_at FROM attribute_definitions WHERE workspace_id=$1 AND id=$2 AND owner_type='conversation'",
          [w, p.attributeId],
        )
      ).rows[0];
      assert(
        definition && !definition.archived_at,
        "ATTRIBUTE_NOT_FOUND",
        "Active conversation attribute unavailable.",
        404,
      );
      await assertFieldAllowed(db, w, c, p.attributeId!);
      const value = p.value,
        kind = definition.value_type;
      const valid =
        value === null ||
        (kind === "string" &&
          typeof value === "string" &&
          value.length <= 10000) ||
        (kind === "integer" && Number.isSafeInteger(value)) ||
        (kind === "float" &&
          typeof value === "number" &&
          Number.isFinite(value)) ||
        (kind === "boolean" && typeof value === "boolean") ||
        (kind === "date" &&
          typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(value) &&
          Number.isFinite(Date.parse(value)) &&
          new Date(value).toISOString().slice(0, 10) === value) ||
        (kind === "options" &&
          Array.isArray(value) &&
          value.length <= 100 &&
          value.every(
            (x) => typeof x === "string" && definition.options?.includes(x),
          ));
      assert(
        valid,
        "ATTRIBUTE_TYPE",
        "Value does not match the attribute definition.",
      );
      const before =
        (c.attributes as Record<string, unknown>)[p.attributeId!] ?? null;
      await append(
        db,
        w,
        c,
        who,
        "attribute_change",
        "",
        { attributeId: p.attributeId, before, after: value },
        "internal",
      );
      await db.query(
        "DELETE FROM conversation_attribute_values WHERE workspace_id=$1 AND conversation_id=$2 AND attribute_id=$3",
        [w, c.id, p.attributeId],
      );
      if (value !== null)
        await db.query(
          "INSERT INTO conversation_attribute_values(workspace_id,conversation_id,attribute_id,string_value,integer_value,float_value,boolean_value,date_value,option_values,origin_timezone) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            w,
            c.id,
            p.attributeId,
            kind === "string" ? value : null,
            kind === "integer" ? value : null,
            kind === "float" ? value : null,
            kind === "boolean" ? value : null,
            kind === "date" ? value : null,
            kind === "options" ? [...new Set(value as string[])].sort() : null,
            actor.originTimezone ?? null,
          ],
        );
      if (value === null)
        await db.query(
          "UPDATE conversations SET attributes=attributes-$3 WHERE workspace_id=$1 AND id=$2",
          [w, c.id, p.attributeId],
        );
      else
        await db.query(
          "UPDATE conversations SET attributes=attributes||jsonb_build_object($3::text,$4::jsonb) WHERE workspace_id=$1 AND id=$2",
          [w, c.id, p.attributeId, JSON.stringify(value)],
        );
    } else if (p.action === "rating") {
      assert(
        Number.isInteger(p.value) &&
          Number(p.value) >= 1 &&
          Number(p.value) <= 5,
        "INVALID_RATING",
        "Choose a rating from 1 to 5.",
      );
      await append(db, w, c, who, "rating", "", { value: p.value });
      await db.query(
        "UPDATE conversations SET rating=$3 WHERE workspace_id=$1 AND id=$2",
        [w, c.id, p.value],
      );
    } else if (p.action === "ticket") {
      await convertToTicket(db, w, c, who, p, append);
    } else if (p.action === "ticket_state") {
      await setTicketState(db, w, c, who, p, append);
    } else if (p.action === "ticket_type") {
      await changeTicketType(db, w, c, who, p, append);
    } else if (p.action === "ticket_link") {
      await linkToTracker(db, w, c, who, p);
    } else if (p.action === "ticket_unlink") {
      await unlinkFromTracker(db, w, c, who, p);
    } else assert(false, "UNKNOWN_COMMAND", "Unsupported conversation action.");
    await syncUnread(db, w, c);
    return { conversationId: c.id };
  });
}

export async function timeline(
  db: Sql,
  w: string,
  id: string,
  actor: Actor,
  after?: { revision: string; positions: Record<string, string> },
): Promise<{
  conversation: Conversation;
  parts: Part[];
  positions: Record<string, string>;
  hasMore: boolean;
  reset: boolean;
}> {
  const c = await conversation(db, w, id);
  await access(db, w, c, actor);
  const reset =
    !after ||
    String(after.revision) !== c.id + ":" + String(c.timeline_revision);
  const positions = reset ? {} : { ...after.positions };
  const scanned = (
    await db.query<Part>(
      `WITH RECURSIVE family AS (SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 UNION ALL SELECT c.id FROM conversations c JOIN family f ON c.merged_into_id=f.id WHERE c.workspace_id=$1)
 SELECT p.*,a.audience AS attachment_audience FROM conversation_parts p JOIN family f ON p.conversation_id=f.id
 LEFT JOIN attachments a ON p.kind='attachment' AND a.workspace_id=p.workspace_id AND a.id=p.data->>'attachmentId'
 WHERE p.workspace_id=$1 AND p.seq>COALESCE(($3::jsonb->>p.conversation_id)::bigint,0) ORDER BY p.created_at,p.conversation_id,p.seq LIMIT 200`,
      [w, c.id, JSON.stringify(positions)],
    )
  ).rows;
  for (const p of scanned) positions[p.conversation_id] = String(p.seq);
  return {
    conversation: c,
    parts: scanned.filter(
      (p) => actor.type === "teammate" || customerVisiblePart(p),
    ),
    positions,
    hasMore: scanned.length === 200,
    reset,
  };
}

/** Upper bounds (exclusive) on seq per family member, for reading history backwards. */
export type OlderBounds = Record<string, string>;
/**
 * Reads up to `limit` parts below `bounds`, newest first per member, then orders them by the
 * shared timeline key. Returns them oldest first with the new bounds and whether more exist.
 * Bounds are per-member seq values, so parts are never skipped or repeated even when
 * created_at and seq disagree across concurrent writers.
 */
async function partsBefore(
  db: Sql,
  w: string,
  c: Conversation,
  actor: Actor,
  bounds: OlderBounds,
  limit: number,
) {
  const rows = (
    await db.query<Part>(
      `WITH RECURSIVE family AS (SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 UNION ALL SELECT c.id FROM conversations c JOIN family f ON c.merged_into_id=f.id WHERE c.workspace_id=$1)
      SELECT p.*,a.audience AS attachment_audience FROM family f CROSS JOIN LATERAL (
        SELECT * FROM conversation_parts p WHERE p.workspace_id=$1 AND p.conversation_id=f.id
        AND p.seq<COALESCE(($3::jsonb->>f.id)::bigint,9223372036854775807) ORDER BY p.seq DESC LIMIT $4) p
      LEFT JOIN attachments a ON p.kind='attachment' AND a.workspace_id=p.workspace_id AND a.id=p.data->>'attachmentId'
      ORDER BY p.created_at DESC,p.conversation_id DESC,p.seq DESC`,
      [w, c.id, JSON.stringify(bounds), limit + 1],
    )
  ).rows;
  const taken = rows.slice(0, limit),
    next = { ...bounds };
  for (const p of taken)
    if (
      !next[p.conversation_id] ||
      BigInt(p.seq) < BigInt(next[p.conversation_id])
    )
      next[p.conversation_id] = String(p.seq);
  return {
    parts: taken
      .reverse()
      .filter((p) => actor.type === "teammate" || customerVisiblePart(p)),
    bounds: next,
    hasOlder: rows.length > limit,
  };
}
/**
 * First screen of a conversation: its newest `limit` parts, plus forward positions that start
 * exactly after them (for live replay) and bounds for reading older history. Positions are read
 * first and the window is capped at them, so a part committed in between is replayed, not lost.
 */
export async function recentTimeline(
  db: Sql,
  w: string,
  id: string,
  actor: Actor,
  limit = 50,
) {
  const c = await conversation(db, w, id);
  await access(db, w, c, actor);
  const positions: Record<string, string> = {};
  for (const r of (
    await db.query<{ conversation_id: string; seq: string }>(
      `WITH RECURSIVE family AS (SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 UNION ALL SELECT c.id FROM conversations c JOIN family f ON c.merged_into_id=f.id WHERE c.workspace_id=$1)
      SELECT f.id AS conversation_id,(SELECT max(seq) FROM conversation_parts p WHERE p.workspace_id=$1 AND p.conversation_id=f.id)::text AS seq FROM family f`,
      [w, c.id],
    )
  ).rows)
    if (r.seq) positions[r.conversation_id] = r.seq;
  const upper = Object.fromEntries(
    Object.entries(positions).map(([k, v]) => [
      k,
      String(BigInt(v) + BigInt(1)),
    ]),
  );
  const page = await partsBefore(db, w, c, actor, upper, limit);
  return {
    conversation: c,
    parts: page.parts,
    positions,
    revision: c.id + ":" + String(c.timeline_revision),
    older: page.hasOlder ? page.bounds : null,
  };
}
/** One page of history older than `bounds`, for a teammate scrolling back. */
export async function olderTimeline(
  db: Sql,
  w: string,
  id: string,
  actor: Actor,
  bounds: OlderBounds,
  limit = 100,
) {
  const c = await conversation(db, w, id);
  await access(db, w, c, actor);
  const page = await partsBefore(db, w, c, actor, bounds, limit);
  return {
    conversation: c,
    parts: page.parts,
    revision: c.id + ":" + String(c.timeline_revision),
    older: page.hasOlder ? page.bounds : null,
  };
}

export async function publishAttachment(
  db: Sql,
  w: string,
  jobId: string,
  id: string,
  conversationId: string,
  author: { type: string; id: string },
  metadata: Record<string, unknown>,
  audience: "customer_visible" | "internal" = "internal",
) {
  return once(
    db,
    w,
    "job.attachment",
    jobId,
    { id, conversationId },
    async () => {
      const c = await conversation(db, w, conversationId, true);
      const part = await append(
        db,
        w,
        c,
        author,
        "attachment",
        "",
        {
          attachmentId: id,
          ...metadata,
        },
        audience === "internal" ? "internal" : "public",
      );
      if (audience === "customer_visible")
        await syncUnread(
          db,
          w,
          c,
          author.type === "contact",
          author.type === "teammate" ? author.id : undefined,
        );
      if (audience === "customer_visible" && author.type === "teammate")
        await customerReply(db, w, c, part.seq);
      return { partId: part.id };
    },
  );
}

export async function wakeConversation(
  db: Sql,
  w: string,
  id: string,
  version: string,
) {
  const c = await conversation(db, w, id, true);
  if (
    c.id !== id ||
    c.status !== "snoozed" ||
    // Compare as text: the production driver returns bigint as a string, PGlite as a number.
    String(c.snooze_version) !== String(version) ||
    !c.snooze_until ||
    new Date(c.snooze_until as string).getTime() > Date.now()
  )
    return { woke: false };
  // Read before the transition, which clears it. The version check above rejects a stale timer.
  const unassign = c.snooze_unassign === true && !!c.assigned;
  await transition(db, w, c, { type: "system", id: "snooze-clock" }, "open", {
    woke: true,
  });
  if (unassign) {
    await append(
      db,
      w,
      c,
      { type: "system", id: "snooze-clock" },
      "assignment_change",
      "",
      {
        before: { teammate: c.assigned, team: c.team_id },
        after: { teammate: "", team: c.team_id },
        reason: "snooze_wake",
      },
      "internal",
    );
    await db.query(
      "UPDATE conversations SET assigned='' WHERE workspace_id=$1 AND id=$2",
      [w, c.id],
    );
    c.assigned = "";
  }
  await syncUnread(db, w, c);
  return { woke: true };
}
