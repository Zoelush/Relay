import { assert, DomainError, type Sql } from "./db";
import { authorize } from "./policy";
import { conversation } from "./conversations";
import { availabilityFor, expectedReply } from "./office-hours";
import { aiEnabled } from "./ai-agent";
import { evaluate, factsFor, workflowsEnabled, type Facts } from "./workflow-engine";
import { ACTIONS, DefinitionError, MAX_NODES, TRIGGERS, validate, type Definition, type Group, type Path, type Step } from "../lib/workflow-definition";

/**
 * Simulation (phase 11, step W3; docs/WORKFLOWS_STEP3.md): a workflow (its unsaved draft too) run
 * against a real conversation with no side effects. The transaction is read-only, so anything
 * that tried to write would fail rather than happen. Conditions are judged by the engine's own
 * `evaluate` on the facts a run would see, and each step's effect is applied to those facts in
 * memory, so later conditions see it ("added the tag", then "has the tag"). Where only the future
 * can decide (the customer's answer, Zoe's outcome, a wait, a connector's result) the trace offers
 * the choices, with a likely default, and the simulation is run again with the one picked.
 */
export type Decision = { id: string; options: { value: string; label: string }[]; chosen: string };
export type TraceEntry = {
  path: string | null;
  step: number | null;
  kind: "trigger" | "condition" | "action" | "message" | "wait" | "branch" | "end" | "stop";
  label: string;
  /** What a condition saw (for each condition: field, op, value, actual, result). */
  checks?: unknown[];
  decision?: Decision;
};

const words = (n: number) => {
  const [unit, size] = n % 86_400 === 0 ? ["day", 86_400] : n % 3600 === 0 ? ["hour", 3600] : ["minute", 60];
  const v = Math.round(n / (size as number));
  return `${v} ${unit}${v === 1 ? "" : "s"}`;
};

