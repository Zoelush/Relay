import { DomainError, tenant, type Sql } from "./db";
import type { AnalyticsStore } from "./analytics";
import { metric as definition } from "../lib/metrics";
import type { Breakdown } from "../lib/reports";

/**
 * The query layer (phase 14, step R2; docs/REPORTING_STEP2.md): every metric in `lib/metrics.ts`
 * as one SQL definition over the analytical store, never the inbox's tables.
 *
 * Each metric's rows have the same columns: `at` (the time it's anchored to), the conversation and
 * its brand, channel, team and teammate, an `item` (a message, article, ticket type…), and what's
 * measured (`ok` for a share, `ms` and `business_ms` for a duration). One wrapper filters them to the
 * period, breaks them down (brand, channel, team, teammate, item, day, week or month in the report's
 * timezone, or a contact attribute as it was when the conversation started) and aggregates them by
 * the metric's kind. The previous period of the same length comes with every answer.
 */
type Kind = "count" | "distinct" | "share" | "duration";
type Def = { kind: Kind; rows: string };
const CUSTOMER = "c.visibility='customer' AND NOT c.merged AND NOT (c.outbound AND c.first_customer_at IS NULL)";
const CONV = "c.conversation_id,c.brand_id,c.channel,c.team_id";
const NONE = "NULL::text AS item,NULL::boolean AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms";
const REPLY = "p.kind='teammate_reply' AND p.author_type='teammate' AND p.audience='public' AND NOT COALESCE((p.data->>'deleted')::boolean,false)";
// End of the period, as an instant inside it (for states at the end).
const END = "($3::timestamptz - interval '1 microsecond')";
// When a conversation counts as started; db/analytics/0002's a_conversations_start indexes exactly this.
const startOf = "(CASE WHEN c.outbound THEN c.first_customer_at ELSE c.started_at END)";
const STARTED = `${startOf}>=$2 AND ${startOf}<$3`;
const fromConversations = (at: string, extra: string, where = "") =>
  `SELECT ${at} AS at,${CONV},c.assignee AS teammate_id,${extra} FROM a_conversations c WHERE c.workspace_id=$1 AND ${CUSTOMER}${where ? " AND " + where : ""}`;
const fromParts = (where: string, extra = NONE, teammate = "CASE WHEN p.author_type='teammate' THEN p.author_id END") =>
  `SELECT p.at,${CONV},${teammate} AS teammate_id,${extra} FROM a_parts p JOIN a_conversations c ON c.workspace_id=p.workspace_id AND c.conversation_id=p.conversation_id
   WHERE p.workspace_id=$1 AND p.at>=$2 AND p.at<$3 AND ${CUSTOMER} AND ${where}`;
const atEnd = (state: string, extra = "") =>
  `SELECT ${END} AS at,${CONV},c.assignee AS teammate_id,${NONE} FROM a_states s JOIN a_conversations c ON c.workspace_id=s.workspace_id AND c.conversation_id=s.conversation_id
   WHERE s.workspace_id=$1 AND s.state='${state}' AND s.from_at<$3 AND (s.to_at IS NULL OR s.to_at>=$3) AND ${CUSTOMER}${extra}`;
const responses = (first: boolean) =>
  `SELECT r.response_at AS at,${CONV},r.teammate_id,NULL::text AS item,NULL::boolean AS ok,r.ms,r.business_ms FROM a_responses r
   JOIN a_conversations c ON c.workspace_id=r.workspace_id AND c.conversation_id=r.conversation_id
   WHERE r.workspace_id=$1 AND r.response_at>=$2 AND r.response_at<$3 AND ${first ? "" : "NOT "}r.first AND ${CUSTOMER}`;
