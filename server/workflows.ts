import { assert, DomainError, once, type Sql } from "./db";
import { authorize } from "./policy";
import { startManual, workflowsEnabled } from "./workflow-engine";
import {
  LATER_TRIGGERS,
  TRIGGERS,
  blankDefinition,
  customerFacing,
  DefinitionError,
  problems,
  validate,
  type Definition,
  type Group,
  type Trigger,
} from "../lib/workflow-definition";

/**
 * Workflows' API (phase 11, step W1; docs/WORKFLOWS_STEP1.md), behind `workflows_v1`, for those who
 * manage the workspace: a draft is saved in any state, published only when it has no problems
 * (graph and references), and every publish is an immutable version; rollback publishes an older
 * version again as the next one. Within a trigger, priority decides which customer-facing
 * workflow runs. The run log is read here too. The builder arrives in W2.
 */
async function access(db: Sql, w: string, principal: string) {
  const t = await authorize(db, w, principal, "workspace.manage");
  assert(await workflowsEnabled(db, w), "WORKFLOWS_DISABLED", "Workflows are not enabled for this workspace.", 404);
  return t;
}
const invalid = (message: string): never => {
  throw new DomainError("INVALID_WORKFLOW", message, 400);
};

type Row = {
  id: string;
  name: string;
  trigger: Trigger;
  priority: number;
  state: "draft" | "live" | "paused";
  draft: Definition;
  live_version: number | null;
  live: Definition | null;
  version: string;
  updated_at: string;
  updated_name: string | null;
};
const ROW = `w.id,w.name,w.trigger,w.priority,w.state,w.draft,w.live_version,w.version::text AS version,w.updated_at,
  (SELECT t.name FROM teammates t WHERE t.workspace_id=w.workspace_id AND t.id=w.updated_by) AS updated_name,
  (SELECT v.definition FROM workflow_versions v WHERE v.workspace_id=w.workspace_id AND v.workflow_id=w.id AND v.version=w.live_version) AS live
  FROM workflows w`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What a definition names that doesn't exist in this workspace: each a problem for publishing. */
async function references(db: Sql, w: string, def: Definition) {
  const out: string[] = [];
  const ids = async (sql: string) => new Set((await db.query<{ id: string }>(sql, [w])).rows.map((r) => r.id));
  const tags = await ids("SELECT id FROM tags WHERE workspace_id=$1 AND archived_at IS NULL");
  const teams = await ids("SELECT id FROM teams WHERE workspace_id=$1");
  const teammates = await ids("SELECT id FROM teammates WHERE workspace_id=$1");
  const brands = await ids("SELECT id FROM brands WHERE workspace_id=$1");
  const attributes = await ids("SELECT id FROM attribute_definitions WHERE workspace_id=$1 AND owner_type='conversation' AND archived_at IS NULL");
  const policies = await ids("SELECT id FROM sla_policies WHERE workspace_id=$1");
  const types = await ids("SELECT id FROM ticket_types WHERE workspace_id=$1");
  const o = def.trigger.options;
  if (o.tagId && !tags.has(o.tagId)) out.push("The trigger's tag doesn't exist (or is archived).");
  if (o.attributeId && !attributes.has(o.attributeId)) out.push("The trigger's attribute doesn't exist.");
  const conditions = (g: Group, where: string) => {
    for (const x of g.items) {
      if ("items" in x) conditions(x, where);
      else if (x.field === "conversation.tag" && !tags.has(String(x.value))) out.push(`${where}: a tag condition names a tag that doesn't exist.`);
      else if (x.field === "conversation.team" && x.value && !teams.has(String(x.value))) out.push(`${where}: a team condition names a team that doesn't exist.`);
      else if (x.field === "team.available" && !teams.has(String(x.key))) out.push(`${where}: a team condition names a team that doesn't exist.`);
      else if (x.field === "conversation.assignee" && x.value && !teammates.has(String(x.value))) out.push(`${where}: a condition names a teammate who doesn't exist.`);
      else if (x.field === "conversation.brand" && !brands.has(String(x.value))) out.push(`${where}: a brand condition names a brand that doesn't exist.`);
      else if (x.field === "conversation.attribute" && !attributes.has(String(x.key))) out.push(`${where}: a condition names an attribute that doesn't exist.`);
    }
  };
  conditions(def.when, "Who it runs for");
  for (const p of def.paths) {
    if (p.next.type === "branch") p.next.branches.forEach((b) => conditions(b.when, `Path ${p.id}, branch “${b.label}”`));
    if (p.next.type === "wait_until") conditions(p.next.when, `Path ${p.id}, wait`);
    p.steps.forEach((s, i) => {
      const where = `Path ${p.id}, step ${i + 1}`;
      const v = (k: string) => (typeof s.options[k] === "string" ? (s.options[k] as string) : "");
      if ((s.type === "tag_add" || s.type === "tag_remove") && !tags.has(v("tagId"))) out.push(`${where}: its tag doesn't exist (or is archived).`);
      if ((s.type === "assign" || s.type === "human_handover") && v("teamId") && !teams.has(v("teamId"))) out.push(`${where}: its team doesn't exist.`);
      if (s.type === "assign" && v("teammateId") && !teammates.has(v("teammateId"))) out.push(`${where}: its teammate doesn't exist.`);
      if (s.type === "attribute_set" && !attributes.has(v("attributeId"))) out.push(`${where}: its attribute doesn't exist.`);
      if (s.type === "sla_apply" && v("policyId") !== "none" && !policies.has(v("policyId"))) out.push(`${where}: its SLA policy doesn't exist.`);
      if (s.type === "ticket_create" && !types.has(v("typeId"))) out.push(`${where}: its ticket type doesn't exist.`);
    });
  }
  return out;
}

