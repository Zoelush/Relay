# Phase 16, step C8a: plans and the one gate

Branch `billing/c8a-plans`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decisions 30 and 31). C8 was split, as asked: this is C8a. C8b covers full and limited seats, their limits, prorated seat changes, and who occupies each. No new dependency.

## What it does

**Three plans: Starter, Pro and Enterprise.** Every workspace, existing or new, is on Enterprise, so nothing it uses switches off. Choosing a plan comes with billing (C10).

| | Starter | Pro | Enterprise |
|---|---|---|---|
| The inbox, messenger, email, tickets, macros, reports, Zoe, the API, data requests, two-factor, the audit log, the health check | Yes | Yes | Yes |
| Workflows; SLAs and office hours; routing, teams and workload; outbound and segments; WhatsApp, SMS, Meta, voice, Slack and Discord; custom roles; Zoe's data connectors | | Yes | Yes |
| Single sign-on; IP allowlists; restricted roles; retention; content redaction; Relay support access | | | Yes |
| Brands | 1 | 3 | Unlimited |
| Help centers | 1 | 3 | Unlimited |

**What a plan's edge looks like:**
- **A product feature beyond the plan is off,** exactly as if its rollout flag were. Its Settings page isn't listed, its routes refuse, and it doesn't run. Workflows don't fire, SLA clocks don't start, and other channels don't receive.
- **A security feature beyond the plan refuses changes,** naming the plan ("Content redaction is on the Enterprise plan."). What's already set keeps applying: an IP allowlist still applies, SSO still signs people in, and redaction rules already on still redact. Security never weakens silently. Revoking Relay support's access is always allowed. What a move to a lower plan does with data over its limits is C10's.
- **Creating a role** is Pro's. **Making a role restricted** is Enterprise's.
- **A brand or help center beyond the plan's number** is refused with the count ("Your plan includes 1 brand, and you have 1. Pro has more.").

**Settings › Billing › Plan** (for who manages billing):
- **The current plan,** and how much of each limit is used.
- **Every plan compared,** feature by feature.
- **Seat prices.** Every price is a placeholder ("Not set yet") until launch.

## How it works

- **`lib/plans.ts` is the plan policy:**
  - **The tiers:** `PLAN_IDS` and `PLANS` (names, summaries, placeholder prices in cents).
  - **The features beyond Starter:** `FEATURES`.
  - **The limits:** `LIMITS`.
  - **The rollout flags each gated feature has:** `FLAG_FEATURE`.
  - **Helpers:** `includes`, `limitOf` and `placeholders`.
- **`server/plans.ts` is the only gate:**
  - **`planOf`, `gate` and `assertGate`:** the last refuses with `PLAN_REQUIRED` (403).
  - **`featureOn` and `flagsOn`:** a rollout flag and the plan together.
  - **`limit` and `assertWithinLimit`:** refused with `PLAN_LIMIT` (403).
  - **`readPlan`:** the page's data.
- **Where it's applied:**
  - **Product features:** every place that read a Pro feature's flag now asks `featureOn`: workflows, SLAs and calendars, routing, outbound, events, segments and subscriptions, data connectors, each channel and `enabledChannels`, Settings' page list, and the public API's workflow routes.
  - **Configuration changes:** `assertGate` guards SSO, IP allowlists, retention policies, redaction rules, support grants, creating a role and restricting one.
  - **Limits:** `assertWithinLimit` guards creating a brand and creating a help center.
- **The route:** `plan` (GET, `billing.manage`). The page is `agent/settings-plan.tsx` (`#settings/plan`), in a new Billing group.
- **Prices:**
  - **`npm run check:plans`** fails while a placeholder remains with `RELAY_BILLING_LIVE=true`. `npm test` does the same.
  - **Not in the build:** it isn't part of `npm run build`, because the build runner is the hosting platform's. Billing's go-live (C10) runs it.

**Migration `0092_plans`:**
- **`workspace_plans`,** audited ("Plan changed"), with every existing workspace set to Enterprise.
- **New workspaces:** `seedFoundation` gives each one a row too.
- **Its rollback** sets every workspace back to Enterprise.

`workspace_plans` holds no one's personal data, so it's listed in `NO_PERSONAL_DATA`.

**Seed data:** every workspace on Enterprise. Prices are placeholders.

## Checks

- **`tests/plans.test.ts`:**
  - **The policy:** each tier includes what's below it, limits grow, and every flag names a real feature. Prices are placeholders until billing goes live, when they must be set.
  - **The one gate:** no file reads `workspace_plans` or imports `lib/plans.ts` but the gate (and the price check), and no file reads a plan-gated flag from `workspace_features` but the gate.
  - **Enterprise:** everything is on, and an allowlist is set.
  - **Starter:**
    - **Product features:** workflows are off, Pro's pages leave Settings (email, the plan, the audit log and the health check stay), Pro's channels aren't listed, and ungated flags are untouched.
    - **Security changes are refused,** each naming its plan: IP allowlists, retention, redaction, support access, SSO, and custom roles (Pro's).
    - **What's set keeps applying:** the earlier allowlist still refuses another network.
    - **Other changes still work,** such as Zoe's model controls.
  - **Limits:** a second brand on Starter is refused with the count. On Pro, a third brand is allowed and a fourth refused, and so is a fourth help center.
  - **Pro:** workflows are on, and a custom role is created, but restricting it is refused (Enterprise's).
  - **The Plan page:** usage, including over a limit (4 of 3), every tier, and prices not set. An agent and another workspace's owner are refused.
  - **Another workspace's** plan is its own, and changes are audited.
  - **Rollback.**
- **`tests/settings.test.ts`** lists the Plan page for owners and not for agents.
- **`tests/browser/plans.spec.ts`:**
  - **Happy path:** Enterprise and the comparison (Workflows not in Starter, in Pro), with prices not set. Moved to Starter, the page says so (Brands 1 of 1), Workflows leaves Settings, and turning on a redaction rule is refused with "Content redaction is on the Enterprise plan." and left off.
  - **Failure path:** on Starter a second brand is refused with the count, and an agent doesn't see the page (the API answers 403).
- **`tests/permissions-matrix.test.ts`** covers the route. **`tests/erasure.test.ts`** passes.