const handling = (ms: string) =>
  `SELECT h.to_at AS at,${CONV},h.teammate_id,NULL::text AS item,NULL::boolean AS ok,${ms} AS ms,NULL::bigint AS business_ms FROM a_handling h
   JOIN a_conversations c ON c.workspace_id=h.workspace_id AND c.conversation_id=h.conversation_id WHERE h.workspace_id=$1 AND h.to_at>=$2 AND h.to_at<$3`;
const sla = (ok: string, at: string, where = "") =>
  `SELECT ${at} AS at,${CONV},c.assignee AS teammate_id,l.metric AS item,${ok} AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms FROM a_sla l
   JOIN a_conversations c ON c.workspace_id=l.workspace_id AND c.conversation_id=l.conversation_id
   WHERE l.workspace_id=$1 AND l.state<>'inactive' AND (l.breached_at IS NOT NULL OR (l.state='stopped') OR l.due_at<now())${where}`;
// An SLA target's time: when it was met, if before it was due; otherwise when it was due (or missed).
const SLA_AT = "(CASE WHEN l.breached_at IS NULL AND l.state='stopped' THEN LEAST(l.updated_at,COALESCE(l.due_at,l.updated_at)) ELSE COALESCE(l.breached_at,l.due_at) END)";
const resolved = `(SELECT count(*) FILTER (WHERE r.kind='resolution')-count(*) FILTER (WHERE r.kind='reversal') FROM a_ai_resolutions r WHERE r.workspace_id=c.workspace_id AND r.conversation_id=c.conversation_id)>0`;
const joined = (alias: string, at: string, extra: string, where: string) =>
  `SELECT ${at} AS at,${alias}.conversation_id,c.brand_id,c.channel,c.team_id,c.assignee AS teammate_id,${extra} FROM ${where}`;

