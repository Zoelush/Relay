# Phase 08, step Z3a: Zoe's specialists

Branch `ai/z3a-specialists`. Plan: `docs/AI_PLAN.md` (Z3 split on 4 October 2026, decision 10). Behind `ai_agent_v1`. Next: Z3b, content targeting.

## What it does

**Train › Specialists** (`#zoe/specialists`): narrower versions of Zoe for one job each, after Beacon's specialists. Customers always see Zoe; specialists are how she's organised.

**Each specialist has:**
- **Name:** up to 60 characters, unique.
- **What she handles:** up to 500 characters. It's her instructions, and how the classifier picks her.
- **Keywords:** up to 20, whole words in any language, checked in code, so she's picked even when the model is down.
- **Only when** (optional): conditions on the customer and conversation (signed in, email domain, brand, language, page address, tag, conversation attribute), the same closed list as escalation rules, with all or any.
- **Her knowledge:** all of Zoe's content, or only chosen help center collections (with their sections), websites, snippets and files.
- **Hands over to:** a team, or Zoe's handover team.
- **On or off.**

**Limits and saving:**
- **At most 10.**
- **Saving:** each saves on its own, from the version the page loaded (refused if it changed elsewhere), idempotently.
- **Removing:** removing her archives her, so answers and conversations keep her name. Removing is refused while guidance applies only when she answers; the refusal names those guidelines.

**Who answers:**
1. At a conversation's first real question, the candidates are the specialists that are on and whose conditions hold, or who have none.
2. Her keywords pick her first, in code.
3. Otherwise the classifier picks one by what she handles (deployed: Claude Haiku; locally: her name as words, or a phrase her job quotes).
4. Otherwise Zoe answers herself.
5. The choice is kept for the conversation, and **a greeting doesn't settle it**, so "Hello!" then a billing question still reaches Billing.
6. A specialist removed or switched off leaves her conversations to Zoe herself.

**How she answers:**
- **Her knowledge:** only content in her knowledge, filtered in PostgreSQL before ranking, so she can't cite content meant for another part of the business.
- **Her job:** given to the model in the guidance data block. A question outside it gets "I couldn't find an answer". After the failed-answer limit she hands over to **her team**.
- **The handover note says so:** "Handed over by Zoe (Billing specialist)."

**Guidance per specialist:**
- **Targeting:** on the Guidance page, a guideline can apply "Always" or "Only when Billing answers". The specialist's card lists her guidelines.
- **Spam guidance** is about the message, so it always applies.
- **Restoring:** a version naming a removed specialist brings those guidelines back switched off.

**Try it**, beside the list:
- **As a specialist being edited:** with the unsaved changes.
- **As a saved one.**
- **As Zoe would route it:** "Let Zoe pick".

It shows who answered and why ("Answered as Billing: the keyword “refund”", or "Zoe herself") and writes nothing. The Playground gets "Answer as" too.

