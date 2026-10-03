import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { messengerAsset } from "../server/assets";
import {
  BACKGROUNDS,
  INK,
  contrast,
  onColour,
  palette,
  readableOn,
} from "../lib/brand-colours";

/** Messenger settings M4 (docs/MESSENGER_SETTINGS_STEP4.md): the brand's colours, readable. */
const sample = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    // A spread of hues and lightnesses, including the awkward middle greys and pale yellows.
    const v = (i * 2654435761) >>> 0;
    return "#" + (v & 0xffffff).toString(16).padStart(6, "0");
  });

test("brand colours: text on any brand colour, and the colour as links, meet 4.5:1 in both themes", () => {
  for (const c of [
    ...sample(400),
    "#ffffff",
    "#000000",
    "#ffd21f",
    "#777777",
    "#087a57",
  ]) {
    const p = palette(c, c);
    assert.ok(contrast(p.light.accent, p.light.onAccent) >= 4.5, c);
    assert.ok(contrast(p.light.accentText, BACKGROUNDS.light) >= 4.5, c);
    assert.ok(contrast(p.light.accentText, "#ffffff") >= 4.5, c);
    assert.ok(contrast(p.dark.accentText, BACKGROUNDS.dark) >= 4.5, c);
    assert.ok(contrast(p.dark.accentText, "#1b1b1f") >= 4.5, c);
  }
  // A pale yellow: black text on it, and darker links on the light theme.
  const yellow = palette("#ffd21f");
  assert.equal(yellow.light.onAccent, INK.dark);
  assert.notEqual(yellow.light.accentText, "#ffd21f");
  // On the dark theme the same yellow already reads as links, so it's unchanged.
  assert.equal(yellow.dark.accentText, "#ffd21f");
  // A dark blue keeps white text and its own colour for links in the light theme.
  assert.equal(onColour("#1d4ed8"), INK.light);
  assert.equal(readableOn("#1d4ed8", BACKGROUNDS.light), "#1d4ed8");
  // A separate dark-theme colour is used there; an unusable one falls back to the light colour.
  assert.equal(palette("#1d4ed8", "#93c5fd").dark.accent, "#93c5fd");
  assert.equal(palette("#1d4ed8", "blue").dark.accent, "#1d4ed8");
});

test("brand colours: the messenger and launcher have no colour of their own", () => {
  const frame = readFileSync("messenger/frame.css", "utf8");
  const launcher = readFileSync("public/messenger/launcher.css", "utf8");
  for (const [name, css] of [
    ["frame.css", frame],
    ["launcher.css", launcher],
  ]) {
    assert.doesNotMatch(css, /#087a57/i, `${name}: Relay's green`);
    // Every fill in the brand colour has its text from the palette, never a fixed white.
    for (const rule of css.split("}")) {
      if (/background:\s*var\(--(relay-)?accent/.test(rule))
        assert.match(
          rule,
          /color:\s*var\(--(relay-)?on-accent/,
          `${name}: ${rule.trim().split("{")[0]}`,
        );
    }
  }
  // The backgrounds colours are checked against are the ones the messenger uses.
  assert.match(frame, new RegExp(`--bg: ${BACKGROUNDS.light};`));
  assert.match(frame, new RegExp(`--surface: ${BACKGROUNDS.dark};`));
  // The messenger and Settings' preview read the shared palette, with no fallback colour.
  const tsx = readFileSync("messenger/frame.tsx", "utf8");
  assert.match(tsx, /paletteVariables\(palette\(/);
  assert.doesNotMatch(tsx, /#087a57/i);
});

test("brand colours: the launcher's stylesheet is in the brand's colour with readable text, per workspace", async () => {
  const db = await testDatabase();
  try {
    for (const [w, color] of [
      ["a", "#ffd21f"],
      ["b", "#1d4ed8"],
    ]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, {
          origins: ["https://shop.test"],
          master: "m".repeat(40),
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        }),
      );
      await tenant(db.connect, w, (q) =>
        q.query(
          "UPDATE brands SET settings=jsonb_set(settings,'{color}',to_jsonb($1::text)) WHERE id='default'",
          [color],
        ),
      );
    }
    const css = async (w: string) =>
      (
        await messengerAsset(
          new Request(
            `https://relay.test/messenger/theme.css?workspace=${w}&brand=default`,
          ),
          db.connect,
          async () => new Response(""),
        )
      ).text();
    assert.equal(
      await css("a"),
      ":host{--relay-accent:#ffd21f;--relay-on-accent:#000000}",
    );
    assert.equal(
      await css("b"),
      ":host{--relay-accent:#1d4ed8;--relay-on-accent:#ffffff}",
    );
    // An unknown workspace learns nothing.
    const other = await messengerAsset(
      new Request(
        "https://relay.test/messenger/theme.css?workspace=c&brand=default",
      ),
      db.connect,
      async () => new Response(""),
    );
    assert.equal(other.status, 404);
  } finally {
    await db.close();
  }
});
