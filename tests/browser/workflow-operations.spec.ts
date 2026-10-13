import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/**
 * Phase 11's acceptance demo (W4; docs/WORKFLOWS_ACCEPTANCE.md): a workflow that tags, routes by
 * language, waits for office hours, hands to Zoe and escalates when she can't resolve it; its run
 * log for three conversations; then broken on purpose, and the alert it raises.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9034, hostPort: 9035, inboxViews: true });
  await sql("DELETE FROM calendar_assignments");
  await sql("UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
  await sql("INSERT INTO tags(workspace_id,id,name) VALUES('demo','acc-triaged','Triaged'),('demo','acc-vip','VIP customer')");
  await sql("INSERT INTO teams(workspace_id,id,name) VALUES('demo','acc-fr','French desk'),('demo','acc-en','English desk') ON CONFLICT DO NOTHING");
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
  await expect(frame.locator(".message").filter({ hasText: text })).toBeVisible();
  return frame;
}
const step = (type: string, options: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), type, options });

test("the acceptance demo: tag, route by language, wait for office hours, hand to Zoe and escalate; its run log for three conversations; broken on purpose, it raises an alert", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent");
  const made = await api(page, "workflow", {
    action: "create",
    name: "Acceptance: triage and escalate",
    definition: {
      trigger: { type: "first_message", options: {} },
      paths: [
        {
          id: "A",
          label: "Triage",
          steps: [step("tag_add", { tagId: "acc-triaged" })],
          next: { type: "branch", branches: [{ label: "French", when: { match: "all", items: [{ field: "conversation.language", op: "is", value: "fr" }] }, path: "B" }], else: "C" },
        },
        { id: "B", label: "French", steps: [step("assign", { teamId: "acc-fr" })], next: { type: "goto", path: "D" } },
        { id: "C", label: "English", steps: [step("assign", { teamId: "acc-en" })], next: { type: "goto", path: "D" } },
        { id: "D", label: "Zoe", steps: [step("wait_office_hours")], next: { type: "zoe", resolved: "E", handedOver: "F", timeoutSeconds: 86_400, timedOut: "F" } },
        { id: "E", label: "Resolved", steps: [], next: { type: "end" } },
        {
          id: "F",
          label: "Escalate",
          steps: [step("priority", { value: true }), step("human_handover"), step("note", { text: "Zoe couldn't resolve this: escalated by the workflow." })],
          next: { type: "end" },
        },
      ],
    },
  });
  const id = made.body.workflow.id;
  await api(page, "workflow", { action: "publish", id, version: made.body.workflow.version });

  // Three conversations: two ask for a person (French and English), one asks a question.
  for (const text of ["Bonjour, je voudrais parler à une personne s'il vous plaît", "Hello, I'd like to talk to a real person please", "How do I change my password?"])
    await ask(await (await browser.newContext()).newPage(), text);
  await expect
    .poll(async () => (await sql("SELECT status FROM workflow_runs WHERE workflow_id=$1 AND status IN ('completed','waiting')", [id])).length, { timeout: 20000 })
    .toBe(3);
  await expect
    .poll(async () => (await sql("SELECT reason FROM workflow_runs WHERE workflow_id=$1 AND status='completed' ORDER BY started_at", [id])).map((r) => r.reason), { timeout: 20000 })
    .toEqual(expect.arrayContaining(["Ended at path F.", "Ended at path F."]));

  // The run log, in the app: the three runs, and each step of the French one.
  await page.goto(relay.hostOrigin + "/agent#workflows");
  await page.getByRole("button", { name: "Run log" }).click();
  await page.getByLabel("Workflow", { exact: true }).selectOption(id);
  const table = page.locator(".pg-wf-runs tbody tr");
  await expect(table).toHaveCount(3);
  const french = (await sql("SELECT r.started_at FROM workflow_runs r JOIN conversation_parts p ON p.conversation_id=r.conversation_id WHERE r.workflow_id=$1 AND p.body LIKE 'Bonjour%'", [id]))[0];
  expect(french).toBeTruthy();
  await table.filter({ hasText: "Ended at path F." }).first().getByRole("button").click();
  const detail = page.getByRole("complementary", { name: "Run" });
  const trace = detail.getByRole("list", { name: "What it did" });
  await expect(trace).toContainText("Added a tag");
  await expect(trace).toContainText(/Branch “French” matched|No branch matched: else/);
  await expect(trace).toContainText("Wait until office hours");
  await expect(trace).toContainText("Letting Zoe answer");
  await expect(trace).toContainText("Zoe handed it over");
  await expect(trace).toContainText("Handed to the team");
  // The French one went to the French desk.
  const routed = await sql(
    `SELECT c.team_id FROM conversations c JOIN conversation_parts p ON p.workspace_id=c.workspace_id AND p.conversation_id=c.id WHERE p.body LIKE 'Bonjour%'`,
  );
  expect(routed).toEqual([{ team_id: "acc-fr" }]);

  // Broken on purpose: its tag is archived. Three failures in a row raise the alert.
  await sql("UPDATE tags SET archived_at=now() WHERE id='acc-triaged'");
  for (const text of ["Broken one", "Broken two", "Broken three"]) await ask(await (await browser.newContext()).newPage(), text);
  await expect.poll(async () => (await sql("SELECT 1 FROM workflow_alerts WHERE workflow_id=$1 AND resolved_at IS NULL", [id])).length, { timeout: 20000 }).toBe(1);
  await page.goto(relay.hostOrigin + "/agent#workflows");
  const alert = page.locator(".pg-wf-alert").filter({ hasText: "Acceptance: triage and escalate" });
  await expect(alert).toContainText("keeps failing: 3 failed runs in a row");
  await expect(alert).toContainText("This tag is archived. Restore it in Settings to use it again.");
  await expect(page.locator(".pg-wf-row", { hasText: "Acceptance: triage and escalate" })).toContainText("Failing");
  // Managers are notified; the notification opens its failed runs.
  await page.getByRole("button", { name: /^Notifications, [1-9]\d* unread$/ }).click();
  await page.getByRole("button", { name: /A workflow keeps failing/ }).click();
  await expect(page.getByLabel("Workflow", { exact: true })).toHaveValue(id);
  await expect(page.locator(".pg-wf-runs tbody tr", { hasText: "Failed" })).toHaveCount(3);
});

test("a template is chosen with its team, a webhook refuses calls without its secret and starts the workflow with it, and a failing workflow's alert is dismissed", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#workflows");
  // From a template: its team is asked for, and the draft opens in the builder, ready to publish.
  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByLabel("Start from").selectOption("route_by_language");
  await expect(page.getByLabel("Name")).toHaveValue("Route by language");
  await expect(page.getByRole("button", { name: "Create and open" })).toBeDisabled();
  await page.getByLabel("The French-speaking team").selectOption("acc-fr");
  await page.getByLabel("Everyone else goes to").selectOption("acc-en");
  await page.getByRole("button", { name: "Create and open" }).click();
  await expect(page.locator('.react-flow__node[data-id="B"]')).toContainText("Assign to the team French desk");
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();

  // A webhook: its address and secret in the builder; calls without the secret are refused.
  const made = await api(page, "workflow", {
    action: "create",
    name: "From the CRM",
    definition: {
      trigger: { type: "webhook", options: {} },
      when: { match: "all", items: [{ field: "trigger.data", key: "tier", op: "is", value: "vip" }] },
      paths: [{ id: "A", label: "", steps: [step("tag_add", { tagId: "acc-vip" })], next: { type: "end" } }],
    },
  });
  const id = made.body.workflow.id;
  await page.goto(relay.hostOrigin + `/agent#workflows/${id}`);
  const panel = page.getByRole("complementary", { name: "Trigger" });
  await expect(panel).toContainText(`/v1/hooks/demo/workflows/${id}`);
  await expect(panel).toContainText("It needs a secret before it accepts calls.");
  await panel.getByRole("button", { name: "Make a secret" }).click();
  const secret = (await panel.getByTestId("hook-secret").textContent())!;
  expect(secret).toMatch(/^whk_/);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.locator(".pg-wf-bar").getByRole("status")).toHaveText("Version 1 is live");
  const hookUrl = `${relay.apiOrigin}/v1/hooks/demo/workflows/${id}`;
  const [conv] = await sql("SELECT id FROM conversations WHERE status<>'closed' AND visibility='customer' ORDER BY created_at DESC LIMIT 1");
  const call = (token: string, key: string | null) =>
    fetch(hookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify({ conversationId: conv.id, data: { tier: "vip" } }),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
  expect((await call("whk_wrong", crypto.randomUUID())).status).toBe(401);
  expect((await call(secret, null)).body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  expect((await call(secret, crypto.randomUUID())).body).toEqual({ queued: true, conversationId: conv.id });
  await expect
    .poll(async () => (await sql("SELECT tag_id FROM conversation_tags WHERE conversation_id=$1 AND tag_id='acc-vip'", [conv.id])).length, { timeout: 15000 })
    .toBe(1);

  // A failing workflow's alert, dismissed by a manager, goes from the list.
  await sql("UPDATE tags SET archived_at=now() WHERE id='acc-vip'");
  const fresh = await sql<{ id: string }>("SELECT id FROM conversations WHERE status<>'closed' AND visibility='customer' AND id<>$1 ORDER BY created_at DESC LIMIT 3", [conv.id]);
  for (const c of fresh)
    await fetch(hookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ conversationId: c.id, data: { tier: "vip" } }),
    });
  await expect.poll(async () => (await sql("SELECT 1 FROM workflow_alerts WHERE workflow_id=$1 AND resolved_at IS NULL", [id])).length, { timeout: 15000 }).toBe(1);
  await page.goto(relay.hostOrigin + "/agent#workflows");
  const alert = page.locator(".pg-wf-alert").filter({ hasText: "From the CRM" });
  await expect(alert).toContainText("3 failed runs in a row");
  await alert.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator(".pg-wf-alert").filter({ hasText: "From the CRM" })).toHaveCount(0);
  await sql("UPDATE tags SET archived_at=NULL WHERE id='acc-vip'");
});
