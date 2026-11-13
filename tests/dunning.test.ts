import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { hashPassword } from "../server/passwords";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { issueInvoice, runInvoiceCharge } from "../server/invoices";
import { nextAttempt, runDunning, RETRY_DAYS, unpaidPause } from "../server/dunning";
import { standInPayments } from "../server/payments";
import { pausedFor } from "../server/limits";
import { periodOf } from "../lib/seats";
import type { Job } from "../server/jobs";
import type { PriceBook } from "../lib/invoices";

/** Dunning (phase 16, C10c; docs/SECURITY_STEP22.md). */
const PRICES: PriceBook = {
  seat: { starter: 2900, pro: 5900, enterprise: 11900 },
  units: { ai_resolutions: 99, ai_resolutions_own_key: 29, emails: 0.4, whatsapp: 5, sms_segments: 2, phone_minutes: 3, outbound_chats: 1, outbound_banners: 0.5, connector_calls: 0.2 },
};
const DAY = 86_400_000;

test("the retry schedule, counted from the first failure", () => {
  const first = new Date("2026-11-13T09:00:00Z");
  assert.deepEqual(RETRY_DAYS, [1, 3, 7]);
  assert.equal(nextAttempt(0, first)?.toISOString(), "2026-11-14T09:00:00.000Z");
  assert.equal(nextAttempt(1, first)?.toISOString(), "2026-11-16T09:00:00.000Z");
  assert.equal(nextAttempt(2, first)?.toISOString(), "2026-11-20T09:00:00.000Z");
  assert.equal(nextAttempt(3, first), null, "three tries, then no more");
});

