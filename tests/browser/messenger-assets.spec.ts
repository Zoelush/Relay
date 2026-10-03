import { test, expect, type Locator, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { PNG_PIXEL } from "../fixtures/documents";
import { section, setLive } from "./messenger-sections";

/** Messenger settings M5 (docs/MESSENGER_SETTINGS_STEP5.md): uploading the messenger's images. */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1500, height: 1100 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 8996,
    hostPort: 8997,
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
async function appearance(page: Page) {
  await page.goto(relay.hostOrigin + "/agent#settings/messenger");
  await expect(page.getByTestId("publish-state")).toBeVisible({
    timeout: 15000,
  });
  await section(page, "Widget", "Messenger theme and branding", "Appearance");
}
const png = (name: string) => ({
  name,
  mimeType: "image/png",
  buffer: Buffer.from(PNG_PIXEL),
});
const preview = (page: Page) =>
  page.frameLocator('iframe[title="Messenger preview"]');
/** Whether an image has actually loaded (not just been given an address). */
const loaded = (img: Locator) =>
  img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0);

test("the Home logo, launcher logo and Home background are uploaded, shown in the preview at once, and on the customer's site once set live", async ({
  page,
  browser,
}) => {
  await appearance(page);
  await page
    .getByLabel("Upload the home screen logo")
    .setInputFiles(png("logo.png"));
  const homeLogo = page.getByRole("img", { name: "Home screen logo preview" });
  await expect(homeLogo).toBeVisible({ timeout: 15000 });
  await page
    .getByLabel("Upload the launcher logo")
    .setInputFiles(png("launcher.png"));
  await expect(
    page.getByRole("img", { name: "Launcher logo preview" }),
  ).toBeVisible({ timeout: 15000 });
  await page
    .getByLabel("Home background", { exact: true })
    .selectOption({ label: "An image" });
  await page
    .getByLabel("Upload the background image")
    .setInputFiles(png("background.png"));
  await expect(
    page.getByRole("img", { name: "Background image preview" }),
  ).toBeVisible({ timeout: 15000 });

  // The preview shows the draft's images straight away, through the agent app.
  const p = preview(page);
  const brandImage = p.locator("header .brand img");
  await expect(brandImage).toHaveAttribute("src", /\/api\/agent\/messenger-asset\?id=/);
  await expect.poll(() => loaded(brandImage)).toBe(true);
  expect(
    await p
      .locator(".intro.hero")
      .evaluate((el) => getComputedStyle(el).backgroundImage),
  ).toContain("/api/agent/messenger-asset");
  await expect(
    page.getByRole("img", { name: "Launcher preview" }).locator("img"),
  ).toHaveAttribute("src", /messenger-asset/);

  // Not live yet: customers can't fetch them.
  const [draftAsset] = await sql<{ id: string }>(
    "SELECT id FROM brand_assets WHERE purpose='home_logo' AND status='ready'",
  );
  const before = await page.request.get(
    `${relay.apiOrigin}/v1/messenger/brand-asset?w=demo&id=${draftAsset.id}`,
  );
  expect(before.status()).toBe(404);

  await setLive(page);
  await expect(page.locator(".pg-settings-notice")).toContainText(
    "Published version 1.",
  );

  // The customer's site: the launcher shows the uploaded logo, and so does the messenger.
  const site = await (await browser.newContext()).newPage();
  // The launcher lives in a closed shadow root; opened here only so the test can read it.
  await site.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      return attach.call(this, { ...init, mode: "open" });
    };
  });
  await site.goto(relay.hostOrigin);
  const launcherImage = site.locator("relay-launcher button img");
  await expect(launcherImage).toHaveAttribute(
    "src",
    new RegExp(`^${relay.apiOrigin}/v1/messenger/brand-asset\\?`),
    { timeout: 15000 },
  );
  await expect.poll(() => loaded(launcherImage)).toBe(true);
  await site.locator("relay-launcher button").first().click();
  await expect
    .poll(() =>
      site.frames().some((f) => f.url().includes("/messenger/frame.html")),
    )
    .toBe(true);
  const frame = site
    .frames()
    .find((f) => f.url().includes("/messenger/frame.html"))!;
  const logo = frame.locator("header .brand img");
  await expect(logo).toHaveAttribute("src", /\/v1\/messenger\/brand-asset\?/);
  await expect.poll(() => loaded(logo)).toBe(true);
  expect(
    await frame
      .locator(".intro.hero")
      .evaluate((el) => getComputedStyle(el).backgroundImage),
  ).toContain("/v1/messenger/brand-asset");
});

test("an image that isn't what it says, or an SVG, is refused with the reason, and the live messenger is unchanged", async ({
  page,
}) => {
  await appearance(page);
  const versions = (
    await sql("SELECT count(*)::int AS n FROM messenger_versions")
  )[0].n;
  const field = page.getByRole("group", { name: "Launcher logo" });
  const shown = await field.getByRole("img").count();

  // An SVG never leaves the browser.
  await page.getByLabel("Upload the launcher logo").setInputFiles({
    name: "logo.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  });
  await expect(field.getByRole("alert")).toHaveText(
    "SVG images can carry scripts, so they aren't accepted. Save it as a PNG.",
  );
  // A "PNG" that's really a web page is caught by Relay's check.
  await page.getByLabel("Upload the launcher logo").setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: Buffer.from("<html><script>alert(1)</script></html>"),
  });
  await expect(field.getByRole("alert")).toContainText(
    "The file's contents do not match its type.",
    { timeout: 15000 },
  );
  await expect(field.getByRole("img")).toHaveCount(shown);
  const [rejected] = await sql<{ failure_code: string }>(
    "SELECT failure_code FROM brand_assets WHERE name='logo.png' AND status='rejected'",
  );
  expect(rejected.failure_code).toBe("TYPE_MISMATCH");
  expect(
    (await sql("SELECT count(*)::int AS n FROM messenger_versions"))[0].n,
  ).toBe(versions);
});
