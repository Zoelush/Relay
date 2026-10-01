/**
 * Slugs and language fallback for the help center (phase 07, step A2). Shared by the server and
 * the Knowledge section, which previews a slug as it is typed.
 */

/** A clean slug: lower-case ASCII words joined by single hyphens, at most 80 characters. */
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MAX = 80;

/** Letters that Unicode decomposition does not reduce to ASCII. */
const SPECIAL: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  þ: "th",
  ł: "l",
  ı: "i",
  ħ: "h",
  "&": " and ",
};

/**
 * A slug from a title: accents removed ("Réinitialiser" → "reinitialiser"), other characters
 * become hyphens, cut at a word boundary. Text with no Latin letters or digits (Arabic, Japanese…)
 * gives "", and the caller uses a fallback.
 */
export function slugify(text: string) {
  const ascii = text
    .toLowerCase()
    .replace(/[ßæœøđðþłıħ&]/g, (c) => SPECIAL[c] ?? c)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  const slug = ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length <= SLUG_MAX) return slug;
  const cut = slug.slice(0, SLUG_MAX + 1);
  const end = cut.lastIndexOf("-");
  return (end > 0 ? cut.slice(0, end) : cut.slice(0, SLUG_MAX)).replace(
    /-+$/,
    "",
  );
}

/** Each shorter form of a language tag: fr-Latn-CA → fr-Latn → fr. */
function bases(locale: string) {
  const parts = locale.split("-");
  const out: string[] = [];
  for (let n = parts.length - 1; n >= 1; n--)
    out.push(parts.slice(0, n).join("-"));
  return out;
}

/**
 * The language a help center shows for a request, and the order to look for content in.
 * `locale` is the requested language if the help center supports it, otherwise its nearest
 * supported base, otherwise the default. `chain` is that language, its supported bases, then
 * the default: fr-CA → fr → en.
 */
export function resolveLocale(
  requested: string,
  center: { defaultLocale: string; locales: string[] },
) {
  const supported = new Set(center.locales);
  let canonical = requested;
  try {
    [canonical] = Intl.getCanonicalLocales(requested);
  } catch {
    canonical = center.defaultLocale;
  }
  const locale =
    [canonical, ...bases(canonical)].find((l) => supported.has(l)) ??
    center.defaultLocale;
  const chain = [
    ...new Set(
      [locale, ...bases(locale)]
        .filter((l) => supported.has(l))
        .concat(center.defaultLocale),
    ),
  ];
  return { locale, chain };
}

/** Public paths, relative to the help center root (B1 adds `/help/{workspace}/`). */
export const helpPath = {
  home: (center: string, locale: string) => `${center}/${locale}`,
  collection: (center: string, locale: string, slug: string) =>
    `${center}/${locale}/collections/${slug}`,
  section: (center: string, locale: string, slug: string) =>
    `${center}/${locale}/sections/${slug}`,
  article: (center: string, locale: string, slug: string) =>
    `${center}/${locale}/articles/${slug}`,
};
