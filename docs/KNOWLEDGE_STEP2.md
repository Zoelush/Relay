# Phase 07, step A2: help center structure

Branch `phase-07/step-a2`. Plan: `docs/KNOWLEDGE_PLAN.md`. Approved on 1 October 2026:
- at most one help center per brand
- clean slugs per language, with a redirect history
- collection → optional section → article
- missing translations fall back along the language chain

There are no public pages yet; step B1 renders them from what this step stores.

## What it does

**Help centers.** At most one per brand. Each has:
- a name and an address (slug)
- a default language and its other languages, canonicalised, up to 30
- a theme: colour, solid or light header, font
- a homepage of up to four blocks in order: search, collections, featured articles, contact
- a "hide from search engines" switch

**Structure.**
- Collections contain optional sections. The depth is fixed at two: there are no sections inside sections.
- An article can sit directly in a collection or in a section, and in several places at once.
- Collections and sections have a name, a description and an address per language, and can be archived and restored. Archiving a collection hides its sections too. Nothing is deleted.

**What can be placed.** Only articles (not snippets or internal articles) with "Show in the help center" on. Each refusal has its own reason. Turning the switch off hides the article everywhere but keeps its placements, so turning it back on restores it. The editor shows why a placed article wouldn't appear: its switch is off, or it isn't published in any of the help center's languages.

**Slugs.**
- **Generated:**
  - from the title, with accents removed: "Réinitialiser" becomes `reinitialiser`, "Straße" becomes `strasse`
  - cut at a word boundary at 80 characters
  - `-2`, `-3` and so on on a collision
  - text with no Latin letters gets a short generated slug
- **When:** an article gets its address when a language is first published. After that it stays the same unless a teammate edits it ("Public address" in the article editor).
- **Unique:**
  - articles per language across the workspace
  - collections and sections per help center and language
  - help centers per workspace
- **Redirects:** every old slug becomes a redirect to its object (`help_redirects`). Redirects point at ids, not at other slugs, so a chain of renames always lands on the current address. A live slug always wins over a redirect, so renaming back and forth never loops, and another object can take an old slug.

**Language fallback.** `resolveLocale` (in `lib/help-paths.ts`) turns a requested language into the help center's language plus a chain:
- `fr-CA → fr → default`
- an unsupported region goes to its supported base: `fr-BE → fr`
- anything else goes to the default

**Resolving public paths.** `resolvePath(db, workspace, "relay-help/fr-CA/articles/…")` returns one of:
- what to show
- a redirect for an old slug, an old help center address, another language's slug, or an unsupported language
- not found

An article without a version in the requested language is shown in the first language along the chain it's published in. Its canonical page is that language's, so search engines see no duplicates. The same applies to collection and section names. Step B1 renders the result.

**The Help centers tab** in Knowledge (for `knowledge.manage`) has:
- create a help center for a brand without one
- settings, with theme and homepage block ordering
- the tree: names and addresses per language (with "Names in" a language), up and down reordering, archive, add a section, add an article, remove an article
- the old addresses that redirect to each item

**The article editor** now has a "Public address" field per language, with a suggestion when what's typed isn't a valid slug.

## API

- `GET /v1/agent/help-centers`: help centers and brands.
- `GET /v1/agent/help-center?id=`: settings, tree, placements and redirects.
- `POST /v1/agent/help-centers` with `op`:
  - help centers: `center_create`, `center_settings` (with `version`)
  - collections and sections: `node_create`, `node_update` (with `version`), `node_archive`, `node_restore`
  - order and placement: `arrange`, `place`, `unplace`

  Writes are idempotent on the request key.
- `POST /v1/agent/knowledge` gains `op: "slug"`.
- `arrange` must name exactly the current members, so an add or remove made at the same time isn't silently lost (`HELP_CENTER_CONFLICT`).
- Everything needs `knowledge.manage` and `knowledge_v1`, and is scoped to the workspace by row-level security.

## Migration

`db/postgres/0030_help_centers.sql` is additive:
- `knowledge_locales.slug`, with a unique index per workspace and language
- the tables `help_centers`, `help_nodes`, `help_node_locales`, `help_placements` and `help_redirects`, with row-level security

The rollback `db/rollback/0030_help_centers.sql` is a no-op, because the previous version ignores these tables. Article languages published before 0030 get an address on their next publish, or when one is set by hand; no deployed workspace has knowledge content yet.

## Seed

The local relay adds a "Relay Help" help center for the default brand (English and French) with:
- the collection "Getting started", containing the section "Your first conversation", which holds the sample article
- the collection "Billing"

## Tests

**`tests/help-centers.test.ts`:**
- slugs: accents, special letters, punctuation, length, non-Latin scripts
- language fallback
- one help center per brand, settings conflicts, theme and layout validation
- the depth limit
- placement rules and reasons, placing in several places
- slugs on publish
- path resolution: fallback, canonical, unsupported language, not found
- article slug renames twice and back, without loops; a redirect slug claimed by another article
- visibility: switch, archive
- collection names per language with fallback and slug redirects
- the help center's own slug
- arrange conflicts, featured articles that can't be placed
- a retried create
- cross-workspace isolation

**`tests/browser/help-centers.spec.ts`:**
- **Happy path:**
  - add a collection, a section and an article, and reorder
  - rename the section's address and see "Redirects from"
  - add a French name, which shows English until then
  - rename an article's address
  - old links redirect, and French falls back to English with an English canonical
- **Failure path:**
  - placing an article whose help center switch is off is refused with the reason, and nothing is placed
  - Grace has no Help centers tab

## Notes

- **The failure path:** the plan said "placing an internal article is refused". Internal articles aren't offered in the editor's picker at all, so the browser failure test uses the case a teammate can actually hit: an article whose help center switch is off. Refusing internal articles and snippets is covered by the unit test.
- **Deferred:**
  - a theme logo: step C1, which brings file storage for knowledge
  - rendering, domains, signed-in access and the portal mount: step B1
  - search over the help center: step B2

## Checks

Results on 1 October 2026: `npm test` 69/69; `npm run typecheck` clean; lint clean on the changed files; `npm run test:e2e` 45/45.
