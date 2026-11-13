import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { standInPayments } from "../../server/payments";
import { issueDueInvoices } from "../../server/invoices";
import { runDunning } from "../../server/dunning";
import { periodOf } from "../../lib/seats";
import type { PriceBook } from "../../lib/invoices";

/**
 * Dunning (phase 16, C10c; docs/SECURITY_STEP22.md), end to end. Happy path: a declined invoice
 * says when Relay will try again, the manager is told, and paying it clears everything. Failure
 * path: when the tries run out the page says automated sending is paused, and says what to do.
 */
const PRICES: PriceBook = {
  seat: { starter: 2900, pro: 5900, enterprise: 11900 },
  units: { ai_resolutions: 99, ai_resolutions_own_key: 29, emails: 0.4, whatsapp: 5, sms_segments: 2, phone_minutes: 3, outbound_chats: 1, outbound_banners: 0.5, connector_calls: 0.2 },
};
const DAY = 86_400_000;
const payments = standInPayments({ decline: true });
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
let invoiceId = "";
test.use({ viewport: { width: 1440, height: 1000 } });
test.describe.configure({ mode: "serial" });
const sql = <T = any>(query: string, values: unknown[] = []) => tenant(relay.db.connect, "demo", async (db) => (await db.query<T>(query, values)).rows);
const billing = () => ({ payments: payments.port, prices: PRICES });

test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9209, hostPort: 9210, aiAgent: false, billing: billing() });
  // A card the bank refuses, and the period's invoice issued with it on file.
  await sql(
    "INSERT INTO billing_customers(workspace_id,provider,customer_id,payment_method_id,card_brand,card_last4) VALUES('demo','stand-in','cus_demo','pm_stand_in_0002','visa','0002') ON CONFLICT(workspace_id) DO UPDATE SET payment_method_id='pm_stand_in_0002',card_last4='0002'",
  );
  const anchor = new Date((await sql<{ period_anchor: Date }>("SELECT period_anchor FROM workspace_plans"))[0].period_anchor);
  const issued = await issueDueInvoices(relay.db.connect, "demo", billing(), new Date(periodOf(anchor, new Date()).end.getTime() + 1000));
  invoiceId = issued!.id;
});
test.afterAll(async () => {
  await relay?.close();
});

test("a declined invoice says when Relay will try again, and tells the people who can fix it", async ({ page }) => {
  await expect
    .poll(async () => (await sql<{ status: string; dunning: string }>("SELECT status,dunning FROM invoices WHERE id=$1", [invoiceId]))[0]?.dunning, { timeout: 30000 })
    .toBe("retrying");
  await page.goto(relay.hostOrigin + "/agent#settings/invoices");
  const row = page.getByRole("list", { name: "Invoices" }).getByRole("listitem").first();
  await expect(row).toContainText("The card has insufficient funds.", { timeout: 20000 });
  await expect(row).toContainText(/We'll try again on /);
  // Nothing is paused while Relay is still trying.
  await expect(page.getByRole("alert").filter({ hasText: "Automated sending is paused" })).toHaveCount(0);
  // The billing manager was told, in the app.
  expect((await sql<{ stage: string }>("SELECT stage FROM billing_alerts")).map((r) => r.stage)).toEqual(["failed"]);
  expect((await sql("SELECT 1 FROM notifications WHERE kind='billing_alert'")).length).toBeGreaterThan(0);
});

test("when the tries run out, the page says automated sending is paused, and paying lifts it", async ({ page }) => {
  // The three tries, each on its day: the sweep queues the one that is due and the relay's own
  // worker charges it. The sweep is asked again until that try has been made.
  for (const [i, days] of [2, 4, 8].entries())
    await expect
      .poll(
        async () => {
          await runDunning(relay.db.connect, "demo", new Date(Date.now() + days * DAY));
          return (await sql<{ retries: number }>("SELECT retries FROM invoices WHERE id=$1", [invoiceId]))[0].retries;
        },
        { timeout: 30000 },
      )
      .toBe(i + 1);
  expect((await sql<{ dunning: string }>("SELECT dunning FROM invoices WHERE id=$1", [invoiceId]))[0].dunning).toBe("unpaid");
  expect((await sql<{ stage: string }>("SELECT stage FROM billing_alerts")).map((r) => r.stage).sort()).toEqual(["failed", "last_try", "unpaid"]);

  await page.goto(relay.hostOrigin + "/agent#settings/invoices");
  const paused = page.getByRole("alert").filter({ hasText: "Automated sending is paused" });
  await expect(paused).toBeVisible({ timeout: 20000 });
  await expect(paused).toContainText("Your team's own replies and calls still work.");
  await expect(page.getByRole("list", { name: "Invoices" }).getByRole("listitem").first()).toContainText("Automated sending is paused");

  // A card that works, and "Pay now": the pause lifts.
  payments.state.decline = false;
  await sql("UPDATE billing_customers SET payment_method_id='pm_stand_in_4242',card_last4='4242' WHERE workspace_id='demo'");
  await page.reload();
  await page.getByRole("list", { name: "Invoices" }).getByRole("listitem").first().getByRole("button", { name: "Pay now" }).click();
  await expect
    .poll(async () => (await sql<{ status: string; dunning: string }>("SELECT status,dunning FROM invoices WHERE id=$1", [invoiceId]))[0].status, { timeout: 30000 })
    .toBe("paid");
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Automated sending is paused" })).toHaveCount(0, { timeout: 20000 });
  await expect(page.getByRole("list", { name: "Invoices" }).getByRole("listitem").first()).toContainText("Paid");
});
