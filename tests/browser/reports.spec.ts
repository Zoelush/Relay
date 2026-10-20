import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { conversationFlow } from "../../server/reports";
import { liveDashboard } from "../../server/live";

/**
 * The Reports area (phase 14, R3; docs/REPORTING_STEP3.md): a customer's conversation reaches the
 * overview's flow, which matches the store's own answer; each number's definition is one click
 * away; the menu opens a pre-built report, broken down by channel. A teammate who may not view
 * reports has no Reports in the strip, and the flow is refused to them.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9064, hostPort: 9065, inboxViews: true, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});
const stored = async () => (await tenant(relay.env.analytics!.connect, "demo", (db) => db.query<{ n: number }>("SELECT count(*)::int AS n FROM a_conversations"))).rows[0].n;
const projected = async () => (await tenant(relay.env.analytics!.connect, "demo", (db) => db.query("SELECT 1 FROM a_projection WHERE projected_at IS NOT NULL"))).rows.length;
/** Asks from inside the agent page, as the app does (the bridge refuses posts from other origins). */
const ask = (page: Page, path: string, body: Record<string, unknown>) =>
  page.evaluate(
    async ([path, body]) => {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
      return { status: r.status };
    },
    [path, body] as const,
  );

test("Reports sits before Outbound; the overview's flow matches the store, definitions open, and a report breaks down by channel", async ({ page, browser }) => {
  await expect.poll(projected, { timeout: 20000 }).toBe(1);
  const before = await stored();
  const site = await (await browser.newContext()).newPage();
  await site.goto(relay.hostOrigin + "/");
  await site.getByRole("button", { name: "Open support", exact: true }).click();
  await expect.poll(() => site.frames().some((f) => f.url().includes("/messenger/frame.html")), { timeout: 15000 }).toBe(true);
  const frame = site.frames().find((f) => f.url().includes("/messenger/frame.html"))!;
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame.getByRole("textbox", { name: "Write your message" }).fill("Where is my order?");
  await frame.getByRole("button", { name: "Send message" }).click();
  await expect.poll(stored, { timeout: 20000 }).toBe(before + 1);

  await page.goto(relay.hostOrigin + "/agent");
  const rail = page.getByRole("navigation", { name: "Main" });
  const reports = rail.getByRole("button", { name: "Reports" });
  await expect(reports).toBeVisible({ timeout: 15000 });
  // Just before Outbound, as in Intercom's strip.
  const names = await rail.locator(".pg-rail-items .pg-rail-item").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.textContent?.trim()));
  expect(names.indexOf("Reports")).toBe(names.indexOf("Outbound") - 1);
  await reports.click();
  await expect(page).toHaveURL(/#reports$/);
  const area = page.getByRole("region", { name: "Reports" });
  await expect(area.getByRole("heading", { name: "Overview", level: 2 })).toBeVisible();

  // The flow: its whole is the store's own count for the same 30 days, and its parts are there.
  const to = new Date(Math.ceil(Date.now() / 60_000) * 60_000);
  const expected = await conversationFlow(relay.env.analytics!, "demo", { from: new Date(to.getTime() - 30 * 86_400_000), to });
  expect(expected.total).toBeGreaterThan(0);
  const flow = area.getByRole("region", { name: "How conversations were handled" });
  await expect(flow.getByRole("img")).toHaveAttribute("aria-label", new RegExp(`^Of ${expected.total} new conversations`));
  await expect(flow).toContainText("New conversations");

  // A tile's number and, one click away, its definition from the dictionary.
  const frt = area.getByRole("region", { name: "First response time" });
  await expect(frt.getByTestId("value")).not.toBeEmpty();
  await frt.getByLabel("What First response time counts").click();
  await expect(frt).toContainText("From the customer's first message to the first teammate reply after it");

  // The menu opens a report; its channel breakdown names the messenger.
  await area.getByRole("navigation", { name: "Reports" }).getByRole("button", { name: "Conversations" }).click();
  await expect(page).toHaveURL(/#reports\/conversations$/);
  await expect(area.getByRole("heading", { name: "Conversations", level: 2 })).toBeVisible();
  const byChannel = area.getByRole("region", { name: "New conversations by channel" });
  await expect(byChannel).toContainText("Messenger");
  // A shorter period is chosen and asked for; the choice is kept.
  await area.getByRole("radio", { name: "7 days" }).click();
  await expect(area.getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true");
  await expect(byChannel).toContainText("Messenger");
  await page.reload();
  await expect(page.getByRole("region", { name: "Reports" }).getByRole("radio", { name: "7 days" })).toHaveAttribute("aria-checked", "true", { timeout: 15000 });
});

test("the live dashboard, from the inbox: now, as the server counts it, and the longest wait opens in the inbox", async ({ page, browser }) => {
  // Someone is waiting: a new conversation from the messenger.
  const site = await (await browser.newContext()).newPage();
  await site.goto(relay.hostOrigin + "/");
  await site.getByRole("button", { name: "Open support", exact: true }).click();
  await expect.poll(() => site.frames().some((f) => f.url().includes("/messenger/frame.html")), { timeout: 15000 }).toBe(true);
  const frame = site.frames().find((f) => f.url().includes("/messenger/frame.html"))!;
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame.getByRole("textbox", { name: "Write your message" }).fill("Is anyone there? Live test");
  await frame.getByRole("button", { name: "Send message" }).click();

  await page.goto(relay.hostOrigin + "/agent");
  await page.getByRole("navigation", { name: "Inbox menu" }).getByRole("button", { name: "Live dashboard" }).or(page.getByRole("button", { name: "Live dashboard" })).first().click({ timeout: 15000 });
  await expect(page).toHaveURL(/#reports\/live$/);
  const area = page.getByRole("region", { name: "Reports" });
  await expect(area.getByRole("heading", { name: /^Live/, level: 2 })).toContainText("Updated", { timeout: 15000 });
  // The numbers are the server's own, for the same moment.
  const now = await tenant(relay.env.connect, "demo", (db) => liveDashboard(db, "demo", "local-owner", {}));
  for (const [label, value] of [
    ["Open now", now.totals.open],
    ["Unassigned", now.totals.unassigned],
    ["Waiting for a reply", now.totals.waiting],
  ] as const)
    await expect(area.getByRole("region", { name: label }).getByTestId("value")).toHaveText(String(value));
  expect(now.waitingLongest.some((c) => c.title.includes("Live test"))).toBeTruthy();
  await expect(area.getByRole("region", { name: "Teammates" })).toContainText("Active");
  await expect(area.getByRole("region", { name: "Queue by team" }).getByRole("row").nth(1)).toBeVisible();
  // A waiting conversation opens in the inbox.
  const queue = area.getByRole("region", { name: "Waiting longest" });
  await queue.getByRole("button", { name: /Live test/ }).click();
  await expect(page).not.toHaveURL(/#reports/);
  await expect(page.getByText("Is anyone there? Live test").first()).toBeVisible({ timeout: 15000 });
});

test("a teammate who may not view reports has no Reports in the strip, and the flow is refused", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent?as=grace#reports");
  const rail = page.getByRole("navigation", { name: "Main" });
  await expect(rail.getByRole("button", { name: "Outbound" }).or(rail.getByRole("button", { name: "Inbox" })).first()).toBeVisible({ timeout: 15000 });
  await expect(rail.getByRole("button", { name: "Reports" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Reports" })).toHaveCount(0);
  const period = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() };
  const flow = await ask(page, "/api/agent/report-flow?as=grace", period);
  expect([403, 404]).toContain(flow.status);
  // Nor the live dashboard: no link in the inbox, and the numbers are refused.
  await expect(page.getByRole("button", { name: "Live dashboard" })).toHaveCount(0);
  const live = await page.evaluate(async () => (await fetch("/api/agent/live-dashboard?as=grace")).status);
  expect([403, 404]).toContain(live);
});
