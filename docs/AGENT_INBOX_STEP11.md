# Agent inbox — step D3 handoff (bulk actions with undo)

Step D3 is the last part of step D in `docs/AGENT_INBOX_PLAN.md`, and completes phase 04's plan. The D2 handoff (context sidebar) is `docs/AGENT_INBOX_STEP10.md`.

## 1. What changed

**Migration 0021 (`db/postgres/0021_bulk_operations.sql`).** Two new tables, both with workspace row-level security:

- `bulk_operations`: the action, the teammate, the server's count (1 to 5,000), status (`prepared`, `running`, `done`, `undoing`, `undone`), commit and undo times, and job ids.
- `bulk_items`: one row per conversation with its position, state (`pending`, `applied`, `failed`, `cancelled`, `undone`, `conflict`), and the fields before and after.

The rollback is `SELECT 1`. The tables stay, and a queued bulk job on the previous version has no handler, so it ends in the dead-letter queue.

**Service (`server/bulk.ts`) and route (`POST` and `GET /v1/agent/bulk`, bridged).**

- **Prepare** (`op: "prepare"`) takes an action and either picked `conversationIds` or a `viewId` ("everything in this view").
  - **Allowed actions:** assign, add or remove a tag, priority, snooze preset, close and reopen. They are validated by the macro rules. Setting an attribute is refused (`INVALID_BULK`), and ticket state gets `TICKETS_UNAVAILABLE`.
  - **The count is the server's.** It resolves the selection within the workspace, ignoring unknown, merged and other-workspace ids, and stores it as a snapshot.
  - **Refusals:** more than 5,000 conversations gets `BULK_TOO_LARGE`, and nothing left to act on gets `BULK_EMPTY`.
- **Commit** (`op: "commit"`) is idempotent on the key.
  - It works only for the teammate who prepared the operation, and only within 10 minutes of preparing.
  - It sets `undo_until` to 10 seconds from commit (server time) and queues `bulk.apply`.
- **Apply job:** 25 conversations per step.
  - Each goes through the ordinary `command` as the preparing teammate, so their permissions, timeline events and realtime all apply.
  - Each runs in its own savepoint, so a failure is recorded against that conversation with its reason and the rest continue.
  - Idempotency keys per item mean a retried step applies nothing twice.
- **Undo** (`op: "undo"`) is refused with `UNDO_EXPIRED` once the window has passed.
  - Conversations not yet reached are marked `cancelled`, and `bulk.undo` is queued.
  - For each applied conversation, the undo job runs a reversing command only if the changed field still holds exactly what the bulk action set (for close, reopen and snooze, the status and wake time). Otherwise the conversation is left alone as a `conflict`.
  - Undo restores what was there before: the previous assignee or team, priority, or tag presence. A tag the conversation already had is kept. For status, a snooze is restored with its original wake time and "unassign on wake" setting if that time is still ahead; otherwise the conversation reopens.
- **Status** (`GET bulk?id=`) returns the status, counts by state, milliseconds of undo left (computed by the server), and up to 20 conflicting conversations.
- **Request size:** this route alone accepts bodies up to 256 KB, so 5,000 picked ids fit. Other routes keep 20 KB.

**Jobs.** `bulk.apply` and `bulk.undo` are registered in `workers/relay.ts` and `scripts/local-relay.ts`.

**UI (`agent/bulk.tsx`, `agent/views.tsx`).**

- **Selecting:** each row has a checkbox, and Shift-click checks a range. X checks the open conversation's row, and is listed on the shortcut sheet. "Select all N in this view" is offered when nothing is searched. The selection belongs to one view, sort and search, and changing any of them drops it.
- **The bulk bar** offers Close, Reopen, Assign, Add tag, Remove tag, Priority, Snooze and Clear selection.
- **Confirming:** the confirmation shows the server's count ("Close 42 conversations?").
- **Progress** follows pushed job frames (`relay:job`), each followed by one status read; there is no polling. It shows "N of M done", then the result, with failures counted.
- **Undo** shows a live countdown ("Undo (7s)") from the server's remaining time. The result lists how many were restored, how many were changed since and left alone (with their titles), and how many were never reached.
- **Bundle:** the agent bundle grows by 2 KB gzip (231 to 233 KB).

**Flags.** Bulk actions appear only in the saved-views list, so they sit behind both `RELAY_AGENT_INBOX_V1` and the inbox-views flag, which default to off.

## 2. Files

| File | Change |
|---|---|
| `db/postgres/0021_bulk_operations.sql`, `db/rollback/0021_bulk_operations.sql` | Tables and rollback |
| `server/bulk.ts`, `server/macros.ts` (exports `checkTargets`) | Service |
| `server/api.ts`, `server/agent-bridge.ts` | Route, bridge access, 256 KB limit for this route |
| `workers/relay.ts`, `scripts/local-relay.ts` | Job handlers |
| `agent/bulk.tsx`, `agent/views.tsx`, `agent/inbox.css`, `agent/commands.tsx`, `components/relay/postgres-inbox.tsx` | Selection, bar, X shortcut, job events |
| `tests/bulk.test.ts`, `tests/browser/bulk.spec.ts` | Coverage below |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 30 September 2026:

- **Node:** 42/42 pass. `tests/bulk.test.ts` covers:
  - **Validation:** attribute and ticket actions refused, and over 5,000 refused.
  - **Workspaces:** another workspace's ids are not counted; another workspace and another teammate get 404 on status and commit.
  - **Commit:** a server count of 3 from 6 submitted ids; a repeated commit key returns the same job and a new commit is refused; the undo deadline is 10 seconds out; the timeline records the command.
  - **Undo after tagging:** a conversation whose tag was removed since is left alone as a conflict, and a tag that was there before is kept.
  - **Undo mid-run:** 30 conversations closed, 25 per step. Undo after the first step cancels 5, and a conversation reopened since is left alone.
  - **Expired undo:** refused with nothing changed.
  - **Per-item failures:** a role without `conversations.assign` gets two recorded failures, and the operation still completes.
- **Typecheck:** clean. Lint on the changed files shows only the two findings in `agent/views.tsx` that predate this step.
- **Browser:** 27/27 pass. `tests/browser/bulk.spec.ts`:
  - **Happy path:** Shift-click selects three rows; "Add tag VIP" is confirmed at the server's count of 3, applied, and undone within 10 seconds.
  - **Select all and conflicts:** X checks the open row; "Select all in this view" closes every open conversation at the server's count. One conversation is snoozed by Grace before Undo, so it is reported as "changed since and left alone" and keeps her snooze; the rest reopen.
  - **Failure path:** Grace, whose role cannot assign, sees "2 conversations could not be changed". An undo after the window is refused with the server's message, and priority stays set.

## 4. Deferred and known gaps

- **A new teammate's first list stays empty.** On a teammate's first visit, their views are still being built. The first page is fetched before that finishes and is not fetched again once the counts are ready, so the list stays empty until something changes or the page reloads. This predates D3 (step B). The Grace browser test waits for the counts and reloads.
- **Setting an attribute in bulk** is not offered. It needs a value editor in the bar, and conflict rules per attribute type.
- **Bulk selection needs the saved-views list.** The older recent-conversations list has none.
- **Nothing cleans up prepared-but-uncommitted operations.** They expire for commit after 10 minutes and are harmless, but the rows stay.
- **Snooze undo in the Worker:** a restored snooze wakes through the existing sweep, which picks up any snooze due within a minute, rather than a new Durable Object alarm.
- **Next:** phase 04's plan (steps A–D) is complete locally; see `docs/STATUS.md` for what remains before hosting.
