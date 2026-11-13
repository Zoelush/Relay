# Phase 16, step C10b: trials, upgrades and downgrades

Branch `billing/c10b-plan-changes`. Plan: `docs/SECURITY_PLAN.md` (decisions 38 and 39). Migration 0100, on top of C10a's invoices.

## What it does

**Settings › Billing › Plan** (`billing.manage`) can now change the plan:

- **The trial:** a workspace on Starter that has never had one can start **14 days of Pro**, with no card. The card says how many days are left and when it ends. When it ends the workspace is on Starter again.
- **Upgrading** applies **at once** — the features and limits of the new plan are there immediately — and the difference for the rest of the period appears on the next invoice as **"Upgrade to Pro partway through the last period"**, prorated by the day, per full seat held when it happened.
- **Moving to a smaller plan** waits until the end of the period already paid for: "You move to Starter on 6 December. Your data stays; what the smaller plan doesn't include stops being available to add to." **"Keep Enterprise"** calls it off until the day comes.
- **What has happened:** every change to the plan, newest first, with who made it and when it takes effect.

**Data is kept, new things are blocked.** A smaller plan never deletes anything: the brands, help centers, workflows and the rest stay. What it does is refuse *more* of them (`assertWithinLimit`) and refuse what the plan doesn't include (`assertGate`); security settings already behave this way — changes are refused, what is configured keeps applying.

## How it works

- **Migration `0100_plan_changes.sql`:** `workspace_plans` gains `trial_plan`, `trial_ends_at`, `trial_used`, `pending_plan` and `pending_from` (audited, as the plan is), and `plan_changes` is an append-only ledger of what happened — `trial_started`, `trial_ended`, `upgraded`, `downgrade_scheduled`, `downgrade_cancelled`, `downgraded` — each with the plans, the actor, when it was made and when it takes effect. `invoice_lines.kind` widens to allow `plan_change`.
- **`planInForce` (`server/plans.ts`) decides the plan**, and everything already goes through `planOf`: a running trial's plan, then a scheduled change whose time has come, then the plan itself. The gate is therefore right the moment a trial lapses, without waiting for the sweep.
- **`changePlan`** is the one way the plan changes: `start_trial`, `change` (up or down, decided by rank) and `cancel_change`. An upgrade ends a running trial and calls off a waiting downgrade; a downgrade during a trial is scheduled for the trial's own end date.
- **`applyPlanChanges`** runs in the sweep: it writes the ledger entry for a trial that has run its course or a downgrade whose day has come, and tidies the columns.
- **The invoice** (`server/invoices.ts`) reads the ledger for upgrades inside the period it is billing and adds one `plan_change` line each: `(new seat price − old seat price) × full seats at that moment × the fraction of the period left`, frozen with the change it came from. Like every other line, it is read from what happened, never counted.

## Decisions

- **Upgrades are prorated, downgrades are not.** Someone who upgrades pays for what they get from the day they get it; someone who moves down keeps what they paid for until the period ends, and nothing is refunded.
- **One trial per workspace**, taken by a button, with no card — so a trial can't be restarted by turning it off and on again (`trial_used` stays true even after an upgrade ends the trial early).
- **The ledger, not a counter.** A plan change is a row; the invoice and the page both read it back. `plan_changes` is append-only, exactly as the seat ledger is.
- **Nothing is deleted by a downgrade.** Relay never takes away a workspace's data because of a plan.

## Checks

- **`tests/plan-changes.test.ts`:** the trial (once, the gate following it, the last day, the sweep); upgrades (at once, same-plan and unknown-plan refused, a trial and a waiting downgrade ended by one); downgrades (scheduled for the period's end, in force on time, called off, applied by the sweep); data kept and new things refused; the append-only ledger and the audit entries; who may change the plan; one workspace's changes never touching another's; the prorated `plan_change` invoice line; and the rollback.
- **`tests/browser/plan.spec.ts`:** a manager starts the trial, sees the days left and upgrades for good; then a move to Starter waits for the period's end, is called off, a second trial is refused with the reason, and an agent has neither the page nor the API.
- **Typecheck, eslint, `npm test`, `npm run test:postgres`, `npm run test:e2e`.**

## What's next

- **C10c:** dunning — retry schedules for a failed charge, reminders, and what happens when a card keeps failing.
- **Before launch:** real prices (a trial and an upgrade are priced from the same placeholders today, so an invoice with a plan change is still issued unpriced).
