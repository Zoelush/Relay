# Routing — step A handoff (assignment engine and simulation)

Step A is the first step of phase 06 in `docs/ROUTING_PLAN.md`. Step B, away mode and workload in the inbox, is next.

## 1. What changed

**Migration 0027 (`db/postgres/0027_routing.sql`):**

- **Teams gain:**
  - `method` (`manual`, `round_robin` or `balanced`)
  - `conversation_limit` (the inbox limit) and an optional `ticket_limit`
  - `tickets_count` (whether tickets count toward conversation capacity)
  - `include_away` (round robin only)
  - `rotation_cursor` and `version`
- **Teammates gain** their own `conversation_limit` and `ticket_limit`.
- **Two partial indexes:** a team's queue, and a teammate's open workload.
- **The `routing_v1` flag,** off by default.

The rollback turns the flag off and drops nothing. Waiting conversations stay in their inbox, assignable by hand.

- **Capacity is counted, not stored.** Instead of a separate counter table (as the plan first said), capacity is counted from the conversations themselves while the team's and its members' rows are locked. This gives the same database-level guarantee and can never drift.

**The engine (`server/routing.ts`):**

- **`decide(team, item)` is pure.** Given the team's state, the item (conversation or ticket) and the rotation cursor, it returns an assignee and a reason.
  - **Manual** assigns nothing.
  - **Round robin** goes in member order after the cursor, skipping away teammates unless the team includes them. It ignores limits, as the prompt requires, and the code says so.
  - **Balanced** checks the inbox's limit and ticket limit first, then each active teammate's limits. It picks the fewest active conversations (tickets included if the team counts them), and ties go to the next in rotation.
