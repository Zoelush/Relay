# Tickets and SLAs — step B2 handoff (SLAs)

Step B2 is the fourth step of phase 05 in `docs/TICKETS_PLAN.md`. The B1 handoff (business-time engine) is `docs/TICKETS_STEP3.md`. Step C, the customer portal, is next.

Decisions approved on 30 September 2026:

- **Which clocks apply:** first response, next response and time to close for any matched conversation; time to resolve for tickets only.
- **Policy changes mid-clock:** a new policy keeps the time already used and applies its own targets.
- **"Waiting on the customer":** a ticket in a waiting-on-customer state; for other conversations, while the last message is a teammate's.
- **Policies are managed through the API only.** The inbox shows SLAs either way.

## 1. What changed

**Migration 0025 (`db/postgres/0025_sla.sql`):**

- **`sla_policies`:** name, order, conditions (the saved-view filter language), targets in milliseconds, business hours or all hours, pause rules, enabled and version.
- **`sla_clocks`:** one row per conversation, clock and next-response cycle. Each row holds its events, state, time used, due time, breach time, and the policy and calendar versions it used.
- **New conversation columns:** `sla_policy_id`, `sla_next_due_at` (when the timer wakes), `sla_sort_at`, `sla_overdue` and `sla_breached`.
- **A new sort key** on view members, `inbox_filter_members.sla_sort_at`.

The rollback turns `sla_v1` off and drops nothing.

**The clocks (`server/sla.ts`).** `syncSla` recomputes a conversation's clocks from its own timeline every time, so running it again is always safe. It uses customer messages, teammate replies, state changes, and ticket creation, state and type events. B1's `clock()` does the maths.

