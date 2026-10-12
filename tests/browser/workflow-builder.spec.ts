import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/** The workflow builder (phase 11, W2; docs/WORKFLOWS_STEP2.md): built on the canvas, published, run. */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9030, hostPort: 9031, inboxViews: true, aiAgent: false });
  await sql("DELETE FROM calendar_assignments");
  await sql("UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
  await sql("INSERT INTO tags(workspace_id,id,name) VALUES('demo','wb-french','French speaker'),('demo','wb-old','Old plan')");
  await sql("INSERT INTO teams(workspace_id,id,name) VALUES('demo','wb-fr','French desk') ON CONFLICT DO NOTHING");
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
/** Drags from a card's handle to a point on the canvas, as a mouse would. */
async function dragHandle(page: Page, node: string, handle: string, to: { x: number; y: number }) {
  const box = (await page.locator(`.react-flow__handle[data-nodeid="${node}"][data-handleid="${handle}"]`).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x - 20, to.y - 20, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await page.mouse.up();
}
const card = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

test("a workflow built on the canvas (conditions, a path dropped on empty canvas, undo and redo) is published and runs for a French customer", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent");
  await page.getByRole("button", { name: "Workflows", exact: true }).click();
  await expect(page).toHaveURL(/#workflows$/);
  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByLabel("Name").fill("Route French speakers");
  await page.getByLabel("When").selectOption("first_message");
  await page.getByRole("button", { name: "Create and open" }).click();
  await expect(page).toHaveURL(/#workflows\/[0-9a-f-]+$/);
  const panel = page.getByRole("complementary", { name: "Trigger" });

  // Who it runs for, with a live estimate.
  await panel.getByRole("button", { name: "Condition" }).click();
  await panel.getByLabel("Condition 1, value").fill("fr");
  await expect(panel.getByRole("status")).toContainText(/It would have run for \d+ of the last \d+ conversations|no conversations from the past 30 days/);
  await expect(card(page, "trigger")).toContainText("Runs for: Language is fr");

  // Path A: tag them.
  await card(page, "A").click();
  const pathA = page.getByRole("complementary", { name: "Path A" });
  await pathA.getByLabel("Add a step").selectOption("tag_add");
  await pathA.getByLabel("Step 1, tag").selectOption("wb-french");
  await expect(card(page, "A")).toContainText("Add the tag “French speaker”");

  // A way on dropped on empty canvas makes path B there, connected.
  const canvas = (await page.locator(".pg-wf-canvas").boundingBox())!;
  await dragHandle(page, "A", "next", { x: canvas.x + canvas.width - 220, y: canvas.y + 200 });
  await expect(card(page, "B")).toBeVisible();
  await expect(card(page, "A")).toContainText("Then → B");
  const pathB = page.getByRole("complementary", { name: "Path B" });
  await pathB.getByLabel("Add a step").selectOption("assign");
  await pathB.getByLabel("Step 1, team", { exact: true }).selectOption("wb-fr");

  // Undo takes back the step, then the new path; redo brings both back.
  await page.locator(".react-flow__pane").click({ position: { x: 40, y: 40 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(card(page, "B")).not.toContainText("Assign");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(card(page, "B")).toHaveCount(0);
  await expect(card(page, "A")).toContainText("END");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(card(page, "B")).toContainText("Assign to the team French desk");

  // The list of paths, and tidying up, keep both cards.
  await page.getByRole("button", { name: "List of paths" }).click();
  await expect(page.getByRole("list", { name: "Paths" }).getByRole("button")).toHaveText([/Trigger/, /A\s+Start/, /B\s+Path B/]);
  await page.getByRole("list", { name: "Paths" }).getByRole("button", { name: /Path B/ }).click();
  await page.getByRole("button", { name: "Tidy up" }).click();
  // A card dragged down stays where it's put (once the canvas has settled from tidying).
  let last = "";
  await expect
    .poll(async () => {
      const now = JSON.stringify(await card(page, "B").boundingBox());
      const still = now === last;
      last = now;
      return still;
    }, { intervals: [150] })
    .toBe(true);
  const head = (await card(page, "B").locator(".pg-wf-card-head").boundingBox())!;
  await page.mouse.move(head.x + 40, head.y + head.height / 2);
  await page.mouse.down();
  await page.mouse.move(head.x + 40, head.y + 80, { steps: 5 });
  await page.mouse.move(head.x + 40, head.y + 160, { steps: 5 });
  await page.mouse.up();

  // Published: a version, and it runs.
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.locator(".pg-wf-bar").getByRole("status")).toHaveText("Version 1 is live");
  await expect(page.locator(".pg-wf-bar .pg-wf-state")).toHaveText("Live");
  const [wf] = await sql<{ id: string; layout: Record<string, unknown> }>("SELECT id,layout FROM workflows WHERE name='Route French speakers'");
  expect(Object.keys(wf.layout).sort()).toEqual(["A", "B", "trigger"]);
  expect((wf.layout.B as { y: number }).y).toBeGreaterThan(60);
  expect(wf.layout.A).toEqual({ x: 380, y: 0 });

  const customer = await (await browser.newContext()).newPage();
  await ask(customer, "Bonjour, ma commande n'est pas arrivée");
  await expect
    .poll(async () => (await sql("SELECT status FROM workflow_runs WHERE workflow_id=$1", [wf.id])).map((r) => r.status), { timeout: 15000 })
    .toEqual(["completed"]);
  const [routed] = await sql(
    `SELECT c.team_id,(SELECT array_agg(tag_id) FROM conversation_tags t WHERE t.workspace_id=c.workspace_id AND t.conversation_id=c.id) AS tags
     FROM conversations c JOIN conversation_parts p ON p.workspace_id=c.workspace_id AND p.conversation_id=c.id WHERE p.body LIKE 'Bonjour, ma commande%'`,
  );
  expect(routed).toEqual({ team_id: "wb-fr", tags: ["wb-french"] });

  // Versions: published once, nothing to restore yet.
  await page.getByRole("button", { name: "Versions" }).click();
  await expect(page.getByRole("complementary", { name: "Versions" })).toContainText("Version 1");

  // Back to the list: grouped by trigger, and a second workflow dragged above it takes priority.
  await page.getByRole("button", { name: "Workflows", exact: true }).first().click();
  await api(page, "workflow", { action: "create", name: "Greet VIPs", trigger: "first_message" });
  await page.reload();
  const group = page.getByRole("region", { name: "A customer sends their first message" });
  await expect(group.locator(".pg-wf-row-name")).toHaveText(["Route French speakers", "Greet VIPs"]);
  await group.locator(".pg-wf-row", { hasText: "Greet VIPs" }).dragTo(group.locator(".pg-wf-row", { hasText: "Route French speakers" }));
  await expect(group.locator(".pg-wf-row-name")).toHaveText(["Greet VIPs", "Route French speakers"]);
  await page.reload();
  await expect(group.locator(".pg-wf-row-name")).toHaveText(["Greet VIPs", "Route French speakers"]);
  await group.getByRole("button", { name: "Move Greet VIPs down" }).click();
  await expect(group.locator(".pg-wf-row-name")).toHaveText(["Route French speakers", "Greet VIPs"]);
  await expect(group.locator(".pg-wf-row", { hasText: "Route French speakers" })).toContainText("Live");
  await expect(group.locator(".pg-wf-row", { hasText: "Route French speakers" })).toContainText("1 completed");
});

test("the builder won't publish a broken workflow, and says why; the server's refusals and someone else's change are shown too", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent");
  const made = await api(page, "workflow", {
    action: "create",
    name: "Tag old plans",
    definition: {
      trigger: { type: "customer_message", options: {} },
      paths: [{ id: "A", label: "", steps: [{ id: "s1", type: "tag_add", options: { tagId: "wb-old" } }], next: { type: "end" } }],
    },
  });
  await page.goto(relay.hostOrigin + `/agent#workflows/${made.body.workflow.id}`);
  await expect(card(page, "A")).toContainText("Add the tag “Old plan”");

  // A branch with nowhere to go: listed, flagged on its card, and publishing is blocked.
  await card(page, "A").click();
  const pathA = page.getByRole("complementary", { name: "Path A" });
  await pathA.getByLabel("What happens after its steps").selectOption("branch");
  const blockers = page.locator("#pg-wf-blockers");
  await expect(blockers).toContainText("problems block publishing");
  await expect(blockers).toContainText("Path A: a way on doesn't lead anywhere. Choose its path.");
  await expect(blockers).toContainText("Path A, branch 1: give it a condition.");
  await expect(card(page, "A").getByLabel("Has a problem")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
  // Undone, it can be published again.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(blockers).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeEnabled();

  // The tag is archived meanwhile: the server refuses, naming it, and nothing goes live.
  await sql("UPDATE tags SET archived_at=now() WHERE id='wb-old'");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("It can't be published yet: Path A, step 1: its tag doesn't exist (or is archived).");
  await expect(page.locator(".pg-wf-bar .pg-wf-state")).toHaveText("Draft");
  expect(await sql("SELECT 1 FROM workflow_versions WHERE workflow_id=$1", [made.body.workflow.id])).toEqual([]);

  // Someone else saves first: this save is refused, and Reload shows theirs.
  const current = await api(page, `workflows?id=${made.body.workflow.id}`);
  await api(page, "workflow", { action: "save", id: made.body.workflow.id, version: current.body.workflow.version, name: "Tag old plans (theirs)", definition: current.body.workflow.definition });
  await page.getByLabel("Workflow name").fill("Tag old plans (mine)");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert")).toContainText("Someone else changed this workflow. Reload to see it.");
  await page.getByRole("alert").getByRole("button", { name: "Reload" }).click();
  await expect(page.getByLabel("Workflow name")).toHaveValue("Tag old plans (theirs)");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
