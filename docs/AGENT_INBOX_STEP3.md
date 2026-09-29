# Agent inbox — step B2 handoff (first screen)

Step B2 completes step B of `docs/AGENT_INBOX_PLAN.md`: a conversation opens on its newest parts, older history loads on demand, and first-screen latency is measured against the 150ms target. Step B1 (saved views) is in `docs/AGENT_INBOX_STEP2.md`.

## 1. What changed and why

Before this step, subscribing to a conversation replayed its whole history from the oldest part, 200 parts per database round trip, until it caught up. A 2,000-part conversation took 10 rounds before its newest message appeared, and the oldest parts rendered first. There was no way to load older history on demand, and nothing measured selection latency.

**Recent window.** `recentTimeline()` (`server/conversations.ts`) returns:

- the newest 50 parts across the conversation and every conversation merged into it, in timeline order (`created_at`, conversation, `seq`)
- the latest `seq` for each merged member. It reads this first and caps the window at it, so a part committed in between is replayed live rather than lost or repeated.
- per-member `seq` bounds for reading older history

**Older pages.** `olderTimeline()` reads each member backwards from its bound using the existing `parts_timeline` index, then merges them into timeline order. Bounds are per-member `seq` values, not timestamps, so a page never skips or repeats a part, even when two writers' `created_at` and `seq` disagree. No migration is needed.

**Transport:**

- An inbox socket `subscribe` without a cursor now sends the recent window as one `reset` frame, carrying a live cursor and an `older` cursor. With a cursor it keeps the forward catch-up. Other agent clients and the customer messenger are unchanged.
- `GET /v1/agent/history?conversation=&before=` returns 100 older parts.
- Without `before`, the same endpoint returns the first screen, which prefetch uses.
- The `older` cursor is signed and bound to the workspace, teammate, conversation and timeline revision. After a merge it is refused with `CURSOR_INVALID` (409), and the inbox reopens the conversation from its newest parts.

**Inbox (`components/relay/postgres-inbox.tsx`):**

- **Cache.** In memory only, so notes and customer details never reach disk. It holds 50 conversations, evicting the least recently used, and is cleared when the workspace, teammate or capabilities change or access is lost.
- **Reopening.** A cached conversation renders at once and resumes live replay from its cursor.
- **Older history.** Scrolling near the top, or a "Load older messages" button, fetches older parts and keeps the reader's position. A failed page shows "Older messages could not be loaded." with a Retry button.
- **Prefetch.** A row hovered or focused for 100ms has its first screen fetched, one request at a time.
- **Timing.** A `relay:first-screen` performance measure spans from selection to the animation frame after the first screen renders.

## 2. Files

| File | Change |
|---|---|
| `server/conversations.ts` | `recentTimeline`, `olderTimeline`, per-member backward reads |
| `server/api.ts` | Recent-first replay for inbox sessions; `/v1/agent/history` (first screen and older pages); signed `agent-older` cursors |
| `server/agent-bridge.ts` | Allows `history` through the authenticated bridge |
| `components/relay/postgres-inbox.tsx`, `agent/inbox.css` | Cache, older loading, prefetch, timing marks |
| `agent/views.tsx` | Row prefetch, plus the list paging fixes in §3 |
| `scripts/local-relay.ts` | Development seed: one 200-part conversation per workspace (`longTimeline`) |
| `scripts/measure-first-screen.ts` | Acceptance measurement (below) |
| `tests/agent-timeline.test.ts`, `tests/browser/agent-timeline.spec.ts` | Unit and end-to-end coverage |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e -- tests/browser/agent-inbox.spec.ts tests/browser/inbox-views.spec.ts tests/browser/agent-timeline.spec.ts
npm run messenger:build && npm run agent:build && node --import tsx scripts/measure-first-screen.ts
```

`test:e2e` builds the messenger and agent bundles first.

Results on 29 September 2026:

- **Node:** 24/24 pass.
- **Typecheck:** clean.
- **Browser:** agent inbox 2/2, views 2/2 and timeline 2/2 pass.

**Acceptance measurement.** Environment: Apple M1 with 8 cores and 8 GB, macOS (Darwin 24.6), headless Chromium 153, and the local relay on embedded PGlite. The fixture has 10,000 open conversations. Of the 100 conversations selected, 20 have 500 parts each and 10 have another conversation merged into them. Half the selections are made by click and half by keyboard.

| First screen (selection → frame after render) | n | p50 | p95 | p99 | max | cache hits |
|---|---|---|---|---|---|---|
| Warm (each conversation opened before) | 100 | 9.1 ms | **15.6 ms** | 16.8 ms | 16.8 ms | 100% |
| Cold (fresh page, empty cache, no prefetch) | 100 | 30.4 ms | 40.8 ms | 87.6 ms | 87.6 ms | 0% |

- **Target:** warm p95 under 150ms is met.
- **Cold server time:** the costliest statement was the recent-window query, 277 calls averaging 1.4ms each with a maximum of 7.8ms. Transaction setup (`BEGIN`, tenant `set_config` and `COMMIT`) came next.
- **Stability:** earlier runs gave warm p95 of 14.7–15.1ms and cold p95 of 40.4–45.0ms. Cold p99 ranged from 73ms to 209ms, so the cold tail is noisy on this machine.

| Virtualization: scroll all rows of "All open" | Result |
|---|---|
| Rows loaded | 9,990 (the 10 merged conversations are excluded, as expected) |
| Most rows mounted at once | 15 |
| Long tasks (>50ms) | 0 |
| Frame interval, one screen per frame | p50 16.7 ms, p99 16.8 ms, max 16.8 ms |

These figures are local only and are not hosted measurements.

**List bugs found by the measurement and fixed here (`agent/views.tsx`, from step B1).** The server sends `inbox_changed` to every inbox socket on every notification in the workspace. The views list:

- reloaded from page one on each of these, so in a busy workspace a teammate could not page past the second page
- lost its loading flag when a request from an earlier list generation finished
- read that flag from a ref during render, so "Load more" could stay disabled
- ignored a scroll that arrived mid-load, then never retried

Workspace activity now refreshes only the first page, merged in front of the deeper rows. The loading flag belongs to the latest request and is state. The list continues loading while it is still at the bottom.

The views browser test now pages through 250 rows (three pages) while activity arrives.

## 4. Deferred and known gaps

- **Timeline rendering is not virtualized.** A teammate who scrolls back through thousands of parts mounts all of them. The first screen is bounded at 50.
- **The timing mark starts in the selection handler,** not at the input event's timestamp. Handler delay before `pick` is not included.
- **Hosted and cold-network measurements are not available.** All figures are local.
- **Deep list rows can be stale.** Rows beyond the first page are not re-fetched on activity. A conversation deep in the list that changed state keeps its old row until the list is reset or scrolled to it again, but counts stay exact.
- **Lint.** Two of the three B1 findings in `agent/views.tsx` remain (a scroll reset `setState` inside an effect, and a cleanup ref warning). The ref read during render is fixed.
- **Next step: C** (timeline rendering of all part kinds, composer, mentions, collaboration).
