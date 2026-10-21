import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";

/**
 * The audit log (phase 16, C1; docs/SECURITY_STEP1.md), end to end: a tag added in Settings is in
 * Settings › Security › Audit log with who added it; filtered to its area; its details open; an
 * export of what's filtered is prepared and downloads as CSV; changing retention is itself
 * recorded. A teammate who doesn't manage the workspace sees no audit log and can't read it.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9092, hostPort: 9093, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});

test("a change in Settings is in the audit log with who made it; filtered, opened, exported, and retention is recorded", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/tags");
  await page.getByLabel("Tag name").fill("Audit trail check");
  await page.getByRole("button", { name: "Add tag" }).click();
  await expect(page.getByText("Added Audit trail check.")).toBeVisible();

  await page.goto(relay.hostOrigin + "/agent#settings/audit");
  await expect(page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Audit log" })).toBeVisible();
  const log = page.getByRole("table", { name: "Audit log" });
  const row = log.getByRole("row", { name: /Tag created/ }).filter({ hasText: "Audit trail check" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Support teammate");

  // Filtered to its area; the details say what was recorded.
  const filters = page.getByRole("form", { name: "Filter the audit log" });
  await filters.getByLabel("Area").selectOption("Data");
  await filters.getByLabel("Search").fill("Audit trail");
  await filters.getByRole("button", { name: "Filter" }).click();
  await expect(log.getByRole("row")).toHaveCount(2);
  await row.getByRole("button", { name: "Tag created" }).click();
  await expect(row).toContainText("name Audit trail check");

  // Export what's filtered: prepared in the background, then a CSV download with the event.
  await page.getByRole("button", { name: "Export CSV" }).click();
  const exports = page.getByRole("list", { name: "Your exports" });
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(exports.getByRole("link", { name: /Download \(1 event\)/ })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20000 });
  const href = await exports.getByRole("link", { name: /Download/ }).getAttribute("href");
  const csv = await (await page.request.get(href!)).text();
  expect(csv.split("\n")[0]).toBe("at,action,label,area,actor_type,actor_id,actor_name,via,target_type,target_id,target_name,details");
  expect(csv).toContain('"Audit trail check"');

  // Retention: changed, and the change and the export are both in the log.
  await page.getByLabel("Keep events for").selectOption({ label: "2 years" });
  await filters.getByRole("button", { name: "Clear" }).click();
  await expect(log.getByRole("row", { name: /Audit log retention created/ })).toBeVisible();
  await expect(log.getByRole("row", { name: /Audit log exported/ })).toBeVisible();
  await expect(page.getByLabel("Keep events for")).toHaveValue("730");
});

test("a teammate who doesn't manage the workspace has no audit log, and can't read it", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent?as=grace#settings");
  await expect(page.getByRole("navigation", { name: "Settings pages" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Audit log" })).toHaveCount(0);
  const status = await page.evaluate(async () => (await fetch("/api/agent/audit?as=grace")).status);
  expect(status).toBe(403);
  const exported = await page.evaluate(async () => {
    const r = await fetch("/api/agent/audit?as=grace", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ action: "export", format: "csv" }),
    });
    return r.status;
  });
  expect(exported).toBe(403);
});
