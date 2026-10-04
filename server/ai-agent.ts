import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { afterChange } from "./routing";
import { availabilityFor } from "./office-hours";
import {
  recordResolution,
  resolutionSummary,
  reverseOnHandover,
} from "./ai-resolutions";
import {
  facts,
  matchKeywords,
  matchRule,
  rulesOf,
  saveRules,
  validGuidance,
  validRules,
  validTopics,
  type Facts,
  type Topic,
} from "./ai-escalation";
import { greetingFor, listIdentities } from "./zoe";
import { applicableGuidance, draftStyle, guidanceAt } from "./zoe-guidance";
import { chooseLanguage, detectLanguage, type LanguageChoice } from "./ai-language";
import {
  ALL_LANGUAGES,
  languageName,
  type Guideline,
  type Voice,
} from "../lib/zoe-voice";
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
  guidanceLine,
  styleLines,
  type AnswerModel,
  type Classification,
  type ClassifierPort,
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
 * Handing over (step A2a; docs/AI_STEP2.md). Before answering, and after two answers it couldn't
 * give, the agent may hand the conversation to the team instead: the customer asked for a person
 * (the "Talk to a person" button, or in their own words), their sentiment turned negative, two
 * answers failed, or the agent only answers outside office hours and the team is open. A handover
 * tells the customer, writes an internal summary note for the teammate (never delivered to the
 * customer), moves the conversation to the agent's handover team so routing (phase 06) assigns
 * it, and sets the conversation's AI state. Outside office hours the agent takes a message,
 * promises when the team is back, or keeps answering until a teammate replies.
 * Step A2b (docs/AI_STEP3.md) adds escalation rules (conditions on the customer and conversation,
 * checked in code first), never-handle topics (keywords in code, and meaning by the classifier)
 * and escalation guidance (applied by the classifier, which can only decide to hand over).
 * Step Z2 (docs/AI_STEP6.md): her voice (tone, length, formality) and the workspace's answer
 * guidance go to the model as data under her rules; spam guidance goes to the classifier, and a
 * message it matches is left alone; she answers in the language the customer writes in
 * (`server/ai-language.ts`), among the languages the workspace allows. Every answer records the
 * language and the guidance version it was given.
 * TODO(phase 08 Z3): several agents (specialists) and content targeting.
 */
export type AiEnvironment = {
  model: AnswerModel;
  rerank: RerankPort;
  index: IndexEnvironment;
  /** Reads messages for handover triggers (A2a). Without it, only the fixed triggers apply. */
  classify?: ClassifierPort;
};
export const DEFAULT_AGENT = "default";
/** At most this many earlier messages go to the model. */
const HISTORY = 10;
/**
 * A model that keeps failing doesn't leave the customer waiting: from this attempt on, the agent
 * says it doesn't know and offers a person (recorded as "failed").
 */
const GIVE_UP_AFTER = 3;

/**
 * Fixed replies, never written by the model, in her nine languages (the messenger's; Z2 added
 * Brazilian Portuguese, Italian, Dutch and Arabic). As written they use each language's usual
 * register for support (vous, tú, Sie, o, você, tu, je); `FORMAL` and `INFORMAL` switch the
 * replies that address the customer (Z2). A native speaker should check the Z2 additions.
 */