const DEFS: Record<string, Def> = {
  new_conversations: { kind: "count", rows: fromConversations(startOf, NONE, STARTED) },
  conversations_replied_to: { kind: "distinct", rows: fromParts(REPLY) },
  replies_sent: { kind: "count", rows: fromParts(REPLY) },
  closed_conversations: { kind: "count", rows: fromParts("p.kind='state_change' AND p.data->>'to'='closed'") },
  reopened_conversations: { kind: "count", rows: fromParts("p.kind='state_change' AND p.data->>'to'='open' AND p.data->>'from'='closed'") },
  open_at_end: { kind: "count", rows: atEnd("open") },
  snoozed_at_end: { kind: "count", rows: atEnd("snoozed") },
  awaiting_first_response: {
    kind: "count",
    rows: atEnd("open", " AND c.first_customer_at<$3 AND (c.first_response_at IS NULL OR c.first_response_at>=$3)"),
  },
  first_response_time: { kind: "duration", rows: responses(true) },
  next_response_time: { kind: "duration", rows: responses(false) },
  time_to_close: {
    kind: "duration",
    rows: fromConversations("c.first_closed_at", "NULL::text AS item,NULL::boolean AS ok,c.time_to_close_ms AS ms,c.time_to_close_business_ms AS business_ms", "c.first_closed_at>=$2 AND c.first_closed_at<$3"),
  },
  time_to_resolve: {
    kind: "duration",
    rows: `SELECT s.from_at AS at,${CONV},c.assignee AS teammate_id,NULL::text AS item,NULL::boolean AS ok,(extract(epoch FROM s.from_at-c.started_at)*1000)::bigint AS ms,NULL::bigint AS business_ms
           FROM a_states s JOIN a_conversations c ON c.workspace_id=s.workspace_id AND c.conversation_id=s.conversation_id
           WHERE s.workspace_id=$1 AND s.state='closed' AND s.from_at>=$2 AND s.from_at<$3 AND (s.to_at IS NULL OR s.to_at>=$3) AND ${CUSTOMER}`,
  },
  reassignments: {
    kind: "count",
    rows: fromParts("p.kind='assignment_change' AND NULLIF(p.data->'before'->>'teammate','')<>NULLIF(p.data->'after'->>'teammate','')"),
  },
  first_contact_resolution: {
    kind: "share",
    rows: fromConversations(
      "c.first_closed_at",
      "NULL::text AS item,(c.replies_before_first_close<=1 AND NOT c.reopened_within_7d) AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms",
      "c.first_closed_at>=$2 AND c.first_closed_at<$3 AND c.customer_messages>0",
    ),
  },
  // Each contact's conversations from 7 days before the period, in start order: one pass on the start index.
  repeat_contact: {
    kind: "share",
    rows: `SELECT x.at,x.conversation_id,x.brand_id,x.channel,x.team_id,x.teammate_id,NULL::text AS item,
             (x.prev IS NOT NULL AND x.prev<x.at AND x.prev>=x.at-interval '7 days') AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms
           FROM (SELECT ${startOf} AS at,${CONV},c.assignee AS teammate_id,
                   lag(${startOf}) OVER (PARTITION BY s.contact_id ORDER BY ${startOf},c.conversation_id) AS prev
                 FROM a_conversations c JOIN a_snapshots s ON s.workspace_id=c.workspace_id AND s.conversation_id=c.conversation_id
                 WHERE c.workspace_id=$1 AND s.contact_id IS NOT NULL AND ${startOf}>=$2::timestamptz-interval '7 days' AND ${startOf}<$3 AND ${CUSTOMER}) x
           WHERE x.at>=$2`,
  },
  deflection: {
    kind: "share",
    rows: fromConversations(startOf, "NULL::text AS item,(c.teammate_replies=0) AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms", `${STARTED} AND c.first_closed_at IS NOT NULL AND c.first_closed_at<$3`),
  },
  handling_time: { kind: "duration", rows: handling("h.ms") },
  handling_time_excluding_idle: { kind: "duration", rows: handling("h.active_ms") },
  adjusted_handling_time: { kind: "duration", rows: handling("h.active_business_ms") },
  sla_hit_rate: { kind: "share", rows: sla("(l.breached_at IS NULL)", SLA_AT) },
  sla_miss_rate: { kind: "share", rows: sla("(l.breached_at IS NOT NULL)", SLA_AT) },
  sla_misses: { kind: "count", rows: sla("true", "l.breached_at", " AND l.breached_at IS NOT NULL") },
  // Each conversation's latest rating, at the time it was given (both projected).
  csat: { kind: "share", rows: fromConversations("c.rated_at", "NULL::text AS item,(c.rating>=4) AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms", "c.rated_at>=$2 AND c.rated_at<$3") },
  csat_response_rate: {
    kind: "share",
    rows: fromConversations("c.last_closed_at", "NULL::text AS item,(c.rating IS NOT NULL) AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms", "c.last_closed_at>=$2 AND c.last_closed_at<$3"),
  },
  ai_resolution_rate: {
    kind: "share",
    rows: fromConversations("c.first_ai_at", `NULL::text AS item,(${resolved}) AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms`, "c.first_ai_at>=$2 AND c.first_ai_at<$3"),
  },
  ai_escalation_rate: {
    kind: "share",
    rows: fromConversations("c.first_ai_at", "NULL::text AS item,c.ai_handed_over AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms", "c.first_ai_at>=$2 AND c.first_ai_at<$3"),
  },
  ai_answer_rate: {
    kind: "share",
    rows: joined(
      "a",
      "a.created_at",
      "NULL::text AS item,(a.outcome='answered') AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms",
      "a_ai_answers a JOIN a_conversations c ON c.workspace_id=a.workspace_id AND c.conversation_id=a.conversation_id WHERE a.workspace_id=$1 AND a.outcome<>'skipped' AND a.created_at>=$2 AND a.created_at<$3",
    ),
  },
  ai_involvement: { kind: "share", rows: fromConversations(startOf, "NULL::text AS item,c.ai_involved AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms", STARTED) },
  new_tickets: {
    kind: "count",
    rows: joined("t", "t.created_at", "t.category AS item,NULL::boolean AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms", "a_tickets t LEFT JOIN a_conversations c ON c.workspace_id=t.workspace_id AND c.conversation_id=t.conversation_id WHERE t.workspace_id=$1"),
  },
  tickets_resolved: {
    kind: "count",
    rows: joined(
      "t",
      "t.updated_at",
      "t.category AS item,NULL::boolean AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms",
      "a_tickets t LEFT JOIN a_conversations c ON c.workspace_id=t.workspace_id AND c.conversation_id=t.conversation_id WHERE t.workspace_id=$1 AND t.state_kind='resolved'",
    ),
  },
  ticket_time_to_resolve: {
    kind: "duration",
    rows: joined(
      "t",
      "t.updated_at",
      "t.category AS item,NULL::boolean AS ok,(extract(epoch FROM t.updated_at-t.created_at)*1000)::bigint AS ms,NULL::bigint AS business_ms",
      "a_tickets t LEFT JOIN a_conversations c ON c.workspace_id=t.workspace_id AND c.conversation_id=t.conversation_id WHERE t.workspace_id=$1 AND t.state_kind='resolved'",
    ),
  },
  ...Object.fromEntries(
    (
      [
        ["outbound_sent", "count", "true", ""],
        ["outbound_seen_rate", "share", "(o.seen_at IS NOT NULL)", ""],
        ["outbound_reply_rate", "share", "(o.replied_at IS NOT NULL)", " AND o.type='chat'"],
        ["outbound_click_rate", "share", "(o.clicked_at IS NOT NULL)", " AND o.type='banner'"],
        ["outbound_dismiss_rate", "share", "(o.dismissed_at IS NOT NULL)", " AND o.type='banner'"],
      ] as const
    ).map(([id, kind, ok, where]) => [
      id,
      {
        kind,
        rows: `SELECT o.entered_at AS at,NULL::text AS conversation_id,NULL::text AS brand_id,NULL::text AS channel,NULL::text AS team_id,NULL::text AS teammate_id,o.message_id AS item,${ok} AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms
               FROM a_outbound o WHERE o.workspace_id=$1 AND o.status='sent' AND o.variant='message'${where}`,
      },
    ]),
  ),
  ...Object.fromEntries(
    (
      [
        ["help_searches", "count", "true", ""],
        ["searches_without_results", "share", "(s.results=0)", ""],
        ["search_click_through", "share", "s.opened", " AND s.results>0"],
      ] as const
    ).map(([id, kind, ok, where]) => [
      id,
      {
        kind,
        rows: `SELECT s.created_at AS at,NULL::text AS conversation_id,NULL::text AS brand_id,NULL::text AS channel,NULL::text AS team_id,NULL::text AS teammate_id,s.surface AS item,${ok} AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms
               FROM a_searches s WHERE s.workspace_id=$1${where}`,
      },
    ]),
  ),
  article_helpful_rate: {
    kind: "share",
    rows: `SELECT f.created_at AS at,NULL::text AS conversation_id,NULL::text AS brand_id,NULL::text AS channel,NULL::text AS team_id,NULL::text AS teammate_id,f.record_id AS item,f.helpful AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms
           FROM a_feedback f WHERE f.workspace_id=$1`,
  },
  ...Object.fromEntries(
    (
      [
        ["calls", "count", "true", "l.started_at", ""],
        ["calls_answered_rate", "share", "l.answered", "l.started_at", " AND l.status<>'in_progress'"],
        ["voicemails", "count", "true", "l.started_at", " AND l.voicemail"],
        ["calls_with_zoe", "share", "(l.zoe_turns>0)", "l.started_at", ""],
      ] as const
    ).map(([id, kind, ok, at, where]) => [
      id,
      {
        kind,
        rows: `SELECT ${at} AS at,l.conversation_id,c.brand_id,'voice' AS channel,c.team_id,c.assignee AS teammate_id,NULL::text AS item,${ok} AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms
               FROM a_calls l LEFT JOIN a_conversations c ON c.workspace_id=l.workspace_id AND c.conversation_id=l.conversation_id WHERE l.workspace_id=$1${where}`,
      },
    ]),
  ),
  call_duration: {
    kind: "duration",
    rows: `SELECT l.ended_at AS at,l.conversation_id,c.brand_id,'voice' AS channel,c.team_id,c.assignee AS teammate_id,NULL::text AS item,NULL::boolean AS ok,(l.duration_seconds*1000)::bigint AS ms,NULL::bigint AS business_ms
           FROM a_calls l LEFT JOIN a_conversations c ON c.workspace_id=l.workspace_id AND c.conversation_id=l.conversation_id WHERE l.workspace_id=$1 AND l.ended_at IS NOT NULL AND l.duration_seconds IS NOT NULL`,
  },
  ...Object.fromEntries(
    (
      [
        ["delivery_rate", "share", "(d.status IN ('delivered','read'))", " AND d.status IN ('sent','delivered','read','failed')"],
        ["delivery_failures", "count", "true", " AND d.status='failed' AND NOT (d.kind='ai_reply' AND d.decided)"],
        ["deliveries_suppressed", "count", "true", " AND d.status='suppressed'"],
        ["ai_drafts_reviewed", "count", "true", " AND d.kind='ai_reply' AND d.decided AND d.status<>'held'"],
        ["ai_draft_approval_rate", "share", "(d.status<>'failed')", " AND d.kind='ai_reply' AND d.decided AND d.status<>'held'"],
      ] as const
    ).map(([id, kind, ok, where]) => [
      id,
      {
        kind,
        rows: `SELECT d.updated_at AS at,d.conversation_id,c.brand_id,d.channel,c.team_id,c.assignee AS teammate_id,d.kind AS item,${ok} AS ok,NULL::bigint AS ms,NULL::bigint AS business_ms
               FROM a_deliveries d LEFT JOIN a_conversations c ON c.workspace_id=d.workspace_id AND c.conversation_id=d.conversation_id WHERE d.workspace_id=$1${where}`,
      },
    ]),
  ),
};
const SPECIAL = new Set(["busiest_period", "conversations_per_teammate_hour"]);
export const QUERYABLE = [...Object.keys(DEFS), ...SPECIAL];

