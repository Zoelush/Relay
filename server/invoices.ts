import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { featureOn, planLabel, planOf, priceBook, seatPrice } from "./plans";
import { meterUnits } from "./meters";
import { enqueueJob, type Job } from "./jobs";
import { periodOf, seatBill, type Period, type SeatChange } from "../lib/seats";
import { METER_IDS, type MeterId } from "../lib/meters";
import { invoiceNumber, lineAmount, usageDescription, type InvoiceStatus, type LineKind, type PriceBook } from "../lib/invoices";
import type { PaymentPort } from "./payments";
import { afterFailedCharge, afterPaidCharge, unpaidPause } from "./dunning";
import { isTest } from "./test-workspace";

/**
 * Invoices (phase 16, step C10a; docs/SECURITY_STEP20.md): Settings › Billing › Invoices
 * (`billing.manage`, behind `billing_v1`), issuing at each period's start (the sweep), charging
 * (the `invoice.charge` job) and the payment provider's webhook.
 *
 * - **Built from records, never counted:** seats from the seat ledger (`seatBill`), usage from the
 *   meters' sources (`meterUnits`). Each line is frozen with what it counts, so a dispute is checked
 *   line by line, and migration 0099's trigger refuses any change to an issued line or unit.
 * - **One invoice per period** (unique on its start): the plan's full seats for the new period in
 *   advance; the last period's prorated seat additions and metered usage; tax (zero, `TaxPort`).
 * - **Unpriced** while a price it needs is a placeholder: no amounts, never charged.
 * - **Charged once per job** (the job's id in the idempotency key, so a retried job can't charge
 *   twice), with the card on file; a decline leaves it `failed`. TODO(phase 16 C10c): retries and
 *   dunning.
 */
export type BillingEnvironment = {
  payments?: PaymentPort;
  /** Tests (and a local relay a test starts): prices in place of the plan policy's placeholders. */
  prices?: PriceBook;
};
export const BILLING_FLAG = "billing_v1";

/** Tax on an invoice. TODO(before launch): a tax provider (such as Stripe Tax) behind this port. */
export type TaxPort = (subtotalCents: number, profile: { country: string; taxId: string }) => number;
const noTax: TaxPort = () => 0;

type UnitRow = { sourceId: string; at: string; quantity: number; conversationId: string | null; contactId: string | null; detail: string };
type Built = {
  period: Period;
  plan: string;
  lines: { kind: LineKind; meter: MeterId | null; description: string; quantity: number; unitCents: number | null; amountCents: number | null; units: UnitRow[] }[];
  priced: boolean;
  subtotalCents: number | null;
  taxCents: number | null;
  totalCents: number | null;
};

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;


