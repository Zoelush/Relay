/**
 * How Zoe answers (phase 08, step Z2; docs/AI_STEP6.md), shared by the server and the agent app:
 * her tones, answer lengths and formality, her languages, the answer guidance categories and
 * limits, and the warnings shown when a guideline asks for something guidance can't do.
 */
export const TONES = [
  {
    id: "friendly",
    label: "Friendly",
    description: "Warm and approachable; contractions welcome.",
    prompt: "friendly: warm and approachable, with contractions where natural",
    sample: "Happy to help! Refunds usually reach your account within five working days.",
  },
  {
    id: "professional",
    label: "Professional",
    description: "Polished and precise; no slang.",
    prompt: "professional: polished and precise, with no slang",
    sample: "Refunds are usually credited to your account within five working days.",
  },
  {
    id: "matter_of_fact",
    label: "Matter-of-fact",
    description: "Neutral and direct; the answer and nothing else.",
    prompt: "matter-of-fact: neutral and direct, the answer and nothing else",
    sample: "Refunds take up to five working days.",
  },
  {
    id: "empathetic",
    label: "Empathetic",
    description: "Acknowledges how the customer feels, then solves it.",
    prompt:
      "empathetic: briefly acknowledge how the customer feels when it shows, then answer",
    sample:
      "I know waiting for money back is frustrating. Refunds usually arrive within five working days.",
  },
  {
    id: "playful",
    label: "Playful",
    description: "Light and human, never at the customer's expense.",
    prompt:
      "playful: light and human, never at the customer's expense, and never when they're upset",
    sample: "Good news: your refund is on its way, and it usually lands within five working days.",
  },
] as const;
export type Tone = (typeof TONES)[number]["id"];

export const LENGTHS = [
  { id: "concise", label: "Concise", sentences: 2, description: "Up to 2 sentences" },
  { id: "standard", label: "Standard", sentences: 4, description: "Up to 4 sentences" },
  {
    id: "thorough",
    label: "Thorough",
    sentences: 8,
    description: "Up to 8 sentences, with steps in order",
  },
] as const;
export type Length = (typeof LENGTHS)[number]["id"];

export const FORMALITIES = [
  {
    id: "usual",
    label: "Usual for each language",
    description:
      "As support usually writes: vous in French, Sie in German, tú in Spanish, tu in Italian, je in Dutch.",
  },
  {
    id: "formal",
    label: "Formal",
    description: "vous, Sie, usted, Lei, u, and o senhor in Portuguese.",
  },
  {
    id: "informal",
    label: "Informal",
    description: "tu, du, tú, tu, je, and tu in Portuguese.",
  },
] as const;
export type Formality = (typeof FORMALITIES)[number]["id"];

export type Voice = { tone: Tone; length: Length; formality: Formality };
export const DEFAULT_VOICE: Voice = {
  tone: "friendly",
  length: "standard",
  formality: "usual",
};

