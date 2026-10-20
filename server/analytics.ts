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

export type FactPart = { seq: number; kind: string; author_type: string; author_id?: string; audience: string; at: Date; data: Record<string, unknown> };
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
  lastClosedAt: Date | null;
  repliesBeforeFirstClose: number;
  reopenedWithin7d: boolean;
  firstAiAt: Date | null;
  ratedAt: Date | null;
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
    lastClosedAt: sorted.filter((p) => p.kind === "state_change" && p.data.to === "closed").at(-1)?.at ?? null,
    repliesBeforeFirstClose: sorted.filter((p) => teammateReply(p) && (!firstClose || p.seq < firstClose.seq)).length,
    reopenedWithin7d:
      !!firstClose &&
      sorted.some((p) => p.seq > firstClose.seq && p.kind === "state_change" && p.data.to === "open" && p.data.from === "closed" && p.at.getTime() - firstClose.at.getTime() <= 7 * 86_400_000),
    firstAiAt: sorted.find((p) => p.kind === "ai_reply")?.at ?? null,
    ratedAt: ratings.at(-1)?.at ?? null,
  };
}

const IDLE_MS = 30 * 60_000;
export type Derived = {
  states: { seq: number; state: string; from: Date; to: Date | null }[];
  responses: { customerSeq: number; first: boolean; customerAt: Date; responseAt: Date; teammateId: string; ms: number; businessMs: number }[];
  handling: { seq: number; teammateId: string; from: Date; to: Date; ms: number; activeMs: number; activeBusinessMs: number }[];
};
/**
 * What a conversation's parts say over time (lib/metrics.ts defines what each metric reads):
 * - **states:** each period open, snoozed or closed (`status` when no change was ever recorded);
 * - **responses:** each run of customer messages and the teammate reply that answered it (the
 *   first run is the first response, the rest next responses);
 * - **handling:** each period it was open and assigned to a teammate, ended by a close, snooze,
 *   reassignment or unassignment (a period still going isn't counted yet), and how much of it they
 *   were active: gaps over 30 minutes without their reply or note are idle.
 */
export function conversationDerived(parts: FactPart[], startedAt: Date, calendar: { timezone: string; schedule: BusinessSchedule } | null, status: string): Derived {
  const sorted = [...parts].sort((a, b) => a.seq - b.seq);
  const business = (from: Date, to: Date) => {
    const c = calendar ?? { timezone: ALWAYS_OPEN.timezone, schedule: ALWAYS_OPEN };
    return to > from ? businessMilliseconds(from, to, c.timezone, c.schedule) : 0;
  };
  const teammateReply = (p: FactPart) => p.kind === "teammate_reply" && p.author_type === "teammate" && p.audience === "public" && !p.data.deleted;
  const changes = sorted.filter((p) => p.kind === "state_change" && typeof p.data.to === "string");
  const states: Derived["states"] = [];
  if (!changes.length) states.push({ seq: 0, state: status, from: startedAt, to: null });
  for (const [i, c] of changes.entries()) states.push({ seq: c.seq, state: String(c.data.to), from: c.at, to: changes[i + 1]?.at ?? null });

  const responses: Derived["responses"] = [];
  let waiting: FactPart | null = null;
  for (const p of sorted) {
    if (p.kind === "customer_message" && p.author_type === "contact" && !waiting) waiting = p;
    else if (waiting && teammateReply(p)) {
      responses.push({
        customerSeq: waiting.seq,
        first: responses.length === 0,
        customerAt: waiting.at,
        responseAt: p.at,
        teammateId: p.author_id ?? "",
        ms: p.at.getTime() - waiting.at.getTime(),
        businessMs: business(waiting.at, p.at),
      });
      waiting = null;
    }
  }

  const handling: Derived["handling"] = [];
  let state = changes.length ? "open" : status;
  let assignee: string | null = null;
  type Period = { seq: number; teammateId: string; from: Date; marks: Date[] };
  let open = null as Period | null;
  const current = () => open as Period | null;
  const end = (at: Date) => {
    if (!open) return;
    const marks = [open.from, ...open.marks.filter((m) => m > open!.from && m < at), at];
    let active = 0;
    let activeBusiness = 0;
    for (let i = 1; i < marks.length; i++) {
      const gap = marks[i].getTime() - marks[i - 1].getTime();
      if (gap <= IDLE_MS) {
        active += gap;
        activeBusiness += business(marks[i - 1], marks[i]);
      }
    }
    handling.push({ seq: open.seq, teammateId: open.teammateId, from: open.from, to: at, ms: at.getTime() - open.from.getTime(), activeMs: active, activeBusinessMs: activeBusiness });
    open = null;
  };
  const begin = (p: FactPart) => {
    if (!open && assignee && state === "open") open = { seq: p.seq, teammateId: assignee, from: p.at, marks: [] };
  };
  for (const p of sorted) {
    if (p.kind === "state_change" && typeof p.data.to === "string") {
      state = String(p.data.to);
      if (state === "open") begin(p);
      else end(p.at);
    } else if (p.kind === "assignment_change") {
      const next = ((p.data.after as { teammate?: string | null } | undefined)?.teammate ?? null) || null;
      if (next !== assignee) {
        end(p.at);
        assignee = next;
        begin(p);
      }
    } else {
      const now = current();
      if (now && p.author_type === "teammate" && p.author_id === now.teammateId && (p.kind === "teammate_reply" || p.kind === "internal_note")) now.marks.push(p.at);
    }
  }
  return { states, responses, handling };
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
  const sources = await syncSources(main, store, w);
  return { done: true, result: { projected, changes: changes.length, sources } };
}

