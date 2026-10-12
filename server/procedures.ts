import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { zoeAccess } from "./zoe";
import { actionsEnabled, pinnedVersion, runConnector, type ConnectorEnvironment } from "./connectors";
import { matchKeywords, matchRule, rulesOf, validRules, type Facts, type Rule } from "./ai-escalation";
import { buildClassifyPrompt, type ClassifierPort } from "./ai-model";
import { redactor, type ModelCall } from "./ai-privacy";
import {
  CompileError,
  blankSource,
  compile,
  describe,
  fill,
  holds,
  validSource,
  type ConnectorRef,
  type Plan,
  type Source,
} from "../lib/procedure-plan";
import type { Definition } from "../lib/connector-definition";

/**
 * Procedures (phase 09, step D2; docs/ACTIONS_STEP2.md), behind `ai_actions_v1`, for those who
 * manage Zoe. A procedure is written as plain-language numbered steps, compiled into a fixed plan
 * (`lib/procedure-plan.ts`) and published as an immutable version. In a conversation, its keywords
 * start it (in code); then each customer message moves it on: the plan decides what happens, and
 * Zoe only asks, says and looks up what it says. Before any connector runs, the customer must pass
 * the workspace's verification rules. Anything that fails is said plainly and handed over.
 */

/* ------------------------------------------------------------------------------------------ */
/* Verification                                                                                */

export type VerificationRule = Rule & { channel: "messenger"; requirement: "signed_in" | "none" };
export type Requirement = "signed_in" | "none";

