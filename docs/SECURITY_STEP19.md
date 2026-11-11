# Phase 16, step C9d: AI providers

Branch `ai/providers`. Plan: `docs/SECURITY_PLAN.md` (decision 37). It was asked for after C9c and is built before C10. New dependency: `@anthropic-ai/sdk` (Anthropic's official SDK), used only by the Claude adapter.

## What it does

**Settings › Knowledge & AI › AI providers** (`workspace.manage`, behind `ai_providers_v1`):
- **A card per provider:** Claude, OpenAI, Gemini, DeepSeek, and any OpenAI-compatible endpoint. Each card shows:
  - whether it's connected, and its role;
  - its model, and its key as "•••• 1234";
  - its last test;
  - the last 7 days' calls, and how often the fallback took over.
- **The dialog** ("Connect OpenAI"):
  - **Fields:** the API key, the model, an optional cheaper model for classifying messages, and the base URL for a custom endpoint.
  - **Help:** where the provider processes data (DeepSeek's API is run from China), and "Keys are encrypted on the server and never sent back to the browser."
  - **Buttons:** Save, and Save and test.
  - **Suggestions:** the model field suggests each provider's current models (from its documentation, 11 November 2026) but takes any name.
- **"Zoe answers with":**
  - **Primary:** Relay's AI, or one of the connected providers.
  - **Fallback:** another connected provider, used only when the primary fails or doesn't answer in time.

**Zoe** answers with what's chosen:
- **Answering and classifying** go to the workspace's providers.
- **Relay's key** is used only when no primary is set. It's never used as a silent fallback: the workspace chose where its customers' data goes.

**Every model call** records three things:
- the provider and model that served it;
- whose key: Relay's or the workspace's;
- when the fallback answered, which primary failed and why.

"Why this reply" and the Playground say who answered: "Answered with your own OpenAI key (gpt-6-luna)."

**Billing:**
- **A new meter:** AI resolutions answered on the workspace's own key are "AI resolutions on your own AI key", with their own price slot (a placeholder, like every price). "AI resolutions" now counts Relay's AI only.
- **Limits:** Zoe's usage limit is the meter for the key she'd use.
- **The spend cap** covers both meters.

## How it works

- **`lib/ai-providers.ts`:**
  - **The providers,** with what the page shows (name, where data goes, suggested models, key placeholder).
  - **Relay's own AI:** decision 2's models, Claude Sonnet 5.5 answering and Claude Haiku 4.5 classifying.
  - **The time limits:** 30 seconds to answer and 15 to classify.
  - **What a model name and a key may look like.**
  - **`servedWords`:** the "Answered with …" words.
- **`server/ai-adapters.ts`:** an adapter per provider, behind Zoe's ports, using the same prompt, parsing, redaction, record of calls and `guardReply`.
  - **Chat Completions:** OpenAI (`max_completion_tokens`, JSON mode), DeepSeek (`max_tokens`, JSON mode, low reasoning effort) and custom endpoints (`max_tokens`, no JSON mode). No temperature, since reasoning models reject it.
  - **Gemini:** `generateContent`, with the key in `x-goog-api-key`, JSON as the response type, and thought parts left out.
  - **How requests go:** every request goes through `safeRequest` (https only, no private addresses, a size cap and the time limit). A failure is described by its status only, never by the provider's response.
  - **`routed(primary, fallback)`:** tries the primary, and only when it fails (an error, a refusal, an unreadable reply or a timeout), the fallback. It tells the port's `served` callback who answered and why the primary failed.
  - **`failingModels`:** a model that always fails with a reason. It's used for a key that can't be read, and for a deployment without Relay's key.
- **`server/ai-model.ts`:** the Claude adapter now uses Anthropic's SDK. The old request (a "{" prefill and temperature 0) is rejected by Claude Sonnet 5.5 and later.
  - **JSON:** asked for in the prompt, with structured outputs on the models that have them (one flat schema per reply type).
  - **Effort:** medium for answers and low for classifying, on models that take it.
  - **Refusals:** `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) on Claude Fable 5.1, Opus 5.5, Opus 5 and Sonnet 5.5. A refusal still standing is a failure.
  - **Unknown models** get the plain request.
  - **The address and credential** are only the ones given. The environment's `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` are ignored, so a workspace's key can't be sent elsewhere or alongside another. Retries are off: the job and the fallback handle failures.
  - **The ports** (`AnswerModel`, `ClassifierPort`) gain `provider`, `keySource` and the `served` callback.
- **`server/ai-providers.ts`:**
  - **`readProviders` and `changeProviders`** (the GET and POST `ai-providers` routes):
    - **Save:** a key is needed the first time. It's sealed with the connector key, bound to the workspace and provider. A changed key, model or address clears the last test.
    - **The other actions:** test, remove (removing the primary clears the fallback), and the primary and fallback.
  - **`runProviderTest`:** the `ai.provider.test` job.
    - **What it sends:** a fixed question with a fixed passage ("Support hours"), and no customer data, to the answering model, and to the classifying model when it's different.
    - **What it records:** the result goes on the connection, in words a manager can act on ("The provider refused the key (401). Check the key, and that it may use this model.").
  - **`withWorkspaceModels`:** builds Zoe's models for a workspace at the start of `runAiReply`, a procedure's resume, and the Playground.
    - **A key that can't be read** (the connector key changed) fails like a provider that's down.
    - **`keySourceOf`** tells `runAiReply` which meter to ask `pausedFor` about.
- **Recording:**
  - **`recordModelCalls`** writes `provider`, `key_source` and `failover`.
  - **Answers:** `decide` keeps the served model, and `ai_answers.key_source`.
  - **Resolutions:** `recordResolution` is "own key" when every answer it rests on was answered with the workspace's key. A reversal carries its resolution's key.
- **Meters:** `ai_resolutions` and `ai_resolutions_own_key` are one source query each, split on `key_source`. `UNIT_PRICES` gains the new slot (`npm run check:plans` lists it as a placeholder).
- **Hosts:**
  - **Deployed (`workers/relay.ts`):** the agent now runs whenever the AI index exists, so a workspace with its own provider gets answers even without Relay's key. Without Relay's key, Zoe tells other workspaces' customers she can't answer and offers a person, after the usual retries. The test job runs whenever the connector key is set.
  - **Local relay:** `aiProviders.policy` lets tests stub every provider; by default a manager's real key reaches the real provider. The page is on.

**Privacy and safety:**
- **Unchanged for every provider:** redaction, the record of model calls, `guardReply`, and the hostile corpus.
- **New entries:**
  - **`lib/processors.ts`:** "The workspace's own AI providers" (a workspace destination). `docs/TRUST.md` is regenerated.
  - **`lib/encryption.ts`:** AI provider keys are among the sealed secrets.
  - **`NO_PERSONAL_DATA`:** `ai_providers`.
- **The audit log:** `ai_providers` is audited by `audit_row` (`ai_provider.created`, `.changed`, `.deleted`). The sealed key appears only as "a secret was replaced", and test results aren't audited.

**Migration `0097_ai_providers`:**
- **New:** `ai_providers`, at most one primary and one fallback per workspace.
- **New columns:** `provider`, `key_source` and `failover` on `ai_model_calls`, and `key_source` on `ai_answers` and `ai_resolutions` (existing rows count as Relay's).
- **Changed:** the new meter in the `usage_limits` and `usage_alerts` checks, and the flag.
- **Its rollback** clears every primary and fallback and turns the flag off, so every workspace answers with Relay's AI again. It removes limits on the new meter. Connections stay, unused, and the earlier code counts every resolution under AI resolutions.

## Checks

- **`tests/ai-providers.test.ts`** uses stub providers only, never the network.
  - **The adapters:**
    - **OpenAI:** its address, the bearer key, the body (no temperature, `max_completion_tokens`, JSON mode), and the classifier's own model. A 401 says only "returned 401" (never the provider's text), and maps to "refused the key". A refusal and a non-JSON reply fail.
    - **DeepSeek:** its address, `max_tokens`, low reasoning effort and JSON mode.
    - **A custom endpoint:** its base URL with `/chat/completions` and no JSON mode. A private address is refused before anything is sent, and base URLs are normalized and checked.
    - **Gemini:** the model in the path, the key header, JSON as the response type, and thoughts left out. Safety blocks fail.
    - **Claude on the workspace's key:** the SDK, the chosen model and medium effort, recorded as the workspace's key. The environment's base URL and token can't redirect it.
    - **A timeout** is told as one.
  - **The router:** the fallback only on failure, told which primary failed and why. A working primary never asks the fallback. Both failing gives the fallback's error, and the classifier routes the same way.
  - **The whole flow**, through the API:
    - **Access:** managers only. Five providers, none connected, and Relay's AI by default.
    - **Saving:** a key is required, and the key, model and address are checked.
    - **The key:** never returned, never stored readable, and never in the audit log.
    - **Save and test:** sends the fixed question only, and keeps the result. A refused key says so, and a changed model clears the result.
    - **Roles:** a fallback without a primary, the same provider twice, or an unconnected provider is refused.
    - **Zoe answers with OpenAI:** both calls are recorded as OpenAI on the workspace's key, and Relay's AI is never asked.
    - **OpenAI failing:** Claude answers, the record says why, and the page counts the failovers.
    - **A confirmed resolution** counts on the own-key meter, not Relay's.
    - **Limits:** Relay's meter's limit doesn't pause her, and the own-key meter's does, with the note.
    - **An unreadable key** falls back, never to Relay's.
    - **Another workspace** sees none of it.
    - **Removing the primary** clears the fallback.
    - **The flag:** off, the page is gone and a primary is ignored.
    - **The rollback.**
- **Changed:**
  - **`tests/ai-agent.test.ts` and `tests/ai-handover.test.ts`:** Claude's new request (no prefill or temperature, structured outputs, effort, refusal fallback, a refusal failing, and the plain request for an unknown model).
  - **The route matrix, plans, erasure and audit tests:** the new route, price slot, table and trigger.
- **`tests/browser/ai-providers.spec.ts`:**
  - **Happy path:**
    - **Connecting:** a manager connects OpenAI. The model is filled in, Save and test passes, and the card shows "•••• 1234". The key is never in the page.
    - **Choosing:** they make it Zoe's primary.
    - **Answering:** a customer's messenger question is answered by the OpenAI stub, and "Why this reply" says "Answered with your own OpenAI key (gpt-6-luna)."
  - **Failure path:**
    - **A refused key:** Gemini refuses it, and Save and test says "Test failed: The provider refused the key (403)…".
    - **An http address:** a custom endpoint at an http address is refused with the reason, and nothing is saved.

## Also in this branch

- **Full-width pages:**
  - **The cap that's gone:** every page in the agent app fills the width beside its menu. `.pg-settings-body` had a fixed maximum width (820px, or 1180–1280px for Zoe, Outbound, People, Workflows and Messenger).
  - **Inner blocks:** so had the knowledge editor, websites and the AI index. The help-center insights table now spans its card.
  - **Kept:** dialogs, pop-ups, chat messages and input fields keep their sizes.
  - **How it was checked:** all 65 pages were measured at 1600px wide (`work/full-width/audit.mjs`, not committed).
- **Settings link entries** (Saved views, Workflows, Help centers, Websites, AI index, Zoe, Content health) opened by their address now open their area, as a click does, instead of an empty page.
- **`tests/browser/retention.spec.ts`:** the sweep queues its own retention run as soon as a policy is saved, so "Run now" can find nothing left. The test now checks the audit log for the run that deleted the conversation. That race already existed: on its own the test failed 2 runs in 3, and it now passes 5 in 5.

## Not done here

- **Real calls haven't been made:** each adapter follows its provider's documentation as of 11 November 2026, and tests stub every provider. "Save and test" with a real key is the first real call.
- **Suggested model names** change often, and the dialog's list is only a starting point.
- **Prices:** the own-key price is a placeholder, like every price, until C10.
- **No usage-based routing:** the cheapest provider isn't chosen per question; the workspace chooses one primary.
