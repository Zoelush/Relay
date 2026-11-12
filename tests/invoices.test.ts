import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { buildInvoice, issueDueInvoices, issueInvoice, receivePaymentWebhook, runInvoiceCharge } from "../server/invoices";
import { standInPayments, stripeSigned } from "../server/payments";
import { invoiceNumber, lineAmount, money, unitPrice } from "../lib/invoices";
import { periodOf } from "../lib/seats";
import type { Job } from "../server/jobs";
import type { PriceBook } from "../lib/invoices";

/** Invoices and the payment port (phase 16, C10a; docs/SECURITY_STEP20.md). */
const PRICES: PriceBook = {
  seat: { starter: 2900, pro: 5900, enterprise: 11900 },
  units: {
    ai_resolutions: 99,
    ai_resolutions_own_key: 29,
    emails: 0.4,
    whatsapp: 5,
    sms_segments: 2,
    phone_minutes: 3,
    outbound_chats: 1,
    outbound_banners: 0.5,
    connector_calls: 0.2,
  },
};

test("an invoice's own arithmetic and words", () => {
  assert.equal(invoiceNumber(2026, 123), "RLY-2026-000123");
  assert.equal(invoiceNumber(2027, 1_234_567), "RLY-2027-1234567");
  assert.equal(lineAmount(3, 2900), 8700);
  assert.equal(lineAmount(1234, 0.4), 494, "fractions of a cent per unit, rounded once at the line");
  assert.equal(lineAmount(5, null), null, "no price, no amount");
  assert.equal(money(8700), "$87.00");
  assert.equal(money(-500), "−$5.00");
  assert.equal(money(null), "Price not set");
  assert.equal(money(8700, "eur"), "EUR 87.00");
  assert.equal(unitPrice(2900), "$29.00");
  assert.equal(unitPrice(0.4), "$0.0040", "a fraction of a cent, shown as one");
});

