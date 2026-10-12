# Phase 08, step C2b: Monitors and incidents

Branch `ai/c2b-monitors`. Plan: `docs/AI_PLAN.md` (decision 15). Behind `zoe_monitors_v1`, off by default and on for the local relay. This is the last step of phase 08's plan.

## What it does

**Six built-in monitors** watch Zoe's behaviour. Each is a rate over the last 24 hours, compared with the 7 days before:

| Monitor | What it measures | Bad when it | Needs at least |
|---|---|---|---|
| "I don't know" rate | questions she tried and couldn't answer from content | rises | 20 answers |
| Handover rate | messages she handed to the team | rises | 20 |
| Blocked by safety | replies the guards in code stopped | rises | 20 |
| Error rate | questions a model or the index failed on | rises | 20 |
| "That helped" rate | answers the customer confirmed helped | falls | 20 |
| Rated bad in review | answers reviewers rated bad (C2a) | rises | 5 ratings |

**Analyze › Monitors:**
- **Each monitor shows:**
  - its numbers now (the last 24 hours, and the usual, with how many answers each covers)
  - its status: Normal, Changed sharply, Incident open, Not enough answers yet, or Off
  - a switch, and a sensitivity
- **Sensitivity:** a change opens an incident when the rate moves the bad way by at least so many points *and* by a factor:

  | Sensitivity | Points | Factor |
  |---|---|---|
  | High | 5 | 1.5× |
  | Medium (the default) | 10 | 2× |
  | Low | 20 | 2.5× |

**Incidents:**
- **Opening:** once an hour, a sharp change opens an incident. Each monitor has at most one open.
- **What an incident holds:**
  - the usual rate, the rate when it opened, its latest and its worst
  - how many answers it covers
  - up to five example conversations, which open in the inbox
  - what changed in the two days before: guidance versions, Zoe's settings, specialists, and content she uses that was published
- **Closing:** a teammate can acknowledge it or resolve it, either with a note. It also resolves itself after two normal checks in a row, and switching its monitor off resolves it too.
- **Analyze › Incidents** lists the open ones, then those resolved in the last 30 days, with how each was resolved.

**Alerts:**
- **In the app:** when an incident opens, everyone who manages Zoe gets a notification ("Incident: Zoe's behaviour changed sharply" and the change). Opening it goes to Incidents.
- **On Zoe's Overview:** a banner while any incident is open.
- **By email:** waits for phase 12 (TODO).

## How it works

**Migration `0053_zoe_monitors`:**
- **`ai_monitor_settings`:** a row only once a monitor's default changes; versioned.
- **`ai_monitor_runs`:** one row per checked UTC hour, written first, so a check runs once an hour however often the sweep does.
- **`ai_monitor_checks`:** each monitor's numbers and status per check, kept 30 days.
- **`ai_incidents`:**
  - one open per monitor, through a partial unique index
  - checks that a resolved incident has its resolution and time
- **`notifications`:**
  - a new kind, `zoe_incident`, with `incident_id`
  - its conversation, part and author become nullable, since an incident has none
  - a check keeps mentions as they were
- **The flag.**
- **The rollback:**
  - turns the flag off
  - marks incident notifications read, because the previous version counts every unread notification but lists only those with a conversation, which would leave a badge nobody could clear

**`lib/zoe-monitors.ts`** has the monitors, the sensitivities and `tripped()`. It's shared, so the pages describe exactly what the server decides.

**`server/zoe-monitors.ts`:**
- **`measure`:** every rate, from `ai_answers`, `ai_resolutions` and `ai_reviews`.
- **`checkMonitors`:** run by the scheduled sweep in `workers/relay.ts` and the local relay's loop. It records each check, opens, updates and resolves incidents, and notifies.
- **The pages and changes:**
  - `readMonitors` and `readIncidents`
  - `changeMonitors` (a monitor's setting, acknowledge, resolve), idempotent by key and checked by version
  - `incidentSummary` for the Overview

**Routes:**
- `GET /v1/agent/zoe?view=monitors|incidents`
- `POST /v1/agent/zoe-monitors`, also allowed in `server/agent-bridge.ts`

**Notifications:** `listNotifications` (`server/mentions.ts`) now returns incident notifications, and still never a mention whose conversation or author is gone.

**In the agent app:** `agent/zoe-monitors.tsx`, plus `NotificationsPanel`'s incident item, which opens Zoe's Incidents.

**Seed:** the local relay turns the flag on, and monitors check what real conversations produce. Until there are 20 answers on both sides of the comparison, each says "Not enough answers yet."

## Not included

- **Alerts by email or chat:** phase 12, TODO in `server/zoe-monitors.ts`.
- **Custom monitors** (your own metric and threshold). Intercom's monitors weren't visible during the audit, so built-in ones were the decision.
- **Latency or cost monitors:** latency is shown on Performance, and there's no cost data yet (phase 16).
- **Hour-by-hour charts:** the checks are stored (30 days) for when a chart is wanted.

## Checks

- **`tests/zoe-monitors.test.ts`:**
  - thresholds by sensitivity and direction
  - off by default
  - one check per hour
  - an incident with its numbers, examples and nearby changes
  - managers notified once, and nobody else
  - still sharp, so the same incident is updated
  - managers only
  - another workspace can't see or change it
  - acknowledged, then resolved by itself after two normal checks
  - opened again, then resolved by hand
  - switching the monitor off resolves it and stops it
  - every validation and version conflict
  - the rollback
- **`tests/browser/zoe-monitors.spec.ts`** (ports 9018 and 9019):
  - **Happy path:** a day of "I don't know" opens an incident. The manager's bell shows it, the notification opens Incidents with its examples and nearby changes, and it's acknowledged with a note, seen on the Overview and Monitors, then resolved.
  - **Failure path:** someone acknowledges an incident another person has just resolved, is told it changed, and sees it resolved.
