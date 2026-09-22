# Agent inbox — step 1 handoff

Updated: 22 September 2026. Scope: authenticated service connection, WebSocket replay, note/attachment privacy and retained D1 fallback. **Local implementation only; no hosted migration or cutover.** Later inbox steps remain unbuilt.

## 1. Reading of the current code

The React 19/TypeScript app uses Vinext/Vite. `app/` contains platform-authenticated pages/routes; `components/relay/` contains both inboxes. Legacy SQL is in `lib/relay-server.ts` and uses D1 polling. New services in `server/` use parameterized PostgreSQL transactions, workspace foreign keys and forced RLS. Migrations live in `db/postgres/`, rollback in `db/rollback/`. Workers in `workers/` require Hyperdrive; local fixtures use PGlite, an embedded PostgreSQL engine.

The app signs exact requests using the authenticated platform principal; the service resolves teammate membership/capabilities. Browser-supplied identity is not forwarded as authority. The platform must strip untrusted identity headers and authenticate requests before forwarding them; the app is not a standalone identity provider. WebSockets replay durable parts from PostgreSQL cursors. Queues, Cron and Durable Object alarms provide hosted background work; the fixture substitutes local runners. Node tests cover SQL, HTTP handlers, isolation and realtime; Playwright contains browser happy/failure paths.

## 2. Plan and scope delivered

- Added the default-off agent inbox path and same-origin authenticated bridge.
- Connected initial list loading and reply/note commands to PostgreSQL; connected updates and cursor replay to WebSockets. List invalidations come from the socket; there is no recurring inbox HTTP polling in the new UI.
- Added additive attachment audience/teammate ownership and enforced customer projection for notes and private attachments. Internal downloads require fresh teammate authorization; no transferable internal-file GET signature is issued.
- Retained the legacy D1 screen/polling and explicitly separated UI rollback from database write authority.

