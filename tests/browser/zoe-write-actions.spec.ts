import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { CANCEL_ORDER, SHOP_KEY, recordedFetch } from "../fixtures/connectors";

/** Write actions (phase 09, D3; docs/ACTIONS_STEP3.md), against recorded responses. */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
const recorded = recordedFetch();
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 9024,
    hostPort: 9025,
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
const cancels = () => recorded.sent.filter((s) => s.url.endsWith("/cancel"));

/** Calls the agent API as the signed-in manager. */
const call = (page: Page, path: string, body: unknown): Promise<any> =>
  page.evaluate(
    async ({ path, body }) => {
      const r = await fetch("/api/agent/" + path, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    { path, body },
  );
/** A customer asks in the messenger (signed in as `user`, or a visitor); returns the frame. */
async function ask(page: Page, text: string, user?: string) {
  await page.goto(relay.hostOrigin + (user ? `/?user=${user}` : ""));
  await page.getByRole("button", { name: "Open support", exact: true }).click();
  await expect.poll(() => page.frames().some((f) => f.url().includes("/messenger/frame.html"))).toBe(true);
  const frame = page.frames().find((f) => f.url().includes("/messenger/frame.html"))!;
  await frame.getByRole("button", { name: "Start a conversation" }).click();
  await frame.getByRole("textbox", { name: "Write your message" }).fill(text);
  await frame.getByRole("button", { name: "Send message" }).click();
  return frame;
}

test("a manager turns on a write past a warning; a signed-in customer asks to cancel, a teammate approves in the conversation, and it's done", async ({
  page,
  browser,
}) => {
  await page.goto(relay.hostOrigin + "/agent#zoe/actions");
  const made = await call(page, "zoe-connector", { action: "create", name: "Cancel order" });
  const id = made.connector.id;
  let c = await call(page, "zoe-connector", { action: "save", id, version: made.connector.version, name: "Cancel order", definition: CANCEL_ORDER.definition });
  c = await call(page, "zoe-connector", { action: "secret", id, name: "api_key", value: SHOP_KEY });
  await call(page, "zoe-connector", { action: "publish", id, version: c.connector.version });

  // Turned on in the UI, past a warning.
  await page.reload();
  await page.getByRole("listitem", { name: "Cancel order" }).getByRole("button", { name: "Open" }).click();
  const editor = page.getByRole("region", { name: "Connector Cancel order" });
  await expect(editor.getByText("Writes off")).toBeVisible();
  page.once("dialog", (d) => {
    expect(d.message()).toContain("Zoe will be able to change things in this service");
    void d.accept();
  });
  await editor.getByRole("button", { name: "Turn writes on" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Writes turned on." })).toBeVisible();
  await expect(editor.getByText("Turned on by Support teammate", { exact: false })).toBeVisible();

  // The procedure, published.
  const p = await call(page, "zoe-procedure", { action: "create", name: "Cancel my order" });
  const saved = await call(page, "zoe-procedure", {
    action: "save",
    id: p.procedure.id,
    version: p.procedure.version,
    name: "Cancel my order",
    source: {
      description: "",
      keywords: ["cancel my order"],
      inputs: [{ name: "order_id", label: "Order number", question: "Which order? It looks like A1234.", pattern: "[A-Z]\\d{4}" }],
      steps: '1. Ask for order_id.\n2. Use Cancel order.\n3. Say "Your order {{order_id}} is {{status}}."\n4. Resolve.',
      onFailure: "Sorry, I couldn't cancel it just now.",
    },
  });
  expect(saved.compiled.error).toBeNull();
  await call(page, "zoe-procedure", { action: "publish", id: p.procedure.id, version: saved.procedure.version });

  // A signed-in customer asks; nothing is sent until a teammate approves.
  const customer = await (await browser.newContext()).newPage();
  const frame = await ask(customer, "Please cancel my order A1001", "jo");
  await expect(frame.getByText("I've asked a teammate to approve this.", { exact: false })).toBeVisible({ timeout: 20000 });
  expect(cancels()).toHaveLength(0);

  // In the inbox: the request, team-only, with Approve and Deny.
  await page.goto(relay.hostOrigin + "/agent");
  await page.locator(".pg-card", { hasText: "Please cancel my order A1001" }).click();
  const card = page.getByRole("region", { name: "Approval" });
  await expect(card).toContainText("Waiting for approval");
  await expect(page.locator(".pg-note").filter({ hasText: "Zoe asks to run Cancel order (POST)" })).toContainText("• Order number: A1001");
  await card.getByLabel("Approval note").fill("Not shipped yet.");
  await card.getByRole("button", { name: "Approve Cancel order" }).click();
  await expect(card).toContainText("Approved by Support teammate: “Not shipped yet.”");

  // She carries on: the write is sent once, with its key, and the customer is told.
  await expect(frame.getByText("Your order A1001 is cancelled.")).toBeVisible({ timeout: 20000 });
  expect(cancels()).toHaveLength(1);
  expect(cancels()[0].headers["idempotency-key"]).toMatch(/^[0-9a-f]{32}$/);
  // The approval note never reaches the customer.
  await expect(frame.getByText("Zoe asks to run", { exact: false })).toHaveCount(0);
  expect(recorded.unmatched).toEqual([]);
});

test("a visitor who isn't signed in is refused a write, and the kill switch stops one for a signed-in customer", async ({ page, browser }) => {
  const visitor = await ask(await (await browser.newContext()).newPage(), "cancel my order A2002");
  await expect(visitor.getByText("I can only look that up for customers who are signed in.")).toBeVisible({ timeout: 20000 });
  await expect(visitor.getByText("I'm connecting you with someone from the team.", { exact: false })).toBeVisible();

  // Paused: every write stops, and the customer is handed over plainly.
  await page.goto(relay.hostOrigin + "/agent#zoe/actions");
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Pause all write actions" }).click();
  await expect(page.getByRole("region", { name: "Write actions" }).getByText("Paused", { exact: true })).toBeVisible();
  const frame = await ask(await (await browser.newContext()).newPage(), "cancel my order A2002", "kim");
  await expect(frame.getByText("I've asked a teammate to approve this.", { exact: false })).toBeVisible({ timeout: 20000 });
  await page.goto(relay.hostOrigin + "/agent");
  await page.locator(".pg-card", { hasText: "cancel my order A2002" }).first().click();
  await page.getByRole("region", { name: "Approval" }).getByRole("button", { name: "Approve Cancel order" }).click();
  await expect(frame.getByText("Sorry, I couldn't cancel it just now.")).toBeVisible({ timeout: 20000 });
  await expect(frame.getByText("I'm connecting you with someone from the team.", { exact: false })).toBeVisible();
  expect(recorded.sent.filter((s) => s.url.endsWith("/A2002/cancel"))).toHaveLength(0);
  const [refused] = await sql("SELECT result,error FROM ai_connector_calls ORDER BY created_at DESC LIMIT 1");
  expect(refused).toEqual({ result: "refused", error: "Write actions are paused for this workspace." });
});
