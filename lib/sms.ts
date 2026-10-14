/**
 * SMS arithmetic (phase 12, step E6; docs/OMNICHANNEL_STEP6.md), shared by the server (which
 * refuses what's too long) and the composer (which shows it as it's written).
 *
 * - **Segments:** a text in the GSM-7 alphabet takes 160 characters in one segment, 153 in each of
 *   several (the rest carry the joining header); its extension characters (€, [, ], {, }, ~, ^, |, \)
 *   count twice. Anything else (an emoji, most non-Latin scripts) sends the whole text as UCS-2:
 *   70 in one, 67 in each of several, counted in UTF-16 units (an emoji counts twice).
 * - **Countries:** a number's calling code (+1, +44, +234), which picks the number a reply goes from
 *   and the price of a segment.
 */
const GSM7 = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
const GSM7_EXTENDED = new Set("^{}\\[~]|€\f");
export const MAX_SEGMENTS = 10;

export type Segments = { encoding: "GSM-7" | "UCS-2"; units: number; segments: number; perSegment: number };
export function segmentsOf(text: string): Segments {
  let units = 0;
  for (const ch of text) {
    if (GSM7.has(ch)) units += 1;
    else if (GSM7_EXTENDED.has(ch)) units += 2;
    else {
      const ucs = text.length;
      return { encoding: "UCS-2", units: ucs, segments: ucs === 0 ? 0 : ucs <= 70 ? 1 : Math.ceil(ucs / 67), perSegment: ucs <= 70 ? 70 : 67 };
    }
  }
  return { encoding: "GSM-7", units, segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153), perSegment: units <= 160 ? 160 : 153 };
}

/** Two-digit calling codes; the rest are one digit (1, 7) or three. */
const TWO = new Set(
  "20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98".split(" "),
);
/** A number's calling code (digits, no plus), from its E.164 form. */
export function callingCode(e164: string) {
  const d = e164.replace(/^\+/, "");
  if (d.startsWith("1") || d.startsWith("7")) return d[0];
  return TWO.has(d.slice(0, 2)) ? d.slice(0, 2) : d.slice(0, 3);
}

/**
 * A rough price per segment, in US dollars, where the workspace hasn't set its own (Settings ›
 * SMS): an estimate for the composer, never a bill.
 */
export const DEFAULT_PRICES: Record<string, number> = {
  "1": 0.0083,
  "44": 0.0524,
  "33": 0.0786,
  "49": 0.0864,
  "34": 0.0772,
  "39": 0.0821,
  "31": 0.0989,
  "61": 0.0515,
  "64": 0.1146,
  "91": 0.0832,
  "234": 0.1107,
  "27": 0.0393,
  "55": 0.0425,
  "52": 0.0306,
  "65": 0.0473,
  "353": 0.0789,
};
