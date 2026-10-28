/**
 * Content redaction (phase 16, step C6b; docs/SECURITY_STEP10.md): one redactor for everything
 * stored. Built-in rules (card numbers checked by Luhn, IBANs by mod 97, US Social Security numbers,
 * UK National Insurance numbers) and a workspace's custom patterns. A match becomes asterisks, as
 * long as what it replaced. Shared by the server (where text is stored) and the settings page (the
 * preview).
 *
 * A custom pattern is a regular expression checked by `checkPattern`: at most 200 characters, no
 * back-references or look-arounds, no repeated group that itself repeats or alternates (the shapes
 * that backtrack without end), nothing that matches empty text, and fast on hostile input.
 */
export type BuiltIn = "card" | "iban" | "us_ssn" | "uk_ni";
export const BUILT_INS: { id: BuiltIn; label: string; example: string }[] = [
  { id: "card", label: "Card numbers", example: "4111 1111 1111 1111" },
  { id: "iban", label: "IBANs (bank account numbers)", example: "GB82 WEST 1234 5698 7654 32" },
  { id: "us_ssn", label: "US Social Security numbers", example: "123-45-6789" },
  { id: "uk_ni", label: "UK National Insurance numbers", example: "AB 12 34 56 C" },
];
export type Rule = { kind: "builtin"; builtin: BuiltIn } | { kind: "custom"; pattern: string };
export const MAX_PATTERN = 200;

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
const ibanValid = (raw: string) => {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
};
/** Each built-in: candidates by shape, kept only when they check out. */
const DETECTORS: Record<BuiltIn, { re: RegExp; ok?: (m: string) => boolean }> = {
  card: { re: /\b(?:\d[ -]?){12,18}\d\b/g, ok: (m) => luhn(m.replace(/\D/g, "")) },
  iban: { re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, ok: ibanValid },
  us_ssn: { re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  uk_ni: { re: /\b(?![DFIQUV])[A-CEGHJ-PR-TW-Z](?![DFIOQUV])[A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/gi },
};

/** Why a custom pattern can't be used, or null. */
export function checkPattern(pattern: unknown): string | null {
  if (typeof pattern !== "string" || !pattern.trim()) return "Enter a pattern.";
  if (pattern.length > MAX_PATTERN) return `Use at most ${MAX_PATTERN} characters.`;
  if (/\\[1-9]|\\k</.test(pattern)) return "Back-references (like \\1) aren't allowed.";
  if (/\(\?<?[=!]/.test(pattern)) return "Look-aheads and look-behinds aren't allowed.";
  // A repeated group that itself repeats or alternates: (a+)+, (\d*)*, (a|ab)+.
  if (/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\}|\|)(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,?\d*\})/.test(pattern)) return "A repeated group can't itself repeat or have alternatives (it can run for ever).";
  let re: RegExp;
  try {
    re = new RegExp(pattern, "gu");
  } catch {
    return "That isn't a valid regular expression.";
  }
  if (re.test("")) return "That pattern matches empty text.";
  // Timed against hostile input: long runs of what patterns usually repeat, with a final mismatch.
  for (const input of ["a".repeat(5000) + "!", "1".repeat(5000) + "x", "a1 ".repeat(1700) + "\u0000", " ".repeat(5000) + "x"]) {
    const started = performance.now();
    input.replace(new RegExp(pattern, "gu"), "*");
    if (performance.now() - started > 25) return "That pattern is too slow on long text. Make it more specific.";
  }
  return null;
}

/** A redactor for a workspace's enabled rules (custom patterns already checked). */
export function redactor(rules: Rule[]) {
  const steps = rules.map((r) =>
    r.kind === "builtin" ? DETECTORS[r.builtin] : { re: new RegExp(r.pattern, "gu"), ok: undefined },
  );
  let hits = 0;
  const text = (s: string) => {
    if (!s || !steps.length) return s;
    let out = s;
    for (const { re, ok } of steps)
      out = out.replace(new RegExp(re.source, re.flags), (m) => {
        if (ok && !ok(m)) return m;
        hits++;
        return "*".repeat(m.length);
      });
    return out;
  };
  return {
    on: steps.length > 0,
    text,
    /** HTML: only the text between tags (tags and attributes untouched). */
    html: (s: string) => (!s || !steps.length ? s : s.replace(/(^|>)([^<]+)/g, (_, open: string, inner: string) => open + text(inner))),
    /** Every string in a JSON value. */
    json: <T>(v: T): T => {
      const walk = (x: unknown): unknown =>
        typeof x === "string" ? text(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x;
      return (steps.length ? walk(v) : v) as T;
    },
    /** A rich-text document: only its text nodes (`text`), so ids, mentions and links stay intact. */
    doc: <T>(v: T): T => {
      const walk = (x: unknown): unknown =>
        Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, k === "text" && typeof y === "string" ? text(y) : walk(y)])) : x;
      return (steps.length ? walk(v) : v) as T;
    },
    hits: () => hits,
  };
}
export type Redactor = ReturnType<typeof redactor>;
