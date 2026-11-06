import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

/**
 * Usage (phase 16, C9a; docs/SECURITY_STEP16.md), end to end. Happy path: a manager opens Settings ›
 * Billing › Usage, sees the emails sent this period (prices not set yet), lists them, and follows one
 * back to its conversation. Failure path: an unknown meter is refused with the reason, and an agent
 * can't reach the page or its API.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
let conversationId = "";
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9189, hostPort: 9190, aiAgent: false });
  conversationId = await tenant(relay.db.connect, "demo", async (db) => {
    const who = await getIdentity(db, "demo", "user", "usage-ada", { name: "Usage Ada", email: "ada@usage.example" });
    const r = (await command(db, "demo", { type: "contact", identityId: who.identityId, brandId: "default" }, crypto.randomUUID(), {
      action: "start",
      text: "A question that was answered by email",
    } as unknown as Parameters<typeof command>[4])) as { conversationId: string };
    const part = (await db.query<{ id: string }>("SELECT id FROM conversation_parts WHERE workspace_id='demo' AND conversation_id=$1 AND body<>'' ORDER BY seq LIMIT 1", [r.conversationId])).rows[0].id;
    await db.query("INSERT INTO channel_deliveries(workspace_id,id,part_id,conversation_id,channel,identity_id,address,status) VALUES('demo',$1,$2,$3,'email',$4,'ada@usage.example','delivered')", [
      crypto.randomUUID(),
      part,
      r.conversationId,
      who.identityId,
    ]);
    return r.conversationId;
  });
});
test.afterAll(async () => {
  await relay?.close();
});

test("a manager sees this period's usage and follows an email back to its conversation", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/usage");
  const table = page.getByRole("table", { name: "Usage by meter" });
  const emails = table.getByRole("row", { name: /^Emails sent/ });
  await expect(emails).toBeVisible();
  await expect(emails).toContainText("Price not set");
  await expect(page.getByText("Total: Prices haven't been set yet")).toBeVisible();
  await emails.getByRole("button", { name: "See units: Emails sent" }).click();
  const units = page.getByRole("list", { name: "Emails sent units" });
  const link = units.locator(`a[href="#conversation/${conversationId}"]`);
  await expect(link).toBeVisible();
  await link.first().click();
  await expect(page.getByRole("log", { name: "Messages" })).toContainText("A question that was answered by email", { timeout: 15000 });
});

test("an unknown meter is refused with the reason; an agent can't reach Usage", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/usage");
  await expect(page.getByRole("table", { name: "Usage by meter" })).toBeVisible();
  const refused = await page.evaluate(async () => {
    const r = await fetch("/api/agent/usage-units?meter=nothing", { credentials: "same-origin" });
    return { status: r.status, body: (await r.json()) as { error?: { message?: string } } };
  });
  expect(refused.status).toBe(400);
  expect(refused.body.error?.message).toBe("Choose a meter.");

  const grace = await (await browser.newContext()).newPage();
  await grace.goto(relay.hostOrigin + "/agent?as=grace#settings");
  await expect(grace.getByRole("navigation", { name: "Settings pages" })).toBeVisible({ timeout: 15000 });
  await expect(grace.getByRole("navigation", { name: "Settings pages" }).getByRole("button", { name: "Usage" })).toHaveCount(0);
  expect(await grace.evaluate(async () => (await fetch("/api/agent/usage", { credentials: "same-origin" })).status)).toBe(403);
});