export async function simulateWorkflow(
  db: Sql,
  w: string,
  principal: string,
  p: { definition?: unknown; workflowId?: string; conversationId?: string; choices?: Record<string, string> },
) {
  await authorize(db, w, principal, "workspace.manage");
  assert(await workflowsEnabled(db, w), "WORKFLOWS_DISABLED", "Workflows are not enabled for this workspace.", 404);
  // Nothing a simulation does can write: the database refuses.
  await db.query("SET TRANSACTION READ ONLY");
  let def: Definition;
  try {
    const raw =
      p.definition ??
      (
        await db.query<{ draft: Definition }>("SELECT draft FROM workflows WHERE workspace_id=$1 AND id=$2 AND NOT archived", [
          w,
          String(p.workflowId ?? ""),
        ])
      ).rows[0]?.draft;
    assert(raw, "WORKFLOW_NOT_FOUND", "That workflow isn't available.", 404);
    def = validate(raw);
  } catch (e) {
    if (e instanceof DefinitionError) throw new DomainError("INVALID_WORKFLOW", e.message, 400);
    throw e;
  }
  const exists = (
    await db.query("SELECT 1 FROM conversations WHERE workspace_id=$1 AND id=$2 AND visibility='customer' AND merged_into_id IS NULL", [
      w,
      String(p.conversationId ?? ""),
    ])
  ).rows.length;
  assert(exists, "CONVERSATION_NOT_FOUND", "Choose a customer conversation in this workspace.", 404);
  const c = await conversation(db, w, String(p.conversationId));
  const choices = p.choices ?? {};
  const latest = (
    await db.query<{ id: string }>(
      "SELECT id FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND kind='customer_message' ORDER BY seq DESC LIMIT 1",
      [w, c.id],
    )
  ).rows[0]?.id;
  // As if the trigger fired now, on the customer's latest message.
  const facts = (await factsFor(db, w, c, { source: "customer", partId: latest ?? null })) as Facts;
  const trace: TraceEntry[] = [];
  const visited: string[] = [];
  const seen = new Map<string, number>();
  /** A choice point: its id is stable across re-runs (where, and which time it's reached). */
  const decide = (where: string, options: Decision["options"], fallback: string): Decision => {
    const n = (seen.get(where) ?? 0) + 1;
    seen.set(where, n);
    const id = `${where}#${n}`;
    const chosen = options.some((o) => o.value === choices[id]) ? choices[id] : fallback;
    return { id, options, chosen };
  };
  const judge = async (g: Group) => evaluate(db, w, g, facts);

  trace.push({ path: null, step: null, kind: "trigger", label: `${TRIGGERS[def.trigger.type].label} (as if now, on this conversation)` });
  const who = await judge(def.when);
  if (!who.result) {
    const d = decide("when", [
      { value: "stop", label: "It wouldn't run" },
      { value: "run", label: "Run it anyway" },
    ], "stop");
    trace.push({ path: null, step: null, kind: "condition", label: "Who it runs for doesn't match this conversation", checks: who.checks, decision: d });
    if (d.chosen === "stop") return { trace, visited, ended: "not run" as const, conversationId: c.id };
  } else if (who.checks.length) trace.push({ path: null, step: null, kind: "condition", label: "Who it runs for matches", checks: who.checks });

  const byId = new Map(def.paths.map((x) => [x.id, x]));
  let path: Path | undefined = def.paths[0];
  let nodes = 0;
  const go = (to: string, label: string, kind: TraceEntry["kind"] = "branch", extra: Partial<TraceEntry> = {}) => {
    trace.push({ path: path!.id, step: null, kind, label: `${label} → path ${to || "(not connected)"}`, ...extra });
    path = byId.get(to);
    if (!path) trace.push({ path: null, step: null, kind: "stop", label: `Path ${to || "(none)"} doesn't exist: a real run would fail here.` });
  };
  while (path) {
    visited.push(path.id);
    for (const [i, s] of path.steps.entries()) {
      if (++nodes > MAX_NODES) {
        trace.push({ path: path.id, step: i, kind: "stop", label: `More than ${MAX_NODES} steps: a real run would fail here.` });
        return { trace, visited, ended: "limit" as const, conversationId: c.id };
      }
      trace.push(...(await stepEffect(db, w, c, s, path.id, i, facts, decide)));
    }
    if (++nodes > MAX_NODES) {
      trace.push({ path: path.id, step: null, kind: "stop", label: `More than ${MAX_NODES} steps: a real run would fail here.` });
      return { trace, visited, ended: "limit" as const, conversationId: c.id };
    }
    const n = path.next;
    const here = path.id;
    if (n.type === "end") {
      trace.push({ path: here, step: null, kind: "end", label: "End" });
      return { trace, visited, ended: "completed" as const, conversationId: c.id };
    }
    if (n.type === "goto") {
      go(n.path, "Go on", "branch");
      continue;
    }
    if (n.type === "branch") {
      let to: string | null = null;
      for (const b of n.branches) {
        const e = await judge(b.when);
        trace.push({ path: here, step: null, kind: "condition", label: `Branch “${b.label}”: ${e.result ? "matches" : "doesn't match"}`, checks: e.checks });
        if (e.result) {
          to = b.path;
          go(b.path, `Takes “${b.label}”`);
          break;
        }
      }
      if (to === null) go(n.else, "Takes Else");
      continue;
    }
    if (n.type === "wait_until") {
      const e = await judge(n.when);
      const d = decide(`${here}:wait`, [
        { value: "met", label: "It holds" },
        { value: "timedOut", label: `It times out (${words(n.timeoutSeconds)})` },
      ], e.result ? "met" : "timedOut");
      trace.push({ path: here, step: null, kind: "wait", label: e.result ? "The wait's condition holds now" : `Would wait up to ${words(n.timeoutSeconds)} for its condition`, checks: e.checks, decision: d });
      facts["wait.timed_out"] = d.chosen === "timedOut";
      go(d.chosen === "met" ? n.met : n.timedOut, d.chosen === "met" ? "When it holds" : "If it times out");
      continue;
    }
    if (n.type === "buttons") {
      trace.push({ path: here, step: null, kind: "message", label: `Would ask: “${n.text}” with ${n.buttons.map((b) => `[${b.label}]`).join(" ")}` });
      const d = decide(`${here}:buttons`, [
        ...n.buttons.map((b, i) => ({ value: "b" + i, label: `They choose “${b.label}”` })),
        { value: "other", label: "They type something else" },
        { value: "timedOut", label: `No answer in ${words(n.timeoutSeconds)}` },
      ], "b0");
      trace.push({ path: here, step: null, kind: "wait", label: "Would wait for their answer", decision: d });
      facts["wait.timed_out"] = d.chosen === "timedOut";
      const button = /^b(\d+)$/.exec(d.chosen);
      if (button) go(n.buttons[Number(button[1])].path, `They chose “${n.buttons[Number(button[1])].label}”`);
      else go(d.chosen === "other" ? n.other : n.timedOut, d.chosen === "other" ? "They typed instead" : "No answer");
      continue;
    }
    if (n.type === "zoe") {
      const on = await aiEnabled(db, w);
      if (!on || facts["conversation.ai_state"] === "escalated" || facts["conversation.ai_state"] === "needs_input") {
        trace.push({ path: here, step: null, kind: "action", label: on ? "Already handed over: Zoe wouldn't answer" : "Zoe is off" });
        go(n.handedOver, "Handed over");
        continue;
      }
      const d = decide(`${here}:zoe`, [
        { value: "resolved", label: "Zoe resolves it" },
        { value: "handedOver", label: "Zoe hands it over" },
        { value: "timedOut", label: `No outcome in ${words(n.timeoutSeconds)}` },
      ], "resolved");
      trace.push({ path: here, step: null, kind: "wait", label: "Would let Zoe answer, and wait for her outcome", decision: d });
      facts["conversation.ai_state"] = d.chosen === "resolved" ? "resolved" : d.chosen === "handedOver" ? "escalated" : "pending";
      facts["wait.timed_out"] = d.chosen === "timedOut";
      go(d.chosen === "resolved" ? n.resolved : d.chosen === "handedOver" ? n.handedOver : n.timedOut, d.chosen === "resolved" ? "Resolved" : d.chosen === "handedOver" ? "Handed over" : "No outcome");
      continue;
    }
    // A connector: never called in a simulation.
    const named = (await db.query<{ name: string }>("SELECT name FROM ai_connectors WHERE workspace_id=$1 AND id=$2", [w, n.connectorId])).rows[0]?.name ?? "its connector";
    const d = decide(`${here}:connector`, [
      { value: "ok", label: "It works" },
      { value: "failed", label: "It fails" },
    ], "ok");
    trace.push({ path: here, step: null, kind: "action", label: `Would call ${named} (not called in a simulation)`, decision: d });
    if (d.chosen === "ok") for (const a of Object.values(n.save)) facts.attributes[a] = "(its output)";
    go(d.chosen === "ok" ? n.ok : n.failed, d.chosen === "ok" ? "It worked" : "It failed");
  }
  return { trace, visited, ended: "failed" as const, conversationId: c.id };
}

