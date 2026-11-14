import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";

/**
 * The paired test workspace (docs/TEST_WORKSPACE_PLAN.md, T1a), end to end. Happy path: a manager
 * makes one from Settings › General, switches into it with the session they already have, and the
 * app says so on every page. Failure path: an agent can neither make one nor reach it, and a
 * workspace that isn't the pair is refused.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9213, hostPort: 9214, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(query: string, values: unknown[] = [], w = "demo") =>
  tenant(relay.db.connect, w, async (db) => (await db.query<T>(query, values)).rows);

test("a manager makes a test workspace, switches into it, and every page says which one they are in", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/general");
  const card = page.getByRole("region", { name: "Test workspace", exact: true });
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card).toContainText("nothing can reach a real person");

  // Making it: the production workspace's brands, roles and teammates, and its plan.
  await card.getByRole("button", { name: "Create a test workspace" }).click();
  await expect(card.getByRole("button", { name: "Switch to it" })).toBeVisible({ timeout: 20000 });
  expect((await sql<{ id: string; test_of: string }>("SELECT id,test_of FROM workspace WHERE test_of='demo'", [], "demo-test"))[0]).toMatchObject({
    id: "demo-test",
    test_of: "demo",
  });
  expect((await sql("SELECT 1 FROM teammates", [], "demo-test")).length).toBe((await sql("SELECT 1 FROM teammates")).length);
  expect((await sql<{ plan: string }>("SELECT plan FROM workspace_plans", [], "demo-test"))[0].plan).toBe(
    (await sql<{ plan: string }>("SELECT plan FROM workspace_plans"))[0].plan,
  );
  // Its brands came with it — without one nothing could be tested — and it has no customers yet.
  expect((await sql<{ id: string }>("SELECT id FROM brands ORDER BY id", [], "demo-test")).map((b) => b.id)).toEqual(
    (await sql<{ id: string }>("SELECT id FROM brands ORDER BY id")).map((b) => b.id),
  );
  // T1b: the configuration came with it, and made-up customers are waiting in its inbox.
  expect((await sql<{ name: string }>("SELECT name FROM macros ORDER BY name", [], "demo-test")).map((m) => m.name)).toEqual(
    (await sql<{ name: string }>("SELECT name FROM macros ORDER BY name")).map((m) => m.name),
  );
  const people = await sql<{ name: string }>("SELECT name FROM contacts", [], "demo-test");
  expect(people.length).toBeGreaterThan(0);
  expect(people.every((p) => p.name.includes("(made up)"))).toBe(true);
  expect((await sql("SELECT 1 FROM conversations", [], "demo-test")).length).toBe(people.length);
  // And nothing that could reach a person came with it.
  for (const table of ["api_tokens", "teammate_credentials", "email_domains", "whatsapp_numbers", "invoices"])
    expect((await sql(`SELECT 1 FROM ${table}`, [], "demo-test")).length).toBe(0);

  // Switching: the same sign-in, and the app says where you are, on every page.
  await card.getByRole("button", { name: "Switch to it" }).click();
  const band = page.getByRole("status").filter({ hasText: "Test workspace" });
  await expect(band).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("region", { name: "Test workspace", exact: true })).toContainText("You are in the test workspace of demo");
  // Its own inbox, empty, with the band still there.
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "Test workspace" })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("status").filter({ hasText: "● Live" })).toBeVisible();

  // And back, from the account menu.
  await page.goto(relay.hostOrigin + "/agent#settings/general");
  await page.getByRole("region", { name: "Test workspace", exact: true }).getByRole("button", { name: "Back to the production workspace" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Test workspace" })).toHaveCount(0, { timeout: 20000 });
  await expect(page.getByRole("region", { name: "Test workspace", exact: true })).toContainText("This workspace has a test workspace");
});

test("an agent cannot make one or reach it, and only the pair can be worked in", async ({ page, browser }) => {
  // The API refuses an agent, whatever the page shows.
  const grace = await (await browser.newContext()).newPage();
  await grace.goto(relay.hostOrigin + "/agent?as=grace#settings/general");
  await expect(grace.getByRole("navigation", { name: "Settings pages" })).toBeVisible({ timeout: 20000 });
  expect(
    await grace.evaluate(async () =>
      (
        await fetch("/api/agent/workspaces", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({ action: "create_test" }),
        })
      ).status,
    ),
  ).toBe(403);

  // A workspace that is not this one's test pair is refused, however it is asked for.
  await page.goto(relay.hostOrigin + "/agent#settings/general");
  await expect(page.getByRole("region", { name: "Test workspace", exact: true })).toBeVisible({ timeout: 20000 });
  const refused = await page.evaluate(async () => {
    const r = await fetch("/api/agent/inbox", { credentials: "same-origin", headers: { "x-relay-workspace": "someone-else" } });
    return { status: r.status, body: (await r.json()) as { error?: { code?: string } } };
  });
  expect(refused.status).toBe(403);
  expect(refused.body.error?.code).toBe("WORKSPACE_NOT_YOURS");
});

/**
 * T2a: promoting a change back. Happy path: a workflow published in the test workspace is
 * promoted from Settings › General and is live in production, which keeps its own record of where
 * it came from. Failure path: one that needs a team production hasn't got says so and offers no
 * button.
 */
