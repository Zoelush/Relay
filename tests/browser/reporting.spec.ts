import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/**
 * Reporting's data (phase 14, R1; docs/REPORTING_STEP1.md): a customer's new conversation reaches
 * reporting's own store in the background, and Settings › Reporting data says how current it is
 * and what each number means. A teammate who may not view reports doesn't get the page.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9062, hostPort: 9063, inboxViews: true, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});
const stored = async () => (await tenant(relay.env.analytics!.connect, "demo", (db) => db.query<{ n: number }>("SELECT count(*)::int AS n FROM a_conversations"))).rows[0].n;
const projected = async () => (await tenant(relay.env.analytics!.connect, "demo", (db) => db.query("SELECT 1 FROM a_projection WHERE projected_at IS NOT NULL"))).rows.length;

test("a new conversation reaches reporting's store, and Settings says how current it is and what each number means", async ({ page, browser }) => {
  // The first projection has run (the backfill: this demo starts with no conversations).
  await expect.poll(projected, { timeout: 20000 }).toBe(1);
  const before = await stored();
  const site = await (await browser.newContext()).newPage();
  await site.goto(relay.hostOrigin + "/");
  await site.getByRole("button", { name: "Open support", exact: true }).click();
  await expect.poll(() => site.frames().some((f) => f.url().includes("/messenger/frame.html")), { timeout: 15000 }).toBe(true);
  const frame = site.frames().find((f) => f.url().includes("/messenger/frame.html"))!;
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame.getByRole("textbox", { name: "Write your message" }).fill("How do reports work?");
  await frame.getByRole("button", { name: "Send message" }).click();
  await expect.poll(stored, { timeout: 20000 }).toBe(before + 1);

  await page.goto(relay.hostOrigin + "/agent#settings/reporting");
  await expect(page.getByLabel("Reporting data status")).toContainText(`${before + 1} ${before + 1 === 1 ? "conversation" : "conversations"}`);
  await expect(page.getByLabel("Reporting data status")).toContainText("Up to date as of");
  const conversations = page.getByRole("region", { name: "Conversations metrics" });
  await conversations.getByText("First response time", { exact: true }).click();
  await expect(conversations).toContainText("From the customer's first message to the first teammate reply after it");
  await expect(conversations).toContainText("Only teammates' replies count; Zoe's and workflows' don't.");
});

test("a teammate who may not view reports doesn't get the reporting page", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent?as=grace#settings");
  await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("link", { name: /Reporting data/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Reporting data/ })).toHaveCount(0);
  const r = await page.request.get(relay.hostOrigin + "/api/agent/reporting-status?as=grace");
  expect([403, 404]).toContain(r.status());
});
