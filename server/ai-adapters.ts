import { DomainError } from "./db";
import { FetchRefused, safeRequest, type FetchPolicy } from "./safe-fetch";
import {
  buildClassifyPrompt,
  buildPrompt,
  claudeAnswerModel,
  claudeClassifier,
  parseClassification,
  parseReply,
  ANSWER_MAX_TOKENS,
  CLASSIFY_MAX_TOKENS,
  type AnswerModel,
  type ClassifierPort,
  type Served,
} from "./ai-model";
import { ANSWER_TIMEOUT_MS, CLASSIFY_TIMEOUT_MS, type KeySource, type ProviderId } from "../lib/ai-providers";

/**
 * The workspace's own AI providers (phase 16, step C9d; docs/SECURITY_STEP19.md): an adapter per
 * provider behind Zoe's ports (`AnswerModel`, `ClassifierPort`), and the router that tries the
 * primary and, only when it fails, the fallback. The prompt, the reply's parsing, redaction, the
 * record of calls and `guardReply` are the same for every provider: an adapter only carries the
 * prompt there and the reply back.
 *
 * - Claude: Anthropic's SDK (`server/ai-model.ts`).
 * - OpenAI, DeepSeek and any OpenAI-compatible endpoint: Chat Completions. No temperature
 *   (reasoning models reject it); OpenAI gets `max_completion_tokens`, the others `max_tokens`;
 *   OpenAI and DeepSeek get JSON mode (the prompt asks for JSON, as both require).
 * - Gemini: `generateContent`, with JSON as the response type.
 *
 * Every request goes through `safeRequest` (https only, no private addresses, a time limit and a
 * size cap); a failure says what happened by its status, never by what the provider sent back.
 */
export type ProviderPolicy = FetchPolicy & {
  /** Tests only: a shorter time limit than 30 seconds to answer and 15 to classify. */
  timeoutMs?: number;
};
export type Connection = {
  provider: ProviderId;
  key: string;
  model: string;
  classifierModel: string | null;
  baseUrl: string | null;
};
type Ask = (r: { system: string; user: string; maxTokens: number; timeoutMs: number; what: string; model: string }) => Promise<{ text: string; model: string }>;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** A failed request, by its status only (the body could quote anything). */
export function providerFailure(status: number, what: string) {
  return new DomainError("MODEL_UNAVAILABLE", `The ${what} returned ${status}.`, 503, { status });
}
async function post(url: string, policy: ProviderPolicy, headers: Record<string, string>, body: unknown, r: { timeoutMs: number; what: string }) {
  let got;
  try {
    got = await safeRequest(url, policy, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body) }, { maxBytes: MAX_RESPONSE_BYTES, timeoutMs: r.timeoutMs });
  } catch (e) {
    if (e instanceof FetchRefused && e.code === "TIMEOUT") throw new DomainError("MODEL_TIMEOUT", `The ${r.what} didn't answer in time.`, 504);
    if (e instanceof FetchRefused && e.code === "ADDRESS_NOT_ALLOWED") throw new DomainError("MODEL_ADDRESS", `The ${r.what}'s address isn't allowed: it must be a public https address.`, 400);
    throw new DomainError("MODEL_UNAVAILABLE", `The ${r.what} couldn't be reached.`, 503);
  }
  if (got.status < 200 || got.status >= 300) throw providerFailure(got.status, r.what);
  try {
    return JSON.parse(got.body) as Record<string, unknown>;
  } catch {
    throw new DomainError("MODEL_REPLY_INVALID", `The ${r.what}'s reply wasn't in the expected form.`, 502);
  }
}

/** Chat Completions: OpenAI, DeepSeek, and any endpoint that speaks it. */
function chatCompletions(c: Connection, policy: ProviderPolicy): Ask {
  const url =
    c.provider === "openai" ? "https://api.openai.com/v1/chat/completions" : c.provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : `${c.baseUrl}/chat/completions`;
  return async (r) => {
    const body = await post(
      url,
      policy,
      { authorization: `Bearer ${c.key}` },
      {
        model: r.model,
        messages: [
          { role: "system", content: r.system },
          { role: "user", content: r.user },
        ],
        ...(c.provider === "openai" ? { max_completion_tokens: r.maxTokens } : { max_tokens: r.maxTokens }),
        ...(c.provider === "custom" ? {} : { response_format: { type: "json_object" } }),
        // DeepSeek thinks by default, at high effort; a support reply needs little.
        ...(c.provider === "deepseek" ? { reasoning_effort: "low" } : {}),
      },
      r,
    );
    const choice = (body.choices as { message?: { content?: unknown; refusal?: unknown }; finish_reason?: string }[] | undefined)?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === "content_filter") throw new DomainError("MODEL_REFUSED", `The ${r.what} declined to answer.`, 502);
    return { text: typeof choice?.message?.content === "string" ? choice.message.content : "", model: typeof body.model === "string" && body.model ? body.model : r.model };
  };
}

