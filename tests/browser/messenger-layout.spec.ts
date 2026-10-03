import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { section, setLive, tab } from "./messenger-sections";

/** Messenger settings M4 (docs/MESSENGER_SETTINGS_STEP4.md): Intercom's layout, the brand's colours. */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1500, height: 1100 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 8994,
    hostPort: 8995,
    aiAgent: false,
  });
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(text: string, values: unknown[] = []) =>
  tenant(
    relay.db.connect,
    "demo",
    async (db) => (await db.query<T>(text, values)).rows,
  );
async function settings(page: Page) {
  await page.goto(relay.hostOrigin + "/agent#settings/messenger");
  await expect(page.getByTestId("publish-state")).toBeVisible({
    timeout: 15000,
  });
}
const preview = (page: Page) =>
  page.frameLocator('iframe[title="Messenger preview"]');
const titles = (page: Page) => page.locator(".pg-accordion h3 strong");
const YELLOW = "rgb(255, 210, 31)";
const BLACK = "rgb(0, 0, 0)";

test("the page is laid out as Intercom's; a pale yellow brand gets black text and darker links, in the preview and on the customer's site, with no green anywhere", async ({
  page,
  browser,
}) => {
  await settings(page);
  await expect(
    page.getByRole("tablist", { name: "Messenger settings" }).getByRole("tab"),
  ).toHaveText(["Widget", "Conversations", "General", "Install", "Security"]);
  await expect(titles(page)).toHaveText([
    "Spaces",
    "Launch directly into a conversation",
    "Set your welcome message",
    "Customize Home with cards",
    "Show the Messenger launcher",
  ]);
  // Closed sections say what's set; one opens at a time.
  await expect(
    page.locator(".pg-accordion", { hasText: "Spaces" }).locator("small"),
  ).toHaveText("Home, Messages, Help");
  await section(page, "Widget", "Spaces");
  await section(page, "Widget", "Set your welcome message");
  await expect(page.locator(".pg-accordion[data-open]")).toHaveCount(1);
  await page
    .getByRole("radiogroup", { name: "Widget settings" })
    .getByRole("radio", { name: "Appearance" })
    .click();
  await expect(titles(page)).toHaveText([
    "Brand",
    "Messenger theme and branding",
    "Teammate avatars",
    "Launcher position",
  ]);
  await page
    .getByRole("tablist", { name: "Messenger settings" })
    .getByRole("tab", { name: "General" })
    .click();
  await expect(titles(page)).toHaveText([
    "Control inbound volume",
    "Supported languages",
    "Keep your Messenger secure",
    "Configure privacy settings",
    "Other preferences",
  ]);
  // Opening a section shows its space in the preview.
  await section(page, "General", "Configure privacy settings");
  await expect(page.getByLabel("Preview page")).toHaveValue("messages");
  await expect(
    preview(page).getByRole("navigation").getByRole("button", { name: /Messages/ }),
  ).toHaveAttribute("aria-current", "page");

  // A pale yellow, in the light scheme.
  await section(page, "Widget", "Messenger theme and branding", "Appearance");
  await page.getByLabel("Colour scheme").selectOption("light");
  await page.getByLabel("Primary colour", { exact: true }).fill("#ffd21f");
  await expect(page.getByTestId("readability")).toContainText(
    "Text on it is black",
  );
  await expect(page.getByTestId("readability")).toContainText(
    "Links use #806910",
  );
  const p = preview(page);
  await page.getByLabel("Preview page").selectOption("home");
  await expect(p.locator(".primary.start")).toHaveCSS(
    "background-color",
    YELLOW,
  );
  await expect(p.locator(".primary.start")).toHaveCSS("color", BLACK);
  await expect(p.locator("html")).toHaveCSS(
    "background-color",
    "rgb(246, 246, 247)",
  );
  await setLive(page);
  await expect(page.locator(".pg-settings-notice")).toContainText(
    "Published version 1.",
  );

  // The customer's site: the launcher and the messenger in yellow, black on it, darker links.
  const site = await (await browser.newContext()).newPage();
  // The launcher lives in a closed shadow root; opened here only so the test can read its style.
  await site.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      return attach.call(this, { ...init, mode: "open" });
    };
  });
  await site.goto(relay.hostOrigin);
  const launcher = site.locator("relay-launcher button").first();
  await expect(launcher).toHaveCSS("background-color", YELLOW, {
    timeout: 15000,
  });
  await expect(launcher).toHaveCSS("color", BLACK);
  await launcher.click();
  await expect
    .poll(() =>
      site.frames().some((f) => f.url().includes("/messenger/frame.html")),
    )
    .toBe(true);
  const frame = site
    .frames()
    .find((f) => f.url().includes("/messenger/frame.html"))!;
  const start = frame.locator(".primary.start");
  await expect(start).toHaveCSS("background-color", YELLOW);
  await expect(start).toHaveCSS("color", BLACK);
  await expect(frame.locator(".brand-mark")).toHaveCSS(
    "color",
    "rgb(128, 105, 16)",
  );
  // No colour in the messenger is Relay's green.
  const greens = await frame.evaluate(() =>
    [...document.querySelectorAll("*")].filter((el) => {
      const s = getComputedStyle(el);
      return [s.color, s.backgroundColor, s.borderTopColor].includes(
        "rgb(8, 122, 87)",
      );
    }).length,
  );
  expect(greens).toBe(0);

  // Install and Security have their own tabs.
  await tab(page, "Install");
  await expect(page.getByLabel("Install snippet")).toBeVisible();
  await tab(page, "Security");
  await expect(
    page.getByRole("heading", { name: "Identity verification", exact: true }),
  ).toBeVisible();
});

test("a primary colour that isn't a hex colour is refused with the reason, and nothing goes live", async ({
  page,
}) => {
  await settings(page);
  const before = (
    await sql("SELECT count(*)::int AS n FROM messenger_versions")
  )[0].n;
  await section(page, "Widget", "Messenger theme and branding", "Appearance");
  await page.getByLabel("Primary colour", { exact: true }).fill("#ffd2");
  await expect(page.getByTestId("readability")).toContainText(
    "Type a colour such as #1d4ed8.",
  );
  await setLive(page);
  await expect(page.getByRole("alert")).toContainText(
    "Choose the primary colour as six-digit hex, such as #1d4ed8.",
  );
  expect(
    (await sql("SELECT count(*)::int AS n FROM messenger_versions"))[0].n,
  ).toBe(before);
  // The section stays open on the colour to fix.
  await expect(
    page.getByLabel("Primary colour", { exact: true }),
  ).toHaveValue("#ffd2");
});