No new people models, saved views/count projections, rich composer, durable drafts, macros, mentions, sidebar apps or bulk actions were added. The list is still bounded to the core's recent 100 conversations. The complete inbox's 10,000-row and 150ms acceptance criteria remain for later steps. The approved decisions and exact people gaps are in [AGENT_INBOX_PLAN.md](AGENT_INBOX_PLAN.md#decisions).

## 3. File-by-file changes

| File(s) | Change |
| --- | --- |
| `db/postgres/0013_agent_inbox_privacy.sql` | Adds attachment audience/owner, default-off workspace flag and a database constraint preventing public internal notes. Existing customer-owned uploads retain customer visibility; unclassified agent uploads default internal. |
| `db/rollback/0013_agent_inbox_privacy.sql` | Disables the workspace flag; preserves privacy columns, constraints and all data. |
| `server/agent-bridge.ts` | Allowlisted signed method/path/query/body/key, bounded request size, same-origin mutations, safe configuration errors and D1 authority checks. |
| `app/api/agent/[...path]/route.ts`, `app/page.tsx`, `cloudflare-env.d.ts` | Platform session → signed service bridge; feature-flag UI selection and typed server configuration. |
| `app/api/inbox/route.ts`, `app/api/visitor/route.ts`, `lib/relay-server.ts` | Preserve legacy reads/polling; reject legacy writes and implicit seeding after PostgreSQL authority. |
| `components/relay/postgres-inbox.tsx`, `agent/inbox.css` | Live inbox, ordered replay/deduplication, reply/note composer, optimistic pending parts, rejection recovery and explicit storage indicator. Private client state clears after authorization loss. |
| `server/api.ts` | Agent feature checks, storage response headers and authorized attachment prepare/complete/content routes. |
| `server/delivery-policy.ts`, `server/conversations.ts` | Central customer-visible part projection; attachment audience, internal unread exclusion and safe client-mutation reconciliation. |
| `server/attachments.ts`, `workers/storage.ts` | Enforce audience/ownership through upload, scan and download; stream internal content from private R2 through the authenticated endpoint. |
| `server/realtime.ts`, `server/realtime-batch.ts` | Inbox invalidations and feature-aware socket authorization/revocation, preserving durable replay. |
| `server/people.ts` | Seed inbox flag off unless a fixture explicitly enables features. |
| `scripts/local-relay.ts`, `agent/entry.tsx`, `scripts/build-agent.mjs` | Two-workspace local seed, HttpOnly fixture agent session, production inbox component in the demo, persistent local database and configurable loopback ports. Removes the old unauthenticated demo-agent command endpoint. |
| `package.json`, `.gitignore` | Agent build integrated with development/E2E; generated bundle ignored. `.dev.vars` and `.dev.vars.*` remain ignored. |
| `tests/agent-inbox.test.ts` | Bridge/isolation/flag rollback, public reply, note edits, private attachment and copied-link denial, including customer realtime replay. |
| `tests/browser/agent-inbox.spec.ts` | Live customer→agent→customer, private note, reconnect/no duplication, no polling, and independent optimistic rejection fixtures. |
| `docs/AGENT_INBOX_PLAN.md`, `docs/LOCAL_READINESS.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md` | Approved decisions, actual scope, verification and release limitations. |

### Routes and stored models touched

New app bridge: `GET /api/agent/{inbox,job,attachment/content}` and `POST /api/agent/{command,realtime-ticket,attachment/prepare,attachment/complete}`. New service attachment paths: `POST /v1/agent/attachment/prepare`, `POST /v1/agent/attachment/complete`, `GET /v1/agent/attachment/content`. Existing `/v1/agent/inbox`, command, ticket/job and `/realtime` are reused. Customer messenger history, replay, upload/download and unread paths are regression-tested. Existing `/`, `/api/inbox` and `/api/visitor` retain their legacy contracts with the write guard.

Direct storage changes: `attachments`, `conversation_parts`, `workspace_features`. Existing access/effects reuse `workspace`, `brands`, `teammates`, roles/capabilities, contacts/identities/mappings, conversations/participants/cycles, read/unread projections, `inbox_counters`, customer counters, jobs/events, outbox, idempotency receipts, messenger sessions and search documents. There is no new inbox-owned table in this step. Existing attachment, actor, session, part, command and realtime types gain the privacy/feature metadata described above.

## 4. Run and verify locally

From the repository root, use the installed dependencies:

```sh
RELAY_LOCAL_API_PORT=8790 RELAY_LOCAL_HOST_PORT=8791 RELAY_LOCAL_DIRECTORY=work/agent-step1 npm run dev:relay
```

The fixture applies migrations through 0013 and seeds workspaces `demo` and `other`, brands, roles and a local teammate. Only these loopback fixtures opt into features. Database and generated fixture keys remain in ignored `work/agent-step1`. Reuse that directory to preserve messages across restarts. Stop any previous instance using those ports before restarting; do not run two processes against the same database directory.

1. **Live customer arrival:** open `http://127.0.0.1:8791/agent` and wait for **Live**. In a second tab open `http://127.0.0.1:8791/`, choose **Open support → Start a conversation**, and send a distinctive message. It must appear in the agent list without refreshing. Select it, send a reply, and verify it appears in the widget.
2. **Private note:** in that agent conversation choose **Internal note**, enter a different distinctive message, and choose **Add internal note**. The amber **Team only** entry appears only for the agent. Reload/reopen the customer widget and verify the note remains absent. Automated privacy tests additionally cover HTTP/replay, superseding note edits and copied internal attachment URLs.
3. **PostgreSQL source:** the agent header says **PostgreSQL · local**. In browser Network inspect `GET /api/agent/inbox`: response headers are `x-relay-storage: postgresql` and `x-relay-transport: local-pglite`; the body includes the storage source. There must be no `/api/inbox` requests from this screen. WebSocket frames carry replay cursors and invalidations. This is embedded PostgreSQL evidence, **not a claim of a live Neon/Hyperdrive connection**. The deployed Worker uses `hyperdriveConnection(env.HYPERDRIVE)`.

The loopback `/agent` login is explicitly a fixture, not production authentication. Agent upload controls are deferred; the new authorized attachment endpoints and privacy tests establish the boundary before those controls are added. The default fixture does not provision R2 or an antivirus service.

### Automated checks

```sh
npm test
npm run typecheck
npm run build
PLAYWRIGHT_CHANNEL=chrome npm run test:e2e -- tests/browser/agent-inbox.spec.ts
```

Evidence from this implementation: all **21 Node tests passed**, including the signed HTTP-handler/realtime happy and privacy failure paths; typecheck, targeted ESLint and the production app build passed. The new browser happy/rejection tests are authored but **not yet passed in this environment**: shell-launched Chrome aborts with a host permission error. The in-app browser verified the agent's **Live / PostgreSQL · local** state and the isolated messenger rendering; its automation could not reach the widget controls inside the closed shadow root. The complete customer→agent→reply/note browser flow therefore remains an explicit acceptance check. No 150ms inbox latency measurement is claimed.

### Deployment configuration and rollback (not executed)

After the separately verified storage migration, configure the app server with `RELAY_AGENT_INBOX_V1=true`, `RELAY_STORAGE_AUTHORITY=postgres`, `RELAY_API_ORIGIN`, `RELAY_WORKSPACE_ID` and secret `RELAY_BRIDGE_SECRET`. The core's secret `BRIDGE_SECRET` must match; the authenticated principal must already map to a teammate in that workspace. Enable `agent_inbox_v1` for that workspace only after verification. Keep the existing conversation/messenger flags enabled as appropriate. Default-off flags and absent configuration fail closed.

Keep local secrets in ignored `.dev.vars`; use the provider's secret mechanism (`wrangler secret put`) for deployed string secrets. Hyperdrive is a resource binding configured by the existing ignored generated binding file, not a string secret. Do not put database credentials or binding identifiers into tracked config/output. Neon London, Hyperdrive, R2 and scanner provisioning remain unverified.

On a configured database, the existing migration tool can apply through 0013 using `node --import tsx scripts/postgres-migrate.ts up --through 0013_agent_inbox_privacy.sql`. This command is an operator instruction, not evidence that a hosted migration ran. The local fixture already applies it automatically. Run the rollback SQL inside a tenant transaction with `relay.workspace_id` set to the intended workspace. Also set the app UI flag false to select the retained D1 screen. **Keep `RELAY_STORAGE_AUTHORITY=postgres`**: fallback D1 history is read-only and may be stale; no reverse copy occurs. Restoring D1 writes requires a separate verified data copy/authority cutover. Keep the D1 source write fence in place.

Internal attachments use private R2 binding reads and authenticated app proxy URLs with `private, no-store`, `nosniff`, restricted content disposition and preview handling. Buckets must have public access/custom public domains disabled. Previously issued legacy signed URLs cannot be revoked by this migration alone: drain their expiry before privacy cutover (existing adapter uses five minutes), or revoke/remove the underlying legacy object access. Existing unknown agent files fail closed. Live bucket configuration and ClamAV have not been certified locally. Future email/channel notification adapters must use the shared customer projection; no unimplemented delivery channel is claimed as tested.

**Stop here.** Further inbox work requires the next explicitly authorized step.
