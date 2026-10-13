import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { ORDER_STATUS, SHOP_KEY, recordedFetch } from "../fixtures/connectors";

/** Customer-facing workflow steps and simulation (phase 11, W3; docs/WORKFLOWS_STEP3.md). */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
const recorded = recordedFetch();
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({
    apiPort: 9032,
    hostPort: 9033,
    inboxViews: true,
    // Zoe is on: these workflows talk to customers, so she waits for them.
    connectors: { policy: { fetch: recorded.fetch }, sleep: async () => {} },
  });
  await sql("DELETE FROM calendar_assignments");
  await sql("UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
  await sql("INSERT INTO tags(workspace_id,id,name) VALUES('demo','wc-billing','Billing question'),('demo','wc-team','Needs the team')");
  await sql("INSERT INTO attribute_definitions(workspace_id,id,name,owner_type,value_type) VALUES('demo','wc-order','Order status','conversation','string')");
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(text: string, values: unknown[] = []) =>
  tenant(relay.db.connect, "demo", async (db) => (await db.query<T>(text, values)).rows);
const api = (page: Page, path: string, body?: unknown): Promise<any> =>
  page.evaluate(
    async ({ path, body }) => {
      const r = await fetch("/api/agent/" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? {} : { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: await r.json() };
    },
    { path, body },
  );
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
const step = (type: string, options: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), type, options });
async function publish(page: Page, name: string, definition: unknown) {
  const made = await api(page, "workflow", { action: "create", name, definition });
  expect(made.status).toBe(200);
  const live = await api(page, "workflow", { action: "publish", id: made.body.workflow.id, version: made.body.workflow.version });
  expect(live.body.workflow?.state, JSON.stringify(live.body)).toBe("live");
  return made.body.workflow.id as string;
}
async function pause(page: Page, id: string) {
  const v = (await api(page, `workflows?id=${id}`)).body.workflow.version;
  await api(page, "workflow", { action: "pause", id, version: v });
}