**For teammates:**
- **Labels:** Zoe's replies read "Zoe · Billing · AI agent", per reply, from her answers' records (never from the reply's own data, which reaches the customer).
- **"Why this reply":** shows the specialist and why she took the conversation.
- **Performance:** a "Who answered" breakdown.
- **Overview:** a Specialists card.

## How it works

**`server/zoe-specialists.ts`:**
- **Validation:** `validSpecialist`. Conditions go through the escalation rules' `validRules`.
- **Saving:** `saveSpecialist` and `changeSpecialist` (idempotent).
- **Reading:** `readSpecialists`, which includes the choices: collections, websites, teams, brands, tags, attributes.
- **Routing helpers:** `candidatesFor` (conditions via `matchRule`), `byKeyword` (via `matchKeywords`), `scopeOf` (her knowledge for retrieval).
- **Playground drafts:** `draftSpecialist`.

**`server/ai-retrieval.ts`:** a `scope` option. The allowed set keeps only records:
- placed in her collections or their sections
- that are pages of her websites
- that are snippets or files when she has those

All of it in the same CTE as the other access rules, before keyword or vector ranking.

**`server/ai-agent.ts`:**
- **In `decide()`:**
  - routing: the Playground's specialist, the conversation's, or keywords; then the classifier's pick, in the same call as the handover triggers
  - her knowledge for retrieval
  - her guidance and job for the model
  - her team for handovers and office hours
- **In the reply job:**
  - settles `conversations.ai_specialist_id` and `ai_routed_at` at the first real question, or a handover
  - records `specialist_id` and `specialist_reason` on each answer

**`server/ai-model.ts`:**
- **The prompt** (`PROMPT_VERSION` z3.1): "[Her job]" heads the guidance block, and a rule says to answer only questions within it.
- **The classifier** (`CLASSIFY_VERSION` z3.1) returns `specialist`.

**Routes:**
- `GET /v1/agent/zoe?view=specialists`
- `POST /v1/agent/zoe-specialist` (create, change from a version, or `remove`)
- `zoe-playground` takes `specialistId` or `specialist` (a draft)
- the inbox snapshot's `ai.specialists` names them
- all managers only, with the agent on

**The agent app:**
- **The page:** `agent/zoe-specialists.tsx`.
- **Shared condition rows:** `ConditionRows` in `agent/settings-ai.tsx`, used by escalation rules and specialists.
- **Labels:** the timeline labels replies by specialist.

## Migration

`db/postgres/0049_zoe_specialists.sql` is additive:
- `ai_specialists`, with row-level security
- `conversations.ai_specialist_id` (foreign key) and `ai_routed_at`
- `ai_answers.specialist_id` and `specialist_reason`

The rollback keeps the data. The previous version ignores all of it, so Zoe answers every conversation herself from all her content. The rollback switches off guidelines that apply only to one specialist, because the previous version would apply them always.

**Seed data:** none needed. The demo starts with no specialists, and its help center has the collections to try one with (Getting started, Billing).

## Not included

| Item | When |
|---|---|
| Content targeting (conditions on articles, snippets, files and websites) | Z3b |
| Actions a specialist may call | Phase 09 |
| Routing by workflow or channel | Phase 11 (workflows) and phase 12 (channels) |
| A separate customer-facing name or avatar per specialist | Not planned: customers always see Zoe (decision 10) |
| Handing a conversation from one specialist to another | Not planned: outside her job she doesn't know, then hands over to her team |

## Tests

**`tests/zoe-specialists.test.ts` (new):**
- **Retrieval before ranking:** all content; one collection with its section; a website with snippets.
- **The prompt:** her job as data whose tags can't be forged, and the rule.
- **Access:** managers only; the choices.
- **Refusals:** seven, with reasons.
- **Saving:** create; idempotent repeat; duplicate name; stale version 409; at most ten.
- **The Playground** (nothing written):
  - a keyword picks Billing, answered from her collection
  - as Billing she doesn't know a setup question, which Zoe herself answers
  - conditions (signed-in Developers)
  - picked by what she handles
  - an unsaved draft; an invalid one refused
- **Guidance:**
  - for Billing only, given only when she answers
  - spam guidance always applies
  - an unknown specialist refused
  - her card lists it
- **The reply job:**
  - a greeting doesn't settle the specialist; the refund question does
  - she keeps the conversation and doesn't know outside her knowledge
  - after the limit she hands over to the Billing team, with "(Billing specialist)" in the note
  - "Why this reply" names her
  - Zoe's own conversation stays hers
- **Pages:** the inbox snapshot names; Performance's "Who answered"; the Overview.
- **Removal:**
  - refused while guidance names her, then archived
  - answers keep her name
  - she no longer takes questions
- **Another workspace:**
  - none of its own
  - can't ask as, change or name this one's specialist
  - can't use this one's collection

**`tests/browser/zoe-specialists.spec.ts` (new; ports 9010/9011):**
- **Happy path:**
  - Specialists from Zoe's menu
  - a new Billing specialist (keywords, the Billing collection, the Billing team) tried unsaved: she can't use the getting-started article
  - added; "Let Zoe pick" gives the same question to Zoe herself
  - a customer's refund question goes to Billing, and the customer sees Zoe
  - the teammate sees "Zoe · Billing · AI agent" and "Billing: The keyword “refund”"
  - switched off
- **Failure path:** "Only these" with nothing chosen is refused with the reason, and nothing is added.

**Updated:**
- `tests/ai-handover.test.ts`: the classifier's specialist index.
- `tests/zoe.test.ts`: the snapshot's specialists.

## Checks

Results on 4 October 2026:
- `npm test`: 117/117 pass.
- `npm run typecheck`: clean.
- Lint on the changed files: clean.
- `npm run test:e2e`: 104/104 pass.
- `npm run test:postgres`: passes.
- **Checked in the browser, dark and light:**
  - the empty Specialists page
  - the editor with the knowledge picker
  - Try it unsaved
  - the saved card
  - routing to Zoe herself and to Billing
