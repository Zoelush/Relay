import { normalize } from "./help-search";
import { ALL_LANGUAGES, type OtherLanguages } from "../lib/zoe-voice";

/**
 * Which language Zoe answers in (phase 08, step Z2; docs/AI_STEP6.md). She reads the language of
 * what the customer wrote, in code (so it holds when the model is down): the script for languages
 * not written in Latin letters, and common short words for her Latin-script languages. A message
 * too short to tell ("ok", "Hi!") keeps the language the conversation was in, then the customer's
 * browser's, then the brand's. A language she doesn't answer in gets the brand's language, or is
 * handed to the team when the workspace says so (only when she read it in what they wrote).
 */

/** Short words that mark each Latin-script language, without accents (as `normalize` leaves them). */
const WORDS: Record<string, string[]> = {
  en: "the and is are was were you your my me how what when where why which who can could would should will do does did have has not this that with for from about there it i im dont cant please thanks thank of to an be if or any get".split(" "),
  fr: "le les des du un une et est je vous tu mon ma mes pour pas que qui quoi comment quand pourquoi combien quel quelle avec sur dans il elle nous ce cette mais merci bonjour salut puis peux faire sont j qu l ai suis votre vos ne au aux voudrais pouvez".split(" "),
  es: "el los las un una y es que del por para como cuando donde porque cuanto cual mi mis tu usted con no se lo puedo hola gracias quiero tengo esta estoy son pero muy hay al su sus nos me le ya tambien hacer puede necesito".split(" "),
  pt: "o os um uma e que do da dos das em no na nos nas para por como quando onde porque quanto meu minha teu tua nao com se posso ola obrigado obrigada quero tenho esta estou sao mas muito voce voces isso isto ao pelo pela sua seu ja tambem fazer pode preciso eu ele ela oi ajuda".split(" "),
  it: "il lo gli le un una e che di del della dei per come quando dove perche quanto mio mia non con si posso ciao grazie voglio ho sono questo questa ci mi ti ma anche gia fare puo devo vorrei buongiorno sto hai ha cosa quale".split(" "),
  de: "der die das und ist ich sie du nicht ein eine einen mit fur wie was wann warum wo mein meine kann konnen bitte danke auf zu es den dem haben habe hallo mir mich sind wir ihr ihre uber auch noch schon aber oder wenn dass bei nach von gibt mochte".split(" "),
  nl: "de het een en is ik je jij u niet van voor met hoe wat wanneer waarom mijn kan kunnen alstublieft bedankt dank op te er dat die zijn heb hebben waar hoi hallo ook nog al maar of wil graag mag moet kun jullie uw welke deze dit wie".split(" "),
};
const SETS = Object.fromEntries(
  Object.entries(WORDS).map(([l, w]) => [l, new Set(w)]),
);
/** Words only Brazilian or European Portuguese tends to use. */
const BRAZIL = /\b(voce|voces|equipe|contato|celular|cadastro|onibus|banheiro|a gente|est(ou|a|amos|ao) \w+ndo)\b/;
const PORTUGAL = /\b(equipa|contacto|telemovel|registo|autocarro|comboio|casa de banho|queres|podes|tens|est(ou|a|amos|ao) a \w+(ar|er|ir))\b/;

/**
 * The language of a customer's text, when it's clear: a language tag ("fr", "pt-BR", "ja"), or
 * null when the text is too short or mixed to tell. Portuguese is "pt-BR" or "pt-PT" when its
 * words say which, and "pt" when they don't.
 */