test("a change tried in the test workspace is promoted, and one production can't take says why", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/general");
  await expect(page.getByRole("region", { name: "Promoted from the test workspace" })).toContainText("Nothing has been promoted yet", { timeout: 20000 });

  // Into the pair, and two workflows published there: one that needs nothing, and one that
  // assigns to a team only the test workspace has.
  await page.getByRole("region", { name: "Test workspace", exact: true }).getByRole("button", { name: "Switch to it" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Test workspace" })).toBeVisible({ timeout: 20000 });
  await sql("INSERT INTO teams(workspace_id,id,name) VALUES('demo-test','weekend','Weekend') ON CONFLICT DO NOTHING", [], "demo-test");
  const published = await page.evaluate(async () => {
    const call = async (body: unknown) =>
      (
        await fetch("/api/agent/workflow", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID(), "x-relay-workspace": "demo-test" },
          body: JSON.stringify(body),
        })
      ).json() as Promise<any>;
    const out: Record<string, string> = {};
    for (const [name, step] of [
      ["Note every new chat", { id: crypto.randomUUID(), type: "note", options: { text: "Tried in the test workspace." } }],
      ["Weekend cover", { id: crypto.randomUUID(), type: "assign", options: { teamId: "weekend" } }],
    ] as const) {
      const made = await call({
        action: "create",
        name,
        definition: { trigger: { type: "first_message", options: {} }, paths: [{ id: "A", label: "", steps: [step], next: { type: "end" } }] },
      });
      const live = await call({ action: "publish", id: made.workflow.id, version: made.workflow.version });
      out[name] = live.workflow?.state ?? JSON.stringify(live);
    }
    return out;
  });
  expect(published).toEqual({ "Note every new chat": "live", "Weekend cover": "live" });

  // The card says what can go, and what the other one needs — the server's words, not the page's.
  await page.goto(relay.hostOrigin + "/agent#settings/general");
  const promote = page.getByRole("region", { name: "Promote to production" });
  await expect(promote).toBeVisible({ timeout: 20000 });
  const ready = promote.getByRole("listitem").filter({ hasText: "Note every new chat" });
  const blocked = promote.getByRole("listitem").filter({ hasText: "Weekend cover" });
  await expect(blocked).toContainText("its team doesn't exist");
  await expect(blocked.getByRole("button", { name: "Promote" })).toHaveCount(0);

  // Promoted: live in production, as a version of its own.
  await ready.getByRole("button", { name: "Promote" }).click();
  await expect(promote).toContainText("is live in", { timeout: 20000 });
  const there = await sql<{ name: string; state: string; live_version: number }>("SELECT name,state,live_version FROM workflows WHERE name='Note every new chat'");
  expect(there[0]).toMatchObject({ state: "live", live_version: 1 });
  expect((await sql("SELECT 1 FROM audit_events WHERE action='workspace.promoted'")).length).toBe(1);

  // Back in production, the workspace's own record of what arrived and from where.
  await page.getByRole("region", { name: "Test workspace", exact: true }).getByRole("button", { name: "Back to the production workspace" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Test workspace" })).toHaveCount(0, { timeout: 20000 });
  const ledger = page.getByRole("region", { name: "Promoted from the test workspace" });
  await expect(ledger).toContainText("Workflow · Note every new chat");
  await expect(ledger).toContainText("version 1");
});
