# Maintenance — open items from phases 04–06 (October 2026)

Branch `maintenance/open-items`, one commit per item. Approved on 1 October 2026:

- run the concurrency test on embedded PostgreSQL as a dev dependency
- add safe diagnostic detail to unexpected-error logs
- use one branch for all four items

## 1. A new teammate's first list looked empty (phase 04)

**Cause, found by tracing the page:** on a teammate's first visit, their first request for views ran before their default views were created. The only views it returned were the shared ones, so "Open priority (shared)" was selected, and it stayed selected after "All open" appeared.

The list was showing that view correctly, and it happened to be empty. The note in `docs/AGENT_INBOX_STEP11.md` (that the first page was never fetched again) was a wrong diagnosis: the page *was* fetched again, for the wrong view.

**Fix (`agent/views.tsx`):** an automatic selection moves to "All open" once it exists. A teammate's own choice (clicking a view, the palette, or saving a view) is never overridden.

**Test:** the phase 04 D3 bulk test now opens Grace's first visit with no reload. It passes with the fix and fails without it.

**Also seen while tracing:** the views list re-reads about once a second for the first few seconds of a first visit. That isn't polling: it's the first-visit view rebuild, which the local relay runs one step per second, pushing an update after each step. The Worker runs the steps back to back.

## 2. Speed with SLAs and routing on (phases 05–06)

On the same machine and fixture as `docs/AGENT_INBOX_STEP3.md` (Apple M1 with 8 GB, headless Chromium, embedded PGlite, 10,000 open conversations), with SLAs and routing on (the local default):

| First screen | p50 | p95 | p99 |
|---|---|---|---|
| Warm (before: 15.6 ms p95) | 11.8 ms | **16.6 ms** | 17.2 ms |
| Cold (before: 40.8 ms p95) | 32.1 ms | 38.7 ms | 74.2 ms |

Both are within run-to-run noise of the phase 04 figures, and far under the 150 ms budget. Reads aren't affected by SLAs or routing.

The real concern was commands: every change now recalculates SLA clocks and may route, inside the same transaction. `scripts/measure-commands.ts` times 200 conversations each started, put in Billing (balanced), replied to and closed, measured around each transaction on the server:

| Command, p95 | SLAs and routing off | On |
|---|---|---|
| Start a conversation | 9.3 ms | 15.0 ms |
| Assign to a team (routing and SLA) | 6.0 ms | 18.2 ms |
| Reply | 11.1 ms | 14.6 ms |
| Close | 6.3 ms | 10.9 ms |

That's 3–12 ms extra per command, and p99 stays under 21 ms, far below the project's 200 ms threshold for moving work to a background job. No optimisation is needed. These are embedded-database figures, not hosted ones.

## 3. Assignment under real concurrency (phase 06)

`npm run test:postgres` (`tests/postgres/concurrency.test.ts`) starts a throwaway **PostgreSQL 17.10** server through the `embedded-postgres` dev dependency (pinned to 17.10.0-beta.17; about 133 MB in `node_modules`; nothing installed system-wide). It applies every migration as the owner, creates a separate runtime role that cannot bypass row-level security, and connects through `pg` and `hyperdriveConnection`, the production path, including its role check. Each tenant transaction gets its own connection, so they genuinely run in parallel.

- **Racing claims:** 200 races of two simultaneous claims on one conversation. Exactly one wins every time, with exactly one assignment record each.
- **The last slot:** 200 rounds of two connections draining one inbox at once, when Ada has one free slot. She ends every round with exactly one.
- **Shared members:** 200 rounds of four parallel drains across two teams sharing both members (limit 3). No deadlock, no error, no limit exceeded.

It runs separately from `npm test` (about 55 seconds) so everyday runs don't start a server.

**One environment finding.** At first about half the runs failed with a single "timeout expired" while connecting. Instrumenting showed no slow queries and no slow successful connections: one connection attempt simply stalled for the full 5-second timeout. Connecting to `127.0.0.1` instead of `localhost` removed it entirely (0 errors in 2,400 parallel drains, and faster). On macOS, resolving `localhost` to IPv6 first occasionally stalls the attempt. Production connects through Hyperdrive's own address, so application code is unaffected.

**Install note.** npm blocked the binary package's `postinstall` script (it recreates symbolic links between libraries). PostgreSQL starts and passes without it, so it wasn't approved.

## 4. The one-off "Relay API failed" log (phase 06 B, and a similar one in phase 04 C3a)

**Diagnostics:** unexpected errors used to log only "Error". They now log `errorFingerprint(error)`: the error class, a PostgreSQL SQLSTATE code if present (for example `40P01` for a deadlock), and the repository-relative file and line where the error was thrown. They still never log the message or request data, which can contain customer details. `tests/error-fingerprint.test.ts` checks a message containing an email is never included, only five-character SQLSTATE codes pass, and no absolute paths appear.

**The hunt.** I ran the full browser suite 5 times with the new diagnostics, and "Relay API failed" didn't appear in any run (nor in the final full run). Its cause is still unknown, but the next occurrence will now name its class, SQLSTATE code and source line.

**A different bug found during the hunt.** Run 3 failed one of phase 04's timeline tests (scroll-back): the "Older messages could not be loaded." alert never appeared, because no older page was ever requested. Tracing it showed a real bug, not just a test problem.
- **The bug:** every timeline update scrolled to the newest message unconditionally. So a live update, even the replay after subscribing with nothing new in it, pulled a teammate reading older history back to the bottom.
- **Why the test failed intermittently:** when the update landed just after the test scrolled to the top, the browser delivered a single scroll event at the bottom, so older history never loaded.
- **Fix (`components/relay/postgres-inbox.tsx`):** the timeline follows the newest message only when a conversation is opened, after the teammate sends, or when they were already within 80 px of the bottom. Otherwise it keeps their place.
- **New test:** a reply arriving while reading keeps your place, and at the newest message it's followed. It fails without the fix.
- **Repeat runs:** the timeline spec passed 30 out of 30 with the fix.

Before this, that spec failed about 1 run in 20 to 30. A run of 20 with the old code happened to pass, which shows how rarely it showed up.

## Checks

Results on 1 October 2026:

- `npm test`: 64/64 pass.
- `npm run typecheck`: clean. Lint on the changed files shows only the two older findings in `agent/views.tsx`.
- `npm run test:e2e`: 41/41 pass, with no "Relay API failed" logged.
- `npm run test:postgres`: passed 3 out of 3 after the `127.0.0.1` change (about 55 seconds each).
- `node --import tsx scripts/measure-first-screen.ts` and `node --import tsx scripts/measure-commands.ts`: figures above.
