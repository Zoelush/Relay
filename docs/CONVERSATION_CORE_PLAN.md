# Relay conversation core and realtime: implementation scope

> Historical plan. The user later authorized local implementation. See [LOCAL_READINESS.md](LOCAL_READINESS.md) for current code, tests and incomplete release gates; no hosted cutover has occurred.

Status: proposed, 16 September 2026. No feature code or migrations were written. The repository inspection found that the preceding PostgreSQL migration and Phase 1 models are still unimplemented. The user's standing instruction requires stopping after the plan when the scope expands.

## 1. Reading of the current code

Relay is TypeScript/React 19 with Vinext/Vite, Tailwind and Cloudflare Workers. `app/` contains pages, platform authentication and two API handlers; `components/relay/` contains the inbox and messenger; `lib/relay-server.ts` holds server helpers and seeding; `db/` and `drizzle/` contain the three-table D1 schema. Runtime queries are raw prepared D1 SQL; Drizzle describes the schema. Agents use platform-forwarded identity checked against one workspace owner. Visitors use conversation-scoped bearer tokens. Delivery uses two-second HTTP polling. There are no jobs, durable replay, per-teammate reads, search index, upload pipeline, or committed unit/browser tests. The PostgreSQL migration exists only as a plan. There are no implemented brands, contacts/identity mappings, teammates, teams, permissions or business calendars to reference. No feature code can truthfully be described as building on those foundations yet.

### Every existing table, model and route affected

- Tables: `workspace`, `conversations`, `messages`. Preserve `messages` during additive backfill; do not rename/drop it in the release that begins using parts.
- Types/contracts: server `Workspace`; client `Conversation`, `Message`, `Settings`; inbox `InboxData` and `DetailData`; visitor `Session`; binding type `Cloudflare.Env`.
- `GET /api/inbox`: list/settings/user branch and conversation detail/messages branch.
- `POST /api/inbox`: reply/note, status/assignment/priority/read, settings branches.
- `GET /api/visitor`: public config and authenticated public history branches.
- `POST /api/visitor`: start and send branches.
- `/`, `/messenger`, `/embed`, and `/widget.js`: dependent surfaces requiring end-to-end coverage. Their route files only change if brand bootstrap requires it. Platform sign-in/out/callback remains the authentication boundary.

### Conflicts and smallest useful sequence

1. **PostgreSQL was requested before feature work, but its migration has not happened.** First execute the separately reviewed migration; do not build another D1-only conversation engine.
2. **This request depends on missing Phase 1 data.** Next implement the needed workspace/brand, teammate/team, permission, contact/identity, tag/attribute and versioned business-calendar foundations as an explicit Phase 1 slice. This does not complete the earlier full Phase 1 request: companies, custom objects, event ingestion and segments retain their own outstanding scope and acceptance gates.
3. **The existing host cannot open raw TCP for Hyperdrive.** Reuse the previously proposed native Cloudflare backend behind authenticated HTTP from the existing Sites app; retain its UI and sign-in. Moving the whole app and replacing auth is the larger alternative, excluded here.
4. **Append-only parts cannot have delivery status overwritten.** Store initial delivery state on the part; append delivery transitions separately and maintain a rebuildable current-status projection.
5. **Ephemeral presence/typing conflict with replaying every socket frame.** Propose ordered, at-least-once replay for durable changes; presence/typing/collision frames expire and refresh from live state. They must not be replayed as historical typing.
6. **Merging arbitrary contacts/brands can expose another customer's history.** Propose restricting initial merges to the same workspace, brand and resolved primary contact. Broader merges require an explicitly approved participant-visibility policy.

The proposed sequence is three separately verified releases: storage migration; prerequisite Phase 1 slice; conversation/realtime/search/attachment layer. Each has its own default-off flag, migration, rollback, seed, unit tests, happy-path E2E, main failure test and CHANGELOG entry. No ticket implementation, AI answering service, external-channel connector or visual workflow builder is included.

## 2. Proposed implementation

### 2.1 Conversation persistence and commands

Use Neon London through Hyperdrive. Every application table carries `workspace_id`; every lookup, join, uniqueness constraint and foreign key is tenant-scoped, with PostgreSQL RLS under the non-owner runtime role. Keep the identity-to-contact indirection from Phase 1: store primary/participant identity references and resolve canonical contacts, rather than rewriting conversation history during a contact merge.

