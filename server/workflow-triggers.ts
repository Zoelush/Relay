import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import { workflowsEnabled } from "./workflow-engine";
import type { Definition, TriggerOptions } from "../lib/workflow-definition";

/**
 * Triggers from outside the timeline (phase 11, step W4; docs/WORKFLOWS_STEP4.md):
 *
 * - **Time:** a schedule, a customer who hasn't replied, an SLA about to be breached. The sweep
 *   checks once a minute per workspace (`checkTimedWorkflows`) and, when a live workflow uses
 *   one, queues `workflow.timed`, which finds the conversations due and queues their starts. Each
 *   occurrence fires a workflow once per conversation (`trigger_key`: the scheduled time, the
 *   message not answered, the SLA target).
 * - **Browsing:** the messenger reports the page the customer opens (`pageVisited`); a live
 *   workflow fires for their conversation that isn't closed, once per page.
 * - **A webhook:** another system calls the workflow's own address with its secret and an
 *   idempotency key (`receiveWebhook`), naming a conversation or a customer.
 */
const TIMED = ["schedule", "unresponsive", "sla_before_breach"] as const;
/** At most this many conversations per workflow per check. */
export const TIMED_BATCH = 500;

/* ------------------------------------------------------------------------------------------ */
/* Schedules                                                                                   */

/** A time zone's wall clock at an instant. */
function wall(at: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour),
    min: Number(parts.minute),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
  };
}
/** The instant a wall-clock time has in a time zone (the later one across a clock change). */
function instant(y: number, m: number, d: number, h: number, min: number, timeZone: string) {
  let guess = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) {
    const seen = wall(guess, timeZone);
    guess += Date.UTC(y, m - 1, d, h, min) - Date.UTC(seen.y, seen.m - 1, seen.d, seen.h, seen.min);
  }
  return guess;
}
/** A schedule's next time after `after` (milliseconds). */
export function nextOccurrence(after: number, o: TriggerOptions): number {
  const tz = o.timezone ?? "UTC";
  const [hh, mm] = (o.at ?? "09:00").split(":").map(Number);
  if (o.every === "hour") {
    const t = new Date(after);
    t.setUTCSeconds(0, 0);
    t.setUTCMinutes(mm);
    let next = t.getTime();
    while (next <= after) next += 3_600_000;
    return next;
  }
  const today = wall(after, tz);
  for (let i = 0; i < 9; i++) {
    const base = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const at = instant(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hh, mm, tz);
    if (at <= after) continue;
    const day = wall(at, tz).weekday;
    if (o.every === "weekdays" && (day === 0 || day === 6)) continue;
    if (o.every === "week" && day !== (o.weekday ?? 1)) continue;
    return at;
  }
  throw new Error("No next occurrence within a week");
}

/* ------------------------------------------------------------------------------------------ */
/* The sweep and the job                                                                       */

/** The sweep, each pass: once a minute, queue the timed check when a live workflow needs one. */
export async function checkTimedWorkflows(connect: Connect, w: string, now = Date.now()) {
  return tenant(connect, w, async (db) => {
    if (!(await workflowsEnabled(db, w))) return false;
    const minute = new Date(Math.floor(now / 60_000) * 60_000).toISOString();
    const fresh = (await db.query("INSERT INTO workflow_ticks(workspace_id,minute) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING minute", [w, minute])).rows.length;
    await db.query("DELETE FROM workflow_ticks WHERE workspace_id=$1 AND minute<$2", [w, new Date(now - 3_600_000).toISOString()]);
    if (!fresh) return false;
    const any = (
      await db.query("SELECT 1 FROM workflows WHERE workspace_id=$1 AND state='live' AND NOT archived AND trigger=ANY($2::text[]) LIMIT 1", [w, [...TIMED]])
    ).rows.length;
    if (any) await enqueueJob(db, w, "workflow.timed", { at: minute }, {});
    return any > 0;
  });
}

