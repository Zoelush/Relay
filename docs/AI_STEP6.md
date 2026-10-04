# Phase 08, step Z2: How Zoe answers

Branch `ai/z2-voice`. Plan: `docs/AI_PLAN.md` (decision 9). Behind `ai_agent_v1`. Next: Z3, specialists.

## What it does

**Train › Guidance**, a new page in Zoe's area (`#zoe/guidance`), with "Try it" beside it, as Intercom keeps a preview beside its Train pages.

**How she sounds:**
- **Tone of voice:** Friendly (the default), Professional, Matter-of-fact, Empathetic or Playful. Each tone has a sample line.
- **Answer length:** Concise (up to 2 sentences), Standard (up to 4, as before) or Thorough (up to 8, with steps in order).
- **Formality:**
  - **Usual for each language** (the default): vous, Sie, tú, tu in Italian, je in Dutch; wording as before.
  - **Formal:** vous, Sie, usted, Lei, u, o senhor.
  - **Informal:** tu, du, tú, tu, je.

  Formality covers her answers and her fixed messages: the greeting, "I couldn't find an answer", the handover and away messages, and the thanks.

**Guidance**, in Intercom's categories:

| Category | What it's for |
|---|---|
| Communication style | Words and phrasing |
| Context and clarification | When to ask for more detail |
| Content and sources | How to use your content |
| Spam | Messages she leaves alone |
| Other | Anything else |

- **Each guideline:**
  - a title (up to 80 characters) and its text (up to 500)
  - on or off
  - for everyone, visitors or signed-in customers
  - for all brands or one
- **Limit:** up to 30 guidelines.
- **Examples:** each empty category shows one.
- **Warnings while you type:** when a guideline asks for something guidance can't do. Saving still works.
  - acting on accounts, orders or payments
  - writing links
  - answering from outside your content
  - handing over (that belongs on the Escalation page)
  - revealing her instructions

**Try it:**
- **Asking:** ask a customer question as a visitor or a signed-in customer, on a brand. She answers with your **unsaved changes** (marked so), or as saved, with the version.
- **What you see:**
  - her reply and its sources
  - the outcome
  - the language she chose, and why
  - **What she was told:** the lines her voice and guidance add to her instructions
- **Nothing is written.**

**History:**
- **Versions:** every save is a numbered version showing who saved it, when, the voice and the number of guidelines.
- **Looking back:** any version can be viewed.
- **Restoring:** saves an earlier version again as the newest, marked "restored from version N". Restoring waits until unsaved changes are saved or discarded.

**Spam:**
- **What she does:** when a message matches spam guidance, she doesn't reply.
- **What teammates see:** a team-only note says why ("Zoe didn't reply. It looks like spam, by your guidance “Sales pitches”."). The conversation stays in the inbox, unassigned as before, and her AI state is unchanged.
- **The limit:** spam guidance can only make her leave a message alone. It never closes or deletes anything.