export function detectLanguage(text: string): string | null {
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch));
  if (!letters.length) return null;
  const count = (re: RegExp) => letters.filter((ch) => re.test(ch)).length;
  const latin = count(/\p{Script=Latin}/u);
  if (letters.length - latin >= Math.max(2, latin)) {
    if (count(/[\p{Script=Hiragana}\p{Script=Katakana}]/u)) return "ja";
    if (count(/\p{Script=Hangul}/u)) return "ko";
    if (count(/\p{Script=Han}/u)) return "zh";
    if (count(/\p{Script=Arabic}/u))
      return /[پچژگ]/.test(text) ? "fa" : /[ٹڈڑںے]/.test(text) ? "ur" : "ar";
    if (count(/\p{Script=Cyrillic}/u)) return /[іїєґ]/i.test(text) ? "uk" : "ru";
    if (count(/\p{Script=Greek}/u)) return "el";
    if (count(/\p{Script=Hebrew}/u)) return "he";
    if (count(/\p{Script=Thai}/u)) return "th";
    if (count(/\p{Script=Devanagari}/u)) return "hi";
    return null;
  }
  const plain = normalize(text);
  const tokens = plain.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const scores = Object.entries(SETS)
    .map(([l, set]) => ({ l, n: tokens.filter((t) => set.has(t)).length }))
    .sort((a, b) => b.n - a.n);
  const [best, next] = scores;
  // Two marking words at least, and twice as many as any other language's.
  if (best.n < 2 || best.n < 2 * next.n) return null;
  if (best.l !== "pt") return best.l;
  const words = " " + tokens.join(" ") + " ";
  const br = BRAZIL.test(words),
    pt = PORTUGAL.test(words);
  return br && !pt ? "pt-BR" : pt && !br ? "pt-PT" : "pt";
}

export type LanguageChoice = {
  /** The language she answers in: one of her allowed languages. */
  answer: string;
  /** The customer's language, as best she can tell (for rules, and for teammates). */
  customer: string;
  /** What she read in this message, when she could tell. */
  detected: string | null;
  /** Where the customer's language came from. */
  source: "message" | "conversation" | "browser" | "brand";
  /** They wrote in a language she doesn't answer in, and the workspace hands those over. */
  handOver: boolean;
  /** The languages to look for content in, best first. */
  chain: string[];
};

const canonical = (tag: string | null | undefined) => {
  if (!tag) return null;
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
};
const base = (tag: string) => tag.split("-")[0].toLowerCase();

/** The allowed language that serves this tag: itself, its own language, or Portuguese's other variant. */
export function matchLanguage(tag: string, allowed: string[]) {
  const t = tag === "pt-PT" ? "pt" : tag;
  const exact = allowed.find((a) => a.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const same = allowed.find((a) => a.toLowerCase() === base(t));
  if (same) return same;
  return allowed.find((a) => base(a) === base(t)) ?? null;
}

/**
 * Chooses the language she answers in: what the customer wrote in (this message, or earlier in the
 * conversation), else their browser's, else the brand's; then one of her allowed languages.
 */
export function chooseLanguage(input: {
  detected: string | null;
  conversation: string | null;
  browser: string | null;
  brand: string;
  allowed: string[];
  other: OtherLanguages;
}): LanguageChoice {
  const allowed = input.allowed.length ? input.allowed : ALL_LANGUAGES;
  const brand = canonical(input.brand) ?? "en";
  const browser = canonical(input.browser);
  // Portuguese whose words don't say which: the browser's or the brand's variant, else Brazil's.
  const variant = (tag: string | null) => {
    if (tag !== "pt") return tag === "pt-PT" ? "pt" : tag;
    const hint = [browser, brand].find((h) => h && base(h) === "pt");
    return hint === "pt-BR" ? "pt-BR" : hint ? "pt" : "pt-BR";
  };
  const detected = variant(input.detected);
  const conversation = variant(input.conversation);
  const [customer, source] = detected
    ? ([detected, "message"] as const)
    : conversation
      ? ([conversation, "conversation"] as const)
      : browser
        ? ([browser, "browser"] as const)
        : ([brand, "brand"] as const);
  const own = matchLanguage(customer, allowed);
  const fallback = matchLanguage(brand, allowed) ?? allowed[0];
  const handOver =
    !own &&
    input.other === "hand_over" &&
    (source === "message" || source === "conversation");
  const answer = own ?? fallback;
  const chain = [
    ...new Set(
      [own && customer !== answer ? customer : null, answer, base(answer), brand, base(brand)]
        .map(canonical)
        .filter((l): l is string => !!l),
    ),
  ];
  return { answer, customer, detected, source, handOver, chain };
}
