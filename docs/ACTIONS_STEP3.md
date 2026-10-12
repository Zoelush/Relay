# Phase 09, step D3: Write actions

Branch `ai/d3-write-actions`. Plan: `docs/ACTIONS_PLAN.md` (decision 8). Behind `ai_actions_v1`, off by default and on for the local relay. Next: D4, OAuth on the workspace's behalf and the audit view.

## What it does

**A connector can now write (change things):**
- **Defining one:** a connector is Read or Write. A write uses POST, PUT, PATCH or DELETE, and has two settings:
  - **Approval:** a teammate approves each write (the default), or none is needed.
  - **An optional idempotency header:** Relay sends the same key on every attempt at one write, so the service can tell retries apart. Without one, a write is never retried, and a definition that asks for retries without one is refused.
- **Turning writes on:** Zoe may use a write connector only after a manager turns its writes on, past a warning that says what Zoe will be able to do. Who turned them on, and when, is shown. A procedure that uses a write connector can't be published until its writes are on.
- **The kill switch:** "Pause all write actions" on the Actions page stops every write in the workspace at once, for Zoe and the test console. The customer is told plainly and handed over.

**Writes in procedures:**
- **Steps:** a step can say `Use <connector>.` or `Run <connector>.` as well as `Look up`. The compiled plan says "Change something with X: a signed-in customer only, after a teammate approves it."
- **A signed-in customer only:** a write needs a customer the website verified, whatever the verification rules allow. An unverified customer is told and handed over, and nothing is sent. This is the phase's acceptance test.
- **Approval, when the connector asks for it:**
  - **The request:** Zoe tells the customer she's asked a teammate. A team-only note in the conversation says what would be sent (sensitive inputs redacted, missing ones shown as "—") and carries the card: a note, **Approve**, **Deny**. Anyone who can reply in conversations can decide, once.
  - **Approved:** the write runs (in a job) and the procedure carries on where it stopped.
  - **Denied:** she says a teammate decided not to go ahead, and hands over. Nothing is sent.
  - **No decision in 24 hours:** it expires, she says so, and hands over.
  - **While it waits:** a customer message gets "A teammate still needs to approve this." Asking for a person cancels the approval.
- **Never twice:**
  - **With an idempotency header:** a write is retried with the same key.
  - **Without one:** it's sent once only. A timeout says "it may have gone through" in the handover note.
  - **A retried job:** one that already ran an approved write never sends it again; it hands over, saying so.

**Audit:** each write's row records the approval it ran under and the idempotency key it was sent with. The approval card shows whether it worked.

## How it works

**Migration `0056_ai_write_actions`:**
- **`ai_connectors`:**
  - `access` can be `write`
  - `writes_enabled`, with who turned it on and when
- **`ai_agents.writes_paused`:** the kill switch, with who and when.
- **`ai_action_approvals`:**
  - one pending per run
  - what would be sent
  - its note, expiry and decision
- **`ai_connector_calls`:** `approval_id` and `idempotency_key`.
- **The rollback:**
  - It archives every write connector, because the previous version would call one like a read.
  - It turns writes off and pauses every workspace.
  - It cancels pending approvals and ends the runs waiting on them.

**Code:**
- **`lib/connector-definition.ts`:** access, methods per access, `approval`, `idempotencyHeader`.
- **`server/connectors.ts`:**
  - `runConnector` refuses a write while paused, or (for Zoe) while its writes are off. It sends the idempotency key and retries a write only with one.
  - New actions: `writes` (needs `acknowledged`) and `pause`.
- **`server/procedures.ts`:**
  - **`advance`:** the plan runner, shared by a customer's message (`procedureTurn`) and a decision (`resumeTurn`).
  - **The key:** a write's idempotency key is derived from the run and step.
  - **The rest:** `readApproval`, `decideApproval` and `expireApprovals` (the sweep).
- **`server/ai-agent.ts`:**
  - `postProcedureTurn` writes the approval and its note, what she says, and the handover or wait.
  - `runProcedureResume` is the `procedure.resume` job.
- **Routes:**
  - `GET ai-approval?id=` (conversations.read)
  - `POST ai-approval` (conversations.reply)
- **In the agent app:** `agent/timeline.tsx` (the approval card on Zoe's note), `agent/zoe-actions.tsx` (access, approval, idempotency header, the Writes card, the kill switch).

## Decisions

- **Who can approve:** anyone who can reply in conversations (the people already looking at it), not only managers.
- **No partial-success retries without a key:** the definition refuses retries on a write without an idempotency header.
- **Writes are for signed-in customers only,** regardless of verification rules, which can only loosen look-ups.
- **The kill switch also stops the test console,** so a paused workspace sends nothing at all.

## Not included

- **Notifying teammates about a pending approval:** for now the note marks the conversation unread for them, and the Procedures page shows runs "Waiting for approval".
- **The audit view for one conversation, and OAuth on the workspace's behalf:** D4.
- **An approval card in the messenger's email fallback:** phase 12.

## Checks

- **`tests/write-actions.test.ts`:**
  - **The definition:** methods per access, and no retries without an idempotency header.
  - **Through the real reply job and the resume job, against recorded responses:**
    - writes turned on only past a warning, by managers
    - a procedure can't publish until writes are on
    - **an unverified customer is refused, and nothing is sent** (acceptance)
    - an approval is requested with its team-only note, and nothing is sent until it's decided
    - a customer writing meanwhile
    - another workspace can't read or decide it
    - approved: sent once with its key, carried on, resolved, audited
    - a retried resume job doesn't resend
    - denied, expired, and cancelled by a person request
    - a timeout retried with the same key, then handed over as possibly done
    - no key, no retry
    - the kill switch stops Zoe and the test console
    - writes turned off stop Zoe
    - the rollback
- **`tests/browser/zoe-write-actions.spec.ts`** (ports 9024 and 9025):
  - **Happy path:** writes turned on in the UI past the warning. A signed-in customer asks to cancel, a teammate approves on the card in the inbox, and the customer is told it's done. The note never reaches them.
  - **Failure paths:** a visitor is refused; a paused workspace hands a signed-in customer over without sending anything.
