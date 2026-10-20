# Phase 14, step R1: The stream, the store and the dictionary

Branch `reporting/r1-store-metrics`. Plan: `docs/REPORTING_PLAN.md` (scope: R1 to R4). Behind `reports_v1`, off by default and on for the local relay. Next: R2, the datasets and the 10-million-part benchmark.

## What it does

The foundation every report stands on: a separate store that only reports read, fed from the application; a written definition of every number; and history that doesn't change when someone edits a contact today.

**The analytical store** is a separate PostgreSQL database (`db/analytics`, its own migrations):
- **Who writes and reads it:** only the projection writes it, and reports read only it, so a report never touches the tables that serve the inbox.
- **Deployed:** a second Neon database through its own Hyperdrive binding (`ANALYTICS_HYPERDRIVE`). Reporting is off until it's provisioned.
- **Locally:** a second embedded database beside the application's.

**The feed** (`analytics.project`, scheduled by the sweep):
- **What it reads:** each changed conversation's new parts (in order; append-only), the snapshot taken when it started, the calendar version it's pinned to, and contacts' later changes. It recomputes the conversation's facts.
- **Idempotent:** parts are keyed by their order, snapshots and changes by id, and facts are recomputed from all of a conversation's parts. Running it again changes nothing.
- **Catching up:** conversations are found by their last change, after a watermark less a two-minute overlap (commits can land out of order). It runs in batches of 200 that continue until the workspace is caught up. Its first run is the backfill.
- **No message text or personal data is copied:** only what metrics read (states, assignments, ratings, Zoe's handover, deletion).

**Snapshots** (in the application, `0074_reporting_sources`):
- **At the start:** when a conversation starts, the database itself records who the customer was (their contact's type and attributes), so every way a conversation starts is covered.
- **Later changes:** every change to a contact's type or attributes is recorded as its own row by a trigger. Both are append-only.
- **What reports use:** attributes as they were when each conversation started. Only a contact's name and email are shown as they are now, and Settings says so.
- **Earlier conversations** were snapshotted when the migration ran, the best that exists for them.

**Facts per conversation** (`conversationFacts`, the dictionary's code):
- **Timing:** the customer's first message, the first teammate reply after it, the first close, first response and time to close (wall-clock and office hours).
- **Counts:** customer messages, teammate replies, Zoe's replies and workflow messages; closes and reopens; assignments.
- **Zoe's involvement and handover, and the latest rating.**
- **Office hours** use only phase 06's engine (`businessMilliseconds`), on the calendar version the conversation is pinned to; with none, always open.

**The metric dictionary** (`lib/metrics.ts`, `docs/METRICS.md`):
- **What's defined:** 30 metrics, each with its formula, the time it's anchored to, what's included and excluded, and how automation is treated. That's the brief's list (new, replied to, replies sent, closed, reopened, open and snoozed at the end, first and next response, time to close and to resolve, handling time with and without idle, SLA hit and miss rates and misses, CSAT and its response rate, the AI agent's resolution, escalation, answer and involvement rates, deflection, conversations per teammate per hour, busiest period) and the gap audit's (first-contact resolution, repeat contact, adjusted handling time, reassignments), plus awaiting first response.
- **Kept in step:** the document is generated from the code (`npm run metrics:doc`), and a test fails if they differ.

**Settings › Reporting data** (for who may view reports): how current the store is ("Up to date as of 08:59:24 · 13 conversations") and every metric's definition, by dataset.

## How it works

**The application's migration `0074_reporting_sources`:**
- `conversation_snapshots` (written by a trigger on new conversations) and `contact_changes` (a trigger on contacts), both append-only
- an index on conversations' last change
- row-level security, and the flag
- **The rollback:** the flag goes off (the projection stops, the page closes). The triggers and snapshots stay, as they only add rows.

**The store's migration `db/analytics/0001_facts.sql`:** `a_projection` (watermarks), `a_parts`, `a_snapshots`, `a_contact_changes`, `a_calendars` and `a_conversations` (the facts), each per workspace with row-level security.
- **Its rollback** (`db/analytics-rollback/`) clears the watermarks: the projection starts again from the beginning and changes nothing.

**Reporting:**
- **`server/analytics.ts`:**
  - `conversationFacts`, `projectJob` and `scheduleProjection`
  - `conversationSummary`, the first query (new conversations, first response medians, a breakdown by an attribute as it was at the start), which R2 builds on
  - `readReportingStatus`
- **`lib/metrics.ts`:** the dictionary and `metricsDocument`.

**Elsewhere:**
- **Databases:** `scripts/local-db.ts` takes a migrations folder; `tests/database.ts` adds `analyticsDatabase`.
- **The Worker:** the job, the sweep, and the optional `ANALYTICS_HYPERDRIVE` (`scripts/worker-config.mjs` adds it when `ANALYTICS_HYPERDRIVE_ID` is set).
- **Local relay:** the second database (`<directory>/analytics`), the job, and the sweep.
- **The route:** `GET reporting-status`.
- **UI:** `agent/settings-reporting.tsx`, in a new "Reports" group.

## Deploying (not done: needs you)

- A second Neon database (in eu-west-2, as the first), with `db/analytics` migrations applied.
- A Hyperdrive configuration for it, with its id as `ANALYTICS_HYPERDRIVE_ID` when generating the Worker config.

## Checks

- **`tests/metrics.test.ts`:**
  - **The dictionary:** `docs/METRICS.md` equals the code's output; every metric the brief and the gap audit name is defined, and each field is written out.
  - **Daylight saving** (the brief's acceptance test): first response wall-clock and office hours across London's autumn and spring changes, a reply on the change night itself, and no calendar.
  - **Facts:** only teammates' public, undeleted replies are responses; closes, reopens, assignments, Zoe, workflows and the latest rating.
- **`tests/analytics.test.ts`:**
  - **Off by default:** nothing projected, no page.
  - **Who may see it:** who may view reports only.
  - **Snapshots:** taken by the database.
  - **The backfill:** 251 conversations in two batches; run again from the start, it changes nothing; no message text is stored.
  - **Facts stay current:** a close today is projected on the next run.
  - **The acceptance test:** Ada's plan edited today doesn't change last month's report (still "pro"), and each change is its own row. Snapshots and changes are append-only.
  - **The status page.**
  - **Another workspace:** its own rows.
  - **Both rollbacks.**
- **`tests/browser/reporting.spec.ts`** (ports 9062 and 9063):
  - **Happy path:** a customer's new conversation reaches the store in the background, and Settings shows the new count, how current it is, and a metric's definition.
  - **Failure path:** a teammate who may not view reports doesn't get the page, and its data is refused.

## Not included

- **Datasets beyond conversations, every metric's query, and the benchmark:** R2.
- **The Reports area and pre-built reports:** R3. **The live dashboard:** R4.
- **Companies in snapshots:** phase 01.
