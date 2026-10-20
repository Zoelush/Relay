import { assert, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { enqueueJob, type Job } from "./jobs";
import { ALWAYS_OPEN, businessMilliseconds, type BusinessSchedule } from "./business-time";
import { METRICS } from "../lib/metrics";

/**
 * Reporting's store and its feed (phase 14, step R1; docs/REPORTING_STEP1.md), behind
 * `reports_v1`. The analytical store is a separate database (`db/analytics`): reports read only
 * it, never the tables that serve the inbox. It's written only by `analytics.project`, which reads
 * the application's append-only sources (each conversation's parts in order, the snapshot taken
 * when it started, contacts' later changes, pinned calendar versions) and works out each
 * conversation's facts with `conversationFacts`, the metric dictionary's code.
 *
 * The projection is idempotent: parts are keyed by their order in the conversation, snapshots and
 * changes by their ids, and facts are recomputed from all of a conversation's parts. Its first run
 * is the backfill. Conversations are found by their last change, read with an overlap (commits can
 * land out of order), and in batches that continue until the workspace is caught up.
 */
export type AnalyticsStore = { connect: Connect };
const BATCH = 200;
const OVERLAP_MS = 2 * 60_000;

export async function reportsOn(db: Sql, w: string) {
  return (await db.query("SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='reports_v1' AND enabled", [w])).rows.length > 0;
}

export type FactPart = { seq: number; kind: string; author_type: string; audience: string; at: Date; data: Record<string, unknown> };
export type Facts = {
  firstCustomerAt: Date | null;
  firstResponseAt: Date | null;
  firstResponseMs: number | null;
  firstResponseBusinessMs: number | null;
  firstClosedAt: Date | null;
  timeToCloseMs: number | null;
  timeToCloseBusinessMs: number | null;
  customerMessages: number;
  teammateReplies: number;
  aiReplies: number;
  workflowMessages: number;
  closes: number;
  reopens: number;
  assignments: number;
  aiInvolved: boolean;
  aiHandedOver: boolean;
  rating: number | null;
};

/**
 * A conversation's facts from its parts (lib/metrics.ts says what each means): the customer's
 * first message, the first teammate reply after it, the first close, counts of who wrote what,
 * closes and reopens, assignments, Zoe's part, and the latest rating. Durations wall-clock and in
 * the office hours of `calendar` (always open without one).
 */
export function conversationFacts(parts: FactPart[], startedAt: Date, calendar: { timezone: string; schedule: BusinessSchedule } | null): Facts {
  const sorted = [...parts].sort((a, b) => a.seq - b.seq);
  const business = (from: Date, to: Date) => {
    const c = calendar ?? { timezone: ALWAYS_OPEN.timezone, schedule: ALWAYS_OPEN };
    return businessMilliseconds(from, to, c.timezone, c.schedule);
  };
  const teammateReply = (p: FactPart) => p.kind === "teammate_reply" && p.author_type === "teammate" && p.audience === "public" && !p.data.deleted;
  const firstCustomer = sorted.find((p) => p.kind === "customer_message" && p.author_type === "contact");
  const firstResponse = firstCustomer ? sorted.find((p) => p.seq > firstCustomer.seq && teammateReply(p)) : undefined;
  const firstClose = sorted.find((p) => p.kind === "state_change" && p.data.to === "closed");
  const ratings = sorted.filter((p) => p.kind === "rating" && typeof p.data.value === "number");
  return {
    firstCustomerAt: firstCustomer?.at ?? null,
    firstResponseAt: firstResponse?.at ?? null,
    firstResponseMs: firstCustomer && firstResponse ? firstResponse.at.getTime() - firstCustomer.at.getTime() : null,
    firstResponseBusinessMs: firstCustomer && firstResponse ? business(firstCustomer.at, firstResponse.at) : null,
    firstClosedAt: firstClose?.at ?? null,
    timeToCloseMs: firstClose ? firstClose.at.getTime() - startedAt.getTime() : null,
    timeToCloseBusinessMs: firstClose ? business(startedAt, firstClose.at) : null,
    customerMessages: sorted.filter((p) => p.kind === "customer_message").length,
    teammateReplies: sorted.filter(teammateReply).length,
    aiReplies: sorted.filter((p) => p.kind === "ai_reply").length,
    workflowMessages: sorted.filter((p) => p.kind === "workflow_message").length,
    closes: sorted.filter((p) => p.kind === "state_change" && p.data.to === "closed").length,
    reopens: sorted.filter((p) => p.kind === "state_change" && p.data.to === "open" && p.data.from === "closed").length,
    assignments: sorted.filter((p) => p.kind === "assignment_change" && !!(p.data.after as { teammate?: string } | undefined)?.teammate).length,
    aiInvolved: sorted.some((p) => p.kind === "ai_reply"),
    aiHandedOver: sorted.some((p) => p.kind === "ai_reply" && p.data.handover === true),
    rating: ratings.length ? Number(ratings.at(-1)!.data.value) : null,
  };
}

/** `analytics.project`: one batch of a workspace's changed conversations (continued until caught up). */
export async function projectJob(main: Connect, store: AnalyticsStore, job: Job) {
  const w = job.workspace_id;
  const on = await tenant(main, w, (db) => reportsOn(db, w));
  if (!on) return { done: true, result: { projected: 0 } };
  const state = await tenant(store.connect, w, async (db) => {
    await db.query("INSERT INTO a_projection(workspace_id) VALUES($1) ON CONFLICT DO NOTHING", [w]);
    return (await db.query<{ watermark: Date; changes_watermark: Date }>("SELECT watermark,changes_watermark FROM a_projection WHERE workspace_id=$1", [w])).rows[0];
  });
  const prior = job.result as { after?: { at: string; id: string }; projected?: number; high?: string } | null;
  const since = (d: Date) => (Number.isFinite(new Date(d).getTime()) ? new Date(new Date(d).getTime() - OVERLAP_MS).toISOString() : "-infinity");
  // The batch: after this run's cursor, or (a new run) after the watermark less the overlap.
  const batch = await tenant(main, w, async (db) => {
    const rows = prior?.after
      ? (
          await db.query<{ id: string; updated_at: Date }>(
            "SELECT id,updated_at FROM conversations WHERE workspace_id=$1 AND (updated_at,id)>($2::timestamptz,$3) ORDER BY updated_at,id LIMIT $4",
            [w, prior.after.at, prior.after.id, BATCH],
          )
        ).rows
      : (
          await db.query<{ id: string; updated_at: Date }>("SELECT id,updated_at FROM conversations WHERE workspace_id=$1 AND updated_at>$2::timestamptz ORDER BY updated_at,id LIMIT $3", [
            w,
            since(state.watermark),
            BATCH,
          ])
        ).rows;
    return rows;
  });
  for (const c of batch) await projectConversation(main, store, w, c.id);
  // Contacts' later changes, and the watermarks, once the conversations are caught up.
  const high = batch.length ? new Date(batch.at(-1)!.updated_at).toISOString() : (prior?.high ?? null);
  const projected = Number(prior?.projected ?? 0) + batch.length;
  if (batch.length === BATCH) return { done: false, result: { after: { at: high, id: batch.at(-1)!.id }, projected, high } };
  const changes = await tenant(main, w, async (db) => {
    const out: { id: string; contact_id: string; role: string; profile: Record<string, unknown>; changed_at: Date }[] = [];
    let after = since(state.changes_watermark);
    for (;;) {
      const rows = (
        await db.query<{ id: string; contact_id: string; role: string; profile: Record<string, unknown>; changed_at: Date }>(
          "SELECT id,contact_id,role,profile,changed_at FROM contact_changes WHERE workspace_id=$1 AND changed_at>$2::timestamptz ORDER BY changed_at,id LIMIT 1000",
          [w, after],
        )
      ).rows;
      out.push(...rows);
      if (rows.length < 1000) return out;
      after = new Date(rows.at(-1)!.changed_at).toISOString();
    }
  });
  await tenant(store.connect, w, async (db) => {
    for (const ch of changes)
      await db.query("INSERT INTO a_contact_changes(workspace_id,id,contact_id,role,profile,changed_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [
        w,
        ch.id,
        ch.contact_id,
        ch.role,
        JSON.stringify(ch.profile),
        new Date(ch.changed_at).toISOString(),
      ]);
    await db.query(
      `UPDATE a_projection SET watermark=GREATEST(watermark,COALESCE($2::timestamptz,watermark)),changes_watermark=GREATEST(changes_watermark,COALESCE($3::timestamptz,changes_watermark)),projected_at=now() WHERE workspace_id=$1`,
      [w, high, changes.length ? new Date(changes.at(-1)!.changed_at).toISOString() : null],
    );
  });
  return { done: true, result: { projected, changes: changes.length } };
}

