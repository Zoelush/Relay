import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8952, hostPort: 8953 });
  // A conversation with a customer message, a reply and an internal note.
  await tenant(relay.db.connect, "demo", async (db) => {
    const identity = await getIdentity(db, "demo", "anonymous", "dark-mode");
    const { conversationId } = (await command(
      db,
      "demo",
      { type: "contact", identityId: identity.identityId, brandId: "default" },
      "dark-mode-start",
      { action: "start", text: "Where is my parcel?" },
    )) as { conversationId: string };
    const teammate = { type: "teammate" as const, principal: "local-owner" };
    await command(db, "demo", teammate, "dark-mode-reply", {
      action: "reply",
      conversationId,
      text: "Looking into it now.",
    });
    await command(db, "demo", teammate, "dark-mode-note", {
      action: "note",
      conversationId,
      text: "Check the carrier first.",
    });
  });
});
test.afterAll(async () => {
  await relay?.close();
});

async function open(page: Page) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
}
/** The theme buttons, in the account menu (opened if it is not). */
async function themes(page: Page) {
  const menu = page.getByRole("dialog", { name: "Account" });
  if (!(await menu.isVisible()))
    await page.getByRole("button", { name: /^Account:/ }).click();
  return menu.getByRole("group", { name: "Theme" });
}
const closeMenu = (page: Page) => page.keyboard.press("Escape");
const theme = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.agentTheme);
const background = (page: Page) =>
  page.evaluate(
    () =>
      getComputedStyle(document.querySelector(".pg-inbox")!).backgroundColor,
  );

/**
 * Every visible piece of text on the page, measured as rendered: its colour over the colours
 * actually behind it. WCAG AA: 4.5:1, or 3:1 for large text. Disabled controls and content
 * faded on purpose (a message still sending) are exempt, as WCAG allows.
 */
async function lowContrast(page: Page) {
  return page.evaluate(() => {
    const parse = (c: string) => {
      const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
      return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1];
    };
    const over = (top: number[], bottom: number[]) =>
      [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3]));
    const lum = (c: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const backdrop = (el: Element): number[] => {
      const layers: number[][] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] === 1) break;
      }
      const canvas =
        document.documentElement.dataset.agentTheme === "dark"
          ? [18, 18, 18]
          : [255, 255, 255];
      return layers.reduceRight(
        (below, layer) => over(layer, below),
        layers.length && layers[layers.length - 1][3] === 1
          ? layers[layers.length - 1].slice(0, 3)
          : canvas,
      );
    };
    const failures: string[] = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent?.trim()) continue;
      seen.add(el);
      if (el.closest("option, script, style, [hidden], .pg-visually-hidden"))
        continue;
      if (el.closest("button:disabled, [aria-disabled='true'], .pg-pending"))
        continue;
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (
        style.visibility === "hidden" ||
        box.width < 2 ||
        box.height < 2 ||
        style.clip === "rect(0px, 0px, 0px, 0px)"
      )
        continue;
      let faded = false;
      for (let e: Element | null = el; e; e = e.parentElement)
        if (Number(getComputedStyle(e).opacity) < 1) faded = true;
      if (faded) continue;
      const fg = parse(style.color);
      const bg = backdrop(el);
      const shown = over(fg, bg);
      const [a, b] = [lum(shown), lum(bg)].sort((x, y) => y - x);
      const ratio = (a + 0.05) / (b + 0.05);
      const size = parseFloat(style.fontSize);
      const large =
        size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5))
        failures.push(
          `${ratio.toFixed(2)} "${n.textContent.trim().slice(0, 40)}" (${el.tagName.toLowerCase()}.${el.className})`,
        );
    }
    return failures;
  });
}

