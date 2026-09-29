# Agent inbox — step B1 handoff (saved views)

Step B of `docs/AGENT_INBOX_PLAN.md` was split into two parts. **B1** (this document) finishes saved views, live counts and paging. **B2** covers the fast first screen: loading the recent part of a conversation first, loading older history on scroll back, a warm cache, and the 150ms measurement.

## 1. What changed and why

Step B's view code already existed but had no tests. Measuring it with 200 agents and 10,000 conversations showed three problems:

| Problem | Measured before | After |
|---|---|---|
| A view page joined and sorted every member | 58ms with table statistics; 5.7–7s without | 5–12ms |
| Every teammate's default views stored their own member list | ~2.3M rows; 400 row writes plus 400 count updates to close one conversation | 15,000 rows; a few writes |
| Projecting 100 changed conversations across 1,005 views | 6.9s in one transaction | 101–134ms |

**Shared filter sets (migration 0015).** A set is one distinct filter. Its id is the SHA-256 of the normalized `jsonb` text, computed in SQL. Views reference a set through `inbox_views.set_id`. Members (`inbox_filter_members`) and counts (`inbox_filter_sets.match_count`) belong to the set. Everyone's "All open" shares one set; each "Mine" set is separate because its filter names the teammate.

- A saved view whose filter another active view already uses is ready immediately, with no job.
- Projection skips sets no active view uses. Attaching an unused set marks it not ready and rebuilds it, so it is never served stale.
- A set's filter never changes, so a rebuild checkpoint stays valid across retries.

**Sort keys on members.** `created_at` and `waiting_at` (last contact reply, or creation) are stored on each member and indexed per set. Pages use keyset cursors over `(key, conversation_id)`, with the key encoded as UTC text to microsecond precision. Cursors are bound to the view, sort, search text and view revision.

**Counts.** Statement-level triggers with transition tables update each set once per statement.

**Ordering.** `move` (`up`/`down`) renumbers the views the teammate may edit in that folder, so positions never collide. Position is display order only, so moving a view leaves its revision and cursors unchanged.

## 2. Files

| File | Change |
|---|---|
| `db/postgres/0015_inbox_filter_sets.sql` | Sets, members, `inbox_views.set_id`, indexes, count triggers, RLS, and a backfill of sets from existing views. `inbox_view_memberships` and `inbox_views.match_count`/`ready` are retained and no longer written. |
| `db/rollback/0015_inbox_filter_sets.sql` | Exposure rollback: views flag off for the workspace; all data is kept. |
| `server/inbox-views.ts` | Set attachment, batched set projection, set rebuilds, keyset pages over members, `move`, position defaults, and omitted fields keep their values on save. |
| `agent/views.tsx` | Move buttons use `move`; views render in position order; optimistic new views are placed and survive refreshes. |
| `scripts/local-relay.ts` | With `inboxViews: true`, seeds the owner's default views and one shared view in both workspaces. |
| `scripts/load-views.ts` | Reproducible load harness (below). |
| `tests/inbox-views.test.ts`, `tests/browser/inbox-views.spec.ts` | Unit and end-to-end coverage. |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e -- tests/browser/agent-inbox.spec.ts tests/browser/inbox-views.spec.ts
node --import tsx scripts/load-views.ts 200 10000
```

`test:e2e` builds the messenger and agent bundles first. Running `npx playwright test` on its own serves a page without its bundle. Chromium must be installed once with `npx playwright install chromium`.

Results on 29 September 2026 (Apple Silicon, embedded PGlite):

- **Node:** 23/23 pass.
- **Typecheck:** clean.
- **Browser:** agent inbox 2/2 and views 2/2 pass, each views test in three consecutive runs. The messenger test "hostile CSS and strict CSP" fails on this branch and identically on `main`; the other three messenger tests pass.
- **Load harness, 200 agents / 10,000 conversations:**
  - 1,005 views over 205 sets and 15,000 members.
  - Projecting 100 changed conversations: 101–134ms.
  - View page: 5–12ms.
  - Rebuild steps: p50 5ms, p95 9ms, p99 17ms, max 117ms.
  - One earlier run had a single 462ms step; it did not repeat in later runs.
  - Stored counts match a recount.

PGlite runs PostgreSQL in WebAssembly inside Node. These are local figures, not hosted measurements.

## 4. Deferred and known gaps

- **Mentions default view:** step C. It needs structured mention records on note parts (TODO in `seedInboxViews`).
- **First screen, backwards history paging, warm cache and the 150ms measurement:** step B2.
- **Contact, company and SLA filters** are rejected as `FILTER_UNAVAILABLE` until their phases exist.
- **Shared views and folders** require `workspace.manage`; there is no separate share permission (confirmed decision).
- **Lint:** `agent/views.tsx` has three pre-existing lint findings that are unchanged here. One is a real bug: "Load more" reads `loading.current` during render, so its disabled state does not update.
- **Unused-set cleanup:** sets no view uses are kept and skipped. No cleanup job exists yet.

## 5. Deployment and rollback (not executed)

- **Migrate:** on a configured database, run `scripts/postgres-migrate.ts up --through 0015_inbox_filter_sets.sql`.
- **Enable:** views stay off until `workspace_features.agent_inbox_views_v1` is enabled for a workspace.
- **Roll back one workspace:** run `db/rollback/0015_inbox_filter_sets.sql` inside that workspace's tenant transaction.
- **If the application is also rolled back to a pre-0015 version:** that version reads `inbox_view_memberships`, which this version no longer maintains. Save or rebuild its views before re-enabling them there.