/** The `workflow.timed` job: each live timed workflow's due conversations, each queued to start. */
export async function runTimedWorkflows(connect: Connect, job: Job) {
  const w = job.workspace_id;
  // As of the minute the sweep checked (so a late job judges the same moment).
  const at = Date.parse(String((job.payload as { at?: string }).at ?? ""));
  const now = Number.isNaN(at) ? Date.now() : at;
  const queued = await tenant(connect, w, async (db) => {
    if (!(await workflowsEnabled(db, w))) return 0;
    const live = (
      await db.query<{ id: string; trigger: string; definition: Definition; schedule_next_at: string | null }>(
        `SELECT w.id,w.trigger,v.definition,w.schedule_next_at FROM workflows w
         JOIN workflow_versions v ON v.workspace_id=w.workspace_id AND v.workflow_id=w.id AND v.version=w.live_version
         WHERE w.workspace_id=$1 AND w.state='live' AND NOT w.archived AND w.trigger=ANY($2::text[])`,
        [w, [...TIMED]],
      )
    ).rows;
    let n = 0;
    const start = async (wf: { id: string; trigger: string }, conversationId: string, key: string, partId: string | null = null) => {
      await enqueueJob(
        db,
        w,
        "workflow.start",
        { conversationId, trigger: wf.trigger, options: {}, partId, source: "system", causedBy: null, workflowId: wf.id, key },
        {},
      );
      n++;
    };
    for (const wf of live) {
      const o = wf.definition.trigger.options;
      if (wf.trigger === "schedule") {
        // The first check only sets the next time; a due one moves it on and runs.
        const due = wf.schedule_next_at ? new Date(wf.schedule_next_at).getTime() : null;
        if (due === null || due <= now)
          await db.query("UPDATE workflows SET schedule_next_at=$3 WHERE workspace_id=$1 AND id=$2", [w, wf.id, new Date(nextOccurrence(now, o)).toISOString()]);
        if (due === null || due > now) continue;
        const rows = (
          await db.query<{ id: string }>(
            `SELECT id FROM conversations WHERE workspace_id=$1 AND status<>'closed' AND visibility='customer' AND merged_into_id IS NULL
             ORDER BY updated_at,id LIMIT $2`,
            [w, TIMED_BATCH],
          )
        ).rows;
        for (const r of rows) await start(wf, r.id, `schedule:${new Date(due).toISOString()}`);
      } else if (wf.trigger === "unresponsive") {
        // The team's (or Zoe's, or a workflow's) last message, unanswered for long enough.
        const rows = (
          await db.query<{ id: string; part: string }>(
            `SELECT c.id,lp.id AS part FROM conversations c
             JOIN LATERAL (SELECT p.id,p.kind,p.created_at FROM conversation_parts p
               WHERE p.workspace_id=c.workspace_id AND p.conversation_id=c.id AND p.audience='public'
                 AND p.kind IN ('customer_message','teammate_reply','ai_reply','workflow_message')
               ORDER BY p.seq DESC LIMIT 1) lp ON true
             WHERE c.workspace_id=$1 AND c.status='open' AND c.visibility='customer' AND c.merged_into_id IS NULL
               AND lp.kind<>'customer_message' AND lp.created_at<=$2 AND lp.created_at>$3
               AND NOT EXISTS(SELECT 1 FROM workflow_runs r WHERE r.workspace_id=c.workspace_id AND r.workflow_id=$4 AND r.conversation_id=c.id
                 AND r.trigger_key='unresponsive:'||lp.id)
             ORDER BY lp.created_at LIMIT $5`,
            [w, new Date(now - (o.minutes ?? 60) * 60_000).toISOString(), new Date(now - 30 * 86_400_000).toISOString(), wf.id, TIMED_BATCH],
          )
        ).rows;
        for (const r of rows) await start(wf, r.id, `unresponsive:${r.part}`, r.part);
      } else {
        // An SLA target due within the time set (and not yet breached).
        const rows = (
          await db.query<{ id: string; due: string }>(
            `SELECT c.id,c.sla_next_due_at AS due FROM conversations c
             WHERE c.workspace_id=$1 AND c.sla_next_due_at IS NOT NULL AND c.sla_next_due_at>$2 AND c.sla_next_due_at<=$3
               AND NOT c.sla_breached AND c.status<>'closed' AND c.merged_into_id IS NULL
             ORDER BY c.sla_next_due_at LIMIT $4`,
            [w, new Date(now).toISOString(), new Date(now + (o.minutes ?? 30) * 60_000).toISOString(), TIMED_BATCH],
          )
        ).rows;
        for (const r of rows) await start(wf, r.id, `sla:${new Date(r.due).toISOString()}`);
      }
    }
    return n;
  });
  return { done: true, result: { queued } };
}

/* ------------------------------------------------------------------------------------------ */
/* Browsing                                                                                    */

