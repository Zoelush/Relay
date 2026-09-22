# Agent inbox — repository reading and implementation plan

Date: 22 September 2026. Status: step 1 implemented locally; remaining inbox steps authorized and in progress.

## Decisions

These user-approved decisions supersede conflicting proposals below.

- **Dependency scope:** do not wait for or implement later phases. Use interfaces and hide/disable unavailable integrations. Ticket-state actions must exist in the eventual macro/bulk schema but stay hidden until phase 5; omit SLA sorts/filters until phase 5. Show only existing contact/company/attribute data. Define the phase-15 app-slot contract with no apps when the sidebar step is built.
- **Counts:** total conversations matching each view, maintained server-side and pushed by WebSocket with at most two seconds of lag. Open views exclude snoozed/closed; Snoozed contains only snoozed. Unread is separate per teammate/conversation: a customer-visible part arrived after that teammate last opened it. Display counts above 9,999 as `9,999+`; never derive totals by counting browser rows or querying a count on each render.
- **Undo:** ten seconds, server-timed. Apply bulk actions immediately and publish them to teammates; undo applies inverse actions. Skip and report any conversation changed by someone else in that window. Never overwrite their work.
- **Attachments:** add `customer_visible`/`internal` audience before private-note uploads. Internal content must remain inaccessible to customer credentials, including copied direct links, preview links and storage paths. Use authenticated downloads for internal files rather than transferable presigned GET URLs.
- **Current authorization:** the user subsequently requested “Continue the remaining steps.” Implement steps B–D below in order, preserving all dependency boundaries, count/undo semantics and privacy requirements. The earlier step-1-only restriction described that completed slice; it no longer limits the remaining inbox work. Cloud provisioning and cutover remain deferred.

### Exact unfinished people dependencies

| Missing feature | What phase 4 eventually needs | Blocks step 1? |
| --- | --- | --- |
| Companies and contact–company roles | Company context, safe macro variables and company filters | No; no company card or invented company record. |
| Typed contact/company attribute values and editing service | Validated inline edits, indexed view filters and safe variables; only definitions and conversation values exist today | No; existing contact details are read-only. |
| Custom object definitions, instances and links | Related-object cards and authorized lookup | No; omit cards until the people service exists. |
| Full contact administration (multiple-address editing, relationship-aware merge audit/reversal) | Rich contact editor and context actions | No; use existing contact identity resolution without expanding edit/merge scope. |
| Events, retention/holds, subscriptions and segments | Event-derived targeting/filters and communication eligibility in their owning phases | No; none is required to connect this inbox or display existing conversations. |

No people gap blocks step 1. Future blockers must be reported before adding a workaround model. SLA, tickets, Help articles and email/chat providers remain later-phase interfaces, not people prerequisites.

## 1. Reading of the current code

Relay uses React 19, TypeScript, Vinext/Vite and Tailwind. `app/` and `components/relay/` contain the existing D1-backed inbox; `lib/relay-server.ts` performs its raw SQL. That UI uses platform-forwarded identity, one workspace owner, two-second polling, client-side filters/counts and memory-only drafts.

The newer implementation lives in `server/`, `workers/`, `db/postgres/`, `messenger/` and `scripts/`. Its data access uses raw parameterized PostgreSQL queries inside tenant transactions, composite workspace foreign keys and forced RLS. Production Workers require Hyperdrive. Signed agent bridge requests resolve teammates and named capabilities; customer sessions use verified identities. The existing inbox has not connected to this bridge.

One WebSocket protocol provides cursor replay, counters, typing, presence and job updates. PostgreSQL parts/outbox are authoritative. Cloudflare Queues run jobs with retries/DLQ, Cron repairs delivery and Durable Object alarms wake snoozed conversations. Local development substitutes PGlite, Node and WebSockets. Node tests exercise SQL and routes; Playwright tests the messenger and restart recovery. There are 19 passing regression tests. Neither the requested agent-inbox browser acceptance nor its 150ms measurement exists yet.

## 2. Plan

### 2.1 Conflicts and the smaller change

