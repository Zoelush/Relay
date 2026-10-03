import { tenant, type Connect, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import {
  access,
  append,
  conversation,
  syncUnread,
  type Conversation,
} from "./conversations";
import { customerReply } from "./unread";
import type { IndexEnvironment } from "./knowledge-index";
import {
  PROMPT_VERSION,
  type AnswerModel,
  type ModelReply,
  type RerankPort,
  type Turn,
} from "./ai-model";
import { retrieveForAgent, searchable, type Retrieval } from "./ai-retrieval";

/**
 * The AI agent (phase 08, step A1; docs/AI_STEP1.md), behind `ai_agent_v1`: it answers customers
 * in the messenger from the knowledge store.
 *
 * A customer message in a messenger conversation no teammate has taken on (unassigned, and no
 * teammate reply yet) queues an `ai.reply` job. The job answers every customer message since the
 * last reply as one question:
 *
 * 1. **Retrieve** passages the customer may see (`retrieveForAgent`).
 * 2. **Gate:** if the best passage's relevance is below the agent's threshold, the agent says it
 *    doesn't know and offers a person, without asking the model. This is code, not a prompt.
 * 3. **Answer:** the model replies with an answer whose every sentence cites a given passage, a
 *    clarifying question, or "unknown". Anything else, or an answer citing nothing it was given,
 *    is treated as "unknown".
 * 4. **Reply** as an `ai_reply` part with its sources (titles and help center paths: nothing
 *    else reaches the customer), and record the attempt in `ai_answers` for teammates.
 *
 * The reply is re-checked when written: if a teammate replied or took the conversation while the
 * agent worked, or the customer wrote again, nothing is sent.
 *
 * TODO(phase 08 A2): escalation, handover summaries, routing after handover and the AI state.
 * TODO(phase 08 B1): several agents, guidance, content targeting and language detection.
 */
export type AiEnvironment = {
  model: AnswerModel;
  rerank: RerankPort;
  index: IndexEnvironment;
};
export const DEFAULT_AGENT = "default";
/** At most this many earlier messages go to the model. */
const HISTORY = 10;
/**
 * A model that keeps failing doesn't leave the customer waiting: from this attempt on, the agent
 * says it doesn't know and offers a person (recorded as "failed").
 */
const GIVE_UP_AFTER = 3;

/** Fixed replies, never written by the model. */
const STRINGS: Record<string, { unknown: string; greeting: string }> = {
  en: {
    unknown:
      "I'm sorry, I couldn't find an answer to that in our help content. Would you like me to connect you with someone from the team?",
    greeting: "Hi! What can I help you with?",
  },
  fr: {
    unknown:
      "Désolé, je n'ai pas trouvé de réponse dans notre aide. Voulez-vous que je vous mette en relation avec quelqu'un de l'équipe ?",
    greeting: "Bonjour ! Comment puis-je vous aider ?",
  },
  es: {
    unknown:
      "Lo siento, no encontré una respuesta en nuestra ayuda. ¿Quieres que te ponga en contacto con alguien del equipo?",
    greeting: "¡Hola! ¿En qué puedo ayudarte?",
  },
  de: {
    unknown:
      "Leider habe ich dazu in unserer Hilfe keine Antwort gefunden. Soll ich Sie mit jemandem aus dem Team verbinden?",
    greeting: "Hallo! Wie kann ich helfen?",
  },
  pt: {
    unknown:
      "Desculpe, não encontrei uma resposta na nossa ajuda. Quer que eu o ponha em contacto com alguém da equipa?",
    greeting: "Olá! Como posso ajudar?",
  },
};
const strings = (locale: string) =>
  STRINGS[locale] ?? STRINGS[locale.split("-")[0]] ?? STRINGS.en;

export async function aiEnabled(db: Sql, w: string) {
  return (
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='ai_agent_v1' AND enabled",
        [w],
      )
    ).rows.length > 0
  );
}
async function agentOf(db: Sql, w: string) {
  await db.query(
    "INSERT INTO ai_agents(workspace_id,id,name) VALUES($1,$2,'AI agent') ON CONFLICT DO NOTHING",
    [w, DEFAULT_AGENT],
  );
  return (
    await db.query<{
      id: string;
      name: string;
      enabled: boolean;
      confidence_threshold: number;
    }>(
      "SELECT id,name,enabled,confidence_threshold FROM ai_agents WHERE workspace_id=$1 AND id=$2",
      [w, DEFAULT_AGENT],
    )
  ).rows[0];
}