/** The messenger reported a page: live page-visit workflows fire for the customer's open conversation. */
export async function pageVisited(db: Sql, w: string, s: { identityId: string; brandId: string }, url: string | null) {
  if (!url || !(await workflowsEnabled(db, w))) return;
  const listening = (await db.query("SELECT 1 FROM workflows WHERE workspace_id=$1 AND state='live' AND NOT archived AND trigger='page_visit' LIMIT 1", [w])).rows.length;
  if (!listening) return;
  // TODO(phase 13): a visit without a conversation starts one (proactive messages, outbound).
  const c = (
    await db.query<{ id: string }>(
      `SELECT id FROM conversations WHERE workspace_id=$1 AND primary_identity_id=$2 AND brand_id=$3 AND status<>'closed'
         AND visibility='customer' AND merged_into_id IS NULL ORDER BY updated_at DESC LIMIT 1`,
      [w, s.identityId, s.brandId],
    )
  ).rows[0];
  if (!c) return;
  await enqueueJob(
    db,
    w,
    "workflow.start",
    { conversationId: c.id, trigger: "page_visit", options: { url }, partId: null, source: "customer", causedBy: null, key: `page:${url.slice(0, 300)}`, data: { url } },
    {},
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Webhooks                                                                                    */

export const HOOKS_PER_MINUTE = 60;
const hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const equal = (a: string, b: string) => a.length === b.length && [...a].reduce((x, ch, i) => x | (ch.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
/** A new secret for a workflow's webhook: only its hash is kept; the secret is shown once. */
export async function newHookSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = "whk_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { secret, hash: await hex(secret) };
}

/** Flat, small data from the caller: strings, numbers and booleans, for conditions on it. */
function hookData(raw: unknown) {
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw).slice(0, 50))
    if (/^[A-Za-z0-9_.-]{1,60}$/.test(k) && (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 500))) out[k] = v;
  return out;
}

/**
 * A call to a workflow's webhook (`POST /v1/hooks/<workspace>/workflows/<id>`), with its secret as
 * a bearer token and an `Idempotency-Key` (a retry answers the same, starting nothing new). The
 * body names `conversationId`, or a customer by `userId` (their user ID) or `email`, whose latest
 * conversation that isn't closed is used; `data` is kept for the run's conditions.
 */
export async function receiveWebhook(db: Sql, w: string, workflowId: string, secret: string, key: string, body: Record<string, unknown>) {
  assert(key && key.length <= 200, "IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header, the same on every retry.", 400);
  const wf = (
    await db.query<{ hook_secret_hash: string | null; state: string; trigger: string }>(
      "SELECT hook_secret_hash,state,trigger FROM workflows WHERE workspace_id=$1 AND id=$2 AND NOT archived",
      [w, workflowId],
    )
  ).rows[0];
  // One answer for every way a call isn't accepted, so the address and secret can't be probed.
  const refused = () => new DomainError("HOOK_REFUSED", "This webhook doesn't accept the call.", 401);
  if (!wf?.hook_secret_hash || !(await workflowsEnabled(db, w)) || !equal(await hex(secret), wf.hook_secret_hash)) throw refused();
  assert(wf.state === "live" && wf.trigger === "webhook", "WORKFLOW_NOT_LIVE", "The workflow isn't live with its webhook trigger.", 409);
  return once(db, w, "hook:" + workflowId, key, body, async () => {
    const recent = (
      await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM workflow_runs WHERE workspace_id=$1 AND workflow_id=$2 AND started_at>now()-interval '1 minute'",
        [w, workflowId],
      )
    ).rows[0].n;
    assert(recent < HOOKS_PER_MINUTE, "RATE_LIMITED", `At most ${HOOKS_PER_MINUTE} calls a minute.`, 429);
    let conversationId: string | null = null;
    if (typeof body.conversationId === "string")
      conversationId =
        (
          await db.query<{ id: string }>("SELECT id FROM conversations WHERE workspace_id=$1 AND id=$2 AND visibility='customer' AND merged_into_id IS NULL", [
            w,
            body.conversationId,
          ])
        ).rows[0]?.id ?? null;
    else if (typeof body.userId === "string" || typeof body.email === "string")
      conversationId =
        (
          await db.query<{ id: string }>(
            `SELECT c.id FROM conversations c
             JOIN identity_contact_mappings m ON m.workspace_id=c.workspace_id AND m.identity_id=c.primary_identity_id
             JOIN contacts k ON k.workspace_id=m.workspace_id AND k.id=m.contact_id
             WHERE c.workspace_id=$1 AND c.status<>'closed' AND c.visibility='customer' AND c.merged_into_id IS NULL
               AND (k.external_id=$2 OR EXISTS(SELECT 1 FROM contact_emails e WHERE e.workspace_id=k.workspace_id AND e.contact_id=k.id AND lower(e.email)=lower($3)))
             ORDER BY c.updated_at DESC LIMIT 1`,
            [w, typeof body.userId === "string" ? body.userId : null, typeof body.email === "string" ? body.email : null],
          )
        ).rows[0]?.id ?? null;
    else throw new DomainError("INVALID_HOOK", "Name the conversation (conversationId), or the customer (userId or email).", 400);
    assert(conversationId, "CONVERSATION_NOT_FOUND", "No conversation (that isn't closed) matches.", 404);
    await enqueueJob(
      db,
      w,
      "workflow.start",
      { conversationId, trigger: "webhook", options: {}, partId: null, source: "system", causedBy: null, workflowId, key: "hook:" + key, data: hookData(body.data) },
      {},
    );
    return { queued: true, conversationId };
  });
}
