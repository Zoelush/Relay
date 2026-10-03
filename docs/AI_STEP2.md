# Phase 08, step A2a: handing over to the team

Branch `ai/a2-handover`. Plan: `docs/AI_PLAN.md` (A2 split into A2a and A2b on 3 October 2026, on request). Behind `ai_agent_v1`. Next: A2b, escalation rules, never-handle topics and guidance.

## What it does

**The agent hands a conversation to the team when:**
1. **The customer asks for a person:**
   - with the new **"Talk to a person"** button under a reply the agent couldn't give, or
   - in their own words ("can I talk to a human?") in English, French, Spanish, German or Portuguese
2. **It couldn't answer too many times:** two "couldn't find an answer" replies in one conversation by default (1–5). The second becomes the handover instead.
3. **The customer seems frustrated:** this can be switched off. Asking for a person always hands over.
4. **Office hours:** with "Only outside office hours", while the team is open the conversation goes straight to it, unanswered. Without office hours set up, the agent always answers.

**At handover:**
- **The customer** is told "I'm connecting you with someone from the team. They'll reply here."
- **Teammates** get an **AI handover summary** note:
  - why the agent handed over
  - the customer's first and latest messages
  - how the agent's replies went
  - the sources it used

  It's built from the conversation itself; no model writes it. It's an internal note, so it is never delivered to the customer.
- **Routing:** the conversation moves to the chosen **handover team**, and team routing (phase 06) assigns it. With no team chosen, it waits in Unassigned.
- **The agent stays out** from then on.

