# Phase 07, step A1 — knowledge store core and the article editor

Branch `phase-07/step-a1`. Plan: `docs/KNOWLEDGE_PLAN.md`.

## What it does

- **One store.** `knowledge_records` holds every kind of content with a `source`: `article`, `internal_article`, `snippet`, `file` or `external_page`. Each record has an owner, an audience (everyone, signed-in customers, internal), a last-reviewed date and three independent switches: the AI agent, the help center and the inbox.
- **Internal content never reaches customers.** A database check and the server both refuse the AI-agent or help-center switch on internal content (the AI agent answers customers). Only public articles can be in the help center. The settings panel turns those switches off and explains why.
- **Languages.** Content lives per locale in `knowledge_locales`. Each locale has its own draft and its own published version, published, unpublished or archived on its own. Locales are canonicalised (`en-gb` → `en-GB`). A new language starts from the current one's draft.
- **Autosave and conflicts.** The editor saves the draft 0.8 s after typing stops, from the draft version it started from. If another tab or teammate saved first, the save is refused (`DRAFT_CONFLICT`), nothing is overwritten, autosave stops, and "Reload the latest" brings in their version.
- **History.** Every publish is an immutable revision (`knowledge_revisions`, protected by a trigger). Restoring a revision makes it the draft; the live version doesn't change until it's published again, as a new revision.
- **The article editor** (`agent/article-editor.tsx`) is TipTap with Relay's article profile: headings 2–4, lists, quotes, code blocks with a language, callouts (info, warning, success), tables (add and delete rows and columns), YouTube and Vimeo videos (pasted addresses; anything else is refused in place), links, and links to other knowledge records by id. The server validates every save against the same profile (`normalizeDoc(…, { article: true })`); messages still refuse article-only content.
- **The Knowledge section** in the inbox nav (when `knowledge_v1` is on): a list with search by title and a kind filter, "New article / internal article / snippet", and the record view with language tabs, save status, publish, unpublish, archive, settings (audience, switches, owner, "Mark reviewed") and published versions with restore. It's lazy-loaded with its own editor chunk. The inbox stays mounted underneath, keeping its place.
- **Permissions.** Writing and publishing need the new `knowledge.manage` capability, given to roles that have `workspace.manage`. Other teammates see only records available to the inbox, only their published versions, read-only, with no history.

## API

- `GET /v1/agent/knowledge?source=&q=`: the list (managers see everything).
- `GET /v1/agent/knowledge-record?id=`: one record, its locales and revisions.
- `POST /v1/agent/knowledge` with `op`: `create`, `settings` (with `version`), `review`, `add_locale`, `save` (with `draftVersion`), `publish`, `unpublish`, `archive`, `restore`. Idempotent on the request key like other agent writes. Knowledge posts accept bodies up to 1 MB (others keep 20 KB, bulk 256 KB).
- All behind `knowledge_v1` and scoped to the workspace by row-level security; another workspace's record is a 404.

## Migration

`db/postgres/0029_knowledge.sql` (additive: three tables, row-level security, the capability and the flag, off). Rollback `db/rollback/0029_knowledge.sql` turns the flag off.

## Seed

The local relay turns `knowledge_v1` on and seeds two records per workspace: a published public article ("Getting started with Relay", with a heading and a callout) and an internal draft ("Refund approvals").

## Tests

- `tests/knowledge.test.ts`: the article profile (valid and refused content, alt text required, messages refusing article nodes); the store (flag, permissions, internal rules, locale canonicalisation, autosave and conflict, publish and revisions, restore, immutable revisions, add language, unpublish and archive, settings conflict, review, a body over 20 KB, non-manager visibility, search and kind filters, cross-workspace 404s, a retried create returning the first result).
- `tests/browser/knowledge.spec.ts`:
  - happy path: a new article with a heading, callout, video and table, autosaved; published; French added and published on its own; English changed and republished; version 1 restored into the draft while version 2 stays live
  - failure path: a draft saved elsewhere first is not overwritten (publish disabled, reload brings it in); internal content can't be offered to the AI agent; Grace (an agent) only reads published content

## Deferred, with owners

- **Image upload in articles:** step C1. Attachments are tied to conversations today; C1 adds storage for knowledge files. The profile already validates images and requires alt text; the editor shows existing images but can't add them yet.
- **Creating files and synced pages:** step C1 (by upload and crawl, not by hand; `create` refuses them with `KNOWLEDGE_SOURCE`).
- **Chunking and embedding on publish:** step C2 (`TODO(phase 07 C2)` in `server/knowledge.ts`).
- **Slugs, collections and the public pages:** steps A2 and B1. Links between records already use ids, so they will survive slug changes.

## Found while testing

Two editor bugs, fixed before commit: inserting a table straight after a video replaced the video (the video stayed selected), and a new table left the cursor in its last cell. Both inserts now add a paragraph after them, and a table puts the cursor in its first cell.

## Checks

Results on 1 October 2026: `npm test` 66/66; `npm run typecheck` clean; lint clean on the changed files; `npm run test:e2e` 43/43 (no "Relay API failed" logged); the knowledge browser spec passed again after knowledge writes were made idempotent.
