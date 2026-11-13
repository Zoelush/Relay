# Phase 16, step C10c: dunning

Branch `billing/c10c-dunning`. Plan: `docs/SECURITY_PLAN.md` (decisions 38 and 40). Migration 0101, on top of C10a's invoices and C10b's plan changes. This finishes C10, and with it the scope of phase 16.

## What it does

When a charge is declined, Relay tries again **on day 1, day 3 and day 7** after the first failure. Each try is the same `invoice.charge` job as a manager's "Pay now", so a charge still happens once per job.

If none of them is paid, the workspace is **unpaid**:

- **Automated sending pauses** — Zoe's replies, outbound messages and banners, automated emails, WhatsApp and SMS, and connector calls — exactly as the spend cap already pauses them, because the pause is the same one (`pausedFor`).
- **A team's own replies, calls and the inbox are never paused**, and nothing is hidden or deleted.
- **Paying lifts it at once.**

**Billing managers are told three times**, in the app and by email: at the first failure (with the reason and the date of the next try), when the last try is scheduled ("we'll try one last time on …"), and when the tries run out (what has paused, and that paying lifts it). Each is said once.

**Settings › Billing › Invoices** shows it: an invoice being retried says when the next try is, an unpaid one says sending is paused, and a banner at the top of the page explains what that means and what still works.

## How it works

- **Migration `0101_dunning.sql`:** `invoices` gains `dunning` (`none`, `retrying`, `unpaid`), `next_attempt_at`, `first_failed_at`, `retries` and `unpaid_at` — none of them touched by the frozen trigger, which guards only what an invoice *counted*. `billing_alerts` records each thing a manager was told (unique per invoice and stage, with the words), and `notifications` and `email_alerts` gain the `billing_alert` / `billing` kind beside the usage ones.
- **`server/dunning.ts`:** `afterFailedCharge` (schedule the next try, or go unpaid, and tell), `afterPaidCharge` (stop everything), `runDunning` (the sweep: queue the try whose day has come), `unpaidPause` (why sending is paused) and `dunningText` (the words).
- **`recordCharge`** in `server/invoices.ts` calls into it, so the job and the provider's webhook follow the same path.
- **`pausedFor`** asks `unpaidPause` first, so every automated sender already honours it — the rule that each one asks `pausedFor` is what makes this one change enough.

## Decisions

- **The clock starts at the first failure,** and a manager's own "Pay now" never spends a try or moves the dates: trying by hand is always free.
- **A try is taken off the queue before the job runs** (`next_attempt_at` cleared), so a slow sweep can't start the same try twice.
- **The pause is the spend cap's pause,** not a new kind of switch. One way to be paused, one place to read why, and every sender already asks.
- **Nothing is suspended, downgraded or deleted** for an unpaid invoice. The team keeps working; only what Relay sends on their behalf stops.

## Checks

- **`tests/dunning.test.ts`:** the schedule's arithmetic; the first failure starting it and telling the managers in the app and by email; no pause while Relay is still trying; a try by hand that spends nothing and says nothing new; the sweep taking each try on its day; the last try announced when it is scheduled; running out (unpaid, every sender paused with words it can show); another workspace untouched; the page's banner; paying lifting it at once; and the rollback.
- **`tests/browser/dunning.spec.ts`:** a declined invoice says when Relay will try again and tells the people who can fix it; then the tries run out, the page says automated sending is paused and what still works, and paying with a good card lifts it.
- **Typecheck, eslint, `npm test`, `npm run test:postgres`, `npm run test:e2e`.**

## What's left in C10

Nothing: C10a (invoices and the payment port), C10b (trials, upgrades and downgrades) and C10c (dunning) are done, which completes phase 16's scope (C1 to C10).

**Before launch:** real prices in `lib/plans.ts` (every one is still a placeholder, so invoices are issued unpriced and nothing is ever charged), and a tax provider behind `TaxPort`.