/** Whether this customer may have connectors run for them, by the rules or the fallback. */
export function verified(
  rules: VerificationRule[],
  fallback: Requirement,
  f: Facts,
  channel: "messenger",
) {
  const rule = matchRule(
    rules.filter((r) => r.channel === channel),
    f,
  ) as VerificationRule | null;
  const requirement = rule ? rule.requirement : fallback;
  return {
    ok: requirement === "none" || f.signedIn,
    requirement,
    rule: rule?.name ?? null,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Fixed replies                                                                               */

/**
 * What Zoe says around a procedure, in her nine languages (usual register). A native speaker
 * should check these, as with Z2's strings.
 */
const PHRASES: Record<string, { retry: string; verify: string; failed: string; done: string }> = {
  en: {
    retry: "Sorry, I didn't catch that.",
    verify: "I can only look that up for customers who are signed in.",
    failed: "I couldn't check that just now.",
    done: "Is there anything else I can help with?",
  },
  fr: {
    retry: "Désolé, je n'ai pas bien compris.",
    verify: "Je ne peux vérifier cela que pour les clients connectés.",
    failed: "Je n'ai pas pu vérifier cela pour le moment.",
    done: "Puis-je vous aider pour autre chose ?",
  },
  es: {
    retry: "Perdona, no lo he entendido.",
    verify: "Solo puedo consultarlo para clientes que hayan iniciado sesión.",
    failed: "No he podido comprobarlo ahora mismo.",
    done: "¿Puedo ayudarte con algo más?",
  },
  de: {
    retry: "Entschuldigung, das habe ich nicht verstanden.",
    verify: "Das kann ich nur für angemeldete Kunden nachsehen.",
    failed: "Das konnte ich gerade nicht prüfen.",
    done: "Kann ich Ihnen sonst noch helfen?",
  },
  pt: {
    retry: "Desculpe, não percebi.",
    verify: "Só posso consultar isso para clientes com sessão iniciada.",
    failed: "Não consegui verificar isso agora.",
    done: "Posso ajudar com mais alguma coisa?",
  },
  "pt-BR": {
    retry: "Desculpe, não entendi.",
    verify: "Só consigo consultar isso para clientes que fizeram login.",
    failed: "Não consegui verificar isso agora.",
    done: "Posso ajudar com mais alguma coisa?",
  },
  it: {
    retry: "Scusa, non ho capito.",
    verify: "Posso verificarlo solo per i clienti che hanno effettuato l'accesso.",
    failed: "Non sono riuscita a verificarlo in questo momento.",
    done: "Posso aiutarti in altro?",
  },
  nl: {
    retry: "Sorry, dat begreep ik niet.",
    verify: "Ik kan dat alleen opzoeken voor klanten die zijn ingelogd.",
    failed: "Ik kon dat nu niet controleren.",
    done: "Kan ik je ergens anders mee helpen?",
  },
  ar: {
    retry: "عذرًا، لم أفهم ذلك.",
    verify: "لا يمكنني البحث عن ذلك إلا للعملاء الذين سجّلوا الدخول.",
    failed: "لم أتمكن من التحقق من ذلك الآن.",
    done: "هل هناك أي شيء آخر يمكنني مساعدتك فيه؟",
  },
};
const phrases = (locale: string) => PHRASES[locale] ?? PHRASES[locale.split("-")[0]] ?? PHRASES.en;

/* ------------------------------------------------------------------------------------------ */
/* Running in a conversation                                                                   */

/** At most this many steps run for one customer message (a loop in the plan stops here). */
const STEP_BUDGET = 50;
/** Tries at an input before she hands over. */
const MAX_RETRIES = 2;

type RunRow = {
  id: string;
  procedure_id: string;
  procedure_version: number;
  step: number;
  waiting_for: string | null;
  retries: number;
  values: Record<string, unknown>;
  version: string;
  name: string;
  plan: Plan;
};
export type ProcedureTurn = {
  runId: string;
  procedure: string;
  version: number;
  /** What she says, in order (one reply). */
  messages: string[];
  status: "waiting" | "resolved" | "escalated" | "abandoned";
  /** For teammates: what happened, in words. */
  reason: string;
  calls: ModelCall[];
  /** Writes the run's new state, in the reply's transaction; false if it changed meanwhile. */
  commit: (db: Sql) => Promise<boolean>;
};
export type ProcedureEnvironment = { connectors?: ConnectorEnvironment; classify?: ClassifierPort };

/** A value for an input in what the customer wrote: by its pattern, or the whole message. */
function extract(input: Plan["inputs"][number], message: string, whole: boolean) {
  const text = message.trim();
  if (input.pattern) {
    const m = new RegExp(input.pattern).exec(text);
    return m ? m[0] : null;
  }
  return whole && text && text.length <= 200 && !/[\r\n]/.test(text) ? text : null;
}

/**
 * A customer message's turn in a procedure, or null when none applies (Zoe answers as usual). A
 * person asked for, or an escalation rule, ends a running procedure and leaves the message to her
 * usual handover. Connector calls happen here, outside any transaction; `commit` writes the run.
 */
export async function procedureTurn(
  connect: Connect,
  env: ProcedureEnvironment,
  input: {
    w: string;
    agentId: string;
    conversationId: string;
    question: string;
    locale: string;
    facts: Facts;
    personLabels: Set<string>;
    redact: boolean;
    names: string[];
  },
): Promise<ProcedureTurn | { abandon: (db: Sql) => Promise<void>; calls: ModelCall[] } | null> {
  const { w } = input;
  const loaded = await tenant(connect, w, async (db) => {
    if (!(await actionsEnabled(db, w))) return null;
    const active = (
      await db.query<RunRow>(
        `SELECT r.id,r.procedure_id,r.procedure_version,r.step,r.waiting_for,r.retries,r."values",r.version::text AS version,p.name,v.plan
         FROM ai_procedure_runs r JOIN ai_procedures p ON p.workspace_id=r.workspace_id AND p.id=r.procedure_id
         JOIN ai_procedure_versions v ON v.workspace_id=r.workspace_id AND v.procedure_id=r.procedure_id AND v.version=r.procedure_version
         WHERE r.workspace_id=$1 AND r.conversation_id=$2 AND r.status='waiting'`,
        [w, input.conversationId],
      )
    ).rows[0];
    const live = active
      ? []
      : (
          await db.query<{ id: string; name: string; live_version: number; plan: Plan }>(
            `SELECT p.id,p.name,p.live_version,v.plan FROM ai_procedures p
             JOIN ai_procedure_versions v ON v.workspace_id=p.workspace_id AND v.procedure_id=p.id AND v.version=p.live_version
             WHERE p.workspace_id=$1 AND p.agent_id=$2 AND NOT p.archived ORDER BY lower(p.name),p.id`,
            [w, input.agentId],
          )
        ).rows;
    const agent = (
      await db.query<{ verification_rules: VerificationRule[]; verification_fallback: Requirement }>(
        "SELECT verification_rules,verification_fallback FROM ai_agents WHERE workspace_id=$1 AND id=$2",
        [w, input.agentId],
      )
    ).rows[0];
    // An escalation rule that matches this customer hands over before anything else (A2b).
    const escalation = matchRule(await rulesOf(db, w, input.agentId), input.facts);
    return { active, live, agent, escalation };
  });
  if (!loaded) return null;
  let run: RunRow | null = loaded.active ?? null;
  if (!run) {
    // Its keywords start it, in code.
    const hit = loaded.live.find((p) =>
      matchKeywords([{ name: p.name, description: "", keywords: p.plan.keywords }], input.question),
    );
    if (!hit) return null;
    run = {
      id: crypto.randomUUID(),
      procedure_id: hit.id,
      procedure_version: hit.live_version,
      step: 0,
      waiting_for: null,
      retries: 0,
      values: {},
      version: "0",
      name: hit.name,
      plan: hit.plan,
    };
  }
  const starting = run.version === "0";
  // A person asked for (the button, or in words), or an escalation rule, comes first: the running
  // procedure ends and her usual handover takes the message.
  const calls: ModelCall[] = [];
  let wantsPerson = input.personLabels.has(input.question.trim().toLowerCase());
  if (!wantsPerson && env.classify) {
    const r = redactor(input.redact, input.names);
    const request = { message: r.redact(input.question), history: [], locale: input.locale, topics: [], guidance: [], spam: [], specialists: [] };
    calls.push({ kind: "classify", model: env.classify.model, sent: buildClassifyPrompt(request).user, redacted: r.on, redactions: {} });
    try {
      wantsPerson = (await env.classify.classify(request)).wantsHuman;
    } catch {
      // Without the classifier the procedure carries on; the button still hands over.
    }
  }
  if (wantsPerson || loaded.escalation) {
    if (starting) return { abandon: async () => {}, calls };
    const r = run;
    return {
      calls,
      abandon: async (db) => {
        await db.query(
          `UPDATE ai_procedure_runs SET status='abandoned',reason=$3,ended_at=now(),updated_at=now(),version=version+1
           WHERE workspace_id=$1 AND id=$2 AND status='waiting'`,
          [w, r.id, wantsPerson ? "The customer asked for a person." : "An escalation rule matched."],
        );
      },
    };
  }

  const plan = run.plan;
  const say = phrases(input.locale);
  const values: Record<string, unknown> = { ...run.values };
  const messages: string[] = [];
  let step = run.step;
  let waitingFor: string | null = run.waiting_for;
  let retries = run.retries;
  let status: ProcedureTurn["status"] = "waiting";
  let reason = "";
  const stepsTaken: string[] = [];
  const finish = (s: ProcedureTurn["status"], why: string) => {
    status = s;
    reason = why;
  };
  const failed = (why: string) => {
    messages.push(plan.onFailure ? fill(plan.onFailure, values) : say.failed);
    finish("escalated", why);
  };

  if (starting) {
    // Values already in the first message (by pattern) needn't be asked for.
    for (const i of plan.inputs) {
      const v = i.pattern ? extract(i, input.question, false) : null;
      if (v !== null) values[i.name] = v;
    }
  } else if (waitingFor) {
    const wanted = plan.inputs.find((i) => i.name === waitingFor)!;
    const v = extract(wanted, input.question, true);
    if (v === null) {
      retries++;
      if (retries > MAX_RETRIES) finish("escalated", `She couldn't get ${wanted.label} after ${MAX_RETRIES + 1} tries.`);
      else {
        messages.push(`${say.retry} ${wanted.question}`);
        reason = `Asked again for ${wanted.label}.`;
      }
    } else {
      values[wanted.name] = v;
      waitingFor = null;
      retries = 0;
      step++;
    }
  }

  // The plan runs until it needs the customer or ends.
  for (let budget = 0; status === "waiting" && !reason.startsWith("Asked again") && budget < STEP_BUDGET; budget++) {
    if (budget === STEP_BUDGET - 1) {
      finish("escalated", "The procedure went round in a loop.");
      break;
    }
    const s = plan.steps[step];
    if (!s) {
      finish("abandoned", "The procedure ran out of steps.");
      break;
    }
    stepsTaken.push(String(step + 1));
    if (s.kind === "ask") {
      const i = plan.inputs.find((x) => x.name === s.input)!;
      if (values[i.name] !== undefined && values[i.name] !== null && values[i.name] !== "") {
        step++;
        continue;
      }
      waitingFor = i.name;
      messages.push(i.question);
      reason = `Asked for ${i.label}.`;
      break;
    }
    if (s.kind === "call") {
      const check = verified(loaded.agent.verification_rules, loaded.agent.verification_fallback, input.facts, "messenger");
      if (!check.ok) {
        messages.push(say.verify);
        finish("escalated", `${s.connector} needs a signed-in customer${check.rule ? ` (verification rule “${check.rule}”)` : " (the fallback rule)"}, and this one isn't.`);
        break;
      }
      if (!env.connectors) {
        failed(`${s.connector} can't run here: connectors aren't configured.`);
        break;
      }
      const version = await tenant(connect, w, (db) => pinnedVersion(db, w, s.connectorId, input.conversationId));
      if (!version) {
        failed(`${s.connector} isn't published any more.`);
        break;
      }
      const call = await runConnector(connect, env.connectors, w, {
        connectorId: s.connectorId,
        version,
        values: Object.fromEntries(plan.inputs.map((i) => [i.name, values[i.name]])),
        source: "agent",
        invokedBy: input.agentId,
        conversationId: input.conversationId,
      });
      if (call.result !== "ok") {
        failed(`${s.connector} failed (${call.result}${call.error ? `: ${call.error}` : ""}).`);
        break;
      }
      Object.assign(values, call.outputs);
      step++;
      continue;
    }
    if (s.kind === "branch") {
      step = holds(s, values) ? s.to : step + 1;
      continue;
    }
    if (s.kind === "say") {
      messages.push(fill(s.text, values));
      step++;
      continue;
    }
    if (s.kind === "goto") {
      step = s.to;
      continue;
    }
    if (s.kind === "end") {
      if (s.outcome === "resolved") {
        if (!messages.length) messages.push(say.done);
        finish("resolved", "Resolved.");
      } else if (s.outcome === "escalated") finish("escalated", "Its plan hands over.");
      else finish("abandoned", "Its plan stops here; she answers as usual from now on.");
      break;
    }
  }
  if (status === "waiting" && !reason) reason = "Waiting for the customer.";
  const r = run;
  const record = `Procedure “${r.name}” (version ${r.procedure_version})${stepsTaken.length ? `, steps ${stepsTaken.join(", ")}` : ""}: ${reason}`;
  return {
    runId: r.id,
    procedure: r.name,
    version: r.procedure_version,
    messages,
    status,
    reason: record,
    calls,
    commit: async (db) => {
      const ended = status !== "waiting";
      if (starting) {
        const inserted = await db.query(
          `INSERT INTO ai_procedure_runs(workspace_id,id,conversation_id,procedure_id,procedure_version,status,step,waiting_for,retries,"values",reason,ended_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${ended ? "now()" : "NULL"})
           ON CONFLICT DO NOTHING RETURNING id`,
          [w, r.id, input.conversationId, r.procedure_id, r.procedure_version, status, step, waitingFor, retries, JSON.stringify(values), reason],
        );
        return inserted.rows.length > 0;
      }
      const updated = await db.query(
        `UPDATE ai_procedure_runs SET status=$3,step=$4,waiting_for=$5,retries=$6,"values"=$7,reason=$8,updated_at=now(),
           ended_at=${ended ? "now()" : "NULL"},version=version+1
         WHERE workspace_id=$1 AND id=$2 AND status='waiting' AND version::text=$9 RETURNING id`,
        [w, r.id, status, step, waitingFor, retries, JSON.stringify(values), reason, r.version],
      );
      return updated.rows.length > 0;
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Managing procedures                                                                         */

async function access(db: Sql, w: string, principal: string) {
  const agent = await zoeAccess(db, w, principal);
  assert(await actionsEnabled(db, w), "ACTIONS_DISABLED", "Procedures are not enabled for this workspace.", 404);
  return { agent, teammate: await authorize(db, w, principal, "workspace.manage") };
}

/** Published connectors, as the compiler sees them. */
async function connectorRefs(db: Sql, w: string): Promise<ConnectorRef[]> {
  return (
    await db.query<{ id: string; name: string; definition: Definition }>(
      `SELECT c.id,c.name,v.definition FROM ai_connectors c
       JOIN ai_connector_versions v ON v.workspace_id=c.workspace_id AND v.connector_id=c.id AND v.version=c.live_version
       WHERE c.workspace_id=$1 AND NOT c.archived`,
      [w],
    )
  ).rows.map((c) => ({
    id: c.id,
    name: c.name,
    asks: c.definition.inputs.filter((i) => i.source === "customer").map((i) => i.name),
    outputs: c.definition.outputs.map((o) => o.name),
  }));
}
/** The source compiled, or why it doesn't compile. */
function tryCompile(source: Source, refs: ConnectorRef[]) {
  try {
    const plan = compile(source, refs);
    return { plan, steps: describe(plan), error: null };
  } catch (e) {
    if (e instanceof CompileError) return { plan: null, steps: [], error: e.message };
    throw e;
  }
}

type ProcRow = { id: string; name: string; source: Source; live_version: number | null; live: Source | null; version: string };
const PROC = `p.id,p.name,p.source,p.live_version,p.version::text AS version,
  (SELECT v.source FROM ai_procedure_versions v WHERE v.workspace_id=p.workspace_id AND v.procedure_id=p.id AND v.version=p.live_version) AS live
  FROM ai_procedures p`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Train › Procedures: the list, the verification rules, and recent runs. */
export async function readProcedures(db: Sql, w: string, principal: string) {
  const { agent } = await access(db, w, principal);
  const rows = (await db.query<ProcRow>(`SELECT ${PROC} WHERE p.workspace_id=$1 AND NOT p.archived ORDER BY lower(p.name),p.id`, [w])).rows;
  const v = (
    await db.query<{ verification_rules: VerificationRule[]; verification_fallback: Requirement }>(
      "SELECT verification_rules,verification_fallback FROM ai_agents WHERE workspace_id=$1 AND id=$2",
      [w, agent.id],
    )
  ).rows[0];
  const runs = (
    await db.query<{ id: string; conversation_id: string; name: string; procedure_version: number; status: string; reason: string; started_at: string }>(
      `SELECT r.id,r.conversation_id,p.name,r.procedure_version,r.status,r.reason,r.started_at FROM ai_procedure_runs r
       JOIN ai_procedures p ON p.workspace_id=r.workspace_id AND p.id=r.procedure_id
       WHERE r.workspace_id=$1 ORDER BY r.started_at DESC,r.id LIMIT 20`,
      [w],
    )
  ).rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    procedure: r.name,
    version: r.procedure_version,
    status: r.status,
    reason: r.reason,
    startedAt: new Date(r.started_at).toISOString(),
  }));
  return {
    procedures: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.source.description,
      keywords: r.source.keywords,
      liveVersion: r.live_version,
      changed: !r.live || !same(r.source, r.live),
    })),
    verification: { rules: v.verification_rules, fallback: v.verification_fallback },
    runs,
  };
}

