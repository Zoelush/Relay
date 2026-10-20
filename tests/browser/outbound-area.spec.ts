import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/**
 * The Outbound area and banners (phase 13, O3; docs/OUTBOUND_STEP3.md), with the demo's seeded
 * messages: a manager finds the "Maintenance tonight" banner draft, sees its audience counted, and
 * sets it live; a customer sees it at the top of the site, clicks its button and closes it (gone
 * for good); the message's numbers say so. A message that can't go live says why and stays a
 * draft; a banner's button must be https.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9058, hostPort: 9059, inboxViews: true, aiAgent: false, examplePeople: true, exampleOutbound: true });
});
test.afterAll(async () => {
  await relay?.close();
});
const entry = async () =>
  (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT status,clicked_at IS NOT NULL AS clicked,dismissed_at IS NOT NULL AS dismissed FROM outbound_entries WHERE message_id='maintenance'"))).rows;

test("a banner draft is set live from the editor; a customer sees it, clicks it and closes it; its numbers say so", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent#outbound");
  const list = page.getByRole("table", { name: "Messages" });
  await expect(list.getByRole("row", { name: /Welcome to Pro/ })).toContainText("Live");
  await expect(list.getByRole("row", { name: /Maintenance tonight/ })).toContainText("Draft");
  await page.getByLabel("Content type").selectOption("banner");
  await expect(list.getByRole("row")).toHaveCount(2, { timeout: 5000 });
  await list.getByRole("button", { name: "Maintenance tonight" }).click();
  await expect(page).toHaveURL(/#outbound\/m\/maintenance$/);
  await expect(page.getByLabel("Message state")).toHaveText("Draft");
  await expect(page.getByLabel("Banner text")).toHaveValue("Scheduled maintenance tonight, 22:00 to 23:00 UTC.");
  await expect(page.getByRole("region", { name: "Audience" })).toContainText(/\d+ (people match|person matches) now\./);
  await page.getByRole("button", { name: "Set live" }).click();
  await expect(page.getByRole("status")).toHaveText("Published: it's live.");
  await expect(page.getByLabel("Message state")).toHaveText("Live");
  await expect(page.getByRole("list", { name: "Versions" })).toContainText("Version 1");

  // A customer's visit: the banner at the top; its button and close are recorded.
  const site = await (await browser.newContext()).newPage();
  await site.route("https://status.example.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<h1>All systems normal</h1>" }));
  await site.goto(relay.hostOrigin + "/?user=grace-demo");
  const bar = site.getByRole("region", { name: "Announcement" });
  await expect(bar).toContainText("Scheduled maintenance tonight", { timeout: 15000 });
  await bar.getByRole("link", { name: "Status page" }).click();
  await expect(site.getByRole("heading", { name: "All systems normal" })).toBeVisible();
  await expect.poll(entry, { timeout: 15000 }).toEqual([{ status: "sent", clicked: true, dismissed: false }]);
  await site.goto(relay.hostOrigin + "/?user=grace-demo");
  await expect(bar).toBeVisible({ timeout: 15000 });
  await bar.getByRole("button", { name: "Close announcement" }).click();
  await expect(bar).toHaveCount(0);
  await expect.poll(entry, { timeout: 15000 }).toEqual([{ status: "sent", clicked: true, dismissed: true }]);
  await site.reload();
  await expect(site.locator("[data-launcher]")).toHaveCount(1, { timeout: 15000 });
  await site.waitForTimeout(1500);
  await expect(bar).toHaveCount(0);

  // The message's numbers.
  await page.reload();
  const numbers = page.getByRole("table", { name: "Message numbers" });
  await expect(numbers.getByRole("row", { name: /Sent/ })).toContainText("1");
  await expect(numbers.getByRole("row", { name: /Clicked/ })).toContainText("1 (100%)");
  await expect(numbers.getByRole("row", { name: /Closed/ })).toContainText("1 (100%)");
  await expect(page.getByRole("table", { name: "Who it reached" })).toContainText("Grace Hopper");
});

test("a message that can't go live says why and stays a draft; a banner's button must be https", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#outbound");
  await page.getByRole("button", { name: "New message" }).click();
  const form = page.getByRole("form", { name: "New message" });
  await form.getByLabel("Title").fill("Spring sale");
  await form.getByLabel("Type").selectOption("banner");
  await form.getByRole("button", { name: "Create" }).click();
  await expect(page.getByLabel("Message title")).toHaveValue("Spring sale");
  await expect(page.getByRole("list", { name: "What stops it going live" })).toContainText("Write the banner (300 characters at most).");
  await page.getByRole("button", { name: "Set live" }).click();
  await expect(page.getByRole("alert")).toHaveText("Write the banner (300 characters at most).");
  await expect(page.getByLabel("Message state")).toHaveText("Draft");

  await page.getByLabel("Banner text").fill("20% off this week");
  await page.getByLabel("Button label (optional)").fill("Shop");
  await page.getByLabel("Button link (https)").fill("http://shop.example.com");
  await page.getByRole("region", { name: "Subscription, goal and control group" }).getByLabel("Subscription type").selectOption({ label: "Product tips" });
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("list", { name: "What stops it going live" })).toHaveText("The banner's button opens an https address.");
  await page.getByRole("button", { name: "Set live" }).click();
  await expect(page.getByRole("alert")).toHaveText("The banner's button opens an https address.");
  await expect(page.getByLabel("Message state")).toHaveText("Draft");
});