/** One conversation: its new parts, its snapshot and calendar, then its facts recomputed. */
async function projectConversation(main: Connect, store: AnalyticsStore, w: string, id: string) {
  const projected = await tenant(store.connect, w, async (db) => Number((await db.query<{ seq: string }>("SELECT projected_seq AS seq FROM a_conversations WHERE workspace_id=$1 AND conversation_id=$2", [w, id])).rows[0]?.seq ?? 0));
  const src = await tenant(main, w, async (db) => {
    const c = (
      await db.query<{
        brand_id: string | null;
        channel: string | null;
        created_at: Date;
        status: string;
        visibility: string | null;
        outbound_message_id: string | null;
        merged_into_id: string | null;
        calendar_id: string | null;
        calendar_version: number | null;
      }>("SELECT brand_id,channel,created_at,status,visibility,outbound_message_id,merged_into_id,calendar_id,calendar_version FROM conversations WHERE workspace_id=$1 AND id=$2", [w, id])
    ).rows[0];
    if (!c) return null;
    const parts = (
      await db.query<{ seq: string; id: string; kind: string; author_type: string; author_id: string; audience: string; channel: string | null; created_at: Date; data: Record<string, unknown> }>(
        "SELECT seq,id,kind,author_type,author_id,audience,channel,created_at,data FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND seq>$3 ORDER BY seq",
        [w, id, projected],
      )
    ).rows;
    const snapshot = (await db.query<{ contact_id: string | null; role: string | null; profile: Record<string, unknown>; taken_at: Date }>("SELECT contact_id,role,profile,taken_at FROM conversation_snapshots WHERE workspace_id=$1 AND conversation_id=$2", [w, id])).rows[0];
    const calendar = c.calendar_id
      ? (await db.query<{ timezone: string; schedule: BusinessSchedule }>("SELECT timezone,schedule FROM business_calendars WHERE workspace_id=$1 AND id=$2 AND version=$3", [w, c.calendar_id, c.calendar_version])).rows[0]
      : undefined;
    return { c, parts, snapshot, calendar };
  });
  if (!src) return;
  const { c, parts, snapshot, calendar } = src;
  await tenant(store.connect, w, async (db) => {
    for (const p of parts)
      await db.query(
        "INSERT INTO a_parts(workspace_id,conversation_id,seq,id,kind,author_type,author_id,audience,channel,at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING",
        [w, id, p.seq, p.id, p.kind, p.author_type, p.author_id, p.audience, p.channel, new Date(p.created_at).toISOString(), JSON.stringify(reportable(p.kind, p.data))],
      );
    if (snapshot)
      await db.query("INSERT INTO a_snapshots(workspace_id,conversation_id,contact_id,role,profile,taken_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [
        w,
        id,
        snapshot.contact_id,
        snapshot.role,
        JSON.stringify(snapshot.profile ?? {}),
        new Date(snapshot.taken_at).toISOString(),
      ]);
    if (calendar)
      await db.query("INSERT INTO a_calendars(workspace_id,id,version,timezone,schedule) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [
        w,
        c.calendar_id,
        c.calendar_version,
        calendar.timezone,
        JSON.stringify(calendar.schedule),
      ]);
    const all = (
      await db.query<{ seq: string; kind: string; author_type: string; audience: string; at: Date; data: Record<string, unknown> }>(
        "SELECT seq,kind,author_type,audience,at,data FROM a_parts WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY seq",
        [w, id],
      )
    ).rows.map((p) => ({ ...p, seq: Number(p.seq), at: new Date(p.at) }));
    const f = conversationFacts(all, new Date(c.created_at), calendar ?? null);
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    await db.query(
      `INSERT INTO a_conversations(workspace_id,conversation_id,brand_id,channel,started_at,calendar_id,calendar_version,projected_seq,first_customer_at,first_response_at,first_response_ms,first_response_business_ms,
         first_closed_at,time_to_close_ms,time_to_close_business_ms,customer_messages,teammate_replies,ai_replies,workflow_messages,closes,reopens,assignments,ai_involved,ai_handed_over,rating,status,visibility,outbound,merged,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,now())
       ON CONFLICT (workspace_id,conversation_id) DO UPDATE SET projected_seq=EXCLUDED.projected_seq,first_customer_at=EXCLUDED.first_customer_at,first_response_at=EXCLUDED.first_response_at,
         first_response_ms=EXCLUDED.first_response_ms,first_response_business_ms=EXCLUDED.first_response_business_ms,first_closed_at=EXCLUDED.first_closed_at,time_to_close_ms=EXCLUDED.time_to_close_ms,
         time_to_close_business_ms=EXCLUDED.time_to_close_business_ms,customer_messages=EXCLUDED.customer_messages,teammate_replies=EXCLUDED.teammate_replies,ai_replies=EXCLUDED.ai_replies,
         workflow_messages=EXCLUDED.workflow_messages,closes=EXCLUDED.closes,reopens=EXCLUDED.reopens,assignments=EXCLUDED.assignments,ai_involved=EXCLUDED.ai_involved,ai_handed_over=EXCLUDED.ai_handed_over,
         rating=EXCLUDED.rating,status=EXCLUDED.status,visibility=EXCLUDED.visibility,outbound=EXCLUDED.outbound,merged=EXCLUDED.merged,updated_at=now()`,
      [
        w,
        id,
        c.brand_id,
        c.channel ?? "messenger",
        new Date(c.created_at).toISOString(),
        c.calendar_id,
        c.calendar_version,
        all.length ? all.at(-1)!.seq : projected,
        iso(f.firstCustomerAt),
        iso(f.firstResponseAt),
        f.firstResponseMs,
        f.firstResponseBusinessMs,
        iso(f.firstClosedAt),
        f.timeToCloseMs,
        f.timeToCloseBusinessMs,
        f.customerMessages,
        f.teammateReplies,
        f.aiReplies,
        f.workflowMessages,
        f.closes,
        f.reopens,
        f.assignments,
        f.aiInvolved,
        f.aiHandedOver,
        f.rating,
        c.status,
        c.visibility ?? "customer",
        !!c.outbound_message_id,
        !!c.merged_into_id,
      ],
    );
  });
}