| Table or projection | Responsibility |
| --- | --- |
| `conversations` | Brand, primary identity, state, snooze time/version, channel of origin, teammate/team assignment, priority, title plus human/generated provenance, sequence/version and derived last-reply/first-response/rating fields. |
| `conversation_parts` | Immutable ID, workspace, original conversation, per-conversation sequence, type, typed author, server UTC time plus origin timezone/provenance, channel, audience, structured payload, initial delivery state, optional supersedes reference. |
| `conversation_part_delivery_events` | Immutable delivery attempts/transitions linked to the part, including queued/accepted/delivered/failed distinctions. |
| `conversation_cycles` | Derived opening/closing cycles linked to their originating parts; response metrics and versioned business-calendar references. Rebuildable without inferring lost transitions from the current state. |
| `conversation_participants` | Current identity membership and role; add/remove operations also append parts. |
| `conversation_aliases`, `conversation_merges` | Both original IDs remain resolvable; record source/target roots, marker parts and timeline revision. |
| `conversation_tags`, `conversation_topics` | Current tag/topic relationships with same-workspace definitions; all changes are recorded. |
| `conversation_attribute_values` | Reuse Phase 1 typed attribute definitions and indexes; changes append parts containing appropriate before/after values. |
| `conversation_reads` | Per-teammate read watermark and derived unread state; no workspace-wide shared unread bit. |
| `conversation_view_memberships`, `inbox_counters` | Incrementally maintained membership and unread totals keyed by workspace, teammate and view; no row counting during renders. |
| `conversation_search_documents`, `part_search_documents`, `search_checkpoints` | Authorized, current searchable content, projection generations and resumable progress. Old edited/deleted content remains in restricted audit storage, not ordinary search results. |
| `attachments`, `attachment_scan_attempts` | Private object references, exact byte hashes, ownership/audience, scan evidence, status and preview references; no binary payloads. |

Reuse migration infrastructure: idempotency receipts, transactional outbox, durable job status/events and feature flags. Reuse Phase 1 brands, identities/mappings, contacts, teammates, teams, roles/permissions, typed attributes, tags and versioned schedules. Define topic labels in this phase; automated topic classification belongs to the AI phase. No raw contact-event table is introduced.

Parts support every requested type: customer message, teammate reply, internal note, AI reply, assignment/state/priority/tag/participant/attribute change, rating, attachment, system event, channel handover and merge marker. The AI author type is a validated future integration contract, not permission for a browser to impersonate an AI agent. Existing messenger is the implemented channel; other channel names do not imply working connectors.

Every durable command carries a client idempotency key and request digest. Authenticate and authorize, resolve the canonical conversation, lock/version-check it, allocate sequence numbers, append parts, update projections/counters and insert outbox/receipt records in one database transaction. A retry replays the original result; conflicting key reuse returns 409. No published part exists before its database commit.

Implement reply, note, assign, snooze, wake, close, reopen, priority, participants, tags/topics, attributes, title, rating, merge and superseding edit/delete operations. Closing/reopening append state transitions and update cycle projections atomically. Repeating a stale alarm or retry cannot create another cycle. Snooze stores a versioned wake deadline; a Durable Object alarm uses that version in an idempotent wake command, and Cron repairs missed schedules. First-response and last-reply fields are server-derived; notes do not count as public replies. Store business-time and wall-clock results against the calendar version used, not today's mutable schedule.

Edits/deletions append a new part referencing the prior version. Enforce separate reply/note permissions and prevent stale concurrent edits from silently winning. Restrict visibility in history, replay, search, attachments and realtime. Replies already delivered on a channel without edit/delete support cannot be represented as remotely recalled; retain the delivery audit and report the limitation.

`TicketPort` is owned by phase 5. The conversion operation validates authorization and calls this interface only when a provider exists. Until then return an explicit unavailable result; do not create a fake ticket, success marker or permanently pending conversion job. Generated titles can use a deterministic server-generated excerpt; AI title generation remains outside this phase.

### 2.2 Ordered realtime and reconnect