test("dunning: three more tries, then automated sending pauses until it's paid; managers told three times", async () => {
  const db = await testDatabase();
  const payments = standInPayments({ decline: true });
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
  /** A charge attempt, as the job runs it. */
  const charge = (invoiceId: string, id: string, scheduled = false) =>
    runInvoiceCharge(db.connect, api.billing!, { id, workspace_id: "a", payload: { invoiceId, ...(scheduled ? { scheduled: true } : {}) } } as unknown as Job);
  const state = () => q<{ status: string; dunning: string; retries: number; next_attempt_at: Date | null; attempts: number }>("a", "SELECT status,dunning,retries,next_attempt_at,attempts FROM invoices").then((r) => r[0]);
  const alerts = () => q<{ stage: string }>("a", "SELECT stage FROM billing_alerts ORDER BY created_at,stage").then((r) => r.map((x) => x.stage));
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: api.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
      await q(w, "DELETE FROM calendar_assignments");
    }
    // The owner signs in with a password, so the alert has an address to reach them at.
    const owner = (await q<{ id: string }>("a", "SELECT id FROM teammates WHERE principal_id='owner-a'"))[0].id;
    await q("a", "INSERT INTO teammate_credentials(workspace_id,teammate_id,email,password_hash) VALUES('a',$1,'owner@example.test',$2)", [owner, hashPassword("a long, varied passphrase")]);
    const anchor = new Date(Date.now() - 20 * DAY);
    await q("a", "UPDATE workspace_plans SET plan='pro',period_anchor=$1", [anchor]);
    // The seat ledger is written as teammates join, so the invoice under test is the next
    // period's: its seats are the ones held when that period starts.
    const period = periodOf(anchor, new Date(periodOf(anchor, new Date()).end.getTime() + 1000));
    const invoice = await tenant(db.connect, "a", (x) => issueInvoice(x, "a", period, PRICES));
    assert.equal(invoice.status, "open", "a seat to pay for");
    // A card the bank refuses.
    await q("a", "INSERT INTO billing_customers(workspace_id,provider,customer_id,payment_method_id,card_brand,card_last4) VALUES('a','stand-in','cus_a','pm_stand_in_0002','visa','0002')");

    // The first failure starts the schedule and tells the managers.
    assert.deepEqual((await charge(invoice.id, "job-1")).result, { paid: false, failure: "The card has insufficient funds." });
    const first = await state();
    assert.equal(first.dunning, "retrying");
    assert.equal(first.retries, 0);
    assert.ok(first.next_attempt_at && Math.abs(first.next_attempt_at.getTime() - (Date.now() + DAY)) < 60_000, "tomorrow");
    assert.deepEqual(await alerts(), ["failed"]);
    const told = await q<{ kind: string; excerpt: string }>("a", "SELECT kind,excerpt FROM notifications WHERE kind='billing_alert'");
    assert.equal(told.length, 1, "the owner manages billing");
    assert.match(told[0].excerpt, /wasn't paid: The card has insufficient funds\./);
    assert.equal((await q("a", "SELECT 1 FROM email_alerts WHERE kind='billing'")).length, 1);

    // Sending is not paused while Relay is still trying.
    assert.equal(await tenant(db.connect, "a", (x) => unpaidPause(x, "a")), null);
    assert.equal(await tenant(db.connect, "a", (x) => pausedFor(x, "a", "emails")), null);

    // Trying by hand in between: it reports, but spends no try and moves no date.
    assert.equal((await charge(invoice.id, "job-by-hand")).result.paid, false);
    const unchanged = await state();
    assert.deepEqual([unchanged.retries, unchanged.next_attempt_at?.getTime()], [first.retries, first.next_attempt_at?.getTime()]);
    assert.deepEqual(await alerts(), ["failed"], "and says nothing new");

    // The sweep takes each try when its day comes.
    assert.equal(await runDunning(db.connect, "a", new Date(Date.now() + 12 * 3_600_000)), 0, "not yet");
    assert.equal(await runDunning(db.connect, "a", new Date(Date.now() + 2 * DAY)), 1);
    assert.equal((await q("a", "SELECT 1 FROM jobs WHERE kind='invoice.charge'")).length, 1);
    assert.equal((await state()).next_attempt_at, null, "taken off the queue before the job runs");
    await charge(invoice.id, "job-2", true);
    const second = await state();
    assert.equal(second.retries, 1);
    assert.ok(second.next_attempt_at && Math.abs(second.next_attempt_at.getTime() - (first.next_attempt_at!.getTime() - DAY + 3 * DAY)) < 60_000, "day 3, from the first failure");
    assert.deepEqual(await alerts(), ["failed"], "nothing new to say in the middle");

    // Scheduling the last try says so.
    await runDunning(db.connect, "a", new Date(Date.now() + 4 * DAY));
    await charge(invoice.id, "job-3", true);
    assert.equal((await state()).retries, 2);
    assert.deepEqual((await alerts()).sort(), ["failed", "last_try"]);
    assert.match(
      (await q<{ text: string }>("a", "SELECT text FROM billing_alerts WHERE stage='last_try'"))[0].text,
      /one last time/,
    );

    // It runs out: unpaid, and every automated sender is paused with words it can show.
    await runDunning(db.connect, "a", new Date(Date.now() + 8 * DAY));
    await charge(invoice.id, "job-4", true);
    const out = await state();
    assert.deepEqual([out.dunning, out.retries, out.next_attempt_at], ["unpaid", 3, null]);
    assert.deepEqual((await alerts()).sort(), ["failed", "last_try", "unpaid"]);
    const pause = await tenant(db.connect, "a", (x) => pausedFor(x, "a", "emails"));
    assert.match(pause ?? "", /hasn't been paid\. Automated sending is paused until it's paid\./);
    assert.equal(await runDunning(db.connect, "a", new Date(Date.now() + 30 * DAY)), 0, "no more tries");
    // Another workspace is untouched by it.
    assert.equal(await tenant(db.connect, "b", (x) => pausedFor(x, "b", "emails")), null);
    assert.equal(await tenant(db.connect, "b", (x) => unpaidPause(x, "b")), null);

    // The page says what is happening, and offers the way out.
    const page = await agent("invoices");
    assert.match(page.body.paused, /hasn't been paid/);
    assert.equal(page.body.invoices[0].dunning, "unpaid");

    // Paying lifts it at once.
    payments.state.decline = false;
    await q("a", "UPDATE billing_customers SET payment_method_id='pm_stand_in_4242',card_last4='4242'");
    assert.deepEqual((await charge(invoice.id, "job-5")).result, { paid: true });
    const paid = await state();
    assert.deepEqual([paid.status, paid.dunning, paid.next_attempt_at], ["paid", "none", null]);
    assert.equal(await tenant(db.connect, "a", (x) => pausedFor(x, "a", "emails")), null);
    assert.equal((await agent("invoices")).body.paused, null);
    // What the managers were told stays as the record.
    assert.equal((await alerts()).length, 3);

    // Rollback: no retries and no pausing; nothing a workspace uses stays switched off.
    await q("a", "UPDATE invoices SET status='failed',dunning='unpaid',unpaid_at=now()");
    assert.ok(await tenant(db.connect, "a", (x) => pausedFor(x, "a", "emails")));
    await q("a", "UPDATE invoices SET dunning='none',next_attempt_at=NULL,unpaid_at=NULL,retries=0 WHERE dunning <> 'none'");
    assert.equal(await tenant(db.connect, "a", (x) => pausedFor(x, "a", "emails")), null);
  } finally {
    await db.close();
  }
});
