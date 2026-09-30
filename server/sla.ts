import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize, can } from "./policy";
import {
  ALWAYS_OPEN,
  clock,
  type Calendar,
  type ClockEvent,
} from "./business-time";
import { calendarVersion, resolveCalendar } from "./calendars";
import { compileFilter, validateFilter, type ViewFilter } from "./inbox-views";
import { enqueueJob, type Job } from "./jobs";
import { append, type Conversation } from "./conversations";

/**
 * SLAs (phase 05, step B2). The first enabled policy, in order, whose conditions match a
 * conversation sets its targets. Clocks are derived from the conversation's own timeline every
 * time it changes, so recomputing is always safe:
 *
 * - first response: from creation (the customer's first message) to the first teammate reply;
 * - next response: from each customer message after a teammate reply to the next reply;
 * - time to close: from creation to close; reopening continues from the time already used;
 * - time to resolve (tickets): from ticket creation to a resolved state; leaving it continues.
 *
 * A policy's pause rules stop the clocks while snoozed and while waiting on the customer (a
 * ticket in a "waiting on customer" state; for other conversations, while the last message is
 * a teammate's). Each clock keeps the calendar version it started under and the time it has
 * used when the policy (and so its target) changes. A breach is recorded once, on the
 * conversation's timeline and as an `sla.breached` outbox event, and never cleared.
 */
export const METRICS = [
  "first_response",
  "next_response",
  "time_to_close",
  "time_to_resolve",
] as const;
export type Metric = (typeof METRICS)[number];
export const METRIC_NAMES: Record<Metric, string> = {
  first_response: "First response",
  next_response: "Next response",
  time_to_close: "Time to close",
  time_to_resolve: "Time to resolve",
};
type Pause = {
  snoozed?: boolean;
  waiting_on_customer?: boolean;
  automation?: boolean;
};
export type Policy = {
  id: string;
  name: string;
  position: number;
  conditions: ViewFilter | null;
  targets: Partial<Record<Metric, number>>;
  hours: "business" | "always";
  pause: Pause;
  enabled: boolean;
  version: string;
};
const MAX_TARGET = 365 * 86_400_000;
/**
 * Milliseconds since the epoch for a database timestamp. Drivers return a Date (PGlite) or a
 * string (production); `Date.parse` on a Date would go through its text form and lose the
 * milliseconds.
 */
const ms = (v: unknown) =>
  v instanceof Date ? v.getTime() : Date.parse(String(v));
/** Paused clocks sort after every running one, by the time they have left. */
const PAUSED_SORT_BASE = Date.parse("3000-01-01T00:00:00Z");

export async function slaEnabled(db: Sql, w: string) {
  return (
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='sla_v1' AND enabled",
        [w],
      )
    ).rows.length > 0
  );
}
async function requireSla(db: Sql, w: string) {
  assert(
    await slaEnabled(db, w),
    "SLA_DISABLED",
    "Business hours and SLAs are not enabled for this workspace.",
    404,
  );
}

async function policies(db: Sql, w: string, includeArchived = false) {
  return (
    await db.query<Policy>(
      `SELECT id,name,position,conditions,targets,hours,pause,enabled,version::text AS version FROM sla_policies
      WHERE workspace_id=$1${includeArchived ? "" : " AND NOT archived"} ORDER BY position,id`,
      [w],
    )
  ).rows;
}

export async function listPolicies(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "conversations.read");
  await requireSla(db, w);
  return {
    policies: await policies(db, w),
    canManage: await can(db, w, principal, "workspace.manage"),
  };
}

