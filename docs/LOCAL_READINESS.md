# Relay local implementation and release gates

## Agent inbox update — 22 September 2026

Step 1 now connects the authenticated app to PostgreSQL/Hyperdrive services and WebSocket replay behind default-off flags. Migration 0013 enforces note/attachment privacy; the retained D1 polling screen has an explicit write-authority guard. See [AGENT_INBOX_STEP1.md](AGENT_INBOX_STEP1.md) for files, local instructions and rollback. The current Node suite has **21 passing tests**; typecheck, targeted lint, app build and Worker bundle checks pass. New inbox browser tests are authored but have not passed here because the host blocked Chrome startup; in-app inspection verified Live/PostgreSQL-local and widget rendering only. Earlier browser/load figures below predate this inbox increment and are not its acceptance evidence.

## 1. Reading of the current code

The existing app is React 19/TypeScript with Vinext/Vite, Tailwind and Cloudflare D1. `app/` contains pages and HTTP routes; `components/relay/` contains the original inbox and messenger; `lib/relay-server.ts` performs raw D1 queries behind Sites identity. That original path still uses polling.

The new path lives in `server/`, `workers/`, `db/postgres/` and `messenger/`. It uses tenant-scoped PostgreSQL transactions and forced row-level security, capability-based teammate authorization, signed agent bridge requests, and verified customer sessions. Workers connect only through Hyperdrive. One WebSocket protocol carries parts, typing, presence, counters and job snapshots; PostgreSQL and the outbox remain authoritative. Queues perform jobs, Cron repairs delivery, and Durable Object alarms schedule per-conversation wakeups. The local fixture substitutes Node/WebSockets and embedded PostgreSQL. Node tests exercise real SQL and HTTP handlers; Playwright covers browser behaviour.

## 2. Plan and boundaries

The authorized order remains: separate storage migration; minimum people prerequisites; conversation/realtime core; messenger. This checkout contains local implementation for those prerequisites and the new chat path. **No hosted cutover has occurred.** Production flags remain off.

The full people phase is not complete: companies, custom object CRUD, contact/company typed values, event ingestion/retention, subscriptions and segment evaluation are outstanding. The 50,000-contact/5,000-company/2-million-event acceptance workload has not been run. The earlier conversation plan explicitly separated these from its minimum prerequisite slice.

The proposed analytical storage remains Pipelines → R2 Data Catalog/Iceberg with R2 SQL. The prior plan's freshness, exact rolling-window, maintenance-writer and cold-cache feasibility gates are unresolved. Raw events have not been placed in PostgreSQL. No embeddings exist; their later knowledge-store phase owns Vectorize.

## 3. File-by-file changes

### Storage and data

| File | Purpose |
| --- | --- |
| `db/postgres/0001_chat.sql` | Legacy-compatible target tables, receipts, authority metadata, jobs/outbox and tenant policies. |
| `0002_people.sql` | Workspaces/brands, roles/capabilities, teammates/teams, contacts/identities, retained merge audit, keys/sessions and calendars. |
| `0003_conversations.sql` | Append-only typed parts, cycles, participants, read models, search documents and attachment metadata. |
| `0004_customer_reads.sql` | Materialized customer unread counters/read positions. |
| `0005_jobs.sql` | Leases, attempts, ownership and durable scan-job references. |
| `0006_search.sql` | Conversation tags and filtering indexes. |
| `0007_metrics.sql` | Versioned business-calendar references, business response metrics and immutable job events. |
| `0008_session_metadata.sql` | Originating session timezone and active-session lookup index. |
| `0009_conversation_attributes.sql` | Separately stored typed conversation values and archive-only definitions. |
| `0010_delivery_indexes.sql` | Reverse alias, identity mapping and participant indexes. |
| `0011_customer_unread_threads.sql` | Canonical thread totals for verified contacts and separate anonymous-device totals, with tenant foreign keys and RLS. |
| `0012_inbox_projection_index.sql` | Workspace/conversation index for message-time teammate unread lookup; avoids scanning unrelated conversations. Rollback retains the compatible index. |
| `db/d1-cutover/0001_write_fence.sql` | Database triggers that fence writes from old D1 deployments. |
| `db/d1-cutover/ROLLBACK.sql`, `db/rollback/*` | Data-preserving authority/exposure rollback; no drop or rename. |
| `server/db.ts`, `postgres.ts`, `migration.ts` | Scoped transactions, idempotency, Hyperdrive connection and exact D1 copy/round-trip verification. |
| `scripts/postgres-migrate.ts` | Checksummed migration ledger and private snapshot import/export commands. Defaults to migration 0001 only. |
| `scripts/local-db.ts`, `local-relay.ts` | Real PostgreSQL SQL in a local fixture, non-owner RLS role, demo seeding and persisted development data. |