/** The invoice for a period: what it would be issued as now (the Upcoming one is this, unsaved). */
export async function buildInvoice(db: Sql, w: string, period: Period, prices: PriceBook = priceBook(), tax: TaxPort = noTax): Promise<Built> {
  const plan = await planOf(db, w);
  const { planName, anchor } = await seatPrice(db, w);
  const seat = prices.seat[plan] ?? null;
  const previous = periodOf(anchor, new Date(period.start.getTime() - 1));
  const hasPrevious = previous.start < period.start;
  const changes = (
    await db.query<{ teammate_id: string; teammate_name: string; from_seat: "full" | "limited" | null; to_seat: "full" | "limited"; at: Date }>(
      "SELECT teammate_id,teammate_name,from_seat,to_seat,at FROM seat_changes WHERE workspace_id=$1 AND at<$2 ORDER BY at,seq",
      [w, period.end],
    )
  ).rows.map((c): SeatChange => ({ teammateId: c.teammate_id, teammateName: c.teammate_name, from: c.from_seat, to: c.to_seat, at: new Date(c.at) }));
  const lines: Built["lines"] = [];

  // The plan's full seats for this period, in advance: who held one at its start.
  const atStart = new Map<string, { name: string; seat: "full" | "limited" }>();
  for (const c of changes) if (c.at <= period.start) atStart.set(c.teammateId, { name: c.teammateName, seat: c.to });
  const full = [...atStart].filter(([, t]) => t.seat === "full");
  lines.push({
    kind: "seats",
    meter: null,
    description: `${planName} plan: full seats for this period`,
    quantity: full.length,
    unitCents: seat,
    amountCents: lineAmount(full.length, seat),
    units: full.map(([id, t]) => ({ sourceId: id, at: period.start.toISOString(), quantity: 1, conversationId: null, contactId: null, detail: t.name })),
  });

  if (hasPrevious) {
    // Full seats added during the last period, each its share of it.
    const bill = seatBill(changes.filter((c) => c.at < previous.end), previous, seat);
    if (bill.prorations.length)
      lines.push({
        kind: "proration",
        meter: null,
        description: "Full seats added during the last period (prorated)",
        quantity: round6(bill.prorations.reduce((s, p) => s + p.fraction, 0)),
        unitCents: seat,
        amountCents: seat === null ? null : bill.prorations.reduce((s, p) => s + (p.amountCents ?? 0), 0),
        units: bill.prorations.map((p) => ({ sourceId: `${p.teammateId}:${p.at}`, at: p.at, quantity: p.fraction, conversationId: null, contactId: null, detail: p.teammateName })),
      });
    // C10b: an upgrade during the last period owes the difference for the rest of it, per full
    // seat held when it happened. Read from the plan ledger, never counted.
    const upgrades = (
      await db.query<{ seq: string; from_plan: string; to_plan: string; effective_at: Date }>(
        "SELECT seq::text,from_plan,to_plan,effective_at FROM plan_changes WHERE workspace_id=$1 AND kind='upgraded' AND effective_at>=$2 AND effective_at<$3 ORDER BY seq",
        [w, previous.start, previous.end],
      )
    ).rows;
    const span = previous.end.getTime() - previous.start.getTime();
    for (const u of upgrades) {
      const at = new Date(u.effective_at);
      const held = new Set<string>();
      for (const c of changes)
        if (c.at <= at) {
          if (c.to === "full") held.add(c.teammateId);
          else held.delete(c.teammateId);
        }
      const fraction = round6(Math.max(0, previous.end.getTime() - at.getTime()) / span);
      const difference =
        prices.seat[u.to_plan as keyof typeof prices.seat] === null || prices.seat[u.from_plan as keyof typeof prices.seat] === null
          ? null
          : prices.seat[u.to_plan as keyof typeof prices.seat]! - prices.seat[u.from_plan as keyof typeof prices.seat]!;
      const quantity = round6(held.size * fraction);
      if (!quantity) continue;
      lines.push({
        kind: "plan_change",
        meter: null,
        description: `Upgrade to ${planLabel(u.to_plan)} partway through the last period`,
        quantity,
        unitCents: difference,
        amountCents: lineAmount(quantity, difference),
        units: [{ sourceId: `plan:${u.seq}`, at: at.toISOString(), quantity: fraction, conversationId: null, contactId: null, detail: `${planLabel(u.from_plan)} to ${planLabel(u.to_plan)}, ${held.size} full ${held.size === 1 ? "seat" : "seats"}` }],
      });
    }
    // The last period's metered usage, every unit read from its source.
    for (const meter of METER_IDS) {
      const units: UnitRow[] = [];
      let after: { at: string; id: string } | null = null;
      for (;;) {
        const page = await meterUnits(db, w, meter, previous, after, 1000);
        for (const u of page.units) units.push({ sourceId: u.id, at: u.at, quantity: u.quantity, conversationId: u.conversationId, contactId: u.contactId, detail: u.detail });
        if (!page.more || !page.units.length) break;
        const last = page.units[page.units.length - 1];
        after = { at: last.at, id: last.id };
      }
      if (!units.length) continue;
      const quantity = round6(units.reduce((s, u) => s + u.quantity, 0));
      const price = prices.units[meter] ?? null;
      lines.push({ kind: "usage", meter, description: usageDescription(meter), quantity, unitCents: price, amountCents: lineAmount(quantity, price), units });
    }
  }
  const priced = lines.every((l) => l.quantity === 0 || l.unitCents !== null);
  const subtotalCents = priced ? lines.reduce((s, l) => s + (l.amountCents ?? 0), 0) : null;
  const profile = (await db.query<{ country: string; tax_id: string }>("SELECT country,tax_id FROM billing_profiles WHERE workspace_id=$1", [w])).rows[0];
  const taxCents = subtotalCents === null ? null : tax(subtotalCents, { country: profile?.country ?? "", taxId: profile?.tax_id ?? "" });
  lines.push({ kind: "tax", meter: null, description: "Tax", quantity: 1, unitCents: taxCents, amountCents: taxCents, units: [] });
  return { period, plan, lines, priced, subtotalCents, taxCents, totalCents: subtotalCents === null || taxCents === null ? null : subtotalCents + taxCents };
}

