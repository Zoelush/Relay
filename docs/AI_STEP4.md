# Phase 08, step A3: the resolution ledger

Branch `ai/a3-resolutions`. Plan: `docs/AI_PLAN.md`. Behind `ai_agent_v1`. Next: B1, configuration (several agents, identity, guidance that shapes answers, content targeting, language, formality and length).

## What it does

**A conversation counts as resolved by the AI agent in exactly two ways:**
1. **Confirmed:** the customer taps **"That helped"** under an answer the agent gave from your content. It sits beside "Talk to a person", in the customer's language. It's an action, not a message, so the agent doesn't reply to it beyond a short thanks: "Glad that helped! If you need anything else, just write here."
2. **Quiet window:** the conversation must meet all of these:
   - the agent's last reply was an answer from content (not "I don't know", a clarifying question or a greeting)
   - the customer didn't write again within the **resolution window** (24 hours by default; 1, 4, 12, 24, 48 or 72)
   - the conversation was never handed over, never replied to by a teammate, and never assigned

**Never counted:** handed-over conversations, refusals, clarifying questions, and conversations a teammate has taken on.

**The ledger** (`ai_resolutions`), append-only:
- **What a row records:** the conversation, the agent, the rule (`confirmed` or `quiet_window`), the answers it rests on (their `ai_answers` ids and reply parts in the thread), the window, a plain-language detail and the time.
- **Reversals:** if a resolved conversation is handed to the team **within the window**, a **reversal** row is added (`handed_over`), naming the resolution. After the window, a resolution stands. Billing (phase 16) reads the net.
- **One standing resolution per conversation:** a customer coming back after a resolution is answered as usual (the AI state returns to pending), but a second resolution isn't recorded while the first stands.
- **Rows are never changed or deleted;** the database refuses.

**Where people see it:**
- **The conversation's AI state** becomes **Resolved** ("AI: resolved" on the card).
- **The teammate's timeline** says:
  - "Resolved by the AI agent: the customer said the answer helped", or
  - "…: no reply within 24 hours of its answer", or
  - "AI resolution reversed: handed to the team within the resolution window"
- **The customer** sees only the thanks after confirming.
- **Settings › AI agent › Resolutions:**
  - the window
  - the last 30 days (net, and recorded/reversed when there were reversals)
  - the latest 20 rows: rule, conversation title, time, detail, the number of answers and the conversation id, to check against the thread

## How it works

**`server/ai-resolutions.ts`:**
- `recordResolution` writes the row, sets `ai_state='resolved'` and adds an internal `ai_resolved` event, unless a resolution already stands.
- `reverseOnHandover` is called from `handOver` (A2a); it adds a reversal within the window.
- `resolveQuiet` is the sweep. It runs every second locally (the maintenance loop) and on each workspace sweep when deployed. It pre-selects pending, unassigned conversations quiet for longer than the window, then re-checks each under a lock in its own transaction:
  - the last public message is an AI answer from content, older than the window
  - no teammate reply
  - no escalation
- `resolutionSummary` builds the Settings view.

**"That helped":**
- an answer's part data carries `confirm` (the button words and the thanks, in the customer's language)
- the messenger sends the `ai_helped` command (customers only, on their own conversation)
- `confirmAiHelped` checks the part is an AI answer with `confirm`, the conversation isn't handed over, and the agent is on

## Migration

`db/postgres/0046_ai_resolutions.sql` is additive:
- `ai_agents.resolution_window_hours`
- `ai_resolutions`:
  - row-level security
  - a trigger refusing updates and deletes
  - checks tying reversals to their resolution and rule
  - one reversal per resolution

The rollback leaves the ledger untouched (it is billing evidence); the previous version ignores it.

## Not included

| Item | When |
|---|---|
| Billing from the ledger | Phase 16 |
| Opening a ledger row's conversation from Settings (the id is shown) | When the agent app gets conversation links |
| Resolution reporting over time | Phase 14 |

## Tests

**`tests/ai-resolutions.test.ts` (new):**
- **Confirmed:**
  - the answer's buttons in the customer's language
  - one row with the answer and reply ids, the window and the detail
  - resolved state, an internal event and the thanks
  - again: nothing new
  - a refusal can't be confirmed, nor another customer's conversation
- **Quiet:**
  - not before 24 hours, recorded after
  - never after "I don't know", a greeting, a teammate taking it on, or a handover
- **A returning customer:** answered again, back to pending, still one resolution.
- **Reversal:** a handover within the window adds a reversal; after the window there's none.
- **The ledger is append-only.**
- **Settings:**
  - the counts net of reversals
  - the window validated and saved
  - a one-hour window resolves after two hours
- **Another workspace:** sees nothing and can't record against these conversations.

**`tests/browser/ai-resolutions.spec.ts` (new; ports 9004/9005):**
- **Happy path:**
  - the customer taps "That helped" and gets the thanks; the buttons go
  - one confirmed ledger row
  - the card shows "AI: resolved" and the timeline says why
  - Settings shows "Last 30 days: 1 resolution." and the row
- **Failure path:** a customer who gets "I don't know" has no "That helped", and days later the sweep still doesn't count it.

**Updated:** `tests/ai-agent.test.ts`. An answer now carries the confirm buttons.

## Checks

Results on 3 October 2026:
- `npm test`: 111/111 pass.
- `npm run typecheck`: clean.
- Lint: clean on the changed files.
- `npm run test:e2e`: 98/98.
- `npm run test:postgres`: passes.
- **The messenger's buttons** were checked by the browser tests (visible, clicked, gone after use), not by a screenshot.