test("dark mode: switch, remembered after a reload, readable everywhere, and System follows the device", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  // Light until the teammate chooses otherwise, even on a dark device.
  expect(await theme(page)).toBe("light");
  await expect(
    (await themes(page)).getByRole("button", { name: "Light" }),
  ).toHaveAttribute("aria-pressed", "true");
  // The open account menu is checked for contrast too, in both themes.
  expect(await lowContrast(page)).toEqual([]);
  await closeMenu(page);
  // The check itself catches poor contrast, including text over a translucent layer.
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.id = "probe";
    p.textContent = "Hard to read";
    p.style.cssText = "color:#8a8a8a;background:#9a9a9a";
    document.querySelector(".pg-top")!.appendChild(p);
  });
  expect(await lowContrast(page)).toEqual([
    expect.stringContaining('"Hard to read"'),
  ]);
  await page.evaluate(() => document.getElementById("probe")!.remove());

  await (await themes(page)).getByRole("button", { name: "Dark" }).click();
  expect(await theme(page)).toBe("dark");
  expect(await background(page)).toBe("rgb(10, 10, 11)");
  expect(await lowContrast(page)).toEqual([]);
  await closeMenu(page);
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    ),
  ).toBe("dark");

  // The inbox, a conversation with a reply and an internal note, and the note composer.
  expect(await lowContrast(page)).toEqual([]);
  await page.getByRole("button", { name: /Where is my parcel\?/ }).click();
  await expect(page.getByText("Check the carrier first.")).toBeVisible();
  expect(await lowContrast(page)).toEqual([]);
  await page
    .getByRole("button", { name: "Internal note", exact: true })
    .click();
  expect(await lowContrast(page)).toEqual([]);
  // The mention list is attached to <body>, outside the app, and is themed too.
  await page.locator(".pg-editor").click();
  await page.keyboard.type("Ask @");
  const mentions = page.locator(".pg-mention-list");
  await expect(mentions).toBeVisible();
  expect(
    await mentions.evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.backgroundColor, s.color];
    }),
  ).toEqual(["rgb(22, 22, 24)", "rgb(236, 236, 238)"]);
  expect(await lowContrast(page)).toEqual([]);
  await page.keyboard.press("Escape");
  // A dialog over the dimmed inbox.
  await page.getByRole("button", { name: /^Shortcuts/ }).click();
  const shortcuts = page.getByRole("dialog");
  await expect(shortcuts).toBeVisible();
  expect(
    await shortcuts.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(22, 22, 24)");
  await page.keyboard.press("Escape");

  // Knowledge: the article editor, and help center settings.
  await page.getByRole("button", { name: "Knowledge" }).click();
  await page
    .getByRole("button", { name: /Getting started with Relay/ })
    .click();
  await expect(page.getByLabel("Title")).toHaveValue(
    "Getting started with Relay",
  );
  expect(await lowContrast(page)).toEqual([]);
  await page.getByRole("tab", { name: "Help centers" }).click();
  await expect(
    page.getByRole("region", { name: "Help center settings" }),
  ).toBeVisible();
  expect(await lowContrast(page)).toEqual([]);

  // Remembered in this browser.
  await open(page);
  expect(await theme(page)).toBe("dark");
  await expect(
    (await themes(page)).getByRole("button", { name: "Dark" }),
  ).toHaveAttribute("aria-pressed", "true");

  // System follows the device, live.
  await page.emulateMedia({ colorScheme: "light" });
  await (await themes(page)).getByRole("button", { name: "System" }).click();
  expect(await theme(page)).toBe("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => theme(page)).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => theme(page)).toBe("light");
});

test("dark mode with browser storage blocked: the switch still works for the visit, and the app starts in Light", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage is blocked", "SecurityError");
      },
    });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  expect(await theme(page)).toBe("light");
  await (await themes(page)).getByRole("button", { name: "Dark" }).click();
  expect(await theme(page)).toBe("dark");
  expect(await background(page)).toBe("rgb(10, 10, 11)");
  // Not kept: the next visit starts in Light, and nothing broke.
  await open(page);
  expect(await theme(page)).toBe("light");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});