### Application and transport

| File | Purpose |
| --- | --- |
| `server/identity.ts` | Fixed-algorithm JWT/HMAC checks, two key slots, encrypted key wrapping. |
| `server/policy.ts`, `people.ts` | Named capabilities, tenant/resource policy, seed roles, identities and non-destructive merge/reversal. |
| `server/conversations.ts` | Commands, typed immutable parts, lifecycle cycles, aliases, superseding edits, tags/topics/attributes and ordered replay. |
| `server/unread.ts`, `business-time.ts`, `availability.ts` | Server-side read projections and time calculations. |
| `server/search.ts` | Workspace-scoped full-text filters and resumable reindex batches. |
| `server/jobs.ts`, `outbox.ts`, `publication.ts` | Durable leases/retries/status, at-least-once publication and bounded fanout batching. |
| `server/api.ts` | Customer and signed-agent routes, tenant authorization, private-response filtering and processing instrumentation. |
| `server/realtime.ts`, `realtime-batch.ts` | Cursor replay, deduplication contract, ephemeral signals and batched authorization/counter snapshots. |
| `server/unread.ts` | Merge/reversal-aware customer read projections, cached totals and a checkpointed backfill job. |
| `server/attachments.ts`, `workers/storage.ts` | Direct signed R2 upload, quarantine, type/size/scan checks, exact-byte promotion and private downloads. |
| `workers/relay.ts` | Native Worker, WebSocket hub, per-conversation alarm, Queue/DLQ and Cron handlers. |
| `workers/preview.ts`, `scanner/*` | Private PNG preview and fail-closed ClamAV service adapters. Not provisioned or live-tested. |
| `server/assets.ts` | Per-brand frame-ancestor policy and validated theme CSS. |
| `server/ports.ts` | Contracts only for Help center, phase-5 tickets, routing and the full event store. |

### Browser, tests and documents

| File | Purpose |
| --- | --- |
| `public/messenger/loader.js`, `launcher.css` | Small asynchronous shadow-root launcher and secure parent/frame bridge. |
| `public/messenger/frame.html`, `messenger/frame.tsx`, `frame.css`, `strings.ts` | Lazy React iframe, Home/Messages/Help state, replies, uploads, accessibility and locale fallback. |
| `scripts/build-messenger.mjs` | Reproducible frame bundle and loader gzip budget check. Generated frame JS/CSS are ignored. |
| `scripts/local-db.ts`, `local-relay.ts` | Persistent local PostgreSQL data and keys, migration checksums, isolated runtime role, job/outbox recovery and loopback fixtures. |
| `package.json`, `package-lock.json`, `eslint.config.mjs` | Runtime/test dependencies and scripts, explicit esbuild/formatter versions, ignored generated artifacts; production lint rules remain enabled. |
| `scripts/worker-config.mjs` | Generates ignored private binding metadata with flags off; does not provision or deploy. |
| `tests/*.test.ts` | SQL, HTTP, tenant isolation, JWT failures, merge, search, jobs, attachment quarantine, business time and rollback checks. |
| `tests/browser/messenger.spec.ts`, `playwright.config.ts` | Hostile CSS/CSP, lazy loading, live replies, RTL, disconnect recovery and host-load measurements. |
| `scripts/load-realtime.ts` | Repeatable 200-agent/5,000-conversation/50-message-per-second local baseline. |
| `docs/MESSENGER.md`, `MOBILE_SDK.md` | Integration contract and native SDK specification. |

### New route surface

Customer routes under `/v1/messenger`: `POST boot`, `GET history`, `GET conversations`, `GET unread`, `POST command`, `POST read`, `POST context`, `POST logout`, `POST realtime-ticket`, `GET job`, `POST attachment/prepare`, `POST attachment/complete`, `GET attachment`. Sessions determine the workspace; body/query parameters cannot switch it.

Agent routes under `/v1/agent`: `GET inbox`, `POST command`, `POST realtime-ticket`, `GET search`, `POST search/reindex`, `POST unread/rebuild`, `GET job`. The signed bridge binds workspace, principal, method, path, query or body digest and mutation key. Named capabilities authorize operations; role names do not decide permissions. Unknown agent paths return 404.

`/realtime` upgrades the shared WebSocket protocol. `/messenger/frame.html` and `/messenger/theme.css` supply public brand presentation with an exact origin allowlist. Bootstrap/brand presentation are intentionally public and never include another tenant's private history. Loopback `/demo/*` routes are test fixtures only.

## 4. Run and verify locally

```sh
npm ci
npm run typecheck
npm test
PLAYWRIGHT_CHANNEL=chrome npm run test:e2e
npm run dev:relay
```