/** One step's effect in words, applied to the facts in memory (never to the conversation). */
async function stepEffect(
  db: Sql,
  w: string,
  c: Awaited<ReturnType<typeof conversation>>,
  s: Step,
  path: string,
  i: number,
  f: Facts,
  decide: (where: string, options: Decision["options"], fallback: string) => Decision,
): Promise<TraceEntry[]> {
  const o = s.options;
  const at = { path, step: i };
  const did = (label: string, kind: TraceEntry["kind"] = "action"): TraceEntry[] => [{ ...at, kind, label }];
  const name = async (table: string, id: unknown) =>
    (await db.query<{ name: string }>(`SELECT name FROM ${table} WHERE workspace_id=$1 AND id=$2`, [w, String(id ?? "")])).rows[0]?.name ?? "a missing one";
  switch (s.type) {
    case "tag_add":
      if (!f.tags.includes(String(o.tagId))) f.tags = [...f.tags, String(o.tagId)];
      return did(`Would add the tag “${await name("tags", o.tagId)}”`);
    case "tag_remove":
      f.tags = f.tags.filter((t) => t !== o.tagId);
      return did(`Would remove the tag “${await name("tags", o.tagId)}”`);
    case "assign":
      if (o.teamId) f["conversation.team"] = String(o.teamId);
      f["conversation.assignee"] = o.teammateId ? String(o.teammateId) : o.teamId ? "(routed by the team's method)" : null;
      return did(
        o.teammateId
          ? `Would assign to ${await name("teammates", o.teammateId)}`
          : o.teamId
            ? `Would assign to the team ${await name("teams", o.teamId)} (routed by its method)`
            : "Would unassign",
      );
    case "priority":
      f["conversation.priority"] = o.value === true;
      return did(o.value ? "Would mark it as priority" : "Would remove priority");
    case "snooze":
      f["conversation.status"] = "snoozed";
      return did(`Would snooze it for ${words(Number(o.seconds))}`);
    case "close":
      f["conversation.status"] = "closed";
      return did("Would close it");
    case "reopen":
      f["conversation.status"] = "open";
      return did("Would reopen it");
    case "sla_apply":
      return did(o.policyId === "none" ? "Would apply no SLA" : `Would apply the SLA “${await name("sla_policies", o.policyId)}”`);
    case "sla_clear":
      return did("Would clear the applied SLA");
    case "attribute_set":
      f.attributes[String(o.attributeId)] = o.value;
      return did(`Would set “${await name("attribute_definitions", o.attributeId)}” to ${String(o.value ?? "nothing")}`);
    case "contact_attribute_set":
      f.contactAttributes[String(o.key)] = o.value;
      return did(`Would set the customer's ${String(o.key)} to ${String(o.value ?? "nothing")}`);
    case "note":
      return did(`Would add a note: “${String(o.text).slice(0, 120)}”`);
    case "ticket_create":
      return did(`Would create a “${await name("ticket_types", o.typeId)}” ticket`);
    case "ai_handover":
      f["conversation.ai_state"] = "pending";
      return did((await aiEnabled(db, w)) ? "Would hand to Zoe" : "Would hand to Zoe, but she's off");
    case "human_handover":
      f["conversation.ai_state"] = "escalated";
      if (o.teamId) f["conversation.team"] = String(o.teamId);
      return did("Would hand to the team");
    case "wait":
      return did(`Would wait ${words(Number(o.seconds))}`, "wait");
    case "wait_office_hours": {
      const hours = await availabilityFor(db, w, { brandId: c.brand_id, teamId: c.team_id }, "en");
      return did(!hours || hours.open ? "Office hours are open: wouldn't wait" : `Would wait until office hours (${hours.nextOpenLabel ?? "when they open"})`, "wait");
    }
    case "message":
      return did(`Would send: “${String(o.text)}”`, "message");
    case "reply_time": {
      const hours = await availabilityFor(db, w, { brandId: c.brand_id, teamId: c.team_id }, "en");
      const r = await expectedReply(db, w, c.brand_id);
      return did(
        !hours || hours.open
          ? `Would show the expected reply time${r ? ` (${"text" in r ? r.text : r.band.replace(/_/g, " ")})` : ""}`
          : `Would say the team is away${hours.nextOpenLabel ? `, back ${hours.nextOpenLabel}` : ""}`,
        "message",
      );
    }
    case "collect": {
      const d = decide(`${path}:${i}:collect`, [
        { value: "answered", label: "They answer" },
        { value: "timedOut", label: "No answer in time" },
      ], "answered");
      if (d.chosen === "answered") {
        if (o.into === "contact") f.contactAttributes[String(o.key)] = "(their answer)";
        if (o.into === "conversation") f.attributes[String(o.attributeId)] = "(their answer)";
      }
      f["wait.timed_out"] = d.chosen === "timedOut";
      return [
        { ...at, kind: "message", label: `Would ask: “${String(o.text)}”` },
        { ...at, kind: "wait", label: "Would wait for their answer, and keep it", decision: d },
      ];
    }
  }
  // Every step is handled above; a step this version doesn't know is said as it is.
  return did((ACTIONS as Record<string, { label: string }>)[(s as Step).type]?.label ?? String((s as Step).type));
}