| Request | Current code / conflict | Smaller change before expansion |
| --- | --- | --- |
| Build the agent inbox | The visible inbox and new conversation service use separate storage/auth paths. | Add a default-off `agent_inbox_v1` path in the existing app, with a server-side signed bridge. Reuse the new core; preserve the legacy path until a verified cutover. |
| Live view counts | `inbox_counters` counts **unread** conversations. It is not a total-membership counter. Its built-in `mine`/`unassigned` membership is not automatically restricted to open state. | Add explicit saved/default view predicates and separate total/unread projections. Confirm which count the sidebar should show. |
| 10,000-row lists | Agent inbox GET returns at most 100 rows; legacy UI loads/maps its entire list. Search returns 50 plus `hasMore`, without a continuation cursor. | Add keyset pages, server sorting and one filter compiler shared by list/search/counts, then virtualize the client list. |
| Rich text and note attachments | Parts currently store plain text. Attachment publication/download checks conversation access but has no internal/public attachment classification. | Add a restricted rich-document representation, sanitized server output and attachment audience/owner metadata **before** enabling note uploads. Retain plain text for search/channel fallback. |
| Macros with separate permissions | Only `macros.manage` exists; no macro tables/routes. | Add create/edit/delete/use/share capabilities and resource ownership checks. Preserve the old capability during additive migration; do not grant custom roles unexpected privileges. |
| Contact/company/custom-object sidebar and filters | Contacts and conversation attribute values exist. Typed contact/company values, companies and custom objects do not. | Finish the relevant earlier people models before enabling their filters/cards. Do not use unindexed profile JSON as a substitute for the requested typed model. |
| SLA filters/sort and ticket state | Ticket conversion is a phase-5 interface; there is no ticket or SLA engine. | Define ticket-state/SLA-read contracts. Keep those controls unavailable until the owning phase provides real data; do not create fake deadlines. |
| Article insertion | `HelpCenterPort` exists without a provider. | Build the insertion adapter against that contract; expose it only when published articles are available. The help-center phase owns article storage/search. |
| Side conversations by email/chat | There is no outbound provider, inbound webhook, threading or channel notification implementation. | Build inbox-owned private threads and a connector contract. Live external delivery requires the channel phase/provider configuration; a local fake is only test evidence. |
| Undo | Core history is append-only and later teammate edits may intervene. | Use version-checked compensating commands. Preserve audit history and report per-item conflicts; never restore a stale whole-conversation snapshot. Confirm the window length. |

The full request expands into unfinished earlier people work and later ticket/SLA/help/channel phases. The recommended boundary is: complete the inbox-owned implementation, integrate existing core services, and define explicit unavailable provider contracts for later phases. Missing earlier people prerequisites remain an ordered prerequisite, not a claim that their acceptance has passed. This requires a scope decision under the standing instruction to stop after an expanded plan.

### 2.2 Existing tables and models this work touches

The following inventory covers direct and transitive access, including command execution, notification delivery and regression coverage. Every query remains workspace-scoped.

| Existing tables | Use in this phase |
| --- | --- |
| `workspace`, `brands`, `workspace_features` | Tenant/brand context, timezone, configuration and default-off inbox flag. |
| `roles`, `role_capabilities`, `teammates`, `teams`, `teammate_teams` | Capabilities, assignments, mentions, personal/shared access and team context. |
| `contacts`, `contact_emails`, `contact_phones`, `identities`, `identity_contact_mappings` | Resolved primary contact, sidebar details, safe macro variables and recent conversations. |
| `conversations`, `conversation_parts`, `conversation_cycles`, `conversation_part_delivery_events`, `conversation_participants` | Commands, typed timeline, lifecycle history, merge aliases and delivery state. |
| `conversation_reads`, `conversation_unread`, `inbox_counters` | Existing teammate read positions and unread projections; preserve existing semantics while adding view totals. |
| `tags`, `conversation_tags`, `attribute_definitions`, `conversation_attribute_values` | Filter and action inputs, validated attributes and macro actions. |
| `conversation_search_documents` | Workspace/view-scoped full-text search, including effective superseding parts. |
| `attachments` | Agent ownership, public/internal audience, quarantine/scanning and authorized previews/downloads. |
| `business_calendars` | Server-side snooze presets, business-hours calculations and future SLA boundary. |
| `idempotency_receipts`, `outbox`, `jobs`, `job_events` | Retry safety, view rebuilds, bulk execution/undo, durable notifications and pushed job status. |
| `customer_reads`, `customer_counters`, `customer_unread_threads`, `customer_unread_totals` | Existing reply/merge side effects; notes must not generate customer unread or notification content. |
| `messenger_sessions`, `identity_keys` | Existing customer authorization/privacy regression tests and shared seed setup; no new agent authentication scheme is stored here. |
| `storage_migration_state` | Read the verified storage authority when connecting the new UI; the inbox phase does not perform the production cutover. |

