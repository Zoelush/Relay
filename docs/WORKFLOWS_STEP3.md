# Phase 11, step W3: Customer-facing steps and simulation

Branch `workflows/w3-customer-steps`. Plan: `docs/WORKFLOWS_PLAN.md`. Behind `workflows_v1`, off by default and on for the local relay. Next: W4, the run log, alerts, templates and the acceptance demo.

## What it does

**Steps that talk to the customer**, in the conversation's own channel (the messenger), shown as "Automation":
- **Send a message.**
- **Show the expected reply time:** the measured reply time or the brand's own phrase; when the team is away, when it's back. The messenger says it in the customer's language.
- **Collect a reply:** asks a question, waits for the answer (up to a set time), and keeps it as:
  - the customer's email address (added unverified)
  - a customer attribute
  - a conversation attribute (as text, an email or a number)

  An answer that doesn't fit is asked for once more; then the workflow goes on without it. No answer in time sets "the last wait timed out" for later conditions.

**New ways on from a path:**
- **Ask with reply buttons:** a question with up to eight buttons, each to its own path. Typing something else, or not answering in time, each have a way on too. Buttons show under the question only while it's the latest message; a click sends the label as the customer's reply, and a typed label counts as choosing it.
- **Let Zoe answer:** she takes the customer's message, and her outcome picks the path:
  - **resolved:** a resolution recorded after the wait began, and not reversed
  - **handed over:** to the team
  - **no outcome in time**

  If Zoe is off, or the conversation is already with the team, it counts as handed over.
- **Call a connector:** a published read connector.
  - **Inputs:** each fixed, or read from a customer or conversation attribute. Context inputs (the customer's email, the conversation's ID) fill themselves.
  - **Outputs:** can be kept in conversation attributes, then tested by later conditions.
  - **Ways on:** "It worked" or "It failed".
  - **Safeguards:** the call runs only for a customer the workspace's verification rules allow (as Zoe's procedures do), and is audited in `ai_connector_calls` as the workflow's. Write connectors are refused, at publishing and in `runConnector`.

**Talking one at a time:**
- **Among workflows:** a workflow with any of these steps (or one that hands to Zoe) is customer-facing.
  - For one trigger, only the highest-priority customer-facing match runs. The others are skipped, saying which ran.
  - While one is still running or waiting in a conversation, no other customer-facing one starts there: "“Triage” is still talking to the customer."
  - Background workflows all run.
- **With Zoe:**
  - She doesn't answer a message a workflow is waiting for, or a first message a customer-facing workflow may still take.
  - When none takes it, she answers as before. When a workflow hands to her, she answers then.
- **Not a teammate:** a workflow's message is its own kind of part (`workflow_message`). It never counts as a teammate's reply: no first response, no SLA, Zoe doesn't step back.
- **Who sees it:**
  - **The customer:** it reaches them like a reply (unread counts, the portal).
  - **Zoe:** sees it in the conversation's history.
  - **Teammates:** see "Workflow “Triage” · to the customer", with its buttons.

**Simulation:** Test, in the builder, runs the draft (unsaved changes included) against a chosen real conversation and lists what it would do.
- **The trace:** every step in words ("Would add the tag “Billing”"), and every condition with what it saw. The paths it takes are lit on the canvas.
- **Effects carry forward:** each step's effect carries to later conditions, so "added the tag" then "has the tag" holds.
- **Decisions:** where only the future decides (a button, typing, no answer, Zoe's outcome, a wait, a connector's result, or who it runs for not matching), there's a likely default and a "Suppose…" choice that re-runs the test.
- **Changes nothing:** its transaction is read-only, so the database refuses any write. Connectors aren't called. Unfinished drafts are refused with what to finish.

## How it works

**Migration `0060_workflow_customer_steps`:**
- `conversation_parts.kind` adds `workflow_message`.
- `ai_connector_calls.source` adds `workflow`.
- An index on waiting runs by conversation.
- **The rollback:** fails runs waiting for a customer's answer or Zoe's outcome, and pauses live workflows that talk to customers. Messages already sent stay.

**Code:**
- **`lib/workflow-definition.ts`:**
  - steps `message`, `reply_time`, `collect`, and `CUSTOMER_STEPS`
  - ways on `buttons`, `zoe`, `connector`, with `outlets`
  - `setOutlet`, now the builder's single way to connect a handle
  - `customerFacing` is real now