- **`claim` assigns atomically.** Its `UPDATE` only matches a conversation that is still open, unassigned, not merged and in this team, so a second attempt (a concurrent router, a teammate taking it) changes nothing and returns false. The records match a manual assignment: an internal "joined" event and an assignment change marked with the reason, then unread counts and SLA clocks are updated.
- **`drainTeam` works the queue.** It locks the team and its members in id order (so teams sharing members can't deadlock), then assigns waiting conversations: highest priority, then soonest SLA due, then longest waiting. Items that can't be placed stay queued, and the next rotation cursor is saved.
- **`afterChange` runs after every command** except read, note and rating, and also after replies, merges and snooze wake-ups:
  - a conversation arriving in, or reopening in, a team inbox is routed
  - when a teammate's workload drops (close, snooze, reassignment, merge), their teams' queues are drained
- **`drainAll`** is the fallback sweep: every second in the local relay, and on the Worker's scheduled sweep.
- **`assigneeFor(conversation)`** is the rule-based routing interface for phase 11. It says who would get the conversation now, without assigning.
- **Manual assignment beyond a limit** is allowed, and the command returns `overLimit: true`.

**API (behind `routing_v1`):**

- `GET /v1/agent/teams` returns settings, queued count, and used against limit for the inbox and each member.
- `POST /v1/agent/teams` (create or update from the editor's version; members) needs `workspace.manage`.
- `POST /v1/agent/teammate-limits` needs `workspace.manage`.
- Changes that may free capacity drain at once.

## 2. Files

| File | Change |
|---|---|
| `db/postgres/0027_routing.sql`, `db/rollback/0027_routing.sql` | Team and teammate routing columns, indexes, flag |
| `server/routing.ts` | Decisions, claims, queue draining, triggers, rule interface, sweep, settings, capacity |
| `server/conversations.ts` | Routing after commands, replies, merges and wakes; over-limit warning |
| `server/api.ts`, `server/agent-bridge.ts`, `server/people.ts` | Routes, bridge, flag seed |
| `scripts/local-relay.ts`, `workers/relay.ts` | Fallback sweep |
| `tests/routing.test.ts`, `tests/routing-simulation.test.ts` | Coverage below |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 30 September 2026:

- **Node:** 60/60 pass (about 79 seconds in total).
- **`tests/routing.test.ts` covers:**
  - **Pure decisions:**
    - manual assigns nothing
    - round robin rotates, skips away teammates, includes them with the toggle, ignores limits, and reports when no one is available
    - balanced picks the fewest active and rotates ties, respects teammate and inbox limits and the ticket limit, and follows whether tickets count
  - **In the database:**
    - flag off; teams need `workspace.manage`, are validated, and refuse members from another workspace
    - balanced assignment queues the third arrival at limit 1, and picks it up automatically when a teammate closes one
    - snoozing frees capacity
    - raising a limit drains the queue while the inbox limit still binds
    - a second claim on the same conversation fails and leaves one assignment record
    - manual teams assign nothing; assigning by hand beyond a limit is allowed with `overLimit: true`
    - round robin rotates `ada, bo, cy, ada`; with everyone away a conversation waits, and is picked up when someone returns
    - the sweep routes anything left waiting
    - the rule interface reads without assigning
    - another workspace sees no teams
- **`tests/routing-simulation.test.ts` (the acceptance criterion):** 20 teammates with limits of 2, 3, 4, 5, 8 or none, a balanced inbox limited to 60, 2,000 arrivals (10% priority), random closes and random away transitions.
  - **Checks:**
    - every 50 arrivals: no teammate over their limit, and the inbox within its limit
    - afterwards: everyone returns and keeps working, and the queue empties by itself
    - nothing lost: 2,000 conversations, all assigned before closing, none left waiting
    - nothing assigned twice: each conversation has exactly one routing record, naming the teammate who holds or held it
    - all 20 teammates took part
  - **Replay:** a second 300-arrival run with the same seed produced the identical assignment sequence.
  - **This run** (seed 20260930): 49 away transitions, 36 returns, peak queue 18.

| Teammate | Limit | Assigned | | Teammate | Limit | Assigned |
|---|---|---|---|---|---|---|
| t01 | 8 | 89 | | t11 | 8 | 98 |
| t02 | none | 157 | | t12 | 8 | 102 |
| t03 | none | 109 | | t13 | none | 144 |
| t04 | 8 | 140 | | t14 | 3 | 86 |
| t05 | 3 | 103 | | t15 | 2 | 95 |
| t06 | none | 99 | | t16 | 5 | 101 |
| t07 | none | 113 | | t17 | 8 | 56 |
| t08 | 2 | 66 | | t18 | 5 | 83 |
| t09 | 3 | 85 | | t19 | 3 | 67 |
| t10 | 8 | 56 | | t20 | 4 | 151 |

  The distribution follows free capacity at each moment, not limits alone. In this model, closes pick at random among all open work, and teammates spent different stretches away. So a teammate with a low limit who was rarely away (t15, limit 2) can take more over the run than one with a higher limit who was away often (t10, limit 8).

- **Typecheck and lint:** clean on the new files.
- **Browser:** 36/36 pass. This step has no UI; step B adds capacity, away mode and "Next conversation" to the inbox, with this phase's browser tests.

## 4. Deferred and known gaps

- **Truly parallel claims** can't run on the embedded test database, which serializes transactions. Atomicity rests on the conditional `UPDATE` and row locks, and the test shows a second claim failing. A parallel test against real PostgreSQL belongs with hosted acceptance.
- **New conversations don't enter a team by themselves yet.** They reach a team inbox when assigned to it (by a teammate, macro, bulk action or, in phase 11, a rule). A brand default team could be added if wanted.
- **Step B:** away mode and away-with-reassignment, auto-unassign, the return ramp-up, "Next conversation", capacity and UI copy in the inbox.
- **Step C:** queue position in the messenger, and one office-hours source.
- **Still open:** a new teammate's first list stays empty until the page reloads (phase 04), and the first-screen timing hasn't been re-measured with SLAs on (phase 05 B2).
