# Phase 15: Developer platform (plan)

Brief: `docs/BUILD_PHASES.md` phase 15. It needs phases 01 to 06: 02 to 06 are done locally, and 01 is partial (no companies, custom objects or tags on people). Drafted on 20 October 2026, after "go ahead with phase 15", and approved that day: the scope D1 to D5 (D6 waits until asked), and a read-only look at Intercom's developer settings before D1.

The brief's point: an integrations team says yes when Relay has a real API, real webhooks, and a way to show their own data inside the inbox. The cut list ranks the first two above the third: "Public API and webhooks (phase 15). This is how you get out of 'cannot replace our stack'" stays, while "App framework and app store" may wait. But the acceptance test is an app: an order-lookup card in the inbox sidebar, built end to end against Relay's own API.

## Where Relay is today

**Already there:**
- **Endpoints for Relay's own clients:** the agent app's `/v1/agent/*`, behind the host's bridge. These are internal, not a public contract.
- **Endpoints called by others' servers:**
  - `POST /v1/events` (a JWT signed with the workspace's identity key)
  - a workflow's webhook trigger (a secret kept as a hash)
  - providers' signed callbacks (SES, Twilio, Meta, Slack)
- **The permission registry** (`server/policy.ts`, 21 capabilities) that every route checks. OAuth scopes and token scopes map onto it.
- **The change stream:** the outbox, read by realtime and reporting. Webhooks are its third reader.
- **Jobs with retries and a dead-letter state,** and per-minute rate counters (`ai_connector_rate`, phase 09).
- **Signed outbound requests** (`safeRequest`, public https only, phase 09).
- **Alert email** (`sendAlert`, through `mayDeliver`).

**Missing:**
- A public API, a spec, tokens, OAuth apps, webhook subscriptions, and any app framework.
- **Companies and custom objects (phase 01)** are on the brief's coverage list but don't exist. Their endpoints wait for phase 01 (a TODO, not scaffolding).

## Steps

| Step | Scope |
|---|---|
| **D1: The API's foundation** | **The spec is the source:** an OpenAPI 3.1 document written first, in code (`lib/api-spec.ts`). Request validation, the reference docs (`docs/API.md` and a page at `/developers`) and the SDKs are generated from it, and a test fails if a generated file is stale. Nothing is ever written from the implementation afterwards.<br>**Versions:** by header (`Relay-Version: 2026-10-20`), with the deprecation policy written down. Each version is a chain of transforms on the newest, so two are always supported.<br>**Conventions:** errors carry a stable code, a message and the field, and never internals. Pagination is by cursor everywhere.<br>**Personal access tokens:** in Settings › Developers. They're workspace-scoped and revocable, with a last-used time, kept as hashes, and limited to their maker's own capabilities.<br>**Rate limits:** per workspace and per token, in response headers. A 429 carries `Retry-After`, the burst allowance is documented, and usage is shown on the Developers page.<br>**First resources:** conversations (list, retrieve, create, reply, note, assign, snooze, close, tag), contacts, tags, notes, teammates and teams. |
| **D2: Coverage and search** | Tickets and ticket types, articles, collections and help centers, knowledge records, macros, workflows (read and trigger), outbound messages, events, data attributes, segments, and data export (a background job). A search endpoint with a documented grammar: nested and/or, operators by attribute type, sorting and cursors. **SDKs** in JavaScript and Python, generated. |
| **D3: Webhooks** | Subscriptions by topic (the brief's list; company ones wait for phase 01).<br>**Signing:** payloads are signed with HMAC-SHA256 over a timestamp and the body. Secrets rotate with two valid at once, and the verification routine is documented, with code.<br>**Delivery:** from the outbox, by job, at least once. Retries back off exponentially over 24 hours. Sustained failure disables the subscription and sends an email alert.<br>**The delivery log** is inspectable for 30 days, and any delivery can be replayed. |
| **D4: OAuth apps** | An app's registration, with scopes mapped to capabilities. A consent screen lists exactly what's granted. Authorization code with PKCE, rotating refresh tokens, and revocation. |
| **D5: Canvas apps, and the acceptance app** | **Components:** text, image, button, link, input, textarea, dropdown, checkbox, list, data table, divider and spacer. They're declarative, with no app code running in Relay's UI. Relay validates the tree against a schema and draws it with its own components.<br>**Lifecycle:** initialize, submit and configure.<br>**Requests to the app:** signed, with short timeouts and a clear failure card. Error rates per app are shown to both sides.<br>**Placements:** the inbox context sidebar and the composer first, then the messenger home and settings.<br>**The acceptance app:** an order-lookup card in the inbox sidebar, built end to end against Relay's own API (a small app plus a demo order service, run locally) and used as the documentation's example. |
| **D6: The developer workspace and directory** | A sandbox workspace, an app manifest with versions, a review step, and a directory with install and uninstall. Uninstalling revokes tokens and removes placements cleanly. |

## Decisions (proposed)

1. **Spec-first, in code.** The OpenAPI document is a typed TypeScript value: the source, written before each endpoint. Generators in `scripts/` derive the validator, the docs and the SDKs, and a test compares them, as `docs/METRICS.md` is checked. This uses no Java toolchain; the generators are small and Relay's own.
2. **The public API is its own surface:** `/rest/*` on the API Worker locally, `api.<domain>` when deployed.
   - **It never reuses the agent app's endpoints.** It calls the same domain functions (`command`, `authorize`, and so on), so behaviour and permissions are one.
   - **A token acts as the teammate who made it.** The audit shows "via API token" or "via <app>".
3. **Versions are dated, with transforms.** The newest version is implemented; each older one is a request and response transform onto it.
   - **The policy:** a version is supported for at least 12 months after its successor ships.
   - **At launch** there is one real version. The "two supported" rule holds from the next release, and a test version proves the transform chain.
4. **Rate limits use a port.** Deployed, a Durable Object per workspace keeps the counters; locally they're in memory. Per-minute totals are written for the dashboard.
5. **Webhooks are another reader of the outbox,** so no event is missed and replays are exact. Deliveries are jobs, following the 200 ms rule.
6. **Requests to Canvas apps are proxied by Relay's server** (`safeRequest`, signed). They have a short timeout, because a teammate is waiting. This is the one interactive network call, like phase 09's read connectors.

7. **D1 decisions** (20 October 2026):
    - **A token carries its workspace** (`relay_pat_<workspace>_<secret>`), so it's looked up in that workspace's own tenant, with row-level security, never by a search across workspaces.
    - **A request without `Relay-Version` uses the token's version,** fixed when it was made, so an integration never changes under it.
    - **A version change names the version before it;** that version stays supported, and its requests and responses are translated.
    - **Usage is counted per token per minute** and kept seven days, pruned as tokens are used.

## Needs you

- **Scope:**
  - **D1 to D5** (recommended): the API, webhooks, OAuth, Canvas and the acceptance app. D6 (sandbox, review, directory) waits until asked.
  - **D1 to D3:** the cut list's must-haves only; the app framework and the acceptance app wait.
  - **D1 to D6:** everything.
- **Intercom's developer hub:** I can look at the live account's developer settings and app pages (read-only, as before) before D1, to match its shapes.