Open the demo at `http://127.0.0.1:8789/`. For load measurements:

```sh
PLAYWRIGHT_CHANNEL=chrome node --import tsx scripts/load-realtime.ts
```

Use Playwright's bundled Chromium instead by omitting the channel variable after installing it. The checks require loopback listeners. Results live in ignored `work/benchmarks/`; screenshots in `work/screenshots/`.

### Verification results

Local results, 21 September 2026:

| Check | Result |
| --- | --- |
| TypeScript | Pass. |
| SQL/HTTP/regression suite | 19 tests pass, including every new route's tenant boundary, privileged-role rejection, identity/canonical unread counts, repeated live merges, publication acknowledgements and persisted job-status push. |
| Browser checks | Restart/replay, hostile CSS/CSP, forged identity/RTL and host-load checks pass across the full run and targeted reruns. The full run exposed a host-load failure; after fixing bootstrap scheduling, the host-load, hostile-CSS and identity checks were rerun. Includes a real 60-second socket outage with server restart, hidden-thread unread preservation and keyboard focus restoration. |
| Original application build | Pass. The original D1 routes remain the application default. |
| Native Worker bundle | Pass; bundle/import validation only, not a deployed Worker test. |
| Lint of new implementation | Pass. Repository-wide lint still reports eight errors in the unchanged legacy `components/relay/{inbox,messenger,shared}.tsx` files. |
| Host-page load impact | 20 fresh browser-context baseline/widget pairs: p50 +9.3ms, p95 +29.3ms, maximum layout shift 0. This is loopback evidence, not a remote-host guarantee. |
| Loader gzip | 4,282 bytes; below 15,000 bytes. |
| Sustained local load | 200 authenticated agent sockets, 5,000 open conversations, 50 writes/second for 60 seconds. 3,000 committed and rendered; zero errors, duplicates or socket errors. |
| Write timestamp → DOM render | p50 **68ms**, p95 **531ms**, p99 **1,082ms**. |
| Server handler processing | p50 **6.5ms**, p95 **149.2ms**, p99 **269.2ms**. Below 200ms p95 in this local run; cold managed-database acceptance remains open. |
| HTTP round trip | p50 9.6ms, p95 197.7ms, p99 322.3ms. |
| Local database connection wait | p50 0.001ms, p95 106.5ms, p99 233.5ms. |
| Time holding the local database connection | p50 6.1ms, p95 16.9ms, p99 21.4ms per request. |

The latency origin is the server's part timestamp inside the write transaction, ending on a browser animation frame after DOM insertion. It is not a transaction-commit timestamp. This single-machine test needs no cross-machine clock correction; it does not certify remote clocks. It uses 200 minimal DOM panes, one selected conversation per agent, embedded PostgreSQL, and a fresh fixture with initial socket replay complete. It is **not a demonstrated cold managed-database cache**, a 10-minute distributed soak, or 200 full agent inboxes.

### Performance diagnosis and smaller change

An isolated profile before the latest fixes measured processing p95 **719.8ms**: database connection wait was **681.5ms**, while transaction time was **19.2ms**. The local adapter serializes access to one PGlite connection. The profile identified repeated replay of already delivered outbox entries, redundant authorization transactions, and a missing index on the unread lookup. Adding background projection jobs first would have added more work to that same queue.

The implemented fix acknowledges only the captured outbox rows after successful immediate fanout, validates agent replay within its timeline transaction, validates customer commands and writes within one transaction, and adds migration 0012. Revoked sessions, disabled flags, wrong origins and workspace isolation remain enforced. Failed dispatch leaves outbox rows pending; rows committed during dispatch are not acknowledged accidentally. Counter-only notifications remain supported.

The isolated rerun above includes recovery, uses the same workload, and reduces transaction count from **27,077 to 8,721** and timeline-page reads from **5,741 to 3,200**. Inbox projections remain synchronous and exact. Earlier failed runs are retained in `work/benchmarks/`; `realtime-load-profile-before-index.json` records the immediate baseline, and `realtime-load.json` includes the final timing and query plan. A single local result is not a cold-cache or production certification.

The final `EXPLAIN (ANALYZE, BUFFERS)` for the message-time unread lookup is:

```text
Result: tenant policy checks relay.workspace_id = 'demo'
  Index Scan using conversation_unread_by_conversation
    Index Cond: workspace_id = 'demo'
                AND conversation_id = 'load-conversation-00001'
    Actual rows: 201; shared buffer hits: 7; reads: 0
Planning time: 0.466ms; execution time: 0.437ms
```

This is a warm indexed unread lookup after load, **not** the requested cold segment query over two million analytical events. That separate acceptance workload remains unimplemented.