/**
 * R2: the other sources reports read, copied whole rows at a time. Each is found by when it last
 * changed (after its own watermark, less the overlap) and upserted by its key, so a repeat changes
 * nothing. Teammates (a few rows) are copied whole each time.
 */
type Source = {
  name: string;
  /** Rows changed after $2 (the watermark), oldest first, with `changed` (their change time). */
  select: string;
  upsert: string;
  values: (r: Record<string, unknown>) => unknown[];
};
const ts = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const SOURCES: Source[] = [
  {
    name: "sla",
    select: "SELECT conversation_id,metric,cycle,policy_id,target_ms,state,due_at,breached_at,updated_at AS changed FROM sla_clocks WHERE workspace_id=$1 AND updated_at>$2::timestamptz ORDER BY updated_at LIMIT 5000",
    upsert: `INSERT INTO a_sla(workspace_id,conversation_id,metric,cycle,policy_id,target_ms,state,due_at,breached_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (workspace_id,conversation_id,metric,cycle) DO UPDATE SET policy_id=EXCLUDED.policy_id,target_ms=EXCLUDED.target_ms,state=EXCLUDED.state,due_at=EXCLUDED.due_at,breached_at=EXCLUDED.breached_at,updated_at=EXCLUDED.updated_at`,
    values: (r) => [r.conversation_id, r.metric, r.cycle, r.policy_id, r.target_ms, r.state, ts(r.due_at), ts(r.breached_at), ts(r.changed)],
  },
  {
    name: "tickets",
    select: `SELECT t.conversation_id,t.number,t.type_id,ty.category,st.kind AS state_kind,t.created_at,t.updated_at AS changed FROM tickets t
             JOIN ticket_types ty ON ty.workspace_id=t.workspace_id AND ty.id=t.type_id JOIN ticket_states st ON st.workspace_id=t.workspace_id AND st.id=t.state_id
             WHERE t.workspace_id=$1 AND t.updated_at>$2::timestamptz ORDER BY t.updated_at LIMIT 5000`,
    upsert: `INSERT INTO a_tickets(workspace_id,conversation_id,number,type_id,category,state_kind,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (workspace_id,conversation_id) DO UPDATE SET type_id=EXCLUDED.type_id,category=EXCLUDED.category,state_kind=EXCLUDED.state_kind,updated_at=EXCLUDED.updated_at`,
    values: (r) => [r.conversation_id, r.number, r.type_id, r.category, r.state_kind, ts(r.created_at), ts(r.changed)],
  },
  {
    name: "ai_answers",
    select: "SELECT id,conversation_id,outcome,created_at AS changed FROM ai_answers WHERE workspace_id=$1 AND created_at>$2::timestamptz ORDER BY created_at LIMIT 5000",
    upsert: "INSERT INTO a_ai_answers(workspace_id,id,conversation_id,outcome,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    values: (r) => [r.id, r.conversation_id, r.outcome, ts(r.changed)],
  },
  {
    name: "ai_resolutions",
    select: "SELECT id,kind,resolution_id,conversation_id,rule,recorded_at AS changed FROM ai_resolutions WHERE workspace_id=$1 AND recorded_at>$2::timestamptz ORDER BY recorded_at LIMIT 5000",
    upsert: "INSERT INTO a_ai_resolutions(workspace_id,id,kind,resolution_id,conversation_id,rule,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
    values: (r) => [r.id, r.kind, r.resolution_id, r.conversation_id, r.rule, ts(r.changed)],
  },
  {
    name: "outbound",
    select: `SELECT e.id,e.message_id,m.type,e.variant,e.status,e.entered_at,e.seen_at,e.clicked_at,e.dismissed_at,e.replied_at,
               GREATEST(e.created_at,e.entered_at,e.seen_at,e.clicked_at,e.dismissed_at,e.replied_at) AS changed
             FROM outbound_entries e JOIN outbound_messages m ON m.workspace_id=e.workspace_id AND m.id=e.message_id
             WHERE e.workspace_id=$1 AND GREATEST(e.created_at,e.entered_at,e.seen_at,e.clicked_at,e.dismissed_at,e.replied_at)>$2::timestamptz ORDER BY 11 LIMIT 5000`,
    upsert: `INSERT INTO a_outbound(workspace_id,id,message_id,type,variant,status,entered_at,seen_at,clicked_at,dismissed_at,replied_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (workspace_id,id) DO UPDATE SET status=EXCLUDED.status,entered_at=EXCLUDED.entered_at,seen_at=EXCLUDED.seen_at,clicked_at=EXCLUDED.clicked_at,dismissed_at=EXCLUDED.dismissed_at,replied_at=EXCLUDED.replied_at`,
    values: (r) => [r.id, r.message_id, r.type, r.variant, r.status, ts(r.entered_at), ts(r.seen_at), ts(r.clicked_at), ts(r.dismissed_at), ts(r.replied_at)],
  },
  {
    name: "calls",
    select: `SELECT id,conversation_id,status,voicemail,accepted_by IS NOT NULL AS answered,zoe_turns,duration_seconds,started_at,ended_at,GREATEST(started_at,ended_at) AS changed
             FROM voice_calls WHERE workspace_id=$1 AND GREATEST(started_at,ended_at)>$2::timestamptz ORDER BY 10 LIMIT 5000`,
    upsert: `INSERT INTO a_calls(workspace_id,id,conversation_id,status,voicemail,answered,zoe_turns,duration_seconds,started_at,ended_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (workspace_id,id) DO UPDATE SET status=EXCLUDED.status,voicemail=EXCLUDED.voicemail,answered=EXCLUDED.answered,zoe_turns=EXCLUDED.zoe_turns,duration_seconds=EXCLUDED.duration_seconds,ended_at=EXCLUDED.ended_at`,
    values: (r) => [r.id, r.conversation_id, r.status, r.voicemail, r.answered, r.zoe_turns, r.duration_seconds, ts(r.started_at), ts(r.ended_at)],
  },
  {
    name: "searches",
    select: `SELECT id,surface,results,opened_record_id IS NOT NULL AS opened,created_at,GREATEST(created_at,opened_at) AS changed FROM help_search_queries
             WHERE workspace_id=$1 AND GREATEST(created_at,opened_at)>$2::timestamptz ORDER BY 6 LIMIT 5000`,
    upsert: "INSERT INTO a_searches(workspace_id,id,surface,results,opened,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id,id) DO UPDATE SET opened=EXCLUDED.opened",
    values: (r) => [r.id, r.surface, r.results, r.opened, ts(r.created_at)],
  },
  {
    name: "feedback",
    select: "SELECT id,record_id,helpful,created_at AS changed FROM knowledge_feedback WHERE workspace_id=$1 AND created_at>$2::timestamptz ORDER BY created_at LIMIT 5000",
    upsert: "INSERT INTO a_feedback(workspace_id,id,record_id,helpful,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
    values: (r) => [r.id, r.record_id, r.helpful, ts(r.changed)],
  },
  {
    name: "deliveries",
    select: `SELECT d.id,d.conversation_id,d.channel,d.status,p.kind,d.decided_at IS NOT NULL OR d.status='held' AS decided,d.created_at,d.updated_at AS changed FROM channel_deliveries d
             JOIN conversation_parts p ON p.workspace_id=d.workspace_id AND p.id=d.part_id WHERE d.workspace_id=$1 AND d.updated_at>$2::timestamptz ORDER BY d.updated_at LIMIT 5000`,
    upsert: `INSERT INTO a_deliveries(workspace_id,id,conversation_id,channel,status,kind,decided,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (workspace_id,id) DO UPDATE SET status=EXCLUDED.status,decided=EXCLUDED.decided,updated_at=EXCLUDED.updated_at`,
    values: (r) => [r.id, r.conversation_id, r.channel, r.status, r.kind, r.decided, ts(r.created_at), ts(r.changed)],
  },
  {
    name: "presence",
    select: "SELECT id,teammate_id,from_presence,to_presence,changed_at AS changed FROM teammate_presence_changes WHERE workspace_id=$1 AND changed_at>$2::timestamptz ORDER BY changed_at LIMIT 5000",
    upsert: "INSERT INTO a_presence_changes(workspace_id,id,teammate_id,from_presence,to_presence,changed_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
    values: (r) => [r.id, r.teammate_id, r.from_presence, r.to_presence, ts(r.changed)],
  },
];
async function syncSources(main: Connect, store: AnalyticsStore, w: string) {
  const counts: Record<string, number> = {};
  for (const src of SOURCES) {
    const mark = await tenant(store.connect, w, async (db) => {
      await db.query("INSERT INTO a_sources(workspace_id,source) VALUES($1,$2) ON CONFLICT DO NOTHING", [w, src.name]);
      return new Date((await db.query<{ watermark: Date }>("SELECT watermark FROM a_sources WHERE workspace_id=$1 AND source=$2", [w, src.name])).rows[0].watermark);
    });
    let after = Number.isFinite(mark.getTime()) ? new Date(mark.getTime() - OVERLAP_MS).toISOString() : "-infinity";
    let high: Date | null = null;
    counts[src.name] = 0;
    for (;;) {
      const rows = await tenant(main, w, async (db) => (await db.query<Record<string, unknown>>(src.select, [w, after])).rows);
      if (!rows.length) break;
      await tenant(store.connect, w, async (db) => {
        for (const r of rows) await db.query(src.upsert, [w, ...src.values(r)]);
      });
      counts[src.name] += rows.length;
      high = new Date(rows.at(-1)!.changed as string);
      if (rows.length < 5000) break;
      after = high.toISOString();
    }
    if (high) await tenant(store.connect, w, (db) => db.query("UPDATE a_sources SET watermark=GREATEST(watermark,$3::timestamptz) WHERE workspace_id=$1 AND source=$2", [w, src.name, high!.toISOString()]));
  }
  // Teammates: names, presence now, and teams (a few rows each).
  const teammates = await tenant(main, w, async (db) =>
    (
      await db.query<{ id: string; name: string; presence: string; teams: string[] }>(
        "SELECT t.id,t.name,t.presence,ARRAY(SELECT team_id FROM teammate_teams x WHERE x.workspace_id=t.workspace_id AND x.teammate_id=t.id ORDER BY team_id) AS teams FROM teammates t WHERE t.workspace_id=$1",
        [w],
      )
    ).rows,
  );
  await tenant(store.connect, w, async (db) => {
    for (const t of teammates)
      await db.query(
        "INSERT INTO a_teammates(workspace_id,id,name,presence,teams) VALUES($1,$2,$3,$4,$5) ON CONFLICT (workspace_id,id) DO UPDATE SET name=EXCLUDED.name,presence=EXCLUDED.presence,teams=EXCLUDED.teams",
        [w, t.id, t.name, t.presence, t.teams],
      );
  });
  counts.teammates = teammates.length;
  return counts;
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
        team_id: string | null;
        assigned: string | null;
      }>("SELECT brand_id,channel,created_at,status,visibility,outbound_message_id,merged_into_id,calendar_id,calendar_version,team_id,assigned FROM conversations WHERE workspace_id=$1 AND id=$2", [w, id])
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
      await db.query<{ seq: string; kind: string; author_type: string; author_id: string; audience: string; at: Date; data: Record<string, unknown> }>(
        "SELECT seq,kind,author_type,author_id,audience,at,data FROM a_parts WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY seq",
        [w, id],
      )
    ).rows.map((p) => ({ ...p, seq: Number(p.seq), at: new Date(p.at) }));
    const f = conversationFacts(all, new Date(c.created_at), calendar ?? null);
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    // R2: its periods in each state, its responses and its handling periods, recomputed whole.
    const d = conversationDerived(all, new Date(c.created_at), calendar ?? null, c.status);
    for (const t of ["a_states", "a_responses", "a_handling"]) await db.query(`DELETE FROM ${t} WHERE workspace_id=$1 AND conversation_id=$2`, [w, id]);
    for (const x of d.states)
      await db.query("INSERT INTO a_states(workspace_id,conversation_id,seq,state,from_at,to_at) VALUES($1,$2,$3,$4,$5,$6)", [w, id, x.seq, x.state, x.from.toISOString(), iso(x.to)]);
    for (const x of d.responses)
      await db.query("INSERT INTO a_responses(workspace_id,conversation_id,customer_seq,first,customer_at,response_at,teammate_id,ms,business_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
        w,
        id,
        x.customerSeq,
        x.first,
        x.customerAt.toISOString(),
        x.responseAt.toISOString(),
        x.teammateId,
        x.ms,
        x.businessMs,
      ]);
    for (const x of d.handling)
      await db.query("INSERT INTO a_handling(workspace_id,conversation_id,seq,teammate_id,from_at,to_at,ms,active_ms,active_business_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
        w,
        id,
        x.seq,
        x.teammateId,
        x.from.toISOString(),
        x.to.toISOString(),
        x.ms,
        x.activeMs,
        x.activeBusinessMs,
      ]);
    await db.query(
      `INSERT INTO a_conversations(workspace_id,conversation_id,brand_id,channel,started_at,calendar_id,calendar_version,projected_seq,first_customer_at,first_response_at,first_response_ms,first_response_business_ms,
         first_closed_at,time_to_close_ms,time_to_close_business_ms,customer_messages,teammate_replies,ai_replies,workflow_messages,closes,reopens,assignments,ai_involved,ai_handed_over,rating,status,visibility,outbound,merged,
         team_id,assignee,last_closed_at,replies_before_first_close,reopened_within_7d,first_ai_at,rated_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,now())
       ON CONFLICT (workspace_id,conversation_id) DO UPDATE SET projected_seq=EXCLUDED.projected_seq,first_customer_at=EXCLUDED.first_customer_at,first_response_at=EXCLUDED.first_response_at,
         first_response_ms=EXCLUDED.first_response_ms,first_response_business_ms=EXCLUDED.first_response_business_ms,first_closed_at=EXCLUDED.first_closed_at,time_to_close_ms=EXCLUDED.time_to_close_ms,
         time_to_close_business_ms=EXCLUDED.time_to_close_business_ms,customer_messages=EXCLUDED.customer_messages,teammate_replies=EXCLUDED.teammate_replies,ai_replies=EXCLUDED.ai_replies,
         workflow_messages=EXCLUDED.workflow_messages,closes=EXCLUDED.closes,reopens=EXCLUDED.reopens,assignments=EXCLUDED.assignments,ai_involved=EXCLUDED.ai_involved,ai_handed_over=EXCLUDED.ai_handed_over,
         rating=EXCLUDED.rating,status=EXCLUDED.status,visibility=EXCLUDED.visibility,outbound=EXCLUDED.outbound,merged=EXCLUDED.merged,
         team_id=EXCLUDED.team_id,assignee=EXCLUDED.assignee,last_closed_at=EXCLUDED.last_closed_at,replies_before_first_close=EXCLUDED.replies_before_first_close,
         reopened_within_7d=EXCLUDED.reopened_within_7d,first_ai_at=EXCLUDED.first_ai_at,rated_at=EXCLUDED.rated_at,updated_at=now()`,
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
        c.team_id,
        c.assigned || null,
        iso(f.lastClosedAt),
        f.repliesBeforeFirstClose,
        f.reopenedWithin7d,
        iso(f.firstAiAt),
        iso(f.ratedAt),
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
  if (kind === "assignment_change")
    for (const k of ["after", "before"] as const)
      if (keep[k] && typeof keep[k] === "object") keep[k] = { teammate: (keep[k] as { teammate?: string }).teammate || null, team: (keep[k] as { team?: string }).team || null }; // (Unassigned is "" in the inbox: null here.)
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
  const { DATASETS, datasetCounts } = await import("./reports");
  const counts = store ? await datasetCounts(store, w) : {};
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
    // R2: each dataset's documented table: its metrics, breakdowns and rows.
    datasets: DATASETS.map((d) => ({ id: d.id, name: d.name, breakdowns: d.breakdowns, rows: counts[d.id] ?? 0, metrics: METRICS.filter((m) => m.dataset === d.id).map((m) => m.id) })),
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

/** `report-metric`: one metric for who may view reports (R3's pages ask through this). */
export async function reportMetric(main: Connect, store: AnalyticsStore | undefined, w: string, principal: string, p: Record<string, unknown>) {
  await tenant(main, w, async (db) => {
    await authorize(db, w, principal, "reports.view");
    assert(await reportsOn(db, w), "REPORTS_DISABLED", "Reports are not enabled for this workspace.", 404);
  });
  assert(store, "REPORTS_UNAVAILABLE", "Reporting's store isn't connected.", 503);
  const { runMetric } = await import("./reports");
  return runMetric(store!, w, {
    metric: String(p.metric ?? ""),
    from: new Date(String(p.from ?? "")),
    to: new Date(String(p.to ?? "")),
    timezone: typeof p.timezone === "string" ? p.timezone : undefined,
    breakdown: typeof p.breakdown === "string" ? (p.breakdown as never) : undefined,
    filters: p.filters && typeof p.filters === "object" ? (p.filters as never) : undefined,
  });
}
