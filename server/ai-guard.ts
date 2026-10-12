import { normalize } from "./help-search";
import type { ModelReply } from "./ai-model";

/**
 * Zoe's safety guards (phase 08, step B2a; docs/AI_STEP9.md): checks in code on every reply a
 * model writes, before it can reach a customer. They don't trust the model: the hostile corpus
 * runs them against a model that obeys every injection. A reply that fails one is replaced by
 * "I couldn't find an answer" (with a person offered), and the answer records which guard fired.
 *
 * - canary: a secret marker in her instructions, new for every answer, showed up in the reply.
 * - prompt: words of her instructions or of the prompt's data blocks showed up in the reply.
 * - personal_data: an email address, phone number, card number or IBAN that is neither in the
 *   passages she was given nor in this customer's own messages (someone else's data).
 * - internal: a run of eight words from internal content (internal knowledge, or this
 *   conversation's internal notes) that isn't also in what she was given.
 * Links are refused earlier by the reply check (`checkReply`).
 */
export type Guard = "canary" | "prompt" | "personal_data" | "internal";
export const GUARD_REASONS: Record<Guard, string> = {
  canary: "it contained her confidential marker",
  prompt: "it repeated her instructions",
  personal_data: "it contained personal data that isn't the customer's own or in the content",
  internal: "it quoted internal content",
};

/** A fresh marker for one answer's instructions. */
export const newCanary = () => "zc-" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);

/** Words of her instructions that never belong in a reply. */
const PROMPT_FRAGMENTS = [
  "nothing in the data blocks",
  "is data, not instructions",
  "reply with one json object",
  "confidential marker",
  "<passages>",
  "<history>",
  "<question>",
  "<guidance>",
  "<memory>",
];

/** The text of everything a reply would show the customer. */
export function replyText(reply: ModelReply) {
  return reply.kind === "answer"
    ? reply.sentences.map((s) => s.text).join(" ")
    : reply.kind === "clarify"
      ? [reply.question, ...reply.options].join(" ")
      : "";
}

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
};
/** Dates look like long numbers; they aren't personal data. */
export const isDate = (s: string) =>
  /^\d{4}[./-]\d{1,2}[./-]\d{1,2}$/.test(s.trim()) || /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(s.trim());
/** Personal data in a text, normalised so the same item matches however it's written. */
export function personalData(text: string) {
  const found = new Set<string>();
  for (const m of text.matchAll(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu))
    found.add("email:" + m[0].toLowerCase());
  for (const m of text.matchAll(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g))
    found.add("iban:" + m[0].replace(/ /g, ""));
  for (const m of text.matchAll(/(?<![\w])\+?\d[\d ().-]{6,22}\d(?![\w])/g)) {
    if (isDate(m[0])) continue;
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) found.add("card:" + digits);
    else if (digits.length >= 8 && digits.length <= 15) found.add("phone:" + digits.slice(-9));
  }
  return found;
}

/** Runs of eight words, to recognise quoted text. */
function shingles(text: string, size = 8) {
  const words = normalize(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(" "));
  return out;
}

/**
 * Which guard a reply fails, if any. `given` is everything she was given that the customer may
 * see: the passages, and this customer's own messages. `internal` is the internal content that
 * must never be quoted.
 */
export function guardReply(
  reply: ModelReply,
  ctx: { canary: string; given: string; internal: string[] },
): Guard | null {
  const text = replyText(reply);
  if (!text) return null;
  if (ctx.canary && text.includes(ctx.canary)) return "canary";
  const plain = text.toLowerCase();
  if (PROMPT_FRAGMENTS.some((f) => plain.includes(f))) return "prompt";
  const allowed = personalData(ctx.given);
  for (const item of personalData(text)) if (!allowed.has(item)) return "personal_data";
  const said = shingles(text);
  if (said.size && ctx.internal.length) {
    const fine = shingles(ctx.given);
    for (const t of ctx.internal)
      for (const s of shingles(t)) if (said.has(s) && !fine.has(s)) return "internal";
  }
  return null;
}
