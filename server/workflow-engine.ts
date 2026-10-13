import { DomainError, tenant, type Connect, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import { command, conversation, type Conversation } from "./conversations";
import { availabilityFor, expectedReply } from "./office-hours";
import { detectLanguage } from "./ai-language";
import { aiEnabled, queueAiReply } from "./ai-agent";
import { syncSla } from "./sla";
import { actionsEnabled, pinnedVersion, runConnector, type ConnectorEnvironment } from "./connectors";
import { facts as aiFacts } from "./ai-escalation";
import { verificationOf, verified } from "./procedures";
import {
  MAX_NODES,
  TRIGGERS,
  customerFacing,
  type Condition,
  type Definition,
  type Group,
  type Path,
  type Source,
  type Step,
  type Trigger,
  type ValueSource,
} from "../lib/workflow-definition";
import type { Definition as ConnectorDefinition } from "../lib/connector-definition";

/**
 * The workflow engine (phase 11, step W1; docs/WORKFLOWS_STEP1.md), behind `workflows_v1`.
 *
 * - **Triggers:** every timeline part passes through `workflowEvent` (from `append`), which maps it
 *   to triggers and, when a live workflow listens, queues a `workflow.start` job. Who made the
 *   change (customer, teammate, Zoe, a workflow, Relay) travels with it, and a workflow's own
 *   changes carry the chain of workflows behind them.
 * - **Starting:** live workflows for the trigger, in priority order; each checks its trigger
 *   options and who it runs for. Only the first matching customer-facing workflow runs (W3 adds
 *   customer-facing steps); background workflows all run. Every match that doesn't run is a
 *   `skipped` run saying why: a higher-priority one ran, it would trigger itself or a loop, or the
 *   conversation hit its hourly limit.
 * - **Running:** each step is its own transaction, with the run's position, so a failure rolls back
 *   only that step. Actions go through `command` as the workflow (idempotent per run and step),
 *   so every invariant teammates' changes keep (SLAs, routing, unread) holds. A domain refusal
 *   fails the run, never the queue; anything else is retried by the job, then dead-lettered.
 * - **Waiting:** a duration, until office hours open, or until a condition holds (re-checked when
 *   the conversation changes) or times out. The scheduled sweep resumes runs that are due.
 * - **The record:** every node visited, condition evaluated (with its inputs) and action taken
 *   (with its result), with timings, in `workflow_run_steps`.
 */
export const MAX_RUNS_PER_HOUR = 20;
export const MAX_CHAIN = 3;

export async function workflowsEnabled(db: Sql, w: string) {
  return (
    (await db.query("SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='workflows_v1' AND enabled", [w])).rows
      .length > 0
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Triggers from the timeline                                                                  */

type PartLike = { id: string; kind: string; author_type: string; author_id: string; data: Record<string, unknown> };
type Event = { trigger: Trigger; options?: { tagId?: string; attributeId?: string; key?: string } };

/** Who made a change, from the part's author. */
export function sourceOf(part: { author_type: string; author_id: string }): Source {
  if (part.author_type === "contact") return "customer";
  if (part.author_type === "teammate") return "teammate";
  if (part.author_type === "ai") return "zoe";
  if (part.author_id.startsWith("workflow:")) return "workflow";
  return "system";
}

/** The triggers a timeline part fires. */
async function triggersOf(db: Sql, w: string, c: Conversation, part: PartLike): Promise<Event[]> {
  const d = part.data ?? {};
  switch (part.kind) {
    case "customer_message": {
      const earlier = (
        await db.query(
          "SELECT 1 FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND kind='customer_message' AND id<>$3 LIMIT 1",
          [w, c.id, part.id],
        )
      ).rows.length;
      return earlier ? [{ trigger: "customer_message" }] : [{ trigger: "first_message" }, { trigger: "customer_message" }];
    }
    case "teammate_reply":
      return [{ trigger: "teammate_reply" }];
    case "internal_note":
      return part.author_type === "contact" ? [] : [{ trigger: "note_added" }];
    case "assignment_change":
      return [{ trigger: "assigned" }];
    case "tag_change":
      return d.action === "tag_add" ? [{ trigger: "tagged", options: { tagId: String(d.tagId ?? "") } }] : [];
    case "state_change":
      if (d.from === null || d.from === undefined) return [{ trigger: "conversation_started" }];
      if (d.to === "closed") return [{ trigger: "closed" }];
      if (d.to === "snoozed") return [{ trigger: "snoozed" }];
      if (d.to === "open" && d.from === "closed") return [{ trigger: "reopened" }];
      return [];
    case "attribute_change":
      return d.attributeId ? [{ trigger: "attribute_changed", options: { attributeId: String(d.attributeId) } }] : [];
    case "system_event":
      if (d.event === "ticket_created") return [{ trigger: "ticket_created" }];
      if (d.event === "ticket_state_change" || d.event === "ticket_status") return [{ trigger: "ticket_state_changed" }];
      if (d.event === "sla_breached") return [{ trigger: "sla_breached" }];
      if (d.event === "contact_attribute_change") return [{ trigger: "contact_attribute_changed", options: { key: String(d.key ?? "") } }];
      return [];
    default:
      return [];
  }
}

/**
 * Called for every part `append` writes, in its transaction: queues a start for the triggers a live
 * workflow listens to, and a re-check for runs waiting on a condition in this conversation.
 */
export async function workflowEvent(db: Sql, w: string, c: Conversation, part: PartLike) {
  if (c.visibility === "internal") return;
  if (!(await workflowsEnabled(db, w))) return;
  const events = await triggersOf(db, w, c, part);
  const live = events.length
    ? (
        await db.query<{ trigger: string; definition: Definition }>(
          `SELECT w.trigger,v.definition FROM workflows w
           JOIN workflow_versions v ON v.workspace_id=w.workspace_id AND v.workflow_id=w.id AND v.version=w.live_version
           WHERE w.workspace_id=$1 AND w.state='live' AND NOT w.archived AND w.trigger=ANY($2::text[])`,
          [w, events.map((e) => e.trigger)],
        )
      ).rows
    : [];
  const listened = events.filter((e) => live.some((l) => l.trigger === e.trigger));
  const causedBy = typeof part.data?.workflowRun === "string" ? part.data.workflowRun : null;
  // W3: a customer's answer to a workflow's question belongs to that workflow: it starts no other
  // customer-facing one, and Zoe doesn't take it (whichever job runs first).
  const answering =
    part.kind === "customer_message"
      ? ((
          await db.query<{ name: string }>(
            `SELECT w.name FROM workflow_runs r JOIN workflows w ON w.workspace_id=r.workspace_id AND w.id=r.workflow_id
             WHERE r.workspace_id=$1 AND r.conversation_id=$2 AND r.status='waiting' AND r.wait->>'kind'='reply' LIMIT 1`,
            [w, c.id],
          )
        ).rows[0]?.name ?? null)
      : null;
  for (const e of listened)
    await enqueueJob(
      db,
      w,
      "workflow.start",
      {
        conversationId: c.id,
        trigger: e.trigger,
        options: e.options ?? {},
        partId: part.id,
        source: sourceOf(part),
        causedBy,
        answering,
        // W3: when a customer-facing workflow may take this, Zoe waits for it (`workflowHolds`).
        deferAi: live.some((l) => l.trigger === e.trigger && customerFacing(l.definition)),
      },
      {},
    );
  // Runs waiting until a condition holds, or for Zoe's outcome, look again (not for a workflow's
  // own change in its run); runs waiting for the customer's answer get it.
  const waiting = (
    await db.query<{ id: string; kind: string }>(
      "SELECT id,wait->>'kind' AS kind FROM workflow_runs WHERE workspace_id=$1 AND conversation_id=$2 AND status='waiting' AND id<>COALESCE($3,'')",
      [w, c.id, causedBy],
    )
  ).rows;
  for (const r of waiting)
    if (r.kind === "condition" || r.kind === "zoe") await enqueueJob(db, w, "workflow.resume", { runId: r.id, check: true }, {});
    else if (r.kind === "reply" && part.kind === "customer_message")
      await enqueueJob(db, w, "workflow.resume", { runId: r.id, reply: part.id }, {});
}

/**
 * W3: whether a workflow has the customer's message, so Zoe doesn't answer it: one is waiting for
 * their answer, or a customer-facing workflow may still start for this conversation. Zoe then
 * answers only if none does (`startWorkflows`), or when a workflow hands to her.
 */
export async function workflowHolds(db: Sql, w: string, conversationId: string, partId: string) {
  void partId;
  return (
    (
      await db.query(
        `SELECT 1 FROM workflow_runs WHERE workspace_id=$1 AND conversation_id=$2 AND status='waiting' AND wait->>'kind'='reply'
         UNION ALL
         SELECT 1 FROM jobs WHERE workspace_id=$1 AND kind='workflow.start' AND state IN ('queued','running')
           AND payload->>'conversationId'=$2 AND payload->>'deferAi'='true'
         LIMIT 1`,
        [w, conversationId],
      )
    ).rows.length > 0
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Facts and conditions                                                                        */

export type Facts = Record<string, unknown> & {
  tags: string[];
  attributes: Record<string, unknown>;
  contactAttributes: Record<string, unknown>;
  emailDomains: string[];
};

/** What a conversation's facts are made from: read one at a time here, or in bulk for W2's estimate. */
export type FactSources = {
  conversation: Conversation & { ai_state?: string | null; sla_breached?: boolean; sla_overdue?: boolean; channel?: string };
  tags: string[];
  contact: { role: string | null; profile: Record<string, unknown> | null; kind: string | null } | undefined;
  emails: string[];
  /** The customer's latest message, and the brand's locale: the customer's language. */
  latest: string;
  brandLocale: string;
  message: string;
  officeHours: "open" | "closed";
  source: Source;
  timedOut: boolean;
  /** W4: the page the customer's messenger is on, and what a webhook sent. */
  pageUrl?: string;
  triggerData?: Record<string, unknown>;
};
export function buildFacts(s: FactSources): Facts {
  const c = s.conversation;
  return {
    "conversation.status": c.status,
    "conversation.priority": !!c.priority,
    "conversation.assignee": c.assigned || null,
    "conversation.team": c.team_id ?? null,
    "conversation.brand": c.brand_id,
    "conversation.channel": c.channel ?? "messenger",
    // The customer's language: what their latest message is written in, else the brand's.
    "conversation.language": (detectLanguage(s.latest) ?? s.brandLocale).split("-")[0],
    "conversation.ai_state": c.ai_state ?? null,
    "conversation.sla": c.sla_breached ? "breached" : c.sla_overdue ? "overdue" : null,
    "message.text": s.message,
    "contact.signed_in": s.contact?.kind === "user",
    "contact.role": s.contact?.role ?? "visitor",
    office_hours: s.officeHours,
    "change.by": s.source,
    "wait.timed_out": s.timedOut,
    "page.url": s.pageUrl ?? "",
    tags: s.tags,
    triggerData: s.triggerData ?? {},
    attributes: (c.attributes as Record<string, unknown>) ?? {},
    contactAttributes: s.contact?.profile ?? {},
    emailDomains: s.emails.map((e) => e.split("@").pop()!.toLowerCase()),
  };
}

/** What conditions test, read once per evaluation (and by W3's simulation). */
export async function factsFor(
  db: Sql,
  w: string,
  c: Conversation,
  run: { source: Source; partId: string | null; timedOut?: boolean; data?: Record<string, unknown> },
): Promise<Facts> {
  const tags = (await db.query<{ tag_id: string }>("SELECT tag_id FROM conversation_tags WHERE workspace_id=$1 AND conversation_id=$2", [w, c.id])).rows.map(
    (r) => r.tag_id,
  );
  const contact = (
    await db.query<{ role: string | null; profile: Record<string, unknown> | null; kind: string | null }>(
      `SELECT k.role,k.profile,i.kind FROM conversations c
       LEFT JOIN identities i ON i.workspace_id=c.workspace_id AND i.id=c.primary_identity_id
       LEFT JOIN identity_contact_mappings m ON m.workspace_id=c.workspace_id AND m.identity_id=c.primary_identity_id
       LEFT JOIN contacts k ON k.workspace_id=m.workspace_id AND k.id=m.contact_id
       WHERE c.workspace_id=$1 AND c.id=$2`,
      [w, c.id],
    )
  ).rows[0];
  const emails = (
    await db.query<{ email: string }>(
      `SELECT e.email FROM identity_contact_mappings m JOIN contact_emails e ON e.workspace_id=m.workspace_id AND e.contact_id=m.contact_id
       WHERE m.workspace_id=$1 AND m.identity_id=$2 AND e.verified`,
      [w, c.primary_identity_id],
    )
  ).rows.map((e) => e.email);
  const message = run.partId
    ? ((await db.query<{ body: string }>("SELECT body FROM conversation_parts WHERE workspace_id=$1 AND id=$2", [w, run.partId])).rows[0]?.body ?? "")
    : "";
  const latest =
    (
      await db.query<{ body: string }>(
        "SELECT body FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND kind='customer_message' ORDER BY seq DESC LIMIT 1",
        [w, c.id],
      )
    ).rows[0]?.body ?? "";
  const brandLocale =
    (await db.query<{ locale: string | null }>("SELECT settings->>'locale' AS locale FROM brands WHERE workspace_id=$1 AND id=$2", [w, c.brand_id])).rows[0]
      ?.locale ?? "en";
  const hours = await availabilityFor(db, w, { brandId: c.brand_id, teamId: c.team_id }, "en");
  // W4: the page their messenger last reported (for this brand).
  const pageUrl =
    (
      await db.query<{ page_url: string | null }>(
        "SELECT page_url FROM messenger_sessions WHERE workspace_id=$1 AND identity_id=$2 AND brand_id=$3 ORDER BY expires_at DESC LIMIT 1",
        [w, c.primary_identity_id, c.brand_id],
      )
    ).rows[0]?.page_url ?? "";
  return buildFacts({
    conversation: c,
    tags,
    contact,
    emails,
    latest,
    brandLocale,
    message,
    officeHours: !hours || hours.open ? "open" : "closed",
    source: run.source,
    timedOut: !!run.timedOut,
    pageUrl,
    triggerData: run.data ?? {},
  });
}

type Evaluated = { field: string; key?: string; op: string; value?: unknown; actual: unknown; result: boolean };

/** A condition against the facts, with what it saw (for the run log). */
async function holds(db: Sql, w: string, c: Condition, f: Facts): Promise<Evaluated> {
  let actual: unknown;
  let result: boolean;
  const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const set = (v: unknown) => v !== null && v !== undefined && v !== "";
  if (c.field === "conversation.tag") {
    actual = f.tags;
    result = f.tags.includes(String(c.value));
    if (c.op === "has_not") result = !result;
  } else if (c.field === "contact.email_domain") {
    actual = f.emailDomains;
    result = f.emailDomains.includes(String(c.value).toLowerCase().replace(/^@/, ""));
    if (c.op === "is_not") result = !result;
  } else if (c.field === "team.available") {
    const n = (
      await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM teammate_teams m JOIN teammates t ON t.workspace_id=m.workspace_id AND t.id=m.teammate_id
         WHERE m.workspace_id=$1 AND m.team_id=$2 AND t.presence='active'`,
        [w, c.key],
      )
    ).rows[0].n;
    actual = n;
    result = (n > 0) === (c.value === true);
  } else {
    actual =
      c.field === "conversation.attribute"
        ? f.attributes[c.key!]
        : c.field === "contact.attribute"
          ? f.contactAttributes[c.key!]
          : c.field === "trigger.data"
            ? (f.triggerData as Record<string, unknown>)[c.key!]
            : f[c.field];
    switch (c.op) {
      case "is":
        result = typeof c.value === "boolean" ? actual === c.value : text(actual).toLowerCase() === text(c.value).toLowerCase();
        break;
      case "is_not":
        result = text(actual).toLowerCase() !== text(c.value).toLowerCase();
        break;
      case "is_set":
        result = set(actual);
        break;
      case "is_not_set":
        result = !set(actual);
        break;
      case "contains":
        result = text(actual).toLowerCase().includes(text(c.value).toLowerCase());
        break;
      case "not_contains":
        result = !text(actual).toLowerCase().includes(text(c.value).toLowerCase());
        break;
      default:
        throw new DomainError("WORKFLOW_CONDITION", `A condition on ${c.field} can't be evaluated.`, 400);
    }
  }
  return { field: c.field, ...(c.key ? { key: c.key } : {}), op: c.op, ...(c.value !== undefined ? { value: c.value } : {}), actual, result };
}

/**
 * A group (all or any, nested), with every condition it evaluated. An empty group holds. Fields
 * in `assume` aren't evaluated but taken to hold (W2's estimate, for what depends on the moment).
 */
export async function evaluate(
  db: Sql,
  w: string,
  g: Group,
  f: Facts,
  assume: ReadonlySet<string> = new Set(),
): Promise<{ result: boolean; checks: Evaluated[] }> {
  const checks: Evaluated[] = [];
  const walk = async (x: Group): Promise<boolean> => {
    if (!x.items.length) return true;
    const results: boolean[] = [];
    for (const item of x.items) {
      if ("items" in item) results.push(await walk(item));
      else if (assume.has(item.field)) results.push(true);
      else {
        const e = await holds(db, w, item, f);
        checks.push(e);
        results.push(e.result);
      }
    }
    return x.match === "all" ? results.every(Boolean) : results.some(Boolean);
  };
  return { result: await walk(g), checks };
}

/* ------------------------------------------------------------------------------------------ */
/* Starting                                                                                    */

type RunRow = {
  id: string;
  workflow_id: string;
  workflow_version: number;
  conversation_id: string | null;
  trigger: string;
  trigger_part_id: string | null;
  trigger_data: Record<string, unknown>;
  source: Source;
  chain: string[];
  status: string;
  path: string | null;
  step: number;
  wait: { kind: string; path?: string; timedOut?: string; met?: string } | null;
  nodes: number;
  steps: number;
  started_at: string;
  version: string;
  name: string;
  definition: Definition;
};
const RUN = `r.id,r.workflow_id,r.workflow_version,r.conversation_id,r.trigger,r.trigger_part_id,r.trigger_data,r.source,r.chain,r.status,r.path,r.step,r.wait,
  r.nodes,r.steps,r.started_at,r.version::text AS version,w.name,v.definition
  FROM workflow_runs r JOIN workflows w ON w.workspace_id=r.workspace_id AND w.id=r.workflow_id
  JOIN workflow_versions v ON v.workspace_id=r.workspace_id AND v.workflow_id=r.workflow_id AND v.version=r.workflow_version`;

async function log(
  db: Sql,
  w: string,
  runId: string,
  e: { path?: string | null; step?: number | null; kind: string; label: string; inputs?: unknown; result: string; detail?: unknown; ms?: number },
) {
  await db.query(
    `INSERT INTO workflow_run_steps(workspace_id,run_id,seq,path,step,kind,label,inputs,result,detail,duration_ms)
     SELECT $1,$2,COALESCE(max(seq),0)+1,$3,$4,$5,$6,$7,$8,$9,$10 FROM workflow_run_steps WHERE workspace_id=$1 AND run_id=$2`,
    [w, runId, e.path ?? null, e.step ?? null, e.kind, e.label, JSON.stringify(e.inputs ?? {}), e.result, JSON.stringify(e.detail ?? {}), e.ms ?? 0],
  );
}
async function finish(db: Sql, w: string, runId: string, status: "completed" | "failed", reason: string, error = "") {
  const run = (
    await db.query<{ workflow_id: string }>(
      `UPDATE workflow_runs SET status=$3,reason=$4,error=$5,ended_at=now(),duration_ms=GREATEST(0,(extract(epoch from now()-started_at)*1000)::int),
         wait=NULL,wait_until=NULL,version=version+1 WHERE workspace_id=$1 AND id=$2 RETURNING workflow_id`,
      [w, runId, status, reason, error],
    )
  ).rows[0];
  if (run) await watchFailures(db, w, run.workflow_id, runId, status, error);
}

/** W4: three failed runs in a row open an alert (and notify managers once); a completed run closes it. */
export const FAILURES_FOR_ALERT = 3;
async function watchFailures(db: Sql, w: string, workflowId: string, runId: string, status: "completed" | "failed", error: string) {
  if (status === "completed") {
    await db.query(
      "UPDATE workflow_alerts SET resolved_at=now(),resolution='recovered' WHERE workspace_id=$1 AND workflow_id=$2 AND resolved_at IS NULL",
      [w, workflowId],
    );
    return;
  }
  const recent = (
    await db.query<{ status: string }>(
      `SELECT status FROM workflow_runs WHERE workspace_id=$1 AND workflow_id=$2 AND status IN ('completed','failed')
       ORDER BY ended_at DESC NULLS LAST,started_at DESC LIMIT $3`,
      [w, workflowId, FAILURES_FOR_ALERT],
    )
  ).rows;
  const open = (
    await db.query<{ id: string }>("SELECT id FROM workflow_alerts WHERE workspace_id=$1 AND workflow_id=$2 AND resolved_at IS NULL", [w, workflowId])
  ).rows[0];
  if (open) {
    await db.query("UPDATE workflow_alerts SET failures=failures+1,last_error=$3,last_run_id=$4 WHERE workspace_id=$1 AND id=$2", [w, open.id, error, runId]);
    return;
  }
  if (recent.length < FAILURES_FOR_ALERT || recent.some((r) => r.status !== "failed")) return;
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO workflow_alerts(workspace_id,id,workflow_id,failures,last_error,last_run_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
    [w, id, workflowId, FAILURES_FOR_ALERT, error, runId],
  );
  const name = (await db.query<{ name: string }>("SELECT name FROM workflows WHERE workspace_id=$1 AND id=$2", [w, workflowId])).rows[0]?.name ?? "A workflow";
  await db.query(
    `INSERT INTO notifications(workspace_id,id,teammate_id,kind,workflow_alert_id,excerpt)
     SELECT $1,gen_random_uuid()::text,t.id,'workflow_alert',$2,$3 FROM teammates t
     JOIN role_capabilities p ON p.workspace_id=t.workspace_id AND p.role_id=t.role_id AND p.capability='workspace.manage'
     WHERE t.workspace_id=$1
     ON CONFLICT DO NOTHING`,
    [w, id, `“${name}” failed ${FAILURES_FOR_ALERT} times in a row: ${error}`.slice(0, 140)],
  );
}

/** What a run needs from outside: connectors (W3), when this runtime has them. */
export type WorkflowEnvironment = { connectors?: ConnectorEnvironment };

/** Zoe answers the customer's latest unanswered message, once no workflow holds it. */
async function answerIfFree(db: Sql, w: string, c: Conversation, jobId: string) {
  const others = (
    await db.query(
      `SELECT 1 FROM jobs WHERE workspace_id=$1 AND kind='workflow.start' AND state IN ('queued','running') AND id<>$3
         AND payload->>'conversationId'=$2 AND payload->>'deferAi'='true' LIMIT 1`,
      [w, c.id, jobId],
    )
  ).rows.length;
  const replyWait = (
    await db.query("SELECT 1 FROM workflow_runs WHERE workspace_id=$1 AND conversation_id=$2 AND status='waiting' AND wait->>'kind'='reply' LIMIT 1", [w, c.id])
  ).rows.length;
  if (others || replyWait) return;
  const last = (
    await db.query<{ id: string }>(
      `SELECT p.id FROM conversation_parts p WHERE p.workspace_id=$1 AND p.conversation_id=$2 AND p.kind='customer_message'
         AND NOT EXISTS(SELECT 1 FROM ai_answers a WHERE a.workspace_id=p.workspace_id AND a.question_part_id=p.id)
         AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.workspace_id=p.workspace_id AND j.kind='ai.reply' AND j.payload->>'partId'=p.id)
       ORDER BY p.seq DESC LIMIT 1`,
      [w, c.id],
    )
  ).rows[0];
  if (last) await queueAiReply(db, w, await conversation(db, w, c.id), last.id);
}

/**
 * The `workflow.start` job: the live workflows for a trigger, in priority order, each checked and
 * either started or recorded as skipped; then the started ones run.
 */
export async function startWorkflows(connect: Connect, job: Job, env: WorkflowEnvironment = {}) {
  const w = job.workspace_id;
  const p = job.payload as {
    conversationId: string;
    trigger: Trigger;
    options: { tagId?: string; attributeId?: string; key?: string; url?: string };
    partId: string | null;
    source: Source;
    causedBy: string | null;
    workflowId?: string;
    deferAi?: boolean;
    answering?: string | null;
    /** W4: fire once per occurrence (time and browsing triggers), and what a webhook or page gave. */
    key?: string;
    data?: Record<string, unknown>;
  };
  const started = await tenant(connect, w, async (db) => {
    if (!(await workflowsEnabled(db, w))) return [];
    const c = await conversation(db, w, p.conversationId);
    const chain = p.causedBy
      ? await (async () => {
          const r = (await db.query<{ workflow_id: string; chain: string[] }>("SELECT workflow_id,chain FROM workflow_runs WHERE workspace_id=$1 AND id=$2", [w, p.causedBy]))
            .rows[0];
          return r ? [...r.chain, r.workflow_id] : [];
        })()
      : [];
    const candidates = (
      await db.query<{ id: string; name: string; live_version: number; definition: Definition }>(
        `SELECT w.id,w.name,w.live_version,v.definition FROM workflows w
         JOIN workflow_versions v ON v.workspace_id=w.workspace_id AND v.workflow_id=w.id AND v.version=w.live_version
         WHERE w.workspace_id=$1 AND w.trigger=$2 AND NOT w.archived AND (w.state='live' OR w.id=$3)
         ORDER BY w.priority,w.created_at,w.id`,
        [w, p.trigger, p.workflowId ?? ""],
      )
    ).rows.filter((x) => (p.workflowId ? x.id === p.workflowId : true));
    const recent = (
      await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM workflow_runs WHERE workspace_id=$1 AND conversation_id=$2 AND status<>'skipped' AND started_at>now()-interval '1 hour'",
        [w, c.id],
      )
    ).rows[0].n;
    // W3: a customer-facing workflow still talking to the customer here keeps others from starting.
    const talking =
      (
        await db.query<{ name: string; definition: Definition }>(
          `SELECT w.name,v.definition FROM workflow_runs r JOIN workflows w ON w.workspace_id=r.workspace_id AND w.id=r.workflow_id
           JOIN workflow_versions v ON v.workspace_id=r.workspace_id AND v.workflow_id=r.workflow_id AND v.version=r.workflow_version
           WHERE r.workspace_id=$1 AND r.conversation_id=$2 AND r.status IN ('running','waiting')`,
          [w, c.id],
        )
      ).rows.find((r) => customerFacing(r.definition))?.name ??
      p.answering ??
      null;
    let ranCustomerFacing: string | null = null;
    let budget = MAX_RUNS_PER_HOUR - recent;
    const out: string[] = [];
    for (const wf of candidates) {
      const def = wf.definition;
      const o = def.trigger.options ?? {};
      if (o.tagId && o.tagId !== p.options.tagId) continue;
      if (o.attributeId && o.attributeId !== p.options.attributeId) continue;
      if (o.key && o.key !== p.options.key) continue;
      if (o.url && !String(p.options.url ?? "").includes(o.url)) continue;
      const facts = await factsFor(db, w, c, { source: p.source, partId: p.partId, data: p.data });
      const who = await evaluate(db, w, def.when, facts);
      if (!who.result) continue;
      const id = crypto.randomUUID();
      const facing = customerFacing(def);
      const skip =
        wf.id === chain.at(-1)
          ? "Its own change would start it again."
          : chain.includes(wf.id)
            ? `A loop: ${[...chain, wf.id].length} workflows would start each other.`
            : chain.length >= MAX_CHAIN
              ? `More than ${MAX_CHAIN} workflows in a row started each other.`
              : facing && ranCustomerFacing
                ? `“${ranCustomerFacing}” ran first: only the highest-priority customer-facing workflow runs for a trigger.`
                : facing && talking
                  ? `“${talking}” is still talking to the customer.`
                : budget <= 0
                  ? `This conversation already had ${MAX_RUNS_PER_HOUR} workflow runs in the last hour.`
                  : null;
      const inserted = (
        await db.query(
          `INSERT INTO workflow_runs(workspace_id,id,workflow_id,workflow_version,conversation_id,trigger,trigger_part_id,source,chain,status,path,reason,ended_at,duration_ms,trigger_key,trigger_data)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,${skip ? "now(),0" : "NULL,NULL"},$13,$14)
           ON CONFLICT (workspace_id,workflow_id,conversation_id,trigger_key) WHERE trigger_key IS NOT NULL DO NOTHING RETURNING id`,
          [w, id, wf.id, wf.live_version, c.id, p.trigger, p.partId, p.source, chain, skip ? "skipped" : "running", def.paths[0].id, skip ?? "", p.key ?? null, JSON.stringify(p.data ?? {})],
        )
      ).rows.length;
      // W4: this occurrence already fired it (a message still unanswered, the same SLA target).
      if (!inserted) continue;
      await log(db, w, id, {
        kind: "trigger",
        label: TRIGGERS[p.trigger].label,
        inputs: { source: p.source, ...p.options, ...(p.partId ? { partId: p.partId } : {}) },
        result: "fired",
      });
      if (who.checks.length) await log(db, w, id, { kind: "condition", label: "Who it runs for", inputs: who.checks, result: "held" });
      if (skip) {
        await log(db, w, id, { kind: "skip", label: "Not run", result: "skipped", detail: { reason: skip } });
        continue;
      }
      if (facing) ranCustomerFacing = wf.name;
      budget--;
      out.push(id);
    }
    // W3: Zoe waited for workflows; if none is talking to the customer now, she answers.
    if (p.deferAi && !ranCustomerFacing && !talking) await answerIfFree(db, w, c, job.id);
    return out;
  });
  for (const id of started) await runWorkflow(connect, w, id, {}, env);
  return { done: true, result: { started: started.length } };
}

/** A teammate runs a manual workflow on a conversation (from the inbox). */
export async function startManual(db: Sql, w: string, workflowId: string, conversationId: string) {
  await enqueueJob(
    db,
    w,
    "workflow.start",
    { conversationId, trigger: "manual", options: {}, partId: null, source: "manual", causedBy: null, workflowId },
    {},
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Running                                                                                     */

/** What a waiting run waits for (`workflow_runs.wait`). */
type WaitState =
  | { kind: "duration" }
  | { kind: "office_hours" }
  | { kind: "condition"; met: string; timedOut: string }
  /** W3: the customer's answer to reply buttons, or to a question a step collects. */
  | { kind: "reply"; mode: "buttons" | "collect"; partId: string; attempt?: number }
  /** W3: Zoe's outcome, after `since`. */
  | { kind: "zoe"; since: string };
type Resume = { timedOut?: boolean; deadline?: string | null; wait?: WaitState | null; reply?: string | null };
/** W3: a connector call, made between transactions (it's network). */
type CallPlan = { connectorId: string; connector: string; version: number; values: Record<string, unknown>; path: string };

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A collected reply in its format, or null when it doesn't fit. */
function parseReply(text: string, format: unknown): string | number | null {
  const t = text.trim();
  if (!t || t.length > 500) return null;
  if (format === "email") return EMAIL.test(t) ? t.toLowerCase() : null;
  if (format === "number") return /^-?\d+(\.\d+)?$/.test(t.replace(/,/g, "")) ? Number(t.replace(/,/g, "")) : null;
  return t;
}

/** Runs from where it stands until it waits, ends or fails. Each step is one transaction. */
export async function runWorkflow(connect: Connect, w: string, runId: string, resume: Resume = {}, env: WorkflowEnvironment = {}) {
  let timedOut = resume.timedOut ?? false;
  let called: { plan: CallPlan; result: Awaited<ReturnType<typeof runConnector>> } | null = null;
  for (let guard = 0; guard < MAX_NODES + 5; guard++) {
    let outcome: "continue" | "stop" | CallPlan;
    const resumed = resume.wait ?? null;
    const reply = resume.reply ?? null;
    const call = called;
    called = null;
    try {
      outcome = await tenant(connect, w, async (db): Promise<"continue" | "stop" | CallPlan> => {
        const run = (await db.query<RunRow>(`SELECT ${RUN} WHERE r.workspace_id=$1 AND r.id=$2 FOR UPDATE OF r`, [w, runId])).rows[0];
        if (!run || run.status !== "running") return "stop";
        if (!(await workflowsEnabled(db, w))) {
          await log(db, w, runId, { kind: "error", label: "Workflows were turned off", result: "failed" });
          await finish(db, w, runId, "failed", "", "Workflows were turned off for this workspace.");
          return "stop";
        }
        if (run.nodes >= MAX_NODES) {
          await log(db, w, runId, { kind: "error", label: `More than ${MAX_NODES} steps`, result: "failed" });
          await finish(db, w, runId, "failed", "", `It took more than ${MAX_NODES} steps; a loop in its paths?`);
          return "stop";
        }
        const path = run.definition.paths.find((x) => x.id === run.path);
        if (!path) {
          await finish(db, w, runId, "failed", "", `Path ${run.path} doesn't exist in version ${run.workflow_version}.`);
          return "stop";
        }
        const c = run.conversation_id ? await conversation(db, w, run.conversation_id, true) : null;
        if (!c) {
          await finish(db, w, runId, "failed", "", "Its conversation is gone.");
          return "stop";
        }
        const started = Date.now();
        const actor = { type: "workflow" as const, workflowId: run.workflow_id, runId: run.id, name: run.name };
        const say = (key: string, text: string, workflowData?: Record<string, unknown>) =>
          command(db, w, actor, `wf:${run.id}:${run.nodes}:${key}`, { action: "reply", conversationId: c.id, text, workflowData } as never) as Promise<{ partId: string }>;
        const go = async (to: string, kind: "goto" | "branch", label: string, inputs: unknown = {}) => {
          await log(db, w, runId, { path: path.id, kind, label, inputs, result: `to path ${to}`, ms: Date.now() - started });
          await db.query("UPDATE workflow_runs SET path=$3,step=0,nodes=nodes+1,wait=NULL,version=version+1 WHERE workspace_id=$1 AND id=$2", [w, runId, to]);
          return "continue" as const;
        };
        const wait = async (state: WaitState, until: string | null) => {
          await db.query("UPDATE workflow_runs SET status='waiting',wait=$3,wait_until=$4,version=version+1 WHERE workspace_id=$1 AND id=$2", [
            w,
            runId,
            JSON.stringify(state),
            until,
          ]);
          return "stop" as const;
        };
        const inSeconds = (n: number) => new Date(Date.now() + n * 1000).toISOString();

        // W3: a connector call made between transactions: keep its outputs, then on by result.
        if (call && path.next.type === "connector") {
          const n = path.next;
          const ok = call.result.result === "ok";
          const saved: Record<string, unknown> = {};
          if (ok)
            for (const [output, attributeId] of Object.entries(n.save))
              if (call.result.outputs[output] !== undefined) {
                await command(db, w, actor, `wf:${run.id}:${run.nodes}:save:${output}`, {
                  action: "attribute_set",
                  conversationId: c.id,
                  attributeId,
                  value: call.result.outputs[output],
                } as never);
                saved[output] = attributeId;
              }
          await log(db, w, runId, {
            path: path.id,
            kind: "action",
            label: `Called ${call.plan.connector}`,
            inputs: { version: call.plan.version, call: call.result.callId },
            result: call.result.result,
            detail: { status: call.result.status, error: call.result.error, saved },
            ms: call.result.durationMs,
          });
          return go(ok ? n.ok : n.failed, "branch", ok ? "The connector worked" : "The connector failed");
        }

        // W3: the customer's answer to a question a step collects (the step was already counted).
        if (resumed?.kind === "reply" && resumed.mode === "collect") {
          const step = path.steps[run.step - 1];
          const o = step?.options ?? {};
          if (!reply) {
            timedOut = true;
            await log(db, w, runId, { path: path.id, step: run.step - 1, kind: "wait", label: "No reply to collect", result: "timed out" });
            return "continue";
          }
          timedOut = false;
          const answer = (await db.query<{ body: string }>("SELECT body FROM conversation_parts WHERE workspace_id=$1 AND id=$2", [w, reply])).rows[0]?.body ?? "";
          const format = o.into === "email" ? "email" : o.format;
          const value = parseReply(answer, format);
          if (value === null) {
            if ((resumed.attempt ?? 1) < 2) {
              const again = await say(
                "again",
                typeof o.retryText === "string" && o.retryText.trim()
                  ? o.retryText.trim()
                  : format === "email"
                    ? "That doesn't look like an email address. Could you check it and send it again?"
                    : format === "number"
                      ? "That doesn't look like a number. Could you send it again?"
                      : "Sorry, I didn't catch that. Could you send it again?",
              );
              await log(db, w, runId, { path: path.id, step: run.step - 1, kind: "wait", label: "Asked again", inputs: { reply }, result: "waiting" });
              return wait({ kind: "reply", mode: "collect", partId: again.partId, attempt: 2 }, inSeconds(Number(o.timeoutSeconds ?? 86_400)));
            }
            await log(db, w, runId, { path: path.id, step: run.step - 1, kind: "action", label: "The reply couldn't be used", inputs: { reply }, result: "not kept" });
            return "continue";
          }
          if (o.into === "email") await keepEmail(db, w, c, String(value));
          else if (o.into === "contact") await setContactAttribute(db, w, run, c, String(o.key), value);
          else await command(db, w, actor, `wf:${run.id}:${run.nodes}:collect`, { action: "attribute_set", conversationId: c.id, attributeId: o.attributeId, value } as never);
          await log(db, w, runId, {
            path: path.id,
            step: run.step - 1,
            kind: "action",
            label: "Kept the reply",
            inputs: { reply },
            result: "ok",
            detail: { into: o.into, ...(o.into === "contact" ? { key: o.key } : o.into === "conversation" ? { attributeId: o.attributeId } : {}) },
          });
          return "continue";
        }

        // The path's steps, one per transaction.
        if (run.step < path.steps.length) {
          const step = path.steps[run.step];
          const result = await act(db, w, run, c, step, path);
          await log(db, w, runId, {
            path: path.id,
            step: run.step,
            kind: step.type === "wait" || step.type === "wait_office_hours" || step.type === "collect" ? "wait" : "action",
            label: result.label,
            inputs: step.options,
            result: result.result,
            detail: result.detail,
            ms: Date.now() - started,
          });
          if (result.wait) {
            await db.query(
              `UPDATE workflow_runs SET status='waiting',step=step+1,nodes=nodes+1,steps=steps+1,wait=$3,wait_until=$4,version=version+1
               WHERE workspace_id=$1 AND id=$2`,
              [w, runId, JSON.stringify(result.wait.state), result.wait.until],
            );
            return "stop";
          }
          await db.query("UPDATE workflow_runs SET step=step+1,nodes=nodes+1,steps=steps+1,version=version+1 WHERE workspace_id=$1 AND id=$2", [w, runId]);
          return "continue";
        }
        // Then its way on.
        const next = path.next;
        if (next.type === "end") {
          await log(db, w, runId, { path: path.id, kind: "end", label: "End", result: "completed" });
          await finish(db, w, runId, "completed", `Ended at path ${path.id}.`);
          return "stop";
        }
        if (next.type === "goto") return go(next.path, "goto", `Go to path ${next.path}`);

        // W3: reply buttons. Asked once; the answer (a button, typing, or none) picks the path.
        if (next.type === "buttons") {
          if (resumed?.kind === "reply" && resumed.mode === "buttons") {
            if (!reply) {
              timedOut = true;
              return go(next.timedOut, "branch", "No answer to the buttons");
            }
            timedOut = false;
            const answer = (await db.query<{ body: string }>("SELECT body FROM conversation_parts WHERE workspace_id=$1 AND id=$2", [w, reply])).rows[0]?.body ?? "";
            const chosen = next.buttons.find((b) => norm(b.label) === norm(answer));
            return chosen
              ? go(chosen.path, "branch", `They chose “${chosen.label}”`, { answer })
              : go(next.other, "branch", "They typed instead of choosing", { answer });
          }
          const asked = await say("ask", next.text, { options: next.buttons.map((b) => b.label) });
          await log(db, w, runId, {
            path: path.id,
            kind: "wait",
            label: "Asked with reply buttons",
            inputs: { buttons: next.buttons.map((b) => b.label) },
            result: "waiting",
            ms: Date.now() - started,
          });
          return wait({ kind: "reply", mode: "buttons", partId: asked.partId }, inSeconds(next.timeoutSeconds));
        }

        // W3: Zoe answers, and her outcome picks the path.
        if (next.type === "zoe") {
          const row = (await db.query<{ ai_state: string | null }>("SELECT ai_state FROM conversations WHERE workspace_id=$1 AND id=$2", [w, c.id])).rows[0];
          if (resumed?.kind === "zoe") {
            const resolved = (
              await db.query(
                `SELECT 1 FROM ai_resolutions r WHERE r.workspace_id=$1 AND r.conversation_id=$2 AND r.kind='resolution' AND r.recorded_at>=$3
                   AND NOT EXISTS(SELECT 1 FROM ai_resolutions x WHERE x.workspace_id=r.workspace_id AND x.resolution_id=r.id)`,
                [w, c.id, resumed.since],
              )
            ).rows.length;
            if (resolved) return go(next.resolved, "branch", "Zoe resolved it", { aiState: row.ai_state });
            if (row.ai_state === "escalated" || row.ai_state === "needs_input") return go(next.handedOver, "branch", "Zoe handed it over", { aiState: row.ai_state });
            if (resume.timedOut) {
              timedOut = true;
              return go(next.timedOut, "branch", "No outcome from Zoe in time", { aiState: row.ai_state });
            }
            return wait(resumed, resume.deadline ?? inSeconds(next.timeoutSeconds));
          }
          if (!(await aiEnabled(db, w))) return go(next.handedOver, "branch", "Zoe is off: handed over");
          if (row.ai_state === "escalated" || row.ai_state === "needs_input") return go(next.handedOver, "branch", "Already handed over", { aiState: row.ai_state });
          const handed = await act(db, w, run, c, { id: "zoe", type: "ai_handover", options: {} }, path);
          await log(db, w, runId, { path: path.id, kind: "wait", label: "Letting Zoe answer", inputs: handed.detail, result: "waiting", ms: Date.now() - started });
          return wait({ kind: "zoe", since: new Date().toISOString() }, inSeconds(next.timeoutSeconds));
        }

        // W4: the conversation goes on in a reusable workflow (its own run, in the same chain).
        if (next.type === "workflow") {
          const target = (
            await db.query<{ name: string }>(
              "SELECT name FROM workflows WHERE workspace_id=$1 AND id=$2 AND trigger='reusable' AND state='live' AND NOT archived",
              [w, next.workflowId],
            )
          ).rows[0];
          if (!target) throw new DomainError("WORKFLOW_NOT_FOUND", "The reusable workflow it passes to isn't live.", 404);
          await log(db, w, runId, { path: path.id, kind: "goto", label: `Passed to “${target.name}”`, result: "passed" });
          await finish(db, w, runId, "completed", `Passed to “${target.name}”.`);
          await enqueueJob(
            db,
            w,
            "workflow.start",
            {
              conversationId: c.id,
              trigger: "reusable",
              options: {},
              partId: run.trigger_part_id,
              source: "workflow",
              causedBy: runId,
              workflowId: next.workflowId,
              data: run.trigger_data,
            },
            {},
          );
          return "stop";
        }

        // W3: a read connector, for a customer the verification rules allow.
        if (next.type === "connector") {
          const fail = (why: string) => go(next.failed, "branch", why);
          if (!env.connectors) return fail("Connectors aren't available here");
          if (!(await actionsEnabled(db, w))) return fail("Data connectors are off");
          const named = (await db.query<{ name: string }>("SELECT name FROM ai_connectors WHERE workspace_id=$1 AND id=$2 AND NOT archived", [w, next.connectorId])).rows[0];
          if (!named) return fail("Its connector isn't available");
          const version = await pinnedVersion(db, w, next.connectorId, c.id);
          const def = version
            ? (
                await db.query<{ definition: ConnectorDefinition }>(
                  "SELECT definition FROM ai_connector_versions WHERE workspace_id=$1 AND connector_id=$2 AND version=$3",
                  [w, next.connectorId, version],
                )
              ).rows[0]?.definition
            : null;
          if (!version || !def) return fail(`${named.name} isn't published`);
          if (def.access === "write") return fail(`${named.name} changes things: workflows call read connectors only`);
          const f = await factsFor(db, w, c, { source: run.source, partId: run.trigger_part_id, data: run.trigger_data });
          const agentId = (await db.query<{ id: string }>("SELECT id FROM ai_agents WHERE workspace_id=$1 ORDER BY id LIMIT 1", [w])).rows[0]?.id;
          const v = agentId ? await verificationOf(db, w, agentId) : { rules: [], fallback: "signed_in" as const };
          const check = verified(
            v.rules,
            v.fallback,
            await aiFacts(db, w, c, { signedIn: f["contact.signed_in"] === true, language: String(f["conversation.language"]) }),
            "messenger",
          );
          if (!check.ok) return fail(`${named.name} needs a signed-in customer${check.rule ? ` (verification rule “${check.rule}”)` : " (the fallback rule)"}`);
          const values: Record<string, unknown> = {};
          for (const [name, src] of Object.entries(next.inputs) as [string, ValueSource][])
            values[name] = src.from === "value" ? src.value : src.from === "contact" ? f.contactAttributes[src.key] : f.attributes[src.attributeId];
          return { connectorId: next.connectorId, connector: named.name, version, values, path: path.id };
        }

        const facts = await factsFor(db, w, c, { source: run.source, partId: run.trigger_part_id, timedOut, data: run.trigger_data });
        if (next.type === "branch") {
          for (const b of next.branches) {
            const e = await evaluate(db, w, b.when, facts);
            if (e.result) return go(b.path, "branch", `Branch “${b.label}” matched`, e.checks);
            await log(db, w, runId, { path: path.id, kind: "condition", label: `Branch “${b.label}”`, inputs: e.checks, result: "no match" });
          }
          return go(next.else, "branch", "No branch matched: else", {});
        }
        // Wait until a condition holds, or time out.
        const e = await evaluate(db, w, next.when, facts);
        if (e.result) {
          timedOut = false;
          return go(next.met, "branch", "The wait's condition holds", e.checks);
        }
        if (resume.timedOut) {
          timedOut = true;
          return go(next.timedOut, "branch", "The wait timed out", e.checks);
        }
        await log(db, w, runId, { path: path.id, kind: "wait", label: "Waiting until the condition holds", inputs: e.checks, result: "waiting" });
        // A re-check keeps the deadline set when the wait began.
        await db.query(
          `UPDATE workflow_runs SET status='waiting',wait=$3,wait_until=COALESCE($5::timestamptz,now()+make_interval(secs=>$4)),version=version+1
           WHERE workspace_id=$1 AND id=$2`,
          [w, runId, JSON.stringify({ kind: "condition", met: next.met, timedOut: next.timedOut }), next.timeoutSeconds, resume.deadline ?? null],
        );
        return "stop";
      });
    } catch (err) {
      if (err instanceof DomainError) {
        // A refusal (an archived tag, a ticket that exists, a close that needs fields) fails this run.
        await tenant(connect, w, async (db) => {
          const run = (await db.query<{ path: string | null; step: number }>("SELECT path,step FROM workflow_runs WHERE workspace_id=$1 AND id=$2", [w, runId])).rows[0];
          await log(db, w, runId, { path: run?.path, step: run?.step, kind: "error", label: "Step failed", result: "failed", detail: { code: err.code, message: err.message } });
          await finish(db, w, runId, "failed", "", err.message);
        });
        return { status: "failed" };
      }
      throw err; // Transient: the job retries the step (idempotent), then dead-letters.
    }
    resume = {};
    if (typeof outcome === "object") {
      // The call itself, never inside a transaction. Read connectors only, so a retry is harmless.
      const plan = outcome;
      const run = await tenant(
        connect,
        w,
        async (db) =>
          (await db.query<{ workflow_id: string; conversation_id: string }>("SELECT workflow_id,conversation_id FROM workflow_runs WHERE workspace_id=$1 AND id=$2", [w, runId]))
            .rows[0],
      );
      const result = await runConnector(connect, env.connectors!, w, {
        connectorId: plan.connectorId,
        version: plan.version,
        values: plan.values,
        source: "workflow",
        invokedBy: "workflow:" + run.workflow_id,
        conversationId: run.conversation_id,
      });
      called = { plan, result };
      continue;
    }
    if (outcome === "stop") break;
  }
  return { status: "done" };
}

/** W3: a collected email address, added to the customer's addresses (unverified). */
async function keepEmail(db: Sql, w: string, c: Conversation, email: string) {
  const contactId = (
    await db.query<{ contact_id: string }>("SELECT contact_id FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2", [w, c.primary_identity_id])
  ).rows[0]?.contact_id;
  if (!contactId) throw new DomainError("CONTACT_NOT_FOUND", "This conversation has no customer record.", 404);
  await db.query("INSERT INTO contact_emails(workspace_id,contact_id,email,verified) VALUES($1,$2,$3,false) ON CONFLICT DO NOTHING", [w, contactId, email]);
}

/** A customer attribute, set as the workflow (and recorded for teammates, firing its trigger). */
async function setContactAttribute(db: Sql, w: string, run: RunRow, c: Conversation, keyName: string, value: unknown) {
  if (!/^[A-Za-z0-9_.-]{1,60}$/.test(keyName)) throw new DomainError("INVALID_ATTRIBUTE", "That customer attribute's name isn't valid.", 400);
  const contactId = (
    await db.query<{ contact_id: string }>("SELECT contact_id FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2", [w, c.primary_identity_id])
  ).rows[0]?.contact_id;
  if (!contactId) throw new DomainError("CONTACT_NOT_FOUND", "This conversation has no customer record.", 404);
  const v = value === undefined ? null : value;
  await db.query("UPDATE contacts SET profile=jsonb_set(profile,ARRAY[$3],$4::jsonb,true),version=version+1 WHERE workspace_id=$1 AND id=$2", [
    w,
    contactId,
    keyName,
    JSON.stringify(v),
  ]);
  const { append } = await import("./conversations");
  await append(
    db,
    w,
    c,
    { type: "system", id: "workflow:" + run.workflow_id, name: run.name, runId: run.id } as never,
    "system_event",
    "",
    { event: "contact_attribute_change", key: keyName, after: v },
    "internal",
  );
}

/** The expected reply time's words in English (the messenger shows the customer's language). */
const REPLY_BANDS: Record<string, string> = {
  few_minutes: "We usually reply in a few minutes.",
  under_an_hour: "We usually reply in under an hour.",
  few_hours: "We usually reply in a few hours.",
  about_a_day: "We usually reply in about a day.",
};

/** One action, through `command` as the workflow (idempotent per run and step). */
async function act(
  db: Sql,
  w: string,
  run: RunRow,
  c: Conversation,
  step: Step,
  path: Path,
): Promise<{ label: string; result: string; detail?: unknown; wait?: { state: WaitState; until: string | null } }> {
  const o = step.options;
  const actor = { type: "workflow" as const, workflowId: run.workflow_id, runId: run.id, name: run.name };
  const key = `wf:${run.id}:${run.nodes}`;
  const cmd = (p: Record<string, unknown>) => command(db, w, actor, key, { conversationId: c.id, ...p } as never);
  switch (step.type) {
    case "tag_add":
    case "tag_remove":
      await cmd({ action: step.type, tagId: o.tagId });
      return { label: step.type === "tag_add" ? "Added a tag" : "Removed a tag", result: "ok" };
    case "assign": {
      const teamId = typeof o.teamId === "string" && o.teamId ? o.teamId : undefined;
      const teammateId = typeof o.teammateId === "string" && o.teammateId ? o.teammateId : undefined;
      await cmd({ action: "assign", teamId, teammateId });
      const after = (await db.query<{ assigned: string; team_id: string | null }>("SELECT assigned,team_id FROM conversations WHERE workspace_id=$1 AND id=$2", [w, c.id]))
        .rows[0];
      return {
        label: teammateId ? "Assigned to a teammate" : teamId ? "Assigned to a team (routed by its method)" : "Unassigned",
        result: "ok",
        detail: { teammate: after.assigned || null, team: after.team_id },
      };
    }
    case "priority":
      await cmd({ action: "priority", value: o.value === true });
      return { label: o.value ? "Set priority" : "Removed priority", result: "ok" };
    case "snooze": {
      const until = new Date(Date.now() + Number(o.seconds) * 1000).toISOString();
      await cmd({ action: "snooze", wakeAt: until, timezone: "UTC" });
      return { label: "Snoozed", result: "ok", detail: { until } };
    }
    case "close":
      if (c.status === "closed") return { label: "Close", result: "already closed" };
      await cmd({ action: "close" });
      return { label: "Closed", result: "ok" };
    case "reopen":
      if (c.status === "open") return { label: "Reopen", result: "already open" };
      await cmd({ action: "reopen" });
      return { label: "Reopened", result: "ok" };
    case "attribute_set":
      await cmd({ action: "attribute_set", attributeId: o.attributeId, value: o.value ?? null });
      return { label: "Set a conversation attribute", result: "ok" };
    case "note":
      await cmd({ action: "note", text: String(o.text) });
      return { label: "Added an internal note", result: "ok" };
    case "ticket_create":
      await cmd({ action: "ticket", typeId: o.typeId, title: typeof o.title === "string" ? o.title : undefined });
      return { label: "Created a ticket", result: "ok" };
    case "sla_apply":
    case "sla_clear": {
      const policy = step.type === "sla_clear" ? null : String(o.policyId);
      if (policy && policy !== "none") {
        const exists = (await db.query("SELECT 1 FROM sla_policies WHERE workspace_id=$1 AND id=$2", [w, policy])).rows.length;
        if (!exists) throw new DomainError("SLA_NOT_FOUND", "That SLA policy isn't available.", 404);
      }
      await db.query("UPDATE conversations SET sla_forced=$3 WHERE workspace_id=$1 AND id=$2", [w, c.id, policy]);
      await syncSla(db, w, c.id);
      return { label: policy ? (policy === "none" ? "Applied no SLA" : "Applied an SLA") : "Cleared the applied SLA", result: "ok", detail: { policy } };
    }
    case "contact_attribute_set": {
      const keyName = String(o.key);
      const value = o.value === undefined ? null : o.value;
      await setContactAttribute(db, w, run, c, keyName, value);
      return { label: "Set a customer attribute", result: "ok", detail: { key: keyName, value } };
    }
    case "ai_handover": {
      if (!(await aiEnabled(db, w))) return { label: "Hand to Zoe", result: "Zoe is off: nothing to hand to" };
      const last = (
        await db.query<{ id: string }>(
          `SELECT p.id FROM conversation_parts p WHERE p.workspace_id=$1 AND p.conversation_id=$2 AND p.kind='customer_message'
             AND NOT EXISTS(SELECT 1 FROM ai_answers a WHERE a.workspace_id=p.workspace_id AND a.question_part_id=p.id)
           ORDER BY p.seq DESC LIMIT 1`,
          [w, c.id],
        )
      ).rows[0];
      const queued = last ? await queueAiReply(db, w, c, last.id) : null;
      return {
        label: "Handed to Zoe",
        result: queued ? "ok" : "nothing for Zoe to answer",
        detail: { question: last?.id ?? null },
      };
    }
    case "human_handover": {
      const teamId = typeof o.teamId === "string" && o.teamId ? o.teamId : c.team_id ?? undefined;
      if (teamId) await cmd({ action: "assign", teamId, teammateId: undefined });
      await db.query(
        "UPDATE conversations SET ai_state='escalated' WHERE workspace_id=$1 AND id=$2 AND ai_state IN ('pending','needs_input')",
        [w, c.id],
      );
      return { label: "Handed to the team", result: "ok", detail: { team: teamId ?? null } };
    }
    case "message": {
      const sent = (await cmd({ action: "reply", text: String(o.text) })) as { partId: string };
      return { label: "Sent a message", result: "ok", detail: { part: sent.partId } };
    }
    case "reply_time": {
      // The customer's messenger says it in their language, from `replyTime` and `availability`.
      const hours = await availabilityFor(db, w, { brandId: c.brand_id, teamId: c.team_id }, "en");
      const replyTime = await expectedReply(db, w, c.brand_id);
      const text =
        !hours || hours.open
          ? replyTime
            ? "text" in replyTime
              ? replyTime.text
              : (REPLY_BANDS[replyTime.band] ?? "We'll reply as soon as we can.")
            : "We'll reply as soon as we can."
          : `We're away right now.${hours.nextOpenLabel ? ` We'll reply from ${hours.nextOpenLabel}.` : ""}`;
      const sent = (await cmd({
        action: "reply",
        text,
        workflowData: { replyTime, availability: hours ? { open: hours.open, nextOpenLabel: hours.nextOpenLabel ?? null } : null },
      })) as { partId: string };
      return { label: "Showed the expected reply time", result: "ok", detail: { part: sent.partId, text } };
    }
    case "collect": {
      const asked = (await cmd({ action: "reply", text: String(o.text) })) as { partId: string };
      const until = new Date(Date.now() + Number(o.timeoutSeconds ?? 86_400) * 1000).toISOString();
      return {
        label: "Asked for a reply to collect",
        result: "waiting",
        detail: { part: asked.partId, until },
        wait: { state: { kind: "reply", mode: "collect", partId: asked.partId, attempt: 1 }, until },
      };
    }
    case "wait": {
      const until = new Date(Date.now() + Number(o.seconds) * 1000).toISOString();
      return { label: `Wait ${Math.round(Number(o.seconds) / 60)} minutes`, result: "waiting", detail: { until }, wait: { state: { kind: "duration" }, until } };
    }
    case "wait_office_hours": {
      const hours = await availabilityFor(db, w, { brandId: c.brand_id, teamId: c.team_id }, "en");
      if (!hours || hours.open || !hours.nextOpenAt) return { label: "Wait until office hours", result: "open now" };
      return {
        label: "Wait until office hours",
        result: "waiting",
        detail: { until: hours.nextOpenAt },
        wait: { state: { kind: "office_hours" }, until: hours.nextOpenAt },
      };
    }
  }
  void path;
  throw new DomainError("WORKFLOW_STEP", `A ${step.type} step can't run yet.`, 400);
}

/* ------------------------------------------------------------------------------------------ */
/* Resuming                                                                                    */

/**
 * The `workflow.resume` job: a waiting run that's due (its time passed), or whose conversation
 * changed while it waits for a condition.
 */
export async function resumeWorkflow(connect: Connect, job: Job, env: WorkflowEnvironment = {}) {
  const w = job.workspace_id;
  const p = job.payload as { runId: string; check?: boolean; due?: boolean; reply?: string };
  const go = await tenant(connect, w, async (db) => {
    const run = (
      await db.query<{ status: string; wait: WaitState | null; due: boolean; wait_until: string | null }>(
        "SELECT status,wait,wait_until<=now() AS due,wait_until FROM workflow_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [w, p.runId],
      )
    ).rows[0];
    if (!run || !run.wait || (run.status !== "waiting" && !(run.status === "running" && p.due))) return null;
    // A change re-checks a condition wait or Zoe's outcome; an answer resumes a run waiting for
    // one; time waits resume when they're due.
    if (p.check && run.wait.kind !== "condition" && run.wait.kind !== "zoe") return null;
    if (p.reply && run.wait.kind !== "reply") return null;
    const timedOut = !p.reply && run.due && (run.wait.kind === "condition" || run.wait.kind === "reply" || run.wait.kind === "zoe");
    await db.query("UPDATE workflow_runs SET status='running',wait=NULL,wait_until=NULL,version=version+1 WHERE workspace_id=$1 AND id=$2", [w, p.runId]);
    return {
      timedOut,
      deadline: run.due ? null : run.wait_until ? new Date(run.wait_until).toISOString() : null,
      wait: run.wait.kind === "reply" || run.wait.kind === "zoe" ? run.wait : null,
      reply: p.reply ?? null,
    };
  });
  if (!go) return { done: true, result: { skipped: true } };
  await runWorkflow(connect, w, p.runId, go, env);
  return { done: true, result: { resumed: true } };
}

/** The sweep: runs whose wait is over are claimed (once) and resumed. */
export async function resumeDueWorkflows(connect: Connect, w: string) {
  return tenant(connect, w, async (db) => {
    if (!(await workflowsEnabled(db, w))) return 0;
    const due = (
      await db.query<{ id: string }>(
        `UPDATE workflow_runs SET status='running',version=version+1 WHERE workspace_id=$1 AND id IN (
           SELECT id FROM workflow_runs WHERE workspace_id=$1 AND status='waiting' AND wait_until<=now() ORDER BY wait_until LIMIT 100)
         RETURNING id`,
        [w],
      )
    ).rows;
    for (const r of due) await enqueueJob(db, w, "workflow.resume", { runId: r.id, due: true }, {});
    return due.length;
  });
}
