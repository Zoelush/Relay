import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { settingsMenu } from "./settings-menu";

/**
 * Trials, upgrades and downgrades (phase 16, C10b; docs/SECURITY_STEP21.md), end to end. Happy
 * path: a manager on Starter starts the fortnight's trial, sees how long it has left, and upgrades
 * for good. Failure path: a move to a smaller plan waits for the end of the period and can be
 * called off, a second trial is refused with the reason, and an agent has neither page nor API.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9205, hostPort: 9206, aiAgent: false });
  // The demo workspace starts on Enterprise (C8a); this one is a new team on the smallest plan.
  await sql("UPDATE workspace_plans SET plan='starter' WHERE workspace_id='demo'");
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(query: string, values: unknown[] = []) => tenant(relay.db.connect, "demo", async (db) => (await db.query<T>(query, values)).rows);

test("a manager starts the trial, watches it run, and upgrades for good", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/plan");
  await expect(page.getByRole("heading", { name: "You're on Starter" })).toBeVisible({ timeout: 20000 });

  // The trial: a fortnight of Pro, with no card.
  await page.getByRole("button", { name: /Start the 14-day Pro trial/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Your 14-day trial has started." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "You're on Pro" })).toBeVisible();
  await expect(page.getByText(/Your trial of Pro has 14 days left/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Start the 14-day Pro trial/ })).toHaveCount(0);
  expect((await sql<{ kind: string }>("SELECT kind FROM plan_changes ORDER BY seq")).map((r) => r.kind)).toEqual(["trial_started"]);

  // Upgrading for good: at once, and the trial ends with it.
  await page.getByRole("button", { name: "Upgrade to Enterprise" }).click();
  await expect(page.getByRole("status").filter({ hasText: "You're on Enterprise." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "You're on Enterprise" })).toBeVisible();
  await expect(page.getByText(/Your trial of Pro has/)).toHaveCount(0);
  expect((await sql<{ plan: string; trial_plan: string | null }>("SELECT plan,trial_plan FROM workspace_plans"))[0]).toMatchObject({ plan: "enterprise", trial_plan: null });
  // What has happened is kept, in order.
  await expect(page.getByRole("list", { name: "Plan history" })).toContainText("Upgraded: Pro to Enterprise");
});

test("a move to a smaller plan waits for the period's end and can be called off; a second trial and an agent are refused", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/plan");
  await expect(page.getByRole("heading", { name: "You're on Enterprise" })).toBeVisible({ timeout: 20000 });

  await page.getByRole("button", { name: "Move to Starter" }).click();
  await expect(page.getByRole("status").filter({ hasText: "You move to Starter when this period ends." })).toBeVisible();
  await expect(page.getByText(/You move to Starter on /)).toBeVisible();
  await expect(page.getByText(/Your data stays/)).toBeVisible();
  // Still Enterprise until then, with the change recorded as waiting.
  await expect(page.getByRole("heading", { name: "You're on Enterprise" })).toBeVisible();
  expect((await sql<{ pending_plan: string }>("SELECT pending_plan FROM workspace_plans"))[0].pending_plan).toBe("starter");

  // Called off.
  await page.getByRole("button", { name: "Keep Enterprise" }).click();
  await expect(page.getByRole("status").filter({ hasText: "The change is called off." })).toBeVisible();
  await expect(page.getByText(/You move to Starter on /)).toHaveCount(0);
  expect((await sql<{ pending_plan: string | null }>("SELECT pending_plan FROM workspace_plans"))[0].pending_plan).toBe(null);

  // The trial is offered once: asking again is refused with the reason.
  const refused = await page.evaluate(async () => {
    const r = await fetch("/api/agent/plan", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ action: "start_trial" }),
    });
    return { status: r.status, body: (await r.json()) as { error?: { message?: string } } };
  });
  expect(refused.status).toBe(409);
  expect(refused.body.error?.message).toBe("This workspace has already had its trial.");

  // An agent has no Plan page, and the API refuses them.
  const grace = await (await browser.newContext()).newPage();
  await grace.goto(relay.hostOrigin + "/agent?as=grace#settings");
  await expect(grace.getByRole("navigation", { name: "Settings pages" })).toBeVisible({ timeout: 20000 });
  await expect((await settingsMenu(grace)).getByRole("button", { name: "Plan" })).toHaveCount(0);
  expect(
    await grace.evaluate(async () =>
      (
        await fetch("/api/agent/plan", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({ action: "change", plan: "starter" }),
        })
      ).status,
    ),
  ).toBe(403);
});
