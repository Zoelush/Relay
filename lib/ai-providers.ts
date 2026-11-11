/**
 * The AI providers a workspace can connect for Zoe (phase 16, step C9d; docs/SECURITY_STEP19.md),
 * shared by the server and Settings › Knowledge & AI › AI providers. Each has its own adapter in
 * `server/ai-adapters.ts` (Claude in `server/ai-model.ts`); DeepSeek and a custom endpoint speak
 * OpenAI's Chat Completions API.
 *
 * The suggested models are only suggestions (from each provider's documentation, 11 November
 * 2026): the field takes any model name, and "Save and test" checks it.
 */
export type ProviderId = "anthropic" | "openai" | "gemini" | "deepseek" | "custom";
export type KeySource = "relay" | "workspace";
export type Provider = {
  name: string;
  /** Who runs it, for the page and the record of calls. */
  company: string;
  description: string;
  /** Where the provider processes what Zoe sends, as the page says it. */
  where: string;
  /** The first is filled in for a new connection. */
  models: string[];
  /** What a key usually starts with, as the field's placeholder. */
  keyPlaceholder: string;
};
export const PROVIDERS: Record<ProviderId, Provider> = {
  anthropic: {
    name: "Claude",
    company: "Anthropic",
    description: "Anthropic's Claude models, through the Messages API.",
    where: "Anthropic processes requests under its API terms; Relay's own AI uses Claude too.",
    models: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
    keyPlaceholder: "sk-ant-…",
  },
  openai: {
    name: "OpenAI",
    company: "OpenAI",
    description: "OpenAI's GPT models, through the Chat Completions API.",
    where: "OpenAI processes requests under its API terms.",
    models: ["gpt-6-luna", "gpt-5.4-mini", "gpt-6.1-sol"],
    keyPlaceholder: "sk-…",
  },
  gemini: {
    name: "Gemini",
    company: "Google",
    description: "Google's Gemini models, through the Gemini API.",
    where: "Google processes requests under the Gemini API terms.",
    models: ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-4-argon"],
    keyPlaceholder: "AIza…",
  },
  deepseek: {
    name: "DeepSeek",
    company: "DeepSeek",
    description: "DeepSeek's models, through its OpenAI-compatible API.",
    where: "DeepSeek's API is run from China. Check that sending customer messages there suits your obligations.",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    keyPlaceholder: "sk-…",
  },
  custom: {
    name: "OpenAI-compatible",
    company: "Your endpoint",
    description: "Any endpoint that speaks OpenAI's Chat Completions API, such as a model gateway or another provider.",
    where: "Wherever the endpoint you enter runs: Relay sends Zoe's requests to its https address.",
    models: [],
    keyPlaceholder: "Your endpoint's key",
  },
};
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** Relay's own AI (decision 2 of docs/AI_PLAN.md), with the deployment's key. */
export const RELAY_AI = { provider: "anthropic" as const, answer: "claude-sonnet-5-5", classify: "claude-haiku-4-5-20251001" };

/** How long a provider has before the fallback takes over (C9d). */
export const ANSWER_TIMEOUT_MS = 30_000;
export const CLASSIFY_TIMEOUT_MS = 15_000;

/** A model name as providers write them ("gpt-6-luna", "openai/gpt-6-luna", "llama@8b"). */
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
/** A key: one line, no spaces. */
export const API_KEY = /^[\x21-\x7e]{8,4000}$/;

/** Who answered a model call, in words (a conversation's "Why this reply" and the Playground). */
export function servedWords(c: { provider?: string | null; model: string; keySource?: KeySource; failover?: string | null }) {
  const name = c.provider && c.provider in PROVIDERS ? PROVIDERS[c.provider as ProviderId].name : "provider";
  const who = c.provider === "stand-in" ? "the offline stand-in" : c.keySource === "workspace" ? `your own ${name} key` : "Relay's AI";
  return `Answered with ${who} (${c.model}).${c.failover ? ` The primary failed first: ${c.failover}` : ""}`;
}
