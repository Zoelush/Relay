import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** Messenger settings M2 (docs/MESSENGER_SETTINGS_STEP2.md): the look and the live preview. */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1500, height: 1100 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 8982,
    hostPort: 8983,
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
const notice = (page: Page) => page.locator(".pg-settings-notice");

test("the preview shows the draft as it's edited, for visitors and users, light and dark; published, the customer's messenger has the new look", async ({
  page,
  browser,
}) => {
  // The preview never talks to the messenger API.
  const calls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/v1/messenger/")) calls.push(r.url());
  });
  await settings(page);
  const p = preview(page);
  await expect(p.getByRole("heading", { level: 1 })).toHaveText("Hi 👋");

  // Edits show in the preview before anything is saved.
  await page.getByLabel("Greeting (English)").fill("Welcome {first_name} 👋");
  await expect(p.getByRole("heading", { level: 1 })).toHaveText("Welcome 👋");
  await page
    .getByLabel("Home background", { exact: true })
    .selectOption({ label: "A gradient" });
  await page.getByRole("checkbox", { name: /Fade the background/ }).check();
  await expect(p.locator(".intro.hero")).toHaveAttribute("data-fade", "true");
  expect(
    await p
      .locator(".intro.hero")
      .evaluate((el) => getComputedStyle(el).backgroundImage),
  ).toContain("linear-gradient");
  await page.getByRole("checkbox", { name: /Show teammates on Home/ }).check();
  await expect(
    p.getByRole("list", { name: "The team" }).getByRole("listitem"),
  ).toHaveCount(3);

  // A different colour in the dark theme, seen with the preview set to dark.
  await page
    .getByRole("checkbox", { name: /different colour in the dark theme/ })
    .check();
  await page.getByLabel("Dark theme colour", { exact: true }).fill("#2bb88a");
  const start = p.locator(".primary.start");
  await page
    .getByRole("radiogroup", { name: "Preview theme" })
    .getByRole("radio", { name: "Dark" })
    .click();
  await expect(start).toHaveCSS("background-color", "rgb(43, 184, 138)");
  await page
    .getByRole("radiogroup", { name: "Preview theme" })
    .getByRole("radio", { name: "Light" })
    .click();
  await expect(start).toHaveCSS("background-color", "rgb(8, 122, 87)");

  // Users: their name in the welcome, and Tickets among the spaces.
  await page.getByRole("radio", { name: "Users" }).click();
  await page.getByRole("checkbox", { name: /^Tickets/ }).check();
  await expect(p.getByRole("heading", { level: 1 })).toHaveText(
    "Welcome Alex 👋",
  );
  await expect(
    p.getByRole("navigation").getByRole("button", { name: /Tickets/ }),
  ).toBeVisible();

  // The launcher: spacing and side, drawn beside the preview.
  await page.getByLabel("Side spacing (px)").fill("60");
  await page.getByLabel("Bottom spacing (px)").fill("40");
  expect(calls).toEqual([]);

  await page.getByRole("button", { name: "Publish" }).click();
  await expect(notice(page)).toContainText("Published version 1.");
  const live = (
    await sql(
      "SELECT settings->'messenger3'->'look' AS look FROM brands WHERE id='default'",
    )
  )[0].look;
  expect(live).toMatchObject({
    darkColor: "#2bb88a",
    header: { background: "gradient", fade: true },
    launcherSpacing: { side: 60, bottom: 40 },
    showTeammates: true,
  });

  // The customer's messenger: the welcome on its gradient, the team's initials, the spacing.
  const site = await (await browser.newContext()).newPage();
  await site.goto(relay.hostOrigin);
  const host = site.locator("[data-launcher]");
  await expect(host).toHaveAttribute("data-launcher", "shown", {
    timeout: 15000,
  });
  expect(
    await host.evaluate((el) =>
      (el as HTMLElement).style.getPropertyValue("--relay-side"),
    ),
  ).toBe("60px");
  await site.getByRole("button", { name: "Open support", exact: true }).click();
  await expect
    .poll(() =>
      site.frames().some((f) => f.url().includes("/messenger/frame.html")),
    )
    .toBe(true);
  const frame = site
    .frames()
    .find((f) => f.url().includes("/messenger/frame.html"))!;
  await expect(frame.getByRole("heading", { level: 1 })).toHaveText(
    "Welcome 👋",
  );
  expect(
    await frame
      .locator(".intro.hero")
      .evaluate((el) => getComputedStyle(el).backgroundImage),
  ).toContain("linear-gradient");
  // The demo workspace's teammates, as initials.
  await expect(frame.getByRole("list", { name: "The team" })).toContainText(
    "ST",
  );
});

test("a launcher logo that isn't https is refused with the reason, and nothing is published", async ({
  page,
}) => {
  await settings(page);
  const before = (
    await sql("SELECT count(*)::int AS n FROM messenger_versions")
  )[0].n;
  await page
    .getByLabel("Launcher logo")
    .fill("http://cdn.example.com/launcher.png");
  // The preview shows the ✦, never an insecure image.
  await expect(
    page.getByRole("img", { name: "Launcher preview" }),
  ).toContainText("✦");
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "The launcher logo needs an https:// image address.",
  );
  expect(
    (await sql("SELECT count(*)::int AS n FROM messenger_versions"))[0].n,
  ).toBe(before);
  await expect(page.getByRole("button", { name: "Save draft" })).toBeEnabled();
});
