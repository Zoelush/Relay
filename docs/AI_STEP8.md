# Phase 08, step Z3b: Content targeting

Branch `ai/z3b-targeting`. Plan: `docs/AI_PLAN.md` (decisions 10 and 11). Behind `ai_agent_v1`. With Z3a, this completes Z1–Z3 (B1 as planned). Next: B2, safety and privacy.

## What it does

**"Who Zoe uses it for"**: on every article, snippet and file in Knowledge (under "AI agent can use it", when it's on), and on each website in its Settings, for all its pages:
- **The two choices:** "Everyone who may see it" (the default), or "Only customers and conversations that match".
- **The conditions:** the same editor and closed list as escalation rules and specialists (signed in, email domain, brand, language, page address, tag, conversation attribute), with all or any, up to 10.
- **Zoe only:** the help center and the messenger's Help space keep the item's own audience (public, signed-in or internal).
- **Websites:** a website's targeting is copied onto every one of its pages, as its audience is, and onto new pages as they sync.

**When Zoe answers:**
- **What she leaves out:** the targeted items this customer doesn't pass, before anything is ranked, so they can't affect the ranking or her confidence.
- **With a specialist (Z3a):** an item is used only when the customer passes its targeting and it's in the answering specialist's knowledge.
- **The customer's language** for a language condition is the one she read in what they wrote (Z2).
- **Email-domain conditions** use verified addresses only, as escalation rules do. A visitor's typed address never matches.

**For teammates:**
- **The Playground and the Try it panels** (Guidance, Specialists) say what she skipped for that customer: "Skipped for this customer: Enterprise SLA."
- **"Why this reply":** "Kept 1 item from her for this customer: …", from the answer's record.
- **Zoe's Content page:** a "Targeted" count, and a badge on each targeted item with its conditions in words ("Only when Signed in and Email domain is bigcorp.com").

Customers never see any of it.

## How it works

**`server/ai-targeting.ts`:**
- `validTargeting`: conditions checked with the escalation rules' `validRules`, under the item's name.
- `passes`: a customer against targeting.
- `targetedOut`: reads only switched-on records with conditions, and returns those this customer fails.
- `targetingChoices` and `recordTitles`: for editors and teammates.

**`server/ai-retrieval.ts`:** an `exclude` option, applied in the allowed set's CTE with the other access rules, before keyword or vector ranking.

**`server/ai-agent.ts`:**
- **`decide()`** works out the exclusions from the same facts escalation rules use, just before retrieval.
- **Recording:** every answer records `targeted_out` (up to 100 ids).
- **Reporting:**
  - the Playground returns `skipped` (the count and up to 5 titles)
  - `aiAnswers` returns `targetedOut` (the count and up to 3 titles)

**Saving:**
- **Records:** `server/knowledge.ts`'s settings save takes `aiMatch` and `aiConditions`. The record view returns them, with the choices for managers.
- **Websites:** `server/knowledge-sync.ts` takes them on create and update, copies them to the website's pages, and gives new pages the website's targeting.

**The agent app:**
- **The editor:** `TargetingFields`, `conditionWords` and `targetingWords` in `agent/settings-ai.tsx`, used by Knowledge's settings and the website settings form.
- **Also fixed on Zoe's Content page:** kinds read "1 article" (not "1 articles"), and website pages show as such.

## Migration

`db/postgres/0050_content_targeting.sql` is additive:
- `ai_match` and `ai_conditions` on `knowledge_records` (with a partial index for targeted records) and on `knowledge_sources`
- `ai_answers.targeted_out`

The rollback switches Zoe off for targeted records and websites, rather than letting the previous version, which ignores targeting, use them for everyone. Their conditions are kept.

**Seed data:** none needed. Nothing in the demo is targeted.

## Not included

| Item | When |
|---|---|
| Contact and company attribute conditions | Phase 01 (the people service), as for escalation rules |
| Targeting individual website pages | Not planned (decision 11): a website is targeted as a whole |
| Targeting in the help center or the messenger's Help space | Not planned (decision 10): those keep the item's audience |
| Bulk targeting from Zoe's Content page | Not planned; set it on the item or its website |

## Tests

**`tests/zoe-targeting.test.ts` (new):**
- **Passing:** no conditions, all, any, and no verified email.
- **Refusals:** three, with reasons, and nothing saved.
- **Saving:** a record targeted at bigcorp.com (the domain normalised); other settings keep it.
- **A real website**, signed-in customers only, created and synced from a local test site: both pages carry it, and the website view returns it.
- **The Playground** (nothing written):
  - a visitor gets neither, with the three skipped titles
  - a bigcorp.com customer gets the enterprise article
  - another domain gets the website but not the article
  - a specialist with all of Zoe's content still doesn't get it for a visitor
- **The reply job:** a real conversation records what was skipped, and "Why this reply" shows it.
- **Zoe's Content page:** the count and each item's targeting.
- **The website back to everyone:** its pages follow.
- **Another workspace:** its own untargeted content answers, and it can't name this one's brand.
- **The rollback:** switches Zoe off for the targeted article only.

**`tests/browser/zoe-targeting.spec.ts` (new; ports 9012/9013):**
- **Happy path:**
  - the getting-started article is targeted at signed-in customers in Knowledge
  - in the Playground, a visitor doesn't get it and sees what was skipped; a signed-in customer gets it
  - Zoe's Content page shows the badge and its conditions in words
  - a visitor in the messenger gets "I couldn't find", and the teammate's "Why this reply" says why
- **Failure path:** an email-domain condition without a domain is refused with the reason, and nothing changes.

## Checks

Results on 4 October 2026:
- `npm test`: 119/119 pass.
- `npm run typecheck`: clean.
- Lint on the changed files: clean.
- `npm run test:e2e`: 106/106 pass.
- `npm run test:postgres`: passes.
- **Checked in the browser:**
  - the targeting block in Knowledge's settings
  - saving it
  - the Playground's skipped note
  - Zoe's Content page with the badge
- **Afterwards:** the demo article was put back to "Everyone".
