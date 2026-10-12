# Phase 09, step D1: Data connectors

Branch `ai/d1-connectors`. Plan: `docs/ACTIONS_PLAN.md`. Behind `ai_actions_v1`, off by default and on for the local relay.

## What it does

Zoe › Train › Actions lets those who manage Zoe create a connector: an HTTP integration that looks something up (read only).

**Parts of a connector:**
- **Inputs:** each declared with a type, a pattern and where it comes from:
  - asked of the customer
  - the contact's email, name or signed-in user ID
  - the conversation's ID

  Only declared inputs can appear in the request, as `{{name}}`.
- **The request:** GET or POST to a public https address, with query values, headers and a JSON body.
- **Authentication:**
  - an API key in a header
  - a bearer token
  - OAuth 2 client credentials (the token is cached encrypted until it expires)
- **The response:** named, typed values picked out by path. Zoe never sees anything else.
- **Limits:** timeout, retries and calls a minute.

**Working on a connector:**
- **Editing:** the draft is saved, then published as an immutable version. A conversation keeps the version it first used (`pinnedVersion`).
- **The test console:** a background job that calls the service with sample values. It shows the exact request with credentials masked, the response, and the values Zoe would get.
- **Recent calls:** every call is shown from the append-only audit, `ai_connector_calls`. Sensitive inputs are redacted, even in the URL, and only mapped values are kept.

**What it guards against:**
- private addresses, refused at save and at call
- redirects, never followed
- context inputs supplied by anyone other than the conversation (refused)
- an anonymous visitor's user ID (never used)

**What each call reports:** timeouts, 4xx and 5xx responses, non-JSON, wrong types, refused credentials and the rate limit each come back with a plain reason.

## How it works

- **Migration `0054_ai_connectors`:** connectors, versions, pins, secrets, tokens, the rate limit and calls. Its rollback turns the flag off and drops cached tokens.
- **`lib/connector-definition.ts`:** validation, templating and mapping, shared with the page.
- **`server/connectors.ts`:** storage, encryption, `runConnector`, the `connector.test` job, and reads and changes.
- **`safeRequest`** in `server/safe-fetch.ts`.
- **Routes:**
  - `GET zoe?view=connectors|connector`
  - `POST zoe-connector`
- **The secret:**
  - `RELAY_CONNECTOR_KEY` for the Worker; connectors are unavailable without it
  - the local relay generates one and keeps it in `local-secrets.json`
- **Seed:** the flag is on locally, and every test uses recorded fixtures.

## Not included

These come in later steps:
- Zoe using connectors in conversations (D2, procedures).
- Write access (D3).
- OAuth on behalf of the workspace (D4).
- Contact custom attributes as input sources.

## Checks

- **`tests/connectors.test.ts`:**
  - **The definition:** validation, encoding, typed body placeholders and mapping.
  - **Managing connectors:**
    - off by default
    - managers only
    - another workspace can't see or call them
    - unique names
    - private addresses refused
    - saving by version
    - a credential needed to publish, stored encrypted and never returned
  - **The test console:** masked, with inputs checked before sending.
  - **The audit:** redacted and append-only.
  - **Versions:** immutable, and pinned per conversation.
  - **Context inputs:** only from the conversation.
  - **Failures:** a 500 retried, a 404, a timeout retried, non-JSON, a wrong type, a 401, the rate limit.
  - **OAuth:** the token fetched once, cached and encrypted.
  - **The rollback.**
- **`tests/browser/zoe-actions.spec.ts`** (ports 9020 and 9021):
  - **Happy path:** an order lookup built in the UI, its key set, tested and published.
  - **Failure paths:** an undeclared placeholder refused, a private address refused, and a timeout shown.
