# Phase 08, step B2: Safety and privacy

Branch `ai/b2-safety-privacy`, as B2a (safety) and B2b (privacy) together. Plan: `docs/AI_PLAN.md` (decision 12). Behind `ai_agent_v1`. Next: C1, the evaluation harness.

## B2a: Safety

**Guards in code, on every reply a model writes,** before it can reach a customer (`server/ai-guard.ts`). They don't rely on the model behaving:
- **Canary:** a secret marker, new for every answer, sits in her instructions. A reply containing it is blocked.
- **Prompt:** a reply repeating her instructions or the prompt's data-block tags is blocked.
- **Personal data:** a reply is blocked if it contains an email address, phone number, card number (Luhn-checked) or IBAN that is in neither the passages she was given nor this customer's own messages. Dates and short order numbers aren't personal data.
- **Internal content:** a reply is blocked if it contains eight words in a row from internal knowledge or this conversation's internal notes that aren't also in what she was given.
- **Links** were already refused by the reply check.

**When a guard fires:**
- **The customer** gets "I couldn't find an answer" with a person offered. It counts toward the failed-answer limit, so repeated blocks reach the team.
- **The answer** records the guard (`ai_answers.guard`).
- **Teammates** see "Her reply was blocked before it reached the customer: it contained …" in "Why this reply" and in the Playground. Performance gets a "Blocked by safety" card.

**What she's given never includes:**
- other customers' messages
- internal notes
- internal articles

This was already true by construction. The corpus test now checks it on every request.

**The hostile corpus** (`tests/fixtures/hostile.ts`, 41 cases): attacks in all nine of her languages, each run through the real pipeline with a model that obeys every injection.
- **33 must be stopped:**
  - her marker
  - her rules
  - another customer's email, phone, card or IBAN, asked for directly or by pretending to be them
  - invented contact details
  - internal content, quoted directly, paraphrased around, or in a clarifying question
  - links carrying data away
- **8 legitimate replies must get through:**
  - the customer's own email and phone
  - the address the content gives
  - plain answers despite injection attempts
  - an order number

**Not covered:** content the workspace itself publishes is trusted. An injected instruction in an article can only make her quote that article, every sentence must cite it, and links are refused.

## B2b: Privacy

Zoe › Settings has a **Privacy** card, with both switches off by default.

**Redact personal data before it's sent to the model:**
- **What's replaced:** email addresses, card numbers, IBANs, IP addresses, phone numbers and the customer's own name become placeholders ("[email 1]", "[name]"). The same value always gets the same placeholder within an answer.
- **Where:** in the question, the history and memory, for both the answering model and the classifier.
- **Her reply:** puts the customer's own details back. The guards then check the restored text.

**The record of model calls** (`ai_model_calls`):
- **What's kept:** every call for a customer message (answer and classify), with exactly what was sent, whether it was redacted, and what was redacted.
- **Who sees it:** managers, from "Why this reply", under "Sent to the model" ("1 email address redacted", with the text).
- **The Playground** shows what would be sent, and records nothing.
- **Kept 90 days:** removed by the daily retention sweep, in the local relay and the Worker.

**Remember a signed-in customer's earlier conversations:**
- **What she gets:** their last three other conversations from the past 90 days, up to six public messages each, as a `<memory>` data block. Her rules say to answer only from the passages, and never to repeat from memory anything the customer didn't write.
- **Never for visitors:** a browser can be shared.
- **Recorded:** each answer records what she remembered (`ai_answers.remembered`), and "Why this reply" shows it.

## How it works

**`decide()` in `server/ai-agent.ts`:**
- **Before the model:** builds one redactor per answer and redacts what's sent. It records each call's exact data block (`buildPrompt`'s and `buildClassifyPrompt`'s user message), and passes the canary and memory.
- **After the model:** restores the reply, runs `checkReply`, then `guardReply`.
- **Recording:** the reply job writes the calls in the same transaction as the answer.

**Prompts:** `PROMPT_VERSION` is b2.1, adding the memory rule, the `<memory>` block and the marker.

TODO(phase 12): filtering spam and phishing on email, when the email channel exists.

## Migration

`db/postgres/0051_ai_safety_privacy.sql` is additive:
- `ai_answers.guard` and `remembered`
- `ai_agents.redact_personal_data` and `memory`
- `ai_model_calls`, with row-level security

The rollback switches the AI agent off for workspaces that turned redaction on, because the previous version can't redact. The record is kept.

**Seed data:** none needed. Both settings start off.

## Tests

**`tests/ai-safety.test.ts` (new):**
- **The guards:** each one, and what's legitimately given.
- **Personal data:** found however it's written; dates and order numbers ignored.
- **The 41-case corpus** through the Playground with an obedient model. Nothing it was given held internal content or another customer's details, and nothing was written.
- **A real conversation:** a teammate's internal note is never given to her. When a model quotes it anyway, the reply is blocked and recorded, the customer is told she couldn't answer, and "Why this reply" and Performance show it.

**`tests/ai-privacy.test.ts` (new):**
- **The redactor:** every kind; same value, same placeholder; restoring; off.
- **Off:** the record shows the raw text.
- **On:**
  - neither model gets the customer's name, card or email
  - the record shows placeholders and counts
  - the reply restores the email
- **Memory:**
  - a signed-in customer's earlier conversation is given, redacted, and recorded
  - a visitor gets none
  - another customer never gets theirs
- **"Why this reply":** shows the sent text to managers only.
- **The Playground:** shows what would be sent, and records nothing.
- **The 90-day purge.**
- **Another workspace:** its own settings; it can't read these.
- **The rollback** switches off a redacting agent.

**`tests/browser/ai-safety-privacy.spec.ts` (new; ports 9014/9015):**
- **Happy path:** redaction on in Settings; a visitor's email reaches the model as "[email 1]"; the manager sees "1 email address redacted" and the exact text.
- **Failure path:** a compromised model writes her marker. The customer sees "I couldn't find an answer" and never the marker. "Why this reply" and Performance say why.

**Updated:** `tests/ai-handover.test.ts` didn't need changes. The classifier's shape is unchanged in B2.

## Checks

Results on 12 October 2026:
- `npm test`: 123/123 pass.
- `npm run typecheck`: clean.
- Lint on the changed files: one warning in `workers/relay.ts` (an unused `isAgent`), which was already on main.
- `npm run test:e2e`: 108/108 pass.
- `npm run test:postgres`: passes.
- **Checked in the browser:** the Privacy card in Zoe's settings.