/** The list, grouped by trigger in priority order, with each workflow's runs in the last 30 days. */
export async function readWorkflows(db: Sql, w: string, principal: string) {
  await access(db, w, principal);
  const rows = (await db.query<Row>(`SELECT ${ROW} WHERE w.workspace_id=$1 AND NOT w.archived ORDER BY w.trigger,w.priority,w.created_at,w.id`, [w])).rows;
  const counts = new Map(
    (
      await db.query<{ workflow_id: string; completed: number; failed: number; skipped: number; active: number; last: string | null }>(
        `SELECT workflow_id,count(*) FILTER (WHERE status='completed')::int AS completed,count(*) FILTER (WHERE status='failed')::int AS failed,
           count(*) FILTER (WHERE status='skipped')::int AS skipped,count(*) FILTER (WHERE status IN ('running','waiting'))::int AS active,max(started_at) AS last
         FROM workflow_runs WHERE workspace_id=$1 AND started_at>now()-interval '30 days' GROUP BY workflow_id`,
        [w],
      )
    ).rows.map((r) => [r.workflow_id, r]),
  );
  const view = (r: Row) => {
    const n = counts.get(r.id);
    return {
      id: r.id,
      name: r.name,
      state: r.state,
      priority: r.priority,
      liveVersion: r.live_version,
      changed: !r.live || !same(r.draft, r.live),
      customerFacing: customerFacing(r.live ?? r.draft),
      updatedAt: new Date(r.updated_at).toISOString(),
      updatedBy: r.updated_name,
      runs: { completed: n?.completed ?? 0, failed: n?.failed ?? 0, skipped: n?.skipped ?? 0, active: n?.active ?? 0, last: n?.last ? new Date(n.last).toISOString() : null },
    };
  };
  return {
    triggers: (Object.keys(TRIGGERS) as Trigger[]).map((t) => ({
      trigger: t,
      label: TRIGGERS[t].label,
      customer: TRIGGERS[t].customer,
      firedBy: TRIGGERS[t].firedBy,
      workflows: rows.filter((r) => r.trigger === t).map(view),
    })),
    later: LATER_TRIGGERS,
  };
}

