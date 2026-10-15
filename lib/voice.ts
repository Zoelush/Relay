/**
 * Voice (phase 12, step E9; docs/OMNICHANNEL_STEP9.md): text made to be spoken. Zoe's answers are
 * written for reading; on a call they're said by a voice, so links, formatting and lists become
 * plain sentences, and a long answer is cut at a sentence (the caller can ask for more).
 */
const MAX_SPOKEN = 600;
export function speakable(text: string) {
  let t = text
    // Links aren't read out.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link on our website")
    // An order or ticket number, before the marks go.
    .replace(/#(\d+)/g, "number $1")
    // Formatting marks, headings and quotes.
    .replace(/[*_`~#>]+/g, "")
    // List items become sentences.
    .replace(/^\s*(?:[-•]|\d+[.)])\s+(.*)$/gm, (_, item: string) => (/[.!?]$/.test(item.trim()) ? item.trim() : item.trim() + "."))
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (t.length > MAX_SPOKEN) {
    const cut = t.slice(0, MAX_SPOKEN);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    t = (end > 100 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + ".") + " Would you like me to go on?";
  }
  return t;
}
/** The language a call's speech is heard and spoken in, from Zoe's language code. */
export const SPEECH_LANGUAGE: Record<string, string> = {
  en: "en-US",
  fr: "fr-FR",
  de: "de-DE",
  es: "es-ES",
  pt: "pt-BR",
  it: "it-IT",
  nl: "nl-NL",
  ja: "ja-JP",
  ar: "ar-AE",
};
