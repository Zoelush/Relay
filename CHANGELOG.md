# Changelog

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
