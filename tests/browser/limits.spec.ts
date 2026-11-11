import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { getIdentity } from "../../server/people";
import { command } from "../../server/conversations";

/**
 * Limits (phase 16, C9b; docs/SECURITY_STEP17.md), end to end. Happy path: with one email already
 * sent this period, a manager sets the emails limit to 1 on Settings › Billing › Usage; the meter
 * shows as paused; clearing the limit lifts it; a spend cap saves but says it isn't applied while
 * prices aren't set. Failure path: a limit of 0 and a cap under $1 are refused with the reason, and an
 * agent can't change limits.
 */
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9191, hostPort: 9192, aiAgent: false });
  await tenant(relay.db.connect, "demo", async (db) => {
    const who = await getIdentity(db, "demo", "user", "limits-ada", { name: "Limits Ada", email: "ada@limits.example" });
    const r = (await command(db, "demo", { type: "contact", identityId: who.identityId, brandId: "default" }, crypto.randomUUID(), {
      action: "start",
      text: "A question answered by email",
    } as unknown as Parameters<typeof command>[4])) as { conversationId: string };
    const part = (await db.query<{ id: string }>("SELECT id FROM conversation_parts WHERE workspace_id='demo' AND conversation_id=$1 AND body<>'' ORDER BY seq LIMIT 1", [r.conversationId])).rows[0].id;
    await db.query("INSERT INTO channel_deliveries(workspace_id,id,part_id,conversation_id,channel,identity_id,address,status) VALUES('demo',$1,$2,$3,'email',$4,'ada@limits.example','sent')", [
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

test("a manager sets a limit that's reached, sees the meter paused, and clears it; a spend cap saves but isn't applied yet", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/usage");
  const form = page.getByRole("form", { name: "Usage limits" });
  await form.getByRole("textbox", { name: "Emails sent" }).fill("1");
  await form.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Limits saved." })).toBeVisible();
  const emails = page.getByRole("table", { name: "Usage by meter" }).getByRole("row", { name: /^Emails sent/ });
  await expect(emails).toContainText("Paused");
  await expect(emails.getByText("Paused")).toHaveAttribute("title", "This period's limit for emails (1) is reached.");

  await form.getByRole("textbox", { name: "Emails sent" }).fill("");
  await form.getByRole("textbox", { name: "Spend cap per period (USD)" }).fill("25");
  await form.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Limits saved." })).toBeVisible();
  await expect(emails).not.toContainText("Paused");
  await expect(form.getByRole("textbox", { name: "Spend cap per period (USD)" })).toHaveValue("25.00");
  await expect(form).toContainText("a spend cap can be saved but isn't applied");
});

test("a limit of 0 and a cap under $1 are refused with the reason; an agent can't change limits", async ({ page, browser }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/usage");
  const form = page.getByRole("form", { name: "Usage limits" });
  await form.getByRole("textbox", { name: "Emails sent" }).fill("0");
  await form.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByRole("alert")).toContainText("A limit is a whole number of emails, at least 1.");
  await form.getByRole("textbox", { name: "Emails sent" }).fill("");
  await form.getByRole("textbox", { name: "Spend cap per period (USD)" }).fill("0.50");
  await form.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByRole("alert")).toContainText("A spend cap is at least $1.00.");

  const grace = await (await browser.newContext()).newPage();
  await grace.goto(relay.hostOrigin + "/agent?as=grace");
  await expect(grace.getByRole("status").filter({ hasText: "●" })).toBeVisible({ timeout: 15000 });
  const refused = await grace.evaluate(async () => {
    const r = await fetch("/api/agent/usage", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ action: "limits", limits: { emails: 1 } }),
    });
    return r.status;
  });
  expect(refused).toBe(403);
});
