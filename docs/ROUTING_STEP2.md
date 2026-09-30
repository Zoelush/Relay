# Routing — step B handoff (away mode and workload in the inbox)

Step B is the second step of phase 06 in `docs/ROUTING_PLAN.md`. The A handoff (engine and simulation) is `docs/ROUTING_STEP1.md`. Step C, queue position and one office-hours source, is next.

Decisions approved on 1 October 2026:

- **Returning conversations on away:** a per-team setting, off by default.
- **Away and reassign replies:** a customer reply hands the conversation back to its team inbox, or leaves it unassigned without a team.
- **Paced return:** 3 per rolling 5 minutes, for 30 minutes.
- **"Next conversation" at your limit:** refused with the reason.

## 1. What changed

**Migration 0028 (`db/postgres/0028_away_workload.sql`):**

- teammates gain `presence_changed_at` and `returned_at`
- teams gain `unassign_on_away` and `view_id`

The rollback is `SELECT 1`; the previous version ignores the columns.

**Away mode (`server/routing.ts`, `POST /v1/agent/presence`):**

- **Setting a status:** set your own presence (Active, Away, or Away and reassign replies), or anyone's with `teammates.manage`.
- **Going away:** for each automatic team with "When a member goes away, return their open conversations to this inbox" switched on, their open conversations in that team are released to its inbox, recorded with reason `away`, and routed on.
- **Away and reassign replies:** a customer's reply (not a teammate's note) on that teammate's conversation releases it with reason `away_reassign`. It then goes back to its team inbox and is routed, or stays unassigned without a team.
- **Returning:** records `returned_at` and drains the teammate's queues. For 30 minutes, the engine's pure decision holds them to 3 automatic assignments per rolling 5 minutes (`RAMP`), and anything they can't take goes to others as usual.
  - Pacing is a per-member `rampLeft` fed into `decide`, so it stays deterministic.
  - The clock is injectable through `loadTeam` and `drainTeam`.
  - Pacing counts routed assignments (reasons `balanced` or `round_robin`) since the return.

**"Next conversation" (`POST /v1/agent/next`):**

- **What it takes:** the first waiting item across your balanced team inboxes (priority, then soonest SLA due, then longest waiting), claimed atomically. If someone else took it first, it tries the next.
- **What gets recorded:** the assignment reason is `next`.
- **Refusals:** "You're at your limit (5 of 5). Close or snooze something first." (`NEXT_AT_LIMIT`), or "Nothing is waiting in your team inboxes." (`NEXT_NONE`).
- **Pacing:** pulling ignores the ramp-up, since it's the teammate choosing more work, but respects their limit.

**Workload (`GET /v1/agent/workload`):** your presence and your load against your limit (conversations and tickets), and your teams. Each team shows its method, inbox load against its limit, the waiting count, and each member's name, status and load against their limit.

**Team inboxes.** Saving a team (with saved views enabled) creates or renames a shared view, "Team inbox: Billing", filtered to that team's open conversations.

**UI (`agent/workload.tsx`):**

- **The inbox header** has a status menu, "Workload 3 / 5" (opens the Workload panel), and a "Next conversation" button (also `Shift+N` and the palette; `N` stays "Internal note"). A refusal is shown inline.
- **The Workload panel** shows each of your teams, and each method explained plainly:
  - **Round robin:** "Takes turns in order. It ignores how busy anyone is and does not respect assignment limits."
  - **Balanced:** "…only within the teammate's and inbox's limits. The rest waits here until someone has room."
- **Managers** can edit a team: method (with those explanations), inbox and ticket limits, whether tickets count, whether round robin includes away teammates, and the return-on-away option.
- **Bundle:** the agent bundle grows by 2 KB gzip (239 to 241 KB).

**Seed data.** The local relay turns `routing_v1` on (`routing: false` turns it off). Billing becomes a balanced inbox with a limit of 20, with the owner (limit 5) and Grace (limit 3) as members.

## 2. Files

| File | Change |
|---|---|
| `db/postgres/0028_away_workload.sql`, `db/rollback/0028_away_workload.sql` | Presence times, team options |
| `server/routing.ts` | Pacing, presence, release and hand-off, next conversation, workload, team inbox views, member names |
| `server/conversations.ts` | Customer replies hand off from away-reassigning teammates |
| `server/api.ts`, `server/agent-bridge.ts` | Routes and bridge |
| `agent/workload.tsx`, `agent/commands.tsx`, `agent/inbox.css`, `components/relay/postgres-inbox.tsx` | UI, `Shift+N`, palette |
| `scripts/local-relay.ts` | Local routing seed |
| `tests/away-workload.test.ts`, `tests/browser/workload.spec.ts` | Coverage below |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 1 October 2026:

- **Node:** 61/61 pass. `tests/away-workload.test.ts` covers:
  - **Team inbox view:** created and renamed with the team.
  - **Presence rules:** setting another's needs `teammates.manage`; an invalid status is refused.
  - **Going away:** releases the teammate's two open conversations with reason `away`, and they wait because everyone else is full.
  - **Away and reassign replies:** a teammate's note doesn't hand a conversation on; a customer's reply does, recorded once.
  - **Paced return:** returning with room for 10 takes 3; a drain inside the window takes none; 3 more in the next window; the rest after 30 minutes; the queue empties.
  - **"Next conversation":** refused at the limit with the exact message; manual inboxes aren't pulled from; the priority item comes first, then the next; nothing left gives `NEXT_NONE`; reason `next` recorded.
  - **Workload:** used against limit, only your teams, members' names and limits.
  - **Other workspaces:** no teams, and presence can't reach across (404).
- **Typecheck and lint:** clean on the new and changed files.
- **Browser:** 38/38 pass. All 36 earlier tests still pass with routing on locally. `tests/browser/workload.spec.ts` passed 4 out of 4 on repeat:
  - **Happy path:** "Workload 0 / 5". Going away, then six conversations reach Billing. The panel shows "Balanced." with its explanation and "6 waiting", and the settings form's round-robin explanation. Returning shows "Workload 3 / 5", so pacing held against the local relay's sweep, which runs every second. "Next conversation" opens "Queue 4" and shows "Workload 4 / 5".
  - **Failure path:** `Shift+N` takes the fifth, then is refused with "You're at your limit (5 of 5). Close or snooze something first."; nothing more is assigned, and one conversation still waits.
- **One unexplained server error was logged once.** One full browser run logged "Relay API failed { type: 'Error' }" while all tests passed. Three further full runs didn't reproduce it. The server logs only the error type, never its message, so the cause is unknown; it's recorded here like the similar one-off in phase 04's C3a.

## 4. Deferred and known gaps

- **Team inbox views** are created when a team is saved through the API with saved views on. The local seed's Billing team has none until it's saved.
- **Pacing counts only routed assignments;** "Next conversation" pulls don't count toward it, by design.
- **Other teams' capacity:** the Workload panel shows only your own teams. A workspace-wide capacity view for managers could follow.
- **Step C:** queue position in the messenger, and one office-hours source.
- **Still open:**
  - a new teammate's first list stays empty until the page reloads (phase 04)
  - first-screen timing not re-measured with SLAs on (phase 05)
  - parallel-claim testing against real PostgreSQL (step A)