test("invoices: built from the records, issued once per period, frozen, charged once, and the provider's webhook", async () => {
  const db = await testDatabase();
  const payments = standInPayments();
  const api: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    storageTransport: "local-pglite",
    billing: { payments: payments.port, prices: PRICES },
  };
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const agent = async (path: string, data?: unknown, principal = "owner-a", w = "a") => {
    const r = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: { origin: "https://app.test", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      principal,
      { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: w, RELAY_BRIDGE_SECRET: api.bridgeSecret },
      (x) => handleApi(x, api),
    );
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: api.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
      await q(w, "DELETE FROM calendar_assignments");
    }
    // The seat ledger is append-only, so the periods move, not the records: the workspace's seats
    // and usage happen in one period, and the invoice we build is the next one's.
    const anchor = new Date(Date.now() - 20 * 86_400_000);
    await q("a", "UPDATE workspace_plans SET plan='pro',period_anchor=$1", [anchor]);
    // A second full seat, taken (like the owner's) two thirds of the way through that period.
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");
    const previous = periodOf(anchor, new Date());
    const current = periodOf(anchor, new Date(previous.end.getTime() + 1000));
    const lastPeriod = new Date();
    // Usage in that period: two AI resolutions, one of them reversed, so one is billed.
    const conversation = await tenant(db.connect, "a", async (x) => {
      const who = await getIdentity(x, "a", "user", "ada", { name: "Ada", email: "ada@customer.example" });
      return (await command(x, "a", { type: "contact", identityId: who.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text: "Hello" } as unknown as Parameters<typeof command>[4])) as {
        conversationId: string;
      };
    });
    await q("a", "INSERT INTO ai_agents(workspace_id,id,name) VALUES('a','default','Zoe') ON CONFLICT DO NOTHING");
    const resolution = (id: string, at: Date) =>
      q("a", "INSERT INTO ai_resolutions(workspace_id,id,kind,conversation_id,agent_id,rule,window_hours,recorded_at) VALUES('a',$1,'resolution',$2,'default','confirmed',24,$3)", [id, conversation.conversationId, at]);
    await resolution("r1", lastPeriod);
    await resolution("r2", new Date(lastPeriod.getTime() - 1000));
    await q("a", "INSERT INTO ai_resolutions(workspace_id,id,kind,resolution_id,conversation_id,agent_id,rule,window_hours,recorded_at) VALUES('a','r2x','reversal','r2',$1,'default','handed_over',24,$2)", [
      conversation.conversationId,
      new Date(lastPeriod.getTime() - 500),
    ]);

    // What the invoice would be: two full seats now, one prorated seat and one resolution from last period.
    const built = await tenant(db.connect, "a", (x) => buildInvoice(x, "a", current, PRICES));
    const kinds = Object.fromEntries(built.lines.map((l) => [l.kind, l]));
    assert.equal(kinds.seats.quantity, 2, "both full seats at the period's start");
    assert.equal(kinds.seats.amountCents, 11800, "two Pro seats at $59");
    assert.ok(kinds.proration.quantity > 0.5 && kinds.proration.quantity < 0.8, JSON.stringify(kinds.proration));
    assert.equal(kinds.proration.units.length, 2, "both seats, each with its share of the last period");
    assert.equal(kinds.usage.meter, "ai_resolutions");
    assert.equal(kinds.usage.quantity, 1, "net of the reversal");
    assert.equal(kinds.usage.amountCents, 99);
    assert.equal(kinds.tax.amountCents, 0, "no tax provider yet");
    assert.equal(built.priced, true);
    assert.equal(built.totalCents, 11800 + (kinds.proration.amountCents ?? 0) + 99);
    assert.equal(kinds.usage.units.length, 3, "frozen with all three records: two resolutions and the reversal");

    // Without prices, it is issued unpriced: quantities and no amounts, never charged.
    const unpriced = await tenant(db.connect, "a", (x) => buildInvoice(x, "a", current));
    assert.equal(unpriced.priced, false);
    assert.equal(unpriced.totalCents, null);
    assert.equal(unpriced.lines.find((l) => l.kind === "seats")!.quantity, 2, "it still records what it counted");

    // Issued once per period, with a number of its own.
    const first = await tenant(db.connect, "a", (x) => issueInvoice(x, "a", current, PRICES));
    assert.deepEqual([first.issued, first.status], [true, "open"]);
    const again = await tenant(db.connect, "a", (x) => issueInvoice(x, "a", current, PRICES));
    assert.deepEqual([again.issued, again.id], [false, first.id]);
    const row = (await q<{ number: string; total_cents: number; status: string }>("a", "SELECT number,total_cents,status FROM invoices"))[0];
    assert.match(row.number, /^RLY-\d{4}-\d{6}$/);
    assert.equal(row.total_cents, built.totalCents);
    // Issued is issued: lines and units never change.
    await assert.rejects(q("a", "UPDATE invoice_lines SET amount_cents=1"), /append-only/);
    await assert.rejects(q("a", "DELETE FROM invoice_line_units"), /append-only/);
    await assert.rejects(q("a", "UPDATE invoices SET total_cents=1"), /append-only/);

    // The page: the card, the billing details, the upcoming invoice and the one issued.
    const billing = await agent("invoices");
    assert.equal(billing.status, 200, JSON.stringify(billing.body));
    assert.equal(billing.body.card, null);
    assert.equal(billing.body.payments, "stand-in");
    assert.equal(billing.body.invoices.length, 1);
    assert.equal(billing.body.invoices[0].number, row.number);
    assert.ok(billing.body.upcoming.lines.length >= 1, "the next period's invoice, unsaved");
    const details = await agent("invoices", { action: "profile", email: "pay@acme.test", name: "Acme Inc", country: "gb", taxId: "GB123" });
    assert.equal(details.status, 200, JSON.stringify(details.body));
    assert.equal(details.body.profile.country, "GB", "the country is kept as two capitals");
    assert.equal((await agent("invoices", { action: "profile", email: "not an email" })).body.error.code, "INVALID_FIELD");

    // One invoice, line by line, and a line's frozen units traced to their conversation.
    const detail = await agent("invoice?id=" + first.id);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.deepEqual(
      detail.body.lines.map((l: any) => l.kind),
      ["seats", "proration", "usage", "tax"],
    );
    assert.equal(detail.body.billTo.name, "Acme Inc");
    const usageLine = detail.body.lines.find((l: any) => l.kind === "usage");
    assert.equal(usageLine.units, 3);
    const units = await agent("invoice-units?line=" + usageLine.id);
    assert.equal(units.body.units[0].conversationId, conversation.conversationId);

    // The PDF: a real one, named after the invoice.
    const pdf = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/invoice-pdf?id=" + first.id, { headers: { origin: "https://app.test" } }),
      "owner-a",
      { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: "a", RELAY_BRIDGE_SECRET: api.bridgeSecret },
      (x) => handleApi(x, api),
    );
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.match(pdf.headers.get("content-disposition") ?? "", new RegExp(`filename="${row.number}.pdf"`));
    assert.match(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 8)), /^%PDF-/);

    // Paying needs a card.
    assert.equal((await agent("invoices", { action: "pay", id: first.id })).body.error.code, "NO_CARD");
    // Adding one: the provider's own page, then the card it saved (its number never reaches Relay).
    const session = await agent("invoices", { action: "card" });
    assert.match(session.body.url, /^https:\/\/app\.test\/agent\?billing_setup=cs_stand_in_/);
    const sessionId = new URL(session.body.url).searchParams.get("billing_setup")!;
    const saved = await agent("invoices", { action: "card_done", session: sessionId });
    assert.deepEqual([saved.body.card.brand, saved.body.card.last4], ["visa", "4242"]);
    assert.equal((await q("a", "SELECT 1 FROM audit_events WHERE action='billing_card.changed'")).length, 1, "a card change is audited");

    // Charging: one charge per job, recorded paid; a retried job charges once.
    const job = { id: "job-1", workspace_id: "a", payload: { invoiceId: first.id } } as unknown as Job;
    assert.deepEqual((await runInvoiceCharge(db.connect, api.billing!, job)).result, { paid: true });
    assert.equal((await q<{ status: string; payment_ref: string }>("a", "SELECT status,payment_ref FROM invoices"))[0].status, "paid");
    assert.deepEqual((await runInvoiceCharge(db.connect, api.billing!, job)).result, { skipped: "Nothing to charge." });
    assert.equal(payments.charges.length, 1, "charged once");
    assert.equal((await agent("invoices", { action: "pay", id: first.id })).body.error.code, "NOTHING_TO_PAY");

    // A declined card: the invoice is left failed, with words a person can act on.
    const second = periodOf(anchor, new Date(current.end.getTime() + 1000));
    const next = await tenant(db.connect, "a", (x) => issueInvoice(x, "a", second, PRICES));
    payments.state.decline = true;
    await q("a", "UPDATE billing_customers SET payment_method_id='pm_stand_in_0002',card_last4='0002'");
    const declined = await runInvoiceCharge(db.connect, api.billing!, { id: "job-2", workspace_id: "a", payload: { invoiceId: next.id } } as unknown as Job);
    assert.deepEqual(declined.result, { paid: false, failure: "The card has insufficient funds." });
    const failed = (await q<{ status: string; failure: string; attempts: number }>("a", "SELECT status,failure,attempts FROM invoices WHERE id=$1", [next.id]))[0];
    assert.deepEqual([failed.status, failed.failure, failed.attempts], ["failed", "The card has insufficient funds.", 1]);

    // The provider's webhook: only when signed, and each event once.
    const event = JSON.stringify({ id: "evt_1", type: "charge_succeeded", workspace: "a", invoiceId: next.id, paymentId: "pi_webhook" });
    const hook = (raw: string, signature: string) => receivePaymentWebhook(db.connect, api.billing!, raw, signature);
    assert.equal((await hook(event, "t=1,v1=nope")).status, 400);
    assert.equal((await q<{ status: string }>("a", "SELECT status FROM invoices WHERE id=$1", [next.id]))[0].status, "failed", "an unsigned event changes nothing");
    const signature = await payments.sign(event);
    assert.ok(await stripeSigned(event, signature, "whsec_stand_in"), "signed as Stripe signs");
    assert.equal((await hook(event, signature)).status, 200);
    assert.equal((await q<{ status: string; payment_ref: string }>("a", "SELECT status,payment_ref FROM invoices WHERE id=$1", [next.id]))[0].status, "paid");
    assert.equal((await hook(event, signature)).status, 200);
    assert.equal((await q("a", "SELECT 1 FROM payment_events")).length, 1, "the same event is taken once");

    // The sweep: this period's invoice, issued once, and charged when a card is on file.
    payments.state.decline = false;
    await q("a", "UPDATE billing_customers SET payment_method_id='pm_stand_in_4242',card_last4='4242'");
    const swept = await issueDueInvoices(db.connect, "a", api.billing!, new Date(second.end.getTime() + 1000));
    assert.equal(swept?.issued, true);
    assert.equal((await issueDueInvoices(db.connect, "a", api.billing!, new Date(second.end.getTime() + 2000)))?.issued, false);
    assert.equal((await q("a", "SELECT 1 FROM jobs WHERE kind='invoice.charge'")).length, 1, "the charge is a job");

    // Another workspace sees none of it, and its own page is empty.
    assert.equal((await agent("invoice?id=" + first.id, undefined, "owner-b", "b")).status, 404);
    assert.deepEqual((await agent("invoices", undefined, "owner-b", "b")).body.invoices, []);
    const across = await receivePaymentWebhook(db.connect, api.billing!, JSON.stringify({ id: "evt_2", type: "charge_succeeded", workspace: "b", invoiceId: first.id, paymentId: "pi_x" }), await payments.sign(JSON.stringify({ id: "evt_2", type: "charge_succeeded", workspace: "b", invoiceId: first.id, paymentId: "pi_x" })));
    assert.equal(across.status, 200);
    assert.equal((await q<{ status: string }>("a", "SELECT status FROM invoices WHERE id=$1", [first.id]))[0].status, "paid", "another workspace's event can't touch this invoice");

    // Rollback: the flag off, and the page is gone (what was issued stays as the record).
    await q("a", "UPDATE workspace_features SET enabled=false WHERE name='billing_v1'");
    assert.equal((await agent("invoices")).status, 404);
    assert.equal((await agent("invoice?id=" + first.id)).status, 404);
    assert.equal((await agent("settings?section=overview")).body.pages.includes("invoices"), false);
    assert.equal(await issueDueInvoices(db.connect, "a", api.billing!, new Date()), null, "nothing is issued while it is off");
    assert.equal((await q("a", "SELECT 1 FROM invoices")).length, 3, "the invoices issued are still there");
  } finally {
    await db.close();
  }
});