/** One workflow: its draft, what blocks publishing it, and its versions. */
export async function readWorkflow(db: Sql, w: string, principal: string, id: string) {
  await access(db, w, principal);
  const r = (await db.query<Row>(`SELECT ${ROW} WHERE w.workspace_id=$1 AND w.id=$2 AND NOT w.archived`, [w, id])).rows[0];
  assert(r, "WORKFLOW_NOT_FOUND", "That workflow isn't available.", 404);
  const versions = (
    await db.query<{ version: number; published_at: string; name: string | null; restored_from: number | null }>(
      `SELECT v.version,v.published_at,v.restored_from,t.name FROM workflow_versions v LEFT JOIN teammates t ON t.workspace_id=v.workspace_id AND t.id=v.published_by
       WHERE v.workspace_id=$1 AND v.workflow_id=$2 ORDER BY v.version DESC LIMIT 50`,
      [w, id],
    )
  ).rows.map((v) => ({ version: v.version, publishedAt: new Date(v.published_at).toISOString(), by: v.name, restoredFrom: v.restored_from }));
  return {
    workflow: {
      id: r.id,
      name: r.name,
      state: r.state,
      priority: r.priority,
      version: r.version,
      definition: r.draft,
      liveVersion: r.live_version,
      changed: !r.live || !same(r.draft, r.live),
      problems: [...problems(r.draft), ...(await references(db, w, r.draft))],
    },
    versions,
  };
}

/**
 * One change, idempotent by key: `create`, `save` (by version), `publish`, `pause`, `resume`,
 * `rollback` (an older version published again), `archive`, or `reorder` a trigger's workflows.
 */