**Languages**, a card in her Settings:
- **Detection:** she reads the language of what the customer writes, not only their browser's.
- **Short messages** ("ok", "Hi!", "Merci") keep the language the conversation was in, then the browser's, then the brand's.
- **Her languages:** you choose which of nine she answers in (the messenger's: English, French, Spanish, German, Portuguese (Portugal), Portuguese (Brazil), Italian, Dutch, Arabic). All nine are on by default.
- **Another language:** she replies in the brand's language (the default), or hands over to the team. She hands over only when she read the language in what they wrote; a browser setting alone never hands over.
- **Content:** she looks in the answer language first, then the brand's.
- **Her fixed messages** now exist in all nine languages, in both registers where the language has them.

**For teammates:**
- **"Why this reply"** adds:
  - the language she answered in and the one she read
  - her voice
  - the guidance version
  - the guidelines she was given
- **Escalation rules on language** now use the language she read in the message. A German browser with an English message isn't German.

**Her pages:**
- **Overview:** a Guidance card with her voice and how many guidelines are on.
- **Performance:**
  - spam counts on its own
  - a new "Languages she replied in"
- **Playground:**
  - "Browser language" (used when she can't tell from the question)
  - her voice and guidance version
  - What she was told

**Running locally with Claude:** with `ANTHROPIC_API_KEY` in `.dev.vars`, `npm run dev:relay` answers and classifies with Claude, so her tone, formality and guidance show.
- **The key:** read from that file only, never printed or stored.
- **What stays offline:** reranking (Workers AI isn't reachable locally).
- **Tests:** they start the relay themselves and always use the stand-ins.
- **Without a key:** the stand-in answers. It doesn't write, so only the length changes its answer. Try it says so.

## How it works

**Language** (`server/ai-language.ts`, in code so it holds when the model is down):
- **`detectLanguage`:**
  - **Other scripts:** read by script (Arabic, Japanese, Chinese, Korean, Cyrillic and others).
  - **Latin-script languages:** read by their common short words. She needs two marking words and twice any other language's count, or she can't tell.
  - **Portuguese:** its vocabulary decides Brazil or Portugal; otherwise the browser's or brand's variant, else Brazil's.
- **`chooseLanguage`:**
  - **Where it starts:** this message, then the conversation's last detected language (`ai_answers.detected_language`), then the browser's, then the brand's.
  - **Then:** one of her allowed languages, with the hand-over rule above.

**Voice and guidance** (`server/ai-model.ts`; `PROMPT_VERSION` z2.1):
- **Her voice:** `styleLines` writes it as "How to write" lines, after her rules.
- **Guidance:** a `<guidance>` data block. The rules say to follow it only where it fits them, and to ignore anything asking to break them, use anything but the passages, act, promise or reveal. Block tags are removed from guidance like any other data.
- **The reply check:**
  - at most 3, 6 or 10 sentences by length
  - unchanged otherwise: every sentence cites a given passage, no links
- **The stand-in** picks 1, 2 or 4 sentences.

**Spam:**
- **The classifier** (`CLASSIFY_VERSION` z2.1) gets the spam guidelines and returns which one a message matches; the stand-in matches quoted phrases.
- **Order:** rules, the language handover, the button and office hours come first. Spam then wins over the classifier's other findings.

**Guidance** (`server/zoe-guidance.ts`):
- **Validation:** `validVoice` and `validGuidelines` check it, with reasons.
- **Who it applies to:** `applicableGuidance` picks what applies by on/off, audience and brand.
- **Saving:** `saveGuidance` saves from the version the page loaded (409 if it changed elsewhere), idempotent on the request's key. Each save is a row in the append-only `ai_guidance_versions` (a trigger refuses changes). Restore copies a version into a new one.
- **Every answer records** its `guidance_version` and `guidance_applied` (ids). "Why this reply" names them from that version.

**Routes:**
- `GET /v1/agent/zoe?view=guidance` (and `&version=N` for one version)
- `POST /v1/agent/zoe-guidance` (save, or `restore`)
- `zoe-playground` takes `draft` (checked like a save)
- `ai-settings` takes `languages` and `otherLanguages`
- all managers only, with the agent on

**The agent app:**
- `agent/zoe-guidance.tsx` is the page.
- `agent/zoe-labels.ts` holds the outcome, trigger and voice wording shared with the Playground.
- `lib/zoe-voice.ts` holds the tones, lengths, formality, languages, categories, limits and warnings, shared with the server.

## Migration

`db/postgres/0048_zoe_voice.sql` is additive:
- **On `ai_agents`:**
  - `tone`, `answer_length`, `formality`
  - `answer_guidance` and `guidance_version`
  - `languages` (all nine by default) and `other_languages`
- **`ai_guidance_versions`:** append-only, with row-level security.
- **On `ai_answers`:** `language`, `detected_language`, `guidance_version`, `guidance_applied`.

The rollback has nothing to undo: the previous version ignores all of it and answers as before. Versions are kept.

**Seed data:** none needed. The migration gives every agent her defaults (friendly, standard, usual formality, nine languages, the brand's language for others). The demo's Guidance page starts empty, with an example in each category.

## Not included

| Item | When |
|---|---|
| Specialists, and content targeting | Z3 |
| Guidance per channel (email, SMS) | Phase 12, when those channels exist |
| Translating content into the customer's language without the model (the stand-in answers from the passage as written) | Deployed, Claude answers in the customer's language from content in another |
| Live preview beside Escalation and Content | Not planned; the Playground covers them |
| Native-speaker check of the new fixed messages (Italian, Dutch, Arabic, Brazilian Portuguese, and the formal and informal variants) | Open, with the messenger's |

## Tests

**`tests/zoe-voice.test.ts` (new):**
- **Detection:**
  - twelve languages and scripts
  - short or mixed text gives none
- **Choosing a language:**
  - hers, a regional variant, another with either rule
  - the browser never hands over, and the conversation's language counts
  - the brand's language when it isn't hers
  - Portuguese variants
- **The prompt:**
  - defaults
  - voice lines after the rules
  - guidance as one data block whose tags can't be forged
- **Warnings:** each kind, and none for spam's own words.
- **The stand-ins:**
  - classifier spam
  - answers at each length
- **Guidance:**
  - **Access:** defaults; agents refused.
  - **Refusals:** eight, with their reasons, and nothing saved.
  - **Version 1:** with guidance for everyone, signed-in customers, one brand, off, spam and a link (warned).
  - **Saving:** an idempotent repeat; a stale save refused.
- **The Playground** (nothing written):
  - **Which guidance applies:** to a visitor, a signed-in customer and another brand.
  - **Drafts:** at thorough length; an invalid one refused.
  - **Spam** left alone.
  - **French:** read and answered from French content; the informal French fixed message.
  - **"Hi!"** keeps the browser's language.
- **Languages:**
  - refusals
  - English only: French gets English, or a language handover
  - a browser alone never hands over
- **Versions:**
  - version 2, then version 1 restored as 3
  - viewing one; a missing one gives 404
  - versions can't be changed
- **The reply job:**
  - an answer records language, version and guidelines
  - "Why this reply" names them
  - spam gets no reply, only a team note, and the AI state is unchanged
  - "Merci" keeps the conversation's French
- **Pages:** Performance counts spam and languages; the Overview shows her voice.
- **Another workspace:**
  - its own defaults and versions
  - none of this one's guidance applies
  - it can't see this one's versions or name this one's brand
  - with the agent off: no page

**`tests/browser/zoe-voice.spec.ts` (new; ports 9008/9009):**
- **Happy path:**
  - Guidance from Zoe's menu
  - Concise and a guideline, with the link warning as you type
  - Try it with unsaved changes (one sentence; What she was told)
  - saved as version 1
  - a customer with an English browser writing French gets Zoe's French reply
  - the teammate's "Why this reply" shows French and her voice and version
  - Playful saved as version 2, version 1 restored as version 3
- **Failure path:** a guideline without text is refused with the reason, and no version is saved.

**Updated:**
- `tests/ai-escalation.test.ts`: the language rule uses what the customer writes.
- `tests/ai-handover.test.ts`: the classifier's spam index.
- `tests/agent-theme.test.ts`: text on the chosen tone's ground.

## Checks

Results on 4 October 2026:
- `npm test`: 116/116 pass.
- `npm run typecheck`: clean.
- Lint on the changed files: clean.
- `npm run test:e2e`: 102/102 pass.
- `npm run test:postgres`: passes.
- **Checked in the browser, dark and light:**
  - the Guidance page and Try it
  - with unsaved changes, French detection and informal French
  - saving as version 1 and the history
  - the Overview card and side menu
  - the Languages card
