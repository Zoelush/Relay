# Phase 06 plan — routing, teams and workload

The phase prompt is "Phase 06 — Routing, teams and workload" in `docs/BUILD_PHASES.md`. This plan splits it into steps, one per session, on branches named `phase-06/step-<id>`. It was approved on 30 September 2026.

## Steps

| Step | Scope | Handoff |
|---|---|---|
| **A: Assignment engine and simulation** | Team settings (method, limits, include-away toggle), teammate limits, manual / round robin / balanced assignment, a queue with automatic pick-up, the rule-based routing interface for phase 11, and the 20-teammate / 2,000-conversation simulation | `docs/ROUTING_STEP1.md` |
| **B: Away mode and workload in the inbox** | Away and away-with-reassignment, auto-unassign when going away, a paced return, "Next conversation", capacity shown as used against limit, team inboxes as views, and UI copy explaining round robin vs balanced | `docs/ROUTING_STEP2.md` |
| **C: Queue position and one office-hours source** | Messenger queue position, and the messenger's availability, expected reply time and out-of-hours text all read from the B1 calendars | `docs/ROUTING_STEP3.md` |

## Designs that run through every step

- **Assignment is atomic in the database.** A conditional update only claims a conversation that is still open, unassigned and in the team. Capacity is counted while the team's and members' rows are locked.
- **The decision is a pure function** of the team's state, the item and the rotation cursor, so simulations replay exactly.
- **Queues are picked up when capacity appears:** a close, snooze, unassign, merge, raised limit, new member or return from away. A sweep acts as a fallback.
- **Flag:** everything sits behind `routing_v1`, off by default.

## Decisions (30 September 2026)

1. **Order:** A → B → C.
2. **What uses capacity:** open (not snoozed or closed) conversations assigned to the teammate. Tickets count according to the team's toggle and may have their own limit. Limits bind automatic assignment only; assigning by hand beyond a limit is allowed, with an "over limit" warning.
3. **Returning from away:** a ramp-up of at most 3 automatic assignments per 5 minutes for a returning teammate, while the queue drains to everyone eligible in fewest-active order (built in step B).
4. **"Next conversation" order:** priority first, then the soonest SLA due time, then longest waiting, across the teammate's balanced team inboxes (step B).
