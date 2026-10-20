# Phase 14: Reporting and analytics (plan)

Brief: `docs/BUILD_PHASES.md` phase 14. It needs phases 05, 06, 08 and 13 (all done locally, 13 as scoped). Drafted on 20 October 2026, and approved that day ("go ahead with phase 14"): a separate PostgreSQL store (decision 1), conversation quality review as its own later phase, the scope R1 to R4, and a read-only look at Intercom's Reports before R3.

The brief's warning shapes everything: reports never query the tables that serve the inbox. Every number is defined once, in writing and in code. History doesn't change when someone edits a contact today.

## Where Relay is today

**Already there:**
- **A change stream:** the outbox (every conversation part, job state and so on, append-only), already read by realtime.
- **Durations:** conversation cycles (each open and close), SLA clocks and their breaches (phase 05), and the business-time engine and calendars (phase 06, the one source of office hours). `first_response_business_ms` is already kept.
- **Zoe:** the resolution ledger (`ai_resolutions`, append-only) and her answers (`ai_answers`).
- **Other sources:** ratings (a part), tickets and their states, email deliveries, calls (E9), outbound's ledger (O2), and events (O1).
- **Measured already:** a few first-response medians (for reply-time expectations) and the help center's search report.

**Missing:**
- **An analytical store:** STATUS says it isn't built or provisioned.
- **Attribute snapshots, a metric dictionary, and any reports area.**
- **Phase 10 (copilot) was skipped,** so there's no copilot usage to report on.
- **Surveys (outbound O6) are outside phase 13's scope,** so CSAT comes from conversation ratings only.

## Steps

| Step | Scope |
|---|---|
| **R1: The stream, the store and the dictionary** | `docs/METRICS.md`: every metric's formula, anchor timestamp, inclusions, exclusions and treatment of automation. That covers the brief's list and the gap audit's (first-contact resolution, repeat contact, adjusted handling time, reassignment count). The definitions are also code, and a test holds the document to the code.<br>**The store:** an analytical store behind a port, fed from the outbox by an idempotent projection job, with its lag shown ("as of 10:42").<br>**Snapshots:** conversation facts with attributes snapshotted at conversation start and later changes as separate rows. Contact name and email are resolved live, and the UI says so.<br>**Durations** in wall-clock and business time (phase 06's engine only).<br>**A backfill** from existing data.<br>**The brief's two acceptance tests:** an edit today doesn't change last month; office-hours durations across a daylight saving change. |
| **R2: Datasets, and the 10-million-part benchmark** | Datasets, each a documented table of metrics and breakdowns: conversation, rating, SLA, ticket, AI agent, teammate, team, outbound, article and search, and calls.<br>**One query layer:** filters, breakdowns, a date range with the previous period, and a report timezone.<br>**Daily rollups** per workspace where they pay.<br>**The benchmark:** 10 million parts across 5,000 workspaces, with timings for every pre-built report's queries. |
| **R3: The Reports area and pre-built reports** | `#reports`: overview (human and AI together), conversations, responsiveness, SLAs, team and teammate performance, tickets, CSAT with dissatisfaction drivers, AI agent performance, help center and search, and outbound performance. From the gap audit: effectiveness, calls, email deliverability and human-in-the-loop.<br>**Each report:** the date range and comparison, the timezone, filters, and drilling from a point to its rows where the viewer may see them. |
| **R4: Real-time dashboard** | Open and unassigned now, waiting longest, teammates online and their status, the queue by team, and live SLA risk. A cheap aggregate refreshed often, apart from the history; reached from the inbox too (the gap audit). |
| **R5: Custom reports** | A builder: dataset, metric, breakdown, filters and chart type (KPI, column, bar, donut, line, area, heatmap, table); several charts to a report.<br>**Custom metrics:** percentage, ratio or absolute, with separate numerator and denominator filters.<br>**Also:** saved filter sets; saving, sharing and access (private, teammates, roles). |
| **R6: Conversation topics** | **Suggesting:** clustering conversations (the existing embedding port) and suggesting topics to a lead, who accepts, renames, merges or rejects them.<br>**Classifying:** incoming conversations against the accepted topics.<br>**Reporting:** volume, CSAT, first response and time to close per topic; every report filterable by topic.<br>**Content gaps:** busy topics without a matching article, fed into phase 07's gap list. |
| **R7: Export and sharing** | **Exports:** CSV, and scheduled email delivery through E3's sending.<br>**Sharing:** an external link with an expiry and an optional password.<br>**Warehouse:** an export of conversations, tickets, contacts and events to object storage (R2), with a documented schema. |