type Strings = {
  unknown: string;
  greeting: string;
  /** The button under a reply the agent couldn't give (A2a). */
  person: string;
  handover: string;
  /** Outside office hours: take a message, promise when the team is back, or keep answering. */
  away: string;
  awayUntil: string;
  awayContinue: string;
  /** Under an answer from content (A3): the customer says it helped, and the thanks. */
  helped: string;
  thanks: string;
};
const STRINGS: Record<string, Strings> = {
  en: {
    unknown:
      "I'm sorry, I couldn't find an answer to that in our help content. Would you like me to connect you with someone from the team?",
    greeting: "Hi! What can I help you with?",
    person: "Talk to a person",
    handover:
      "I'm connecting you with someone from the team. They'll reply here.",
    away: "Our team is away right now. They'll reply here as soon as they're back.",
    awayUntil:
      "Our team is away right now and back {when}. They'll reply here then.",
    awayContinue:
      "Our team is away right now; they'll reply here when they're back. Until then, I'm happy to keep helping.",
    helped: "That helped",
    thanks:
      "Glad that helped! If you need anything else, just write here.",
  },
  fr: {
    unknown:
      "Désolé, je n'ai pas trouvé de réponse dans notre aide. Voulez-vous que je vous mette en relation avec quelqu'un de l'équipe ?",
    greeting: "Bonjour ! Comment puis-je vous aider ?",
    person: "Parler à quelqu'un",
    handover:
      "Je vous mets en relation avec quelqu'un de l'équipe. Il vous répondra ici.",
    away: "Notre équipe est absente pour le moment. Elle vous répondra ici dès son retour.",
    awayUntil:
      "Notre équipe est absente pour le moment et revient {when}. Elle vous répondra ici.",
    awayContinue:
      "Notre équipe est absente pour le moment et vous répondra ici à son retour. D'ici là, je peux continuer à vous aider.",
    helped: "Ça m'a aidé",
    thanks:
      "Ravi d'avoir pu aider ! Si vous avez besoin d'autre chose, écrivez-nous ici.",
  },
  es: {
    unknown:
      "Lo siento, no encontré una respuesta en nuestra ayuda. ¿Quieres que te ponga en contacto con alguien del equipo?",
    greeting: "¡Hola! ¿En qué puedo ayudarte?",
    person: "Hablar con una persona",
    handover:
      "Te pongo en contacto con alguien del equipo. Te responderá aquí.",
    away: "Nuestro equipo no está disponible ahora. Te responderá aquí en cuanto vuelva.",
    awayUntil:
      "Nuestro equipo no está disponible ahora y vuelve {when}. Te responderá aquí.",
    awayContinue:
      "Nuestro equipo no está disponible ahora y te responderá aquí cuando vuelva. Mientras tanto, puedo seguir ayudándote.",
    helped: "Me ha ayudado",
    thanks:
      "¡Me alegra haber ayudado! Si necesitas algo más, escríbenos aquí.",
  },
  de: {
    unknown:
      "Leider habe ich dazu in unserer Hilfe keine Antwort gefunden. Soll ich Sie mit jemandem aus dem Team verbinden?",
    greeting: "Hallo! Wie kann ich helfen?",
    person: "Mit einer Person sprechen",
    handover:
      "Ich verbinde Sie mit jemandem aus dem Team. Sie erhalten die Antwort hier.",
    away: "Unser Team ist gerade nicht da. Sie erhalten die Antwort hier, sobald es zurück ist.",
    awayUntil:
      "Unser Team ist gerade nicht da und ab {when} zurück. Sie erhalten die Antwort dann hier.",
    awayContinue:
      "Unser Team ist gerade nicht da und antwortet hier, sobald es zurück ist. Bis dahin helfe ich gern weiter.",
    helped: "Das hat geholfen",
    thanks:
      "Schön, dass es geholfen hat! Wenn Sie noch etwas brauchen, schreiben Sie einfach hier.",
  },
  pt: {
    unknown:
      "Desculpe, não encontrei uma resposta na nossa ajuda. Quer que eu o ponha em contacto com alguém da equipa?",
    greeting: "Olá! Como posso ajudar?",
    person: "Falar com uma pessoa",
    handover:
      "Vou pô-lo em contacto com alguém da equipa. A resposta chega aqui.",
    away: "A nossa equipa não está disponível agora. A resposta chega aqui assim que voltar.",
    awayUntil:
      "A nossa equipa não está disponível agora e volta {when}. A resposta chega aqui.",
    awayContinue:
      "A nossa equipa não está disponível agora e responde aqui quando voltar. Até lá, posso continuar a ajudar.",
    helped: "Isso ajudou",
    thanks:
      "Ainda bem que ajudou! Se precisar de mais alguma coisa, escreva aqui.",
  },
  "pt-BR": {
    unknown:
      "Desculpe, não encontrei uma resposta para isso na nossa ajuda. Quer que eu coloque você em contato com alguém da equipe?",
    greeting: "Olá! Como posso ajudar?",
    person: "Falar com uma pessoa",
    handover:
      "Vou colocar você em contato com alguém da equipe. A resposta vai chegar aqui.",
    away: "Nossa equipe não está disponível agora. A resposta vai chegar aqui assim que ela voltar.",
    awayUntil:
      "Nossa equipe não está disponível agora e volta {when}. A resposta vai chegar aqui.",
    awayContinue:
      "Nossa equipe não está disponível agora e vai responder aqui quando voltar. Enquanto isso, posso continuar ajudando você.",
    helped: "Isso ajudou",
    thanks: "Que bom que ajudou! Se precisar de mais alguma coisa, é só escrever aqui.",
  },
  it: {
    unknown:
      "Mi dispiace, non ho trovato una risposta nella nostra guida. Vuoi che ti metta in contatto con qualcuno del team?",
    greeting: "Ciao! Come posso aiutarti?",
    person: "Parla con una persona",
    handover: "Ti metto in contatto con qualcuno del team. Ti risponderà qui.",
    away: "Il nostro team non è disponibile in questo momento. Ti risponderà qui appena torna.",
    awayUntil:
      "Il nostro team non è disponibile in questo momento e torna {when}. Ti risponderà qui.",
    awayContinue:
      "Il nostro team non è disponibile in questo momento e ti risponderà qui al suo ritorno. Nel frattempo, posso continuare ad aiutarti.",
    helped: "Mi è stato utile",
    thanks: "Felice di aver aiutato! Se ti serve altro, scrivici qui.",
  },
  nl: {
    unknown:
      "Sorry, ik heb daar in onze hulp geen antwoord op gevonden. Wil je dat ik je in contact breng met iemand van het team?",
    greeting: "Hoi! Waarmee kan ik je helpen?",
    person: "Met een persoon praten",
    handover: "Ik breng je in contact met iemand van het team. Je krijgt hier antwoord.",
    away: "Ons team is er nu niet. Je krijgt hier antwoord zodra het terug is.",
    awayUntil: "Ons team is er nu niet en is {when} terug. Je krijgt dan hier antwoord.",
    awayContinue:
      "Ons team is er nu niet en antwoordt hier zodra het terug is. Tot die tijd help ik je graag verder.",
    helped: "Dit heeft geholpen",
    thanks: "Fijn dat het heeft geholpen! Als je nog iets nodig hebt, schrijf het hier.",
  },
  ar: {
    unknown:
      "عذرًا، لم أجد إجابة عن ذلك في محتوى المساعدة لدينا. هل تريد أن أوصلك بأحد أعضاء الفريق؟",
    greeting: "مرحبًا! كيف يمكنني مساعدتك؟",
    person: "التحدث إلى شخص",
    handover: "سأوصلك بأحد أعضاء الفريق. سيصلك الرد هنا.",
    away: "فريقنا غير متاح الآن. سيصلك الرد هنا فور عودته.",
    awayUntil: "فريقنا غير متاح الآن ويعود {when}. سيصلك الرد هنا.",
    awayContinue:
      "فريقنا غير متاح الآن وسيرد هنا عند عودته. حتى ذلك الحين، يسعدني أن أواصل مساعدتك.",
    helped: "هذا ساعدني",
    thanks: "يسعدني أن ذلك ساعد! إذا احتجت إلى أي شيء آخر، فاكتب هنا.",
  },
};
/** The formal register, where a language's usual one is informal (Z2). */
const FORMAL: Record<string, Partial<Strings>> = {
  es: {
    unknown:
      "Lo siento, no encontré una respuesta en nuestra ayuda. ¿Quiere que le ponga en contacto con alguien del equipo?",
    greeting: "¡Hola! ¿En qué puedo ayudarle?",
    handover: "Le pongo en contacto con alguien del equipo. Le responderá aquí.",
    away: "Nuestro equipo no está disponible ahora. Le responderá aquí en cuanto vuelva.",
    awayUntil:
      "Nuestro equipo no está disponible ahora y vuelve {when}. Le responderá aquí.",
    awayContinue:
      "Nuestro equipo no está disponible ahora y le responderá aquí cuando vuelva. Mientras tanto, puedo seguir ayudándole.",
    thanks: "¡Me alegra haber ayudado! Si necesita algo más, escríbanos aquí.",
  },
  "pt-BR": {
    unknown:
      "Desculpe, não encontrei uma resposta para isso na nossa ajuda. Deseja falar com alguém da equipe?",
    handover:
      "Vou encaminhar sua conversa para alguém da equipe. A resposta chegará aqui.",
    away: "Nossa equipe não está disponível no momento. A resposta chegará aqui assim que ela retornar.",
    awayUntil:
      "Nossa equipe não está disponível no momento e retorna {when}. A resposta chegará aqui.",
    awayContinue:
      "Nossa equipe não está disponível no momento e responderá aqui quando retornar. Enquanto isso, posso continuar ajudando.",
    thanks: "Que bom que ajudou! Se precisar de mais alguma coisa, basta escrever aqui.",
  },
  it: {
    unknown:
      "Mi dispiace, non ho trovato una risposta nella nostra guida. Vuole che la metta in contatto con qualcuno del team?",
    greeting: "Buongiorno! Come posso aiutarla?",
    handover: "La metto in contatto con qualcuno del team. Le risponderà qui.",
    away: "Il nostro team non è disponibile in questo momento. Le risponderà qui appena torna.",
    awayUntil:
      "Il nostro team non è disponibile in questo momento e torna {when}. Le risponderà qui.",
    awayContinue:
      "Il nostro team non è disponibile in questo momento e le risponderà qui al suo ritorno. Nel frattempo, posso continuare ad aiutarla.",
    thanks: "Felice di aver aiutato! Se le serve altro, ci scriva qui.",
  },
  nl: {
    unknown:
      "Excuses, ik heb daar in onze hulp geen antwoord op gevonden. Wilt u dat ik u in contact breng met iemand van het team?",
    greeting: "Hallo! Waarmee kan ik u helpen?",
    handover: "Ik breng u in contact met iemand van het team. U krijgt hier antwoord.",
    away: "Ons team is er nu niet. U krijgt hier antwoord zodra het terug is.",
    awayUntil: "Ons team is er nu niet en is {when} terug. U krijgt dan hier antwoord.",
    awayContinue:
      "Ons team is er nu niet en antwoordt hier zodra het terug is. Tot die tijd help ik u graag verder.",
    thanks: "Fijn dat het heeft geholpen! Als u nog iets nodig heeft, schrijf het dan hier.",
  },
};
/** The informal register, where a language's usual one is formal (Z2). */
const INFORMAL: Record<string, Partial<Strings>> = {
  fr: {
    unknown:
      "Désolé, je n'ai pas trouvé de réponse dans notre aide. Tu veux que je te mette en relation avec quelqu'un de l'équipe ?",
    greeting: "Bonjour ! Comment puis-je t'aider ?",
    handover: "Je te mets en relation avec quelqu'un de l'équipe. Il te répondra ici.",
    away: "Notre équipe est absente pour le moment. Elle te répondra ici dès son retour.",
    awayUntil:
      "Notre équipe est absente pour le moment et revient {when}. Elle te répondra ici.",
    awayContinue:
      "Notre équipe est absente pour le moment et te répondra ici à son retour. D'ici là, je peux continuer à t'aider.",
    thanks: "Ravi d'avoir pu aider ! Si tu as besoin d'autre chose, écris-nous ici.",
  },
  de: {
    unknown:
      "Leider habe ich dazu in unserer Hilfe keine Antwort gefunden. Soll ich dich mit jemandem aus dem Team verbinden?",
    handover: "Ich verbinde dich mit jemandem aus dem Team. Du bekommst die Antwort hier.",
    away: "Unser Team ist gerade nicht da. Du bekommst die Antwort hier, sobald es zurück ist.",
    awayUntil:
      "Unser Team ist gerade nicht da und ab {when} zurück. Du bekommst die Antwort dann hier.",
    awayContinue:
      "Unser Team ist gerade nicht da und antwortet hier, sobald es zurück ist. Bis dahin helfe ich dir gern weiter.",
    thanks: "Schön, dass es geholfen hat! Wenn du noch etwas brauchst, schreib einfach hier.",
  },
  pt: {
    unknown:
      "Desculpa, não encontrei uma resposta na nossa ajuda. Queres que te ponha em contacto com alguém da equipa?",
    handover: "Vou pôr-te em contacto com alguém da equipa. A resposta chega aqui.",
    awayContinue:
      "A nossa equipa não está disponível agora e responde aqui quando voltar. Até lá, posso continuar a ajudar-te.",
    thanks: "Ainda bem que ajudou! Se precisares de mais alguma coisa, escreve aqui.",
  },
};
/** The "Talk to a person" button's words in every language, as the customer sends them. */
const PERSON_LABELS = new Set(
  Object.values(STRINGS).map((t) => t.person.toLowerCase()),
);
/** Her fixed replies in a language (its own, or its base language's, or English), in a register. */
const strings = (locale: string, formality: Voice["formality"] = "usual"): Strings => {
  const key = STRINGS[locale]
    ? locale
    : STRINGS[locale.split("-")[0]]
      ? locale.split("-")[0]
      : "en";
  const register =
    formality === "formal" ? FORMAL[key] : formality === "informal" ? INFORMAL[key] : undefined;
  return { ...STRINGS[key], ...register };
};

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
/** The workspace's agent (Zoe), created with the defaults the first time it's needed. */
export const agentRow = (db: Sql, w: string) => agentOf(db, w);
async function agentOf(db: Sql, w: string) {
  await db.query(
    "INSERT INTO ai_agents(workspace_id,id,name) VALUES($1,$2,'Zoe') ON CONFLICT DO NOTHING",
    [w, DEFAULT_AGENT],
  );
  return (
    await db.query<{
      id: string;
      name: string;
      enabled: boolean;
      confidence_threshold: number;
      handover_team_id: string | null;
      answer_hours: "always" | "outside_office_hours";
      out_of_hours: "continue" | "take_message" | "reply_time";
      failed_limit: number;
      escalate_on_sentiment: boolean;
      never_handle: Topic[];
      escalation_guidance: string[];
      resolution_window_hours: number;
      version: string;
      tone: Voice["tone"];
      answer_length: Voice["length"];
      formality: Voice["formality"];
      answer_guidance: Guideline[];
      guidance_version: number;
      languages: string[];
      other_languages: "brand_language" | "hand_over";
    }>(
      `SELECT id,name,enabled,confidence_threshold,handover_team_id,answer_hours,out_of_hours,failed_limit,escalate_on_sentiment,never_handle,escalation_guidance,resolution_window_hours,version::text AS version,
         tone,answer_length,formality,answer_guidance,guidance_version,languages,other_languages FROM ai_agents WHERE workspace_id=$1 AND id=$2`,
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
  // Handed over (A2a): nothing to queue, unless it keeps answering while the team is away.
  if (
    c.ai_state === "escalated" ||
    (c.ai_state === "needs_input" && agent.out_of_hours !== "continue")
  )
    return null;
  return enqueueJob(db, w, "ai.reply", { conversationId: c.id, partId }, {});
}

type Context = {
  c: Conversation;
  agent: Awaited<ReturnType<typeof agentOf>>;
  question: string;
  history: Turn[];
  chain: string[];
  signedIn: boolean;
  /** The language she answers in, and how she chose it (Z2). */
  language: LanguageChoice;
};

/** Why the agent won't answer this message now, if it won't. */
async function skipReason(db: Sql, w: string, c: Conversation, partId: string) {
  if (!(await aiEnabled(db, w))) return "The AI agent is off.";
  const agent = await agentOf(db, w);
  if (!agent.enabled) return "The AI agent is off.";
  if (await teammateInvolved(db, w, c))
    return "A teammate has taken the conversation on.";
  // Handed over (A2a): the agent stays out, unless the team was away and the agent was set to
  // keep answering until a teammate replies.
  if (
    c.ai_state === "escalated" ||
    (c.ai_state === "needs_input" && agent.out_of_hours !== "continue")
  )
    return "The conversation was handed to the team.";
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
  // The customer's browser language (their messenger session's), and the brand's.
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
  // Z2: what the customer wrote in (this message, or earlier in the conversation), else their
  // browser's language, else the brand's; then one of the languages she answers in.
  const earlier =
    (
      await db.query<{ language: string }>(
        "SELECT detected_language AS language FROM ai_answers WHERE workspace_id=$1 AND conversation_id=$2 AND detected_language IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        [w, c.id],
      )
    ).rows[0]?.language ?? null;
  const language = chooseLanguage({
    detected: detectLanguage(question),
    conversation: earlier,
    browser: locale,
    brand: brandLocale,
    allowed: agent.languages,
    other: agent.other_languages,
  });
  const signedIn =
    (
      await db.query<{ kind: string }>(
        "SELECT kind FROM identities WHERE workspace_id=$1 AND id=$2",
        [w, c.primary_identity_id],
      )
    ).rows[0]?.kind === "user";
  return { c, agent, question, history, chain: language.chain, signedIn, language };
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
 * Checks a model reply against what it was given: an answer needs one to six sentences (three when
 * concise, ten when thorough; Z2), each citing at least one given passage, with no links. Anything
 * else becomes "unknown".
 */
export function checkReply(
  reply: ModelReply,
  passageIds: Set<string>,
  maxSentences = 6,
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
  if (!sentences.length || sentences.length > maxSentences)
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
  // What rules can test, how many answers it couldn't give so far, and the brand's greeting.
  const known = await tenant(connect, w, async (db) => ({
    facts: await facts(db, w, ctx.c, {
      signedIn: ctx.signedIn,
      // Z2: the language she read in what they wrote, else their browser's.
      language: ctx.language.customer,
    }),
    failedSoFar: Number(
      (
        await db.query<{ n: string }>(
          "SELECT count(*) AS n FROM ai_answers WHERE workspace_id=$1 AND conversation_id=$2 AND outcome IN ('unknown','failed')",
          [w, ctx.c.id],
        )
      ).rows[0].n,
    ),
    greeting: await greetingFor(db, w, ctx.agent.id, ctx.c.brand_id, ctx.language.answer),
  }));
  // A failing model throws, and the job retries; decide gives up on the last attempts.
  const decision = await decide(connect, env, {
      w,
      agent: ctx.agent,
      question: ctx.question,
      history: ctx.history,
      chain: ctx.chain,
      signedIn: ctx.signedIn,
      brandId: ctx.c.brand_id,
      teamId: ctx.c.team_id,
      facts: known.facts,
      failedSoFar: known.failedSoFar,
      greeting: known.greeting,
      attempts: job.attempts,
      language: ctx.language,
      voice: voiceOf(ctx.agent),
      guidance: applicableGuidance(ctx.agent.answer_guidance, {
        signedIn: ctx.signedIn,
        brandId: ctx.c.brand_id,
      }),
    });
  const { text, locale, retrieval, cited, model, data, body } = decision;
  // What every record of this answer carries (Z2): its language and guidance.
  const given = {
    language: locale,
    detectedLanguage: ctx.language.detected,
    guidanceVersion: ctx.agent.guidance_version,
    guidanceApplied: decision.applied,
  };
  const { trigger, outcome, reason } = decision;
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
        ...given,
      });
      return null;
    }
    if (outcome === "ignored") {
      // Spam, by the workspace's guidance (Z2): no reply. Teammates see why, in a note only they
      // can read; the conversation stays where it is for them.
      await append(
        db,
        w,
        c,
        { type: "ai", id: ctx.agent.id },
        "internal_note",
        `${ctx.agent.name} didn't reply. ${reason}`,
        { aiSpam: { guideline: decision.applied[0] ?? null } },
        "internal",
      );
      await syncUnread(db, w, c);
      await record(db, w, {
        agentId: ctx.agent.id,
        conversationId: c.id,
        partId,
        outcome: "skipped",
        reason,
        threshold: ctx.agent.confidence_threshold,
        model,
        latency: Date.now() - started,
        trigger: "spam",
        ...given,
      });
      return null;
    }
    let replyPartId: string;
    let team: string | null = null;
    if (trigger) {
      const handed = await handOver(db, w, c, {
        agent: ctx.agent,
        trigger,
        reason,
        text,
        locale,
      });
      replyPartId = handed.replyPartId;
      team = handed.team;
    } else {
      const part = await append(
        db,
        w,
        c,
        { type: "ai", id: ctx.agent.id },
        "ai_reply",
        body,
        data,
      );
      replyPartId = part.id;
      await customerReply(db, w, c, part.seq);
      // Waiting on the customer, unless handed over already (kept answering while the team's away).
      await db.query(
        "UPDATE conversations SET ai_state='pending' WHERE workspace_id=$1 AND id=$2 AND (ai_state IS NULL OR ai_state IN ('pending','resolved'))",
        [w, c.id],
      );
      await syncUnread(db, w, c);
    }
    await record(db, w, {
      agentId: ctx.agent.id,
      conversationId: c.id,
      partId,
      replyPartId,
      outcome,
      reason,
      threshold: ctx.agent.confidence_threshold,
      retrieval,
      cited,
      model,
      latency: Date.now() - started,
      trigger,
      handoverTeamId: team,
      ...given,
    });
    return replyPartId;
  });
  return {
    done: true,
    result: written ? { outcome, replyPartId: written } : { skipped: true },
  };
}