- **`server/conversations.ts`:**
  - **Messages:** a workflow's reply is a `workflow_message` (buttons or reply time in its data, only from a workflow); the customer is told of it as of a reply.
  - **Zoe:** is queued for a customer's message, the first one included, only when `workflowHolds` is false.
- **`server/workflow-engine.ts`:**
  - **`workflowEvent`:** sends a customer's message to a run waiting for their answer (`workflow.resume` with `reply`). It re-checks runs waiting for Zoe's outcome on any change, and marks starts that may defer Zoe (`deferAi`) and answers that belong to a run (`answering`).
  - **`startWorkflows`:** skips customer-facing workflows while one is talking, and lets Zoe answer (`answerIfFree`) when none took the message.
  - **`runWorkflow`:** resumes with what the run waited for. A connector call is made between transactions, never inside one; read connectors only, so a retry is harmless.
  - **Wait states:** `reply` (buttons or collect, with the question's part) and `zoe` (since when).
  - **Connectors:** `startWorkflows` and `resumeWorkflow` take the connectors' environment from the worker and the local relay.
- **`server/workflow-simulate.ts`:**
  - `simulateWorkflow` (POST `workflow-simulate`)
  - `simulationConversations` (GET `workflow-conversations?q=`, the latest 20 customer conversations)
- **`server/workflows.ts`:** the builder's options include published read connectors (inputs to give, outputs to keep). Publishing checks connectors, their inputs and attributes, and collected attributes.
- **The builder:**
  - editors for the new steps and ways on (`agent/workflow-parts.tsx`, `agent/workflow-builder.tsx`)
  - path cards say what a path asks or calls
  - a Test panel
- **The messenger** (`messenger/frame.tsx`) shows workflow messages, their buttons, and the expected reply time localized. **The agent timeline** shows them as the workflow's.
- **Seed:** the dev relay adds a draft, "Example: ask what they need" (buttons, reply time, Zoe), once.

## Not included

These come later:
- **Run log pages, the failing alert, templates, the remaining triggers, sub-workflows, the acceptance demo:** W4.
- **Send an email:** phase 12. Reply buttons from custom-object records: phase 01. A ticket form, and turning off customer replies, aren't in the plan's steps. Each is noted in the definition.
- **Write connectors from workflows:** not planned. Writes keep D3's safeguards (approval, signed-in customers, the kill switch) inside Zoe's procedures.
- **Translations:** messages are sent as written; the workflow's author writes in the customer's language. "Asked again" wording is English unless the step gives its own.

## Checks

- **`tests/workflow-customer.test.ts`:**
  - **Definitions:**
    - shape refusals (duplicate or too many buttons, empty questions, attribute names, waits, input sources)
    - handles for each new way on
    - `setOutlet`, and what's customer-facing
  - **Through real messages:**
    - **Buttons:** a greeting and a buttons question, with Zoe not queued and no first response recorded; a button by its label (any case); typing instead, which goes on to Zoe; no answer in time.
    - **One at a time:** a second workflow for the trigger skipped; an "any message" workflow skipped twice while the customer answers; Zoe answering when nothing else takes a first message.
    - **Collecting:** an email asked again, then kept unverified; a number kept in a conversation attribute.
    - **Zoe's outcome:** handed over, and resolved.
    - **A connector:**
      - offered with its inputs, and a missing input blocks publishing
      - refused by the fallback verification rule, with no call made
      - then called: its output kept, audited as the workflow's
    - **Simulation:** effects seen by later conditions; a decision changed; who it runs for not matching, and "run anyway"; nothing written (parts, tags, runs, jobs counted). Another workspace's conversation refused, unfinished drafts refused, agents refused.
    - **The rollback.**
- **`tests/browser/workflow-customer.spec.ts`** (ports 9032 and 9033):
  - **Happy path:**
    - In the messenger: a greeting from Automation, a buttons question, Billing clicked; the buttons go, and the expected reply time follows. Zoe didn't answer.
    - The inbox timeline names the workflow and its buttons.
    - Test against that conversation: shows the decisions and lights the path; supposing "typed instead" takes the other way; nothing changes.
  - **Failure path:**
    - An unverified customer's connector look-up fails over to the team without a call.
    - A typed answer takes the "other" way.
    - A test of an unfinished draft is refused with the reason, which also blocks publishing.
