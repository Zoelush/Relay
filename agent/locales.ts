/** Choosing which of a record's languages to show a teammate (phase 07). */
/** The teammate's languages, most preferred first (the browser's). */
export const teammateLanguages = () =>
  typeof navigator === "undefined" ? ["en"] : [...navigator.languages];
/** The best of a record's languages for these wishes: exact, then same base language. */
export function preferredLocale<T extends { locale: string }>(
  locales: T[],
  wanted: string[],
): T | undefined {
  for (const w of wanted) {
    const exact = locales.find(
      (l) => l.locale.toLowerCase() === w.toLowerCase(),
    );
    if (exact) return exact;
    const base = locales.find(
      (l) => l.locale.split("-")[0] === w.split("-")[0],
    );
    if (base) return base;
  }
  return locales[0];
}
