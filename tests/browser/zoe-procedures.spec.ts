import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { ORDER_STATUS, SHOP_KEY, recordedFetch } from "../fixtures/connectors";

/** Procedures (phase 09, D2; docs/ACTIONS_STEP2.md), against recorded responses. */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
const recorded = recordedFetch();
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 9022,
    hostPort: 9023,
    inboxViews: true,
    connectors: { policy: { fetch: recorded.fetch }, sleep: async () => {} },
  });
  await sql("DELETE FROM calendar_assignments");
  await sql("UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(text: string, values: unknown[] = []) =>
  tenant(relay.db.connect, "demo", async (db) => (await db.query<T>(text, values)).rows);

/** The published "Order status" connector, made through the agent API as a manager. */
async function connector(page: Page) {
  await page.goto(relay.hostOrigin + "/agent#zoe/actions");
  await page.evaluate(
    async ({ def, key }) => {
      const call = async (body: unknown): Promise<any> => {
        const r = await fetch("/api/agent/zoe-connector", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      };
      const made = await call({ action: "create", name: "Order status" });
      const id = made.connector.id;
      await call({ action: "save", id, version: made.connector.version, name: "Order status", definition: def });
      const keyed = await call({ action: "secret", id, name: "api_key", value: key });
      await call({ action: "publish", id, version: keyed.connector.version });
    },
    { def: ORDER_STATUS.definition, key: SHOP_KEY },
  );
}
/** A visitor asks in the messenger; returns the frame. */
async function ask(page: Page, text: string) {
  await page.goto(relay.hostOrigin);
  await page.getByRole("button", { name: "Open support", exact: true }).click();
  await expect.poll(() => page.frames().some((f) => f.url().includes("/messenger/frame.html"))).toBe(true);
  const frame = page.frames().find((f) => f.url().includes("/messenger/frame.html"))!;
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame.getByRole("textbox", { name: "Write your message" }).fill(text);
  await frame.getByRole("button", { name: "Send message" }).click();
  return frame;
}

test("a manager writes a procedure that finds an order; an unverified visitor is handed over, and once visitors are allowed one gets their answer", async ({
  page,
  browser,
}) => {
  await connector(page);
  await page.goto(relay.hostOrigin + "/agent#zoe/procedures");
  await page.getByLabel("New procedure").fill("Where's my order");
  await page.getByRole("button", { name: "Create" }).click();
  const p = page.getByRole("region", { name: "Procedure Where's my order" });
  await p.getByLabel("Keywords").fill("where is my order, order status");
  await p.getByLabel("What it's for").fill("Tells customers where their order is.");
  await p.getByRole("button", { name: "Add something to collect" }).click();
  await p.getByLabel("Collect name").fill("order_id");
  await p.getByLabel("Collect label").fill("Order number");
  await p.getByLabel("Collect question").fill("What's your order number? It looks like A1234.");
  await p.getByLabel("Collect pattern").fill("[A-Z]\\d{4}");
  await p.getByLabel("Procedure steps").fill(
    [
      "1. Ask for order_id.",
      "2. Look up Order status.",
      '3. If status is "shipped", go to step 6.',
      '4. Say "Your order {{order_id}} is {{status}}."',
      "5. Resolve.",
      '6. Say "Your order {{order_id}} is on its way and should arrive on {{eta}}."',
      "7. Resolve.",
    ].join("\n"),
  );
  await p.getByLabel("If a look-up fails, she says").fill("Sorry, I couldn't look up your order just now.");
  await p.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Draft saved." })).toBeVisible();
  const plan = p.getByRole("list", { name: "Compiled plan" });
  await expect(plan.getByRole("listitem")).toHaveCount(7);
  await expect(plan.getByRole("listitem").nth(2)).toHaveText("If status is “shipped”, go to step 6; otherwise continue.");
  await p.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published." })).toBeVisible();
  await expect(p.getByText("Live, version 1")).toBeVisible();

  // By default only signed-in customers have look-ups: a visitor is told, and handed over.
  const first = await ask(await (await browser.newContext()).newPage(), "Where is my order A1001?");
  await expect(first.getByText("I can only look that up for customers who are signed in.")).toBeVisible({ timeout: 20000 });
  await expect(first.getByText("I'm connecting you with someone from the team.", { exact: false })).toBeVisible();
  expect(await sql("SELECT count(*)::int AS n FROM ai_connector_calls WHERE source='agent'")).toEqual([{ n: 0 }]);

  // Visitors on the messenger allowed by a rule; the next one gets their order.
  await p.getByRole("button", { name: "All procedures" }).click();
  const verification = page.getByRole("region", { name: "Verification" });
  await verification.getByRole("button", { name: "Add a rule" }).click();
  await verification.getByLabel("Verification rule 1 name").fill("Visitors");
  await verification.getByRole("button", { name: "Save verification" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Verification saved." })).toBeVisible();

  const second = await ask(await (await browser.newContext()).newPage(), "Where is my order A1001?");
  await expect(second.getByText("Your order A1001 is on its way and should arrive on 2026-10-15.")).toBeVisible({ timeout: 20000 });
  await page.reload();
  const runs = page.getByRole("list", { name: "Recent runs" });
  await expect(runs.getByRole("listitem").filter({ hasText: "Resolved" })).toHaveCount(1);
  await expect(runs.getByRole("listitem").filter({ hasText: "Handed over" })).toHaveCount(1);
  expect(recorded.unmatched).toEqual([]);
});

test("a look-up that times out ends in a clean handover: the customer is told, and the team has it", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent#zoe/procedures");
  await expect(page.getByRole("listitem", { name: "Where's my order" })).toContainText("Live, version 1");
  const frame = await ask(await (await browser.newContext()).newPage(), "where is my order A9999");
  await expect(frame.getByText("Sorry, I couldn't look up your order just now.")).toBeVisible({ timeout: 20000 });
  await expect(frame.getByText("I'm connecting you with someone from the team.", { exact: false })).toBeVisible();
  const [row] = await sql<{ ai_state: string; status: string }>(
    `SELECT c.ai_state,r.status FROM ai_procedure_runs r JOIN conversations c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id
     ORDER BY r.started_at DESC LIMIT 1`,
  );
  expect(row).toEqual({ ai_state: "escalated", status: "escalated" });
  const [call] = await sql("SELECT result FROM ai_connector_calls ORDER BY created_at DESC LIMIT 1");
  expect(call).toEqual({ result: "timeout" });
});
