# Phase 05 plan — tickets and SLAs

The phase prompt is "Phase 05 — Tickets and SLAs" in `docs/BUILD_PHASES.md`. This plan splits it into steps, one per session, on branches named `phase-05/step-<id>`. It was approved on 30 September 2026.

## Steps

| Step | Scope | Handoff |
|---|---|---|
| **A1: Ticket core** | Ticket types, custom states and transitions, typed fields, fields required before closing, converting a conversation, changing type with a preview | `docs/TICKETS_STEP1.md` |
| **A2: Categories and linking** | Customer, back-office and tracker behaviour; links from a back-office ticket to its conversation and from a tracker to many conversations; a tracker broadcast that updates every linked conversation in one action; customer-visible state updates | — |
| **B1: Business-time engine** | Due-time calculations with second precision; per-team and per-brand calendars with holidays; the acceptance test matrix (office-hours boundaries, holidays, time zone changes, snooze, reopen after close, daylight saving) | — |
| **B2: SLAs** | Policies, targets (first response, next response, time to close, time to resolve) and conditions, re-evaluated when relevant attributes change; pause rules; clocks; breach handling (marked and emitted as an event, never silently expired); time remaining on the conversation and sortable in views | — |
| **C: Customer portal** | A branded page where a signed-in customer sees their tickets and conversations and can reply; visibility rules; a link from the messenger | — |

## Designs that run through every step

- **A ticket is a conversation with a ticket record attached,** so the timeline, notes, assignment, views and realtime all work unchanged. Back-office and tracker tickets are internal conversations the customer never sees.
- **Every change is recorded:** state changes, type changes and creation are timeline events and appear in the API.
- **Flag:** tickets sit behind the `tickets_v1` workspace flag, off by default. The local relay turns it on.

## Decisions (30 September 2026)

1. **Order:** A1 → A2 → B1 → B2 → C.
2. **Company visibility in the portal:** step C builds "only their own tickets". The company setting is defined as an interface with a TODO owned by phase 01, which builds companies.
3. **Custom domains:** the branded portal is served on the Relay host, with a table mapping a domain to a brand. Certificates and DNS wait for hosting (phase 17).
4. **"While in an automation" pause:** the pause rule and its setting are built in B2, with nothing turning it on yet and a TODO for phase 11.