/** Whether a teammate has taken the conversation on: assigned, or replied. */
async function teammateInvolved(db: Sql, w: string, c: Conversation) {
  if (c.assigned) return true;
  return (
    (
      await db.query(
        "SELECT 1 FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND kind='teammate_reply' LIMIT 1",
        [w, c.id],
      )
    ).rows.length > 0
  );
}

/**
 * Queues an answer to a customer's message, in the transaction that wrote it, when the agent is
 * on and no teammate has taken the conversation on.
 */
export async function queueAiReply(
  db: Sql,
  w: string,
  c: Conversation,
  partId: string,
) {
  if ((c.channel ?? "messenger") !== "messenger") return null;
  if (c.visibility === "internal") return null;
  if (!(await aiEnabled(db, w))) return null;
  const agent = await agentOf(db, w);
  if (!agent.enabled || (await teammateInvolved(db, w, c))) return null;
  return enqueueJob(db, w, "ai.reply", { conversationId: c.id, partId }, {});
}

type Context = {
  c: Conversation;
  agent: Awaited<ReturnType<typeof agentOf>>;
  question: string;
  history: Turn[];
  chain: string[];
  signedIn: boolean;
};

/** Why the agent won't answer this message now, if it won't. */
async function skipReason(db: Sql, w: string, c: Conversation, partId: string) {
  if (!(await aiEnabled(db, w))) return "The AI agent is off.";
  const agent = await agentOf(db, w);
  if (!agent.enabled) return "The AI agent is off.";
  if (await teammateInvolved(db, w, c))
    return "A teammate has taken the conversation on.";
  const question = (
    await db.query<{ seq: string }>(
      "SELECT seq FROM conversation_parts WHERE workspace_id=$1 AND id=$2",
      [w, partId],
    )
  ).rows[0];
  const newer = (
    await db.query(
      "SELECT 1 FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND kind='customer_message' AND seq>$3 LIMIT 1",
      [w, c.id, question.seq],
    )
  ).rows.length;
  if (newer) return "The customer wrote again; the newer message is answered.";
  return null;
}

async function context(
  db: Sql,
  w: string,
  c: Conversation,
  partId: string,
): Promise<Context> {
  const agent = await agentOf(db, w);
  const parts = (
    await db.query<{
      id: string;
      kind: string;
      body: string;
      seq: string;
    }>(
      // Public messages only: internal notes and system events never reach the model.
      `SELECT id,kind,body,seq FROM conversation_parts
       WHERE workspace_id=$1 AND conversation_id=$2 AND audience='public'
         AND kind IN ('customer_message','teammate_reply','ai_reply')
         AND NOT COALESCE((data->>'deleted')::boolean,false)
         AND NOT EXISTS(SELECT 1 FROM conversation_parts s WHERE s.workspace_id=conversation_parts.workspace_id AND s.supersedes_id=conversation_parts.id)
       ORDER BY seq`,
      [w, c.id],
    )
  ).rows;
  // The question: every customer message since the last reply, up to this one.
  const at = parts.findIndex((p) => p.id === partId);
  let from = at;
  while (from > 0 && parts[from - 1].kind === "customer_message") from--;
  const question = parts
    .slice(from, at + 1)
    .map((p) => p.body.trim())
    .filter(Boolean)
    .join("\n");
  const history = parts
    .slice(Math.max(0, from - HISTORY), from)
    .map((p): Turn => ({
      from: p.kind === "customer_message" ? "customer" : "agent",
      text: p.body,
    }));
  // The customer's language: their messenger session's, then the brand's.
  const locale =
    (
      await db.query<{ locale: string }>(
        "SELECT locale FROM messenger_sessions WHERE workspace_id=$1 AND identity_id=$2 AND brand_id=$3 ORDER BY expires_at DESC LIMIT 1",
        [w, c.primary_identity_id, c.brand_id],
      )
    ).rows[0]?.locale ?? null;
  const brandLocale =
    (
      await db.query<{ locale: string | null }>(
        "SELECT settings->>'locale' AS locale FROM brands WHERE workspace_id=$1 AND id=$2",
        [w, c.brand_id],
      )
    ).rows[0]?.locale ?? "en";
  const canonical = (l: string) => {
    try {
      return Intl.getCanonicalLocales(l)[0];
    } catch {
      return null;
    }
  };
  const chain = [
    ...new Set(
      [locale, locale?.split("-")[0], brandLocale, brandLocale.split("-")[0]]
        .filter((l): l is string => !!l)
        .map(canonical)
        .filter((l): l is string => !!l),
    ),
  ];
  const signedIn =
    (
      await db.query<{ kind: string }>(
        "SELECT kind FROM identities WHERE workspace_id=$1 AND id=$2",
        [w, c.primary_identity_id],
      )
    ).rows[0]?.kind === "user";
  return { c, agent, question, history, chain, signedIn };
}

