import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { standardSite, testSite, type TestSite } from "../fixtures/site";

let relay: Awaited<ReturnType<typeof startLocalRelay>>;
let site: TestSite;
test.use({ viewport: { width: 1440, height: 900 } });
test.beforeAll(async () => {
  site = await testSite();
  standardSite(site);
  // The test site is on loopback: reachable only through this explicit allowance.
  relay = await startLocalRelay({
    apiPort: 8950,
    hostPort: 8951,
    sync: { policy: { allowHosts: [site.host] } },
  });
});
test.afterAll(async () => {
  await relay?.close();
  await site?.close();
});
async function websites(page: Page) {
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText(
    "● Live",
  );
  await page.getByRole("button", { name: "Knowledge" }).click();
  await page.getByRole("tab", { name: "Websites" }).click();
}
async function add(page: Page, name: string, strip = "", exclude = "") {
  await page.getByRole("button", { name: "Add a website" }).click();
  const form = page.getByRole("form", { name: "Add a website" });
  await form.getByLabel("Address or sitemap").fill(site.origin + "/");
  await form.getByLabel("Name").fill(name);
  if (exclude)
    await form.getByLabel("Don't sync addresses matching").fill(exclude);
  if (strip) await form.getByLabel("Leave out page parts matching").fill(strip);
  await form.getByRole("button", { name: "Add and sync" }).click();
  await expect(form).toBeHidden();
}
const entry = (page: Page, name: string) =>
  page.getByRole("list", { name: "Websites" }).getByRole("button", {
    name: new RegExp(name),
  });

test("add a website, watch it sync, and find its pages in Knowledge", async ({
  page,
}) => {
  await websites(page);
  await add(page, "Help site", "nav\n.cookie-banner", "/blog/*");
  // The first sync runs in the background and the list follows it.
  await expect(entry(page, "Help site")).toContainText(/Synced .* · 4 pages/, {
    timeout: 30_000,
  });
  const detail = page.getByRole("region", { name: "Website Help site" });
  await expect(detail).toBeVisible();
  // Every page's state, with the reason when it wasn't synced.
  const pages = detail.getByRole("table");
  await expect(
    pages.getByRole("row", { name: /Shipping times/ }),
  ).toContainText("Synced");
  await expect(
    pages.getByRole("row", { name: /Staff|private\/staff/ }),
  ).toContainText(
    "Skipped: The site's robots.txt asks crawlers not to read this page.",
  );
  await expect(pages.getByRole("row", { name: /quiet/ })).toContainText(
    "The page asks not to be indexed.",
  );
  expect(site.hits).not.toContain("/private/staff");

  // In Knowledge: found by a word inside the page, read-only, with where it comes from.
  await page.getByRole("tab", { name: "Content" }).click();
  await page.getByLabel("Search knowledge").fill("wombat");
  const list = page.getByRole("region", { name: "Knowledge records" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("Synced page · en Published");
  await list.getByRole("button", { name: /Shipping times/ }).click();
  const panel = page.getByRole("region", { name: "Synced page" });
  await expect(
    panel.getByRole("link", { name: site.origin + "/shipping" }),
  ).toBeVisible();
  await expect(panel).toContainText("Orders ship within two working days");
  // No editor, and its settings are the website's.
  await expect(page.getByLabel("Article body")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Settings" })).toHaveCount(0);

  // A change on the site arrives with Sync now.
  site.page(
    "/shipping",
    "Shipping times",
    "<p>Orders now ship the same day by kangaroo express.</p>",
  );
  await page.getByRole("tab", { name: "Websites" }).click();
  await entry(page, "Help site").click();
  await page.getByRole("button", { name: "Sync now" }).click();
  // Wait for this run's result, not the previous run's "Synced".
  await expect(
    page.getByRole("region", { name: "Website Help site" }).getByRole("status"),
  ).toContainText("1 updated", { timeout: 30_000 });
  await page.getByRole("tab", { name: "Content" }).click();
  await page.getByLabel("Search knowledge").fill("kangaroo");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("Shipping times");
  await page.getByLabel("Search knowledge").fill("wombat");
  await expect(list).toContainText("Nothing here yet.");
});

test("a site whose robots.txt fails is not crawled, and the reason is shown", async ({
  page,
}) => {
  site.routes.set("/robots.txt", {
    status: 503,
    type: "text/plain",
    body: "Down",
  });
  site.hits.length = 0;
  await websites(page);
  await add(page, "Broken site");
  await expect(entry(page, "Broken site")).toContainText(
    "Last sync failed: The site's robots.txt couldn't be read (a server error), so nothing was fetched.",
    { timeout: 30_000 },
  );
  await expect(entry(page, "Broken site")).toContainText("0 pages");
  expect(site.hits).toEqual(["/robots.txt"]);
  // A refused address is explained before anything is fetched.
  await page.getByRole("button", { name: "Add a website" }).click();
  const form = page.getByRole("form", { name: "Add a website" });
  await form.getByLabel("Address or sitemap").fill("https://localhost/help");
  await form.getByRole("button", { name: "Add and sync" }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "Use a public https:// address. Private, local and IP addresses can't be synced.",
  );
  standardSite(site);
});
