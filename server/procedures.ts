import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { enqueueJob } from "./jobs";
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
const PHRASES: Record<
  string,
  { retry: string; verify: string; failed: string; done: string; approval: string; stillWaiting: string; denied: string; expired: string }
> = {
  en: {
    retry: "Sorry, I didn't catch that.",
    verify: "I can only look that up for customers who are signed in.",
    failed: "I couldn't check that just now.",
    done: "Is there anything else I can help with?",
    approval: "I've asked a teammate to approve this. I'll carry on here as soon as they do.",
    stillWaiting: "A teammate still needs to approve this. I'll carry on here as soon as they do.",
    denied: "A teammate decided not to go ahead with this.",
    expired: "This couldn't be approved in time.",
  },
  fr: {
    retry: "Désolé, je n'ai pas bien compris.",
    verify: "Je ne peux vérifier cela que pour les clients connectés.",
    failed: "Je n'ai pas pu vérifier cela pour le moment.",
    done: "Puis-je vous aider pour autre chose ?",
    approval: "J'ai demandé à un membre de l'équipe de valider cela. Je reprends ici dès que c'est fait.",
    stillWaiting: "Un membre de l'équipe doit encore valider cela. Je reprends ici dès que c'est fait.",
    denied: "Un membre de l'équipe a décidé de ne pas donner suite.",
    expired: "Cela n'a pas pu être validé à temps.",
  },
  es: {
    retry: "Perdona, no lo he entendido.",
    verify: "Solo puedo consultarlo para clientes que hayan iniciado sesión.",
    failed: "No he podido comprobarlo ahora mismo.",
    done: "¿Puedo ayudarte con algo más?",
    approval: "He pedido a alguien del equipo que lo apruebe. Continuaré aquí en cuanto lo haga.",
    stillWaiting: "Alguien del equipo todavía tiene que aprobarlo. Continuaré aquí en cuanto lo haga.",
    denied: "Alguien del equipo ha decidido no seguir adelante.",
    expired: "No se ha podido aprobar a tiempo.",
  },
  de: {
    retry: "Entschuldigung, das habe ich nicht verstanden.",
    verify: "Das kann ich nur für angemeldete Kunden nachsehen.",
    failed: "Das konnte ich gerade nicht prüfen.",
    done: "Kann ich Ihnen sonst noch helfen?",
    approval: "Ich habe ein Teammitglied gebeten, das freizugeben. Ich mache hier weiter, sobald es freigegeben ist.",
    stillWaiting: "Ein Teammitglied muss das noch freigeben. Ich mache hier weiter, sobald es freigegeben ist.",
    denied: "Ein Teammitglied hat entschieden, das nicht auszuführen.",
    expired: "Das konnte nicht rechtzeitig freigegeben werden.",
  },
  pt: {
    retry: "Desculpe, não percebi.",
    verify: "Só posso consultar isso para clientes com sessão iniciada.",
    failed: "Não consegui verificar isso agora.",
    done: "Posso ajudar com mais alguma coisa?",
    approval: "Pedi a um membro da equipa que aprove isto. Continuo aqui assim que o fizer.",
    stillWaiting: "Um membro da equipa ainda tem de aprovar isto. Continuo aqui assim que o fizer.",
    denied: "Um membro da equipa decidiu não avançar com isto.",
    expired: "Não foi possível aprovar isto a tempo.",
  },
  "pt-BR": {
    retry: "Desculpe, não entendi.",
    verify: "Só consigo consultar isso para clientes que fizeram login.",
    failed: "Não consegui verificar isso agora.",
    done: "Posso ajudar com mais alguma coisa?",
    approval: "Pedi a alguém da equipe para aprovar isso. Continuo aqui assim que aprovarem.",
    stillWaiting: "Alguém da equipe ainda precisa aprovar isso. Continuo aqui assim que aprovarem.",
    denied: "Alguém da equipe decidiu não seguir com isso.",
    expired: "Não foi possível aprovar isso a tempo.",
  },
  it: {
    retry: "Scusa, non ho capito.",
    verify: "Posso verificarlo solo per i clienti che hanno effettuato l'accesso.",
    failed: "Non sono riuscita a verificarlo in questo momento.",
    done: "Posso aiutarti in altro?",
    approval: "Ho chiesto a un membro del team di approvarlo. Continuo qui appena lo fa.",
    stillWaiting: "Un membro del team deve ancora approvarlo. Continuo qui appena lo fa.",
    denied: "Un membro del team ha deciso di non procedere.",
    expired: "Non è stato possibile approvarlo in tempo.",
  },
  nl: {
    retry: "Sorry, dat begreep ik niet.",
    verify: "Ik kan dat alleen opzoeken voor klanten die zijn ingelogd.",
    failed: "Ik kon dat nu niet controleren.",
    done: "Kan ik je ergens anders mee helpen?",
    approval: "Ik heb een teamlid gevraagd dit goed te keuren. Ik ga hier verder zodra dat gebeurd is.",
    stillWaiting: "Een teamlid moet dit nog goedkeuren. Ik ga hier verder zodra dat gebeurd is.",
    denied: "Een teamlid heeft besloten dit niet door te zetten.",
    expired: "Dit kon niet op tijd worden goedgekeurd.",
  },
  ar: {
    retry: "عذرًا، لم أفهم ذلك.",
    verify: "لا يمكنني البحث عن ذلك إلا للعملاء الذين سجّلوا الدخول.",
    failed: "لم أتمكن من التحقق من ذلك الآن.",
    done: "هل هناك أي شيء آخر يمكنني مساعدتك فيه؟",
    approval: "طلبتُ من أحد أعضاء الفريق الموافقة على ذلك. سأتابع هنا بمجرد موافقته.",
    stillWaiting: "لا يزال أحد أعضاء الفريق بحاجة إلى الموافقة على ذلك. سأتابع هنا بمجرد موافقته.",
    denied: "قرر أحد أعضاء الفريق عدم المتابعة في ذلك.",
    expired: "تعذّرت الموافقة على ذلك في الوقت المحدد.",
  },
};
const phrases = (locale: string) => PHRASES[locale] ?? PHRASES[locale.split("-")[0]] ?? PHRASES.en;

