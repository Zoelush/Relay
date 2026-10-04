# Phase 08, step Z1: Zoe's home, and colour across Relay

Branch `ai/z1-zoe`. Plan: `docs/AI_PLAN.md` (B1 became Z1–Z3 on 4 October 2026, on request). Behind `ai_agent_v1`. Next: Z2, how Zoe answers.

Relay's AI agent is now **Zoe**. Before building, Beacon's agent ("Ray") and Intercom's ("Fin") were scoped read-only in the browser: nothing was changed, saved, sent or tested in either account, and no customer or teammate data was recorded.

## What it does

**Zoe in the icon strip,** between Inbox and Knowledge, where Beacon and Intercom put their agents:
- **Her mark:** a sparkle on her signature teal-to-emerald gradient.
- **Her side menu:**
  - an identity card: her name, with Live or Off
  - Overview
  - Train: Escalation, Content
  - Test: Playground
  - Deploy: Messenger
  - Analyze: Performance, Knowledge gaps, Resolutions
  - Settings
- **Addresses:** each page has its own, `#zoe/<page>`.
- **Who sees it:** managers, while the AI agent is on.

**Her pages:**
- **Overview:**
  - **The top:** her name, Live or Off, and an "Answering customers" switch.
  - **The last 30 days:** resolution rate (her net resolutions over the conversations she took part in), answers, handovers, average confidence.
  - **Cards:** Escalation (rules, topics and guidance counts), Content (what she can use), Playground.
  - **Panels:** the questions she couldn't answer (the same question counted once, with how often), and the articles she leans on most.
  - **A "Try Zoe yourself" banner.**
- **Escalation:** handing over, outside office hours, rules, never-handle topics and guidance. They moved here from Settings › AI agent.
- **Content:**
  - what she answers from: published, switched on for the AI agent, never internal
  - counts by kind, signed-in-only items, and what's excluded
  - each item with the languages it's in and how often she cited it
  - a link to manage it in Knowledge
- **Playground:**
  - **Asking:** ask as a visitor or a signed-in customer (optionally with an email, for email-domain rules), on a brand, in a language, on a page.
  - **Her answer:** what she'd reply, with her sources or buttons.
  - **Why:** the outcome and why, her confidence against the threshold (a meter), the language, the model and the time.
  - **Passages:** the ones she weighed, marking those given to her.
  - **Suggested questions:** from her most-used articles and knowledge gaps.
  - **Nothing is written:** no message, no audit row, no retrieval count, no ledger row. Deployed, each question is a real model call.
- **Messenger (Deploy):** each brand's messenger, whether she's live, which messenger version is live, how many websites it was seen on in the last 7 days, and her name there.
- **Performance:**
  - resolved (confirmed, quiet, reversed)
  - messages considered
  - median time to answer and average confidence
  - outcome and handover-trigger breakdowns as bars
- **Knowledge gaps:** the 50 questions she couldn't answer most often, with when they were last asked and the conversation.
- **Resolutions:** the ledger and its window (A3), moved here.
- **Settings:**
  - **Answering:** on or off, when she answers, and a new **confidence threshold** (20% to 90%).
  - **Her identity on each brand:** name, avatar for the light and dark messenger (uploaded, PNG, JPG or GIF up to 1 MB), an AI disclosure, and her reply to a greeting in the brand's language.

Settings › AI agent became a link card that opens Zoe.

