import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";
import { checkUsageAlerts } from "../../server/usage-alerts";

/**
 * Usage alerts (phase 16, C9c; docs/SECURITY_STEP18.md), end to end. Happy path: a manager sets an
 * emails limit of 2 and an alert at 50% on Settings › Billing › Usage; with one email sent, the sweep's
 * check tells them; the notification says what crossed, and opening it goes to Usage. Failure path:
 * a threshold over 100 is refused with the reason, and a teammate who doesn't manage billing isn't
 * told.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9193, hostPort: 9194, aiAgent: false });
  await tenant(relay.db.connect, "demo", async (db) => {
    const who = await getIdentity(db, "demo", "user", "alerts-ada", { name: "Alerts Ada", email: "ada@alerts.example" });
    const r = (await command(db, "demo", { type: "contact", identityId: who.identityId, brandId: "default" }, crypto.randomUUID(), {
      action: "start",
      text: "A question answered by email",
    } as unknown as Parameters<typeof command>[4])) as { conversationId: string };
    const part = (await db.query<{ id: string }>("SELECT id FROM conversation_parts WHERE workspace_id='demo' AND conversation_id=$1 AND body<>'' ORDER BY seq LIMIT 1", [r.conversationId])).rows[0].id;
    await db.query("INSERT INTO channel_deliveries(workspace_id,id,part_id,conversation_id,channel,identity_id,address,status) VALUES('demo',$1,$2,$3,'email',$4,'ada@alerts.example','sent')", [
      crypto.randomUUID(),
      part,
      r.conversationId,
      who.identityId,
    ]);
  });
});
test.afterAll(async () => {
  await relay?.close();
});

test("a manager sets an alert at 50% of a limit, is told when it's crossed, and the notification opens Usage", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/usage");
  const form = page.getByRole("form", { name: "Usage limits" });
  await form.getByRole("textbox", { name: "Emails sent" }).fill("2");
  await form.getByRole("textbox", { name: "Alert at (% of each limit and the cap)" }).fill("50");
  await form.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Limits saved." })).toBeVisible();
  await expect(form.getByRole("textbox", { name: "Alert at (% of each limit and the cap)" })).toHaveValue("50");

  // The sweep's check, run now (the local relay's own sweep may get there first; either way, once).
  await checkUsageAlerts(relay.db.connect, "demo");
  await expect
    .poll(async () => (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT 1 FROM usage_alerts WHERE workspace_id='demo'"))).rows.length)
    .toBe(1);
  await page.goto(relay.hostOrigin + "/agent");
  await page.getByRole("button", { name: /^Notifications, 1 unread/ }).click();
  const alert = page.getByRole("button", { name: /Usage alert/ });
  await expect(alert).toContainText("50% of this period's limit for emails: 1 of 2.");
  await alert.click();
  await expect(page).toHaveURL(/#settings\/usage$/);
  await expect(page.getByRole("form", { name: "Usage limits" })).toBeVisible();
});

test("a threshold over 100 is refused with the reason; a teammate who doesn't manage billing isn't told", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/usage");
  const form = page.getByRole("form", { name: "Usage limits" });
  await form.getByRole("textbox", { name: "Alert at (% of each limit and the cap)" }).fill("80, 150");
  await form.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByRole("alert")).toContainText("Alert at up to 5 percentages, each a whole number from 1 to 100.");
  const grace = (await tenant(relay.db.connect, "demo", (db) => db.query("SELECT 1 FROM notifications WHERE workspace_id='demo' AND teammate_id='grace' AND kind='usage_alert'"))).rows;
  expect(grace).toHaveLength(0);
});