/* ------------------------------------------------------------------------------------------ */
/* Running in a conversation                                                                   */

/** At most this many steps run for one customer message (a loop in the plan stops here). */
const STEP_BUDGET = 50;
/** Tries at an input before she hands over. */
const MAX_RETRIES = 2;
/** D3: how long a write waits for a teammate's approval. */
export const APPROVAL_HOURS = 24;

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
/** D3: an approval a write step asks for, written with the turn. */
export type ApprovalRequest = {
  id: string;
  connectorId: string;
  connector: string;
  version: number;
  step: number;
  method: string;
  /** What would be sent, sensitive inputs redacted. */
  summary: Record<string, unknown>;
  expiresAt: string;
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
  /** D3: an approval to ask a teammate for (a team-only note), with the run waiting on it. */
  approval: ApprovalRequest | null;
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

/** One write's idempotency key: the same for every attempt at this step of this run. */
async function idempotencyKey(runId: string, step: number) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`relay-write:${runId}:${step}`)));
  return [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Ctx = {
  w: string;
  agentId: string;
  conversationId: string;
  locale: string;
  facts: Facts;
  verification: { rules: VerificationRule[]; fallback: Requirement };
};
type State = {
  run: RunRow;
  starting: boolean;
  values: Record<string, unknown>;
  step: number;
  waitingFor: string | null;
  retries: number;
  messages: string[];
  status: ProcedureTurn["status"];
  reason: string;
  stepsTaken: string[];
  approval: ApprovalRequest | null;
};
const stateOf = (run: RunRow, starting: boolean): State => ({
  run,
  starting,
  values: { ...run.values },
  step: run.step,
  waitingFor: run.waiting_for,
  retries: run.retries,
  messages: [],
  status: "waiting",
  reason: "",
  stepsTaken: [],
  approval: null,
});

/**
 * Runs the plan from where it stands until it needs the customer (or a teammate's approval) or
 * ends. `approved` is an approval granted for the write at the current step (a resumed run).
 */
async function advance(connect: Connect, env: ProcedureEnvironment, ctx: Ctx, st: State, approved: string | null) {
  const { w } = ctx;
  const plan = st.run.plan;
  const say = phrases(ctx.locale);
  const finish = (s: ProcedureTurn["status"], why: string) => {
    st.status = s;
    st.reason = why;
  };
  const failed = (why: string) => {
    st.messages.push(plan.onFailure ? fill(plan.onFailure, st.values) : say.failed);
    finish("escalated", why);
  };
  for (let budget = 0; st.status === "waiting" && budget < STEP_BUDGET; budget++) {
    if (budget === STEP_BUDGET - 1) {
      finish("escalated", "The procedure went round in a loop.");
      break;
    }
    const s = plan.steps[st.step];
    if (!s) {
      finish("abandoned", "The procedure ran out of steps.");
      break;
    }
    st.stepsTaken.push(String(st.step + 1));
    if (s.kind === "ask") {
      const i = plan.inputs.find((x) => x.name === s.input)!;
      const v = st.values[i.name];
      if (v !== undefined && v !== null && v !== "") {
        st.step++;
        continue;
      }
      st.waitingFor = i.name;
      st.messages.push(i.question);
      st.reason = `Asked for ${i.label}.`;
      break;
    }
    if (s.kind === "call") {
      // Approved writes passed these checks when their approval was asked for.
      if (!approved) {
        const check = verified(ctx.verification.rules, ctx.verification.fallback, ctx.facts, "messenger");
        if (!check.ok) {
          st.messages.push(say.verify);
          finish("escalated", `${s.connector} needs a signed-in customer${check.rule ? ` (verification rule “${check.rule}”)` : " (the fallback rule)"}, and this one isn't.`);
          break;
        }
      }
      if (!env.connectors) {
        failed(`${s.connector} can't run here: connectors aren't configured.`);
        break;
      }
      const pinned = await tenant(connect, w, async (db) => {
        const version = await pinnedVersion(db, w, s.connectorId, ctx.conversationId);
        const def = version
          ? (
              await db.query<{ definition: Definition }>(
                "SELECT definition FROM ai_connector_versions WHERE workspace_id=$1 AND connector_id=$2 AND version=$3",
                [w, s.connectorId, version],
              )
            ).rows[0]?.definition
          : null;
        return version && def ? { version, def } : null;
      });
      if (!pinned) {
        failed(`${s.connector} isn't published any more.`);
        break;
      }
      const write = pinned.def.access === "write";
      const given = Object.fromEntries(plan.inputs.map((i) => [i.name, st.values[i.name]]));
      // D3: a write changes things, so only for a customer the website verified, whatever the rules.
      if (write && !ctx.facts.signedIn) {
        st.messages.push(say.verify);
        finish("escalated", `${s.connector} changes things, so it needs a signed-in customer, and this one isn't. Nothing was sent.`);
        break;
      }
      if (write && pinned.def.approval === "always" && !approved) {
        const id = crypto.randomUUID();
        st.approval = {
          id,
          connectorId: s.connectorId,
          connector: s.connector,
          version: pinned.version,
          step: st.step,
          method: pinned.def.method,
          summary: Object.fromEntries(
            pinned.def.inputs
              .filter((i) => i.source === "customer")
              .map((i) => {
                const v = given[i.name];
                const empty = v === undefined || v === null || v === "";
                return [i.label, empty ? null : i.sensitive ? "[redacted]" : v];
              }),
          ),
          expiresAt: new Date(Date.now() + APPROVAL_HOURS * 3_600_000).toISOString(),
        };
        st.waitingFor = `approval:${id}`;
        st.messages.push(say.approval);
        st.reason = `Waiting for a teammate to approve ${s.connector}.`;
        break;
      }
      const call = await runConnector(connect, env.connectors, w, {
        connectorId: s.connectorId,
        version: pinned.version,
        values: given,
        source: "agent",
        invokedBy: ctx.agentId,
        conversationId: ctx.conversationId,
        approvalId: approved ?? undefined,
        idempotencyKey: write ? await idempotencyKey(st.run.id, st.step) : undefined,
      });
      approved = null;
      if (call.result !== "ok") {
        failed(`${s.connector} failed (${call.result}${call.error ? `: ${call.error}` : ""}).`);
        break;
      }
      Object.assign(st.values, call.outputs);
      st.step++;
      continue;
    }
    if (s.kind === "branch") {
      st.step = holds(s, st.values) ? s.to : st.step + 1;
      continue;
    }
    if (s.kind === "say") {
      st.messages.push(fill(s.text, st.values));
      st.step++;
      continue;
    }
    if (s.kind === "goto") {
      st.step = s.to;
      continue;
    }
    if (s.kind === "end") {
      if (s.outcome === "resolved") {
        if (!st.messages.length) st.messages.push(say.done);
        finish("resolved", "Resolved.");
      } else if (s.outcome === "escalated") finish("escalated", "Its plan hands over.");
      else finish("abandoned", "Its plan stops here; she answers as usual from now on.");
      break;
    }
  }
}

/** The turn: what she says, and a commit that writes the run (checked against its version). */
function turnOf(ctx: Ctx, st: State, calls: ModelCall[]): ProcedureTurn {
  const { w } = ctx;
  const r = st.run;
  if (st.status === "waiting" && !st.reason) st.reason = "Waiting for the customer.";
  const record = `Procedure “${r.name}” (version ${r.procedure_version})${st.stepsTaken.length ? `, steps ${st.stepsTaken.join(", ")}` : ""}: ${st.reason}`;
  return {
    runId: r.id,
    procedure: r.name,
    version: r.procedure_version,
    messages: st.messages,
    status: st.status,
    reason: record,
    calls,
    approval: st.approval,
    commit: async (db) => {
      const ended = st.status !== "waiting";
      const values = JSON.stringify(st.values);
      if (st.starting) {
        const inserted = await db.query(
          `INSERT INTO ai_procedure_runs(workspace_id,id,conversation_id,procedure_id,procedure_version,status,step,waiting_for,retries,"values",reason,ended_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${ended ? "now()" : "NULL"})
           ON CONFLICT DO NOTHING RETURNING id`,
          [w, r.id, ctx.conversationId, r.procedure_id, r.procedure_version, st.status, st.step, st.waitingFor, st.retries, values, st.reason],
        );
        return inserted.rows.length > 0;
      }
      const updated = await db.query(
        `UPDATE ai_procedure_runs SET status=$3,step=$4,waiting_for=$5,retries=$6,"values"=$7,reason=$8,updated_at=now(),
           ended_at=${ended ? "now()" : "NULL"},version=version+1
         WHERE workspace_id=$1 AND id=$2 AND status='waiting' AND version::text=$9 RETURNING id`,
        [w, r.id, st.status, st.step, st.waitingFor, st.retries, values, st.reason, r.version],
      );
      return updated.rows.length > 0;
    },
  };
}

const RUN_FIELDS = `r.id,r.procedure_id,r.procedure_version,r.step,r.waiting_for,r.retries,r."values",r.version::text AS version,p.name,v.plan
  FROM ai_procedure_runs r JOIN ai_procedures p ON p.workspace_id=r.workspace_id AND p.id=r.procedure_id
  JOIN ai_procedure_versions v ON v.workspace_id=r.workspace_id AND v.procedure_id=r.procedure_id AND v.version=r.procedure_version`;
async function verificationOf(db: Sql, w: string, agentId: string) {
  const a = (
    await db.query<{ verification_rules: VerificationRule[]; verification_fallback: Requirement }>(
      "SELECT verification_rules,verification_fallback FROM ai_agents WHERE workspace_id=$1 AND id=$2",
      [w, agentId],
    )
  ).rows[0];
  return { rules: a.verification_rules, fallback: a.verification_fallback };
}

/**
 * A customer message's turn in a procedure, or null when none applies (Zoe answers as usual). A
 * person asked for, or an escalation rule, ends a running procedure (and cancels an approval it
 * waits on) and leaves the message to her usual handover. Connector calls happen here, outside
 * any transaction; `commit` writes the run.
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
      await db.query<RunRow>(`SELECT ${RUN_FIELDS} WHERE r.workspace_id=$1 AND r.conversation_id=$2 AND r.status='waiting'`, [
        w,
        input.conversationId,
      ])
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
    // An escalation rule that matches this customer hands over before anything else (A2b).
    const escalation = matchRule(await rulesOf(db, w, input.agentId), input.facts);
    return { active, live, verification: await verificationOf(db, w, input.agentId), escalation };
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
        const why = wantsPerson ? "The customer asked for a person." : "An escalation rule matched.";
        await db.query(
          `UPDATE ai_procedure_runs SET status='abandoned',reason=$3,ended_at=now(),updated_at=now(),version=version+1
           WHERE workspace_id=$1 AND id=$2 AND status='waiting'`,
          [w, r.id, why],
        );
        await db.query(
          `UPDATE ai_action_approvals SET status='cancelled',decided_at=now(),note=$3,version=version+1
           WHERE workspace_id=$1 AND run_id=$2 AND status='pending'`,
          [w, r.id, why],
        );
      },
    };
  }

  const ctx: Ctx = {
    w,
    agentId: input.agentId,
    conversationId: input.conversationId,
    locale: input.locale,
    facts: input.facts,
    verification: loaded.verification,
  };
  const st = stateOf(run, starting);
  const say = phrases(input.locale);
  if (st.waitingFor?.startsWith("approval:")) {
    // D3: a teammate hasn't decided yet; nothing moves until they do.
    st.messages.push(say.stillWaiting);
    st.reason = "Still waiting for a teammate's approval.";
    return turnOf(ctx, st, calls);
  }
  if (starting) {
    // Values already in the first message (by pattern) needn't be asked for.
    for (const i of run.plan.inputs) {
      const v = i.pattern ? extract(i, input.question, false) : null;
      if (v !== null) st.values[i.name] = v;
    }
  } else if (st.waitingFor) {
    const wanted = run.plan.inputs.find((i) => i.name === st.waitingFor)!;
    const v = extract(wanted, input.question, true);
    if (v === null) {
      st.retries++;
      if (st.retries > MAX_RETRIES) {
        st.status = "escalated";
        st.reason = `She couldn't get ${wanted.label} after ${MAX_RETRIES + 1} tries.`;
      } else {
        st.messages.push(`${say.retry} ${wanted.question}`);
        st.reason = `Asked again for ${wanted.label}.`;
      }
      return turnOf(ctx, st, calls);
    }
    st.values[wanted.name] = v;
    st.waitingFor = null;
    st.retries = 0;
    st.step++;
  }
  await advance(connect, env, ctx, st, null);
  return turnOf(ctx, st, calls);
}

/**
 * D3: a teammate decided (or the approval expired): the run waiting on it moves on. Approved, the
 * write runs (with its approval and idempotency key) and the plan continues; denied or expired, the
 * customer is told and handed over. The caller posts the turn.
 */
export async function resumeTurn(
  connect: Connect,
  env: ProcedureEnvironment,
  w: string,
  approvalId: string,
): Promise<{ turn: ProcedureTurn; conversationId: string; agentId: string; locale: string } | null> {
  const loaded = await tenant(connect, w, async (db) => {
    const a = (
      await db.query<{ status: string; run_id: string; conversation_id: string; connector: string | null; note: string }>(
        `SELECT a.status,a.run_id,a.conversation_id,a.note,(SELECT c.name FROM ai_connectors c WHERE c.workspace_id=a.workspace_id AND c.id=a.connector_id) AS connector
         FROM ai_action_approvals a WHERE a.workspace_id=$1 AND a.id=$2`,
        [w, approvalId],
      )
    ).rows[0];
    if (!a || a.status === "pending" || a.status === "cancelled") return null;
    const run = (
      await db.query<RunRow>(`SELECT ${RUN_FIELDS} WHERE r.workspace_id=$1 AND r.id=$2 AND r.status='waiting' AND r.waiting_for=$3`, [
        w,
        a.run_id,
        `approval:${approvalId}`,
      ])
    ).rows[0];
    if (!run) return null;
    const agentId = (await db.query<{ id: string }>("SELECT agent_id AS id FROM ai_procedures WHERE workspace_id=$1 AND id=$2", [w, run.procedure_id])).rows[0].id;
    const locale =
      (
        await db.query<{ language: string | null }>(
          "SELECT language FROM ai_answers WHERE workspace_id=$1 AND conversation_id=$2 AND language IS NOT NULL ORDER BY created_at DESC LIMIT 1",
          [w, a.conversation_id],
        )
      ).rows[0]?.language ?? "en";
    // A resumed job that ran this write already (and failed afterwards) never sends it again.
    const attempted =
      (await db.query("SELECT 1 FROM ai_connector_calls WHERE workspace_id=$1 AND approval_id=$2 LIMIT 1", [w, approvalId])).rows.length > 0;
    return { a, run, agentId, locale, attempted, verification: await verificationOf(db, w, agentId) };
  });
  if (!loaded) return null;
  const { a, run, agentId, locale } = loaded;
  const ctx: Ctx = {
    w,
    agentId,
    conversationId: a.conversation_id,
    locale,
    // Checked when the approval was asked for; an approved write doesn't check again.
    facts: { signedIn: true, emailDomains: [], brand: "", language: locale, page: "", tags: [], attributes: {} },
    verification: loaded.verification,
  };
  const st = stateOf(run, false);
  st.waitingFor = null;
  const say = phrases(locale);
  if (a.status === "approved" && loaded.attempted) {
    st.messages.push(phrases(locale).failed);
    st.status = "escalated";
    st.reason = `${a.connector ?? "The write"} was already attempted once under this approval; it isn't sent again. Check the service before retrying.`;
  } else if (a.status === "approved") await advance(connect, env, ctx, st, approvalId);
  else {
    st.messages.push(a.status === "denied" ? say.denied : say.expired);
    st.status = "escalated";
    st.reason =
      a.status === "denied"
        ? `A teammate denied ${a.connector ?? "the write"}${a.note ? `: “${a.note}”` : ""}. Nothing was sent.`
        : `Nobody approved ${a.connector ?? "the write"} within ${APPROVAL_HOURS} hours. Nothing was sent.`;
  }
  return { turn: turnOf(ctx, st, []), conversationId: a.conversation_id, agentId, locale };
}

/** D3: approvals past their 24 hours expire; each one's run is then resumed (and handed over). */
export async function expireApprovals(connect: Connect, w: string) {
  return tenant(connect, w, async (db) => {
    const expired = (
      await db.query<{ id: string }>(
        `UPDATE ai_action_approvals SET status='expired',decided_at=now(),version=version+1
         WHERE workspace_id=$1 AND status='pending' AND expires_at<=now() RETURNING id`,
        [w],
      )
    ).rows;
    for (const e of expired) await enqueueJob(db, w, "procedure.resume", { approvalId: e.id }, {});
    return expired.length;
  });
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
    await db.query<{ id: string; name: string; definition: Definition; writes_enabled: boolean }>(
      `SELECT c.id,c.name,v.definition,c.writes_enabled FROM ai_connectors c
       JOIN ai_connector_versions v ON v.workspace_id=c.workspace_id AND v.connector_id=c.id AND v.version=c.live_version
       WHERE c.workspace_id=$1 AND NOT c.archived`,
      [w],
    )
  ).rows.map((c) => ({
    id: c.id,
    name: c.name,
    // Only what it can't do without: an optional input it may simply not get.
    asks: c.definition.inputs.filter((i) => i.source === "customer" && i.required).map((i) => i.name),
    outputs: c.definition.outputs.map((o) => o.name),
    write: c.definition.access === "write",
    writesEnabled: c.writes_enabled,
    approval: c.definition.approval !== "never",
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

/* ------------------------------------------------------------------------------------------ */
/* Approvals (D3)                                                                              */

/** One approval, for the card in the conversation (anyone who can read conversations). */
export async function readApproval(db: Sql, w: string, principal: string, id: string) {
  await authorize(db, w, principal, "conversations.read");
  const a = (
    await db.query<{
      id: string;
      conversation_id: string;
      connector: string | null;
      connector_version: number;
      method: string | null;
      summary: Record<string, unknown>;
      status: string;
      requested_at: string;
      expires_at: string;
      decided_by_name: string | null;
      decided_at: string | null;
      note: string;
      version: string;
      result: string | null;
    }>(
      `SELECT a.id,a.conversation_id,c.name AS connector,a.connector_version,v.definition->>'method' AS method,a.summary,a.status,a.requested_at,a.expires_at,
         t.name AS decided_by_name,a.decided_at,a.note,a.version::text AS version,
         (SELECT k.result FROM ai_connector_calls k WHERE k.workspace_id=a.workspace_id AND k.approval_id=a.id ORDER BY k.created_at DESC LIMIT 1) AS result
       FROM ai_action_approvals a
       LEFT JOIN ai_connectors c ON c.workspace_id=a.workspace_id AND c.id=a.connector_id
       LEFT JOIN ai_connector_versions v ON v.workspace_id=a.workspace_id AND v.connector_id=a.connector_id AND v.version=a.connector_version
       LEFT JOIN teammates t ON t.workspace_id=a.workspace_id AND t.id=a.decided_by
       WHERE a.workspace_id=$1 AND a.id=$2`,
      [w, id],
    )
  ).rows[0];
  assert(a, "APPROVAL_NOT_FOUND", "That approval isn't available.", 404);
  const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
  return {
    id: a.id,
    conversationId: a.conversation_id,
    connector: a.connector ?? "A removed connector",
    method: a.method,
    summary: a.summary,
    status: a.status,
    requestedAt: iso(a.requested_at),
    expiresAt: iso(a.expires_at),
    decidedBy: a.decided_by_name,
    decidedAt: iso(a.decided_at),
    note: a.note,
    version: a.version,
    // What happened when it ran (after approval), from the audit.
    result: a.result,
  };
}

/**
 * A teammate (anyone who can reply in conversations) approves or denies a write, once, by
 * version, with an optional note. The procedure resumes in a job.
 */
export async function decideApproval(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>) {
  const t = await authorize(db, w, principal, "conversations.reply");
  assert(await actionsEnabled(db, w), "ACTIONS_DISABLED", "Procedures are not enabled for this workspace.", 404);
  return once(db, w, "ai-approval:" + principal, key, p, async () => {
    const decision = p.decision;
    if (decision !== "approve" && decision !== "deny") throw new DomainError("INVALID_APPROVAL", "Approve or deny it.", 400);
    const note = typeof p.note === "string" ? p.note.trim() : "";
    if (note.length > 1000) throw new DomainError("INVALID_APPROVAL", "Keep the note to 1,000 characters.", 400);
    const id = String(p.id ?? "");
    const row = (
      await db.query<{ status: string; version: string }>("SELECT status,version::text AS version FROM ai_action_approvals WHERE workspace_id=$1 AND id=$2", [
        w,
        id,
      ])
    ).rows[0];
    assert(row, "APPROVAL_NOT_FOUND", "That approval isn't available.", 404);
    if (row.status !== "pending")
      throw new DomainError("APPROVAL_DECIDED", `This was already ${row.status === "approved" ? "approved" : row.status === "denied" ? "denied" : row.status}.`, 409);
    if (row.version !== String(p.version ?? "")) throw new DomainError("APPROVAL_CHANGED", "This approval changed. Reload to see it.", 409);
    await db.query(
      `UPDATE ai_action_approvals SET status=$3,decided_by=$4,decided_at=now(),note=$5,version=version+1
       WHERE workspace_id=$1 AND id=$2 AND status='pending'`,
      [w, id, decision === "approve" ? "approved" : "denied", t.id, note],
    );
    await enqueueJob(db, w, "procedure.resume", { approvalId: id }, { teammateId: t.id });
    return readApproval(db, w, principal, id);
  });
}
