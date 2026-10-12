# Phase 09, step D2: Procedures

Branch `ai/d2-procedures`. Plan: `docs/ACTIONS_PLAN.md` (decision 7). Behind `ai_actions_v1`, off by default and on for the local relay. Next: D3, write actions.

## What it does

**Zoe › Train › Procedures:** a procedure is a task Zoe carries out step by step. It has:
- **When it starts:** keywords, checked in code.
- **What to collect:** each value has a question she asks and, optionally, a pattern, which lets her find the value inside a longer message, including the first one.
- **Steps:** numbered lines, one action each:

  | Action | What it does |
  |---|---|
  | `Ask for <name>.` | Asks for a value, unless it's already known |
  | `Look up <connector>.` | Calls a published connector |
  | `If <value> is` / `is not` / `contains "text"`, `go to step <n>.` | Branches on a value |
  | `If <value> is empty` / `is not empty`, `go to step <n>.` | Branches on a missing value |
  | `Say "text with {{value}}".` | Says something, filling in values |
  | `Go to step <n>.` | Jumps to a step |
  | `Resolve.` / `Hand over.` / `Stop.` | Ends the procedure |

- **What she says if a look-up fails,** before she hands over.

**Compiling and publishing:**
- **Every save compiles the steps** into a fixed plan, shown in words beside them ("What Zoe will do"), or names the step to fix. Compiling checks:
  - every value mentioned is collected or looked up
  - every connector exists and is published
  - a connector's customer inputs are collected
  - jumps go to real steps
  - the plan ends properly
- **Publishing** creates an immutable version. A conversation keeps the version it started with.
- **Archiving** stops runs in progress.

**In a conversation** (the reply job, before her usual answer):
- **Starting:** a published procedure's keywords start it, and values with a pattern are taken from that first message.
- **Each customer message moves it on:**
  - **The plan decides** what happens. She asks, says, looks up and branches only as written, so nothing a customer writes can change the steps.
  - **An input she can't find** gets one retry message, then another; after three failed tries she hands over.
- **Leaving it:** asking for a person (the button, or in words, by the classifier) or a matching escalation rule ends it. Her usual handover then takes the message.
- **Its end:**
  - **Resolve:** a reply, and the conversation waits on the customer.
  - **Hand over:** her usual handover, to the team, with a summary note saying which procedure, the steps taken and why.
  - **Stop:** she answers as usual from then on.
- **When a look-up fails** (timeout, error, refused credentials, unexpected response, unpublished connector), she says the failure message and hands over. The conversation is never left hanging.

**Verification** (on the Procedures page) is checked before every look-up:
- Rules for the messenger (email waits for phase 12), with the same conditions as escalation rules, each requiring a signed-in customer or allowing anyone. The first that matches decides; otherwise the fallback does.
- The fallback is **Require a signed-in customer** by default. *Signed in* means the website verified who they are (the messenger's signed identity).
- A customer who doesn't qualify is told "I can only look that up for customers who are signed in." and handed over. No connector runs.

**Records:**
- Every turn is an answer record (outcome *procedure*, or *escalated* with the trigger *procedure*), with its run.
- Performance counts "Followed a procedure."
- Recent runs on the Procedures page show how each ended.

**Fixed phrases** (didn't catch that, verification, failure, anything else) are in her nine languages. A native speaker should check them.

## How it works

**Migration `0055_ai_procedures`:**
- `ai_procedures` and `ai_procedure_versions` (immutable)
- `ai_procedure_runs`: one waiting per conversation, with the step, the input awaited, retries and values
- `ai_answers`: the outcome `procedure`, and `procedure_run_id`
- `ai_agents.verification_rules` and `verification_fallback`
- **The rollback:** ends waiting runs, so the previous version answers as usual.

**Code:**
- **`lib/procedure-plan.ts`** (shared with the page): `validSource`, `compile`, `describe`, `fill` and `holds`.
- **`server/procedures.ts`:**
  - `procedureTurn` runs the plan. Connector calls go through `runConnector`, on the conversation's pinned version, outside any transaction. It returns a `commit` that writes the run in the reply's transaction, and is skipped if the run moved on meanwhile.
  - `verified` applies the rules.
  - It also holds the reads and changes.
- **`runAiReply`** (`server/ai-agent.ts`) asks `procedureTurn` first, posts what it says, and hands over with the trigger `procedure`. A classifier call it makes is recorded like any other model call (B2b).
- **The reply job's environment** carries the connector settings (`AiEnvironment.connectors`), in the worker and the local relay.

**Routes:**
- `GET zoe?view=procedures|procedure`
- `POST zoe-procedure`

## Decisions

- **The compiler is deterministic.** The numbered-steps grammar is the source of truth, and the compiled plan is shown before publishing. The plan said Claude would draft plans when a key is set. Without a key that can't be built or tested, so it waits for the key and would only ever produce the same grammar for review.
- **Zoe's words in a procedure are the workspace's own** ("Say" steps and questions), not the model's. Phrasing them with the model, and extracting values without a pattern, come when Claude is available.
- **Verification falls back to signed in by default:** secure unless a workspace says otherwise.

## Not included

- **Write actions, approvals and the kill switch:** D3.
- **Email and SMS verification codes:** phase 12.
- **Testing procedures in the Playground** (it never writes, and procedures call connectors): a simulated conversation could come later.
- **Procedures resolving into the A3 ledger:** a resolved procedure doesn't record a billable resolution yet. That's for phase 16's billing to decide.

## Checks

- **`tests/procedures.test.ts`:**
  - **Compiling:** a plan and its description, and every compile error with its step.
  - **Through the real reply job, against recorded responses:**
    - off by default
    - managers only
    - another workspace can't see it
    - drafts that don't compile can't be published
    - versions are immutable
    - an unverified customer is handed over and nothing is called
    - a verification rule
    - the number in the first message: looked up, branched, resolved, audited
    - asked for, retried, then answered
    - **a timeout:** the customer is told plainly and handed over, with a teammate-only note (acceptance)
    - a person asked for mid-procedure
    - three failed tries
    - a run keeps its version when a new one is published
    - messages without keywords
    - archiving ends runs
    - the rollback
- **`tests/browser/zoe-procedures.spec.ts`** (ports 9022 and 9023):
  - **Happy path:** a procedure written in the UI, compiled and published. An unverified visitor is told and handed over; after a verification rule, the next visitor gets their order. Recent runs show both.
  - **Failure path:** a look-up that times out ends in a clean handover.
