import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** Settings › Channels (S3b; docs/SETTINGS_STEP5.md): brands, the messenger, the portal. */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1100 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 8966, hostPort: 8967 });
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
async function open(page: Page, settingsPage: string) {
  await page.goto(relay.hostOrigin + "/agent#settings/" + settingsPage);
  await expect(page.locator("#settings-title")).toBeVisible({ timeout: 15000 });
}
const notice = (page: Page) => page.locator(".pg-settings-notice");
const save = (page: Page) =>
  page.getByRole("button", { name: "Save", exact: true });

test("a brand added, the default brand's messenger restyled with a new greeting and website (and the live messenger shows it), the install snippet, and the portal's visibility and domain", async ({
  page,
  browser,
}) => {
  // Brands: the default is listed with its website; a new one has none.
  await open(page, "brands");
  const brands = page.getByRole("list", { name: "Brands" });
  await expect(brands).toContainText(relay.hostOrigin);
  await page.getByLabel("Brand name").fill("Acme Outdoors");
  await page.getByRole("button", { name: "Add brand" }).click();
  await expect(notice(page)).toContainText("Added Acme Outdoors.");
  await expect(brands).toContainText("No websites yet");
  // Its messenger opens from the list.
  await page
    .getByRole("button", { name: "Messenger for Acme Outdoors" })
    .click();
  await expect(page).toHaveURL(/#settings\/messenger$/);
  await expect(page.getByLabel("Brand", { exact: true })).toHaveValue(
    "acme-outdoors",
  );
  await expect(
    page.getByText("No websites yet: the messenger won't load anywhere."),
  ).toBeVisible();

  // The default brand: colour, side, greeting and a second website.
  await page.getByLabel("Brand", { exact: true }).selectOption("default");
  await expect(save(page)).toBeDisabled();
  await page.getByLabel("Brand colour", { exact: true }).fill("#aa3311");
  await page.getByLabel("Bottom left").check();
  await page
    .getByRole("textbox", { name: "Greeting", exact: true })
    .fill("Ask us anything");
  await page.getByLabel("Website address").fill("https://www.shop.test/");
  await page.getByRole("button", { name: "Add website" }).click();
  await expect(page.getByRole("list", { name: "Websites" })).toContainText(
    "https://www.shop.test",
  );
  await save(page).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  await expect(save(page)).toBeDisabled();
  const [stored] = await sql<{ settings: Record<string, unknown> }>(
    "SELECT settings FROM brands WHERE id='default'",
  );
  expect(stored.settings).toMatchObject({
    color: "#aa3311",
    position: "left",
    teamIntroduction: "Ask us anything",
    allowedOrigins: [relay.hostOrigin, "https://www.shop.test"],
  });
  // The install snippet names this brand and the loader.
  const snippet = page.getByLabel("Install snippet");
  await expect(snippet).toContainText("brandId: 'default'");
  await expect(snippet).toContainText(`${relay.apiOrigin}/messenger/loader.js`);

  // The live messenger on the customer's site shows the new greeting and colour.
  const site = await (await browser.newContext()).newPage();
  await site.goto(relay.hostOrigin);
  await site.getByRole("button", { name: "Open support", exact: true }).click();
  await expect
    .poll(() =>
      site.frames().some((f) => f.url().includes("/messenger/frame.html")),
    )
    .toBe(true);
  const frame = site
    .frames()
    .find((f) => f.url().includes("/messenger/frame.html"))!;
  await expect(frame.getByText("Ask us anything")).toBeVisible();
  const css = await (
    await site.request.get(
      `${relay.apiOrigin}/messenger/theme.css?workspace=demo&brand=default`,
    )
  ).text();
  expect(css).toContain("#aa3311");

  // The portal: company-wide visibility and a custom domain for Acme.
  await open(page, "portal");
  await expect(
    page.getByRole("list", { name: "Portal addresses" }),
  ).toContainText(`${relay.apiOrigin}/portal/demo/acme-outdoors`);
  await page.getByLabel(/^Everyone at their company/).click();
  await expect(notice(page)).toContainText(
    "Customers now see their company's requests.",
  );
  await expect(page.getByLabel(/^Everyone at their company/)).toBeChecked();
  await page.getByLabel("Host name").fill("help.acme.test");
  await page.getByLabel("For brand").selectOption({ label: "Acme Outdoors" });
  await page.getByRole("button", { name: "Add domain" }).click();
  await expect(notice(page)).toContainText(
    "Added help.acme.test for Acme Outdoors.",
  );
  expect(
    await sql("SELECT host,brand_id FROM portal_domains ORDER BY host"),
  ).toEqual([{ host: "help.acme.test", brand_id: "acme-outdoors" }]);
  expect(
    (await sql("SELECT visibility FROM portal_settings"))[0].visibility,
  ).toBe("company");
});

test("a wildcard website is refused with the reason, keeping the change unsaved, and the messenger keeps loading where it did", async ({
  page,
}) => {
  // The default brand is shown first.
  await open(page, "messenger");
  const before = (
    await sql<{ o: string[] }>(
      "SELECT settings->'allowedOrigins' AS o FROM brands WHERE id='default'",
    )
  )[0].o;
  await page.getByLabel("Website address").fill("https://*.shop.test");
  await page.getByRole("button", { name: "Add website" }).click();
  await save(page).click();
  await expect(page.getByRole("alert")).toContainText(
    "“https://*.shop.test” isn't a website address.",
  );
  await expect(save(page)).toBeEnabled();
  await expect(page.getByRole("list", { name: "Websites" })).toContainText(
    "https://*.shop.test",
  );
  expect(
    (
      await sql<{ o: string[] }>(
        "SELECT settings->'allowedOrigins' AS o FROM brands WHERE id='default'",
      )
    )[0].o,
  ).toEqual(before);
});