/**
 * What of a part's data reporting keeps: only what metrics read (states, assignments, ratings,
 * Zoe's handover, deletion), never message bodies or personal data.
 */
function reportable(kind: string, data: Record<string, unknown>) {
  const keep: Record<string, unknown> = {};
  for (const k of ["from", "to", "after", "before", "reason", "value", "handover", "deleted", "event", "metric"]) if (k in data) keep[k] = data[k];
  if (kind === "assignment_change" && keep.after && typeof keep.after === "object") keep.after = { teammate: (keep.after as { teammate?: string }).teammate ?? null, team: (keep.after as { team?: string }).team ?? null };
  return keep;
}

/**
 * The conversations started in a period, from the store only: how many, first response (median,
 * wall-clock and office hours), and how many by a contact attribute as it was when each started.
 * R2 builds the datasets and every metric on this; R1 needs it for the snapshot guarantee.
 */
export async function conversationSummary(store: AnalyticsStore, w: string, range: { from: Date; to: Date }, byAttribute?: string) {
  return tenant(store.connect, w, async (db) => {
    const anchor = "(CASE WHEN c.outbound THEN c.first_customer_at ELSE c.started_at END)";
    const where = `c.workspace_id=$1 AND c.visibility='customer' AND NOT c.merged AND NOT (c.outbound AND c.first_customer_at IS NULL) AND ${anchor}>=$2 AND ${anchor}<$3`;
    const totals = (
      await db.query<{ n: number; median: number | null; median_business: number | null }>(
        `SELECT count(*)::int AS n,percentile_cont(0.5) WITHIN GROUP (ORDER BY c.first_response_ms) AS median,percentile_cont(0.5) WITHIN GROUP (ORDER BY c.first_response_business_ms) AS median_business
         FROM a_conversations c WHERE ${where}`,
        [w, range.from.toISOString(), range.to.toISOString()],
      )
    ).rows[0];
    const breakdown = byAttribute
      ? (
          await db.query<{ value: string | null; n: number }>(
            `SELECT s.profile->>$4 AS value,count(*)::int AS n FROM a_conversations c LEFT JOIN a_snapshots s ON s.workspace_id=c.workspace_id AND s.conversation_id=c.conversation_id
             WHERE ${where} GROUP BY 1 ORDER BY 2 DESC,1`,
            [w, range.from.toISOString(), range.to.toISOString(), byAttribute],
          )
        ).rows
      : [];
    return {
      newConversations: totals.n,
      firstResponseMedianMs: totals.median === null ? null : Math.round(Number(totals.median)),
      firstResponseMedianBusinessMs: totals.median_business === null ? null : Math.round(Number(totals.median_business)),
      byAttribute: breakdown.map((b) => ({ value: b.value, count: b.n })),
    };
  });
}