export type Filters = { brandId?: string; channel?: string; teamId?: string; teammateId?: string; item?: string; attribute?: { key: string; value: string } };
export type MetricQuery = { metric: string; from: Date; to: Date; timezone?: string; breakdown?: Breakdown; filters?: Filters };
export type Value =
  | { kind: "count"; count: number }
  | { kind: "share"; percent: number | null; numerator: number; denominator: number }
  | { kind: "duration"; count: number; medianMs: number | null; averageMs: number | null; medianBusinessMs: number | null; averageBusinessMs: number | null }
  | { kind: "rate"; value: number | null; numerator: number; denominator: number }
  | { kind: "time"; label: string | null; count: number };
export type MetricResult = { metric: string; total: Value; previous: Value; rows: { key: string | null; value: Value }[] };

const DIMENSIONS: Record<string, string> = { brand: "r.brand_id", channel: "r.channel", team: "r.team_id", teammate: "r.teammate_id", item: "r.item" };
const ATTRIBUTE = /^attribute:([A-Za-z0-9_.:-]{1,100})$/;
const zone = (tz?: string) => {
  try {
    return new Intl.DateTimeFormat("en", { timeZone: tz || "UTC" }).resolvedOptions().timeZone;
  } catch {
    throw new DomainError("INVALID_REPORT", "Choose a timezone (Europe/London).", 400);
  }
};
function aggregate(kind: Kind) {
  if (kind === "count") return "count(*)::int AS n";
  if (kind === "distinct") return "count(DISTINCT r.conversation_id)::int AS n";
  if (kind === "share") return "count(*) FILTER (WHERE r.ok)::int AS num,count(*)::int AS den";
  return "count(r.ms)::int AS n,percentile_cont(0.5) WITHIN GROUP (ORDER BY r.ms) AS median,avg(r.ms) AS average,percentile_cont(0.5) WITHIN GROUP (ORDER BY r.business_ms) AS median_b,avg(r.business_ms) AS average_b";
}
function value(kind: Kind, row: Record<string, unknown> | undefined): Value {
  const num = (x: unknown) => (x === null || x === undefined ? null : Math.round(Number(x)));
  if (kind === "count" || kind === "distinct") return { kind: "count", count: Number(row?.n ?? 0) };
  if (kind === "share") {
    const n = Number(row?.num ?? 0),
      d = Number(row?.den ?? 0);
    return { kind: "share", percent: d ? Math.round((n / d) * 1000) / 10 : null, numerator: n, denominator: d };
  }
  return { kind: "duration", count: Number(row?.n ?? 0), medianMs: num(row?.median), averageMs: num(row?.average), medianBusinessMs: num(row?.median_b), averageBusinessMs: num(row?.average_b) };
}

