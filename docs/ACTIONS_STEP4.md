# Phase 09, step D4: OAuth on the workspace's behalf, and the audit view

Branch `ai/d4-oauth-audit`. Plan: `docs/ACTIONS_PLAN.md` (decision 9). Behind `ai_actions_v1`, off by default and on for the local relay. This completes phase 09's plan.

## What it does

**Connecting a service on the workspace's behalf** (OAuth 2, authorization code):
- **Setting it up:** a connector's authentication can be "OAuth 2 (connect on your workspace's behalf)": the service's authorization and token addresses, a client ID, a scope and a client secret. The page shows the return address to register with the service: the agent app's own `/agent`.
- **Connecting:** a manager presses **Connect**, signs in at the service, and comes back to Zoe › Actions with the connector open and "Connected."
  - The page then shows who connected it and when.
  - Zoe uses that connection for every conversation.
  - **Connect again** and **Disconnect** are always there.
- **If they refuse at the service,** the page says so and nothing is stored.
- **The address** never keeps the code or state after the return.
- **Behind the scenes:**
  - PKCE (S256)
  - a one-time state, kept only as a hash, valid 10 minutes, and only for the manager who started it
  - the code exchanged for tokens once
  - the refresh token encrypted like any credential and never returned
- **When Zoe uses it:** the access token is cached encrypted until it expires, then refreshed with the refresh token. A provider that rotates refresh tokens has the new one kept. A 401 refreshes once.
  - **If the service didn't give a refresh token,** the connection is refused with how to fix it (ask for offline access).
  - **Disconnected or never connected,** a call fails plainly: "It isn't connected yet: connect it under Actions."

**The audit for one conversation** (the phase's acceptance demonstration):
- **Where:** "Zoe's actions" beside the conversation lists, in time order:
  - each procedure that ran (version, how it ended and why, steps taken)
  - each connector call (who, which connector and version, read or write, result, status, time, attempts)
  - each approval (who decided, and their note)
- **What was sent and returned** opens under each call:
  - the address and inputs, with sensitive ones redacted when they were recorded
  - the values it got back
  - the idempotency key for a write
- **Who sees what:** that detail is shown only to teammates allowed to see customers' personal data. Others see what happened, not what was sent. It appears only when Zoe did something there.
- **Copy log:** copies the same audit as plain text:

```
Zoe's actions in conversation cd6c70e2-…

2026-10-12 21:00:30 UTC  Procedure “My booking” (version 1) started; resolved at 2026-10-12 21:00:30 UTC.
    Procedure “My booking” (version 1), steps 1, 2, 3: Resolved.
2026-10-12 21:00:30 UTC  Zoe called Bookings (version 1): ok (200) in 6 ms.
    GET https://api.calendar.example/v1/bookings?email=[redacted]
    Sent: {"email":"[redacted]"}
    Got: {"next_booking":"Tuesday 14 October, 10:00"}
```

## How it works

**Migration `0057_ai_oauth_audit`:**
- `refresh_token` added to `ai_connector_secrets`' names
- `ai_connector_oauth_states`
- **The rollback:** drops connections in progress and archives connectors that use OAuth on the workspace's behalf, which the previous version doesn't know.

**Code:**
- **`lib/connector-definition.ts`:** the `oauth_authorization_code` auth type.
- **`server/connectors.ts`:**
  - **`oauth_start`:** builds the provider's address with PKCE and the hashed state.
  - **`finishOAuth`:** runs in its own transactions, so a refused code can't be retried with the same state, and no network call happens inside a transaction:
    1. the state is used up
    2. the code is exchanged
    3. the tokens are stored
  - **`oauth_disconnect`.**
  - **`runConnector`:** refreshes and rotates tokens.
- **`components/relay/postgres-inbox.tsx`:** finishes a connection when the app loads with a `relay_` state, then opens Zoe › Actions (`agent/zoe-actions.tsx` shows how it went).
- **`server/ai-audit.ts`:** `readAiAudit` (conversations.read; detail with contacts.personal_data) and `auditText`.
- **Route:** `GET ai-audit?conversation=`.
- **In the agent app:** `AiAudit` in `agent/sidebar.tsx`.
- **Audit order:** a procedure run's start is now when its turn began, so it sorts before the calls it made. Its stored reason is the full one, with its steps.

## Decisions

- **Finishing a connection is interactive, not a job.** The manager is waiting for it, and it's a single token request with the connector's timeout, like the Playground's model call. It runs outside any database transaction.
- **The return address is the agent app itself** (`/agent`), so connecting needs no new public endpoint, and the code arrives through the signed-in session's own requests.
- **Audit detail follows personal-data permission,** because connectors' values can be about the customer.

## Not included

- **Retention for the connector audit:** it's kept for now. A retention period belongs with phase 13's data controls.
- **Exporting a conversation's audit as a file:** Copy log covers the demonstration. Phase 14's exports can add it.

## Checks

- **`tests/oauth-audit.test.ts`:**
  - **Connecting:**
    - needs the client secret
    - return addresses checked
    - managers only
    - PKCE, with the state stored only hashed
  - **The state:** forged, refused, used up after a refused code, other workspaces, and no refresh token.
  - **The connection:**
    - connected, with secrets encrypted
    - calls with the cached token
    - expiry refreshed, and a rotated refresh token kept
    - disconnect, then a plain failure
  - **The audit, after a procedure used the connector in a conversation:**
    - order and detail
    - the text form
    - detail hidden without personal-data permission
    - other workspaces
  - **The rollback.**
- **`tests/browser/zoe-oauth-audit.spec.ts`** (ports 9026 and 9027; the provider's sign-in page is intercepted):
  - **Failure path:** refused at the provider, then connected, with nothing left in the address.
  - **Happy path:** a signed-in customer's booking looked up, and the audit beside the conversation with what was sent opened.
- **Test fixes:** `tests/procedures.test.ts`, `tests/write-actions.test.ts` and `tests/oauth-audit.test.ts` now clear the brand's office-hours calendar, as the browser tests do. A handover in the evening said "the team is away" and failed them.
