# Changelog

## Unreleased — agent inbox step D3 (bulk actions with undo)

- Bulk actions from the saved-views list:
  - **Selecting:** row checkboxes, Shift-click ranges, X for the open conversation, and "Select all N in this view".
  - **Actions:** close, reopen, assign, add or remove a tag, priority and snooze.
  - **Confirming:** the confirmation shows the server's count, at most 5,000 conversations.
- A background job applies 25 conversations per step through the ordinary commands, as the teammate and with their permissions. Each conversation's failure is recorded with its reason without stopping the rest.
- Undo is available for 10 seconds from commit (server time), with a live countdown. Conversations not yet reached are cancelled. A reversing command runs only if the changed field still holds what the bulk action set; otherwise that conversation is left alone and reported as changed since.
- Migration 0021 adds `bulk_operations` and `bulk_items`, with a rollback. New route `POST`/`GET /v1/agent/bulk`, which alone accepts bodies up to 256 KB, so 5,000 ids fit.
- Tests: `tests/bulk.test.ts` and `tests/browser/bulk.spec.ts` (tag three by Shift-click and undo; select all, close, and undo with a conflict; per-conversation failures and an expired undo refused). 42/42 Node tests, typecheck and 27/27 browser tests pass. Flags remain off.

## Unreleased — agent inbox step D2 (context sidebar and app slot)

- A conversation details sidebar showing:
  - the customer, resolved through contact merges: name, emails, phones and external id for teammates with personal-data access, and type, times, time zone and live local time for everyone
  - conversation attributes, editable inline by type through the existing typed command, reverting on rejection
  - up to five of the customer's other recent conversations, across their merged contacts
  - participants
- New route: `GET /v1/agent/context`. No migration.
- The sidebar is open by default on wide screens and toggled with I, "Details" or the palette; the choice is remembered in the browser as a UI preference only.
- The phase-15 app-slot contract (`lib/app-slots.ts`): versioned types, a scoped context, declared capabilities, loading/error/ready states, and a host that refuses undeclared capabilities and other conversations. No app code is loaded, and no cards appear until phase 15.
- Local seed adds three conversation attributes. In development, a customer with an email and two earlier conversations.
- Tests: `tests/context.test.ts` (merges, personal-data gating, same-customer history, attributes, workspaces, app-slot host) and `tests/browser/sidebar.spec.ts` (details, local time, inline attribute save, history navigation, the toggle remembered; an invalid value reverted). 41/41 Node tests, typecheck and 24/24 browser tests pass. Flags remain off.

## Unreleased — agent inbox step D1 (macros)

- Personal and shared macros: a saved reply or note, with variables, plus up to 10 actions (assign, add or remove a tag, priority, snooze preset, close, reopen, set an attribute). Migration 0020 adds the `macros` table.
- Permissions: `macros.use` lets a teammate apply macros and manage their own personal ones. `macros.create`, `macros.edit` and `macros.delete` govern shared macros and are granted only to roles already holding `macros.manage`.
- Variables (customer name, first name and email, conversation title, your name, brand name) are filled on the server as plain text, with fallbacks when a value is empty or the teammate lacks personal-data access. Variables are refused anywhere but a macro body.
- Applying (M, or "Apply macro: …" in the command palette) validates the whole bundle, then runs every action in one transaction as the applying teammate, with their own permissions: any failure rolls back everything. It is idempotent and publishes only after commit. The filled text goes to the composer for review. Ticket actions are rejected whole until phase 5.
- The macro manager edits the name, mode, sharing, rich text with a variable picker, and actions, with version conflicts.
- Fixed keyboard traps found by the browser tests: "Insert variable" kept focus, so a space re-inserted it; and Escape could not close the manager after saving.
- Local seed adds two sample macros per workspace.
- Tests: `tests/macros.test.ts`, variable cases in `tests/rich-doc.test.ts`, and `tests/browser/macros.spec.ts` (create, apply and send; a macro with a removed assignee refused whole). 39/39 Node tests, typecheck and 22/22 browser tests pass. Flags remain off.

## Unreleased — agent inbox step C3b (viewing and writing indicators)

- One routing table for live signals, `fanOutSignal`, now used by both the Worker and the local relay, which previously disagreed.
  - Viewing and a teammate's note typing reach teammates only, never customers.
  - A teammate's reply typing still shows "Someone is typing…" to the customer.
  - Presence reaches teammates only; signals never echo to the sender or cross workspaces.
  - Teammate typing without `mode: "reply"` is treated as a note.
