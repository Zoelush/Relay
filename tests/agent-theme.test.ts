import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  readChoice,
  resolveTheme,
  THEME_KEY,
  writeChoice,
} from "../agent/theme";

const css = readFileSync(
  new URL("../agent/inbox.css", import.meta.url),
  "utf8",
);
/** The custom properties declared in a rule whose selector is exactly `selector`. */
function tokens(selector: string) {
  const start = css.indexOf(selector + " {");
  assert(start >= 0, selector);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/--pg-([a-z0-9-]+):\s*(#[0-9a-f]{3,8})/gi)].map((m) => [
      m[1],
      m[2],
    ]),
  );
}
const light = tokens(":root");
const dark = tokens(':root[data-agent-theme="dark"]');

function rgba(hex: string) {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}
const luminance = ([r, g, b]: number[]) => {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
/** WCAG contrast of a colour over a background (a translucent colour is laid over it first). */
function contrast(fg: string, bg: string) {
  const b = rgba(bg),
    f = rgba(fg);
  const over = f.slice(0, 3).map((c, i) => c * f[3] + b[i] * (1 - f[3]));
  const [x, y] = [luminance(over), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const TINTS = [
  "blue",
  "violet",
  "rose",
  "amber",
  "teal",
  "green",
  "sky",
  "slate",
];
/**
 * Every pairing the stylesheet uses: text needs 4.5:1 (WCAG AA), and indicators, focus rings and
 * form-control borders 3:1 (non-text contrast).
 */
const TEXT: [string, string[]][] = [
  [
    "text",
    [
      "bg",
      "canvas",
      "surface",
      "sunken",
      "nav",
      "hover",
      "selected",
      "active",
      "chip",
      "note-bg",
      "note-bg-2",
      "info-bg",
      "danger-bg",
      "team-bg",
      "customer-bg",
    ],
  ],
  ["customer-text", ["customer-bg"]],
  [
    "text-2",
    [
      "canvas",
      "surface",
      "sunken",
      "nav",
      "selected",
      "note-bg",
      "team-bg",
      "customer-bg",
    ],
  ],
  [
    "text-3",
    [
      "canvas",
      "surface",
      "sunken",
      "nav",
      "selected",
      "team-bg",
      "customer-bg",
    ],
  ],
  [
    "muted",
    ["bg", "canvas", "surface", "sunken", "nav", "selected", "note-bg-2"],
  ],
  [
    "accent",
    [
      "bg",
      "canvas",
      "surface",
      "sunken",
      "nav",
      "selected",
      "team-bg",
      "customer-bg",
    ],
  ],
  ["accent-strong", ["selected", "active"]],
  ["on-accent", ["accent-fill"]],
  ["note-text", ["note-bg", "note-bg-2", "note-active", "surface"]],
  ["on-note", ["note-fill"]],
  ["warn-text", ["surface", "sunken"]],
  ["danger-text", ["danger-bg", "surface", "sunken"]],
  ["on-badge", ["badge"]],
  ["variable-text", ["variable-bg"]],
  ["neutral-text", ["neutral-bg"]],
  // Z1: the tints are text in avatars' initials, on their own soft ground; Zoe's tone is text too.
  ...TINTS.map((t): [string, string[]] => [
    `tint-${t}`,
    [`tint-${t}-bg`, "surface", "canvas"],
  ]),
  ["zoe-text", ["zoe-bg", "surface", "canvas", "nav"]],
  // Text on Zoe's gradient (her buttons): both ends must carry it.
  ["on-zoe", ["zoe-from", "zoe-to"]],
];
const NON_TEXT: [string, string[]][] = [
  // Z1: tinted icons on the strip and menus, at rest, hovered and selected; the mark on Zoe's gradient.
  ...TINTS.map((t): [string, string[]] => [
    `tint-${t}`,
    ["nav", "hover", "active", "sunken", `tint-${t}-bg`],
  ]),
  ["on-zoe", ["zoe-from", "zoe-to"]],
  ["focus", ["bg", "canvas", "surface"]],
  ["input-border", ["surface"]],
  ["accent", ["selected"]],
  ["icon-soft", ["canvas"]],
  ["warn-line", ["note-bg-2"]],
  ["danger-line", ["danger-bg", "surface"]],
  ["info-line", ["info-bg"]],
];

test("agent colours: both themes define the same colours, and nothing outside them sets one", () => {
  assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
  assert(Object.keys(light).length > 40);
  // Outside the two token blocks, colours only come from tokens.
  const rest = css
    .replace(/:root \{[^}]*\}/, "")
    .replace(/:root\[data-agent-theme="dark"\] \{[^}]*\}/, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.deepEqual(
    rest.match(/#[0-9a-f]{3,8}\b|:\s*(white|black)\b|rgba?\(|hsla?\(/gi),
    null,
  );
  // A token never lands inside a property name (replacing "white" once broke white-space).
  assert.deepEqual(css.match(/var\(--pg-[a-z0-9-]+\)-|-var\(--pg-/g), null);
  // And every token used is defined.
  for (const [, name] of rest.matchAll(/var\(--pg-([a-z0-9-]+)\)/g))
    assert(name in light, name);
});

for (const [name, theme] of [
  ["light", light],
  ["dark", dark],
] as const)
  test(`agent colours: ${name} theme meets WCAG AA contrast`, () => {
    const failures: string[] = [];
    for (const [pairs, minimum] of [
      [TEXT, 4.5],
      [NON_TEXT, 3],
    ] as const)
      for (const [fg, backgrounds] of pairs)
        for (const bg of backgrounds) {
          const ratio = contrast(theme[fg], theme[bg]);
          if (ratio < minimum)
            failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${minimum}`);
        }
    assert.deepEqual(failures, []);
  });

test("theme choice: saved per browser, Light by default, and safe when storage is blocked", () => {
  const saved = new Map<string, string>();
  const storage = () => ({
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => void saved.set(k, v),
  });
  assert.equal(readChoice(storage), "light");
  assert.equal(writeChoice(storage, "dark"), true);
  assert.equal(saved.get(THEME_KEY), "dark");
  assert.equal(readChoice(storage), "dark");
  saved.set(THEME_KEY, "sepia");
  assert.equal(readChoice(storage), "light", "an unknown value");
  const blocked = () => {
    throw new DOMException("blocked", "SecurityError");
  };
  assert.equal(readChoice(blocked), "light");
  assert.equal(writeChoice(blocked, "dark"), false);
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
});
