# Phase 14, step R3: The Reports area

Branch `reporting/r3-reports` (on top of R2's `reporting/r2-datasets`). Plan: `docs/REPORTING_PLAN.md` (scope: R1 to R4). Behind `reports_v1`, off by default and on for the local relay. Next: R4, the live dashboard.

## What it does

Reports have their own place in the app: **Reports** in the strip, just before Outbound (as in Intercom's), at `#reports` and `#reports/<report>`. It's shown to whoever may view reports, while reporting is on and its store is connected.

**The overview:**
- **How conversations were handled:** a flow of the period's new conversations.
  - **First split:** Zoe took part; else a teammate replied; else it closed without a reply; else it's waiting.
  - **Then:** Zoe's split into resolved by her, handed to a teammate, or neither; the team's into closed or still open.
  - **Scale:** band widths are to scale, and the parts always add up to the whole. Hovering a node or band highlights its path.
- **The overview report's tiles and charts:** AI agent involvement and resolution, first response, time to close, CSAT, deflection, and new conversations by day.
- **Every report** as a card, by group.

**The 14 pre-built reports** (`lib/reports.ts`), grouped as Intercom's in the side menu:
- **Human support:** Conversations, Responsiveness, SLAs, Team performance, Teammate performance, CSAT, Effectiveness, Tickets, Calls and Email deliverability.
- **AI & automation:** AI agent and Human in the loop.
- **Proactive:** Outbound.
- **Self-serve:** Help center and search.

**On every page:**
- **The period:** today, 7, 30 or 90 days, 12 months, or custom dates.
- **Filters and timezone:** channel and team filters, and the report's timezone (the browser's by default).
- **Office hours:** a switch that shows durations in office hours instead of wall-clock.
- **Freshness:** how current the data is, with Refresh.
- **Remembered:** the period, timezone and office-hours choice are kept per browser.

**What each chart shows:**
- **A chart without a breakdown is a tile:** the number, what it's made of ("5 of 12", "Median of 4"), and its change against the previous period.
  - **The change's colour** depends on whether that direction is better for that metric (`BETTER` in `lib/reports.ts`). Volume has no colour.
  - **A share's change** is in points.
- **Day, week or month is a bar chart:**
  - **Every period appears,** quiet ones as gaps, with the busiest one read out and the hovered one named.
  - **Over 62 days,** daily charts become weekly so bars stay readable.
- **Brand, channel, team, teammate or item is a ranked bar list,** by name, with a share's parts beside it.
- **Every chart's definition is one click away** (ⓘ): its formula, when it's counted, what's in and out, and how automation is treated, from `lib/metrics.ts`. These are the same words as `docs/METRICS.md`.

**Look:**
- **Colours:** every colour is a token. Each card takes a tint in turn, and Reports is violet in the strip.
- **Both themes** meet the theme test.
- **Loading** shows a shimmer (still for reduced motion).
- **Narrow screens:** the header scrolls away, and the flow keeps a readable size and scrolls sideways.

## How it works

- **`agent/reports.tsx`** draws everything; there's no chart library, the charts are SVG and CSS.
  - **How it asks:** each chart asks `report-metric` for its metric, previous period and breakdown, all at once. Each answer is kept by its question, so going back to a report doesn't ask again.
  - **What the page computes:** nothing. Counts, medians and shares come from the server; the page formats them.
- **`server/reports.ts` `conversationFlow`:** one query over the period's new conversations, from the columns the dictionary's metrics use (`ai_involved`, Zoe's net resolutions, `ai_handed_over`, `teammate_replies`, the first close). It's anchored to the start, as new conversations are.
  - **Its route:** `POST report-flow` (`reportFlow`), with the same permission as `report-metric`, which now share `mayReport`.
- **Names for breakdown keys:** `report-metric` now returns `labels` (`reportLabels`), because the store keeps only ids.
  - **Read from the application:** teammate, team and brand names, outbound messages' titles, and articles' titles.
  - **Fixed words** (ticket categories, SLA targets, search surfaces, who wrote a delivery) are in `ITEM_LABELS`.
- **The capability `reports`** is in the inbox snapshot (`server/api.ts`). The strip entry and the area are in `components/relay/postgres-inbox.tsx`.

No migration: R3 reads what R2 built.

## Before building: Intercom's Reports (read-only look, 20 October 2026)

Looked at, not changed:
- **Where it sits:** Reports sits after Knowledge and before Outbound.
- **The overview** leads with a flow of how conversations were handled, then sections of tiles with the change against the previous period, and weekly charts.
- **Each report:** a title and description, a toolbar (dates, filters, timezone, when it was last updated), a row of tiles, then charts over time and breakdowns.
- **The menu:** Overview, all reports, and groups (AI & Automation, Human support, Proactive).

Relay follows that shape. Saved filters, custom reports, scheduling and export aren't in R3's scope.

## Checks

- **`tests/reports.test.ts`:**
  - **The flow** on the scenario (C1 and C2 answered by the team, C1 closed, C3 resolved by Zoe), filtered by team.
  - **Permissions:** refused to a teammate without permission.
  - **Isolation:** empty for another workspace.
  - **Labels:** a teammate breakdown names the teammate.
- **`tests/browser/reports.spec.ts`:**
  - **Happy path:**
    - Reports sits just before Outbound.
    - A customer's new conversation is in the overview's flow, which matches `conversationFlow` for the same 30 days.
    - A tile's definition opens.
    - The menu opens Conversations, whose channel breakdown names Messenger.
    - Choosing 7 days is kept across a reload.
  - **Failure path:** a teammate who may not view reports has no Reports in the strip or at `#reports`, and `report-flow` is refused.
- **`tests/browser/zoe.spec.ts`:** the strip's order, now with Reports (violet) before Outbound.
