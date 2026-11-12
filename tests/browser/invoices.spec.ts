import { test, expect } from "@playwright/test";
import { startLocalRelay } from "../../scripts/local-relay";
import { tenant } from "../../server/db";
import { standInPayments } from "../../server/payments";
import { issueDueInvoices } from "../../server/invoices";
import { periodOf } from "../../lib/seats";
import { settingsMenu } from "./settings-menu";
import type { PriceBook } from "../../lib/invoices";

/**
 * Invoices (phase 16, C10a; docs/SECURITY_STEP20.md), end to end. Happy path: a manager fills in
 * the billing details and adds a card on the provider's page; when the period turns over the
 * invoice is issued from the records, charged to that card, and can be read line by line, down to
 * what each line counted. Failure path: a declined card leaves the invoice due with the reason,
 * trying again is refused again, and an agent can't reach the page or its API.
 *
 * Prices are the test's: the plan policy's are still placeholders, which would leave every invoice
 * unpriced. Payments are the stand-in — no network, no money.
 */
const PRICES: PriceBook = {
  seat: { starter: 2900, pro: 5900, enterprise: 11900 },
  units: { ai_resolutions: 99, ai_resolutions_own_key: 29, emails: 0.4, whatsapp: 5, sms_segments: 2, phone_minutes: 3, outbound_chats: 1, outbound_banners: 0.5, connector_calls: 0.2 },
};
const payments = standInPayments();
let relay: Awaited<ReturnType<typeof startLocalRelay>>;
test.use({ viewport: { width: 1440, height: 1000 } });
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  relay = await startLocalRelay({ apiPort: 9201, hostPort: 9202, aiAgent: false, billing: { payments: payments.port, prices: PRICES } });
});
test.afterAll(async () => {
  await relay?.close();
});
const sql = <T = any>(query: string, values: unknown[] = []) => tenant(relay.db.connect, "demo", async (db) => (await db.query<T>(query, values)).rows);
/** The sweep, run as it would be `skip` periods from now: that period's invoice, issued for real. */
async function issueNext(skip = 1) {
  const anchor = new Date((await sql<{ period_anchor: Date }>("SELECT period_anchor FROM workspace_plans"))[0].period_anchor);
  let at = new Date();
  for (let i = 0; i < skip; i++) at = new Date(periodOf(anchor, at).end.getTime() + 1000);
  return issueDueInvoices(relay.db.connect, "demo", { payments: payments.port, prices: PRICES }, at);
}

test("a manager fills in the billing details and adds a card; the period's invoice is issued, charged and shown line by line", async ({ page }) => {
  await page.goto(relay.hostOrigin + "/agent#settings/invoices");
  await expect(page.getByRole("heading", { name: "Invoices", level: 2 })).toBeVisible({ timeout: 20000 });
  // The upcoming invoice: this workspace's seats, priced.
  const upcoming = page.getByRole("table", { name: "The upcoming invoice" });
  await expect(upcoming).toContainText("full seats for this period");
  await expect(page.getByText("No card on file. Invoices stay due until one is added.")).toBeVisible();

  // The details each invoice is made out to.
  await page.getByLabel("Billing email").fill("pay@acme.test");
  await page.getByLabel("Billed to").fill("Acme Inc");
  await page.getByLabel("Country").fill("GB");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Billing details saved." })).toBeVisible();

  // Adding a card: Relay sends the manager to the provider's page and keeps only what identifies it.
  await page.getByRole("button", { name: "Add a card" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Your card is saved." })).toBeVisible({ timeout: 20000 });
  await expect(page.getByText("VISA ending 4242")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("billing_setup")).toBe(null);

  // The period turns over: the invoice is issued from the records and charged to the card on file.
  const issued = await issueNext();
  expect(issued?.issued).toBe(true);
  await expect
    .poll(async () => (await sql<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [issued!.id]))[0].status, { timeout: 30000 })
    .toBe("paid");
  await page.reload();
  const invoices = page.getByRole("list", { name: "Invoices" });
  const row = invoices.getByRole("listitem").first();
  await expect(row).toContainText(/RLY-\d{4}-\d{6}/);
  await row.getByRole("button", { name: "Open" }).click();
  const lines = page.getByRole("table", { name: /^Invoice RLY-/ });
  await expect(lines).toContainText("full seats for this period");
  // The demo workspace is on Enterprise, so a full seat is $119.
  await expect(lines).toContainText("$119.00", { useInnerText: true });
  await expect(page.getByText("Billed to Acme Inc")).toBeVisible();
  await expect(row).toContainText("Paid");
  // What a line counted, traced back.
  await page.getByRole("button", { name: /^What it counts/ }).first().click();
  await expect(page.getByRole("list", { name: /^What .* counts/ })).toBeVisible();
});

test("a declined card leaves the invoice due with the reason, and an agent can't reach invoices", async ({ page, browser }) => {
  // The card the bank refuses.
  await sql("UPDATE billing_customers SET payment_method_id='pm_stand_in_0002',card_last4='0002' WHERE workspace_id='demo'");
  const issued = await issueNext(2);
  expect(issued?.issued).toBe(true);
  // The sweep charges it, the bank refuses, and the invoice stays due with the reason.
  await expect
    .poll(async () => (await sql<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [issued!.id]))[0].status, { timeout: 30000 })
    .toBe("failed");
  await page.goto(relay.hostOrigin + "/agent#settings/invoices");
  const row = page.getByRole("list", { name: "Invoices" }).getByRole("listitem").first();
  await expect(row).toContainText("The card has insufficient funds.", { timeout: 20000 });
  // Trying again from the page: charged again, and refused again.
  await row.getByRole("button", { name: "Pay now" }).click();
  await expect
    .poll(async () => (await sql<{ attempts: number }>("SELECT attempts FROM invoices WHERE id=$1", [issued!.id]))[0].attempts, { timeout: 20000 })
    .toBeGreaterThan(1);
  expect((await sql<{ status: string }>("SELECT status FROM invoices WHERE id=$1", [issued!.id]))[0].status).toBe("failed");

  // An agent has no Invoices page, and the API refuses them.
  const grace = await (await browser.newContext()).newPage();
  await grace.goto(relay.hostOrigin + "/agent?as=grace#settings");
  await expect(grace.getByRole("navigation", { name: "Settings pages" })).toBeVisible({ timeout: 20000 });
  await expect((await settingsMenu(grace)).getByRole("button", { name: "Invoices" })).toHaveCount(0);
  expect(await grace.evaluate(async () => (await fetch("/api/agent/invoices", { credentials: "same-origin" })).status)).toBe(403);
});
