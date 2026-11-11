# Phase 16, step C9b: limits and the spend cap

Branch `billing/c9b-limits`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decision 35). C9 was split again, as asked: this is C9b. C9c covers alerts (in the app and by email, once per threshold per period). No new dependency.

## What it does

**Settings › Billing › Usage** (for who manages billing) gains:
- **A limit for each meter,** in units per billing period. There are none by default.
- **A spend cap** on metered usage, in dollars per period. Seats aren't included, since they're fixed and known.
  - **Until prices are set,** the cap can be saved but isn't applied (an amount can't be known yet), and the page says so.
  - **Reaching the cap** pauses every automated sender, as if every limit were reached.
- **A Limit column** in the usage table, with **Paused** (and why) on any meter whose automated sends are paused.

Changes are in the audit log ("Usage limit created", "changed", "deleted", and "Spend cap changed").

**Reaching a limit pauses automated sends only, never the product:**

| What | When its limit (or the cap) is reached |
|---|---|
| Zoe (AI resolutions; on a call, phone minutes too) | She doesn't answer. An internal note tells the team why ("Zoe didn't answer: This period's limit for AI resolutions (1) is reached. A teammate needs to reply."), and the conversation is handed to the team, so she stays out of it. |
| Outbound chats and banners | They wait, and the engine tries again later. |
| Zoe's, workflows' and away messages on email, WhatsApp and SMS | They're held until the period ends. Raising or removing the limit sends them straight away. |
| Connector calls by Zoe or a workflow | They're refused with the reason. Refused calls are free. |

Teammates' own replies on every channel, calls and the inbox always keep working, and are still metered.

**Checked exactly at each send:** each automated send reads its meter's total for the period, and the spend when a cap is set. Two sends at the same moment can both pass a limit; that's accepted.

## How it works

**`server/limits.ts`:**
- **`pausedFor(meter)`:** why a meter's automated sends are paused this period, or null. It reads `usage_limits` and the meter's total, and the spend cap against the priced total of every meter.
- **`readLimits` and `changeLimits`:** the page (`billing.manage`). After a change, messages a limit held on a channel that's no longer paused are released.
- **`CHANNEL_METER`:** maps email, WhatsApp and SMS to their meters.

**Where it's asked:**
- **Zoe:** `runAiReply`, before answering (AI resolutions, and phone minutes on a call).
- **Outbound:** `admit`, which returns "later" with the reason.
- **Automated messages:** `runDelivery`, for Zoe's replies, workflow messages and away emails. These are deferred to the period's end with `not_before` and marked `limit_held`. The sweep's existing `releaseDeferred` sends them when due, and clears the mark.
- **Connector calls:** `runConnector`, which refuses Zoe's and workflows' calls; test calls are never stopped.

**Wiring:**
- **The route:** `usage` gains POST (`billing.manage`), and its GET adds `limits`: each meter's limit, the cap, whether the cap applies, the spend so far, and what's paused.
- **The page:** the Usage page's "Limits and spend cap" card.
- **Wording:** each meter has a `noun` for use in a sentence.

**Migration `0095_limits`:**
- **New:** `usage_limits` and `usage_settings` (the spend cap), both audited, and `channel_deliveries.limit_held`.
- **Its rollback** removes every limit and the cap, and releases held messages (due now), which the earlier code's sweep sends.

**Seed data:** none. No limits, no cap.

## Checks

- **`tests/limits.test.ts`:**
  - **Defaults:** nothing is limited.
  - **Setting limits:** billing managers only, whole numbers, and a cap of at least $1. Changes are audited.
  - **Zoe:** with an AI resolutions limit of 1 and one recorded, she doesn't answer. She leaves an internal note (never delivered), no reply, and a "skipped" answer, and the conversation is handed to the team.
  - **Outbound:** a chat waits with the reason, and banners keep their own limit.
  - **Held messages:** with an emails limit of 1 and one sent, a workflow's email is held to the period's end, and a teammate's reply isn't held.
  - **Connector calls:** Zoe's call is refused with the reason.
  - **Phone minutes:** a 120-second call is over a limit of 1. Zoe's check of it on a real call needs the voice channel, so that path isn't tested end to end.
  - **The spend cap:** saved, but not applied while prices are placeholders.
  - **Raising the limits:** the held email is released and queued by the sweep, and the chat is sent.
  - **Another workspace** has its own limits.
  - **Rollback:** limits gone, and held messages released.
- **`tests/browser/limits.spec.ts`:**
  - **Happy path:** with one email sent, a limit of 1 shows Emails sent as Paused, with the reason. Clearing it lifts that, and a $25 cap saves with the note that it isn't applied yet.
  - **Failure path:** a limit of 0 is refused ("A limit is a whole number of emails, at least 1."), and so is a cap of $0.50 ("A spend cap is at least $1.00."). An agent's change is refused (403).
- **`tests/permissions-matrix.test.ts`** covers the route. **`tests/erasure.test.ts`** passes, with both tables listed as holding no one's data.