/** One metric for a period (and the one before it), broken down if asked. */
export async function runMetric(store: AnalyticsStore, w: string, q: MetricQuery): Promise<MetricResult> {
  if (!definition(q.metric) || !QUERYABLE.includes(q.metric)) throw new DomainError("INVALID_REPORT", "Choose a metric from the dictionary.", 400);
  if (!(q.from instanceof Date) || !(q.to instanceof Date) || !Number.isFinite(q.from.getTime()) || !(q.to > q.from) || q.to.getTime() - q.from.getTime() > 400 * 86_400_000)
    throw new DomainError("INVALID_REPORT", "Choose a period of up to 400 days.", 400);
  const tz = zone(q.timezone);
  const previousFrom = new Date(q.from.getTime() - (q.to.getTime() - q.from.getTime()));
  return tenant(store.connect, w, async (db) => {
    const run = (from: Date, to: Date, breakdown?: Breakdown) => (SPECIAL.has(q.metric) ? special(db, w, q.metric, from, to, tz, breakdown, q.filters) : standard(db, w, q.metric, from, to, tz, breakdown, q.filters));
    const [total] = await run(q.from, q.to);
    const [previous] = await run(previousFrom, q.from);
    const rows = q.breakdown ? await run(q.from, q.to, q.breakdown) : [];
    return { metric: q.metric, total: total.value, previous: previous.value, rows };
  });
}