Relevant existing code models: `Conversation`, `Part`, `Command`, `Actor`, `Teammate`, `Capability`, `Session`, `AgentSession`, `RealtimeSession`, `Job`, `AttachmentStorage`, `Sql`, `Connect`, `ApiEnvironment`, `HelpCenterPort`, `TicketPort` and `RoutingPort`. Legacy UI `Conversation`, `Message`, `InboxData` and `DetailData` require an explicit new-path adapter rather than casts between incompatible D1/PostgreSQL shapes.

Proposed inbox-owned tables (all with `workspace_id`, tenant foreign keys, RLS and UTC/origin timezone for timestamps):

- `inbox_views`, `inbox_view_folders`, `inbox_view_preferences`: predicates, owner/visibility, folders and per-teammate ordering. Shared folder membership cannot reveal a personal view.
- `inbox_view_memberships`, `inbox_view_counts`, `inbox_projection_checkpoints`: rebuildable membership/count generations and resumable watermarks. Counts carry versions and freshness status.
- `conversation_drafts`: author-only versioned rich document keyed by teammate, conversation and reply/note mode.
- `macros`, `macro_versions`: visibility, owner, validated document/action bundle and retained execution version.
- `part_mentions`, `teammate_notifications`: structured recipient references, deduplicated per-recipient notifications and read state.
- `side_conversations`, `side_conversation_parts`, `side_conversation_deliveries`: separately scoped private threads, immutable history and provider retry receipts. A side thread never uses the customer's participant list.
- `inbox_bulk_operations`, `inbox_bulk_items`: frozen authorized selection, affected count, execution outcome, before/after versions and compensating-action receipts.

No companies, tickets, SLA, help-center or app-installation tables are silently scaffolded as inbox tables. Their owning phases supply the prerequisite implementations or contracts stated above.

### 2.3 Route inventory

Existing routes to modify or exercise:

- `GET /`: default-off selection of new inbox after authenticated workspace membership; retain old UI for uncut-over workspaces.
- `GET/POST /api/inbox`: preserve legacy contract; add an explicit authenticated new-path bridge rather than passing browser identity/credentials through unchecked.
- `GET /v1/agent/inbox`, `GET /v1/agent/search`: cursor pagination, view predicates, sorting, first-screen data and server counts.
- `POST /v1/agent/command`: rich reply/note, validated mentions, snooze wake policy, macro action composition and reconciliation versions.
- `POST /v1/agent/realtime-ticket`, `GET /v1/agent/job`, `POST /v1/agent/search/reindex`, `POST /v1/agent/unread/rebuild`: reuse authorization and pushed recovery/status flow.
- `/realtime`: add view subscriptions/count versions, private notifications and viewing/composing leases. Existing customer subscriptions remain audience-filtered.
- Customer regression surface: `GET /v1/messenger/history`, `GET /v1/messenger/conversations`, `GET /v1/messenger/unread`, `GET /v1/messenger/attachment`, `POST /v1/messenger/read`, `POST /v1/messenger/realtime-ticket`, plus customer boot/command in end-to-end fixtures.
- Local `/agent`, `/demo/agent` and `/demo/agent.js`: replace the manual agent fixture with a testable new inbox path, preserving loopback-only fixture authentication.

Proposed new HTTP routes under `/v1/agent` (all retryable mutations require a client idempotency key):