test("a customer is greeted, chooses a reply button and is told when to expect a reply; teammates see what the workflow said, and a test shows each decision", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent");
  const id = await publish(page, "Ask what they need", {
    trigger: { type: "first_message", options: {} },
    paths: [
      {
        id: "A",
        label: "Start",
        steps: [step("message", { text: "Hi! Let's find the right person for you." })],
        next: {
          type: "buttons",
          text: "What's it about?",
          buttons: [
            { label: "Billing", path: "B" },
            { label: "Something else", path: "C" },
          ],
          other: "C",
          timeoutSeconds: 3600,
          timedOut: "C",
        },
      },
      { id: "B", label: "Billing", steps: [step("tag_add", { tagId: "wc-billing" }), step("reply_time")], next: { type: "end" } },
      { id: "C", label: "Other", steps: [step("tag_add", { tagId: "wc-team" })], next: { type: "end" } },
    ],
  });

  const customer = await (await browser.newContext()).newPage();
  const frame = await ask(customer, "Hello, I was charged twice");
  const log = frame.getByRole("log");
  await expect(log.locator("article.message").filter({ hasText: "Hi! Let's find the right person for you." })).toContainText("Automation");
  await expect(log.locator("article.message").filter({ hasText: "What's it about?" })).toBeVisible();
  await log.getByRole("button", { name: "Billing" }).click();
  await expect(log.locator("article.message.outgoing").filter({ hasText: "Billing" })).toBeVisible();
  // The buttons were for that question only, and the expected reply time follows (always open here).
  await expect(log.getByRole("button", { name: "Something else" })).toHaveCount(0);
  await expect(log.locator("article.message").last()).toContainText(/We usually reply|We'll reply as soon as we can|reply/i);
  await expect
    .poll(async () => (await sql("SELECT status,reason FROM workflow_runs WHERE workflow_id=$1", [id])).map((r) => `${r.status}: ${r.reason}`))
    .toEqual(["completed: Ended at path B."]);
  expect(await sql("SELECT 1 FROM conversation_parts WHERE kind='ai_reply'")).toEqual([]);

  // Teammates see what the customer was told, by which workflow, with its buttons.
  await page.reload();
  await page.locator(".pg-card", { hasText: "charged twice" }).click();
  const timeline = page.getByRole("region", { name: "Conversation timeline" });
  const asked = timeline.locator(".pg-message", { hasText: "What's it about?" });
  await expect(asked).toContainText("Workflow “Ask what they need” · to the customer");
  await expect(asked.getByRole("list", { name: "Reply buttons" }).getByRole("listitem")).toHaveText(["Billing", "Something else"]);

  // A test against that conversation: each decision shown, a different answer supposed, nothing changed.
  const parts = (await sql("SELECT count(*)::int AS n FROM conversation_parts"))[0].n;
  await page.goto(relay.hostOrigin + `/agent#workflows/${id}`);
  await page.getByRole("button", { name: "Test", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Test" });
  await panel.getByLabel("Find a conversation").fill("charged twice");
  await expect(panel.getByLabel("Conversation to test with")).toContainText("charged twice");
  await panel.getByRole("button", { name: "Run test" }).click();
  const trace = panel.getByRole("list", { name: "What it would do" });
  await expect(trace).toContainText("Would send: “Hi! Let's find the right person for you.”");
  await expect(trace).toContainText("They chose “Billing” → path B");
  await expect(page.locator('.react-flow__node[data-id="B"] .pg-wf-card')).toHaveAttribute("data-visited", "true");
  await trace.getByLabel("Suppose: Would wait for their answer").selectOption("other");
  await expect(trace).toContainText("They typed instead → path C");
  await expect(trace).toContainText("Would add the tag “Needs the team”");
  await expect(page.locator('.react-flow__node[data-id="B"] .pg-wf-card')).not.toHaveAttribute("data-visited", "true");
  expect((await sql("SELECT count(*)::int AS n FROM conversation_parts"))[0].n).toBe(parts);
  await pause(page, id);
});

test("an unverified customer's connector look-up fails over to the team, a typed answer takes its own way, and a test of an unfinished draft says what's missing", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent");
  const c = await api(page, "zoe-connector", { action: "create", name: "Order status" });
  let v = (await api(page, "zoe-connector", { action: "save", id: c.body.connector.id, version: c.body.connector.version, name: "Order status", definition: ORDER_STATUS.definition })).body.connector.version;
  v = (await api(page, "zoe-connector", { action: "secret", id: c.body.connector.id, name: "api_key", value: SHOP_KEY })).body.connector.version;
  expect((await api(page, "zoe-connector", { action: "publish", id: c.body.connector.id, version: v })).body.connector.liveVersion).toBe(1);
  const id = await publish(page, "Look up the order", {
    trigger: { type: "first_message", options: {} },
    paths: [
      {
        id: "A",
        label: "",
        steps: [],
        next: { type: "buttons", text: "Is this about an order?", buttons: [{ label: "Yes", path: "B" }], other: "C", timeoutSeconds: 3600, timedOut: "C" },
      },
      {
        id: "B",
        label: "Look it up",
        steps: [],
        next: { type: "connector", connectorId: c.body.connector.id, inputs: { order_id: { from: "value", value: "A1001" } }, save: { status: "wc-order" }, ok: "D", failed: "C" },
      },
      { id: "C", label: "Team", steps: [step("tag_add", { tagId: "wc-team" }), step("message", { text: "Thanks, the team will take it from here." })], next: { type: "end" } },
      { id: "D", label: "Found", steps: [step("message", { text: "Found it." })], next: { type: "end" } },
    ],
  });
  const customer = await (await browser.newContext()).newPage();
  const frame = await ask(customer, "Hi there");
  const log = frame.getByRole("log");
  await log.getByRole("button", { name: "Yes" }).click();
  // The verification rules' fallback asks for a signed-in customer: no call is made.
  await expect(log.locator("article.message").last()).toContainText("Thanks, the team will take it from here.");
  const [run] = await sql("SELECT id,status FROM workflow_runs WHERE workflow_id=$1", [id]);
  expect(run.status).toBe("completed");
  const detail = await api(page, `workflow-runs?id=${run.id}`);
  expect(detail.body.steps.map((s: { label: string }) => s.label)).toContain("Order status needs a signed-in customer (the fallback rule)");
  expect(await sql("SELECT 1 FROM ai_connector_calls")).toEqual([]);

  // Typing instead of choosing takes the "other" way.
  const second = await (await browser.newContext()).newPage();
  const frame2 = await ask(second, "Hello");
  await expect(frame2.getByRole("log").getByRole("button", { name: "Yes" })).toBeVisible();
  await frame2.getByRole("textbox", { name: "Write your message" }).fill("No, it's about my account");
  await frame2.getByRole("button", { name: "Send message" }).click();
  await expect(frame2.getByRole("log").locator("article.message").last()).toContainText("Thanks, the team will take it from here.");

  // A test of an unfinished draft is refused, saying what to finish.
  await page.goto(relay.hostOrigin + `/agent#workflows/${id}`);
  await page.locator('.react-flow__node[data-id="D"]').click();
  await page.getByRole("complementary", { name: "Path D" }).getByLabel("Step 1, message").fill("");
  await page.getByRole("button", { name: "Test", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "Test" });
  await expect(panel.getByLabel("Conversation to test with")).not.toHaveValue("");
  await panel.getByRole("button", { name: "Run test" }).click();
  await expect(panel.getByRole("alert")).toHaveText("Path D, step 1: Send a message needs its text.");
  await expect(page.locator("#pg-wf-blockers")).toContainText("Path D, step 1: Send a message needs its text.");
  await pause(page, id);
});
