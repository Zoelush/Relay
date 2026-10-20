# Phase 14, step R2: Datasets, the query layer and the benchmark

Branch `reporting/r2-datasets`. Plan: `docs/REPORTING_PLAN.md` (scope: R1 to R4). Behind `reports_v1`, off by default and on for the local relay. Next: R3, the Reports area and the pre-built reports (after a read-only look at Intercom's).

## What it does

Every metric in the dictionary can now be asked for, from reporting's own store, in one way: a period, the previous period of the same length, a report timezone, filters and a breakdown.

**Datasets** (Settings › Reporting data lists each one: its metrics, what it breaks down by, and how many rows it holds):
- **Conversations, Ratings, SLAs, Tickets, AI agent, Teammates, Outbound, Search, Articles, Calls and Deliveries.**
- **52 metrics** (R1's 30, and tickets, outbound, help center search and articles, calls, email deliverability and Zoe's drafts held for a teammate), each defined in `lib/metrics.ts` and `docs/METRICS.md`.

**The query layer** (`server/reports.ts`, `runMetric`):
- **One definition per metric:** each is one SQL statement over the store whose rows have the same columns (the time it's anchored to, the conversation's brand, channel, team and teammate, an item, and what's measured). One wrapper filters, breaks down and aggregates them, so a metric means the same in every report.
- **Kinds:** counts, distinct counts, shares (with numerator and denominator), durations (median and average, wall-clock and office hours), and two of their own: the busiest hour of the week, and conversations per teammate per active hour.
- **Breakdowns:** brand, channel, team, teammate, item (a ticket type, an outbound message, an article…), day, week or month in the report's timezone, or a contact attribute as it was when the conversation started.
- **Refused:** a metric that isn't in the dictionary, a period over 400 days or backwards, an unknown timezone or breakdown.
- **Through the app:** `POST report-metric`, for who may view reports, while reporting is on and its store is connected.

**What the store now holds** (copied by the same idempotent projection):
- **From each conversation's parts:** its states over time (open, snoozed, closed), each response (a run of customer messages and the teammate reply that answered it), and each handling period (assigned and open, ended by a close, snooze or reassignment, with idle gaps over 30 minutes counted apart).
- **New facts:** the last close, replies before the first close, reopened within 7 days, and Zoe's first reply.
- **Copied sources,** each with its own watermark: SLA clocks, tickets, Zoe's answers and resolutions, outbound entries, calls, help center searches and article feedback, channel deliveries, teammates and their presence changes.
- **Presence history** comes from the application's new `teammate_presence_changes` (a trigger, append-only), so active hours can be counted.

**Daily rollups: not built.** The plan asked for them "where they pay". Per the benchmark, they'd pay only for two charts, for the largest workspace, over a year (about 300 ms against the 200 ms target). Everything else is within target without them. The query layer is the one place they'd go: a per-workspace, per-day table of replies and active hours.

## The benchmark

`scripts/reporting-benchmark.ts`. Results: `docs/REPORTING_BENCHMARK.md`.

- **Setup:** 10 million parts across 5,000 workspaces, on PostgreSQL 17, with sizes skewed as customers are.
- **Method:** every pre-built report's charts run as the runtime role, with row-level security on. Three workspaces are timed (the largest, the 99th percentile and the median) over 30 days, and the largest also over 365 days.

**Results** (Apple M1, 8 GB, PostgreSQL 17 with default settings, 7 timed runs):
- **The 99th-percentile workspace** (14,000 parts) **and the median** (about 1,000): every chart answers in about 20 to 60 ms. Most of that is the connection and the three queries' round trips.
- **The largest workspace** (about 590,000 parts, 6% of everything), **over 30 days:** every chart is within 200 ms at p95. The slowest is `conversations_replied_to` by day, at about 170 ms.
- **The largest workspace over 365 days:** two charts go over 200 ms. `conversations_replied_to` by day takes about 300 ms and `conversations_per_teammate_hour` about 335 ms; both count a year of replies.
- **Whole reports** (charts in sequence) take up to about 0.9 seconds for the largest workspace. R3 can run a report's charts in parallel.

**What it changed:** an early run at a small size found three plans that read a workspace's whole history. All three are fixed in the store's 0002 migration:
- **Repeat contact** took 2.4 seconds over a year. It's now one pass with `lag()` over each contact's conversations.
- **Zoe's rates** looked up her first reply per conversation. `first_ai_at` is now a projected column with its own index.
- **New conversations** couldn't use the start index, because an outbound chat starts at the customer's first message. That expression now has its own index.
- **CSAT** (found at full size) found each conversation's latest rating across the whole history before filtering, up to 360 ms. The latest rating's time is now projected (`rated_at`), and the CSAT report fell from 830 ms to 190 ms.
- **The load itself:** the first full run took over an hour inserting into indexed tables. The script now loads as any bulk load would: rows sorted, and the secondary indexes dropped and rebuilt from the migrations' own definitions. That takes about 3 minutes.

## How it works

**The application's migration `0075_reporting_presence`:** `teammate_presence_changes`, written by a trigger on teammates' presence, append-only, with row-level security.
- **Its rollback** does nothing: the table and trigger only add rows, and reporting reads them only while on.

**The store's migration `db/analytics/0002_datasets.sql`:**
- **New columns on `a_conversations`:** team, assignee, last close, replies before the first close, reopened within 7 days, Zoe's first reply, and when the latest rating was given.
- **The derived tables:** `a_states`, `a_responses` and `a_handling`.
- **The copies:** `a_sources` (watermarks), `a_sla`, `a_tickets`, `a_ai_answers`, `a_ai_resolutions`, `a_outbound`, `a_calls`, `a_searches`, `a_feedback`, `a_deliveries`, `a_teammates` and `a_presence_changes`.
- **Indexes** for each anchor, and row-level security on every table.
- **Existing conversations:** the migration ends by resetting the conversation watermark. Conversations already in a store get the new columns and derived rows on the next run, recomputed from their stored parts.
- **Its rollback** resets the watermarks: everything is rebuilt from the beginning, with the same answers (tested).

**Code:**
- **`server/analytics.ts`:**
  - `conversationDerived` (states, responses, handling)
  - the new facts (including Zoe's first reply and when the latest rating was given)
  - `syncSources`
  - `reportMetric`
  - datasets in `readReportingStatus`
- **`server/reports.ts`:** the definitions, `runMetric`, `DATASETS` and `QUERYABLE`.
- **`lib/reports.ts`:** the 15 pre-built reports (what R3 draws and the benchmark times).
- **Routes:** `server/api.ts` and `server/agent-bridge.ts` (`report-metric`).
- **Page:** `agent/settings-reporting.tsx` (Datasets).

**Unassigned is null in the store.** The inbox writes it as an empty string; the projection keeps it as null, and the reassignment query treats both as unassigned (parts stored before this keep `""`). This is what stops a first assignment from counting as a reassignment.

**Seed data:** none of its own. The demo's conversations, SLAs, tickets, Zoe's answers, calls and outbound reach the store through the projection, as real data does.

## Checks

- **`tests/reports.test.ts`:**
  - **Derived periods:** states, responses (one per run of customer messages) and handling periods, with idle time excluded.
  - **The scenario:** four conversations at known times, plus SLA targets, a ticket, Zoe's answer and resolution, outbound, calls, presence, searches and feedback. Every metric's value is asserted against the scenario: totals, the previous period, breakdowns (attribute, day, teammate, team), filters and a +14-hour timezone.
  - **Coverage:** every metric in the dictionary and every pre-built chart runs; the refusals are tested.
  - **Through `reportMetric`:** who may view reports only.
  - **Cross-workspace:** another workspace sees none of the first's data.
  - **The rollback:** rebuilt, the same answers.
- **`tests/metrics.test.ts`:** the new facts.
- **`tests/browser/reporting.spec.ts`:**
  - **Happy path:** a metric broken down by channel through the app equals the store's own count, and the Datasets table shows the conversation dataset's rows.
  - **Failure path:** a metric not in the dictionary is refused (400), and a teammate who may not view reports is refused.
