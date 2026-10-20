import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/**
 * Reporting's data (phase 14, R1 and R2; docs/REPORTING_STEP1.md and STEP2.md): a customer's new
 * conversation reaches reporting's own store in the background, and Settings › Reporting data says
 * how current it is, what each number means and what each dataset holds; a metric is answered from
 * the store, broken down. A teammate who may not view reports gets neither.
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

/** Asks for a metric from inside the agent page, as the app does (the bridge refuses posts from other origins). */
const ask = (page: Page, body: Record<string, unknown>, as = "") =>
  page.evaluate(
    async ([path, body]) => {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
      return { status: r.status, json: (await r.json()) as any };
    },
    ["/api/agent/report-metric" + as, body] as const,
  );

test("a metric is answered from reporting's store, broken down, and Settings lists each dataset", async ({ page }) => {
  await expect.poll(projected, { timeout: 20000 }).toBe(1);
  const from = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const byChannel = (
    await tenant(relay.env.analytics!.connect, "demo", (db) =>
      db.query<{ channel: string; n: number }>("SELECT channel,count(*)::int AS n FROM a_conversations WHERE visibility='customer' AND NOT merged AND started_at>=$1 AND started_at<$2 GROUP BY 1 ORDER BY 1", [from, to]),
    )
  ).rows;
  await page.goto(relay.hostOrigin + "/agent#settings/reporting");
  const r = await ask(page, { metric: "new_conversations", from, to, timezone: "Europe/London", breakdown: "channel" });
  expect(r.status).toBe(200);
  const answer = r.json;
  expect(answer.total).toEqual({ kind: "count", count: byChannel.reduce((s, x) => s + x.n, 0) });
  expect(answer.previous.kind).toBe("count");
  expect(answer.rows.map((x: { key: string; value: { count: number } }) => [x.key, x.value.count])).toEqual(byChannel.map((x) => [x.channel, x.n]));

  const datasets = page.getByRole("table", { name: "Datasets" });
  const conversation = datasets.getByRole("row", { name: /^Conversations / });
  await expect(conversation).toContainText("New conversations");
  await expect(conversation).toContainText("channel");
  const stored = (await tenant(relay.env.analytics!.connect, "demo", (db) => db.query<{ n: number }>("SELECT count(*)::int AS n FROM a_conversations"))).rows[0].n;
  await expect(conversation.getByRole("cell").last()).toHaveText(String(stored));
});

test("a metric that isn't in the dictionary, or a teammate who may not view reports, is refused", async ({ page }) => {
  const period = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString() };
  await page.goto(relay.hostOrigin + "/agent#settings/reporting");
  const unknown = await ask(page, { metric: "revenue", ...period });
  expect(unknown.status).toBe(400);
  expect(unknown.json.error.message).toContain("Choose a metric");
  const other = await page.context().browser()!.newContext();
  const gracePage = await other.newPage();
  await gracePage.goto(relay.hostOrigin + "/agent?as=grace#settings");
  await expect(gracePage.getByRole("heading", { name: "Settings" }).first()).toBeVisible({ timeout: 15000 });
  const grace = await ask(gracePage, { metric: "new_conversations", ...period }, "?as=grace");
  expect([403, 404], JSON.stringify(grace)).toContain(grace.status);
  await other.close();
});

test("a teammate who may not view reports doesn't get the reporting page", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent?as=grace#settings");
  await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("link", { name: /Reporting data/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Reporting data/ })).toHaveCount(0);
  const r = await page.request.get(relay.hostOrigin + "/api/agent/reporting-status?as=grace");
  expect([403, 404]).toContain(r.status());
});
