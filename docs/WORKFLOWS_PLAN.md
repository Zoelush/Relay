# Phase 11: The workflow builder (plan)

Brief: `docs/BUILD_PHASES.md` phase 11. Phase 10 (the agent copilot) was skipped at the user's request; phase 11 needs only phases 5, 6 and 8. Approved on 12 October 2026 ("go ahead with W1").

| Step | Scope |
|---|---|
| **W1: Engine** | Workflows stored as data, with a draft, a live version, immutable versions and rollback; runs finish on their version. Triggers from the timeline. Nested and/or conditions. Background actions. Waits (a duration, office hours, a condition with a timeout). A run record per execution. Loop protection, hourly limits, failure isolation, retries and dead letters. API only. |
| **W2: Builder** | The list grouped by trigger, with drag-to-reorder priority. A canvas (drag, connect, zoom, undo and redo) with path editors. A live estimate of matching conversations. Publishing blocked with clear messages. Versions and rollback. |
| **W3: Customer-facing steps and simulation** | Messages, reply buttons with branches, collecting a reply or attribute, the expected reply time, Zoe's outcome and connector results as branches. Simulation against a real conversation without side effects. |
| **W4: Run log, alerts, templates, acceptance** | Run log pages, filterable. An alert when a workflow keeps failing. Ten templates. More triggers: schedule, inbound webhook, page visit, unresponsive customer, before an SLA breach. Reusable sub-workflows. The acceptance demo. |

## Seen in Intercom's Workflows (12 October 2026, read-only)

- **The list is grouped by trigger.** Each group says that only the top customer-facing workflow that matches will run, and teammates drag to reorder.
  - **Each row shows:** its state (live, paused or draft), who updated it, and its sent, engaged and completed counts.
  - **Filters:** people type, state, channel and type.
- **A workflow is a trigger card followed by lettered paths.** Each path is a card holding a sequence of steps (a message, let the customer type, collect data, let Fin handle it, assign, show the expected reply time). Branches and buttons lead to other paths, and every path ends in END. One workspace workflow has about 30 paths.
- **Around the canvas:** Workflow, Overview and Path Analysis views; Preview and Edit; zoom, pan and auto-layout; and a "List of paths" view.
- **Templates** come in six categories: Popular, Fin AI Agent, Teammate efficiency, End user experience, Message proactively and Connect apps.
- **No per-run log:** totals only (the audit found the same).

## Decisions

1. **The shape of a workflow is Intercom's.** Each canvas node is a lettered path of steps, ending in END, a jump to another path, a branch (first match wins, else a fallback), or a wait until a condition holds (or times out). It's a directed graph with one trigger root, stored as data.
2. **One trigger, several workflows:** only the highest-priority customer-facing workflow that matches runs, while background-only workflows all run. Each workflow that matched but didn't run is recorded as a skipped run, saying why.
3. **Changes by Zoe, bulk actions and workflows fire triggers too,** unlike Intercom.
   - A condition can test who made the change.
   - A workflow's own change never starts it again.
   - Chains of workflows starting each other are stopped after three, or on a loop.
   - Each trigger documents what fires it.
4. **The canvas uses `@xyflow/react`** (React Flow, MIT), from W2.
5. **Triggers, conditions and actions that need later phases are refused when saving or publishing, naming that phase,** rather than falling through to "no match":
   - inbound email (phase 12)
   - segments and outbound series (13)
   - topics and events (14)
   - Slack and outgoing webhooks (15)
   - companies and custom objects (01)
6. **The flag is `workflows_v1`,** off by default.
7. **W1 decisions** (12 October 2026):
   - **Conditions are evaluated in code** against a snapshot of facts, so the run log shows each one's inputs. W2's live estimate will compile the conversation-level ones to SQL.
   - **Actions go through `command`** as the workflow (an actor acting as Relay, named in the timeline), so SLAs, routing and unread counts behave exactly as for a teammate's change.
   - **Each step is its own transaction,** idempotent per run and step.
   - **Waits resume from the scheduled sweep;** jobs have no delay.
   - **"Apply an SLA"** sets `conversations.sla_forced`, which SLA matching honours.
   - **Limits:** at most 100 steps per run, 20 runs per conversation per hour, and 3 workflows in a chain.

Handoffs: `docs/WORKFLOWS_STEP1.md` (W1).