The browser suite initially measured host-load impact at 63.7ms p95 (failure). The loader awaited a resolved `load` listener and resumed cold bootstrap work in a microtask before the event finished. It now yields to a separate task before accessing device storage, resolving the timezone and requesting bootstrap. The isolated 20-pair rerun measured 29.3ms p95; the maximum load-handler duration was 0.2ms, and every bootstrap fetch started after `loadEventEnd`. The 50ms threshold was not relaxed. Both `host-load-before-bootstrap-yield.json` and `host-load.json` are retained. Cross-machine/browser/network variation still requires deployment-specific validation.

### Migration and rollback gate

`.dev.vars` and `.dev.vars.*` are ignored. No deployment secret values or Hyperdrive IDs have been committed or printed. Test-only signing fixtures are explicit test data. Wrangler was signed out and Neon credentials were absent; the user explicitly deferred access. Previously requested Cloudflare inventory commands failed authentication, which is not evidence that those resources do not exist.

The migration runner reads `DATABASE_URL` only as an operator connection. Runtime Workers require `HYPERDRIVE`; they have no direct-URL fallback. Hyperdrive is a typed resource binding, not a string secret. The private config generator writes its binding ID only into ignored `.wrangler/relay-private.json`. Put deployed signing/scanner credentials through `wrangler secret put`; do not place them in the generated config.

Runtime connections reject superuser/BYPASSRLS roles and table owners. Local fixtures use a separate non-owner role and run the same forced-RLS policies. The migration script is not that runtime connection: it is a privileged operator tool and defaults to applying only `0001_chat.sql`.

For a workspace already using migrations 0002–0010, keep its messenger flag off, apply 0011 additively, submit the idempotent signed-agent `POST /v1/agent/unread/rebuild`, and subscribe to its persisted job ID over WebSocket. Confirm success and compare canonical unread membership before enabling the new reader. The backfill advances in batches of 25 canonical conversations and can resume/replay. New live writes maintain their affected projections. `db/rollback/0011_customer_unread.sql` disables messenger exposure and revokes sessions while retaining both generations of counters and all read positions.

Migration 0012 adds only an index and requires no data rewrite or new seed shape. The local load fixture seeds 200 teammates and 5,000 conversations, then creates unread rows through real message commands. Its rollback retains the compatible index and rolls back application code; no data or columns are dropped. The migration runner applies this index transactionally, so an existing large deployment requires a maintenance window or a separately planned concurrent-index rollout before applying it under live write traffic.

After access is configured, follow `POSTGRES_MIGRATION_PLAN.md`: create separate migration/runtime roles, verify London placement and disable Hyperdrive query caching; apply the source fence without freezing it; perform a shadow copy; freeze/drain D1 writes; verify complete canonical records; switch a read-only canary; open PostgreSQL writes only after verification. The two databases may coexist, but there must be one write authority. The importer rejects mismatches and leaves authority frozen. It is an atomic snapshot copier, not yet a resumable hosted migration job.

Rollback before PostgreSQL accepts writes reopens the intact D1 source after verification. Rollback after PostgreSQL accepts writes requires a verified reverse copy; never simply flip the writer flag back. New typed parts/identities cannot all be represented in the legacy three-table model. After enabling those features, retain PostgreSQL and roll back application exposure while preserving new data. The supplied SQL disables features/revokes sessions or freezes authority; it does not delete history.

## Remaining release blockers

- Hosted D1 export/cutover, compatibility for existing visitor tokens, production verification of the new Sites inbox bridge, and a resumable production migration job are not complete. The new native path must not receive production traffic yet.
- No Neon/Hyperdrive, Cloudflare Queue/DLQ, Durable Object eviction/restart or R2/ClamAV/Images hosted acceptance has run. Local doubles do not prove those integrations.
- The load harness uses embedded PostgreSQL and minimal DOM clients. A successful local delivery run is not a production capacity guarantee. Cold managed-database caches and cross-region p95 processing still need verification.
- Full people/events/segment scope remains separate and incomplete, including the requested 2-million-event benchmark and retention-with-holds writer.
- Help-center content, ticket history/conversion and routing queue positions remain provider interfaces. No mobile SDK is implemented.
- Brand/key/role administration currently uses operator/database configuration. The new signed-agent/WebSocket inbox is implemented locally behind flags; hosted authentication and cutover remain unverified.
- The local message workload is below 200ms p95 after the index/transaction/publication fixes, but the required cold managed-database result is not established. Large identity-history merges and large inbox/search workloads still need bounded-job/performance validation before release.
- A retained identity can now reverse without rewriting events/parts, but full people-phase relationship/attribute handling, later-edit conflict UX and the eventual loser-purge policy are still outstanding.

These are explicit gates, not completed acceptance criteria. Default-off flags keep the original app available while this work is reviewed and hosted access is added.
