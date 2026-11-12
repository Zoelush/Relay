# Phase 16, step C10a: invoices and the payment port

Branch `billing/c10a-invoices`. Plan: `docs/SECURITY_PLAN.md` (decision 38). New dependency: `pdf-lib` (the invoice PDF). Behind `billing_v1`, off by default.

## What it does

**Settings › Billing › Invoices** (`billing.manage`, behind `billing_v1`):

- **Payment method:** the card on file — its brand, last four digits and expiry, and nothing else. "Add a card" opens the provider's own page, so card numbers never reach Relay.
- **Billing details:** the email, name, address, country and tax id each invoice is made out to.
- **This period:** what the invoice building towards the next issue date holds, line by line. It isn't saved; it is what issuing now would produce.
- **Invoices:** every invoice issued, newest first, each with its number, period, status and total. Open one to read its lines; open a line to read **what it counted** — every record, with its time, quantity and a link back to its conversation. Each one downloads as a PDF.

**An invoice** is one per billing period, issued at the period's start:

- **seats:** the plan's full seats for the new period, in advance;
- **proration:** full seats added during the last period, each its share of it (from `seatBill`, the seat ledger);
- **usage:** the last period's metered units, one line per meter, read from the meters' own sources;
- **tax:** zero for now, behind `TaxPort`.

**While any price it needs is a placeholder** (every price is, today) an invoice is issued **unpriced**: it records what it counted, shows no amounts, and is never charged.

**Charging:** when an invoice is issued open and a card is on file, an `invoice.charge` job charges the total once. A decline leaves the invoice failed with words the manager can act on ("The card has insufficient funds."), and "Pay now" tries again. Retries and dunning are C10c.

## How it works

- **`db/postgres/0099_invoices.sql`:** `billing_profiles` (the address), `billing_customers` (the provider's customer and what identifies the card), `invoices`, `invoice_lines`, `invoice_line_units` (what each line counted), `payment_events` (each webhook once) and `invoice_number_seq`. Every table is tenant-scoped with RLS; the profile and the card are audited (`billing_profile`, `billing_card`). The application's role needs `USAGE` on the sequence.
  - **Issued is issued:** `invoice_frozen` lets an invoice change only its status and payment (and an unpriced one only become void); `invoice_line_frozen` refuses every change to a line or a unit.
- **`lib/invoices.ts`:** the invoice's own arithmetic and words — the number (`RLY-2026-000123`), a line's amount, money and unit prices (a fraction of a cent reads as `$0.0040`), and what each status is called.
- **`server/invoices.ts`:** `buildInvoice` (what a period's invoice would be, from the records), `issueInvoice` (once per period: unique on its start), `issueDueInvoices` (the sweep), `runInvoiceCharge` (the job), `receivePaymentWebhook`, and the page's `readBilling`, `readInvoice`, `readInvoiceUnits` and `changeBilling`.
- **`server/payments.ts`:** the `PaymentPort`. **Stripe** is a small client over its REST API with no SDK: a customer, a Checkout session in setup mode, the card it saved, a PaymentIntent confirmed off-session (idempotent on its key), and signed webhooks (`t=<seconds>,v1=<hex>` over `<t>.<body>`, within five minutes). A live key is refused unless `RELAY_BILLING_LIVE=true`. **The stand-in** does the same steps with no network and no money; its card ends 4242, or 0002 to be declined.
- **`server/invoice-pdf.ts`:** the invoice as a PDF (pdf-lib), built from the same data the page shows.
- **Routes:** `GET invoices`, `invoice`, `invoice-units`, `invoice-pdf` and `POST invoices` (`billing.manage`), and `/v1/hooks/stripe` for the provider.
- **Wiring:** the sweep calls `issueDueInvoices`; `invoice.charge` is a job in the worker and the local relay. Locally the stand-in provider is used, and `billing_v1` is on.

## Decisions

- **Relay's invoice is the record.** The provider only keeps the card and moves the money. Nothing is ever counted twice: lines are built from the seat ledger and the meters' sources, and frozen with the records they count.
- **A charge is one per job.** The job's id is in the idempotency key, so a retried job can't charge twice, and the result is recorded by whichever arrives first — the charge or the webhook. Paid is never undone.
- **Another workspace's webhook can't touch this one's invoice:** every event is handled in its own workspace's transaction, and each event id is taken once.
- **Prices are still placeholders.** `priceBook()` reads the plan policy, where every price is `null`; tests and the local relay pass their own. Nothing is charged until they are real.
- **Tax is a slot, not a guess:** `TaxPort` returns zero, and the line is always there.

## Checks

- **`tests/invoices.test.ts`:** the arithmetic and the words; an invoice built from two seats, a prorated seat and a net resolution; unpriced without prices; issued once per period; the frozen triggers; the page, the detail, a line's units and the PDF; adding a card, charging once, a retried job, a decline; the webhook (unsigned refused, each event once, another workspace's event ignored); the sweep; isolation; and the rollback (the flag off, the page gone, what was issued still there).
- **`tests/browser/invoices.spec.ts`:** a manager fills in the details, adds a card on the provider's page, and the period's invoice is issued, charged and read line by line; then a declined card leaves it due with the reason, "Pay now" is refused again, and an agent has neither the page nor the API.
- **Typecheck, eslint, `npm test`, `npm run test:postgres`, `npm run test:e2e`.**

## What's next

- **C10b:** trials (14 days of Pro, then Starter), upgrades and downgrades (data kept, new things blocked).
- **C10c:** dunning — retry schedules, reminders and what happens when a card keeps failing.
- **Before launch:** real prices in the plan policy, and a tax provider behind `TaxPort`.