async function standard(db: Sql, w: string, id: string, from: Date, to: Date, tz: string, breakdown?: Breakdown, filters?: Filters) {
  const d = DEFS[id];
  const params: unknown[] = [w, from.toISOString(), to.toISOString(), tz];
  const p = (v: unknown) => {
    params.push(v);
    return "$" + params.length;
  };
  let key = "'all'";
  let join = "";
  if (breakdown) {
    const attribute = ATTRIBUTE.exec(breakdown);
    const periods: Record<string, string> = { day: "YYYY-MM-DD", week: 'IYYY-"W"IW', month: "YYYY-MM" };
    if (attribute) {
      join = "LEFT JOIN a_snapshots snap ON snap.workspace_id=$1 AND snap.conversation_id=r.conversation_id";
      key = `snap.profile->>${p(attribute[1])}`;
    } else if (breakdown in periods) key = `to_char(date_trunc('${breakdown}',r.at AT TIME ZONE $4),'${periods[breakdown]}')`;
    else if (breakdown in DIMENSIONS) key = DIMENSIONS[breakdown];
    else throw new DomainError("INVALID_REPORT", "Break it down by brand, channel, team, teammate, item, day, week, month or an attribute.", 400);
  }
  // ($4, the timezone, is in every query, used or not: some drivers refuse a parameter left unused.)
  const where: string[] = ["r.at>=$2", "r.at<$3", "$4::text IS NOT NULL"];
  if (filters?.brandId) where.push(`r.brand_id=${p(filters.brandId)}`);
  if (filters?.channel) where.push(`r.channel=${p(filters.channel)}`);
  if (filters?.teamId) where.push(`r.team_id=${p(filters.teamId)}`);
  if (filters?.teammateId) where.push(`r.teammate_id=${p(filters.teammateId)}`);
  if (filters?.item) where.push(`r.item=${p(filters.item)}`);
  if (filters?.attribute) {
    if (!join) join = "LEFT JOIN a_snapshots snap ON snap.workspace_id=$1 AND snap.conversation_id=r.conversation_id";
    where.push(`snap.profile->>${p(filters.attribute.key)}=${p(filters.attribute.value)}`);
  }
  const sql = `SELECT ${key} AS key,${aggregate(d.kind)} FROM (${d.rows}) r ${join} WHERE ${where.join(" AND ")} GROUP BY 1 ORDER BY 1`;
  const rows = (await db.query<Record<string, unknown>>(sql, params)).rows;
  if (!breakdown) return [{ key: null, value: value(d.kind, rows[0]) }];
  return rows.map((r) => ({ key: (r.key as string | null) ?? null, value: value(d.kind, r) }));
}

