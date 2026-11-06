import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";

/**
 * The security health check, and the subprocessors and encryption page (phase 16, C7c;
 * docs/SECURITY_STEP13.md), end to end. Happy path: a manager sees content redaction among what
 * needs attention, follows its link, turns on card numbers, and comes back to find it fine; the
 * subprocessors and encryption page lists Twilio and the connector key. Failure path: an agent sees
 * neither page, and the API refuses the health check.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9183, hostPort: 9184, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});

test("a manager follows a recommendation from the health check and sees it fixed; the encryption page lists subprocessors and keys", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/health-check");
  const attention = page.getByRole("list", { name: "Needs attention" });
  const redaction = attention.getByRole("listitem").filter({ hasText: "Content redaction" });
  await expect(redaction).toContainText("Recommended");
  await expect(redaction).toContainText("No redaction rules");
  await redaction.getByRole("link", { name: "Change content redaction" }).click();
  await expect(page).toHaveURL(/#settings\/data-protection$/);
  await page.getByRole("group", { name: "Built-in rules" }).getByRole("checkbox", { name: /Card numbers/ }).check();
  await expect(page.getByRole("status").filter({ hasText: "Card numbers are now redacted." })).toBeVisible();

  await page.goto(relay.hostOrigin + "/agent#settings/health-check");
  await expect(page.getByRole("list", { name: "Data protection" }).getByRole("listitem").filter({ hasText: "Content redaction" })).toContainText("Fine");
  await expect(page.getByRole("list", { name: "Needs attention" }).getByRole("listitem").filter({ hasText: "Content redaction" })).toHaveCount(0);

  await page.goto(relay.hostOrigin + "/agent#settings/trust");
  await expect(page.getByRole("table", { name: "Subprocessors" }).getByRole("rowheader", { name: "Twilio" })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "AES-256-GCM" }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Keys" })).toContainText("RELAY_CONNECTOR_KEY");
});

test("an agent sees neither page, and the health check's API refuses them", async ({ browser }) => {
  const grace = await (await browser.newContext()).newPage();
  await grace.goto(relay.hostOrigin + "/agent?as=grace#settings");
  const nav = grace.getByRole("navigation", { name: "Settings pages" });
  await expect(nav).toBeVisible({ timeout: 15000 });
  await expect(nav.getByRole("button", { name: "Health check" })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Subprocessors and encryption" })).toHaveCount(0);
  expect(await grace.evaluate(async () => (await fetch("/api/agent/health-check", { credentials: "same-origin" })).status)).toBe(403);
});