Each step ships the usual: migration and rollback, seed, unit tests, an end-to-end happy path and failure path, a CHANGELOG entry and a handoff (`docs/REPORTING_STEP<n>.md`). The flags are `reports_v1`, `report_topics_v1` (R6) and `report_sharing_v1` (R7), all off by default.

## Decisions (proposed)

1. **The analytical store is PostgreSQL, in a separate database, behind a port** (`AnalyticsStore`). It's fed only by the projection, so the inbox's tables are never read by a report. Deployed, that's a second Neon database with its own Hyperdrive; locally, a second embedded PGlite. Exact numbers matter here, and SQL stays one tool. If R2's benchmark misses its targets, the port lets a columnar store (ClickHouse) replace it without touching reports.
   - **Not chosen: Cloudflare Analytics Engine.** It samples, so its numbers aren't exact.
   - **Not chosen: DuckDB over files in R2.** It's good for the warehouse export, but not for interactive reports per workspace.
2. **The feed is the outbox,** read by `analytics.project`. It's idempotent by outbox id, so a replay changes nothing. The store keeps the last id it read, and reports show that time.
3. **Snapshots:** a conversation's contact, company (once phase 01 has them) and conversation attributes are copied when it starts. Later changes are new rows with their time. Contact name and email are resolved live, and each report says so where it shows them.
4. **One definition of each metric,** in code (`lib/metrics.ts`), used by every report. `docs/METRICS.md` is written alongside, and a test fails if they disagree.
5. **Durations use only phase 06's business-time engine,** with the calendar pinned on the conversation (as SLAs do).
6. **The real-time dashboard reads live counters,** never the history. It's refreshed every few seconds from small aggregate queries on indexed columns, with a test bounding their cost.
7. **Phase 10's copilot report is left out** (phase 10 was skipped), and **survey responses wait for outbound O6.** CSAT comes from conversation ratings.

## Needs you

- **The store (decision 1):** PostgreSQL in a separate database (recommended), or a columnar store from the start (ClickHouse Cloud, a new account). Nothing needs an account to build; deploying needs the second database.
- **Conversation quality review** (the brief: "large enough to become its own phase; decide before starting phase 14"): reviewers, scorecards, issues, and optionally an AI quality score. My recommendation is to make it its own phase after 14, so it isn't in this plan.
- **Scope:** the brief's cut list says "Ship eight excellent fixed reports first" and a custom report builder is safe to defer.
  - **R1 to R4** (recommended): the store, the datasets and benchmark, the pre-built reports, and the live dashboard. Then R5 to R7 when asked.
  - **R1 to R7:** everything.
  - **Something in between.**
- **Intercom's Reports:** I can look at the live account's reports (read-only, as before) before R3, to match their shapes.

8. **R1 decisions** (20 October 2026):
    - **Snapshots are taken by the database** (a trigger on new conversations), and contacts' later changes by another (a trigger on contacts), so every code path is covered. Conversations from before were snapshotted when the migration ran.
    - **The feed reads each conversation's parts by their order** (gap-free per conversation), not the outbox's time order. Conversations are found by their last change, with a two-minute overlap, in batches until caught up.
    - **The store keeps no message text:** only what metrics read.
    - **Reporting is off where the store isn't connected** (deployed, until the second database exists).

Handoffs: `docs/REPORTING_STEP1.md` (R1).
