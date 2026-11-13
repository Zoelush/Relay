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
  const card = page.getByRole("region", { name: "Test workspace" });
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
  expect((await sql("SELECT 1 FROM conversations", [], "demo-test")).length).toBe(0);

  // Switching: the same sign-in, and the app says where you are, on every page.
  await card.getByRole("button", { name: "Switch to it" }).click();
  const band = page.getByRole("status").filter({ hasText: "Test workspace" });
  await expect(band).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("region", { name: "Test workspace" })).toContainText("You are in the test workspace of demo");
  // Its own inbox, empty, with the band still there.
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "Test workspace" })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("status").filter({ hasText: "● Live" })).toBeVisible();

  // And back, from the account menu.
  await page.goto(relay.hostOrigin + "/agent#settings/general");
  await page.getByRole("region", { name: "Test workspace" }).getByRole("button", { name: "Back to the production workspace" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Test workspace" })).toHaveCount(0, { timeout: 20000 });
  await expect(page.getByRole("region", { name: "Test workspace" })).toContainText("This workspace has a test workspace");
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
  await expect(page.getByRole("region", { name: "Test workspace" })).toBeVisible({ timeout: 20000 });
  const refused = await page.evaluate(async () => {
    const r = await fetch("/api/agent/inbox", { credentials: "same-origin", headers: { "x-relay-workspace": "someone-else" } });
    return { status: r.status, body: (await r.json()) as { error?: { code?: string } } };
  });
  expect(refused.status).toBe(403);
  expect(refused.body.error?.code).toBe("WORKSPACE_NOT_YOURS");
});
