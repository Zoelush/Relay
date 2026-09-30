# Changelog

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
