# Phase 08, step A1: the AI agent's answering core

Branch `ai/a1-answering`. Plan: `docs/AI_PLAN.md`. Behind the new `ai_agent_v1` flag, off by default; the local relay turns it on.

## What it does

**For the customer, in the messenger:**
- **When the agent answers:** a message in a conversation no teammate has taken on (unassigned, and no teammate reply yet). Several messages in a row are answered once, as one question.
- **An answer:** a short reply labelled "AI agent", built only from the help content, with its sources listed underneath. An article published in the brand's help center links to it there, in a new tab.
- **A refusal:** when the content doesn't cover the question, the agent says so honestly and asks whether the customer would like someone from the team: "I'm sorry, I couldn't find an answer to that in our help content. Would you like me to connect you with someone from the team?" It never guesses. (Connecting them is step A2.)
- **A clarifying question:** when a short question could mean different things that different articles answer, the agent asks which. The choices are buttons the customer can tap.
- **A greeting** ("Hi!") gets "Hi! What can I help you with?" without searching.
- **Languages:** fixed replies are in English, French, Spanish, German or Portuguese, by the customer's language.

**For teammates, in the inbox:**
- **Under each AI reply:** its sources, and "Why this reply":
  - the outcome (answered from content, asked to clarify, said it didn't know, or the model failed)
  - the reason
  - the best passage's relevance against the threshold
  - the model and prompt version
- **When a teammate takes over:** once a teammate replies or the conversation is assigned, the agent stays out. If a teammate replies while the agent is working, its reply isn't sent.

## How it works

**Retrieval** (`server/ai-retrieval.ts`):
- **Which passages may be used,** decided in PostgreSQL before any ranking:
  - published, switched on for the AI agent
  - public, or signed-in when the customer is verified
  - in the first language along the customer's chain the record is published in (their messenger language, then the brand's)
  - not placed only in another brand's help centers
- **Keyword:** full-text search over the AI index's passages, each in its own language's stemming. Migration 0040 adds `knowledge_chunks.document`, kept by a trigger.
- **Meaning:** the vector store's nearest neighbours, kept only if allowed. A passage the customer may not see never influences ranking or the confidence score.
- **Combining:** the two lists are fused by reciprocal rank, the best 12 are reranked, and at most two passages per record are kept, six in all.

**Answering** (`server/ai-agent.ts`, job `ai.reply`):
1. **The gate:** if the best rerank score is below the agent's threshold (0.5 by default), the agent refuses without asking the model.
2. **The model** (`server/ai-model.ts`) returns JSON: an answer whose every sentence cites passage ids, a clarifying question, or "unknown".
3. **The check** (`checkReply`): an answer with a sentence citing no passage it was given, a link, or more than six sentences becomes "unknown".
4. **The reply** is an `ai_reply` part. Its data holds only the sources (titles and help center paths) and any clarifying options, because part data reaches the customer.
5. **The audit:** everything else goes in `ai_answers`, for teammates and evaluation: every candidate passage's keyword rank, vector score, fused score and rerank, which were used, the outcome and reason, the model, the prompt version and the latency. Records the agent retrieves are counted for content health.
6. **Changes while it worked:** the reply is re-checked when written. If a teammate replied or took over, or the customer wrote again, nothing is sent and the attempt is recorded as skipped.
7. **A failing model** is retried by the job. From the third attempt the customer gets the plain refusal (outcome "failed").

**Data, not instructions** (`buildPrompt`):
- the customer's question, the conversation so far and the passages go in tagged data blocks, which the instructions say are data
- block tags inside any data are removed, so an article or a customer can't close a block or open a fake one
- internal notes and system events are never sent to the model
- the model has no tools in this step, and its reply is parsed and checked, never executed

**Models:**
- **Deployed:**
  - Claude Sonnet 5.5 through Anthropic's Messages API (`claudeAnswerModel`), at temperature 0 with the reply prefilled with `{`. The key is the `ANTHROPIC_API_KEY` Worker secret.
  - Workers AI `bge-reranker-base` (`workersAiReranker`).
  - Without the key, the agent doesn't run.
- **Locally and in tests:** deterministic stand-ins.
  - `standInReranker` scores the share of the question's meaningful words a passage contains.
  - `standInAnswerModel` quotes the best passage's matching sentences.

**Teammates' endpoint:** `GET /v1/agent/ai-answers?conversation=…` (conversation access checked), allowed through the agent bridge.

## Migration

`db/postgres/0040_ai_agent.sql` is additive:
- **Keyword search over passages:** `relay_text_config`, `relay_unaccent_lower`, `knowledge_chunks.document` (with its trigger, a backfill and a GIN index).
- **Tables:** `ai_agents` (one default agent for now: name, on/off, threshold) and `ai_answers`, both with row-level security.
- **The flag:** `ai_agent_v1`, off. New workspaces get it from `seedFoundation`.

The rollback switches the flag off; queued answers then skip.

## Not included yet

| Item | Step |
|---|---|
| Handing over to a person, escalation rules and triggers, summaries, routing after handover, out-of-hours behaviour, the AI state and its views | A2 |
| Resolutions | A3 |
| Several agents, guidance, content targeting, identity per brand, language detection, formality and length, Settings pages | B1 |
| Redaction before the provider, the hostile corpus, memory | B2 |
| The golden set, scoring and the regression gate | C1 |
| Review queue and monitors | C2 |
| Email, SMS and voice formatting | Phase 12 |

## Tests

**`tests/ai-agent.test.ts`:**
- **Retrieval:**
  - internal, switched-off, signed-in-only (for visitors) and other-brand content is never a candidate
  - a record is used in the customer's first language
- **An answerable question:** answered with the article's sentence, its source and help center path, an audit record (cited record, score above threshold, model, prompt version) and a retrieval count.
- **An unanswerable question:** refused by the gate, and the model is never called.
- **Other replies:** a greeting gets the fixed question; an ambiguous one-word question gets a clarifying question with both articles as options.
- **What reaches the model:** an internal note doesn't; two messages in a row are one question (the earlier job is skipped).
- **Teammates:** after a teammate replies the agent stays out; a teammate replying while it works means nothing is sent.
- **Bad model output:** a model citing a passage it wasn't given is refused; a failing model is retried twice, then the customer gets the refusal (outcome "failed").
- **Isolation and the flag:** another workspace gets 404 for the audit and finds none of A's content; with the flag off, nothing is queued.
- **The prompt:**
  - hostile article text and a hostile question can't close or open data blocks
  - only the three reply shapes parse
  - links and uncited sentences are refused
- **Claude's request:** model, temperature 0, prefill; a malformed reply and an error status are refused.

**`tests/browser/ai-agent.spec.ts`** (ports 8974/8975):
- **Happy path:** a customer asks when replies arrive and gets the seeded article's answer, labelled AI agent, with the source linking to the article in the help center. The teammate sees the reply, its source, and "Why this reply" (answered from content, the threshold, the model).
- **Failure path:** a question the content can't answer gets the refusal and an offer of a person, no sources, and the model isn't asked. This is the phase's refusal acceptance criterion.

**Updated:** `cards-composer.spec.ts` and `messenger.spec.ts` run with `aiAgent: false`, since they check the latest message and count messages exactly.

## Checks

Results on 3 October 2026:
- `npm test`: 99/99 pass.
- `npm run typecheck`: clean.
- Lint shows nothing in the new files.
- `npm run test:e2e`: 82/82.
- `npm run test:postgres`: passes.
- **Checked in screenshots:** the messenger answer with its source; the inbox reply with "Why this reply", light and dark.