const invalid = (message: string): never => {
  throw new DomainError("INVALID_SLA_POLICY", message, 400);
};
function validPolicy(p: Record<string, unknown>) {
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name || name.length > 80)
    invalid("Give the policy a name of up to 80 characters.");
  let conditions: ViewFilter | null = null;
  if (p.conditions !== undefined && p.conditions !== null) {
    try {
      validateFilter(p.conditions);
    } catch (e) {
      invalid(e instanceof Error ? e.message : "Check the conditions.");
    }
    conditions = p.conditions as ViewFilter;
  }
  const raw = (p.targets ?? {}) as Record<string, unknown>;
  if (typeof raw !== "object" || Array.isArray(raw))
    invalid("Give targets in milliseconds.");
  const targets: Partial<Record<Metric, number>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!METRICS.includes(key as Metric))
      invalid(
        "Targets are first response, next response, time to close and time to resolve.",
      );
    if (
      !Number.isSafeInteger(value) ||
      (value as number) < 1000 ||
      (value as number) > MAX_TARGET
    )
      invalid("A target is between one second and a year.");
    targets[key as Metric] = value as number;
  }
  if (!Object.keys(targets).length) invalid("Set at least one target.");
  const hours = p.hours ?? "business";
  if (hours !== "business" && hours !== "always")
    invalid("Count business hours or all hours.");
  const pause = (p.pause ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(pause))
    if (
      !["snoozed", "waiting_on_customer", "automation"].includes(key) ||
      typeof value !== "boolean"
    )
      invalid(
        "Pause rules are snoozed, waiting_on_customer and automation, each on or off.",
      );
  const position = p.position ?? 0;
  if (!Number.isSafeInteger(position) || (position as number) < 0)
    invalid("Position is a whole number.");
  return {
    name,
    conditions,
    targets,
    hours: hours as Policy["hours"],
    pause: pause as Pause,
    enabled: p.enabled !== false,
    position: position as number,
  };
}

/**
 * Creates, updates (from the version the editor started from) or archives a policy; needs
 * `workspace.manage`. Every open conversation is then re-evaluated by a background job.
 */