- Viewing: joins are announced both ways, a newcomer learns who is already there, the inbox refreshes every 30 seconds and entries expire after 45, and leaving or a closed socket is announced at once.
- Writing: the composer sends "writing a note" or "writing a reply" at most every 2 seconds, and stops after 4 idle seconds, on send, on a mode switch and on leaving.
- The conversation header shows who is viewing or writing (for example "Grace is writing a note"), and warns "Grace is also replying" while you are in reply mode.
- Fixed: a stop signal used up the 200ms typing throttle, so the next mode's signal after a mode switch was dropped. Only active typing is throttled now.
- Tests: `tests/signals.test.ts` (the whole routing table, joins, refreshes, departures and the throttle regression) and `tests/browser/collision.spec.ts` (two teammates and a customer; departure clears indicators). 37/37 Node tests, typecheck and 20/20 browser tests pass. No migration. Flags remain off.

## Unreleased — agent inbox step C3a (mentions and notifications)

- Notes can @-mention teammates and teams through a keyboard picker in the composer. Mentions are refused in customer replies (`MENTION_IN_REPLY`). The server checks each mention against the directory (`MENTION_NOT_FOUND`), rewrites its label from the directory and derives the plain text as `@Name`.
- Teams expand to their members at send time. Duplicates are removed, and the author is never notified, even through a team. An edited note notifies only newly mentioned people.
- In-app notifications (migration 0019): a bell with a live unread count pushed over the socket, and a panel with who, where and a 140-character excerpt. Opening one goes to the conversation and marks it read; "Mark all as read" and a palette command are also there. Notifications are only ever read with the signed-in teammate's id.
- A Mentions default view for every teammate, through a new `mentioned` filter. Teammates set up earlier get it automatically.
- Local development seeds a second teammate, Grace, in Billing, and a loopback-only `/agent?as=grace` sign-in.
- Tests: `tests/mentions.test.ts`, mention cases in `tests/rich-doc.test.ts`, and `tests/browser/mentions.spec.ts` (live notification between two teammates; a removed teammate's mention refused with the note kept). The views test now expects six default views. 36/36 Node tests, typecheck and 18/18 browser tests pass. One full browser run logged two unexplained server errors that did not recur in five further runs. Flags remain off.

## Unreleased — agent inbox step C2b (inline images)

- Teammates can place PNG and JPEG images (up to 10 MB each, 10 per message) inside replies and notes by button, paste or drag-and-drop. Inline uploads use the existing prepare, upload, byte-check and scan flow but never become separate attachment messages (migration 0018 adds `attachments.purpose` and `conversation_part_images`). The image node holds an attachment id, never a URL.
- At send, each image must be the sender's own clean inline upload in this conversation, and a reply may only use customer-visible uploads. Each failure has its own error: `IMAGE_NOT_FOUND`, `IMAGE_NOT_READY`, `IMAGE_BLOCKED` or `IMAGE_AUDIENCE`. The composer shows uploading, checking, blocked and clean states, and keeps Send disabled until every image is clean.
- Customers can fetch an inline image only once a sent public reply references it, through the messenger's short-lived links. Note images never reach them; the tests cover downloads, history and live replay.
- Unreferenced inline uploads are deleted after 30 days, from storage (R2 `deleteClean`) and the database.
- Local development and browser tests use a new loopback storage adapter, never deployed; its scanner flags the EICAR test file. The local relay now accepts binary uploads.
- Tests: `tests/inline-images.test.ts`, image cases in `tests/rich-doc.test.ts`, and `tests/browser/inline-images.spec.ts` (image decoded in inbox and messenger; blocked image gates Send). 34/34 Node tests, typecheck and 16/16 browser tests pass. Flags remain off.

## Unreleased — agent inbox step C2a (rich text and drafts)

- Rich replies, notes and edits use a restricted document format: paragraphs, lists, quotes, code blocks, line breaks, bold, italic, inline code and links. Links must be https, http or mailto; limits are 5,000 characters, four levels of nesting and 2,000 nodes. The server rebuilds each document from allowed content only, stores it as `data.doc` and derives the plain-text `body` used by search and future plain channels. Customers cannot send documents.
- Documents render as React elements, never as HTML, in the inbox and in the customer messenger (the frame grows from 67.0 to 68.4 KB gzip). Notes stay private; a test places a secret in a note's text, link and code and checks it never reaches the customer.
- The composer is a TipTap 3.31.3 editor with an accessible formatting toolbar, lazy-loaded (about 130 KB gzip) so the list and timeline load first.
- Drafts are server-backed and visible only to their author (migration 0017). They autosave after 800ms, carry a version so another tab's newer save produces a "Keep mine" / "Use the other version" choice, are sent at once when the page is hidden, are kept in memory while offline, are deleted on send, and are purged after 30 days.
- Fixed while testing: a draft that loaded before the editor mounted was dropped; the editor's trailing empty paragraph counted as an edit; and `jsonb` key order made identical drafts compare unequal.
- Tests: `tests/rich-doc.test.ts`, `tests/drafts.test.ts` and `tests/browser/composer.spec.ts`. 32/32 Node tests, typecheck and 14/14 browser tests pass. Flags remain off.

## Unreleased — agent inbox step C1 (timeline and fast actions)

- The timeline gives every system part kind readable text, naming teammates, teams and tags (for example "Ada assigned this to Grace and team Billing" or "Snoozed until Thu 1 Oct, 09:00 BST"), instead of raw kind names. Consecutive system events collapse into an expandable "Show N updates" line. Edited parts are marked.
- Snooze presets (later today, tomorrow 09:00, next Monday 09:00) resolve on the server in the teammate's IANA zone, correctly on daylight-saving days. Custom times need an explicit offset. An optional "unassign when it wakes" flag applies only to the current snooze. Migration 0016 adds `snooze_unassign` and `snooze_timezone`; the rollback keeps them.
- Fixed: snooze versions were compared as strings to PGlite's numbers, so snoozed conversations never woke on the local relay.
- A thread toolbar (close/reopen, snooze, assign to me, priority) with optimistic updates that revert on rejection. Keyboard shortcuts: J/K, R, N, ⌘Enter, Esc, E, Shift E, S, A, P, /, ?, and ⌘K. A command palette covers conversation actions, assignment to any teammate or team, tags and views. Shortcuts are suppressed while typing.
- The inbox snapshot now includes teammates, teams, tags and the `manage` capability. The local seed adds a team and two tags per workspace.
- Tests: `tests/snooze.test.ts`, `tests/timeline.test.ts` and `tests/browser/triage.spec.ts` (keyboard-only triage; rejected snooze). 28/28 Node tests, typecheck and 12/12 browser tests pass. Flags remain off.

## Unreleased — agent inbox step B2 (first screen)

- An inbox conversation now opens on its newest 50 parts instead of replaying its whole history from the oldest part. Older history loads on scroll (100 parts per page) through `GET /v1/agent/history`, with signed per-teammate cursors that a merge invalidates. The live cursor resumes exactly after the first screen, with no gap or repeat. The customer messenger and other agent clients are unchanged.
- The inbox keeps an in-memory cache of 50 conversations, cleared on workspace, teammate or capability change. It prefetches a conversation's first screen after 100ms of hover or focus, one at a time, and keeps the reader's position when older parts load. A failed older page offers Retry.
- Measured locally on an Apple M1 over 10,000 rows, 20 conversations of 500 parts and 10 merged conversations:
  - Warm first screen: p50 9.1ms, **p95 15.6ms** (target: under 150ms).
  - Cold: p50 30.4ms, p95 40.8ms.
  - Scrolling all 9,990 rows: at most 15 rows mounted, no long tasks, frames at 16.7ms.
  - Reproduce with `scripts/measure-first-screen.ts`.
- Fixed in the views list (from step B1): every workspace notification reloaded it from page one, so paging could not get past 200 rows while activity arrived. A stale loading flag and a render-time ref read could also block "Load more". Activity now refreshes only the first page.
- Added `tests/agent-timeline.test.ts` and `tests/browser/agent-timeline.spec.ts`. The views browser test now pages through three pages. A development seed adds a 200-part conversation per workspace. 24/24 Node tests, typecheck and all 6 inbox browser tests pass. No migration. Flags remain off.

## Unreleased — agent inbox step B1 (saved views)

- Views with the same filter now share one conversation list and one count (migration 0015, `inbox_filter_sets`/`inbox_filter_members`). With 200 agents and 10,000 conversations, stored list rows fall from about 2.3 million to 15,000, and projecting 100 changed conversations across 1,005 views takes 101–134ms, down from 6.9s. A view whose filter is already in use is ready at once, with no rebuild.
- List members carry their sort keys, so a view page reads one index range: 5–12ms at 5,000 members, previously 58ms with table statistics and 5.7s without them.
- Counts are maintained by statement-level triggers, one update per list per statement.
- Added a server-side `move` action that renumbers a folder so view positions never collide, and made the UI render views in position order.
- Fixed: saving a view without `shared` or `folderId` un-shared it or removed it from its folder; new views were created at position 0; default views could be made shared; optimistic new views never appeared in the list, and a server refresh during a pending save dropped them.
- Added `tests/inbox-views.test.ts` (filter injection and unavailable filters; tenant, teammate and permission isolation; shared lists; live counts through state changes, merges and snoozes; keyset paging under concurrent inserts; cursor invalidation; search; move; crash-resumed rebuild; exposure rollback) and `tests/browser/inbox-views.spec.ts` (happy path with live counts and full paging; rejected save). Added a two-workspace views seed and `scripts/load-views.ts`.
- All 23 Node tests, typecheck and all 4 agent-inbox/views browser tests pass. The messenger hostile-CSS browser test fails on this branch and on `main`; it is outside this step.
- The "mentions" default view is deferred to step C, which introduces structured mentions. First-screen latency and the 150ms measurement are step B2. Flags remain off.

## Unreleased — agent inbox step 1

- Connected the platform-authenticated inbox to the signed PostgreSQL/Hyperdrive service bridge and WebSocket cursor replay, behind default-off application/workspace flags. Added reply/note optimistic reconciliation and visible storage-source evidence.
- Added migration 0013 for attachment audience/teammate ownership and a database constraint keeping internal notes private. Customer history/replay excludes private notes and files; internal files use authenticated proxy downloads rather than transferable signed GET URLs.
- Preserved the D1 polling UI and added legacy write/seed guards when PostgreSQL has authority. The rollback disables exposure and retains data/privacy; it does not switch writers or reverse-copy data.
- Added two-workspace privacy/isolation and rollback coverage plus browser happy/rejection tests. All 21 Node tests, typecheck, targeted lint, app build and Worker bundle checks pass. Browser tests remain unverified because Chrome launch was blocked by the host; manual browser inspection verified Live/PostgreSQL-local and widget rendering only.
- Recorded approved decisions and local verification in `docs/AGENT_INBOX_PLAN.md` and `docs/AGENT_INBOX_STEP1.md`. Later inbox steps and hosted cutover remain deferred.

## Unreleased — local conversation and messenger foundation

- Added additive PostgreSQL schemas, tenant-scoped transactions with forced RLS, retry receipts, D1 copy verification, source write fences and data-preserving rollback scripts.
- Added minimum brand/people/permission prerequisites, signed identities with two-key rotation, non-destructive contact merge audit and conflict-aware reversal.
- Added immutable typed conversation parts, lifecycle cycles, assignments, participants, merge aliases, superseding edits, typed attributes, search and versioned business-time metrics.
- Added authenticated cursor-based WebSocket replay, ephemeral signals, materialized counters, transactional publication intent, batched fanout and persistent job status.
- Added native Cloudflare Queue/Cron/DO handlers and private R2 upload/scan/preview adapters; no resources were provisioned or deployed.
- Added a lazy iframe messenger, small shadow-root loader, strict-CSP hostile-host demo, RTL/locales, keyboard support, upload/job UI and notification options.
- Added local SQL/HTTP/browser tests, a reproducible load harness, integration documentation and an interface-only mobile SDK specification.
- Fixed verified-contact unread totals across identity merges/reversals and conversation aliases while retaining device-scoped anonymous access. Added additive migration 0011, a resumable backfill job and exposure rollback.
- Fixed live delivery and superseding edits through repeated conversation aliases; persisted local data/keys now survive restart during the 60-second reconnect test.
- Added Hyperdrive runtime-role checks, local job/outbox repair, pushed job completion, localized launcher/notification labels, and explicit route allowlisting.
- Added migration 0012's conversation-scoped unread index and a data-preserving rollback. Consolidated customer command and agent replay authorization transactions; successful immediate fanout now acknowledges its captured outbox entries while preserving failure recovery and later commits.
- Added local connection-wait/transaction profiling, an indexed query plan, and regressions for revoked sessions, disabled flags, wrong origins and outbox acknowledgement races. The isolated 200-agent/5,000-conversation/50-message-per-second rerun reduced server-processing p95 from 720ms to 149ms; delivery p50/p99 is 68/1,082ms. All 3,000 messages rendered without duplicates; hosted/cold-cache acceptance remains unverified.
- Deferred messenger bootstrap to a separate task after the host load event. The host-load check first failed at 63.7ms p95, then measured 29.3ms after the fix; zero layout shift, with resource-timing assertions that bootstrap starts after load completes. The loader is 4,282 bytes gzip.
- Production flags remain off. The D1 app remains the default; the subsequent step-1 change adds explicit write-authority guards. Hosted migration/integration acceptance and the full people/events/segments phase remain incomplete; see `docs/LOCAL_READINESS.md`.