- **First response:** from creation (the customer's first message) to the first teammate reply.
- **Next response:** from each customer message after a teammate reply to the next reply. Each cycle is a separate clock; the sidebar shows the latest and any earlier breach.
- **Time to close:** runs while the conversation isn't closed. Reopening continues from the time used.
- **Time to resolve** (tickets only): runs while the ticket's state isn't resolved.
- **Pauses:** while snoozed, and while waiting on the customer, if the policy says so. The "while in an automation" rule is stored and validated but nothing turns it on yet (TODO for phase 11).
- **Choosing a policy:** the first enabled policy, in order, whose conditions match. Internal (back-office and tracker) and merged conversations get none. When the matching policy changes, the time already used stays and the new targets apply; clocks the new policy has no target for become inactive, and their breaches stay.
- **Calendars:** a clock pins the calendar that applies (team, then brand, then workspace, then 24/7) the first time it's measured in business hours, and keeps it.
- **When it runs:** after every command except read, note and rating (including the early-return paths for replies and merges), after a snooze wakes, from the breach timer, and when a policy is saved (the `sla.reevaluate` job, 100 conversations per step).
- **Breach, recorded once and never cleared:** an internal `sla_breached` timeline event ("First response SLA breached (Urgent)"), and an `sla.breached` outbox event for phase 11's workflows (they stay unpublished until phase 11 adds a consumer; TODO). The conversation's `sla_breached` flag stays set, and `sla_overdue` is set while a breached clock keeps running.
- **Timers:** the Worker's per-conversation Durable Object now holds both the snooze and the SLA due time on its one alarm, and the sweep also picks up SLAs due within a minute. The local relay checks every second.
- **A precision fix:** the local database driver returns timestamps as `Date` objects, and `Date.parse` on a `Date` drops the milliseconds, so times are read with a helper that handles both forms.

**Policies API (behind `sla_v1`):**

- `GET /v1/agent/sla-policies` lists policies.
- `POST /v1/agent/sla-policies` (`op: "save"` or `"archive"`, needs `workspace.manage`) is validated whole: at least one target, each between one second and a year, known pause rules, valid conditions, and the version the editor started from. Saving queues a re-evaluation.

**Views:**

- **Filters:** `sla` (overdue or breached) and `ticket_type`.
- **"SLA due soonest" sort:** running clocks by due time (overdue ones first), then paused clocks by time left, then conversations with no SLA.
- **Row data:** rows carry `sla_next_due_at` and `sla_overdue`.

**UI:**

- **Sidebar SLA section:** the policy and its hours, and each clock:
  - "Due Tue 13:00 · in 1h 42m" (amber under 15 minutes)
  - "Overdue by 5m" (red)
  - "Paused · 35m left" (grey)
  - "Met" or "Breached" once stopped
- **Countdowns** use the server's clock offset, and the sidebar now reloads on any new timeline part, so a reply updates it at once.
- **List rows** show "SLA 42m" or "SLA overdue".
- **The view editor** offers the SLA and ticket-type filters and the new sort.
- **The timeline** shows breaches.
- **Bundle:** the agent bundle grows by 1 KB gzip (238 to 239 KB).

**Seed data.** The local relay adds a "Standard support" policy on the seeded office hours: first response 1 hour, next response 2 hours, close 8 hours and resolve 24 business hours, pausing while snoozed and while waiting on the customer.

## 2. Files

| File | Change |
|---|---|
| `db/postgres/0025_sla.sql`, `db/rollback/0025_sla.sql` | Policies, clocks, conversation and member columns |
| `server/sla.ts` | Policies, timeline-derived clocks, breach, timer check, re-evaluation, sidebar context |
| `server/conversations.ts` | SLA sync after commands, replies, merges and wakes; SLA fields on rows |
| `server/inbox-views.ts` | SLA and ticket-type filters; SLA sort key |
| `server/tickets.ts` | Type-change events record the new state's kind |
| `server/api.ts`, `server/agent-bridge.ts`, `server/context.ts` | Routes, bridge, sidebar context |
| `workers/relay.ts`, `scripts/local-relay.ts` | Timers, sweep, job handler, local check, seed policy |
| `agent/sla.tsx`, `agent/sidebar.tsx`, `agent/views.tsx`, `agent/timeline.tsx`, `agent/inbox.css`, `components/relay/postgres-inbox.tsx` | UI |
| `tests/sla.test.ts`, `tests/browser/sla.spec.ts` | Coverage below |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 30 September 2026:

- **Node:** 55/55 pass. `tests/sla.test.ts` covers:
  - **Setup:** flag off (no clocks); five invalid policies refused; `workspace.manage` required; version conflicts; other workspaces see nothing; re-evaluation of existing conversations after a save.
  - **Starting clocks:** a new conversation starts first response (due in an hour) and time to close; the timer's due time.
  - **Priority policy:** tightens the target while keeping the 4 minutes used; the close clock becomes inactive.
  - **Breach:** recorded once at exactly the moment the target ran out, on the internal timeline and as an outbox event, and never shown to the customer; a reply stops the clock and the breach stays.
  - **Pauses and cycles:** waiting on the customer pauses time to close; next-response cycles 1 and 2; snooze pauses and waking resumes; close stops and reopening continues.
  - **Tickets:** time to resolve pauses in a waiting state and stops when resolved.
  - **Views:** breached and ticket-type filters; sort order.
  - **Timer path:** a 1-second target breaches through the timer, once.
  - **Calendars:** a business-hours clock pins calendar version 1 and keeps it after version 2 is published.
  - **Exclusions:** internal tickets and other workspaces get no clocks; another workspace can't read the context.
  - **Sidebar data:** the SLA section's contents.
- **Typecheck and lint:** clean on the changed files (the two older findings in `agent/views.tsx` remain).
- **Browser:** 34/34 pass. `tests/browser/sla.spec.ts` passed 4 out of 4 on repeat.
  - **Happy path:** "Chat · all hours" with "Due … · in 1h 59m" in the sidebar and on the row; a reply from the composer turns it to "Met", and the row badge goes.
  - **Failure path:** a 4-second target breaches with nobody touching the conversation. The sidebar turns red ("Overdue by"), the timeline shows "First response SLA breached (Urgent)", the row shows "SLA overdue", exactly one `sla.breached` outbox event exists, and "SLA due soonest" puts it first.

## 4. Deferred and known gaps

- **No policy editor.** Policies are managed through the API (and the local seed).
- **SLA work runs inside every command's transaction.** `syncSla` reads the conversation's message, state and ticket parts and runs a few queries. The first-screen timing measured in phase 04 (`scripts/measure-first-screen.ts`) has not been re-run with SLAs on.
- **No one consumes `sla.breached` outbox events yet.** Workflows (phase 11) will act on them.
- **Reports on SLA performance** (met and breached rates) are phase 14.
- **AI replies (phase 08) don't count as a response yet.** Only teammate replies stop response clocks.
- **Moving a clock to another team's calendar** when a conversation is reassigned isn't done. Clocks keep their calendar, as decided in B1.
- **Still open from phase 04:** a new teammate's first list stays empty until the page reloads.