/** The builder's conversation picker: the latest customer conversations, matching `q` if given. */
export async function simulationConversations(db: Sql, w: string, principal: string, q: string) {
  await authorize(db, w, principal, "workspace.manage");
  assert(await workflowsEnabled(db, w), "WORKFLOWS_DISABLED", "Workflows are not enabled for this workspace.", 404);
  const rows = (
    await db.query<{ id: string; title: string; status: string; created_at: string; customer: string | null }>(
      `SELECT c.id,c.title,c.status,c.created_at,k.name AS customer FROM conversations c
       LEFT JOIN LATERAL (SELECT m.contact_id FROM identity_contact_mappings m WHERE m.workspace_id=c.workspace_id AND m.identity_id=c.primary_identity_id LIMIT 1) m ON true
       LEFT JOIN contacts k ON k.workspace_id=c.workspace_id AND k.id=m.contact_id
       WHERE c.workspace_id=$1 AND c.visibility='customer' AND c.merged_into_id IS NULL
         AND ($2='' OR c.id=$2 OR c.title ILIKE '%'||$2||'%' OR k.name ILIKE '%'||$2||'%')
       ORDER BY c.created_at DESC,c.id DESC LIMIT 20`,
      [w, q.trim().slice(0, 100)],
    )
  ).rows;
  return {
    conversations: rows.map((r) => ({ id: r.id, title: r.title, status: r.status, customer: r.customer, createdAt: new Date(r.created_at).toISOString() })),
  };
}