/** One procedure: its source, what it compiles to (or why not), and its versions. */
export async function readProcedure(db: Sql, w: string, principal: string, id: string) {
  await access(db, w, principal);
  const r = (await db.query<ProcRow>(`SELECT ${PROC} WHERE p.workspace_id=$1 AND p.id=$2 AND NOT p.archived`, [w, id])).rows[0];
  assert(r, "PROCEDURE_NOT_FOUND", "That procedure isn't available.", 404);
  const refs = await connectorRefs(db, w);
  const versions = (
    await db.query<{ version: number; published_at: string; name: string | null }>(
      `SELECT v.version,v.published_at,t.name FROM ai_procedure_versions v LEFT JOIN teammates t ON t.workspace_id=v.workspace_id AND t.id=v.published_by
       WHERE v.workspace_id=$1 AND v.procedure_id=$2 ORDER BY v.version DESC LIMIT 20`,
      [w, id],
    )
  ).rows.map((v) => ({ version: v.version, publishedAt: new Date(v.published_at).toISOString(), by: v.name }));
  const compiled = tryCompile(r.source, refs);
  return {
    procedure: {
      id: r.id,
      name: r.name,
      version: r.version,
      source: r.source,
      liveVersion: r.live_version,
      changed: !r.live || !same(r.source, r.live),
    },
    compiled: { steps: compiled.steps, error: compiled.error },
    connectors: refs.map((c) => ({ name: c.name, asks: c.asks, outputs: c.outputs })),
    versions,
  };
}

