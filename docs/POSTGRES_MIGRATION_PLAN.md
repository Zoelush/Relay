# Relay: PostgreSQL storage migration plan

> Historical plan. The user later authorized local implementation. See [LOCAL_READINESS.md](LOCAL_READINESS.md) for current code, tests and incomplete release gates; no hosted cutover has occurred.

Status: proposal only. Inspected 16 September 2026. No migration, deployment, resource creation, dependency installation, or Phase 1 feature implementation is authorized by this document.

The only configuration edit made for this planning session was adding `.dev.vars` and `.dev.vars.*` to `.gitignore`, as requested. Both were verified with `git check-ignore`.

## Reading of the current code

Relay uses TypeScript, React 19, Vinext/Vite and Cloudflare Workers, with Tailwind and shadcn components. `app/` contains pages, platform sign-in helpers and two API handlers; `components/relay/` contains the inbox, messenger and shared client helpers; `lib/relay-server.ts` owns server helpers and sample seeding; `db/` and `drizzle/` describe three SQLite/D1 tables. Runtime access is raw D1 SQL, despite the Drizzle schema. Authentication trusts the Sites platform's forwarded identity and checks one workspace owner. Visitors use a hashed bearer token associated with a conversation. There is no teammate or role model. Chat delivery uses HTTP requests and two-second polling. There is no background job runner. There is no committed automated test suite or test script; an ignored HTTP smoke script exists. This checkout has no Git remote; the previously inspected GitHub Relay repository was empty. This plan describes the actual local application, not an assumed remote implementation.

### Actual Cloudflare inventory results

| Requested command | Result |
| --- | --- |
| `npx wrangler whoami` | Exit 0, but reports: `You are not authenticated. Please run wrangler login.` |
| `npx wrangler d1 list` | Exit 1: non-interactive Wrangler requires `CLOUDFLARE_API_TOKEN`. |
| `npx wrangler r2 bucket list` | Same authentication error, exit 1. |
| `npx wrangler kv namespace list` | Same authentication error, exit 1. |
| `npx wrangler queues list` | Same authentication error, exit 1. |
| `npx wrangler vectorize list` | Same authentication error, exit 1. |

The initial invocations also encountered a local log-directory `EPERM`. Repeating them with project-local logging removed that error and confirmed the authentication failures above. No login or infrastructure mutation was attempted. These results establish that inventory is unavailable, not that the account has no resources.

There is no authored root `wrangler.toml` or `wrangler.jsonc`. `vite.config.ts` derives local configuration from `.openai/hosting.json`; `dist/server/wrangler.json` is generated. It declares one local D1 binding with a placeholder database ID, and zero R2, KV, Queues, Hyperdrive, Vectorize, Durable Object or Cron bindings. This is not a verified inventory of deployed resources. In particular, a Sites-managed D1 database might not be visible in the user's own Cloudflare account.

## 1. Target PostgreSQL schema and changes from D1

### Separate the migration release from Phase 1

**Migration release:** port the current chat behavior to Neon in AWS London (`eu-west-2`) through Hyperdrive. Preserve public conversation/message IDs, visitor token hashes, existing HTTP contracts, note visibility and platform sign-in. Add tenant enforcement and the operational machinery needed for a safe, retryable migration. Do not introduce contacts, brands, roles, segments or other people features in this release.

**Phase 1, after a separate approval:** add the people schema below. Its presence in this design is not permission to create these tables during the storage migration.

