/**
 * A brand's messenger colours (messenger settings M4; docs/MESSENGER_SETTINGS_STEP4.md). The
 * messenger has no colour of its own: its surfaces are neutral greys, and everything coloured comes
 * from the brand's primary colour for each theme. Text on the brand colour is black or white,
 * whichever reads better, and the brand colour used as text (links) is darkened or lightened until
 * it reads on the theme's background. Shared by the server (the launcher's stylesheet), the
 * messenger and Settings' preview, so all three agree.
 */
export const HEX = /^#[0-9a-fA-F]{6}$/;
/** A new brand's colour until it chooses its own. Nothing else falls back to it. */
export const DEFAULT_COLOR = "#087a57";
/** The neutral backgrounds colours are checked against (keep in step with messenger/frame.css). */
export const BACKGROUNDS = { light: "#f6f6f7", dark: "#26262b" } as const;
/** Pure black and white: on any colour, one of them reaches at least 4.58:1. */
export const INK = { light: "#ffffff", dark: "#000000" } as const;

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (parts: number[]) =>
  "#" +
  parts
    .map((p) => Math.round(Math.min(255, Math.max(0, p))).toString(16).padStart(2, "0"))
    .join("");
/** WCAG relative luminance. */
export const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio, 1 to 21. */
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** Black or white text on a colour, whichever has more contrast (always at least 4.5:1). */
export const onColour = (hex: string): string =>
  contrast(hex, INK.light) >= contrast(hex, INK.dark) ? INK.light : INK.dark;
/**
 * The colour as text on `background`: unchanged when it already reads (4.5:1), otherwise mixed
 * towards black (a light background) or white (a dark one) just far enough.
 */
export const readableOn = (hex: string, background: string): string => {
  if (contrast(hex, background) >= 4.5) return hex.toLowerCase();
  const toward = luminance(background) > 0.5 ? [0, 0, 0] : [255, 255, 255];
  const from = rgb(hex);
  for (let step = 1; step <= 20; step++) {
    const mixed = toHex(from.map((c, i) => c + ((toward[i] - c) * step) / 20));
    if (contrast(mixed, background) >= 4.5) return mixed;
  }
  return toHex(toward);
};
export const validColour = (value: unknown): string | null =>
  typeof value === "string" && HEX.test(value) ? value.toLowerCase() : null;

export type Palette = {
  /** Fills: buttons, the customer's own messages, the launcher. */
  accent: string;
  /** Text and icons on a fill: black or white. */
  onAccent: string;
  /** The brand colour as text, such as links, on the theme's background. */
  accentText: string;
};
export function palette(color: unknown, darkColor?: unknown): {
  light: Palette;
  dark: Palette;
} {
  const light = validColour(color) ?? DEFAULT_COLOR;
  const dark = validColour(darkColor) ?? light;
  const of = (accent: string, background: string): Palette => ({
    accent,
    onAccent: onColour(accent),
    accentText: readableOn(accent, background),
  });
  return { light: of(light, BACKGROUNDS.light), dark: of(dark, BACKGROUNDS.dark) };
}
/** The palette as the messenger's CSS variables (messenger/frame.css reads them). */
export const paletteVariables = (p: ReturnType<typeof palette>) => ({
  "--accent-light": p.light.accent,
  "--on-accent-light": p.light.onAccent,
  "--accent-text-light": p.light.accentText,
  "--accent-dark": p.dark.accent,
  "--on-accent-dark": p.dark.onAccent,
  "--accent-text-dark": p.dark.accentText,
});
