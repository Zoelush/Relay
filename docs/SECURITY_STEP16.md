# Phase 16, step C9a: meters and the Usage page

Branch `billing/c9a-meters`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decisions 33 and 34). C9 was split, as asked: this is C9a. C9b covers alerts, limits that pause automated sends, and the spend cap. No new dependency.

## What it does

**Eight meters,** each read from what it counts, for a billing period (monthly, from C8b's period anchor):

| Meter | Read from | Free |
|---|---|---|
| AI resolutions | Zoe's resolution ledger, net: a reversal is −1 in the period it happens | |
| Emails sent | Email deliveries sent, delivered or read | Failed and suppressed |
| WhatsApp messages sent | WhatsApp deliveries sent, delivered or read | Failed and suppressed |
| SMS segments sent | SMS deliveries sent, each counted in segments from its message (the same rule as the composer and the 10-segment limit) | Failed and suppressed |
| Phone minutes | Completed calls, each rounded up to the minute | Calls not answered |
| Outbound chats | Outbound chat entries sent | Held out or suppressed |
| Outbound banners | Outbound banner entries shown | Held out or suppressed |
| Connector calls | Calls by Zoe or a workflow that succeeded | Test calls, and calls refused, invalid, rate-limited or failed |

**Settings › Billing › Usage** (for who manages billing):
- **Each meter:** this period's units, or the last period's, with its price per unit and its amount.
- **The total.**
- **Prices:** every unit price is a placeholder until launch, so amounts show as "Price not set".
- **Tracing:** each meter lists its units, 50 at a time. Each unit shows its time, its quantity and what it was, and links to its conversation (or names its contact, for a banner shown outside one).

## How it works

- **`lib/meters.ts`:** the registry of meters (label, unit, source).
- **`server/meters.ts`:**
  - **One query per meter,** over its source, for a period.
  - **`meterUnits`:** the units in time order, after a cursor.
  - **`meterTotal`:** their total.
  - **`readUsage` and `readUsageUnits`:** the page.
  - **Nothing is written:** a test fails on a write in the module, so meters never count.
- **SMS segments** are counted by `segmentsOf` from each delivered part's text.
- **Unit prices:** `UNIT_PRICES` in `lib/plans.ts` (the plan policy), read through `unitPrices` in `server/plans.ts` (the one gate). They're placeholders, so `check:plans` fails on them once billing is live.
- **Wiring:** the routes `usage` and `usage-units` (GET, `billing.manage`), and the page `agent/settings-usage.tsx` (`#settings/usage`, in Billing).
- **Following a unit:** "Open conversation" uses the inbox's `#conversation/<id>` link (C8b).

**Migration `0094_meters`:** partial indexes for reading each meter by period, on channel deliveries, calls, outbound entries and connector calls. The resolution ledger already had one. Its rollback drops them.

**Seed data:** none.

## Checks

- **`tests/meters.test.ts`:**
  - **No writes:** the meters module only reads, and every meter has a price slot.
  - **One period, every meter:**
    - **AI resolutions:** two resolutions and one reversal in the period, plus a reversal of one from the last period, net 0. The last period counts its one.
    - **Messages:** two emails sent (a failed one is free), one WhatsApp message (a suppressed one is free), and SMS counted in segments (a 200-character text is 2).
    - **Phone minutes:** 3 (61 seconds and 30 seconds; an unanswered call is free).
    - **Outbound:** one chat and one banner (a held-out entry is free).
    - **Connector calls:** two (a test call and a failed one are free).
  - **Prices:** none are set, so there are no amounts.
  - **Tracing:** every unit leads to its conversation or contact, each meter's units add up to its total, and the resolutions are traced one by one, reversals as −1.
  - **Paging:** 57 emails come back as 50 and 7, with none repeated, and an unknown meter is refused.
  - **Access:** billing managers only, and each workspace sees its own usage.
  - **Rollback:** the meters read the same without the indexes.
- **`tests/settings.test.ts`** lists Usage for owners.
- **`tests/browser/usage.spec.ts`:**
  - **Happy path:** Usage shows emails sent with prices not set. Listing them and following one opens its conversation.
  - **Failure path:** an unknown meter is refused ("Choose a meter."), and an agent doesn't see the page (the API answers 403).
- **`tests/permissions-matrix.test.ts`** covers both routes.
