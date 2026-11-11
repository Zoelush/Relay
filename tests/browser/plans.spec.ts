import { test, expect, type Page } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { settingsMenu } from "./settings-menu";

/**
 * Plans (phase 16, C8a; docs/SECURITY_STEP14.md), end to end. Happy path: an owner sees Enterprise
 * on Settings › Billing › Plan with every tier compared and prices not set yet; moved to Starter, the
 * page says so, Pro's pages leave Settings, and turning on a redaction rule is refused with the plan
 * it needs. Failure path: on Starter a second brand is refused with the count, and an agent can't
 * reach the Plan page.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9185, hostPort: 9186, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});
const setPlan = (plan: string) => tenant(relay.db.connect, "demo", (db) => db.query("UPDATE workspace_plans SET plan=$1 WHERE workspace_id='demo'", [plan]));
const post = (page: Page, path: string, body: unknown) =>
  page.evaluate(
    async ({ path, body }) => {
      const r = await fetch("/api/agent/" + path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as { error?: { code?: string; message?: string } } };
    },
    { path, body },
  );

test("an owner sees their plan and every tier; on Starter, Pro's pages go and a redaction rule is refused with the plan it needs", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/plan");
  await expect(page.getByRole("heading", { name: "You're on Enterprise" })).toBeVisible();
  const compare = page.getByRole("table", { name: "Compare plans" });
  const workflows = compare.getByRole("row", { name: /^Workflows/ });
  await expect(workflows.getByRole("cell").nth(0).getByLabel("Not included")).toBeVisible();
  await expect(workflows.getByRole("cell").nth(1).getByLabel("Included")).toBeVisible();
  await expect(page.getByText("Prices haven't been set yet.")).toBeVisible();

  await setPlan("starter");
  try {
    await page.reload();
    await expect(page.getByRole("heading", { name: "You're on Starter" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Plan limits" })).toContainText("Brands: 1 of 1");
    const nav = await settingsMenu(page);
    await expect(nav.getByRole("button", { name: "Plan" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Workflows" })).toHaveCount(0);
    await page.goto(relay.hostOrigin + "/agent#settings/data-protection");
    await page.getByRole("group", { name: "Built-in rules" }).getByRole("checkbox", { name: /Card numbers/ }).check();
    await expect(page.getByRole("alert")).toContainText("Content redaction is on the Enterprise plan.");
    await expect(page.getByRole("group", { name: "Built-in rules" }).getByRole("checkbox", { name: /Card numbers/ })).not.toBeChecked();
  } finally {
    await setPlan("enterprise");
  }
});

test("on Starter a second brand is refused with the count; an agent can't reach the Plan page", async ({ page, browser }) => {
  await setPlan("starter");
  try {
    await page.goto(relay.hostOrigin + "/agent#settings/plan");
    await expect(page.getByRole("heading", { name: "You're on Starter" })).toBeVisible();
    const refused = await post(page, "brands", { name: "Second brand" });
    expect(refused.status).toBe(403);
    expect(refused.body.error?.message).toBe("Your plan includes 1 brand, and you have 1. Pro has more.");
  } finally {
    await setPlan("enterprise");
  }
  const grace = await (await browser.newContext()).newPage();
  await grace.goto(relay.hostOrigin + "/agent?as=grace#settings");
  await expect(grace.getByRole("navigation", { name: "Settings pages" })).toBeVisible({ timeout: 15000 });
  await expect((await settingsMenu(grace)).getByRole("button", { name: "Plan" })).toHaveCount(0);
  expect(await grace.evaluate(async () => (await fetch("/api/agent/plan", { credentials: "same-origin" })).status)).toBe(403);
});
