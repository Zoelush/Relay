# Phase 11, step W1: The workflow engine

Branch `workflows/w1-engine`. Plan: `docs/WORKFLOWS_PLAN.md`. Behind `workflows_v1`, off by default and on for the local relay. Next: W2, the builder.

## What it does

**A workflow is data:**
- one trigger
- who it runs for (conditions)
- lettered paths, each a list of steps ending in END, a jump to another path, a branch (first match wins, else a fallback), or a wait until a condition holds (or times out)

**Editing and publishing:**
- **Drafts** save in any state.
- **Publishing** creates an immutable version. It's refused, naming the first problem (all of them are returned), when:
  - a path can't be reached
  - a way on leads nowhere or to a missing path
  - a branch has no condition
  - a path never reaches an end
  - it names a tag, team, teammate, brand, attribute, SLA policy or ticket type that doesn't exist
- **Versions:** a run finishes on the version it started with. **Rollback** publishes an older version again as the next one. Pause, resume and archive are available too.
- **Priority:** within a trigger, workflows are ordered by priority (reorder).

**Triggers** come from the conversation timeline, each documenting what fires it (`TRIGGERS[…].firedBy`):
- a conversation started, a first message or any customer message
- a teammate reply, a note
- assigned, tagged (optionally one tag), closed, reopened, snoozed
- a conversation attribute changed (optionally one), a customer attribute changed
- a ticket created or its state changed
- an SLA breached
- run manually from the inbox

Changes by Zoe, bulk actions and other workflows fire them too.

Triggers that need later steps or phases (schedule, webhook, page visit, unresponsive, before a breach, email, segments, events) are refused, naming when they arrive.

**Conditions:** nested all/any groups, at most three deep and 25 conditions. They can test:
- **The conversation:** state, priority, assignee, team, tags, brand, channel, the customer's language (from their latest message), conversation attributes, Zoe's state, SLA state.
- **The triggering message's text.**
- **The customer:** signed in, type, verified email domain, attributes.
- **Availability:** office hours, whether a team has someone available.
- **Who made the change.**
- **Whether the last wait timed out.**

Conditions on companies, custom objects, topics, events or segments are refused at save, naming the phase that brings them, never treated as "no match".

**Steps:**
- tag, untag, assign (a teammate, or a team, routed by its method), priority, snooze, close, reopen
- apply or clear an SLA
- set a conversation or customer attribute
- an internal note
- create a ticket
- hand to Zoe, hand to the team
- wait (a duration, or until office hours)

**The run log:** every run has steps recording each node visited, each condition evaluated with what it saw (for example: language *is* fr, actual *fr*, true), and each action with its result and time.
- **Skipped runs:** a workflow that matched but didn't run is recorded as skipped, with why: its own change would start it again, a loop between workflows, more than three in a row, a higher-priority customer-facing workflow ran, or the hourly limit.
- **Reading it:** filterable by workflow, conversation and status.

**Safety:**
- **Limits:** at most 100 steps per run (a loop between paths fails the run with that reason), and 20 runs per conversation per hour.
- **Failures:**
  - **A refusal** (an archived tag, an existing ticket, a close that needs fields) fails that run with its message, rolls back that step, and runs nothing after it.
  - **Anything else** is retried by the job, idempotently per step, then dead-lettered.
  - **The queue:** other workflows and jobs carry on either way.

**In the timeline,** a workflow's changes name it: "Workflow “Triage by language” added the tag Triaged".

## How it works

**Migration `0058_workflows`:**
- `workflows`, `workflow_versions` (immutable), `workflow_runs` and `workflow_run_steps` (append-only)
- `conversations.sla_forced`
- the flag
- **The rollback:** turns the flag off, ends runs in progress as failed, and clears forced SLAs.

**Code:**
- **`lib/workflow-definition.ts`** (shared with the builder from W2): triggers, fields, actions, `validate` and `problems`.
- **`server/workflow-engine.ts`:**
  - **`workflowEvent`:** called from `append` for every part. It maps parts to triggers and queues `workflow.start` only when a live workflow listens, and re-checks condition waits.
  - **`startWorkflows`:** priority order, trigger options, who it runs for, skips and limits.
  - **`runWorkflow`:** one transaction per step, and branches.
  - **`act`:** actions through `command` as a `WorkflowActor`.
  - **Resuming:** `resumeWorkflow` (the `workflow.resume` job), and `resumeDueWorkflows` for the sweep.
- **`server/workflows.ts`:** CRUD, publish, rollback, reorder, manual runs, the run log.
- **`server/conversations.ts`:**
  - `command` and `access` accept a `WorkflowActor`, authored as Relay (`system`, `workflow:<id>`), with `workflowName` and `workflowRun` on its parts.
  - Workflows add notes, but can't message the customer yet (W3).
- **`server/sla.ts`:** honours `sla_forced`.
- **Routes:**
  - `GET workflows[?id=]`
  - `GET workflow-runs[?id=|workflow=|conversation=|status=]`
  - `POST workflow`
  - `POST workflow-run`

## Not included

These come later:
- **The builder UI and the live estimate:** W2.
- **Customer-facing steps, simulation, and the exclusivity rule in practice:** W3. In W1 no step is customer-facing, so every matching workflow runs.
- **Run log pages, the failing alert, templates, the remaining triggers, sub-workflows:** W4.
- **Run log retention:** runs are kept. A retention period belongs with phase 13's data controls.

## Checks

- **`tests/workflows.test.ts`:**
  - **Definitions:** shape and graph checks, later triggers and fields refused, every graph problem worded.
  - **Through real timeline events:**
    - off by default
    - publishing refused for a missing team, then live
    - a French customer tagged and routed, and an English one to the else path, with the steps and condition inputs recorded and the timeline naming the workflow
    - a second message not firing "first message" again
    - the list by trigger, the run log filtered, another workspace can't see it
    - a run pinned to version 1 after version 2 is published
    - rollback creating version 3 from 1
    - a condition wait met by a teammate's tag, kept waiting by an unrelated change with its deadline unchanged, and timing out to close
    - loops: self-start and ping-pong stopped
    - a path loop failing at 100 steps
    - an archived tag failing its run and rolling back that step, with no failed jobs
    - manual runs, refused for non-manual workflows and other workspaces
    - the hourly limit
    - two background workflows both running in priority order, after a reorder
    - the rollback
- **`tests/browser/workflows.spec.ts`** (ports 9028 and 9029):
  - **Happy path:** a workflow published through the API tags and routes a French customer's conversation; the inbox timeline names the workflow, and the run log shows each step and condition.
  - **Failure path:** a broken graph is refused at publish; a step that fails stops its run without changing the conversation, and nothing is dead-lettered.