/** The languages Zoe answers in: the messenger's own nine (lib/messenger-languages.ts). */
export const ZOE_LANGUAGES = [
  { id: "en", name: "English", native: "English" },
  { id: "fr", name: "French", native: "Français" },
  { id: "es", name: "Spanish", native: "Español" },
  { id: "de", name: "German", native: "Deutsch" },
  { id: "pt", name: "Portuguese (Portugal)", native: "Português (Portugal)" },
  { id: "pt-BR", name: "Portuguese (Brazil)", native: "Português (Brasil)" },
  { id: "it", name: "Italian", native: "Italiano" },
  { id: "nl", name: "Dutch", native: "Nederlands" },
  { id: "ar", name: "Arabic", native: "العربية" },
] as const;
export const ALL_LANGUAGES: string[] = ZOE_LANGUAGES.map((l) => l.id);
/** Any language's English name ("Japanese" for ja), for teammates. */
export function languageName(tag: string | null | undefined) {
  if (!tag) return "";
  const own = ZOE_LANGUAGES.find((l) => l.id.toLowerCase() === tag.toLowerCase());
  if (own) return own.name;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
export type OtherLanguages = "brand_language" | "hand_over";

export const GUIDANCE_CATEGORIES = [
  {
    id: "style",
    label: "Communication style",
    description: "Words and phrasing: what to call things, spelling, what to avoid.",
    example: "Call our product Relay, never “the app”. Use British spelling.",
    hue: "violet",
  },
  {
    id: "clarification",
    label: "Context and clarification",
    description: "When to ask the customer for more detail before answering.",
    example:
      "If someone asks about billing without saying which plan they're on, ask which plan first.",
    hue: "sky",
  },
  {
    id: "sources",
    label: "Content and sources",
    description: "How to use your content: what to prefer, and what to say when it only partly answers.",
    example: "When the content answers only part of the question, say which part it answers.",
    hue: "amber",
  },
  {
    id: "spam",
    label: "Spam",
    description:
      "Messages she should leave alone. She won't reply, and they stay in the inbox for the team.",
    example: "Sales pitches for “SEO services” or “guest posts”.",
    hue: "rose",
  },
  {
    id: "other",
    label: "Other",
    description: "Anything else about how she answers.",
    example: "Only end with a question when you need more detail.",
    hue: "slate",
  },
] as const;
export type GuidanceCategory = (typeof GUIDANCE_CATEGORIES)[number]["id"];
export const AUDIENCES = [
  { id: "everyone", label: "Everyone" },
  { id: "visitors", label: "Visitors" },
  { id: "signed_in", label: "Signed-in customers" },
] as const;
export type Audience = (typeof AUDIENCES)[number]["id"];
export type Guideline = {
  id: string;
  category: GuidanceCategory;
  title: string;
  text: string;
  enabled: boolean;
  audience: Audience;
  /** One brand, or every brand (null). */
  brandId: string | null;
};
export const MAX_GUIDELINES = 30;
export const MAX_GUIDELINE_TITLE = 80;
export const MAX_GUIDELINE_TEXT = 500;

/**
 * What a guideline asks for that guidance can't give her. Guidance changes how she answers, never
 * what she can do: these are shown as warnings (saving still works), and her rules hold anyway.
 */
export function guidanceWarnings(g: { category: string; text: string; title?: string }) {
  const text = `${g.title ?? ""} ${g.text}`;
  const out: string[] = [];
  if (
    /\b(issue|give|grant|process|approve|offer|send)\s+(them\s+|the customer\s+|customers\s+)?(a|an|the)?\s*(refund|credit|discount|voucher|coupon|compensation|free)/i.test(text) ||
    /\b(look up|lookup|check|track|update|change|cancel|reset|delete|close)\s+(the|their|a|an|his|her|its)\s+(order|account|subscription|plan|password|address|delivery|parcel|booking|payment|invoice)s?\b/i.test(text)
  )
    out.push(
      "She can't act on accounts, orders or payments. Guidance changes how she answers, not what she can do.",
    );
  if (/https?:\/\/|www\.|\b(link|url)s?\b/i.test(text))
    out.push("She doesn't write links: the sources she used are shown under her answer.");
  if (
    /\b(general|own) knowledge\b|\boutside (of )?(the|our|your) (content|articles|help|knowledge)\b|\bnot in (the|our|your) (content|articles|help)\b|\bmake (it|something|things) up\b|\bguess\b|\bthe internet\b|\bsearch the web\b/i.test(text)
  )
    out.push("She answers only from your content; guidance can't change that.");
  if (
    g.category !== "spam" &&
    /\b(hand (it |them |this |the conversation )?(over|off)|escalate|transfer (it|them|the conversation)|pass (it|them|this|the conversation) (on|to)|connect (them|the customer|customers) (to|with))\b/i.test(text)
  )
    out.push(
      "Handing over is decided on the Escalation page: add it there as escalation guidance.",
    );
  if (/\b(system prompt|your instructions|these instructions|internal notes?|internal (articles|content))\b/i.test(text))
    out.push("She never reveals her instructions or internal content.");
  return out;
}
