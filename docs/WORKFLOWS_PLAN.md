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

8. **W2 decisions** (12 October 2026):
   - **The builder is its own area in the strip** (`#workflows`), for managers, with a Settings link card. Intercom keeps Workflows in its AI agent's menu, but Relay's Zoe area exists only while the AI agent is on, and workflows don't need it.
   - **Card positions live in `workflows.layout`,** beside the draft and outside versions, so moving cards is never an unpublished change.
   - **The builder checks drafts with the engine's own `validate` and `problems`;** the server adds missing references.
   - **The live estimate is judged by the engine's own `evaluate`,** over at most 500 conversations from the last 30 days, in one query (about 48 ms). It isn't compiled to SQL, as W1's note planned: the customer's language is detected in code, so SQL couldn't judge it. Conditions that depend on the moment a run starts are taken to hold and named ("at most").

9. **W3 decisions** (13 October 2026):
   - **A workflow's message is its own part kind, `workflow_message`,** shown to the customer as "Automation". It's never a teammate's reply, which would count as a first response and make Zoe step back.
   - **Reply buttons reuse the messenger's choices:** a click sends the label as the customer's reply, and the run matches it.
   - **Customer-facing means talking to the customer, or handing to Zoe.**
     - Only the highest-priority match runs for a trigger.
     - None starts while another is still running or waiting in the conversation.
     - Zoe answers a message only when no workflow holds it: one waiting for that answer, or a customer-facing one that may still start. When none takes it, she answers.
   - **"Let Zoe answer"** waits for her outcome: a resolution recorded after the wait began (not reversed), a handover, or a timeout.
   - **Workflows call read connectors only,** under the workspace's verification rules, audited as the workflow's. A call is made between transactions.
   - **Simulation runs in a read-only transaction,** so it can't write. It applies each step's effect to the facts in memory, and asks "Suppose…" where only the future decides.

Handoffs: `docs/WORKFLOWS_STEP1.md` (W1), `docs/WORKFLOWS_STEP2.md` (W2), `docs/WORKFLOWS_STEP3.md` (W3).