/** Issues the invoice for the period (once: unique on its start); returns its id and status. */
export async function issueInvoice(db: Sql, w: string, period: Period, prices?: PriceBook, now = new Date()) {
  const existing = (await db.query<{ id: string; status: InvoiceStatus }>("SELECT id,status FROM invoices WHERE workspace_id=$1 AND period_start=$2", [w, period.start])).rows[0];
  if (existing) return { ...existing, issued: false };
  const built = await buildInvoice(db, w, period, prices);
  const id = crypto.randomUUID();
  const n = Number((await db.query<{ n: string }>("SELECT nextval('invoice_number_seq') AS n")).rows[0].n);
  const status: InvoiceStatus = !built.priced ? "unpriced" : (built.totalCents ?? 0) <= 0 ? "paid" : "open";
  await db.query(
    `INSERT INTO invoices(workspace_id,id,number,period_start,period_end,plan,status,subtotal_cents,tax_cents,total_cents,issued_at,paid_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [w, id, invoiceNumber(now.getUTCFullYear(), n), period.start, period.end, built.plan, status, built.subtotalCents, built.taxCents, built.totalCents, now, status === "paid" ? now : null],
  );
  for (const [seq, line] of built.lines.entries()) {
    const lineId = crypto.randomUUID();
    await db.query(
      "INSERT INTO invoice_lines(workspace_id,invoice_id,id,seq,kind,meter,description,quantity,unit_cents,amount_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [w, id, lineId, seq, line.kind, line.meter, line.description, line.quantity, line.unitCents, line.amountCents],
    );
    for (let i = 0; i < line.units.length; i += 500) {
      const chunk = line.units.slice(i, i + 500);
      await db.query(
        `INSERT INTO invoice_line_units(workspace_id,line_id,source_id,at,quantity,conversation_id,contact_id,detail)
         SELECT $1,$2,* FROM unnest($3::text[],$4::timestamptz[],$5::numeric[],$6::text[],$7::text[],$8::text[])`,
        [w, lineId, chunk.map((u) => u.sourceId), chunk.map((u) => u.at), chunk.map((u) => u.quantity), chunk.map((u) => u.conversationId), chunk.map((u) => u.contactId), chunk.map((u) => u.detail)],
      );
    }
  }
  return { id, status, issued: true };
}

/** The sweep: this period's invoice issued when billing is on, and charged once when it's due and a card is on file. */
export async function issueDueInvoices(connect: Connect, w: string, env: BillingEnvironment = {}, now = new Date()) {
  return tenant(connect, w, async (db) => {
    if (!(await featureOn(db, w, BILLING_FLAG))) return null;
    // A test workspace is never invoiced: its seats and usage belong to the workspace it tests.
    if (await isTest(db, w)) return null;
    const { anchor } = await seatPrice(db, w);
    const r = await issueInvoice(db, w, periodOf(anchor, now), env.prices, now);
    if (r.issued && r.status === "open" && (await cardOf(db, w))) await enqueueJob(db, w, "invoice.charge", { invoiceId: r.id }, {});
    return r;
  });
}

async function cardOf(db: Sql, w: string) {
  return (
    (
      await db.query<{ provider: string; customer_id: string; payment_method_id: string | null; card_brand: string | null; card_last4: string | null; card_exp_month: number | null; card_exp_year: number | null }>(
        "SELECT * FROM billing_customers WHERE workspace_id=$1 AND payment_method_id IS NOT NULL",
        [w],
      )
    ).rows[0] ?? null
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Charging                                                                                    */

/** The `invoice.charge` job: one charge for this job (its id in the key), recorded paid or failed. */
export async function runInvoiceCharge(connect: Connect, env: BillingEnvironment, job: Job) {
  const w = job.workspace_id;
  const invoiceId = String(job.payload.invoiceId ?? "");
  const ready = await tenant(connect, w, async (db) => {
    const inv = (await db.query<{ id: string; number: string; status: InvoiceStatus; total_cents: number; currency: string }>("SELECT id,number,status,total_cents,currency FROM invoices WHERE workspace_id=$1 AND id=$2", [w, invoiceId])).rows[0];
    if (!inv || (inv.status !== "open" && inv.status !== "failed")) return { skip: "Nothing to charge." };
    const card = await cardOf(db, w);
    if (!card || !card.payment_method_id) return { skip: "No card on file." };
    return { inv, card };
  });
  if ("skip" in ready) return { done: true, result: { skipped: ready.skip } };
  assert(env.payments, "PAYMENTS_UNAVAILABLE", "Payments aren't set up here.", 503);
  const { inv, card } = ready;
  const r = await env.payments.charge({
    w,
    customerId: card.customer_id,
    paymentMethodId: card.payment_method_id!,
    amountCents: inv.total_cents,
    currency: inv.currency,
    invoiceId: inv.id,
    description: `Relay invoice ${inv.number}`,
    idempotencyKey: `invoice:${inv.id}:job:${job.id}`,
  });
  await tenant(connect, w, (db) => recordCharge(db, w, inv.id, r.status === "succeeded" ? { paid: r.id } : { failed: r.failure, ref: r.id }, job.payload.scheduled === true));
  return { done: true, result: r.status === "succeeded" ? { paid: true } : { paid: false, failure: r.failure } };
}
/**
 * A charge's result, from the job or the webhook (whichever comes first; never un-pays). C10c:
 * what follows — the next try, or the pause — is `server/dunning.ts`.
 */
async function recordCharge(db: Sql, w: string, invoiceId: string, r: { paid: string } | { failed: string; ref: string | null }, scheduled = false) {
  if ("paid" in r) {
    const paid = (
      await db.query("UPDATE invoices SET status='paid',paid_at=now(),payment_ref=$3,failure='',attempts=attempts+1 WHERE workspace_id=$1 AND id=$2 AND status IN ('open','failed') RETURNING id", [w, invoiceId, r.paid])
    ).rows.length;
    if (paid) await afterPaidCharge(db, w, invoiceId);
    return;
  }
  const failed = (
    await db.query("UPDATE invoices SET status='failed',failure=$3,payment_ref=COALESCE($4,payment_ref),attempts=attempts+1 WHERE workspace_id=$1 AND id=$2 AND status IN ('open','failed') RETURNING id", [w, invoiceId, r.failed, r.ref])
  ).rows.length;
  if (failed) await afterFailedCharge(db, w, invoiceId, { scheduled });
}

/** The provider's webhook (`/v1/hooks/stripe`): believed only when signed, each event once. */
export async function receivePaymentWebhook(connect: Connect, env: BillingEnvironment, raw: string, signature: string) {
  if (!env.payments) return { status: 404, body: { error: "Endpoint unavailable." } };
  let event;
  try {
    event = await env.payments.event(raw, signature);
  } catch {
    event = null;
  }
  if (!event) return { status: 400, body: { error: "The signature didn't match." } };
  if (event.type === "ignored") return { status: 200, body: { received: true } };
  const w = event.workspace;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(w)) return { status: 200, body: { received: true } };
  // A card added: read it from the provider (outside any transaction), then keep it.
  if (event.type === "card_added") {
    const customer = await tenant(connect, w, async (db) => (await db.query<{ customer_id: string }>("SELECT customer_id FROM billing_customers WHERE workspace_id=$1", [w])).rows[0]?.customer_id);
    if (!customer) return { status: 200, body: { received: true } };
    const card = await env.payments.cardFrom({ w, customerId: customer, sessionId: event.sessionId });
    await tenant(connect, w, async (db) => {
      if ((await db.query("INSERT INTO payment_events(workspace_id,id,type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id", [w, event.id, event.type])).rows.length) await saveCard(db, w, card);
    });
    return { status: 200, body: { received: true } };
  }
  await tenant(connect, w, async (db) => {
    if (!(await db.query("INSERT INTO payment_events(workspace_id,id,type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id", [w, event.id, event.type])).rows.length) return;
    if (event.type === "charge_succeeded") await recordCharge(db, w, event.invoiceId, { paid: event.paymentId });
    else if (event.type === "charge_failed") await recordCharge(db, w, event.invoiceId, { failed: event.failure, ref: event.paymentId });
  });
  return { status: 200, body: { received: true } };
}
async function saveCard(db: Sql, w: string, card: { paymentMethodId: string; brand: string; last4: string; expMonth: number; expYear: number }) {
  await db.query(
    "UPDATE billing_customers SET payment_method_id=$2,card_brand=$3,card_last4=$4,card_exp_month=$5,card_exp_year=$6,updated_at=now() WHERE workspace_id=$1",
    [w, card.paymentMethodId, card.brand.slice(0, 20), card.last4, card.expMonth, card.expYear],
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Settings › Billing › Invoices                                                               */

async function available(db: Sql, w: string) {
  assert(await featureOn(db, w, BILLING_FLAG), "NOT_FOUND", "Invoices aren't available in this workspace.", 404);
}
type InvoiceRow = { id: string; number: string; period_start: Date; period_end: Date; plan: string; status: InvoiceStatus; currency: string; subtotal_cents: number | null; tax_cents: number | null; total_cents: number | null; issued_at: Date; paid_at: Date | null; failure: string; attempts: number; dunning: "none" | "retrying" | "unpaid"; next_attempt_at: Date | null };
const invoiceOut = (r: InvoiceRow) => ({
  id: r.id,
  number: r.number,
  period: { start: new Date(r.period_start).toISOString(), end: new Date(r.period_end).toISOString() },
  plan: r.plan,
  status: r.status,
  currency: r.currency,
  subtotalCents: r.subtotal_cents,
  taxCents: r.tax_cents,
  totalCents: r.total_cents,
  issuedAt: new Date(r.issued_at).toISOString(),
  paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
  failure: r.failure,
  // C10c: where it is in its retries, and when the next one is due.
  dunning: r.dunning,
  nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at).toISOString() : null,
});
const PROFILE_FIELDS = ["email", "name", "address_line1", "address_line2", "city", "postal_code", "country", "tax_id"] as const;
const camel = (f: string) => f.replace(/_(.)/g, (_, c: string) => c.toUpperCase());

/** The page: billing details, the card, the upcoming invoice (unsaved), and every invoice issued. */
export async function readBilling(db: Sql, w: string, principal: string, env: BillingEnvironment = {}, now = new Date()) {
  await authorize(db, w, principal, "billing.manage");
  await available(db, w);
  const profile = (await db.query<Record<string, string>>("SELECT * FROM billing_profiles WHERE workspace_id=$1", [w])).rows[0];
  const card = await cardOf(db, w);
  const { anchor } = await seatPrice(db, w);
  const current = periodOf(anchor, now);
  const upcoming = await buildInvoice(db, w, periodOf(anchor, current.end), env.prices);
  return {
    profile: Object.fromEntries(PROFILE_FIELDS.map((f) => [camel(f), profile?.[f] ?? ""])),
    card: card ? { brand: card.card_brand, last4: card.card_last4, expMonth: card.card_exp_month, expYear: card.card_exp_year } : null,
    payments: env.payments?.provider ?? null,
    // C10c: why automated sending is paused, when an invoice has gone unpaid.
    paused: await unpaidPause(db, w),
    upcoming: {
      period: { start: upcoming.period.start.toISOString(), end: upcoming.period.end.toISOString() },
      priced: upcoming.priced,
      totalCents: upcoming.totalCents,
      lines: upcoming.lines.map((l) => ({ kind: l.kind, description: l.description, quantity: l.quantity, unitCents: l.unitCents, amountCents: l.amountCents })),
    },
    invoices: (await db.query<InvoiceRow>("SELECT * FROM invoices WHERE workspace_id=$1 ORDER BY period_start DESC LIMIT 60", [w])).rows.map(invoiceOut),
  };
}

/** One invoice and its lines (each with how many units it froze). */
export async function readInvoice(db: Sql, w: string, principal: string, id: string) {
  await authorize(db, w, principal, "billing.manage");
  await available(db, w);
  const inv = (await db.query<InvoiceRow>("SELECT * FROM invoices WHERE workspace_id=$1 AND id=$2", [w, id])).rows[0];
  assert(inv, "NOT_FOUND", "That invoice isn't in this workspace.", 404);
  const lines = (
    await db.query<{ id: string; kind: LineKind; meter: string | null; description: string; quantity: string; unit_cents: string | null; amount_cents: number | null; units: string }>(
      `SELECT l.id,l.kind,l.meter,l.description,l.quantity,l.unit_cents,l.amount_cents,
         (SELECT count(*) FROM invoice_line_units u WHERE u.workspace_id=l.workspace_id AND u.line_id=l.id) AS units
       FROM invoice_lines l WHERE l.workspace_id=$1 AND l.invoice_id=$2 ORDER BY l.seq`,
      [w, id],
    )
  ).rows;
  const profile = (await db.query<Record<string, string>>("SELECT * FROM billing_profiles WHERE workspace_id=$1", [w])).rows[0];
  return {
    invoice: invoiceOut(inv!),
    lines: lines.map((l) => ({
      id: l.id,
      kind: l.kind,
      meter: l.meter,
      description: l.description,
      quantity: Number(l.quantity),
      unitCents: l.unit_cents === null ? null : Number(l.unit_cents),
      amountCents: l.amount_cents,
      units: Number(l.units),
    })),
    billTo: Object.fromEntries(PROFILE_FIELDS.map((f) => [camel(f), profile?.[f] ?? ""])) as Record<string, string>,
  };
}

/** A line's frozen units, 50 at a time (each traced to its conversation or contact). */
export async function readInvoiceUnits(db: Sql, w: string, principal: string, q: URLSearchParams) {
  await authorize(db, w, principal, "billing.manage");
  await available(db, w);
  const line = q.get("line") ?? "";
  const cursor = q.get("cursor");
  let after: [string, string] | null = null;
  if (cursor) {
    const [at, id] = cursor.split("|");
    if (!at || !id || Number.isNaN(Date.parse(at))) throw new DomainError("INVALID_FIELD", "That page isn't valid.", 400);
    after = [at, id];
  }
  const rows = (
    await db.query<{ source_id: string; at: Date; quantity: string; conversation_id: string | null; contact_id: string | null; detail: string }>(
      `SELECT source_id,at,quantity,conversation_id,contact_id,detail FROM invoice_line_units WHERE workspace_id=$1 AND line_id=$2
       ${after ? "AND (at,source_id)>($3::timestamptz,$4)" : ""} ORDER BY at,source_id LIMIT 51`,
      after ? [w, line, after[0], after[1]] : [w, line],
    )
  ).rows;
  const page = rows.slice(0, 50).map((u) => ({ id: u.source_id, at: new Date(u.at).toISOString(), quantity: Number(u.quantity), conversationId: u.conversation_id, contactId: u.contact_id, detail: u.detail }));
  return { units: page, next: rows.length > 50 ? `${page[49].at}|${page[49].id}` : null };
}

/** Billing details, adding a card (and finishing), and paying an invoice now. */
export async function changeBilling(db: Sql, w: string, principal: string, p: Record<string, unknown>, env: BillingEnvironment, origin: string | null) {
  const me = await authorize(db, w, principal, "billing.manage");
  await available(db, w);
  if (p.action === "profile") {
    const v = (k: string, max: number) => {
      const x = typeof p[k] === "string" ? (p[k] as string).trim() : "";
      if (x.length > max || /[\r\n\x00]/.test(x)) throw new DomainError("INVALID_FIELD", "Keep each field on one line and shorter.", 400, { field: k });
      return x;
    };
    const email = v("email", 254);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DomainError("INVALID_FIELD", "Enter an email address for invoices.", 400, { field: "email" });
    const country = v("country", 2).toUpperCase();
    if (country && !/^[A-Z]{2}$/.test(country)) throw new DomainError("INVALID_FIELD", "Use the country's two-letter code, such as GB or US.", 400, { field: "country" });
    const values = [email, v("name", 200), v("addressLine1", 200), v("addressLine2", 200), v("city", 100), v("postalCode", 20), country, v("taxId", 40)];
    await db.query(
      `INSERT INTO billing_profiles(workspace_id,${PROFILE_FIELDS.join(",")},updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(workspace_id) DO UPDATE SET ${PROFILE_FIELDS.map((f) => `${f}=EXCLUDED.${f}`).join(",")},updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [w, ...values, me.id],
    );
    return readBilling(db, w, principal, env);
  }
  if (p.action === "card") {
    assert(env.payments, "PAYMENTS_UNAVAILABLE", "Payments aren't set up here.", 503);
    assert(origin && /^https?:\/\/[^/]+$/.test(origin), "INVALID_ORIGIN", "Open Relay in your browser to add a card.", 400);
    let customer = (await db.query<{ customer_id: string; provider: string }>("SELECT customer_id,provider FROM billing_customers WHERE workspace_id=$1", [w])).rows[0];
    if (!customer || customer.provider !== env.payments.provider) {
      const profile = (await db.query<{ email: string; name: string }>("SELECT email,name FROM billing_profiles WHERE workspace_id=$1", [w])).rows[0];
      const id = await env.payments.customer(w, { email: profile?.email ?? "", name: profile?.name ?? "" });
      await db.query(
        `INSERT INTO billing_customers(workspace_id,provider,customer_id) VALUES($1,$2,$3)
         ON CONFLICT(workspace_id) DO UPDATE SET provider=EXCLUDED.provider,customer_id=EXCLUDED.customer_id,payment_method_id=NULL,card_brand=NULL,card_last4=NULL,card_exp_month=NULL,card_exp_year=NULL,updated_at=now()`,
        [w, env.payments.provider, id],
      );
      customer = { customer_id: id, provider: env.payments.provider };
    }
    const back = `${origin}/agent?billing_setup={CHECKOUT_SESSION_ID}#settings/invoices`;
    const session = await env.payments.setupSession({ w, customerId: customer.customer_id, returnUrl: back, cancelUrl: `${origin}/agent#settings/invoices` });
    return { url: session.url };
  }
  if (p.action === "card_done") {
    assert(env.payments, "PAYMENTS_UNAVAILABLE", "Payments aren't set up here.", 503);
    const customer = (await db.query<{ customer_id: string }>("SELECT customer_id FROM billing_customers WHERE workspace_id=$1", [w])).rows[0];
    assert(customer, "CARD_NOT_ADDED", "Start adding a card from this page.", 409);
    const card = await env.payments.cardFrom({ w, customerId: customer!.customer_id, sessionId: String(p.session ?? "") });
    await saveCard(db, w, card);
    return readBilling(db, w, principal, env);
  }
  if (p.action === "pay") {
    const inv = (await db.query<{ status: InvoiceStatus }>("SELECT status FROM invoices WHERE workspace_id=$1 AND id=$2", [w, String(p.id ?? "")])).rows[0];
    assert(inv, "NOT_FOUND", "That invoice isn't in this workspace.", 404);
    if (inv!.status !== "open" && inv!.status !== "failed") throw new DomainError("NOTHING_TO_PAY", inv!.status === "unpriced" ? "This invoice isn't priced yet, so there's nothing to pay." : "This invoice is already settled.", 409);
    assert(await cardOf(db, w), "NO_CARD", "Add a card first.", 409);
    return { jobId: await enqueueJob(db, w, "invoice.charge", { invoiceId: String(p.id) }, { teammateId: me.id }) };
  }
  throw new DomainError("INVALID_FIELD", "Unknown billing change.", 400);
}