**When the team is away** (from the team's calendar, then the brand's, then the workspace's), the agent does one of three things:
- **Say when the team is back** (the default): "Our team is away right now and back Monday, 09:00 AM UTC. They'll reply here then."
- **Take a message:** "Our team is away right now. They'll reply here as soon as they're back."
- **Keep answering until a teammate replies.** Asking again doesn't hand over twice.

**The AI state, beside each conversation's status:**

| State | Meaning |
|---|---|
| Pending | The agent replied and is waiting on the customer |
| Escalated | Handed to the team |
| Needs teammate input | Handed over while the team was away; it becomes Escalated when a teammate replies |

Resolved comes with A3.

**Where teammates see it:**
- **The AI state** shows on conversation cards ("AI: escalated").
- **The inbox menu** has an **AI agent** section with **"Escalated by AI"**, which holds both escalated and needs-input conversations.
- **Saved views** can filter on "AI agent state".
- **"Why this reply"** under the handover message says "Handed to the team" and gives the reason.

**Settings › AI agent** (managers):
- the agent on or off
- when it answers
- the handover team
- answers it couldn't give before handing over
- frustration on or off
- what it does outside office hours

## How it works

**Triggers** (`server/ai-agent.ts`, in the `ai.reply` job):
- **Checked before answering:**
  1. the button's exact words, in any of the five languages (no model)
  2. "Only outside office hours" with the team open (`availabilityFor`)
  3. the classifier
- **Checked after answering:** an "I don't know" or a failed model reply, counted against `failed_limit` from `ai_answers`.

**The classifier** (`server/ai-model.ts`, `ClassifierPort`, prompt version `a2.1`):
- **What it returns:** only whether the customer asks for a person, and their sentiment. It can't answer, act or change anything, so nothing in a message can grant the agent anything.
- **Models:** Claude Haiku 4.5 when deployed (`claudeClassifier`, same key as the answering model). Locally and in tests, `standInClassifier` uses phrase lists.
- **Prompt safety:** the message and history are tagged data blocks, with block tags removed from all data, as in A1.
- **If it fails:** the agent answers with A1's safeguards and the reason records it (decision 2). Two failed answers still hand over.

**Handover** (`handOver`), in the transaction that writes the reply:
- the customer's message, then the summary as an `internal_note` with `data.aiHandover`
- the team change, with an `assignment_change` part
- `conversations.ai_state`, then `afterChange` so routing assigns from the team's queue
- the attempt recorded in `ai_answers` with outcome `escalated`, its `trigger` and the team
- `queueAiReply` queues nothing for a handed-over conversation, unless it keeps answering while the team is away

**AI state:**
- set to pending when the agent replies
- set to escalated or needs input at handover
- needs input becomes escalated when a teammate replies (`server/conversations.ts`)

**Views** (`server/inbox-views.ts`):
- `ai_state` is a filter field. Only the four states are accepted.
- The built-in view `ai:escalated` is seeded by initialize while the agent is on, and archived when it's off.
- The views snapshot says whether it should exist, so the client tops it up.

**Settings:**
- `GET/POST /v1/agent/ai-settings`, allowed through the bridge
- managers only, saved from the version read (409 if it changed)
- idempotent on the request's key
- the handover team must be one of the workspace's own

## Migration

`db/postgres/0044_ai_handover.sql` is additive:
- `conversations.ai_state`
- the agent's handover settings
- `ai_answers.trigger`, `handover_team_id` and the `escalated` outcome
- `ai_escalation_rules`, with row-level security, for A2b

The rollback relabels `escalated` audit rows as `skipped` (their reason still says what happened) and restores the old outcome check. The columns and table stay.

**Seed data:** none needed. The agent's defaults apply, and the handover team is chosen in Settings.

## Not included

- **Escalation rules** (humans-only segments), **never-handle topics** and **escalation guidance:** step A2b.
- **Resolved, and the resolution ledger:** A3.
- **A model-written summary:** the summary is built from the conversation for now. A model could write a richer one once redaction (B2) is in place.
- **Email, SMS and voice:** handovers on those channels wait for phase 12.

## Tests

**`tests/ai-handover.test.ts` (new):**
- **Settings:**
  - agents get 403
  - the defaults
  - four refusals with reasons
  - a stale version gets 409
  - another workspace can't hand over to this one's team
- **Asking for a person in words:**
  - handed over before the answering model is asked
  - routed to Billing and assigned to Grace by round robin
  - the summary is internal, by the AI, with its reason and the first message
  - the customer's own timeline never has it
  - later messages queue nothing
- **The button:** hands over without a classification.
- **Two failed answers:** the second hands over, and the summary counts the failure and quotes the latest message.
- **Frustration:** hands over, and with that switched off the agent answers.
- **A failing classifier:** the agent answers, and the reason says so.
- **Only outside office hours:**
  - while open, straight to the team and the model isn't asked
  - while away, answered
- **Away:**
  - the reply time
  - taking a message (then it stays out)
  - continuing (answers, one summary only, escalated once a teammate replies)
- **No handover team:** escalated and unassigned.
- **The `ai_state` filter:** selects exactly the handed-over conversations and refuses unknown states.
- **"Escalated by AI":** appears after initialize.
- **Classification:**
  - data blocks can't be opened or closed from data
  - only the exact shape parses
  - the stand-in recognises the five languages
  - Claude Haiku's request (model, temperature 0, prefill), and a malformed reply is refused

**`tests/browser/ai-handover.spec.ts` (new; ports 8998/8999):**
- **Happy path:**
  - a manager chooses Billing in Settings
  - the customer gets the refusal, taps "Talk to a person" and is told they're being connected, never seeing the summary
  - the teammate finds it under "Escalated by AI" with "AI: escalated" on the card, reads the summary, and sees "Handed to the team" under the handover
- **Failure path:** with the classifier down, a frustrated customer is still answered from content, and the reason records the outage.

**Updated:** `tests/ai-agent.test.ts`. A refusal now carries the "Talk to a person" option.

## Checks

Results on 3 October 2026:
- `npm test`: 109/109 pass.
- `npm run typecheck`: clean.
- Lint shows nothing new (an existing error and warning in `agent/views.tsx` are unchanged).
- `npm run test:e2e`: 94/94.
- `npm run test:postgres`: passes.
- **Checked in the browser:** the Settings › AI agent page, and the "Escalated by AI" view in the inbox menu.