type Agent = Awaited<ReturnType<typeof agentOf>>;
/** Her saved voice (Z2). */
const voiceOf = (a: Agent): Voice => ({
  tone: a.tone,
  length: a.answer_length,
  formality: a.formality,
});
/** The most sentences the reply check allows at each length (a little over what she's asked for). */
const MAX_SENTENCES: Record<Voice["length"], number> = {
  concise: 3,
  standard: 6,
  thorough: 10,
};
/** Everything a decision needs: from a conversation (the job) or a question (the Playground). */
type DecideInput = {
  w: string;
  agent: Agent;
  question: string;
  history: Turn[];
  /** The customer's languages, theirs first. */
  chain: string[];
  signedIn: boolean;
  brandId: string;
  /** The conversation's team, for office hours when no handover team is set. */
  teamId: string | null;
  facts: Facts;
  /** Answers the agent couldn't give earlier in the conversation; null in the Playground. */
  failedSoFar: number | null;
  /** The brand's own reply to a greeting, when the customer reads the brand's language. */
  greeting: string | null;
  /** The job's attempts so far: from GIVE_UP_AFTER a failing model gives the plain refusal. */
  attempts: number;
  /** The language she answers in, and how she chose it (Z2). */
  language: LanguageChoice;
  /** Her voice and the guidance that applies (Z2): saved, or a Playground draft. */
  voice: Voice;
  guidance: { answer: Guideline[]; spam: Guideline[] };
};
export type Decision = {
  trigger: Trigger | null;
  /** "ignored": spam, by the workspace's guidance (Z2); she doesn't reply. */
  outcome: "answered" | "clarified" | "unknown" | "failed" | "escalated" | "ignored";
  reason: string;
  body: string;
  data: Record<string, unknown>;
  retrieval: Retrieval;
  cited: string[];
  model: string | null;
  text: Strings;
  locale: string;
  /** The guidelines she was given, or the spam guideline that matched, by id (Z2). */
  applied: string[];
  /** What her voice and guidance add to her instructions (Z2), as the Playground shows them. */
  instructions: string[];
};

