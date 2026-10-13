# Phase 11, step W4: The run log, alerts, templates, more triggers and the acceptance demo

Branch `workflows/w4-runlog-alerts-templates`. Plan: `docs/WORKFLOWS_PLAN.md`. Behind `workflows_v1`, off by default and on for the local relay. This step completes phase 11. The acceptance demo is `docs/WORKFLOWS_ACCEPTANCE.md`.

## What it does

**The run log** (Workflows › Run log, `#workflows/runs`; one workflow's at `#workflows/runs/<id>`):
- **Every run, newest first,** 50 a page with "Older runs". Filter by workflow, outcome (completed, failed, skipped, running, waiting), trigger and conversation ID.
- **Each run opens** to every node visited, every condition with what it saw (✓ or ✗, and the actual value), and every action with its inputs, result and time. Its conversation is a click away.
- **From the builder,** Runs opens that workflow's.
- **Retention:** runs are kept. A retention period belongs with phase 13's data controls, as W1 said.

**The failing alert:**
- **Opening:** three failed runs of a workflow in a row (skipped runs don't count) open an alert, and everyone who manages the workspace is notified once. "A workflow keeps failing" opens its failed runs.
- **Where it shows:**
  - a red banner on the list, the run log and the builder, with the failures so far and the last error
  - the row says "Failing"
- **Closing:** the next run that completes closes it ("recovered"), or a manager dismisses it.

**Reusable workflows:**
- **The trigger:** "Used by other workflows" never fires on its own.
- **Passing to one:** "Pass to a reusable workflow", a way on, ends the run and starts the reusable workflow's own run for the conversation, in the same chain. Loops and long chains are stopped as for workflows that start each other.
- **Publishing** is refused when the target isn't a live reusable workflow, or is itself.
- **Testing:** the builder's Test stops at the pass, naming it.

**More triggers:**
- **On a schedule:**
  - **When:** every hour (at a minute), day, weekday or week (a day), at a time in a time zone. Clock changes are followed.
  - **What it runs for:** each conversation that isn't closed, at most 500 a time, oldest activity first, that "who it runs for" lets through.
  - **The first check after publishing** only sets the next time.
- **The customer hasn't replied:** once the team's, Zoe's or a workflow's last message has gone unanswered for the time set. Once per message.
- **An SLA is about to be breached:** the time set before an SLA target is due. Once per target.
- **The customer visits a page:**
  - **What fires it:** the messenger reports the page (it already did, for Zoe's rules). A live workflow fires for the customer's conversation that isn't closed, when the address contains what's set. Once per page per conversation.
  - **"The page they're on"** is a new condition.
  - **Not yet:** a visit with no conversation doesn't start one. That's proactive messaging (phase 13).
- **Another system calls its webhook:**
  - **The call:** `POST /v1/hooks/<workspace>/workflows/<id>`, with the workflow's secret as a bearer token and an `Idempotency-Key` (a retry answers the same and starts nothing new).
  - **The body** names `conversationId`, or a customer by `userId` or `email` (their latest conversation that isn't closed). Its flat `data` (strings, numbers, booleans) is kept with the run for the new condition "The webhook's data".
  - **The secret:** made in the builder and shown once. Only its hash is kept, and never in the idempotency record. Replacing it stops the old one.
  - **Refusals:** a wrong secret, an unknown workflow or another workspace's address get one answer (401). The workflow must be live with this trigger. At most 60 calls a minute.

**Templates:** the brief's ten, under New workflow › Start from, by category. Each asks for the tags and teams it needs, then opens as a draft:

| Template | Notes |
|---|---|
| Triage and route by topic | Words in the message; topics arrive with phase 14. |
| Out-of-hours autoresponder | |
| VIP fast lane | |
| Collect email before chat | |
| Qualify a lead | |
| Escalate on negative sentiment | Words; Zoe's classifier isn't a workflow condition. |
| Close stale conversations | Check in once, close if still quiet. |
| Request a rating after closure | |
| Alert on SLA breach | Slack arrives with phase 15. |
| Route by language | |

**The acceptance demo** (`docs/WORKFLOWS_ACCEPTANCE.md`), run by `tests/browser/workflow-operations.spec.ts`: a workflow that tags, routes by language, waits for office hours, hands to Zoe and escalates when she can't resolve it. Its run log is shown for three conversations; then it's broken on purpose and raises the alert.

## How it works

**Migration `0061_workflow_operations`:**
- `workflow_alerts`: one open per workflow.
- `notifications`: kind `workflow_alert`, with `workflow_alert_id`.
- `workflow_runs`:
  - `trigger_key`: unique per workflow, conversation and occurrence, so a time or page trigger fires once.
  - `trigger_data`: the page, or the webhook's data.
- `workflows`: `hook_secret_hash` and `schedule_next_at`.
- `workflow_ticks`: the sweep's once-a-minute check.
- **The rollback:** closes alerts and removes their notifications, clears webhook secrets, and pauses live workflows using the new triggers or passing to a reusable one.

**Code:**
- **`lib/workflow-definition.ts`:**
  - triggers `schedule`, `unresponsive`, `sla_before_breach`, `page_visit`, `webhook`, `reusable`, with their options checked
  - conditions `page.url` and `trigger.data`
  - the way on `workflow`, which counts as an end
- **`lib/workflow-templates.ts`:** the ten templates and `fromTemplate`.
- **`server/workflow-triggers.ts`:**
  - **Time:** `checkTimedWorkflows`, the sweep's per-minute check, queues `workflow.timed`. `runTimedWorkflows` (that job) finds what's due as of the sweep's minute and queues starts. `nextOccurrence` computes a schedule's next time.
  - **Browsing:** `pageVisited` is called from `/v1/messenger/context`.
  - **Webhooks:** `newHookSecret` and `receiveWebhook`.
- **`server/workflow-engine.ts`:**
  - `finish` watches failures (`watchFailures`)
  - starts carry `key` (fire once) and `data`, and facts include the page and the webhook's data
  - `workflow` passes on
- **`server/workflows.ts`:**
  - **Lists:** the list includes alerts, templates and what their slots are filled with. The run log filters by trigger and pages with `before`.
  - **Actions:** `hook_secret` (outside the idempotency record) and `dismiss_alert`; `create` takes `template` and `slots`.
  - **Publishing** checks reusable targets.
- **The agent app:**
  - `agent/workflow-runs.tsx`: the run log and alert banners
  - `agent/workflows.tsx`: the Run log entry, alerts and templates
  - `agent/workflow-builder.tsx`: trigger options, the webhook panel, pass-on, Runs, and the alert
  - `agent/notifications.tsx`: workflow alerts
- **Runtimes:** the worker and local relay run `workflow.timed` and the per-minute check.

## Checks

- **`tests/workflow-operations.test.ts`:**
  - **Definitions and templates:**
    - each template valid and complete with its slots filled; a missing slot refused in words
    - schedules' next times: daily, weekdays, weekly, hourly, and across the end of summer time
    - the new triggers' options checked
  - **Through real conversations:**
    - **Alerts:** opened at the third failure in a row, managers notified once, the count kept, closed by a completed run, and dismissed.
    - **The run log:** filtered by workflow, outcome, trigger and conversation; 68 runs paged 50 and 18; another workspace sees none.
    - **Reusable workflows:** a pass to a draft refused at publishing, then passed to live (chain recorded); passing to itself refused.
    - **Time triggers:**
      - the unresponsive trigger fires only for unanswered messages that are due, once each, and not before its time
      - the SLA trigger fires once per target
      - a schedule's first check only sets its time, then it runs where who it runs for matches
    - **Page visits:** only matching addresses, once per page.
    - **Webhooks:**
      - **Refused:** without the secret, while a draft, without a key, on another workspace's address.
      - **Accepted:** a retry answers the same; data that doesn't match runs nothing; matched by email (any case); no conversation or no target refused.
      - **Kept apart:** only the data's flat values are kept, and the secret is never stored.
    - **Templates through the API.**
    - **The rollback.**
- **`tests/browser/workflow-operations.spec.ts`** (ports 9034 and 9035):
  - **Happy path:** the acceptance demo.
  - **Failure path:**
    - a template created with its teams chosen in the form
    - a webhook made and published in the builder, refusing a wrong secret and a missing key, then starting the workflow
    - a failing workflow's alert dismissed from the list
