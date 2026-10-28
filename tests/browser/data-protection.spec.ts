import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

/**
 * Data protection (phase 16, C6b; docs/SECURITY_STEP10.md), end to end. Happy path: a manager turns
 * on card numbers in Settings › Data protection, tries a custom pattern on a sample and adds it; a
 * customer's message with a card and an account number then shows only asterisks in the inbox.
 * Failure path: a pattern that could run for ever is refused with the reason, and a teammate without
 * security.manage can't reach the page or the API.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9173, hostPort: 9174, aiAgent: false });
});
test.afterAll(async () => {
  await relay?.close();
});
const CARD = "4111 1111 1111 1111";

test("a manager turns on card redaction and adds a pattern; a customer's numbers reach the inbox as asterisks", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/data-protection");
  const builtIns = page.getByRole("group", { name: "Built-in rules" });
  await builtIns.getByRole("checkbox", { name: /Card numbers/ }).check();
  await expect(page.getByRole("status").filter({ hasText: "Card numbers are now redacted." })).toBeVisible();
  await expect(builtIns.getByRole("checkbox", { name: /Card numbers/ })).toBeChecked();

  const form = page.getByRole("form", { name: "Add a pattern" });
  await form.getByRole("textbox", { name: "Name" }).fill("Account numbers");
  await form.getByRole("textbox", { name: "Pattern" }).fill("ACC-\\d{8}");
  await form.getByRole("textbox", { name: "Try it on" }).fill("Account ACC-12345678");
  await form.getByRole("button", { name: "Try" }).click();
  await expect(form.getByLabel("Result")).toHaveText("Becomes: Account ************");
  await form.getByRole("button", { name: "Add pattern" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Pattern added." })).toBeVisible();
  await expect(page.getByRole("list", { name: "Custom patterns" })).toContainText("Account numbers");

  const id = await tenant(relay.db.connect, "demo", async (db) => {
    const who = await getIdentity(db, "demo", "user", "redaction-ada", { name: "Redaction Ada", email: "ada@redaction.example" });
    const r = (await command(db, "demo", { type: "contact", identityId: who.identityId, brandId: "default" }, crypto.randomUUID(), {
      action: "start",
      text: `Please refund card ${CARD} on account ACC-12345678`,
    } as unknown as Parameters<typeof command>[4])) as { conversationId: string };
    await db.query("UPDATE conversations SET name='Redacted refund' WHERE workspace_id='demo' AND id=$1", [r.conversationId]);
    return r.conversationId;
  });
  expect(id).toBeTruthy();
  await page.goto(relay.hostOrigin + "/agent");
  await expect(page.getByRole("status").filter({ hasText: "●" })).toHaveText("● Live");
  await page.getByRole("button", { name: /Redacted refund/ }).click();
  await expect(page.getByRole("log", { name: "Messages" })).toContainText(`Please refund card ${"*".repeat(CARD.length)} on account ************`);
  await expect(page.getByRole("log", { name: "Messages" })).not.toContainText(CARD);
});

test("an unsafe pattern is refused with the reason; an agent can't reach data protection", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/data-protection");
  const form = page.getByRole("form", { name: "Add a pattern" });
  await form.getByRole("textbox", { name: "Name" }).fill("Runaway");
  await form.getByRole("textbox", { name: "Pattern" }).fill("(a+)+$");
  await form.getByRole("button", { name: "Add pattern" }).click();
  await expect(form.getByRole("alert")).toContainText("A repeated group can't itself repeat");
  await expect(page.getByText("No custom patterns yet.").or(page.getByRole("list", { name: "Custom patterns" }))).toBeVisible();
  await expect(page.getByRole("list", { name: "Custom patterns" }).getByText("Runaway")).toHaveCount(0);

  const grace = await (await browser.newContext()).newPage();
  await grace.goto(relay.hostOrigin + "/agent?as=grace#settings");
  await expect(grace.getByRole("navigation", { name: "Settings pages" })).toBeVisible({ timeout: 15000 });
  await expect(grace.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Data protection" })).toHaveCount(0);
  expect(await grace.evaluate(async () => (await fetch("/api/agent/data-protection", { credentials: "same-origin" })).status)).toBe(403);
});