/** Each cited record's title, and its help center path when it is published there for this brand. */
async function sources(
  db: Sql,
  w: string,
  brandId: string,
  cited: { recordId: string; title: string; locale: string }[],
) {
  const out: { title: string; path?: string }[] = [];
  for (const s of cited) {
    const place = (
      await db.query<{ center: string; slug: string; locale: string }>(
        `SELECT h.slug AS center,l.slug,l.locale FROM help_centers h
         JOIN knowledge_records r ON r.workspace_id=h.workspace_id AND r.id=$3 AND r.source='article' AND r.for_help_center
         JOIN knowledge_locales l ON l.workspace_id=r.workspace_id AND l.record_id=r.id AND l.status='published' AND l.slug IS NOT NULL
           AND l.locale=ANY(h.locales)
         WHERE h.workspace_id=$1 AND h.brand_id=$2
           AND EXISTS(SELECT 1 FROM help_placements p JOIN help_nodes n ON n.workspace_id=p.workspace_id AND n.id=p.node_id
             WHERE p.workspace_id=h.workspace_id AND p.record_id=r.id AND n.center_id=h.id AND NOT n.archived)
         ORDER BY l.locale=$4 DESC,l.locale LIMIT 1`,
        [w, brandId, s.recordId, s.locale],
      )
    ).rows[0];
    out.push({
      title: s.title,
      ...(place
        ? {
            path: `/help/${encodeURIComponent(w)}/${place.center}/${place.locale}/articles/${place.slug}`,
          }
        : {}),
    });
  }
  return out;
}

/**
 * Checks a model reply against what it was given: an answer needs one to six sentences, each
 * citing at least one given passage, with no links. Anything else becomes "unknown".
 */