**Customers see Zoe:**
- **Her replies** in the messenger carry her avatar (her sparkle in the brand's colour unless one is uploaded), her name and an "AI agent" label. The messenger still has no colour of its own (M4).
- **The disclosure,** if set, sits above her first reply in a conversation.
- **Her greeting** is used when a customer just says hello in the brand's language; other languages get the built-in translation.

**Teammates see Zoe:**
- **Her name and mark** on her replies ("Zoe · AI agent") in the timeline.
- **Her handover summary** ("Handover summary from Zoe · Team only"), which begins "Handed over by Zoe."
- **Her resolutions:** "Resolved by Zoe: …".
- **On cards:** "Zoe · escalated" and the like.
- **The inbox menu:** a section under her name with **With Zoe** (she replied and waits on the customer) and **Escalated by Zoe**.

**Renaming:**
- The workspace's agent is called Zoe; workspaces that kept "AI agent" were renamed by the migration.
- Renaming her on the default brand renames her everywhere, including the strip, her views (on their next initialize) and the prompt.

**Colour across Relay**, after Beacon and Intercom, where colour marks meaning and neutrals stay neutral:
- **The icon strip:** Inbox blue, Zoe her gradient tile, Knowledge amber, Notifications rose, Shortcuts violet, Settings slate. The open area sits on a soft tile of its colour.
- **Side menus:**
  - inbox views: Your inbox blue, Mentions violet, Unassigned amber, All teal
  - each team inbox gets its own colour
  - custom views slate, and Zoe's views hers and rose
  - Knowledge's areas and Zoe's pages each have a tint
- **Settings:** each group has a colour, on its menu icons and its home tiles (Personal sky, Workspace violet, Helpdesk blue, Channels teal, Inbox amber, Knowledge & AI rose).
- **Avatars:** customers and teammates get a stable colour each, from their name.
- **The palette:** eight tints (a strong tone on a soft ground) and Zoe's gradient, as named tokens with light and dark values. The theme test checks:
  - each tint as text (avatar initials) on its own ground and on the page at 4.5:1, and Zoe's text tone likewise
  - tinted icons on the strip and menus (at rest, hovered and open) at 3:1
  - text on Zoe's gradient at 4.5:1 at both ends

## How it works

**`server/zoe.ts`:**
- **Access:** `zoeAccess` (managers, with the agent on).
- **Identity:** `identityFor`, `greetingFor`, `listIdentities` and `saveIdentity`. Avatars must be this brand's ready uploads in the right place; the default brand's name is the agent's.
- **The messenger's boot:** `bootIdentity`.
- **The pages' data:** `zoeOverview`, `zoePerformance`, `zoeGaps`, `zoeContent` and `zoeDeploy`, computed over the last 30 days from `ai_answers`, `ai_resolutions` and the knowledge store.

**Decisions are shared** (`server/ai-agent.ts`): the reply job and the Playground run the same `decide()`:
- the triggers (rules, the button's words, office hours, topic keywords, the classifier)
- the greeting
- retrieval and the gate
- the checked model reply
- the failed-answers limit

The job writes the result; `previewAiReply` only returns it.

**Routes:**
- `GET /v1/agent/zoe?view=overview|performance|gaps|content|deploy`
- `POST /v1/agent/zoe-identity` (idempotent)
- `POST /v1/agent/zoe-playground`
- `ai-settings` now carries identities and the threshold, and no longer needs the Settings area's flag
- the inbox snapshot carries `ai` (her name) and `capabilities.zoe`

**Avatars:**
- **Uploads:** they reuse the M5 upload path (`brand_assets`, purposes `agent_avatar` and `agent_avatar_dark`) under the AI agent's permission.
- **Serving:** served to customers once an identity uses them.
- **Tidying:** never tidied while used.

**The agent app:**
- `agent/zoe.tsx` is her area.
- `agent/colour.tsx` holds the tints (`hueOf`), her mark (`ZoeMark`) and her name in context (`AgentName`).
- The settings editors in `agent/settings-ai.tsx` are sections that her pages share.

## Migration

`db/postgres/0047_zoe.sql` is additive:
- the agent's default name becomes Zoe, and "AI agent" is renamed
- `ai_agent_identities`, with row-level security
- the new upload purposes

The rollback removes avatar uploads and restores the old purpose check. The identities table stays, and the previous version ignores it. The name Zoe stays.

## Not included

| Item | When |
|---|---|
| Tone of voice, answer length, formality, language detection and allowlist, answer guidance (Train › Guidance) | Z2 |
| Specialists and content targeting (Train › Specialists) | Z3 |
| Test suites | C1 |
| Actions and procedures (calling your systems) | Phase 09 |
| Trend charts | Phase 14 |
| Opening a gap's or a ledger row's conversation from Zoe's pages (the id is shown) | When the agent app gets conversation links |

## Tests

**`tests/zoe.test.ts` (new):**
- **Access:** she starts as Zoe, managers only (403 for agents on every page and the Playground), and the inbox snapshot names her.
- **Identity:**
  - five refusals with their reasons, and an unknown brand gets 404
  - an avatar uploaded under the AI agent's permission, refused in the dark slot, saved in its own
  - the default brand's name renames her
  - the boot carries her name, Relay's avatar address and the disclosure, and the avatar is served
  - the greeting in the brand's language
  - switched off, there's no identity in the boot
- **The Playground:**
  - an answer with sources, confidence and named passages
  - a refusal with the person button
  - an email-domain rule handing over
  - the greeting from her identity, and the built-in French one
  - nothing is written (messages, audits, retrieval counts, ledger)
  - an empty question is refused
- **The numbers:** Overview, Performance, Content, Deploy and Knowledge gaps:
  - the same question asked twice is grouped
  - switched-off and internal content isn't hers
- **Another workspace:**
  - its own Zoe and no numbers
  - none of this one's content in its Playground
  - it can't use this one's avatar
  - with the agent off: no area, no boot identity, no name in the snapshot

**`tests/browser/zoe.spec.ts` (new; ports 9006/9007):**
- **Happy path:**
  - the strip shows Inbox, Zoe and Knowledge in their colours, and Zoe opens at `#zoe`
  - the Overview is live, with the knowledge gap a customer just caused
  - the Playground answers from the help center with its source and a confidence meter, and records nothing
  - she's renamed Ada with a disclosure; the strip relabels at once, and a customer sees "Ada · AI agent" and the disclosure on her reply
- **Failure path:** an identity without a name is refused with the reason, and her name doesn't change.

**Updated:**
- In `tests/browser/`:
  - `ai-agent.spec.ts`: her name on replies
  - `ai-handover.spec.ts`, `ai-escalation.spec.ts` and `ai-resolutions.spec.ts`: her pages and labels
  - `app-shell.spec.ts`: Tab from Inbox reaches Zoe, then Knowledge
- `tests/ai-handover.test.ts`: her views and summary.
- `tests/agent-theme.test.ts`: the new tints and her gradient.

## Checks

Results on 4 October 2026:
- `npm test`: 112/112 pass.
- `npm run typecheck`: clean.
- Lint: nothing new; an error and a warning in `agent/views.tsx` predate this step.
- `npm run test:e2e`: 100/100.
- `npm run test:postgres`: passes.
- **Checked in the browser, light and dark:**
  - Zoe's Overview and side menu
  - the Playground answering
  - the inbox menu's colours
  - Settings home's tinted tiles
