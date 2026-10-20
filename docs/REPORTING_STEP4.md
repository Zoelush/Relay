# Phase 14, step R4: The live dashboard

Branch `reporting/r4-live`. Plan: `docs/REPORTING_PLAN.md` (scope: R1 to R4, now complete). Behind `reports_v1`, off by default and on for the local relay. R5 to R7 wait until asked.

## What it does

**Live** shows what's happening now: the queue, who's waiting, the team and SLAs. It's the first entry in the Reports menu (`#reports/live`), and also **Live dashboard** in the inbox's menu, as the gap audit asked ("reached from the inbox").

**Who and when:**
- **Who sees it:** who may view reports, while reporting is on.
- **No store needed:** it needs no analytical store, so it's there even where reports over history aren't. Then the area is Live alone.

**What's on it:**
- **Now:**
  - Open now, Unassigned and Waiting for a reply.
  - The longest wait.
  - SLA missed and SLA due within the hour.
  - Snoozed.
  - Missed SLAs show in rose, and unassigned and due-soon counts in amber, when there are any.
- **Waiting longest:** the ten conversations whose customer has waited longest for a teammate's reply.
  - **Each shows** how long, the channel, team and assignee, and an SLA chip.
  - **Clicking one** opens it in the inbox.
- **Teammates:** each one's presence (active, away, away and reassigning) and since when, and their open conversations against their limit. A bar turns rose at the limit.
- **Queue by team:** open, unassigned, waiting, longest wait, SLA due soon and missed for each team, including conversations with no team.
- **A team filter** narrows everything to one team and its members.

**Refreshing:**
- **Every 15 seconds,** but only while the tab is visible, and at once on coming back to it. Intercom's refreshes every 60.
- **Between answers,** waits keep ticking.
- **The badge** says when it last updated, or "Not updating" if a refresh fails.

## How it works

**Reading the live set:**
- **Live tables, not the history:** "now" can't wait for the projection, so `server/live.ts` reads the inbox's own tables, unlike reports.
- **Only the conversations in play:** open or snoozed, customer-facing and not merged. Migration `0076_live_dashboard` adds two partial indexes for this:
  - `conversations_live` (team, assignee)
  - `conversations_live_waiting` (in waiting order)
- **Three small queries:**
  - **Counts by team and by teammate,** in one pass (`GROUPING SETS`).
  - **The ten longest waits,** read in waiting order from their index.
  - **Teammates, teams and membership** (small tables).
- **The cost bound** (plan decision 6) is in `tests/live.test.ts`: with 4,000 closed conversations, neither query reads conversations by a full scan, and neither reads more rows than the live set.
  - **Checked both ways:** without the two indexes, the test fails.

**Terms are the inbox's:**
- Unassigned is `assigned=''`.
- A conversation is waiting when its customer wrote after the last teammate reply, and it's waiting since that message (the inbox's waiting order).
- An outbound chat counts once the person replies (as in reports).
- SLA missed is the next target already past; due soon is within the hour.

**The page computes nothing:**
- **Counts and waits come from the server.** Between refreshes the page only adds the seconds since it asked.
- **Code:** `agent/live.tsx`, `GET live-dashboard?team=` (`server/api.ts`, `server/agent-bridge.ts`), the `live` capability, the Reports area's Live entry, and the inbox menu's link (`agent/views.tsx`).

**Rollback:** `db/rollback/0076_live_dashboard.sql` drops the two indexes. Nothing else is stored.

**Seed data:** none of its own. The demo's open conversations, teams, SLAs and teammates are what it shows.

## Checks

- **`tests/live.test.ts`:**
  - **Known answers,** totals and by team: open, unassigned, waiting, snoozed, missed and at risk.
  - **Teammates:** presence and limit.
  - **Waiting longest,** in order and with SLA state.
  - **Excluded:** a closed conversation and an unanswered outbound chat are left out.
  - **The team filter.**
  - **Who may see it,** and the flag off.
  - **Isolation:** another workspace sees none of it.
  - **The cost bound.**
- **`tests/browser/reports.spec.ts`:**
  - **Happy path:**
    - The inbox's Live dashboard link opens it.
    - Its numbers equal the server's own (`liveDashboard`).
    - A new waiting conversation is in the queue.
    - The teammates and team table are shown.
    - Clicking a waiting conversation opens it in the inbox.
  - **Failure path:** a teammate who may not view reports has no link, and `live-dashboard` is refused.