/** The two metrics that aren't one aggregate: the busiest hour of the week, and pace per active hour. */
async function special(db: Sql, w: string, id: string, from: Date, to: Date, tz: string, breakdown?: Breakdown, filters?: Filters): Promise<{ key: string | null; value: Value }[]> {
  if (id === "busiest_period") {
    const rows = (
      await db.query<{ dow: number; hour: number; n: number }>(
        `SELECT extract(isodow FROM p.at AT TIME ZONE $4)::int AS dow,extract(hour FROM p.at AT TIME ZONE $4)::int AS hour,count(*)::int AS n
         FROM a_parts p JOIN a_conversations c ON c.workspace_id=p.workspace_id AND c.conversation_id=p.conversation_id
         WHERE p.workspace_id=$1 AND p.kind='customer_message' AND p.author_type='contact' AND p.at>=$2 AND p.at<$3 AND ${CUSTOMER}${filters?.channel ? " AND c.channel=$5" : ""}
         GROUP BY 1,2 ORDER BY 3 DESC,1,2 LIMIT 1`,
        [w, from.toISOString(), to.toISOString(), tz, ...(filters?.channel ? [filters.channel] : [])],
      )
    ).rows[0];
    const days = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    return [{ key: null, value: { kind: "time", label: rows ? `${days[rows.dow]} ${String(rows.hour).padStart(2, "0")}:00` : null, count: rows?.n ?? 0 } }];
  }
  // Conversations per teammate per active hour: distinct conversations they replied to, over the
  // hours their presence was active in the period (their presence before its first recorded change
  // is what that change was from; with no change, what it is now).
  const replies = (
    await db.query<{ teammate_id: string; n: number }>(
      `SELECT p.author_id AS teammate_id,count(DISTINCT p.conversation_id)::int AS n FROM a_parts p JOIN a_conversations c ON c.workspace_id=p.workspace_id AND c.conversation_id=p.conversation_id
       WHERE p.workspace_id=$1 AND p.at>=$2 AND p.at<$3 AND ${REPLY} AND ${CUSTOMER} GROUP BY 1`,
      [w, from.toISOString(), to.toISOString()],
    )
  ).rows;
  const teammates = (await db.query<{ id: string; presence: string }>("SELECT id,presence FROM a_teammates WHERE workspace_id=$1", [w])).rows;
  const changes = (
    await db.query<{ teammate_id: string; from_presence: string; to_presence: string; changed_at: Date }>(
      "SELECT teammate_id,from_presence,to_presence,changed_at FROM a_presence_changes WHERE workspace_id=$1 ORDER BY teammate_id,changed_at",
      [w],
    )
  ).rows;
  const activeHours = (teammate: string, now: string) => {
    const mine = changes.filter((c) => c.teammate_id === teammate);
    const points = [{ at: -Infinity, state: mine[0]?.from_presence ?? now }, ...mine.map((c) => ({ at: new Date(c.changed_at).getTime(), state: c.to_presence }))];
    let ms = 0;
    for (let i = 0; i < points.length; i++) {
      if (points[i].state !== "active") continue;
      const a = Math.max(points[i].at, from.getTime());
      const b = Math.min(points[i + 1]?.at ?? Infinity, to.getTime());
      if (b > a) ms += b - a;
    }
    return ms / 3_600_000;
  };
  const per = teammates
    .filter((t) => !filters?.teammateId || t.id === filters.teammateId)
    .map((t) => ({ key: t.id, n: replies.find((r) => r.teammate_id === t.id)?.n ?? 0, hours: activeHours(t.id, t.presence) }));
  const rate = (n: number, h: number): Value => ({ kind: "rate", value: h ? Math.round((n / h) * 100) / 100 : null, numerator: n, denominator: Math.round(h * 100) / 100 });
  if (breakdown === "teammate") return per.filter((x) => x.n || x.hours).map((x) => ({ key: x.key, value: rate(x.n, x.hours) }));
  return [{ key: null, value: rate(per.reduce((a, x) => a + x.n, 0), per.reduce((a, x) => a + x.hours, 0)) }];
}