Use one authenticated WebSocket protocol for parts, assignments, unread projections, typing, presence and collision signals. Keep normal command HTTP requests for idempotent writes and signed URLs for file transfer; these are not competing realtime transports. A native Cloudflare Worker terminates authentication and routes connections to workspace-scoped Durable Object gateways with bounded, authorized subscriptions. [Cloudflare WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

Durable flow:

1. Commit the command, ordered conversation log and outbox together in PostgreSQL.
2. A fast post-commit notification can wake the gateway; an outbox dispatcher with retries is the recovery path if that notification is lost. Queues are wake-up/work signals, not the source of ordering. [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/).
3. Gateways drain committed events in sequence and do not forward a later event while an earlier permitted interval is missing. Subscriber-specific visibility must not leak internal note payloads or authors; use opaque server cursors that advance across filtered records so clients do not mistake hidden notes for delivery gaps.
4. On subscribe/reconnect, establish a durable high-water mark, replay from the validated cursor through that mark, then drain buffered/new events. This handshake closes the race between replay and live delivery.
5. Clients persist the accepted cursor with their deduplicated timeline state, deduplicate parts by stable part ID and apply sequences in order. A crash after rendering but before acknowledgement causes harmless replay. A missing client cache triggers a full authorized snapshot before cursor advancement.
6. Slow clients get bounded buffering and a reconnect/resync response, not silent dropped durable frames. A server restart recovers from PostgreSQL; WebSocket memory is never authoritative. A superseded projection/timeline revision requires an explicit snapshot and new cursor.

Presence, typing and collision leases remain in the realtime service, expire by server time and never enter PostgreSQL. They can vanish on restart/hibernation and reconstruct from connected sockets/heartbeats. Durable Object hibernation resets in-memory state, so typing cannot depend on memory surviving it. Durable frames and ephemeral frames have distinct protocol envelopes; an ephemeral frame does not consume a durable conversation sequence. [Hibernation behavior](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

Unread semantics proposed for approval: an unread conversation is one with a customer-visible inbound message beyond that teammate's read watermark. Private notes and the teammate's own reply do not create unread counts. Built-in views initially cover all, mine, unassigned, team, priority, snoozed and closed; counts represent unread conversations. Update counters on new inbound content, read markers, membership/assignment/state changes and merges, with an idempotent repair job. Push absolute counts plus versions; clients do not accumulate unverified increments. Custom saved-view authoring remains a later inbox feature, with a view-evaluator interface rather than an unused builder.

### 2.3 Conversation merge without history loss

Lock both resolved roots in a stable order, reject cross-workspace merges and cycles, check the approved brand/contact policy, append merge markers and persist aliases. Keep immutable parts under their original source IDs/sequences. Allocate a server-controlled, nondecreasing timeline-order timestamp with each original sequence, retaining the actual observed timestamp separately; a clock correction must not invert an existing conversation's sequence. A merged-history projection orders the union by that original ordering timestamp, then original conversation ID and original sequence for deterministic ties. Preserve all original parts and supersession chains exactly once.

Do not renumber immutable parts or pretend two old cursors are one linear cursor. Increment the canonical timeline revision and send a durable redirect/resync event to both streams. Replay through a merge-aware snapshot containing both timelines, establish its high-water marks, then follow the canonical stream. Both original IDs resolve through authorization checks; cursor resets may duplicate delivery but cannot duplicate the displayed timeline. New commands target the canonical root. Tests must cover concurrent writes, reconnect during merge, later merges and stale aliases, not only a static union of arrays.

### 2.4 Search

Start with PostgreSQL full-text projections and GIN indexes, plus workspace-prefixed filter indexes for state, channel, teammate, team, date and resolved contact; tag filters use indexed membership. Use parameterized queries and apply tenant/audience policy before producing snippets or counts. Index effective reply/note versions, not superseded/deleted text. [PostgreSQL text-search indexes](https://www.postgresql.org/docs/current/textsearch-indexes.html).

An outbox-fed indexer records resumable keyset/change checkpoints. Reindex into a new projection generation from a fixed watermark, consume subsequent changes, verify parity, and switch the active generation without dropping old indexes/tables in that deploy. A crash resumes from committed checkpoints; replay is idempotent. Benchmark under the sustained write workload before considering an external search service. Report search freshness explicitly.

### 2.5 Attachments

Proposed first-version policy for review: maximum 25 MiB; JPEG, PNG, WebP, GIF, PDF and plain text. The server validates workspace, conversation, capability, requested size/type and quota before issuing a short-lived, object-specific signed R2 PUT URL. Configure CORS for approved messenger origins. Verify actual stored byte length, magic/type, checksum and parser limits after upload; declared metadata alone is insufficient. A direct PUT URL is not a claim that arbitrary oversize bytes can never reach quarantine. Reject/remove invalid objects before they become usable. [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/).

Uploads go into private quarantine. Queues run type checks and real ClamAV scanning in a private Cloudflare Container, with maintained signatures, retry limits, dead letters and pushed job status. Do not expose the unauthenticated ClamAV daemon directly. Missing/stale scanner signatures or scan failure keep the file unavailable. This is additional infrastructure, not an R2 feature that already exists. [Cloudflare Containers](https://developers.cloudflare.com/containers/), [ClamAV scanning](https://docs.clamav.net/manual/Usage/Scanning.html).

Prevent replacement-after-scan: scan/hash exact bytes and promote those same bytes to a new clean object key the client cannot overwrite. Serve only that verified clean object. Generate bounded raster previews from scanned images, remove metadata and reject decompression bombs; do not inline arbitrary SVG/HTML. Downloads/previews require conversation authorization and expire; cache keys include access scope, and quarantine is never public. Remove abandoned uploads through a scheduled job. PostgreSQL holds metadata only.

### 2.6 Validation and rollout

- **Isolation:** two workspaces, overlapping identifiers where possible, every route/command, WebSocket subscription/replay cursor, search filter, read counter, alias and upload/download path. Use the real non-owner database role, not a mocked repository alone.
- **Happy path:** customer starts a branded chat, teammate receives and replies over realtime, customer renders the reply, read counters converge; private notes remain private.
- **Main failure:** database commit followed by process termination before publish/ack; client retries and reconnects with one logical mutation, ordered recovery, no lost part and no duplicate rendering.
- **60-second disconnect:** keep other clients writing while one disconnects; include server restart, duplicate/out-of-order notifications and a merge variant. On reconnect, compare the entire authorized ordered timeline and effective edits with the server, plus IDs, counts and cursors. No gaps or duplicates.
- **Merge:** both original IDs resolve; one deterministic union contains every original part once; include tied timestamps, edits, notes, attachments, concurrent writes and cross-tenant rejection.
- **Attachments:** real scanner test fixture, spoofed MIME, oversize/truncated upload, expired signature, scan outage, reused PUT/replacement race and denied foreign-workspace download.
- **Other failures:** repeated/stale snooze alarms, concurrent edit conflict, search indexer restart and stale permissions on an already-open socket.
- **Load:** proposed 2-minute warm-up and 10-minute sustained run at 50 messages/second, 200 authenticated agent browsers and 5,000 open conversations. Include a hot-conversation case and background indexing. Distinguish actual browser render measurements from socket-only throughput. Record p50/p95/p99, delivery failures, duplicates/gaps, worker/job backlog, browser CPU saturation, environment and geographic placement.
- **Measurement:** stamp write-handler admission, transaction completion, publish, receive and first post-update animation frame. Report admission-to-render and transaction-completion-to-render separately, with measured clock offset/error; socket receipt is not client render. Collect all expected samples or report missing ones as failures, not discarded tail latency. No latency threshold beyond the previously agreed server-processing budget is invented.
- **Timing:** measure p95 server processing; operations expected to exceed 200ms use durable jobs and pushed status. Do not queue a second copy of a mutation merely because its first committed execution was slow.
- **Rollout:** workspace feature flags default off; additive backfill of messages to typed parts uses stable IDs and checkpoints. Preserve the original message timestamps and mark unavailable historical actor/timezone/cycle data as unknown. The old mutable flag never recorded prior close/reopen cycles, so those cannot be reconstructed honestly.
- **Rollback:** retain the prior core-capable reader and write fences. Once rich parts exist, a D1-era client cannot represent them; do not claim a blind downgrade preserves history. Disable new commands if necessary while serving the durable timeline from a compatible version; repair/forward-fix projections. Leave added schema in place. Each release supplies operational rollback commands, seed data, tests and CHANGELOG.

## Planned implementation boundaries, not changes made

| Area | Planned files/modules |
| --- | --- |
| Storage prerequisites | The separate migration manifest in `POSTGRES_MIGRATION_PLAN.md`; Phase 1 prerequisite schemas/policies/calendars receive their own reviewed migration. |
| Core | `lib/conversations/` contracts, command policy, state transitions, effective-part rendering and merge rules; native Worker services and PostgreSQL repositories. |
| Realtime | `workers/realtime/` gateway/protocol/replay/ephemeral leases; `lib/realtime/` client cursor store, ordering and deduplication. |
| Search | `workers/search/` indexer and query service; projection-generation/checkpoint migrations. |
| Attachments | `workers/attachments/` signing/authorization/jobs; private scanner container and preview pipeline. |
| UI | Existing inbox, messenger and shared client helpers; new part renderer, connection status, upload progress and collision/presence components. |
| Routes | Keep existing inbox/visitor compatibility routes; introduce versioned conversation commands/history, search, read markers, upload initiation/completion/download and realtime authorization routes. Every new operation must have isolation coverage. |
| Verification | Unit and PostgreSQL/Worker integration suites, browser reconnect/merge/attachment E2E, distributed browser load harness, deterministic seeds, migration rollback runbooks and CHANGELOG. |

No implementation command or test result is claimed: those files/scripts are not present yet. Cloud authentication was unavailable in the preceding inventory; no new authenticated cloud inventory or deployment was performed during this plan.

## Decisions needed before feature code

1. Confirm the three-release scope: separate storage migration, explicit minimum Phase 1 prerequisites, then this layer. If those foundations were implemented elsewhere, identify the checkout/branch so it can be inspected instead.
2. Confirm initial merge policy: same workspace, brand and resolved primary contact; broader merges require explicit audience rules.
3. Confirm durable-only replay with expiring ephemeral signals, unread-conversation counts, whether new customer replies automatically reopen closed/snoozed conversations, the proposed upload policy, and a rating scale (proposed 1–5). These are proposed semantics, not silent implementation choices.

The pause is required by the user's scope-confirmation rule; it is not an automatic approval rejection or a skill-imposed approval requirement.
