# Phase 15, step D2: Coverage, search, export and the SDKs

Branch `platform/d2-coverage`. Plan: `docs/DEVELOPER_PLATFORM_PLAN.md` (scope: D1 to D5). Behind `developer_api_v1` (and each area's own switch). Next: D3, webhooks.

## What it does

**The rest of the brief's coverage.** The reference is `docs/API.md`, generated.
- **Tickets:**
  - list them (by type or state kind) and read one
  - make a conversation a ticket
  - move its state (the type's transitions hold)
- **Ticket types:** list, and read one with its states.
- **Help centers:** list, and read one with its collections.
- **Articles:**
  - list (published or drafts) and read one
  - create one as a draft from plain text
  - update the draft
  - publish it
- **Knowledge records:** list (by kind) and read one: articles, internal articles, snippets, files and synced pages.
- **Macros:** list and read them, and apply one to a conversation. That runs its actions and sends its reply or note: the API has no composer to put the text into.
- **Workflows:** list and read them, list a workflow's runs, and trigger a live manual workflow on a conversation (it runs in the background).
- **Outbound messages:** list, and read one with what it reached (sent, seen, replied, clicked, dismissed).
- **Events:** record one for a contact (your `id` dedupes, so retries are safe), and list a contact's events.
- **Data attributes:** list conversation and contact attributes, and create a conversation attribute.
- **Segments:** list the saved and built-in segments, and list who's in one, paged by cursor.
- **Data export:**
  - **What's exported:** conversations, contacts and/or tickets, optionally by creation date, as newline-delimited JSON in the API's own shapes.
  - **How it runs:** in the background. Fetch the export for its progress, then links to its files, each valid for an hour.
  - **Who sees it:** only the teammate whose token started it.

**Search** (`POST /conversations/search`, `POST /contacts/search`):
- **The grammar:** a query is a condition `{field, operator, value}` or a group `{operator: AND|OR, value: […]}`, up to 3 groups deep and 20 conditions.
- **Operators by type:**
  - **Text:** `= != IN NIN ~ !~ ^ $`
  - **Choice:** `= != IN NIN`
  - **Number and time:** `= != < > <= >=`
  - **Boolean:** `= !=`
- **Fields:**
  - **Conversations:** id, status, channel, brand, assignee, team, contact, tag, priority, created, updated, and waiting since.
  - **Contacts:** id, role, name, email, external id, first and last seen, signed up, and `custom_attributes.<name>`.
- **Sorting and paging:** sortable fields are marked in the reference; results are cursor-paged.
- **Refusals** name the part of the query at fault (`query.value[1].operator`).

**SDKs**, generated from the spec by `npm run api:doc`, with no dependencies:
- **JavaScript:** `sdk/javascript/relay.mjs`, with TypeScript types in `relay.d.ts`.
- **Python:** `sdk/python/relay.py`, standard library only.
- **What they share:**
  - a method per operation
  - the token and a pinned version
  - an idempotency key on every POST, yours or one made for the call and reused on its retries
  - a wait-and-retry on 429 that honours `Retry-After`
  - an `…All` / `iter_…` that follows the pages
  - an error carrying the status, code, field and request id

## How it works

**Reads and writes:**
- **Reads are the API's own queries,** into the shapes the spec promises, so a change to the inbox's screens can't change the API. Each area's feature switch is checked first.
- **Writes go through each area's domain function,** as the token's teammate:
  - `command` for tickets and macro replies
  - `changeKnowledge` for articles
  - `applyMacro`, `runManually`, `recordEvent` and `saveAttribute` for the rest

  So permissions, the timeline, SLAs, workflows and realtime behave as in the inbox.
- **Where the code is:**
  - **`server/rest-more.ts`:** the handlers, merged into the router (looked up when called; the two files import each other).
  - **`lib/api-search.ts`:** search.
    - **Its registry:** fields by resource, each with a type and its operators.
    - **Compiled to SQL:** a query becomes SQL over fixed columns, with every value a parameter. Wildcards in text are literal, and memberships (tags, emails) are `EXISTS`.
    - **Documented from the same registry,** so the reference's tables are what's enforced.
- **Segments** are paged by contact id through the segment compiler (`compileSegment`), not the Outbound screen's offset pages.
- **Exports:**
  - **The job:** `api.export`, registered in the local relay and the Worker. Each step writes up to 1,000 rows of one resource to one file in the attachments store, and continues until done.
  - **Links** are signed when fetched, and always absolute.

**Code:** `lib/api-spec.ts` (D2's block), `lib/api-search.ts`, `lib/api-sdk.ts` (the generators), `lib/api-reference.ts` (search sections), `server/rest-more.ts`, `scripts/api-doc.ts`, `sdk/`.

**No migration:** D2 reads what each area already stores.

**Seed data:** none of its own. The demo's data is what the API returns.

## Checks

- **`tests/api-coverage.test.ts`:**
  - **The SDKs** match their generator.
  - **Through the generated JavaScript SDK:**
    - **Events:** dedupe.
    - **Conversation search:** nested AND/OR, tag membership and its negation, waiting since, sorting, and paging item by item.
    - **Contact search:** email (ignoring case), a numeric custom attribute, starts-with, literal wildcards, and five refusals each naming its place.
    - **Tickets:** made, moved, an illegal move refused, and filtered.
    - **Articles:** drafted, edited, published and listed.
    - **Macros:** applied, with the reply sent.
    - **Workflows:** a draft can't be run.
    - **Outbound:** numbers.
    - **Attributes, and a segment's members paged.**
    - **An export:** run in parts, with its files read back.
    - **The SDK** waits out a 429.
    - **Another workspace** sees none of it.
  - **The Python SDK** against a running API: paging, a named error, and the 429 retry.
- **`tests/browser/developers.spec.ts`:**
  - **Happy path:** with a token made in Settings, the generated SDK searches the running relay. An export is run by the relay's own jobs and its file downloads.
  - **Failure path:** a bad query names its part, and an export without the scope is refused.