/** Gemini's `generateContent`. */
function gemini(c: Connection, policy: ProviderPolicy): Ask {
  return async (r) => {
    const body = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(r.model)}:generateContent`,
      policy,
      { "x-goog-api-key": c.key },
      {
        systemInstruction: { parts: [{ text: r.system }] },
        contents: [{ role: "user", parts: [{ text: r.user }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: r.maxTokens },
      },
      r,
    );
    const candidate = (body.candidates as { content?: { parts?: { text?: unknown; thought?: unknown }[] }; finishReason?: string }[] | undefined)?.[0];
    if (!candidate || ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(candidate.finishReason ?? ""))
      throw new DomainError("MODEL_REFUSED", `The ${r.what} declined to answer.`, 502);
    const text = (candidate.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
    return { text, model: typeof body.modelVersion === "string" && body.modelVersion ? body.modelVersion : r.model };
  };
}

/** A connection's answering and classifying models (a workspace's own key). */
export function connectionModels(c: Connection, policy: ProviderPolicy = {}): { model: AnswerModel; classify: ClassifierPort } {
  const keySource: KeySource = "workspace";
  const classifierModel = c.classifierModel || c.model;
  if (c.provider === "anthropic")
    return {
      model: claudeAnswerModel(c.key, { model: c.model, keySource, fetch: policy.fetch, timeoutMs: policy.timeoutMs }),
      classify: claudeClassifier(c.key, { model: classifierModel, keySource, fetch: policy.fetch, timeoutMs: policy.timeoutMs }),
    };
  const ask = c.provider === "gemini" ? gemini(c, policy) : chatCompletions(c, policy);
  return {
    model: {
      model: c.model,
      provider: c.provider,
      keySource,
      async answer(request, served) {
        const { system, user } = buildPrompt(request);
        const got = await ask({ system, user, maxTokens: ANSWER_MAX_TOKENS, timeoutMs: policy.timeoutMs ?? ANSWER_TIMEOUT_MS, what: "answering model", model: c.model });
        const reply = parseReply(got.text);
        if (!reply) throw new DomainError("MODEL_REPLY_INVALID", "The answering model's reply wasn't in the expected form.", 502);
        served?.({ provider: c.provider, model: got.model, keySource, failover: null });
        return reply;
      },
    },
    classify: {
      model: classifierModel,
      provider: c.provider,
      keySource,
      async classify(request, served) {
        const { system, user } = buildClassifyPrompt(request);
        const got = await ask({ system, user, maxTokens: CLASSIFY_MAX_TOKENS, timeoutMs: policy.timeoutMs ?? CLASSIFY_TIMEOUT_MS, what: "classifier", model: classifierModel });
        const parsed = parseClassification(got.text);
        if (!parsed) throw new DomainError("MODEL_REPLY_INVALID", "The classifier's reply wasn't in the expected form.", 502);
        served?.({ provider: c.provider, model: got.model, keySource, failover: null });
        return parsed;
      },
    },
  };
}

/** Why a primary failed, as the record of calls keeps it: its provider, model and reason. */
const failoverOf = (provider: string | undefined, model: string, e: unknown) =>
  `${provider ?? "unknown"} ${model}: ${e instanceof DomainError ? e.message : "it failed."}`.slice(0, 300);
/**
 * The primary, and only when it fails (an error, a refusal, an unreadable reply, or no answer in
 * time) the fallback. A primary that can't be built (its key can't be read) fails the same way.
 */
export function routed<T extends AnswerModel | ClassifierPort>(primary: T, fallback: T | null): T {
  if (!fallback) return primary;
  const run = async <R>(call: (port: T, served: (s: Served) => void) => Promise<R>, served?: (s: Served) => void) => {
    try {
      return await call(primary, (s) => served?.(s));
    } catch (e) {
      const why = failoverOf(primary.provider, primary.model, e);
      const fallen = (s: Served) => served?.({ ...s, failover: why });
      fallen({ provider: fallback.provider ?? "unknown", model: fallback.model, keySource: fallback.keySource ?? "workspace", failover: why });
      return await call(fallback, fallen);
    }
  };
  if ("answer" in primary)
    return {
      model: primary.model,
      provider: primary.provider,
      keySource: primary.keySource,
      answer: (request, served) => run((port, s) => (port as AnswerModel).answer(request, s), served),
    } satisfies AnswerModel as T;
  return {
    model: primary.model,
    provider: primary.provider,
    keySource: primary.keySource,
    classify: (request, served) => run((port, s) => (port as ClassifierPort).classify(request, s), served),
  } satisfies ClassifierPort as T;
}

/** A model that always fails with a reason (a key that can't be read, or no AI configured). */
export function failingModels(reason: string, keySource: KeySource, provider?: string): { model: AnswerModel; classify: ClassifierPort } {
  const fail = async (): Promise<never> => {
    throw new DomainError("MODEL_UNAVAILABLE", reason, 503);
  };
  return {
    model: { model: "unavailable", provider, keySource, answer: fail },
    classify: { model: "unavailable", provider, keySource, classify: fail },
  };
}