export async function changeWorkflow(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>) {
  const t = await access(db, w, principal);
  return once(db, w, "workflow:" + principal, key, p, async () => {
    const nameOf = (v: unknown) => {
      const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
      if (!s || s.length > 80 || /[\x00-\x1f]/.test(s)) invalid("Name the workflow, in up to 80 characters.");
      return s;
    };
    const taken = async (name: string, except = "") =>
      (await db.query("SELECT 1 FROM workflows WHERE workspace_id=$1 AND lower(name)=lower($2) AND NOT archived AND id<>$3", [w, name, except])).rows.length > 0;
    const def = (raw: unknown) => {
      try {
        return validate(raw);
      } catch (e) {
        if (e instanceof DefinitionError) return invalid(e.message);
        throw e;
      }
    };
    if (p.action === "reorder") {
      const trigger = String(p.trigger ?? "");
      const ids = Array.isArray(p.ids) ? p.ids.map(String) : [];
      const current = (await db.query<{ id: string }>("SELECT id FROM workflows WHERE workspace_id=$1 AND trigger=$2 AND NOT archived", [w, trigger])).rows.map(
        (r) => r.id,
      );
      if (ids.length !== current.length || !current.every((id) => ids.includes(id))) invalid("Give every workflow for this trigger, in order.");
      for (const [i, id] of ids.entries())
        await db.query("UPDATE workflows SET priority=$3,version=version+1,updated_by=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, id, i, t.id]);
      return readWorkflows(db, w, principal);
    }
    if (p.action === "create") {
      const name = nameOf(p.name);
      if (await taken(name)) invalid(`There's already a workflow called ${name}.`);
      const trigger = String(p.trigger ?? "first_message");
      const draft = def(p.definition ?? blankDefinition(trigger as Trigger));
      const id = crypto.randomUUID();
      const last = (await db.query<{ n: number | null }>("SELECT max(priority) AS n FROM workflows WHERE workspace_id=$1 AND trigger=$2 AND NOT archived", [w, draft.trigger.type]))
        .rows[0].n;
      await db.query(
        "INSERT INTO workflows(workspace_id,id,name,trigger,priority,draft,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$7)",
        [w, id, name, draft.trigger.type, (last ?? -1) + 1, JSON.stringify(draft), t.id],
      );
      return readWorkflow(db, w, principal, id);
    }
    const id = String(p.id ?? "");
    const row = (
      await db.query<{ version: string; draft: Definition; state: string; live_version: number | null; trigger: string }>(
        "SELECT version::text AS version,draft,state,live_version,trigger FROM workflows WHERE workspace_id=$1 AND id=$2 AND NOT archived",
        [w, id],
      )
    ).rows[0];
    assert(row, "WORKFLOW_NOT_FOUND", "That workflow isn't available.", 404);
    if (String(p.version ?? "") !== row.version) throw new DomainError("WORKFLOW_CHANGED", "Someone else changed this workflow. Reload to see it.", 409);
    const touch = "version=version+1,updated_by=$3,updated_at=now()";
    const publish = async (definition: Definition, restoredFrom: number | null) => {
      const blockers = [...problems(definition), ...(await references(db, w, definition))];
      if (blockers.length) throw new DomainError("WORKFLOW_INVALID", `It can't be published yet: ${blockers[0]}`, 400, { problems: blockers });
      const version =
        ((await db.query<{ v: number | null }>("SELECT max(version) AS v FROM workflow_versions WHERE workspace_id=$1 AND workflow_id=$2", [w, id])).rows[0].v ?? 0) + 1;
      await db.query(
        "INSERT INTO workflow_versions(workspace_id,workflow_id,version,definition,restored_from,published_by) VALUES($1,$2,$3,$4,$5,$6)",
        [w, id, version, JSON.stringify(definition), restoredFrom, t.id],
      );
      // A new trigger moves it to the end of that trigger's order.
      const moved = definition.trigger.type !== row.trigger;
      const priority = moved
        ? ((await db.query<{ n: number | null }>("SELECT max(priority) AS n FROM workflows WHERE workspace_id=$1 AND trigger=$2 AND NOT archived", [w, definition.trigger.type]))
            .rows[0].n ?? -1) + 1
        : null;
      await db.query(
        `UPDATE workflows SET live_version=$4,state='live',trigger=$5,priority=COALESCE($6,priority),${touch} WHERE workspace_id=$1 AND id=$2`,
        [w, id, t.id, version, definition.trigger.type, priority],
      );
    };
    if (p.action === "save") {
      const name = nameOf(p.name);
      if (await taken(name, id)) invalid(`There's already a workflow called ${name}.`);
      const draft = def(p.definition);
      await db.query(`UPDATE workflows SET name=$4,draft=$5,${touch} WHERE workspace_id=$1 AND id=$2`, [w, id, t.id, name, JSON.stringify(draft)]);
      return readWorkflow(db, w, principal, id);
    }
    if (p.action === "publish") {
      await publish(row.draft, null);
      return readWorkflow(db, w, principal, id);
    }
    if (p.action === "rollback") {
      const to = Number(p.to);
      const old = (
        await db.query<{ definition: Definition }>("SELECT definition FROM workflow_versions WHERE workspace_id=$1 AND workflow_id=$2 AND version=$3", [w, id, to])
      ).rows[0];
      assert(old, "VERSION_NOT_FOUND", "That version isn't available.", 404);
      await publish(old.definition, to);
      await db.query("UPDATE workflows SET draft=$3 WHERE workspace_id=$1 AND id=$2", [w, id, JSON.stringify(old.definition)]);
      return readWorkflow(db, w, principal, id);
    }
    if (p.action === "pause" || p.action === "resume") {
      if (!row.live_version) invalid("Publish it first.");
      await db.query(`UPDATE workflows SET state=$4,${touch} WHERE workspace_id=$1 AND id=$2`, [w, id, t.id, p.action === "pause" ? "paused" : "live"]);
      return readWorkflow(db, w, principal, id);
    }
    if (p.action === "archive") {
      await db.query(`UPDATE workflows SET archived=true,state=CASE WHEN live_version IS NULL THEN 'draft' ELSE 'paused' END,${touch} WHERE workspace_id=$1 AND id=$2`, [w, id, t.id]);
      return readWorkflows(db, w, principal);
    }
    return invalid("Unknown workflow change.");
  });
}

/** A teammate runs a live manual workflow on a conversation they can manage. */
export async function runManually(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>) {
  await authorize(db, w, principal, "conversations.manage");
  assert(await workflowsEnabled(db, w), "WORKFLOWS_DISABLED", "Workflows are not enabled for this workspace.", 404);
  return once(db, w, "workflow-run:" + principal, key, p, async () => {
    const wf = (
      await db.query<{ id: string }>("SELECT id FROM workflows WHERE workspace_id=$1 AND id=$2 AND state='live' AND trigger='manual' AND NOT archived", [
        w,
        String(p.workflowId ?? ""),
      ])
    ).rows[0];
    assert(wf, "WORKFLOW_NOT_FOUND", "That workflow can't be run from the inbox.", 404);
    const conv = (await db.query("SELECT 1 FROM conversations WHERE workspace_id=$1 AND id=$2", [w, String(p.conversationId ?? "")])).rows.length;
    assert(conv, "CONVERSATION_NOT_FOUND", "Conversation unavailable.", 404);
    await startManual(db, w, wf.id, String(p.conversationId));
    return { queued: true };
  });
}

/* ------------------------------------------------------------------------------------------ */
/* The run log                                                                                 */

type RunRow = {
  id: string;
  workflow_id: string;
  name: string;
  workflow_version: number;
  conversation_id: string | null;
  trigger: string;
  source: string;
  status: string;
  path: string | null;
  reason: string;
  error: string;
  steps: number;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  wait_until: string | null;
};
const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
const runView = (r: RunRow) => ({
  id: r.id,
  workflowId: r.workflow_id,
  workflow: r.name,
  version: r.workflow_version,
  conversationId: r.conversation_id,
  trigger: r.trigger,
  source: r.source,
  status: r.status,
  path: r.path,
  reason: r.reason,
  error: r.error,
  steps: r.steps,
  startedAt: iso(r.started_at),
  endedAt: iso(r.ended_at),
  durationMs: r.duration_ms,
  waitUntil: iso(r.wait_until),
});

/** Runs, newest first, filtered by workflow, conversation and status. */
export async function readRuns(db: Sql, w: string, principal: string, f: { workflowId?: string; conversationId?: string; status?: string }) {
  await access(db, w, principal);
  const values: unknown[] = [w];
  const where = ["r.workspace_id=$1"];
  if (f.workflowId) where.push(`r.workflow_id=$${values.push(f.workflowId)}`);
  if (f.conversationId) where.push(`r.conversation_id=$${values.push(f.conversationId)}`);
  if (f.status) where.push(`r.status=$${values.push(f.status)}`);
  const rows = (
    await db.query<RunRow>(
      `SELECT r.id,r.workflow_id,w.name,r.workflow_version,r.conversation_id,r.trigger,r.source,r.status,r.path,r.reason,r.error,r.steps,r.started_at,r.ended_at,r.duration_ms,r.wait_until
       FROM workflow_runs r JOIN workflows w ON w.workspace_id=r.workspace_id AND w.id=r.workflow_id
       WHERE ${where.join(" AND ")} ORDER BY r.started_at DESC,r.id LIMIT 100`,
      values,
    )
  ).rows;
  return { runs: rows.map(runView) };
}

/** One run: every node visited, condition evaluated (with inputs) and action taken (with result). */
export async function readRun(db: Sql, w: string, principal: string, id: string) {
  await access(db, w, principal);
  const r = (
    await db.query<RunRow>(
      `SELECT r.id,r.workflow_id,w.name,r.workflow_version,r.conversation_id,r.trigger,r.source,r.status,r.path,r.reason,r.error,r.steps,r.started_at,r.ended_at,r.duration_ms,r.wait_until
       FROM workflow_runs r JOIN workflows w ON w.workspace_id=r.workspace_id AND w.id=r.workflow_id WHERE r.workspace_id=$1 AND r.id=$2`,
      [w, id],
    )
  ).rows[0];
  assert(r, "RUN_NOT_FOUND", "That run isn't available.", 404);
  const steps = (
    await db.query<{ seq: number; at: string; path: string | null; step: number | null; kind: string; label: string; inputs: unknown; result: string; detail: unknown; duration_ms: number }>(
      "SELECT seq,at,path,step,kind,label,inputs,result,detail,duration_ms FROM workflow_run_steps WHERE workspace_id=$1 AND run_id=$2 ORDER BY seq",
      [w, id],
    )
  ).rows.map((s) => ({ seq: s.seq, at: iso(s.at), path: s.path, step: s.step, kind: s.kind, label: s.label, inputs: s.inputs, result: s.result, detail: s.detail, durationMs: s.duration_ms }));
  return { run: runView(r), steps };
}