/** Settings › Reporting data: how current the store is, how much is in it, and the dictionary. */
export async function readReportingStatus(main: Connect, store: AnalyticsStore | undefined, w: string, principal: string) {
  await tenant(main, w, async (db) => {
    await authorize(db, w, principal, "reports.view");
    assert(await reportsOn(db, w), "REPORTS_DISABLED", "Reports are not enabled for this workspace.", 404);
  });
  const stored = store
    ? await tenant(store.connect, w, async (db) => ({
        asOf: (await db.query<{ projected_at: Date | null }>("SELECT projected_at FROM a_projection WHERE workspace_id=$1", [w])).rows[0]?.projected_at ?? null,
        conversations: (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM a_conversations WHERE workspace_id=$1", [w])).rows[0].n,
      }))
    : null;
  return {
    connected: !!store,
    asOf: stored?.asOf ? new Date(stored.asOf).toISOString() : null,
    conversations: stored?.conversations ?? 0,
    metrics: METRICS,
  };
}

/** The sweep: a projection run for the workspace, unless one is already queued or running. */
export async function scheduleProjection(main: Connect, w: string) {
  await tenant(main, w, async (db) => {
    if (!(await reportsOn(db, w))) return;
    if ((await db.query("SELECT 1 FROM jobs WHERE workspace_id=$1 AND kind='analytics.project' AND state IN ('queued','running') LIMIT 1", [w])).rows.length) return;
    await enqueueJob(db, w, "analytics.project", {}, {});
  });
}
