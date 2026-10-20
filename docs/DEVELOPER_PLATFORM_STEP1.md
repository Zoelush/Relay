# Phase 15, step D1: The API's foundation

Branch `platform/d1-api`. Plan: `docs/DEVELOPER_PLATFORM_PLAN.md` (scope: D1 to D5). Behind `developer_api_v1`, off by default and on for the local relay. Next: D2, the rest of the API's coverage, search, and the SDKs.

## What it does

**A public REST API at `/rest`.** Deployed, it's `api.<your domain>/rest`; locally, it's the API server's. It covers:
- **Conversations:** list (by status, assignee or team), read, list their parts, start one for a contact, reply, add a note, assign, snooze, reopen, close, and tag and untag.
- **Contacts:** list (by email or your id), read, create a user or a lead, and update their name and custom attributes.
- **Tags:** list and create.
- **Teammates and teams:** list and read.
- **Who a token is:** `GET /me`.

**Personal access tokens** (Settings › Developers › API tokens):
- **Acting as you:** a token acts as the teammate who made it, within the scopes they chose. Scopes are their own role's permissions, named and grouped as on Roles, so a token never has more than its maker. If the role loses a permission, so do its tokens.
- **Shown once:** a token's text appears once; only its hash is kept.
- **Revoking** takes effect at once.
- **The list** shows each token's owner, scopes, last use and the last hour's calls, including any refused. Who manages the workspace sees and can revoke everyone's.

**What an integration can rely on:**
- **Versions:**
  - `Relay-Version: 2026-10-20` names a version. Without the header, the token's own version is used (fixed when it was made), and every response says which version answered.
  - **The deprecation policy is written down:** a version stays supported for at least 12 months after its successor.
- **Errors:** `{type: "error", request_id, errors: [{code, message, field}]}`.
  - **The code** is stable (`invalid_field`, `unauthorized`, `forbidden`, `not_found`, `rate_limited`…), and **the field** names what's wrong.
  - **Anything unexpected** is `internal_error`, with no detail.
- **Pagination** is by cursor, everywhere (`starting_after`, `pages.next`).
- **Rate limits:**
  - **Per token:** bursts of 100, refilling at 10 a second (600 a minute).
  - **Per workspace:** 1,500 a minute.
  - **Every response** carries `X-RateLimit-*`. Over the limit gets `429` with `Retry-After`. Usage is on the Developers page.
- **Retries:** `Idempotency-Key` makes a `POST` safe to retry. The same key from the same token does the work once.

**The reference is generated from the spec:**
- `docs/API.md` (`npm run api:doc`; a test compares it)
- the `/developers` page
- `/rest/openapi.json`

## How it works

**The spec is the source** (`lib/api-spec.ts`): an OpenAPI 3.1 document, written before each endpoint. Each operation names its scope (`x-relay-scope`). Everything else is derived from it:
- **Validation** (`lib/api-validate.ts`) reads the spec's schemas as they are. A test fails if the spec uses a keyword the validator doesn't check.
- **The router** (`server/rest.ts`) matches requests against the spec's paths. A test fails if an operation has no handler.
- **The reference** (`lib/api-reference.ts`) writes both the Markdown and the page from the spec and one written guide.

**A request:**
1. **The token.** It carries its workspace (`relay_pat_<workspace>_<secret>`), so it's looked up by hash inside that workspace's tenant transaction, with row-level security.
2. **Rate limits** (`server/rate-limit.ts`, a port: in memory locally; a Durable Object when deployed is a TODO for deploy).
3. **The version.**
4. **The scope**, against the token.
5. **Parameters and body**, against the spec.
6. **The teammate's role**, checked now.
7. **The same domain functions the inbox uses.** For a conversation that's `command`, so permissions, the timeline, SLAs, workflows and realtime all behave exactly as when a teammate acts in the inbox.

**Versions** are transforms: the newest is built, and each change names the version before it and translates its requests and responses. A test proves the chain with a temporary older version.

**Tokens** (`server/developer.ts`) are created with the creator's own capabilities as the limit, and revoked by their owner or by who manages the workspace.

**Code:**
- **Migration `0077_developer_api`:** `api_tokens` (hashes only), `api_usage` (per token per minute, kept seven days, pruned as tokens are used) and the flag.
  - **Its rollback** turns the flag off, which refuses every token and closes the page.
- **Routes:** `/rest/*` and `/developers` on the API server (`server/api.ts`, `workers/relay.ts`, the local relay), and `developer-settings` and `developer-token` for the page.
- **The page:** `agent/settings-developers.tsx`, in a new Developers group in Settings.

**Contacts' custom attributes** go into the contact's profile (as segments read them): up to 50, each a string, number, boolean or null. Typed contact attributes and companies are phase 01's, and their endpoints wait for it.

**Seed data:** none of its own. The demo's conversations, contacts, tags and teammates are what the API returns.

## Before building: Intercom's developer settings (read-only look, 20 October 2026)

Looked at, not changed:
- **Settings › Integrations:** has the Developer Hub, Authentication, personal API tokens and data connectors.
- **The personal page** lists OAuth tokens from connected apps, and links to an IP allowlist.
- **The Developer Hub** lists the workspace's apps (three private ones) beside the App Store. Going further asks you to accept Intercom's developer terms, which wasn't done.
- **Not opened:** pages that display access tokens.

## Checks

- **`tests/api.test.ts`:**
  - **The spec as the source:** every operation is served, every keyword is enforced, and the reference matches it.
  - **Tokens:** shape, hashes only, revocation, the flag off, scopes, and never more than the maker's role.
  - **Another workspace's token** sees none of the first's data.
  - **Contacts:** created again by your id returns the same contact; leads; attributes set and removed; lookup by email.
  - **Conversations:**
    - started (once per key)
    - replied to (once per key)
    - noted (internal)
    - assigned (setting the team keeps the assignee)
    - tagged and untagged
    - snoozed, reopened and closed
  - **Lists:** paging and filters.
  - **Errors:** each names its field.
  - **Rate limits:** the 429 with `Retry-After`, refused calls counted, and the burst.
  - **Versions:** an older version's request and response translated.
- **`tests/browser/developers.spec.ts`:**
  - **Happy path:** a token made in Settings calls the API, is counted, and stops working when revoked.
  - **Failure path:** a read-only token can't reply, and a bad parameter is named.