export function checkReply(
  reply: ModelReply,
  passageIds: Set<string>,
): { reply: ModelReply; reason?: string } {
  if (reply.kind === "clarify") {
    const question = reply.question.trim();
    if (!question || question.length > 300 || /https?:\/\//i.test(question))
      return {
        reply: { kind: "unknown" },
        reason: "Unusable clarifying question.",
      };
    return {
      reply: {
        kind: "clarify",
        question,
        options: reply.options
          .map((o) => o.trim())
          .filter((o) => o && o.length <= 120)
          .slice(0, 4),
      },
    };
  }
  if (reply.kind === "unknown") return { reply };
  const sentences = reply.sentences.map((s) => ({
    text: s.text.trim(),
    sources: [...new Set(s.sources)],
  }));
  if (!sentences.length || sentences.length > 6)
    return {
      reply: { kind: "unknown" },
      reason: "The answer had no usable sentences.",
    };
  for (const s of sentences) {
    if (!s.text)
      return { reply: { kind: "unknown" }, reason: "An empty sentence." };
    if (/https?:\/\/|www\./i.test(s.text))
      return {
        reply: { kind: "unknown" },
        reason: "The answer contained a link.",
      };
    if (!s.sources.length || !s.sources.every((id) => passageIds.has(id)))
      return {
        reply: { kind: "unknown" },
        reason: "A sentence cited no passage it was given.",
      };
  }
  return { reply: { kind: "answer", sentences } };
}

/** The `ai.reply` job: one answer to one customer message (or the run of messages ending in it). */
export async function runAiReply(
  connect: Connect,
  env: AiEnvironment,
  job: Job,
): Promise<{ done: boolean; result: Record<string, unknown> }> {
  const w = job.workspace_id;
  const conversationId = String(job.payload.conversationId ?? "");
  const partId = String(job.payload.partId ?? "");
  const started = Date.now();
  const prepared = await tenant(connect, w, async (db) => {
    const done = (
      await db.query(
        "SELECT 1 FROM ai_answers WHERE workspace_id=$1 AND question_part_id=$2",
        [w, partId],
      )
    ).rows.length;
    if (done) return { skip: "Already handled." };
    const c = await conversation(db, w, conversationId);
    const reason = await skipReason(db, w, c, partId);
    if (reason) {
      const agent = await agentOf(db, w);
      await record(db, w, {
        agentId: agent.id,
        conversationId: c.id,
        partId,
        outcome: "skipped",
        reason,
        threshold: agent.confidence_threshold,
      });
      return { skip: reason };
    }
    return { context: await context(db, w, c, partId) };
  });
  if ("skip" in prepared)
    return { done: true, result: { skipped: prepared.skip } };
  const ctx = prepared.context!;
  const locale = ctx.chain[0] ?? "en";
  const text = strings(locale);

  let retrieval: Retrieval = { passages: [], candidates: [], topScore: 0 };
  let outcome: "answered" | "clarified" | "unknown" | "failed";
  let reason: string;
  let body: string;
  let data: Record<string, unknown> = {};
  let cited: string[] = [];
  let model: string | null = null;
  if (!searchable(ctx.question)) {
    outcome = "clarified";
    reason = "Nothing to search for (a greeting).";
    body = text.greeting;
  } else {
    retrieval = await retrieveForAgent(
      connect,
      { index: env.index, rerank: env.rerank },
      w,
      {
        query: ctx.question,
        chain: ctx.chain,
        brandId: ctx.c.brand_id,
        signedIn: ctx.signedIn,
      },
    );
    if (
      !retrieval.passages.length ||
      retrieval.topScore < ctx.agent.confidence_threshold
    ) {
      // The hard gate: weak retrieval never reaches the model.
      outcome = "unknown";
      reason = retrieval.passages.length
        ? `Best passage scored ${retrieval.topScore.toFixed(2)}, below the threshold of ${ctx.agent.confidence_threshold.toFixed(2)}.`
        : "No passage the customer may see matched.";
      body = text.unknown;
    } else {
      model = env.model.model;
      let raw: ModelReply | null = null;
      try {
        raw = await env.model.answer({
          question: ctx.question,
          history: ctx.history,
          passages: retrieval.passages,
          locale,
          agentName: ctx.agent.name,
        });
      } catch (e) {
        // Retried by the job; after a few attempts the customer is told plainly instead.
        if (job.attempts < GIVE_UP_AFTER) throw e;
      }
      const checked = raw
        ? checkReply(raw, new Set(retrieval.passages.map((p) => p.id)))
        : null;
      const reply = checked?.reply;
      if (!checked || !reply) {
        outcome = "failed";
        reason = `The answering model failed ${job.attempts} times.`;
        body = text.unknown;
      } else if (reply.kind === "answer") {
        outcome = "answered";
        reason = "Answered from the knowledge store.";
        body = reply.sentences.map((s) => s.text).join(" ");
        const ids = new Set(reply.sentences.flatMap((s) => s.sources));
        const used = retrieval.passages.filter((p) => ids.has(p.id));
        const records = [...new Map(used.map((p) => [p.recordId, p])).values()];
        cited = records.map((p) => p.recordId);
        data = {
          sources: await tenant(connect, w, (db) =>
            sources(db, w, ctx.c.brand_id, records),
          ),
        };
      } else if (reply.kind === "clarify") {
        outcome = "clarified";
        reason = "The question could mean different things.";
        body = reply.question;
        data = reply.options.length ? { options: reply.options } : {};
      } else {
        outcome = "unknown";
        reason = checked.reason ?? "The model found no answer in the passages.";
        body = text.unknown;
      }
    }
  }

  // Written only if nothing changed while the agent worked.
  const written = await tenant(connect, w, async (db) => {
    const c = await conversation(db, w, conversationId, true);
    const late = await skipReason(db, w, c, partId);
    if (late) {
      await record(db, w, {
        agentId: ctx.agent.id,
        conversationId: c.id,
        partId,
        outcome: "skipped",
        reason: late,
        threshold: ctx.agent.confidence_threshold,
        retrieval,
        model,
      });
      return null;
    }
    const part = await append(
      db,
      w,
      c,
      { type: "ai", id: ctx.agent.id },
      "ai_reply",
      body,
      data,
    );
    await customerReply(db, w, c, part.seq);
    await syncUnread(db, w, c);
    await record(db, w, {
      agentId: ctx.agent.id,
      conversationId: c.id,
      partId,
      replyPartId: part.id,
      outcome,
      reason,
      threshold: ctx.agent.confidence_threshold,
      retrieval,
      cited,
      model,
      latency: Date.now() - started,
    });
    return part.id;
  });
  return {
    done: true,
    result: written ? { outcome, replyPartId: written } : { skipped: true },
  };
}

async function record(
  db: Sql,
  w: string,
  a: {
    agentId: string;
    conversationId: string;
    partId: string;
    replyPartId?: string;
    outcome: string;
    reason: string;
    threshold: number;
    retrieval?: Retrieval;
    cited?: string[];
    model?: string | null;
    latency?: number;
  },
) {
  await db.query(
    `INSERT INTO ai_answers(workspace_id,id,agent_id,conversation_id,question_part_id,reply_part_id,outcome,reason,top_score,threshold,passages,cited,model,prompt_version,latency_ms)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(workspace_id,question_part_id) DO NOTHING`,
    [
      w,
      crypto.randomUUID(),
      a.agentId,
      a.conversationId,
      a.partId,
      a.replyPartId ?? null,
      a.outcome,
      a.reason,
      a.retrieval ? a.retrieval.topScore : null,
      a.threshold,
      JSON.stringify(
        (a.retrieval?.candidates ?? []).map((x) => ({
          ...x,
          used: a.retrieval!.passages.some((p) => p.chunkId === x.chunkId),
        })),
      ),
      a.cited ?? [],
      a.model ?? null,
      PROMPT_VERSION,
      a.latency ?? null,
    ],
  );
  if (a.retrieval?.passages.length && a.outcome !== "skipped")
    // Counted for the content health report (phase 07 C2b), as retrievals by the AI agent.
    await db.query(
      `INSERT INTO knowledge_retrievals(workspace_id,record_id,day,purpose,count)
       SELECT $1,x,(now() AT TIME ZONE 'UTC')::date,'ai',1 FROM unnest($2::text[]) x
       ON CONFLICT(workspace_id,record_id,day,purpose) DO UPDATE SET count=knowledge_retrievals.count+1`,
      [w, [...new Set(a.retrieval.passages.map((p) => p.recordId))]],
    );
}

/** What the agent did with each message in a conversation, for teammates who can see it. */
export async function aiAnswers(
  db: Sql,
  w: string,
  principal: string,
  conversationId: string,
) {
  const c = await conversation(db, w, conversationId);
  await access(db, w, c, { type: "teammate", principal });
  const answers = (
    await db.query<{
      question_part_id: string;
      reply_part_id: string | null;
      outcome: string;
      reason: string;
      top_score: number | null;
      threshold: number;
      cited: string[];
      model: string | null;
      prompt_version: string;
      created_at: string;
    }>(
      "SELECT question_part_id,reply_part_id,outcome,reason,top_score,threshold,cited,model,prompt_version,created_at FROM ai_answers WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY created_at",
      [w, c.id],
    )
  ).rows.map((a) => ({
    questionPartId: a.question_part_id,
    replyPartId: a.reply_part_id,
    outcome: a.outcome,
    reason: a.reason,
    topScore: a.top_score === null ? null : Math.round(a.top_score * 100) / 100,
    threshold: a.threshold,
    cited: a.cited,
    model: a.model,
    promptVersion: a.prompt_version,
    at: new Date(a.created_at).toISOString(),
  }));
  return { answers };
}