| Method | Paths | Purpose |
| --- | --- | --- |
| GET | `/bootstrap`, `/context`, `/timeline` | Current teammate/capabilities, sidebar context and paginated first-screen history. |
| GET, POST | `/views`, `/folders` | Read and mutate personal/shared definitions; actions include create, update, duplicate, reorder and archive. |
| POST | `/views/rebuild` | Return a persisted projection job ID; progress/completion arrives on the socket. |
| GET, POST | `/draft` | Author-only load/save/discard with conflict versions. |
| GET, POST | `/macros` | Authorized catalogue and versioned CRUD. |
| POST | `/macros/preview`, `/macros/apply` | Server-side safe interpolation, action validation and atomic per-conversation execution. |
| GET, POST | `/notifications` | Teammate-only notification snapshots and idempotent acknowledgement. |
| GET, POST | `/side-conversations` | Separate private timeline and connector-backed sends when a provider exists. |
| POST | `/bulk/prepare`, `/bulk/commit`, `/bulk/undo` | Server-counted frozen selection, confirmed execution job and conflict-aware compensations. |
| POST | `/contact/command` | Capability-checked, versioned inline editing through the people service. |
| POST | `/attachment/prepare`, `/attachment/complete` | Agent-owned signed upload and scan-job submission with explicit audience. |
| GET | `/attachment` | Audience/owner-aware private download or preview. |

Add a same-origin allowlisted `/api/agent/[...path]` bridge for these routes. The app authenticates the principal, resolves workspace membership server-side and signs the exact method/path/query/body/key. Browser-supplied workspace, principal and capability claims are never trusted. Keep signing secrets on the server. Use short-lived socket tickets, not bridge secrets, in the browser. External reply webhook paths belong to the selected channel provider and are not invented before that choice.

### 2.4 Ordered implementation

**A. Connection and privacy boundary.** Wire the authenticated app to the new core behind `agent_inbox_v1=false`. Add additive attachment owner/audience fields and fail closed for unclassified agent uploads. Centralize public-part projection for messenger, preview, unread and future delivery adapters. New note/side-thread content cannot enter a customer delivery envelope; internal attachments require their own authorization. Preserve legacy text and customer upload behavior.

**B. Queue, views and fast navigation.** Define nested validated predicates and deterministic server sort keys with an ID tiebreaker. Defaults are mine, unassigned, all open, snoozed, closed and mentions; mine/unassigned apply explicit open-state predicates. Custom views use the same compiler for list, search, count and membership. Return server-computed totals/unread values, waiting duration and display labels. Do not count client rows. Materialize view membership using resumable jobs and versioned outbox events; incremental updates include contact/company changes when those providers exist and scheduled time-boundary changes. Unknown providers produce an explicit unavailable filter, never an empty-success result.

Use bounded list pages and a virtualized viewport with overscan, stable keys and keyboard focus retention. Warm-cache selection renders an authorization-scoped first-screen snapshot immediately, then reconciles with the server. Cache keys include workspace, principal and conversation revision; clear on logout/role change. Add a recent first-screen endpoint plus backwards history pagination so opening a long conversation does not replay its entire history first. The durable socket cursor still covers all committed parts and aliases.

**C. Timeline, composing and collaboration.** Render all 15 existing part kinds, superseding edits/deletions, attachment state and merge markers. Collapse system-event runs with accessible expansion. Replies and notes use distinct colour, heading, send label and audience indicators. Rich documents use an allowlist of nodes/marks/links; sanitize on the server and produce plain-text fallback. Inline images reference scanned attachments. Draft autosave is server-backed and author-only, with version conflict handling and a namespaced recovery buffer during connectivity loss. Mention recipients are structured teammate/team IDs; resolve team recipients server-side at send time and deduplicate notifications. Viewing and composing are expiring, agent-only leases on the existing socket; they never touch PostgreSQL or expose note composition to customers.

Add shortcut sheet and command palette covering navigation, reply/note, send, assign, macro, snooze, tag, close/reopen and search. Suppress navigation shortcuts during text entry/IME and retain accessible alternatives. Snooze presets/custom time resolve on the server using the originating timezone; retain assignee by default and persist the configured unassign-on-wake choice with the snooze version.

**D. Macros, sidebar and bulk actions.** Macros interpolate allowlisted fields on the server with permission-aware, escaped fallbacks; never evaluate templates as code. Validate the entire action bundle before writing, append all effects atomically and publish only after commit. A missing ticket provider rejects the entire unsupported bundle rather than partially applying it. Add separate personal/shared create/edit/delete/use/share checks.

The sidebar reads the resolved contact and related history, enforces personal-data permission and routes edits through typed people commands. Company/custom-object cards require their earlier-phase data. Define a versioned phase-15 app-slot interface containing scoped context, declared capabilities, loading/error states and a host-mediated action API; do not load arbitrary app scripts or build an app marketplace.

