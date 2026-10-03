# Phase 08, step A2b: escalation rules, never-handle topics and guidance

Branch `ai/a2b-rules`. Plan: `docs/AI_PLAN.md`. Behind `ai_agent_v1`. Next: A3, the resolution ledger.

## What it does

Three new sections in **Settings › AI agent**, saved with the page's Save button and versioned with the rest:

- **Escalation rules** (up to 20):
  - each rule has a name, all or any of up to ten conditions, and an on/off switch
  - when one matches a customer message, the agent hands over without answering, and the summary names the rule
  - checked in order on every customer message, so a tag added mid-conversation applies from the next message
  - **conditions:**
    - the customer is signed in (or not)
    - email domain (verified addresses only)
    - brand
    - language ("fr" also matches fr-CA)
    - the page address the messenger is on (contains, starts with, is exactly)
    - a conversation tag
    - a conversation attribute (is, is not, is set)
- **Never-handle topics** (up to 20):
  - each has a name, a description and up to 20 keywords
  - **keywords** are matched as whole words, accents ignored, in code. They hold even when the model is down.
  - **the model** also recognises a topic by its name and description
- **Escalation guidance** (up to 10, 500 characters each): plain-language instructions on when a person should take over. Guidance only decides whether to hand over; it can't change what the agent may do.

**The order for each customer message:**
1. escalation rules
2. the "Talk to a person" button's words, and office hours (A2a)
3. topic keywords
4. the classifier, which checks in this order: asking for a person, a topic by meaning, guidance, frustration

The first rule, topic or piece of guidance that applies is named in "Why this reply" and the handover summary. For example: "The message is about a never-handle topic: “Legal”."

## How it works

**`server/ai-escalation.ts`:**
- **Validation:** `validRules` checks rules against this workspace's own brands, tags and conversation attributes; `validTopics` and `validGuidance` check limits and lengths.
- **Facts:** `facts` reads what a rule can test, once per message: verified email domains, the messenger session's page and the conversation's language, tags and attributes.
- **Matching:** `matchRule` evaluates rules; `matchKeywords` matches topic keywords.
- **Storage:** rules are rows in `ai_escalation_rules` (from 0044), replaced together on save.

**The classifier** (`ClassifyRequest.topics` and `guidance`, prompt version `a2.2`):
- **Input:** topics and guidance go in their own tagged data blocks. Block tags are removed from all data.
- **Output:** a topic or guidance index or null, checked against the lists. A malformed index refuses the whole reply.
- **The stand-in:** matches a topic's name, or a phrase the guidance quotes (“cancel my account”).

**Companies and custom contact attributes** wait for the people service (phase 01); a TODO marks the place. The conditions are a closed list.

## Migration

`db/postgres/0045_ai_escalation.sql` is additive: `ai_agents.never_handle` and `escalation_guidance` (JSON arrays). The rollback leaves them; the previous version ignores them and the rules.

## Not included

| Item | When |
|---|---|
| Company and custom contact attribute conditions | Phase 01, the people service |
| Guidance with channel selectors, and guidance that shapes answers | B1 |
| Resolutions | A3 |

## Tests

**`tests/ai-escalation.test.ts` (new):**
- **Eleven refusals in Settings,** each with its reason. Nothing is saved.
- **A save:** three rules (one switched off, one "any"), two topics and guidance, read back in order. The domain is normalised, and empty or padded keywords are cleaned. Saving without them leaves them unchanged.
- **Rules:**
  - a signed-in Big Corp customer is handed over unanswered and unclassified, with the rule in the summary
  - another domain, and a visitor (matching only the switched-off rule), are answered
  - the page and the language match
  - a tag or attribute added mid-conversation matches the next message
- **Topics:**
  - a keyword hands over without the classifier, and still does while it's down
  - a topic without keywords needs the model: down, the agent answers; up, it hands over
  - the classifier receives topics and guidance as data
- **Guidance:** hands over and is quoted in the reason.
- **Keywords:** whole words only, accents ignored.
- **Another workspace:** has its own empty settings and can't use this one's tags.

**`tests/browser/ai-escalation.spec.ts` (new; ports 9002/9003):**
- **Happy path:** a manager adds a "Legal" topic with keywords. A customer mentioning their lawyer gets the handover message and no answer, and the teammate's summary names the topic.
- **Failure path:** a rule with an empty email domain is refused with the reason and nothing is saved. Fixed, it saves.

**Updated:** `tests/ai-handover.test.ts`. Classifications now carry topic and guidance.

## Checks

Results on 3 October 2026:
- `npm test`: 110/110 pass.
- `npm run typecheck`: clean.
- Lint: clean on the changed files.
- `npm run test:e2e`: 96/96.
- `npm run test:postgres`: passes.
- **Checked in the browser:** the escalation rules and never-handle topics sections in Settings › AI agent.
