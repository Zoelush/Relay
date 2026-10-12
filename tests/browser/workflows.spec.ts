import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** The workflow engine (phase 11, W1; docs/WORKFLOWS_STEP1.md): set up through its API, seen in the inbox. */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9028, hostPort: 9029, inboxViews: true, aiAgent: false });
  await sql("DELETE FROM calendar_assignments");
  await sql("UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
  await sql("INSERT INTO tags(workspace_id,id,name) VALUES('demo','wf-triaged','Triaged by language'),('demo','wf-legacy','Legacy plan')");
  await sql("INSERT INTO teams(workspace_id,id,name) VALUES('demo','french','French') ON CONFLICT DO NOTHING");
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

test("a published workflow tags and routes a French customer's conversation; the inbox shows what it did, and the run log why", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent");
  const made = await api(page, "workflow", {
    action: "create",
    name: "Triage by language",
    definition: {
      trigger: { type: "first_message", options: {} },
      paths: [
        {
          id: "A",
          label: "Tag",
          steps: [step("tag_add", { tagId: "wf-triaged" })],
          next: {
            type: "branch",
            branches: [{ label: "French", when: { match: "all", items: [{ field: "conversation.language", op: "is", value: "fr" }] }, path: "B" }],
            else: "C",
          },
        },
        { id: "B", label: "French team", steps: [step("assign", { teamId: "french" })], next: { type: "end" } },
        { id: "C", label: "Everyone else", steps: [], next: { type: "end" } },
      ],
    },
  });
  expect(made.status).toBe(200);
  const live = await api(page, "workflow", { action: "publish", id: made.body.workflow.id, version: made.body.workflow.version });
  expect(live.body.workflow.state).toBe("live");

  const customer = await (await browser.newContext()).newPage();
  await ask(customer, "Bonjour, ma commande n'est pas arrivée");
  await expect
    .poll(async () => (await sql("SELECT status FROM workflow_runs")).map((r) => r.status), { timeout: 15000 })
    .toEqual(["completed"]);

  await page.reload();
  await page.locator(".pg-card", { hasText: "Bonjour, ma commande" }).click();
  const timeline = page.getByRole("region", { name: "Conversation timeline" });
  await timeline.getByRole("button", { name: /^Show \d+ updates$/ }).click();
  await expect(timeline).toContainText("Workflow “Triage by language” added the tag Triaged by language");
  await expect(timeline).toContainText("Workflow “Triage by language” assigned this to team French");

  const runs = await api(page, `workflow-runs?workflow=${made.body.workflow.id}`);
  const run = await api(page, `workflow-runs?id=${runs.body.runs[0].id}`);
  expect(run.body.steps.map((s: { label: string }) => s.label)).toEqual([
    "A customer sends their first message",
    "Added a tag",
    "Branch “French” matched",
    "Assigned to a team (routed by its method)",
    "End",
  ]);
  expect(run.body.steps[2].inputs[0]).toMatchObject({ field: "conversation.language", actual: "fr", result: true });
});

test("a broken graph can't be published, and a step that fails stops its run without touching the conversation", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent");
  const broken = await api(page, "workflow", {
    action: "create",
    name: "Broken",
    definition: { trigger: { type: "customer_message", options: {} }, paths: [{ id: "A", label: "", steps: [], next: { type: "goto", path: "Q" } }] },
  });
  const refused = await api(page, "workflow", { action: "publish", id: broken.body.workflow.id, version: broken.body.workflow.version });
  expect(refused.status).toBe(400);
  expect(refused.body.error.message).toBe("It can't be published yet: Path A: it leads to path Q, which doesn't exist.");

  const legacy = await api(page, "workflow", {
    action: "create",
    name: "Tag legacy",
    definition: { trigger: { type: "customer_message", options: {} }, paths: [{ id: "A", label: "", steps: [step("tag_add", { tagId: "wf-legacy" }), step("priority", { value: true })], next: { type: "end" } }] },
  });
  expect((await api(page, "workflow", { action: "publish", id: legacy.body.workflow.id, version: legacy.body.workflow.version })).body.workflow.state).toBe("live");
  await sql("UPDATE tags SET archived_at=now() WHERE id='wf-legacy'");

  const customer = await (await browser.newContext()).newPage();
  const frame = await ask(customer, "Hello, is anyone there?");
  await expect(frame.locator(".message").filter({ hasText: "Hello, is anyone there?" })).toBeVisible();
  await expect
    .poll(async () => (await sql("SELECT status,error FROM workflow_runs WHERE workflow_id=$1", [legacy.body.workflow.id])), { timeout: 15000 })
    .toEqual([{ status: "failed", error: "This tag is archived. Restore it in Settings to use it again." }]);
  const [conv] = await sql("SELECT c.priority FROM conversations c JOIN conversation_parts p ON p.workspace_id=c.workspace_id AND p.conversation_id=c.id WHERE p.body='Hello, is anyone there?'");
  expect(conv.priority).toBe(false);
  expect(await sql("SELECT 1 FROM jobs WHERE kind='workflow.start' AND state='dead_letter'")).toEqual([]);
});