export async function savePolicy(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const t = await authorize(db, w, principal, "workspace.manage");
  await requireSla(db, w);
  let id: string;
  if (p.op === "archive" || p.id !== undefined) {
    const current = (
      await db.query<{ version: string }>(
        "SELECT version::text AS version FROM sla_policies WHERE workspace_id=$1 AND id=$2 AND NOT archived FOR UPDATE",
        [w, String(p.id ?? "")],
      )
    ).rows[0];
    assert(current, "SLA_POLICY_NOT_FOUND", "SLA policy unavailable.", 404);
    assert(
      String(p.version) === current.version,
      "SLA_POLICY_CONFLICT",
      "This policy changed elsewhere. Reload it and try again.",
      409,
    );
    id = String(p.id);
    if (p.op === "archive")
      await db.query(
        "UPDATE sla_policies SET archived=true,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [w, id],
      );
    else {
      const v = validPolicy(p);
      await db.query(
        `UPDATE sla_policies SET name=$3,position=$4,conditions=$5,targets=$6,hours=$7,pause=$8,enabled=$9,version=version+1,updated_at=now()
        WHERE workspace_id=$1 AND id=$2`,
        [
          w,
          id,
          v.name,
          v.position,
          JSON.stringify(v.conditions),
          JSON.stringify(v.targets),
          v.hours,
          JSON.stringify(v.pause),
          v.enabled,
        ],
      );
    }
  } else {
    const v = validPolicy(p);
    id = crypto.randomUUID();
    await db.query(
      `INSERT INTO sla_policies(workspace_id,id,name,position,conditions,targets,hours,pause,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        w,
        id,
        v.name,
        v.position,
        JSON.stringify(v.conditions),
        JSON.stringify(v.targets),
        v.hours,
        JSON.stringify(v.pause),
        v.enabled,
      ],
    );
  }
  const jobId = await enqueueJob(
    db,
    w,
    "sla.reevaluate",
    { after: "" },
    { teammateId: t.id },
  );
  const version = (
    await db.query<{ version: string }>(
      "SELECT version::text AS version FROM sla_policies WHERE workspace_id=$1 AND id=$2",
      [w, id],
    )
  ).rows[0].version;
  return { id, version, jobId };
}

/** The first enabled policy whose conditions match; customer conversations only. */
async function matchPolicy(db: Sql, w: string, c: Conversation) {
  if (c.visibility === "internal" || c.merged_into_id) return null;
  for (const policy of await policies(db, w)) {
    if (!policy.enabled) continue;
    if (!policy.conditions) return policy;
    const values: unknown[] = [w, c.id];
    const where = compileFilter(policy.conditions, values);
    if (
      (
        await db.query(
          `SELECT 1 FROM conversations c WHERE c.workspace_id=$1 AND c.id=$2 AND ${where}`,
          values,
        )
      ).rows.length
    )
      return policy;
  }
  return null;
}

type Interval = [number, number];
/** Parts of `base` not covered by `cut`. Both sorted, non-overlapping; ends may be Infinity. */
function subtract(base: Interval[], cut: Interval[]) {
  const out: Interval[] = [];
  for (const [a, b] of base) {
    let start = a;
    for (const [c, d] of cut) {
      if (d <= start || c >= b) continue;
      if (c > start) out.push([start, c]);
      start = Math.max(start, d);
      if (start >= b) break;
    }
    if (start < b) out.push([start, b]);
  }
  return out;
}
/** Intervals during which `timeline` (a series of [at, value]) satisfies `test`. */
function during<T>(
  timeline: [number, T][],
  test: (v: T) => boolean,
): Interval[] {
  const out: Interval[] = [];
  let open: number | null = null;
  for (const [at, value] of timeline) {
    if (test(value) && open === null) open = at;
    else if (!test(value) && open !== null) {
      out.push([open, at]);
      open = null;
    }
  }
  if (open !== null) out.push([open, Infinity]);
  return out;
}

type Derived = { metric: Metric; cycle: number; segments: Interval[] };
/** Reads the conversation's timeline and derives each clock's segments and the pause periods. */
async function derive(db: Sql, w: string, c: Conversation, pause: Pause) {
  const parts = (
    await db.query<{
      kind: string;
      data: Record<string, any>;
      created_at: string;
    }>(
      `SELECT kind,data,created_at FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2
      AND (kind IN ('customer_message','teammate_reply','state_change')
        OR (kind='system_event' AND data->>'event' IN ('ticket_created','ticket_state_change','ticket_type_change')))
      ORDER BY seq`,
      [w, c.id],
    )
  ).rows.map((p) => ({ ...p, at: ms(p.created_at) }));
  const created = ms(c.created_at);
  const status: [number, string][] = [[created, "open"]];
  const ticket: [number, string][] = [];
  const messages: [number, "customer" | "teammate"][] = [];
  for (const p of parts) {
    if (p.kind === "state_change" && p.data.to)
      status.push([p.at, String(p.data.to)]);
    else if (p.kind === "customer_message") messages.push([p.at, "customer"]);
    else if (p.kind === "teammate_reply") messages.push([p.at, "teammate"]);
    else if (p.data.event === "ticket_created")
      ticket.push([p.at, String(p.data.state?.kind ?? "submitted")]);
    else if (p.data.event === "ticket_state_change")
      ticket.push([p.at, String(p.data.to?.kind ?? "in_progress")]);
    else if (p.data.event === "ticket_type_change")
      ticket.push([p.at, String(p.data.state?.kind ?? "in_progress")]);
  }
  const clocks: Derived[] = [];
  // First response, then one next-response cycle per customer message after a reply.
  const firstReply = messages.find(([, who]) => who === "teammate")?.[0];
  clocks.push({
    metric: "first_response",
    cycle: 0,
    segments: [[created, firstReply ?? Infinity]],
  });
  let cycle = 0,
    open: number | null = null,
    replied = false;
  for (const [at, who] of messages) {
    if (who === "teammate") {
      if (open !== null)
        clocks.push({ metric: "next_response", cycle, segments: [[open, at]] });
      open = null;
      replied = true;
    } else if (replied && open === null) {
      cycle++;
      open = at;
    }
  }
  if (open !== null)
    clocks.push({
      metric: "next_response",
      cycle,
      segments: [[open, Infinity]],
    });
  clocks.push({
    metric: "time_to_close",
    cycle: 0,
    segments: during(status, (s) => s !== "closed"),
  });
  if (ticket.length)
    clocks.push({
      metric: "time_to_resolve",
      cycle: 0,
      segments: during(ticket, (k) => k !== "resolved"),
    });
  // Pause periods.
  let pauses: Interval[] = [];
  if (pause.snoozed) pauses.push(...during(status, (s) => s === "snoozed"));
  if (pause.waiting_on_customer)
    pauses.push(
      ...(ticket.length
        ? during(ticket, (k) => k === "waiting_on_customer")
        : during(messages, (who) => who === "teammate")),
    );
  // TODO(phase 11): "while in an automation" pauses once workflows mark conversations as in one.
  pauses = pauses
    .sort((a, b) => a[0] - b[0])
    .reduce<Interval[]>((out, [a, b]) => {
      const last = out[out.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
      return out;
    }, []);
  return { clocks, pauses };
}

type ClockRow = {
  metric: Metric;
  cycle: number;
  calendar_id: string | null;
  calendar_version: number | null;
  breached_at: string | null;
  state: string;
};

/**
 * Recomputes a conversation's SLA clocks from its timeline and records any breach. Safe to call
 * any number of times; called after every command that can change the conversation, by the
 * breach timer, and when policies change.
 */
export async function syncSla(
  db: Sql,
  w: string,
  conversationId: string,
  now = Date.now(),
) {
  if (!(await slaEnabled(db, w))) return { breached: 0 };
  const c = (
    await db.query<Conversation>(
      "SELECT * FROM conversations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [w, conversationId],
    )
  ).rows[0];
  if (!c) return { breached: 0 };
  const policy = await matchPolicy(db, w, c);
  const rows = new Map(
    (
      await db.query<ClockRow>(
        "SELECT metric,cycle,calendar_id,calendar_version,breached_at,state FROM sla_clocks WHERE workspace_id=$1 AND conversation_id=$2",
        [w, c.id],
      )
    ).rows.map((r) => [`${r.metric}:${r.cycle}`, r]),
  );
  const active = new Set<string>();
  let breached = 0;
  if (policy) {
    const { clocks, pauses } = await derive(db, w, c, policy.pause ?? {});
    for (const d of clocks) {
      const target = policy.targets[d.metric];
      if (!target) continue;
      const key = `${d.metric}:${d.cycle}`;
      active.add(key);
      const existing = rows.get(key);
      // The calendar is pinned the first time the clock is measured in business hours (when it
      // starts, or when a business-hours policy takes over) and kept after that.
      let pinId = existing ? existing.calendar_id : null,
        pinVersion = existing ? existing.calendar_version : null;
      if (!pinId && policy.hours === "business") {
        const resolved = await resolveCalendar(db, w, {
          teamId: c.team_id,
          brandId: c.brand_id,
        });
        pinId = resolved.calendarId;
        pinVersion = resolved.version;
      }
      const calendar: Calendar =
        policy.hours === "always" || !pinId || !pinVersion
          ? ALWAYS_OPEN
          : ((await calendarVersion(db, w, pinId, Number(pinVersion))) ??
            ALWAYS_OPEN);
      const running = subtract(d.segments, pauses);
      const events: ClockEvent[] = [];
      for (const [a, b] of running) {
        events.push({ at: a, type: "start" });
        if (Number.isFinite(b))
          events.push({
            at: b,
            type: d.segments.some(([, e]) => e === b) ? "stop" : "pause",
          });
      }
      const result = clock(calendar, target, events, now);
      const inSegment = d.segments.some(([a, b]) => a <= now && now < b);
      const state = !inSegment
        ? "stopped"
        : running.some(([a, b]) => a <= now && now < b)
          ? "running"
          : "paused";
      let breachedAt = existing?.breached_at ? ms(existing.breached_at) : null;
      if (
        result.breached &&
        breachedAt === null &&
        result.breachedAt !== null &&
        result.breachedAt <= now
      ) {
        breachedAt = result.breachedAt;
        breached++;
        await recordBreach(
          db,
          w,
          c,
          policy,
          d.metric,
          d.cycle,
          target,
          breachedAt,
        );
      }
      await db.query(
        `INSERT INTO sla_clocks(workspace_id,conversation_id,metric,cycle,policy_id,policy_version,target_ms,calendar_id,calendar_version,events,state,elapsed_ms,due_at,breached_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
        ON CONFLICT(workspace_id,conversation_id,metric,cycle) DO UPDATE SET policy_id=$5,policy_version=$6,target_ms=$7,calendar_id=$8,calendar_version=$9,events=$10,state=$11,elapsed_ms=$12,due_at=$13,breached_at=$14,updated_at=now()`,
        [
          w,
          c.id,
          d.metric,
          d.cycle,
          policy.id,
          policy.version,
          target,
          pinId,
          pinVersion,
          JSON.stringify(
            events.map((e) => ({
              at: new Date(e.at).toISOString(),
              type: e.type,
            })),
          ),
          state,
          result.elapsedMs,
          state === "running" && result.dueAt !== null
            ? new Date(result.dueAt).toISOString()
            : null,
          breachedAt === null ? null : new Date(breachedAt).toISOString(),
        ],
      );
    }
  }
  // Clocks no longer measured (no policy, or no target for them) stop counting; breaches stay.
  const retired = [...rows.keys()].filter(
    (k) => !active.has(k) && rows.get(k)!.state !== "inactive",
  );
  for (const key of retired) {
    const [metric, cycle] = key.split(":");
    await db.query(
      "UPDATE sla_clocks SET state='inactive',due_at=NULL,updated_at=now() WHERE workspace_id=$1 AND conversation_id=$2 AND metric=$3 AND cycle=$4",
      [w, c.id, metric, Number(cycle)],
    );
  }
  await summarize(db, w, c, policy?.id ?? null);
  return { breached };
}

async function recordBreach(
  db: Sql,
  w: string,
  c: Conversation,
  policy: Policy,
  metric: Metric,
  cycle: number,
  target: number,
  breachedAt: number,
) {
  const detail = {
    metric,
    cycle,
    policy: { id: policy.id, name: policy.name },
    targetMs: target,
    breachedAt: new Date(breachedAt).toISOString(),
  };
  await append(
    db,
    w,
    c,
    { type: "system", id: "sla" },
    "system_event",
    "",
    { event: "sla_breached", ...detail },
    "internal",
  );
  // For phase 11's workflows to act on. TODO(phase 11): a consumer publishes and marks these.
  await db.query(
    "INSERT INTO outbox(workspace_id,id,kind,resource_id,payload) VALUES($1,$2,'event',$3,$4) ON CONFLICT DO NOTHING",
    [
      w,
      `sla.breached:${c.id}:${metric}:${cycle}`,
      c.id,
      JSON.stringify({ name: "sla.breached", conversationId: c.id, ...detail }),
    ],
  );
}

/** The conversation's SLA columns: what views filter and sort on, and when the timer wakes. */
async function summarize(
  db: Sql,
  w: string,
  c: Conversation,
  policyId: string | null,
) {
  const clocks = (
    await db.query<{
      state: string;
      due_at: string | null;
      breached_at: string | null;
      target_ms: string;
      elapsed_ms: string;
    }>(
      "SELECT state,due_at,breached_at,target_ms,elapsed_ms FROM sla_clocks WHERE workspace_id=$1 AND conversation_id=$2",
      [w, c.id],
    )
  ).rows;
  const running = clocks.filter((k) => k.state === "running" && k.due_at);
  const nextDue = running
    .filter((k) => !k.breached_at)
    .map((k) => ms(k.due_at!));
  const paused = clocks
    .filter((k) => k.state === "paused")
    .map((k) => Number(k.target_ms) - Number(k.elapsed_ms));
  const sortAt = running.length
    ? Math.min(...running.map((k) => ms(k.due_at!)))
    : paused.length
      ? PAUSED_SORT_BASE + Math.max(0, Math.min(...paused))
      : null;
  const next = {
    sla_policy_id: policyId,
    sla_next_due_at: nextDue.length
      ? new Date(Math.min(...nextDue)).toISOString()
      : null,
    sla_sort_at: sortAt === null ? null : new Date(sortAt).toISOString(),
    sla_overdue: running.some((k) => k.breached_at),
    sla_breached: clocks.some((k) => k.breached_at),
  };
  const same = (a: unknown, b: string | null) =>
    (a === null || a === undefined
      ? null
      : new Date(a as string).toISOString()) === b;
  if (
    c.sla_policy_id === next.sla_policy_id &&
    same(c.sla_next_due_at, next.sla_next_due_at) &&
    same(c.sla_sort_at, next.sla_sort_at) &&
    c.sla_overdue === next.sla_overdue &&
    c.sla_breached === next.sla_breached
  )
    return;
  await db.query(
    "UPDATE conversations SET sla_policy_id=$3,sla_next_due_at=$4,sla_sort_at=$5,sla_overdue=$6,sla_breached=$7 WHERE workspace_id=$1 AND id=$2",
    [
      w,
      c.id,
      next.sla_policy_id,
      next.sla_next_due_at,
      next.sla_sort_at,
      next.sla_overdue,
      next.sla_breached,
    ],
  );
}

/** Conversations whose next SLA due time has passed: the timer's work, one transaction each. */
export async function checkDueSlas(connect: Connect, w: string, limit = 100) {
  const due = await tenant(connect, w, async (db) =>
    (await slaEnabled(db, w))
      ? (
          await db.query<{ id: string }>(
            "SELECT id FROM conversations WHERE workspace_id=$1 AND sla_next_due_at<=now() ORDER BY sla_next_due_at,id LIMIT $2",
            [w, limit],
          )
        ).rows
      : [],
  );
  const breached: string[] = [];
  for (const { id } of due)
    if ((await tenant(connect, w, (db) => syncSla(db, w, id))).breached)
      breached.push(id);
  return breached;
}

/** Re-evaluates conversations after a policy change, 100 per step. */
export async function reevaluateJob(connect: Connect, job: Job) {
  const w = job.workspace_id;
  const ids = await tenant(connect, w, async (db) =>
    (
      await db.query<{ id: string }>(
        "SELECT id FROM conversations WHERE workspace_id=$1 AND id>$2 AND merged_into_id IS NULL AND visibility='customer' ORDER BY id LIMIT 100",
        [
          w,
          String(
            (job.result as { after?: string } | null)?.after ??
              job.payload.after ??
              "",
          ),
        ],
      )
    ).rows.map((r) => r.id),
  );
  for (const id of ids) await tenant(connect, w, (db) => syncSla(db, w, id));
  return {
    done: ids.length < 100,
    result: { after: ids[ids.length - 1] ?? "" },
  };
}

/** The sidebar's SLA section: the policy and each clock, recomputed as of now. */
export async function slaContext(db: Sql, w: string, c: Conversation) {
  if (!(await slaEnabled(db, w)))
    return { enabled: false, policy: null, clocks: [] };
  const policy = c.sla_policy_id
    ? ((
        await db.query<{ id: string; name: string; hours: string }>(
          "SELECT id,name,hours FROM sla_policies WHERE workspace_id=$1 AND id=$2",
          [w, c.sla_policy_id],
        )
      ).rows[0] ?? null)
    : null;
  const clocks = (
    await db.query<{
      metric: Metric;
      cycle: number;
      state: string;
      target_ms: string;
      elapsed_ms: string;
      due_at: string | null;
      breached_at: string | null;
    }>(
      `SELECT metric,cycle,state,target_ms,elapsed_ms,due_at,breached_at FROM sla_clocks
      WHERE workspace_id=$1 AND conversation_id=$2 AND (state<>'inactive' OR breached_at IS NOT NULL)
      ORDER BY array_position(ARRAY['first_response','next_response','time_to_close','time_to_resolve'],metric),cycle DESC`,
      [w, c.id],
    )
  ).rows;
  // Only the latest next-response cycle is shown, with any earlier breach kept.
  const latestNext = clocks.find((k) => k.metric === "next_response")?.cycle;
  return {
    enabled: true,
    serverNow: new Date().toISOString(),
    policy,
    clocks: clocks
      .filter(
        (k) =>
          k.metric !== "next_response" ||
          k.cycle === latestNext ||
          k.breached_at,
      )
      .map((k) => ({
        metric: k.metric,
        name: METRIC_NAMES[k.metric],
        cycle: k.cycle,
        state: k.state,
        targetMs: Number(k.target_ms),
        elapsedMs: Number(k.elapsed_ms),
        dueAt: k.due_at ? new Date(k.due_at).toISOString() : null,
        breachedAt: k.breached_at
          ? new Date(k.breached_at).toISOString()
          : null,
      })),
  };
}