/**
 * What the agent does with a question, without writing anything: the handover triggers (rules,
 * a language she doesn't answer in, the button's words, office hours, topic keywords, then the
 * classifier, which also spots spam), the greeting, retrieval and the confidence gate, the model's
 * checked reply in her voice, and the failed-answers limit. The reply job writes the result; the
 * Playground (Z1) only shows it.
 */
async function decide(
  connect: Connect,
  env: AiEnvironment,
  input: DecideInput,
): Promise<Decision> {
  const { w, agent } = input;
  const locale = input.language.answer;
  const text = strings(locale, input.voice.formality);
  // What she's told about writing (Z2): her voice, then the guidelines that apply.
  const instructions = [
    ...styleLines(input.voice, locale),
    ...input.guidance.answer.map(guidanceLine),
  ];

  // Handover triggers checked before answering. First the escalation rules (A2b), in code.
  let why = "";
  const matched = await tenant(connect, w, async (db) =>
    matchRule(await rulesOf(db, w, agent.id), input.facts),
  );
  let trigger: Trigger | null = matched ? "rule" : null;
  if (matched) why = matched.name;
  // Z2: they wrote in a language she doesn't answer in, and the workspace hands those over.
  if (!trigger && input.language.handOver) {
    trigger = "language";
    why = languageName(input.language.customer);
  }
  // The button's own words need no model (A2a).
  if (!trigger && PERSON_LABELS.has(input.question.trim().toLowerCase()))
    trigger = "asked_for_person";
  let note = "";
  if (!trigger && agent.answer_hours === "outside_office_hours") {
    const hours = await tenant(connect, w, (db) =>
      availabilityFor(
        db,
        w,
        { brandId: input.brandId, teamId: agent.handover_team_id ?? input.teamId },
        locale,
      ),
    );
    // With no office hours set, there's no "inside" them: the agent answers.
    if (hours?.open) trigger = "office_hours";
  }
  // Never-handle topics' keywords, in code, so they hold when the model is down (A2b).
  const topics = agent.never_handle;
  const keyword = trigger ? null : matchKeywords(topics, input.question);
  if (keyword) {
    trigger = "topic";
    why = keyword.name;
  }
  let ignored: Guideline | undefined;
  if (!trigger && env.classify) {
    let seen: Classification | null = null;
    try {
      seen = await env.classify.classify({
        message: input.question,
        history: input.history,
        locale,
        topics: topics.map((t) => ({ name: t.name, description: t.description })),
        guidance: agent.escalation_guidance,
        spam: input.guidance.spam.map((g) => `${g.title}: ${g.text}`),
      });
    } catch {
      // Decision (docs/AI_STEP2.md): a failing classifier doesn't hand everything over. The agent
      // answers with A1's safeguards, and two failed answers still hand over.
      note = " The classifier was unavailable, so only the fixed handover triggers applied.";
    }
    const topic = seen?.topic != null ? topics[seen.topic] : undefined;
    const guidance =
      seen?.guidance != null ? agent.escalation_guidance[seen.guidance] : undefined;
    // Spam guidance (Z2) can only make her leave a message alone; then nothing else applies.
    ignored = seen?.spam != null ? input.guidance.spam[seen.spam] : undefined;
    if (!ignored) {
      if (seen?.wantsHuman) trigger = "asked_for_person";
      else if (topic) {
        trigger = "topic";
        why = topic.name;
      } else if (guidance) {
        trigger = "guidance";
        why = guidance.length > 120 ? guidance.slice(0, 119) + "…" : guidance;
      } else if (seen?.sentiment === "negative" && agent.escalate_on_sentiment)
        trigger = "negative_sentiment";
    }
  }

  let retrieval: Retrieval = { passages: [], candidates: [], topScore: 0 };
  let outcome: Decision["outcome"];
  let reason: string;
  let body: string;
  let data: Record<string, unknown> = {};
  let cited: string[] = [];
  let model: string | null = null;
  let applied: string[] = [];
  if (ignored) {
    outcome = "ignored";
    reason = `It looks like spam, by your guidance “${ignored.title}”.`;
    body = "";
    applied = [ignored.id];
  } else if (trigger) {
    outcome = "escalated";
    reason = TRIGGERS[trigger] + (why ? `: “${why}”` : "") + "." + note;
    body = "";
  } else if (!searchable(input.question)) {
    outcome = "clarified";
    reason = "Nothing to search for (a greeting).";
    body = input.greeting || text.greeting;
  } else {
    retrieval = await retrieveForAgent(
      connect,
      { index: env.index, rerank: env.rerank },
      w,
      {
        query: input.question,
        chain: input.chain,
        brandId: input.brandId,
        signedIn: input.signedIn,
      },
    );
    if (!retrieval.passages.length || retrieval.topScore < agent.confidence_threshold) {
      // The hard gate: weak retrieval never reaches the model.
      outcome = "unknown";
      reason = retrieval.passages.length
        ? `Best passage scored ${retrieval.topScore.toFixed(2)}, below the threshold of ${agent.confidence_threshold.toFixed(2)}.`
        : "No passage the customer may see matched.";
      body = text.unknown;
    } else {
      model = env.model.model;
      applied = input.guidance.answer.map((g) => g.id);
      let raw: ModelReply | null = null;
      try {
        raw = await env.model.answer({
          question: input.question,
          history: input.history,
          passages: retrieval.passages,
          locale,
          agentName: agent.name,
          // Z2: her voice, and the guidance as data under her rules.
          style: {
            ...input.voice,
            guidance: input.guidance.answer.map((g) => ({
              category: g.category,
              title: g.title,
              text: g.text,
            })),
          },
        });
      } catch (e) {
        // Retried by the job; after a few attempts the customer is told plainly instead.
        if (input.attempts < GIVE_UP_AFTER) throw e;
      }
      const checked = raw
        ? checkReply(
            raw,
            new Set(retrieval.passages.map((p) => p.id)),
            MAX_SENTENCES[input.voice.length],
          )
        : null;
      const reply = checked?.reply;
      if (!checked || !reply) {
        outcome = "failed";
        reason = `The answering model failed ${input.attempts} times.`;
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
            sources(db, w, input.brandId, records),
          ),
          // A3: "That helped" (a resolution) or "Talk to a person", in the customer's language.
          confirm: { helped: text.helped, person: text.person, thanks: text.thanks },
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

  if (outcome === "unknown" || outcome === "failed") {
    // Too many answers it couldn't give: hand over instead of saying so again (A2a).
    if (
      input.failedSoFar !== null &&
      input.failedSoFar + 1 >= agent.failed_limit
    ) {
      trigger = "failed_answers";
      reason = `${reason} ${TRIGGERS.failed_answers} (${input.failedSoFar + 1}).`;
      outcome = "escalated";
    } else data = { options: [text.person] };
  }
  if (note && outcome !== "escalated") reason += note;
  return {
    trigger,
    outcome,
    reason,
    body,
    data,
    retrieval,
    cited,
    model,
    text,
    locale,
    applied,
    instructions,
  };
}

/**
 * The Playground (Z1): what the agent would reply to a question, as a visitor or a signed-in
 * customer of a brand, with a browser language, without a conversation. It runs the same decision
 * as a real reply and writes nothing: no message, no audit row, no retrieval count, no resolution.
 * Deployed, each question costs model calls like a customer's would. Z2: a `draft` (the Guidance
 * page's unsaved voice and guidance, checked like a save) is used instead of the saved ones, and
 * the result says what she was told and which language she chose and why.
 */
export async function previewAiReply(
  connect: Connect,
  env: AiEnvironment,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const started = Date.now();
  const question = typeof p.question === "string" ? p.question.trim() : "";
  if (!question || question.length > 2000)
    throw new DomainError(
      "INVALID_PLAYGROUND",
      "Ask a question of up to 2,000 characters.",
      400,
    );
  const signedIn = p.signedIn === true;
  const prepared = await tenant(connect, w, async (db) => {
    await authorize(db, w, principal, "workspace.manage");
    assert(
      await aiEnabled(db, w),
      "AI_AGENT_DISABLED",
      "The AI agent is not enabled for this workspace.",
      404,
    );
    const agent = await agentOf(db, w);
    const brand = (
      await db.query<{ id: string; locale: string | null }>(
        "SELECT id,settings->>'locale' AS locale FROM brands WHERE workspace_id=$1 AND id=$2",
        [w, String(p.brandId ?? "default")],
      )
    ).rows[0];
    assert(brand, "BRAND_NOT_FOUND", "Brand unavailable.", 404);
    // The customer's browser language, if given; she reads the question's own language first.
    let browser: string | null = null;
    if (p.locale)
      try {
        browser = Intl.getCanonicalLocales(String(p.locale))[0];
      } catch {
        throw new DomainError("INVALID_PLAYGROUND", "Choose a language such as en or fr.", 400);
      }
    const language = chooseLanguage({
      detected: detectLanguage(question),
      conversation: null,
      browser,
      brand: brand.locale || "en",
      allowed: agent.languages,
      other: agent.other_languages,
    });
    const email = typeof p.email === "string" ? p.email.trim().toLowerCase() : "";
    const facts: Facts = {
      signedIn,
      // As Relay would know it: a verified address only for a signed-in customer.
      emailDomains: signedIn && email.includes("@") ? [email.split("@").pop()!] : [],
      brand: brand.id,
      language: language.customer,
      page: typeof p.page === "string" ? p.page.trim().slice(0, 500) : "",
      tags: [],
      attributes: {},
    };
    // Z2: the Guidance page's unsaved changes, checked like a save, or what's saved.
    const draft = p.draft === undefined || p.draft === null ? null : await draftStyle(db, w, p.draft);
    return {
      agent,
      brandId: brand.id,
      language,
      facts,
      greeting: await greetingFor(db, w, agent.id, brand.id, language.answer),
      draft,
    };
  });
  const voice = prepared.draft?.voice ?? voiceOf(prepared.agent);
  const guidance = applicableGuidance(
    prepared.draft?.guidance ?? prepared.agent.answer_guidance,
    { signedIn, brandId: prepared.brandId },
  );
  const d = await decide(connect, env, {
    w,
    agent: prepared.agent,
    question,
    history: [],
    chain: prepared.language.chain,
    signedIn,
    brandId: prepared.brandId,
    teamId: null,
    facts: prepared.facts,
    failedSoFar: null,
    greeting: prepared.greeting,
    attempts: GIVE_UP_AFTER,
    language: prepared.language,
    voice,
    guidance,
  });
  const titles = new Map(
    [...guidance.answer, ...guidance.spam].map((g) => [g.id, g]),
  );
  const used = new Set(d.retrieval.passages.map((x) => x.chunkId));
  const best = d.retrieval.candidates
    .slice()
    .sort((a, b) => (b.rerank ?? -1) - (a.rerank ?? -1))
    .slice(0, 6);
  // The candidates' titles and headings, for the teammate (no passage text beyond the heading).
  const named = await tenant(connect, w, async (db) =>
    new Map(
      (
        await db.query<{ id: string; heading: string; title: string | null }>(
          `SELECT c.chunk_id AS id,c.heading,(SELECT l.published_title FROM knowledge_locales l WHERE l.workspace_id=c.workspace_id AND l.record_id=c.record_id AND l.locale=c.locale) AS title
           FROM knowledge_chunks c WHERE c.workspace_id=$1 AND c.chunk_id=ANY($2::text[])`,
          [w, best.map((c) => c.chunkId)],
        )
      ).rows.map((r) => [r.id, r]),
    ),
  );
  return {
    outcome: d.outcome,
    trigger: d.trigger,
    reason: d.reason,
    // What the customer would read: the reply, or the handover message.
    reply: d.outcome === "escalated" ? d.text.handover : d.body,
    sources: (d.data.sources as { title: string; path?: string }[] | undefined) ?? [],
    options: (d.data.options as string[] | undefined) ?? [],
    confidence: d.retrieval.passages.length
      ? Math.round(d.retrieval.topScore * 100) / 100
      : null,
    threshold: prepared.agent.confidence_threshold,
    // The passages it weighed, best first (titles and scores; no content beyond the heading).
    candidates: best.map((c) => ({
      title: named.get(c.chunkId)?.title ?? "Untitled",
      heading: named.get(c.chunkId)?.heading ?? "",
      score: c.rerank === null ? null : Math.round(c.rerank * 100) / 100,
      used: used.has(c.chunkId),
    })),
    model: d.model,
    language: d.locale,
    // Z2: the customer's language as she read it, and where from (message, browser, brand).
    customerLanguage: prepared.language.customer,
    detectedLanguage: prepared.language.detected,
    languageSource: prepared.language.source,
    voice,
    // Saved (and which version), or the Guidance page's unsaved changes.
    draft: !!prepared.draft,
    guidanceVersion: prepared.draft ? null : prepared.agent.guidance_version,
    // What she was told, and the guidelines given to her (or the spam one that matched).
    instructions: d.instructions,
    applied: d.applied.map((id) => ({
      title: titles.get(id)?.title ?? "",
      category: titles.get(id)?.category ?? "other",
    })),
    latencyMs: Date.now() - started,
  };
}

/** Why the agent handed a conversation over (A2a; rules, topics and guidance from A2b). */
export type Trigger =
  | "asked_for_person"
  | "failed_answers"
  | "negative_sentiment"
  | "office_hours"
  | "rule"
  | "topic"
  | "guidance"
  | "language"
  | "spam";
const TRIGGERS: Record<Trigger, string> = {
  rule: "An escalation rule matched",
  language: "The customer wrote in a language she doesn't answer in",
  spam: "Spam, by the workspace's guidance",
  topic: "The message is about a never-handle topic",
  guidance: "Escalation guidance says a person should handle this",
  asked_for_person: "The customer asked for a person",
  failed_answers: "The agent couldn't answer too many times",
  negative_sentiment: "The customer seemed frustrated",
  office_hours:
    "The agent answers only outside office hours, and the team is open",
};

/**
 * Hands the conversation to the team: the customer is told (by office hours and the agent's
 * out-of-hours choice), a summary note goes to teammates only, the conversation moves to the
 * handover team for routing, and the AI state says where it stands. A conversation already
 * handed over while the team was away only gets the away message again.
 */
async function handOver(
  db: Sql,
  w: string,
  c: Conversation,
  h: {
    agent: Awaited<ReturnType<typeof agentOf>>;
    trigger: Trigger;
    reason: string;
    text: Strings;
    locale: string;
  },
) {
  const already = c.ai_state === "needs_input";
  const team = h.agent.handover_team_id
    ? ((
        await db.query<{ id: string }>(
          "SELECT id FROM teams WHERE workspace_id=$1 AND id=$2",
          [w, h.agent.handover_team_id],
        )
      ).rows[0]?.id ?? null)
    : null;
  const hours = await availabilityFor(
    db,
    w,
    { brandId: c.brand_id, teamId: team ?? c.team_id },
    h.locale,
  );
  const away = !!hours && !hours.open;
  const body = !away
    ? h.text.handover
    : h.agent.out_of_hours === "continue"
      ? h.text.awayContinue
      : h.agent.out_of_hours === "reply_time" && hours?.nextOpenLabel
        ? h.text.awayUntil.replace("{when}", hours.nextOpenLabel)
        : h.text.away;
  const reply = await append(
    db,
    w,
    c,
    { type: "ai", id: h.agent.id },
    "ai_reply",
    body,
    { handover: true },
  );
  await customerReply(db, w, c, reply.seq);
  if (!already) {
    // A3: a resolution recorded within its window is reversed by a handover.
    await reverseOnHandover(db, w, c, h.agent.id);
    // For teammates only: an internal note is never delivered to the customer.
    await append(
      db,
      w,
      c,
      { type: "ai", id: h.agent.id },
      "internal_note",
      await summary(db, w, c, h.reason, h.agent.name),
      { aiHandover: { trigger: h.trigger, teamId: team } },
      "internal",
    );
    const before = { assigned: c.assigned, status: c.status, team_id: c.team_id };
    if (team && c.team_id !== team) {
      await append(
        db,
        w,
        c,
        { type: "ai", id: h.agent.id },
        "assignment_change",
        "",
        {
          before: { teammate: c.assigned, team: c.team_id },
          after: { teammate: c.assigned, team },
        },
        "internal",
      );
      await db.query(
        "UPDATE conversations SET team_id=$3 WHERE workspace_id=$1 AND id=$2",
        [w, c.id, team],
      );
      c.team_id = team;
    }
    await db.query(
      "UPDATE conversations SET ai_state=$3 WHERE workspace_id=$1 AND id=$2",
      [w, c.id, away ? "needs_input" : "escalated"],
    );
    // Routing (phase 06) assigns it from the team's queue, as any team conversation.
    await afterChange(db, w, c.id, before);
  }
  await syncUnread(db, w, c);
  return { replyPartId: reply.id, team };
}

/**
 * The handover note: why, what the customer asked, and what the agent replied, built from the
 * conversation itself (no model writes it, so it can't invent anything).
 */
async function summary(
  db: Sql,
  w: string,
  c: Conversation,
  reason: string,
  agentName: string,
) {
  const parts = (
    await db.query<{ kind: string; body: string; data: Record<string, unknown> }>(
      `SELECT kind,body,data FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2
       AND audience='public' AND kind IN ('customer_message','ai_reply') ORDER BY seq`,
      [w, c.id],
    )
  ).rows;
  const quote = (t: string) =>
    "“" + (t.length > 300 ? t.slice(0, 299) + "…" : t).replace(/\s+/g, " ").trim() + "”";
  const asked = parts.filter((p) => p.kind === "customer_message" && p.body.trim());
  const outcomes = (
    await db.query<{ outcome: string; n: string }>(
      "SELECT outcome,count(*) AS n FROM ai_answers WHERE workspace_id=$1 AND conversation_id=$2 AND outcome IN ('answered','clarified','unknown','failed') GROUP BY outcome",
      [w, c.id],
    )
  ).rows;
  const count = (o: string) => Number(outcomes.find((x) => x.outcome === o)?.n ?? 0);
  const sources = [
    ...new Set(
      parts.flatMap((p) =>
        p.kind === "ai_reply" && Array.isArray(p.data.sources)
          ? (p.data.sources as { title?: string }[]).map((x) => String(x.title ?? ""))
          : [],
      ),
    ),
  ].filter(Boolean);
  const replies = [
    count("answered") && `${count("answered")} answered`,
    count("clarified") && `${count("clarified")} clarifying`,
    count("unknown") + count("failed") &&
      `${count("unknown") + count("failed")} couldn't answer`,
  ].filter(Boolean);
  return [
    `Handed over by ${agentName}. ${reason}`,
    asked.length ? `First message: ${quote(asked[0].body)}` : "",
    asked.length > 1 ? `Latest message: ${quote(asked.at(-1)!.body)}` : "",
    `AI replies: ${replies.length ? replies.join(", ") : "none"}.`,
    sources.length ? `Sources used: ${sources.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The customer tapped "That helped" under an answer from content (A3): a confirmed resolution,
 * unless the conversation was handed over or one already stands. Repeating it changes nothing.
 */
export async function confirmAiHelped(
  db: Sql,
  w: string,
  c: Conversation,
  partId: string,
) {
  const part = (
    await db.query<{ data: Record<string, unknown> }>(
      "SELECT data FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND id=$3 AND kind='ai_reply' AND audience='public'",
      [w, c.id, partId],
    )
  ).rows[0];
  const confirm = part?.data.confirm as { thanks?: unknown } | undefined;
  assert(
    confirm,
    "AI_REPLY_NOT_FOUND",
    "Only an answer from the AI agent can be marked as helpful.",
    404,
  );
  if (
    !(await aiEnabled(db, w)) ||
    c.ai_state === "escalated" ||
    c.ai_state === "needs_input"
  )
    return { conversationId: c.id, resolved: false };
  const agent = await agentOf(db, w);
  const id = await recordResolution(db, w, c, {
    agentId: agent.id,
    rule: "confirmed",
    windowHours: agent.resolution_window_hours,
  });
  if (!id) return { conversationId: c.id, resolved: false };
  const thanks = await append(
    db,
    w,
    c,
    { type: "ai", id: agent.id },
    "ai_reply",
    typeof confirm.thanks === "string" ? confirm.thanks : STRINGS.en.thanks,
    {},
  );
  await customerReply(db, w, c, thanks.seq);
  await syncUnread(db, w, c);
  return { conversationId: c.id, resolved: true, resolutionId: id };
}

/* ------------------------------------------------------------------------------------------ */
/* Settings › AI agent (A2a): the handover choices                                             */

/** The agent's handover settings and the teams to choose from, for workspace managers. */
export async function readAiSettings(db: Sql, w: string, principal: string) {
  // Zoe's own area (Z1) holds these now, so they don't depend on the Settings area's flag.
  await authorize(db, w, principal, "workspace.manage");
  assert(
    await aiEnabled(db, w),
    "AI_AGENT_DISABLED",
    "The AI agent is not enabled for this workspace.",
    404,
  );
  const a = await agentOf(db, w);
  const list = async (sql: string) =>
    (await db.query<{ id: string; name: string }>(sql, [w])).rows;
  const teams = await list(
    "SELECT id,name FROM teams WHERE workspace_id=$1 ORDER BY name,id",
  );
  return {
    // What a rule can be about (A2b): this workspace's own brands, tags and attributes.
    choices: {
      brands: await list(
        "SELECT id,name FROM brands WHERE workspace_id=$1 ORDER BY name,id",
      ),
      tags: await list(
        "SELECT id,name FROM tags WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY lower(name),id",
      ),
      attributes: await list(
        "SELECT id,name FROM attribute_definitions WHERE workspace_id=$1 AND owner_type='conversation' AND archived_at IS NULL ORDER BY lower(name),id",
      ),
    },
    rules: await rulesOf(db, w, a.id),
    // A3: the resolution ledger, net of reversals, and its latest rows.
    resolutions: await resolutionSummary(db, w),
    // Z1: Zoe's identity per brand.
    identities: await listIdentities(db, w, a.id),
    topics: a.never_handle,
    guidance: a.escalation_guidance,
    agent: {
      id: a.id,
      name: a.name,
      enabled: a.enabled,
      handoverTeamId: a.handover_team_id,
      answerHours: a.answer_hours,
      outOfHours: a.out_of_hours,
      failedLimit: a.failed_limit,
      escalateOnSentiment: a.escalate_on_sentiment,
      resolutionWindowHours: a.resolution_window_hours,
      threshold: a.confidence_threshold,
      // Z2: the languages she answers in, and what she does when a customer writes in another.
      languages: a.languages,
      otherLanguages: a.other_languages,
      version: a.version,
    },
    teams,
  };
}
/** Saves them, from the version the page loaded (or refused as changed elsewhere). */
export async function saveAiSettings(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const current = await readAiSettings(db, w, principal);
  if (String(p.version ?? "") !== current.agent.version)
    throw new DomainError(
      "AI_SETTINGS_CONFLICT",
      "These settings changed elsewhere. Reload to see the latest, then try again.",
      409,
    );
  const invalid = (message: string): never => {
    throw new DomainError("INVALID_AI_SETTINGS", message, 400);
  };
  const team =
    p.handoverTeamId === null || p.handoverTeamId === "" || p.handoverTeamId === undefined
      ? null
      : String(p.handoverTeamId);
  if (team && !current.teams.some((t) => t.id === team))
    invalid("Choose one of your teams, or no team.");
  if (!["always", "outside_office_hours"].includes(String(p.answerHours)))
    invalid("Choose when the agent answers.");
  if (!["continue", "take_message", "reply_time"].includes(String(p.outOfHours)))
    invalid("Choose what the agent does outside office hours.");
  const windowHours =
    p.resolutionWindowHours === undefined
      ? current.agent.resolutionWindowHours
      : Number(p.resolutionWindowHours);
  if (![1, 4, 12, 24, 48, 72].includes(windowHours))
    invalid("Choose a resolution window of 1, 4, 12, 24, 48 or 72 hours.");
  // Z1: how sure Zoe must be before she answers (the confidence gate).
  const threshold =
    p.threshold === undefined ? current.agent.threshold : Number(p.threshold);
  if (!Number.isFinite(threshold) || threshold < 0.2 || threshold > 0.9)
    invalid("Choose a confidence threshold between 20% and 90%.");
  const limit = Number(p.failedLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5)
    invalid("Hand over after 1 to 5 answers the agent couldn't give.");
  if (typeof p.enabled !== "boolean" || typeof p.escalateOnSentiment !== "boolean")
    invalid("Choose on or off.");
  // Z2: her languages (at least one of hers), and what she does with others.
  let languages = current.agent.languages;
  if (p.languages !== undefined) {
    const chosen = Array.isArray(p.languages) ? p.languages.map(String) : [];
    if (!chosen.length || chosen.some((l) => !ALL_LANGUAGES.includes(l)))
      invalid("Choose at least one of the languages she answers in.");
    languages = ALL_LANGUAGES.filter((l) => chosen.includes(l));
  }
  const otherLanguages =
    p.otherLanguages === undefined ? current.agent.otherLanguages : String(p.otherLanguages);
  if (!["brand_language", "hand_over"].includes(otherLanguages))
    invalid("Choose what she does when a customer writes in another language.");
  // A2b: rules, never-handle topics and guidance; left as they are when not sent.
  const rules =
    p.rules === undefined ? current.rules : await validRules(db, w, p.rules);
  const topics = p.topics === undefined ? current.topics : validTopics(p.topics);
  const guidance =
    p.guidance === undefined ? current.guidance : validGuidance(p.guidance);
  await db.query(
    `UPDATE ai_agents SET enabled=$3,handover_team_id=$4,answer_hours=$5,out_of_hours=$6,failed_limit=$7,escalate_on_sentiment=$8,
     never_handle=$9,escalation_guidance=$10,resolution_window_hours=$11,confidence_threshold=$12,languages=$13,other_languages=$14,
     version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
    [
      w,
      DEFAULT_AGENT,
      p.enabled,
      team,
      p.answerHours,
      p.outOfHours,
      limit,
      p.escalateOnSentiment,
      JSON.stringify(topics),
      JSON.stringify(guidance),
      windowHours,
      Math.round(threshold * 100) / 100,
      languages,
      otherLanguages,
    ],
  );
  await saveRules(db, w, DEFAULT_AGENT, rules);
  return readAiSettings(db, w, principal);
}
/** The settings route: saves are idempotent on the request's key. */
export const changeAiSettings = (
  db: Sql,
  w: string,
  principal: string,
  key: string,
  p: Record<string, unknown>,
) => once(db, w, "ai-settings:" + principal, key, p, () => saveAiSettings(db, w, principal, p));

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
    trigger?: Trigger | null;
    handoverTeamId?: string | null;
    /** Z2: the language she answered in, the one she read, and the guidance she was given. */
    language?: string | null;
    detectedLanguage?: string | null;
    guidanceVersion?: number | null;
    guidanceApplied?: string[];
  },
) {
  await db.query(
    `INSERT INTO ai_answers(workspace_id,id,agent_id,conversation_id,question_part_id,reply_part_id,outcome,reason,top_score,threshold,passages,cited,model,prompt_version,latency_ms,trigger,handover_team_id,
       language,detected_language,guidance_version,guidance_applied)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT(workspace_id,question_part_id) DO NOTHING`,
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
      a.trigger ?? null,
      a.handoverTeamId ?? null,
      a.language ?? null,
      a.detectedLanguage ?? null,
      a.guidanceVersion ?? null,
      a.guidanceApplied ?? [],
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
      trigger: string | null;
      agent_id: string;
      language: string | null;
      detected_language: string | null;
      guidance_version: number | null;
      guidance_applied: string[];
    }>(
      `SELECT question_part_id,reply_part_id,outcome,reason,top_score,threshold,cited,model,prompt_version,created_at,trigger,
         agent_id,language,detected_language,guidance_version,guidance_applied
       FROM ai_answers WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY created_at`,
      [w, c.id],
    )
  ).rows;
  // Z2: the voice and guideline titles of each guidance version an answer was given.
  const versions = new Map<number, Awaited<ReturnType<typeof guidanceAt>>>();
  for (const a of answers)
    if (a.guidance_version !== null && !versions.has(a.guidance_version))
      versions.set(a.guidance_version, await guidanceAt(db, w, a.agent_id, a.guidance_version));
  return {
    answers: answers.map((a) => {
      const at = a.guidance_version === null ? undefined : versions.get(a.guidance_version);
      return {
        questionPartId: a.question_part_id,
        replyPartId: a.reply_part_id,
        outcome: a.outcome,
        reason: a.reason,
        topScore: a.top_score === null ? null : Math.round(a.top_score * 100) / 100,
        threshold: a.threshold,
        cited: a.cited,
        model: a.model,
        promptVersion: a.prompt_version,
        trigger: a.trigger,
        at: new Date(a.created_at).toISOString(),
        language: a.language,
        detectedLanguage: a.detected_language,
        guidanceVersion: a.guidance_version,
        voice: at?.voice ?? null,
        guidance: a.guidance_applied.map((id) => at?.titles.get(id) ?? "A guideline since removed"),
      };
    }),
  };
}