/** Each dataset: what it measures, how it breaks down, and the store table its rows come from. */
const PERIODS = ["day", "week", "month"];
// `where` narrows a table that holds more than the dataset (ratings are among all parts).
export const DATASETS: { id: string; name: string; table: string; where?: string; breakdowns: string[] }[] = [
  { id: "conversation", name: "Conversations", table: "a_conversations", breakdowns: ["brand", "channel", "team", "teammate", ...PERIODS, "attribute"] },
  { id: "rating", name: "Ratings", table: "a_parts", where: "kind='rating'", breakdowns: ["brand", "channel", "team", "teammate", ...PERIODS, "attribute"] },
  { id: "sla", name: "SLAs", table: "a_sla", breakdowns: ["brand", "channel", "team", "teammate", "item (target)", ...PERIODS, "attribute"] },
  { id: "ticket", name: "Tickets", table: "a_tickets", breakdowns: ["brand", "team", "item (category)", ...PERIODS] },
  { id: "ai_agent", name: "AI agent", table: "a_ai_answers", breakdowns: ["brand", "channel", "team", ...PERIODS, "attribute"] },
  { id: "teammate", name: "Teammates", table: "a_handling", breakdowns: ["teammate", "team", ...PERIODS] },
  { id: "outbound", name: "Outbound", table: "a_outbound", breakdowns: ["item (message)", ...PERIODS] },
  { id: "search", name: "Search", table: "a_searches", breakdowns: ["item (surface)", ...PERIODS] },
  { id: "article", name: "Articles", table: "a_feedback", breakdowns: ["item (article)", ...PERIODS] },
  { id: "call", name: "Calls", table: "a_calls", breakdowns: ["brand", "team", ...PERIODS] },
  { id: "delivery", name: "Deliveries", table: "a_deliveries", breakdowns: ["brand", "channel", "team", "item (who wrote it)", ...PERIODS] },
];
export async function datasetCounts(store: AnalyticsStore, w: string) {
  return tenant(store.connect, w, async (db) => {
    const out: Record<string, number> = {};
    for (const d of DATASETS) out[d.id] = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${d.table} WHERE workspace_id=$1${d.where ? " AND " + d.where : ""}`, [w])).rows[0].n;
    return out;
  });
}