Bulk prepare returns a server-counted selection snapshot and versions. After the count is confirmed, commit returns a job ID; checkpointed items have independent idempotency receipts. The UI can display pending state immediately, then reconcile pushed results. Undo cancels pending items and applies version-checked compensating commands to completed items within a server-calculated window. Later edits produce visible conflicts, not overwritten work. External side-message sends have no promise of recall and are not included in bulk undo.

### 2.5 Optimism, jobs and release evidence

Every mutation gets a stable client mutation ID, local pending overlay and authoritative response/version. Failed writes remove only their own optimistic overlay, preserve unsent text and show the rejection. Stale responses cannot replace newer state. A retry reuses the original key; changed payload requires a new key. For bulk/background work, acceptance is not completion. The UI renders persisted job state and pushed item results, never client polling. Do not show a file as deliverable before scanning or an external message as delivered before provider acknowledgement.

Queues perform view rebuilds, bulk work and external deliveries; Cron repairs undelivered outbox entries/scheduled projection boundaries; Durable Object alarms handle entity deadlines. Retries and DLQ use existing persisted job infrastructure. Measure p95 processing; split work that cannot remain within 200ms into bounded jobs. Store deadlines in UTC with originating timezone and calendar version. Keep business-hours and wall-clock calculations on the server.

Each implementation increment includes additive migration and data-preserving rollback, two-workspace seed data, unit tests, one happy-path E2E, a main failure-path E2E and a CHANGELOG entry. Rollback disables the inbox flag/revokes new sessions as appropriate and retains drafts, parts, macro versions and undo history. It never silently switches PostgreSQL writes back to D1.

Required acceptance evidence:

1. **Warm first-screen latency:** record click/keyboard-selection start to the animation frame after the first timeline screen is rendered, excluding skeletons. Seed 10,000 list rows plus long/merged timelines; warm one cache entry per conversation, then measure at least 100 selections. Report p50/p95/p99, cache-hit rate, browser/hardware and server timing; target p95 below 150ms. Report cold/network misses separately. No fabricated measurement before implementation.
2. **Virtualization:** scroll through 10,000 server-paged rows; bound mounted nodes, preserve selection/focus and record long tasks/frame timings. Existing 200-minimal-pane realtime measurements do not establish this acceptance.
3. **Optimistic reconciliation:** table-driven happy/rejection/conflict tests for each mutation category, including draft save, notes/replies, macro actions, view changes, inline edits, snooze and bulk undo. Test reversed response order and lost acknowledgement/retry.
4. **Tenant and author isolation:** cross-workspace read/write tests for every new route; teammate B cannot load teammate A's drafts or personal definitions; shared resources respect capabilities. Test role revocation with a warm browser cache and open socket.
5. **Notes never reach customers:** inject a unique secret in note text, rich content, mentions, edits, deleted/superseding parts and attachments. Assert absence from customer HTTP history, replay after outage, search/public projections, notification payloads, preview/download URLs and customer delivery envelopes. Attempt malformed kinds/audiences and raw part IDs through provider adapters; reject before enqueue/send. Separately permit authorized teammate notifications without expanding recipients to customers. Real email/chat integration requires the eventual provider test; an unimplemented channel is not certified by a mock.
6. **Durability:** crash during bulk/macro/view rebuild and reconnect during updates; exact replay and one durable effect per key. Undo must preserve later edits and return per-item conflicts. Restart and stale alarms must not duplicate snooze wake or notifications.

### 2.6 Approved boundary and implementation record

The scope questions are resolved by **Decisions** above: step 1 only, total view matches separate from unread, and ten-second conflict-aware bulk undo when that later step is built. Sections 1–2.5 preserve the pre-implementation inventory and broader roadmap; they do not authorize later steps.

Step 1 now connects the authenticated app to the PostgreSQL service and WebSocket replay, adds note/attachment privacy, and retains the D1 polling UI behind the flag. See [AGENT_INBOX_STEP1.md](AGENT_INBOX_STEP1.md) for the actual file changes, migration/rollback, local verification and remaining acceptance limits. No later inbox steps or hosted cutover were performed.