const invalid = (message: string): never => {
  throw new DomainError("INVALID_PROCEDURE", message, 400);
};
const nameOf = (v: unknown) => {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!s || s.length > 60 || /[\x00-\x1f]/.test(s)) invalid("Name the procedure, in up to 60 characters.");
  return s;
};

/**
 * One change, idempotent by key: `create`, `save` (by version; a draft may not compile yet),
 * `publish` (it must compile against published connectors), `archive` (a run in progress ends),
 * or `verification` (the rules and fallback).
 */
export async function changeProcedure(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>) {
  const { agent, teammate } = await access(db, w, principal);
  return once(db, w, "zoe-procedure:" + principal, key, p, async () => {
    if (p.action === "verification") {
      const list = Array.isArray(p.rules) ? (p.rules as Record<string, unknown>[]) : [];
      const rules = (await validRules(db, w, list)).map((r, i): VerificationRule => {
        const requirement = list[i].requirement;
        if (requirement !== "signed_in" && requirement !== "none") invalid(`Say what “${r.name}” requires.`);
        return { ...r, channel: "messenger", requirement: requirement as Requirement };
      });
      if (p.fallback !== "signed_in" && p.fallback !== "none") invalid("Choose the fallback: signed in, or anyone.");
      await db.query(
        "UPDATE ai_agents SET verification_rules=$3,verification_fallback=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [w, agent.id, JSON.stringify(rules), p.fallback],
      );
      return readProcedures(db, w, principal);
    }
    const taken = async (name: string, except = "") =>
      (await db.query("SELECT 1 FROM ai_procedures WHERE workspace_id=$1 AND lower(name)=lower($2) AND NOT archived AND id<>$3", [w, name, except]))
        .rows.length > 0;
    if (p.action === "create") {
      const name = nameOf(p.name);
      if (await taken(name)) invalid(`There's already a procedure called ${name}.`);
      const id = crypto.randomUUID();
      await db.query(
        "INSERT INTO ai_procedures(workspace_id,id,agent_id,name,source,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)",
        [w, id, agent.id, name, JSON.stringify(blankSource()), teammate.id],
      );
      return readProcedure(db, w, principal, id);
    }
    const id = String(p.id ?? "");
    const row = (
      await db.query<{ version: string; source: Source }>(
        "SELECT version::text AS version,source FROM ai_procedures WHERE workspace_id=$1 AND id=$2 AND NOT archived",
        [w, id],
      )
    ).rows[0];
    assert(row, "PROCEDURE_NOT_FOUND", "That procedure isn't available.", 404);
    if (String(p.version ?? "") !== row.version)
      throw new DomainError("PROCEDURE_CHANGED", "Someone else changed this procedure. Reload to see it.", 409);
    if (p.action === "save") {
      const name = nameOf(p.name);
      if (await taken(name, id)) invalid(`There's already a procedure called ${name}.`);
      let source: Source;
      try {
        source = validSource(p.source);
      } catch (e) {
        if (e instanceof CompileError) return invalid(e.message);
        throw e;
      }
      await db.query(
        "UPDATE ai_procedures SET name=$3,source=$4,version=version+1,updated_by=$5,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [w, id, name, JSON.stringify(source), teammate.id],
      );
      return readProcedure(db, w, principal, id);
    }
    if (p.action === "publish") {
      const compiled = tryCompile(row.source, await connectorRefs(db, w));
      if (!compiled.plan) invalid(compiled.error ?? "It doesn't compile.");
      const version =
        ((await db.query<{ v: number | null }>("SELECT max(version) AS v FROM ai_procedure_versions WHERE workspace_id=$1 AND procedure_id=$2", [w, id]))
          .rows[0].v ?? 0) + 1;
      await db.query(
        "INSERT INTO ai_procedure_versions(workspace_id,procedure_id,version,source,plan,published_by) VALUES($1,$2,$3,$4,$5,$6)",
        [w, id, version, JSON.stringify(row.source), JSON.stringify(compiled.plan), teammate.id],
      );
      await db.query(
        "UPDATE ai_procedures SET live_version=$3,version=version+1,updated_by=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [w, id, version, teammate.id],
      );
      return readProcedure(db, w, principal, id);
    }
    if (p.action === "archive") {
      await db.query("UPDATE ai_procedures SET archived=true,version=version+1,updated_by=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2", [
        w,
        id,
        teammate.id,
      ]);
      await db.query(
        `UPDATE ai_procedure_runs SET status='abandoned',reason='The procedure was archived.',ended_at=now(),updated_at=now(),version=version+1
         WHERE workspace_id=$1 AND procedure_id=$2 AND status='waiting'`,
        [w, id],
      );
      return readProcedures(db, w, principal);
    }
    return invalid("Unknown procedure change.");
  });
}
