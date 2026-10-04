import { FORMALITIES, LENGTHS, TONES, languageName, type Voice } from "../lib/zoe-voice";
import type { Hue } from "./colour";

/** What Zoe did, why she handed over, and how she sounded, in words (Z1, Z2). */
export const OUTCOME_NAMES: Record<string, string> = {
  answered: "Answered from content",
  clarified: "Asked to clarify",
  unknown: "Said she didn't know",
  failed: "Model failed",
  escalated: "Handed to the team",
  ignored: "Left alone as spam",
  spam: "Left alone as spam",
  skipped: "Stepped aside (a teammate had it)",
};
export const OUTCOME_HUES: Record<string, Hue> = {
  answered: "green",
  escalated: "rose",
  clarified: "sky",
  ignored: "slate",
  spam: "slate",
  skipped: "slate",
};
export const TRIGGER_NAMES: Record<string, string> = {
  asked_for_person: "Asked for a person",
  failed_answers: "Couldn't answer twice",
  negative_sentiment: "Seemed frustrated",
  office_hours: "Team open (answers out of hours only)",
  rule: "Escalation rule",
  topic: "Never-handle topic",
  guidance: "Escalation guidance",
  language: "Wrote in a language she doesn't answer in",
  spam: "Spam guidance",
};
/** "Friendly · Standard · usual formality". */
export function voiceSummary(v: Voice) {
  const formality = FORMALITIES.find((f) => f.id === v.formality);
  return [
    TONES.find((t) => t.id === v.tone)?.label ?? v.tone,
    LENGTHS.find((l) => l.id === v.length)?.label ?? v.length,
    v.formality === "usual" ? "usual formality" : (formality?.label ?? v.formality).toLowerCase(),
  ].join(" · ");
}
/** "French, read in the question", "English, their browser's". */
export function languageNote(
  answer: string,
  customer: string,
  source: "message" | "conversation" | "browser" | "brand",
) {
  const where = {
    message: "read in the question",
    conversation: "the conversation's",
    browser: "their browser's",
    brand: "the brand's",
  }[source];
  const base = (tag: string) => tag.split("-")[0].toLowerCase();
  return base(customer) === base(answer)
    ? `${languageName(answer)}, ${where}`
    : `${languageName(answer)}: the customer's ${languageName(customer)} (${where}) isn't one of hers`;
}
export const ago = (iso: string) => {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "within the hour";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};