Neon supports the requested London region. The connection path is an ordinary PostgreSQL driver in a native Cloudflare Worker, through Hyperdrive to Neon, not the Neon HTTP driver. [Neon London announcement](https://neon.com/docs/changelog/2025-02-14), [Cloudflare's Neon integration](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/).

### Migration-release schema

| Table | Existing data and proposed change |
| --- | --- |
| `workspace` | Keep existing `id`, `owner_id`, `brand`, `greeting`, `color`, `availability`. Add `workspace_id` constrained equal to `id`, and explicit migration/version metadata. Preserve the singleton's existing ID. |
| `conversations` | Preserve IDs, token hashes, name/email snapshots, title, status, assignment, flags and tag text. Add required `workspace_id`. Convert persisted millisecond timestamps to `timestamptz` without losing precision; preserve original values in the copy manifest. |
| `messages` | Preserve IDs, conversation, kind, body, sender and timestamp. Add required `workspace_id` and a composite foreign key to the conversation in that workspace. Keep this table name; no premature rename to parts. |
| `storage_migration_state` | Workspace-scoped authority, migration epoch, source/target state and write-fence information. A minimal counterpart in D1 protects source writes. |
| `idempotency_receipts` | Workspace, authenticated principal/session scope, operation, client key, request digest, result and expiry. A differing payload under the same key returns 409. Store the receipt and business mutation in one transaction. |
| `migration_runs`, `migration_chunks` | Workspace-scoped source manifest, resumable cursors, checksums, progress and verification results. |
| `jobs`, `job_events`, `outbox` | Persisted migration/job status, ordered status events for reconnect, and transactional publication intent. Job IDs are returned immediately; status is pushed rather than polled. |

Every application table above carries `workspace_id`. Infrastructure-owned migration bookkeeping is not a business table and contains no tenant data. Runtime queries include explicit workspace predicates; PostgreSQL row-level security adds defense in depth. Set tenant context transaction-locally on a non-owner role without `BYPASSRLS`, and force RLS where appropriate. Composite foreign keys and uniqueness constraints include workspace scope. [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

Keep existing text IDs unchanged: sample IDs and `chat-...` IDs are not UUIDs. New entity IDs can be server-generated UUIDs represented consistently as opaque IDs; changing legacy primary keys is unnecessary for this migration. Index chat reads on `(workspace_id, updated_at, id)` and `(workspace_id, conversation_id, created_at, id)`.

Use checked values for statuses/kinds and Boolean flags internally; adapt responses to the current client contract. Server-generated instants are UTC. Legacy records have no recorded originating timezone: mark that provenance as unknown rather than inventing London from the database region. A workspace's operational timezone/default locale must be explicitly chosen when Phase 1 workspace settings are introduced.

Disable Hyperdrive query caching for transactional/auth reads; its cached results are unsuitable for immediate authorization and read-after-write guarantees. Use short transactions and transaction-local tenant settings, not connection-global state. [Hyperdrive caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

### Future Phase 1 schema — design only

All tables in this list are workspace-scoped, including join tables, histories and derived data. Unique external identifiers are unique within a workspace and their relevant provider/object type, never globally.

| Area | Proposed tables and essential fields |
| --- | --- |
| Tenant and brands | Extend `workspace` with IANA timezone, default locale, settings JSON and event retention policy, default 365 days. `brands`: name, logo attachment reference, colours, sending address and settings. Many brands belong to one workspace; conversations gain a brand reference. Help-center implementation belongs to a later phase. |
| Teammates and teams | `teammates`: external authenticated principal, role, full/limited seat, active/away/away-and-reassigning presence, schedule. `teams`, `teammate_teams`, `availability_schedules`: versioned local-time intervals, timezone and calendar exceptions so later business-hours calculations are reproducible. |
| Authorization | `roles`, `role_permissions`. A versioned named-capability registry in code plus a resource-aware policy function; no role-name checks in handlers. Seed owner, admin and agent roles. Include all 13 requested capabilities, with separate reply/note deletion and report access/creation capabilities. Custom roles select from this registry. |
| Contacts and identity | `contacts`: visitor/lead/user role, external ID, profile, first/last seen, signup time, browser/device, locale/location, global unsubscribe, merge redirect and row version. `contact_emails`, `contact_phones`: multiple values, verification and primary flags. `identities`: anonymous device/session or verified external identity. `identity_contact_mappings`: identity-to-contact assignment. |
| Merge history | `contact_merges`, `contact_merge_changes`, `contact_redirects`: survivor/loser, actor, idempotency key, versions, full before/after values and relationship changes, and retained recovery snapshot. No raw events are rewritten. |
| Companies | `companies`: external ID, name, plan, server-validated seat count, decimal monthly spend plus currency. `contact_companies`: contact/company membership and relationship role. Never use floating-point money. |
| Typed attributes | `attribute_definitions`, `attribute_options`, `contact_attribute_values`, `company_attribute_values`, `conversation_attribute_values`. Definition has owner kind, key, type, validation and archived timestamp. Values have typed columns with checks, owner/definition foreign keys and indexes beginning `(workspace_id, definition_id, typed_value, owner_id)`. Multi-option selections use `attribute_option_values` with exactly one valid owner reference. No hard deletion of definitions. |
| Custom objects | `custom_object_types`, `custom_object_instances`, `custom_object_attribute_values`, `custom_object_links`. Reuse typed definitions keyed to the object type. Instance external IDs are unique per workspace/type. Links have checked, same-workspace contact/company/conversation references. CRUD must define deletion/reference behavior before implementation. |
| Tags | `tags`, `contact_tags`, `company_tags`, `conversation_tags`. Same-workspace composite references and uniqueness on each assignment. The legacy single tag remains during additive backfill. |
| Segments | `segments`: target kind and validated, versioned nested filter expression. `segment_memberships`, `event_count_rollups`, `projection_checkpoints`: derived serving data and its freshness, not raw event payloads. Member cache keys include segment revision and relevant data versions; timed predicates require expiry/re-evaluation at their next boundary. |
| Communication preferences | `subscription_types`, `contact_subscriptions`: category-specific consent/unsubscribe history and effective state. Global unsubscribe takes precedence. Later outbound work must declare a category. |
| Event governance | `event_holds`: event identity and billing/audit reference, not a copy of the raw event. Workspace retention policy remains relational configuration; raw events remain in the analytical store. |

The capability seeds are: reply to conversations, add notes, delete replies, delete notes, manage macros, reassign conversations, access reports, create/share reports, export data, manage teammates, manage billing, manage workspace settings, and view contact personal data. Registry names do not implement the later report, billing or macro features.

In Phase 1, add `identity_id` to conversations and backfill before switching reads. Retain legacy token and name/email fields throughout the compatibility deploy. A visitor-to-user merge changes the visitor identity mapping and the loser redirect; conversations and event records keep their original identity IDs. For the specified one-anonymous-identity visitor case, that is one mapping update. A contact with multiple identities must not be silently treated as this case: additional aliases must resolve through the redirect or be explicitly covered in the audited operation.

Proposed attribute precedence: the verified survivor's existing value wins, including valid `false`, `0`, empty strings and empty lists; only genuinely absent values are filled from the visitor. Do not concatenate conflicting lists implicitly. Union deduplicated relationships where safe; unsubscribe wins over subscribe unless an explicit later consent action changes it. Record each changed relationship/value and its version. Reversal uses a transaction with conflict checks against all affected rows, not only the survivor's top-level version; return the conflicting fields/relationships instead of overwriting later edits.

Unlimited reversal and physical deletion require retained recovery data. Proposed interpretation: retain the loser for at least 30 days; after an optional physical purge, retain a tombstone and complete recovery snapshot, allowing reconstruction under the same IDs. Deleting that recovery data would end reversibility and must not be described as unlimited reversal. This interpretation needs acceptance before implementing purge behavior.

## 2. Data that stays out of the primary database

There are currently **no event, attachment or embedding tables/rows in the application schema**. This migration has no existing payloads of those types to move. The following are Phase 1/later storage contracts, not justification to scaffold upload or AI features in the migration release.

| Data | Proposed destination | Relational metadata only |
| --- | --- | --- |
| Raw events | Cloudflare Pipelines into R2 Data Catalog, Apache Iceberg/Parquet; R2 SQL for analytical reads. | Retention policy, holds, ingestion receipts/checkpoints and derived counts. |
| Attachment bytes | Private Cloudflare R2; quarantine before scanning and authorized release. | Object key, workspace, owner, size, content type, checksum, scan status and lifecycle state. Attachment feature phase owns the upload/scanning implementation. |
| Embedding vectors | Cloudflare Vectorize, tenant-scoped namespace/filter with model/version metadata. | Source reference, vector ID, model/version and indexing status. AI knowledge phase owns creation/querying. |

Raw events contain `workspace_id`, stable `event_id`, `identity_id`, name, occurred-at UTC, originating timezone/provenance, ingestion time and metadata. Client idempotency keys map to stable IDs. Queue retries and ambiguous sink acknowledgements require replay deduplication; a sink's delivery guarantee is not proof that duplicate client submissions cannot happen. Never store raw event payloads in the application outbox merely to make ingestion easier; stage durably outside the transactional primary and keep pointers/checkpoints there.

### Material limitations to resolve before Phase 1

- **Freshness:** the Iceberg sink has a minimum 60-second roll interval. It cannot alone power immediate per-message targeting. Use a derived serving projection with an explicit committed watermark and recent-event coverage; define the acceptable freshness before implementing targeting. [Pipelines Iceberg sink](https://developers.cloudflare.com/pipelines/sinks/available-sinks/r2-data-catalog/).
- **Exact time windows:** daily count rollups alone are incorrect for an arbitrary rolling 30-day boundary. Combine complete buckets with exact boundary-interval counts from an event occurrence index/analytical query, deduplicate overlap and cover newly accepted events. Raw metadata remains outside PostgreSQL. Benchmark the complete multi-store path, including boundary work; do not time only the final PostgreSQL join.
- **Retention:** R2 SQL is read-only. Per-workspace expiry with billing/audit holds requires a proven Iceberg-compatible maintenance writer, coordinated with hold creation, followed by snapshot/file expiry. Blind R2 lifecycle deletion of live table files corrupts the table; catalog snapshot expiry alone does not delete live expired rows. Validate the maintenance writer and held-event restore before enabling retention. This is a storage feasibility gate, not an already working capability. [R2 SQL limitations](https://developers.cloudflare.com/r2-sql/reference/limitations-best-practices/), [catalog maintenance](https://developers.cloudflare.com/r2-data-catalog/table-maintenance/).
- **Operational tradeoff:** Pipelines and R2 SQL are beta services. The analytical choice is a proposal contingent on retention and latency tests. If either fails, bring back a revised analytical-store decision; do not quietly put events back into the primary database.
- **Consistency:** R2/Vectorize and PostgreSQL do not share a transaction. Persist reference/status changes and retry work idempotently; expose pending/failed state and repair orphaned objects/index entries.

The Phase 1 acceptance workload remains 50,000 contacts, 5,000 companies, 20 custom attributes and 2 million raw events. Require exact result validation and **p95 <=500ms**, including attribute, tag, event-count and identity-resolution work. Show query plans beside timings, dataset hashes, parameters, sample count, full-path timing, and projection watermarks. Use at least 100 independent cold trials. Clear application caches and disable Hyperdrive caching; independently recreate/restart test database compute and verify cache conditions where supported. `DISCARD ALL`, a new connection or a fresh query parameter is not proof of a cold database cache. Managed R2 SQL/internal caches cannot currently be assumed flushable: report this limitation, and do not label such a run a proven fully cold-cache pass. No benchmark has been run during this planning session.

### Cost basis, not a fabricated monthly total

Prices checked against current public documentation; account-specific plans, volume and taxes are not known.

| Service | Pricing basis and example |
| --- | --- |
| Neon | Published Launch rates: $0.106/CU-hour and $0.35/GB-month; history storage and transfer can add charges. Illustrative always-on 0.25 CU for 730 hours plus 10 GB is about **$22.85/month**, before those additions. Disable autosuspend for latency-sensitive production; benchmark cold starts separately. [Neon pricing](https://neon.com/pricing). |
| Hyperdrive | Pooling and caching have no separate charge on Workers Paid; Worker execution remains billable. [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/). |
| Pipelines | Monthly included volumes, then $0.04/GB transformed and $0.06/GB delivered to Iceberg. R2/catalog charges are additional. [Pipelines pricing](https://developers.cloudflare.com/pipelines/platform/pricing/). |
| R2 | Standard storage $0.015/GB-month, plus operations, with a free allowance; 100 GB totals roughly $1.35/month for storage after the 10 GB allowance, excluding operations. [R2 pricing](https://developers.cloudflare.com/r2/pricing/). |
| Catalog and queries | Catalog operations, compaction and scanned bytes are separate meters. R2 SQL lists $0.0025/GB scanned after its allowance. [Catalog pricing](https://developers.cloudflare.com/r2-data-catalog/platform/pricing/), [R2 SQL pricing](https://developers.cloudflare.com/r2-sql/platform/pricing/). |
| Vectorize | After allowances: $0.01/million queried dimensions and $0.05/100 million stored dimensions. Embedding inference is separate. [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/). |

Queues, Durable Objects, the storage Worker, scanning and retention-maintenance compute also incur usage costs. Event count alone does not determine the bill: average event bytes, compressed retention size, scan frequency, vector dimensions and request volume are needed. Temporary D1/Neon overlap and migration snapshots add cost during cutover.

## 3. Cutover sequence and verification

### Hosting and secrets corrections

The current Sites build cannot use raw TCP sockets. The Sites building skill states: “Hosted Sites do not support raw TCP sockets (`connect()`); use HTTP-based clients or APIs for external databases and services.” Therefore the smaller migration is:

`existing browser UI -> existing same-origin Sites API/auth -> signed HTTPS -> native Cloudflare storage Worker -> Hyperdrive -> Neon London`

The larger alternative is moving the entire app and replacing the platform auth boundary. It is unnecessary for this storage migration and is not included.

The storage Worker must verify a service-authenticated request envelope binding principal, workspace, action, method/path, body digest, timestamp and replay protection. It must independently enforce owner/session authorization against stored data. It must not trust public `oai-authenticated-user-*` or caller-supplied workspace headers. No database credentials or service keys reach the browser. Verify that the Sites host can supply a server-side service credential before adopting this bridge; never replace that with a secret in the client bundle.

`.dev.vars` holds local secret strings and private resource configuration inputs and is ignored. Deployed string secrets use secret-management commands with stdin, not logged command arguments. **Hyperdrive itself is a typed resource binding, not a string secret; `wrangler secret put` cannot create that binding.** Use Cloudflare deployment metadata/API or an ignored, generated private config to attach it; do not commit or print credentials/resource identifiers. The Worker reads the Hyperdrive binding, never `DATABASE_URL` as its runtime connection fallback. Store the origin credentials in Hyperdrive's protected configuration.

Ordinary local Hyperdrive emulation connects directly to the configured database. To respect the requested real Hyperdrive path, use a dedicated remote development storage Worker and isolated Neon development branch for integration tests, while keeping the UI local. Any local PostgreSQL unit/integration harness must be explicitly labeled driver/schema testing, not a Hyperdrive acceptance test. [Hyperdrive development modes](https://developers.cloudflare.com/hyperdrive/configuration/local-development/).

### Ordered rollout

1. **Read-only preflight:** after Cloudflare authentication is available, discover resources again, identify the actual authoritative D1 source and verify export access. Resolve Sites-owned versus user-owned resource boundaries. Verify Neon account/region availability and bridge secret support. No resource names are needed from the user.
2. **Prepare reversible infrastructure:** separate runtime/migration PostgreSQL roles, development branch, Hyperdrive with query caching disabled, private R2 migration snapshots, work queue/DLQ and job status push. The migration flag defaults off. No Phase 1 tables are created.
3. **Deploy a compatibility release on D1:** introduce workspace-scoped repositories and explicit owner/session context; add tenant columns/control records additively, without rewriting the initial migration. Add database-enforced write fences. Fix retry semantics for the complete mutation, including metadata updates, using client keys and request digests. Persist the visitor start key/token before sending so an acknowledgement loss plus reload can recover the same conversation. Remove implicit unguarded GET seeding; explicit initialization is fenced and idempotent.
4. **Build and rehearse PostgreSQL in isolation:** create the compatibility schema, fixtures for two workspaces, resumable export/import and verification tools. Convert SQL placeholders, conflict handling, transaction/batch behavior and result types. Preserve legacy API formats. Demonstrate rollback on synthetic data before touching authoritative data.
5. **Run D1 and PostgreSQL in parallel:** D1 is the only writable source of truth; PostgreSQL is a shadow copy. Initial copy is resumable and idempotent. Compare shadow reads after normalizing timestamps/flags. Do not independently dual-write user mutations across databases.
6. **Freeze and finish the copy:** fence every D1 business write, including initialization and settings; drain in-flight requests. Export a stable final snapshot or reconcile against that snapshot in bounded chunks. Retain checksummed manifests and source backups in private R2. Failed/retried chunks resume from persisted checkpoints. A concurrent old deployment cannot bypass the database fence.
7. **Verify before opening PostgreSQL writes:** compare table and per-workspace row counts, sorted primary-key sets, canonical per-row digests, foreign-key/orphan checks, timestamp conversion, kinds/status distributions, note visibility, token hashes and owner mapping. Compare complete relevant fields, not just counts or `MAX(id)`. Include receipts needed to prevent a retry crossing cutover from mutating twice. Store the verified manifest/epoch in the migration record.
8. **Switch through a read-only gate:** route the migration-aware compatibility release to PostgreSQL while writes remain frozen; run the happy chat flow on an isolated test workspace and read-only checks against imported data. Activate production PostgreSQL writes only if every gate passes. Old D1 handlers remain fenced. Route/fence state is durable and checked; a stale process or default-off environment flag cannot silently select the old writable store.
9. **Observe, then end the compatibility window:** monitor p95 processing time, error rate, job backlog, verification drift and tenant isolation. Keep the D1 snapshot, old code and backward-compatible data representation throughout the rollback window. Start Phase 1 only after the storage release is accepted; cleanup/drop migrations are a later deployment.

**Confirmed runner:** Cloudflare Queues for work with bounded retries and a DLQ; Cron Triggers for scheduled reconciliation; Durable Object alarms for per-entity timers. Queue consumption is at least once and unordered, so handlers need idempotency and version/order guards. Later SLA/snooze behavior is not implemented in the migration. Job status is a PostgreSQL record plus persisted event/outbox publication and authenticated realtime push, with snapshot/replay on reconnect and Cron repair of unpublished events. Existing chat polling can remain during the storage migration; new job status must not poll. [Queues guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [queue ordering](https://developers.cloudflare.com/queues/reference/how-queues-works/), [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).

User-facing operations expected to exceed 200ms of server processing return a job ID after durable admission. Benchmark p95; do not start a second background mutation merely because an already-committed synchronous request was slow. Imports, reconciliation and retention work always use jobs. Preserve client idempotency keys between synchronous and queued handling.

## 4. Existing code that breaks and planned file scope

### Existing models and routes affected

The complete existing database model set is `workspace`, `conversations`, `messages`. Existing TypeScript contracts touched are `Workspace`, `Conversation`, `Message`, `Settings`, plus inbox/detail/session response shapes when introducing job admission and receipts.

Every authored API branch is affected:

- `GET /api/inbox`: list/settings/user and conversation detail/messages.
- `POST /api/inbox`: agent reply, internal note, conversation update, workspace settings.
- `GET /api/visitor`: public config and authenticated public message history.
- `POST /api/visitor`: start and send.

The `/`, `/messenger`, `/embed` pages and `/widget.js` loader consume these contracts and need regression coverage; their route files need not change. Platform sign-in/out/callback behavior is preserved.

New native Worker routes are a signed internal chat RPC, signed migration/job admission, and authenticated job snapshot/realtime delivery endpoints. Every operation gets a cross-workspace test, including visitor credentials, idempotency receipts, job IDs and realtime subscriptions.

| Breakage | Proposed containment |
| --- | --- |
| `env.DB.prepare().bind().first/all/run/batch` and SQLite `?` / `INSERT OR IGNORE` | Scoped repository interface with retained D1 adapter and PostgreSQL adapter; explicit transactions and conflict semantics. |
| Singleton `main` and unscoped message/conversation queries | Explicit tenant context, composite references and database RLS; backfill the existing owner workspace without changing public IDs. |
| First GET can seed/write, including during freeze | Explicit guarded initialization and CLI seed; no hidden unguarded mutation on reads. |
| Retry currently changes metadata or loses visitor session after an acknowledgement failure | Transactional receipts and stable client pending-operation state. Reject mismatched key reuse. |
| Dates/booleans differ between drivers | Server DTO conversion preserves current JSON until a separately versioned contract change. Counts are computed server-side. |
| Sites hosting and platform auth cannot simply be copied into an unrestricted Worker | Signed HTTP bridge and independent backend authorization; preserve the existing platform boundary. |
| No queue/status/test infrastructure | Minimal migration jobs, durable push status and committed unit/integration/browser tests. |

### Planned file manifest: 42 files, subject to preflight

This is an implementation estimate, not a claim that these files were edited. It covers the storage migration, not the later people implementation. Generated ignored deployment configs and data exports are excluded. Only `.gitignore` has already been edited in this session; this proposal is a documentation artifact.

**14 existing files:**

| File | Planned change |
| --- | --- |
| `.gitignore` | Ignore local secret variants; already done. |
| `package.json` | PostgreSQL driver, test tooling and migration/verification commands. |
| `package-lock.json` | Matching lockfile. |
| `cloudflare-env.d.ts` | Typed bridge environment, flag and service configuration without values. |
| `vite.config.ts` | Local bridge wiring; preserve Sites configuration. |
| `lib/relay-server.ts` | Scoped repository selection, guarded initialization and service context. |
| `app/api/inbox/route.ts` | Repository calls, whole-operation idempotency, server-derived counts and job admission/status access. |
| `app/api/visitor/route.ts` | Scoped visitor/session operations and replay-safe start/send. |
| `components/relay/shared.tsx` | Response contracts and explicit stable idempotency-key support. |
| `components/relay/inbox.tsx` | Stable mutation keys, server counts and pushed migration/job status. |
| `components/relay/messenger.tsx` | Persist pending start/session before transmission; safe retry/job handling. |
| `db/schema.ts` | Additive D1 tenancy/control/receipt schema for the compatibility period. |
| `drizzle/meta/_journal.json` | Append the new D1 migration; preserve old history. |
| `README.md` | Local setup, secret handling, migration gates and verification commands. |

**28 new files:**

| Files | Count | Planned purpose |
| --- | ---: | --- |
| `lib/storage/contracts.ts`, `d1.ts`, `remote.ts`, `request-signing.ts` | 4 | Scoped contracts, legacy adapter and authenticated HTTP bridge. |
| `workers/storage/index.ts`, `postgres.ts`, `jobs.ts`, `job-status.ts`, `env.d.ts` | 5 | Native Worker routing, PostgreSQL access, queue consumer, durable realtime status and bindings. |
| `db/postgres/schema.ts`, `drizzle.postgres.config.ts` | 2 | Separate PostgreSQL schema and migration configuration. |
| `drizzle/0001_tenant_storage_guard.sql`, `drizzle/meta/0001_snapshot.json` | 2 | Additive D1 guard/tenant/receipt migration and metadata. |
| `drizzle-postgres/0000_chat_storage.sql`, `drizzle-postgres/meta/_journal.json`, `drizzle-postgres/meta/0000_snapshot.json` | 3 | PostgreSQL compatibility schema and metadata. |
| `scripts/storage-config.mjs`, `scripts/storage-migration.mjs`, `scripts/seed-storage.mjs` | 3 | Private deployment-config generation, resumable migration/rollback commands and deterministic seeds. |
| `tests/storage.unit.test.ts`, `tests/storage.integration.test.ts`, `tests/storage-migration.integration.test.ts`, `tests/chat.e2e.spec.ts` | 4 | Unit behavior, tenant isolation, interrupted migrations/rollback and browser chat flow. |
| `playwright.config.ts`, `vitest.config.ts` | 2 | Test runner configuration. |
| `docs/POSTGRES_MIGRATION.md`, `docs/rollback/POSTGRES.md`, `CHANGELOG.md` | 3 | Executable runbook, data-safe rollback procedure and release record. |

The scope is larger than replacing a database driver because the existing host, tenant boundary, retry behavior and job guarantees need compatibility work. This is the smaller proposal compared with moving the entire frontend and replacing sign-in. The plan must be reviewed before implementation.

## 5. Rollback, including failure halfway

| Failure point | Data-safe response |
| --- | --- |
| Before final freeze | D1 remains authoritative. Stop migration jobs, leave the flag off, preserve diagnostics and resume/rebuild the shadow copy idempotently. |
| After D1 freeze, before any PostgreSQL business write | Keep both fenced while diagnosing. Verify PostgreSQL has admitted no authoritative writes, restore the D1 routing epoch, then unfreeze D1. Partial PostgreSQL imports are disposable/retryable copies; leave schemas intact. |
| After route switch but before write enablement | Same as above. The read-only gate prevents ambiguous dual authority. |
| After any PostgreSQL business write | First roll back application code to the prepared PostgreSQL-compatible release, leaving PostgreSQL authoritative. A simple D1 flag flip would lose new messages and is forbidden. |
| PostgreSQL must be abandoned after writes | Fence both stores, drain admitted jobs, recover the committed PostgreSQL state, reverse-copy all compatible workspace/chat/receipt changes into D1 idempotently, verify full key/row digests and relationships, then advance the routing epoch and unfreeze D1. If PostgreSQL is unreachable, wait for recovery/backup replay; do not reopen stale D1 and claim zero data loss. |
| Interrupted rollback or worker restart | Persisted epoch, job checkpoints and receipts resume the same operation. Both business-write fences stay closed until reconciliation is verified. |

The migration release does not allow new data shapes that D1 cannot represent during its rollback window. Keep original epoch-millisecond precision, IDs, hashes, kinds and flags round-trippable. Physical schema rollback is deferred: leave added columns/tables inert instead of dropping them in the same deploy that stops their use. The rollback deliverable includes executable fence, reverse-copy, verify and routing commands, not only prose or `DROP TABLE` scripts.

### Required verification before accepting the migration

1. Unit tests for type/timestamp conversion, deterministic digests, tenant context and idempotency request matching.
2. Integration tests against real PostgreSQL with the actual non-owner runtime role: cross-workspace reads/writes/FKs fail, including every new route/operation and job subscription; missing tenant context fails closed.
3. Happy-path browser test: customer starts/sends, agent sees and replies, customer sees reply; internal notes stay private.
4. Main failure test: commit succeeds but acknowledgement is lost; restart/retry with the same key creates one message and one metadata transition. Include visitor reload recovery and changed-payload 409.
5. Failure injection at every cutover/rollback boundary, plus queue duplicate/out-of-order delivery, dead letters and job-status replay after a restart. Test refusal to reopen stale D1 after a PostgreSQL write.
6. Seed two workspaces, compare copy/reverse-copy canonical digests, exercise rollback, run lint/typecheck/build and collect p95 processing measurements. The 50,000-contact/2-million-event segment benchmark belongs to Phase 1 and must not be reported as completed here.

Local verification commands will be delivered with the implementation; they do not exist yet. The intended workflow is local UI and unit tests, plus an isolated remote development Worker/Hyperdrive/Neon branch for the real transport and end-to-end tests. No live account resource, production data copy, query plan or timing has been fabricated for this proposal.

### Decisions still requiring review before the relevant implementation

- Accept the separate native storage Worker and private deployment-binding mechanism because the current host and string-secret mechanism cannot directly provide Hyperdrive.
- Accept the minimum migration infrastructure scope before starting it; do not silently expand into Phase 1.
- Before Phase 1: choose the workspace's timezone/default locale, agree event-serving freshness and a demonstrable cold-cache test definition, validate the Iceberg retention writer, and accept the retained merge recovery snapshot interpretation.

Stopped at the plan, as requested.
