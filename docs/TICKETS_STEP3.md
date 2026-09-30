# Tickets and SLAs — step B1 handoff (business-time engine and clock matrix)

Step B1 is the third step of phase 05 in `docs/TICKETS_PLAN.md`. The A2 handoff is `docs/TICKETS_STEP2.md`. Step B2, SLAs, is next and builds on this engine.

Decisions approved on 30 September 2026:

- **Running clocks keep the calendar version they started with.** Calendar changes apply to new clocks only.
- **Overnight hours and special-day hours are supported.**
- **Which calendar applies:** team, then brand, then the workspace default, then open 24/7.
- **API only for now.** There's no settings screen yet.

## 1. What changed

**The engine (`server/business-time.ts`).** It works with whole time periods instead of stepping a minute at a time, and is exact to the millisecond. It never reads the clock or the database.

- **Opening hours are local wall-clock times,** converted to real instants.
  - An hour the clocks skip is never open, and an hour they repeat counts twice.
  - So an 00:00–04:00 window is 3 real hours on a spring-forward night and 5 on a fall-back night.
  - Changes in UTC offset are located to the exact second.
- **Overnight hours:** a range may cross midnight ("22:00"–"06:00"). The whole shift belongs to the day it starts, so a holiday on that day cancels all of it and a holiday the next day cancels none.
- **Holidays and special days:** full-day holidays are listed as local dates. Special days replace a day's hours, can open a weekend, and `[]` closes a day.
- **The functions:**
  - `dueAt(calendar, start, target)`: when a target runs out. A target that runs out exactly at closing is due at closing.
  - `businessBetween(calendar, start, end)`: business time between two moments.
  - `openIntervals(calendar, from, to)`: the open periods themselves.
- **`clock(calendar, target, events, now)`** runs a clock over start, pause, resume and stop events. It returns the state, time elapsed and remaining, the due time, and whether and when it breached.
  - **Breach:** business time went past the target. The breach time is the first open moment after the target ran out. A clock stopped exactly at its due time has met the target, and a clock reopened after its target was used up breaches only when business time next passes.
  - Repeated events and events after `now` are ignored.
- **`ALWAYS_OPEN`:** open 24/7 in UTC, used when no calendar applies.
- **`validCalendar`:**
  - checks the time zone and HH:MM times up to 24:00
  - rejects ranges with the same start and end, and overlapping ranges within a day
  - requires weekdays 0–6 and real dates for holidays and special days (500 of each at most)
  - requires the calendar to be open at some point each week
- **`businessMilliseconds`** (used by the first-response metric) now uses the new engine. Its existing test passes unchanged, and results are exact to the millisecond.

**Calendars (`server/calendars.ts`, migration 0024).**

- **Versions:** `calendars` gives each calendar a name and a pointer to its current version. Every publish adds an immutable `business_calendars` version, so earlier versions stay available to anything that pinned them.
  - Editing requires the version the editor started from; otherwise it's refused (`CALENDAR_CONFLICT`).
  - The migration names existing calendars. `seedFoundation` names its seeded "Office hours" calendar.
- **Assignments:** `calendar_assignments` assigns a calendar to the workspace default, a brand or a team.
  - **Resolution order:** team, then brand (an assignment first, then the older `brands.settings.calendarId`), then the workspace default, then 24/7.
  - **At conversation start:** a new conversation pins the calendar that applies at that moment (it has no team yet). With no assignments, the older brand setting applies, so behaviour is unchanged.
- **Routes** (behind the new `sla_v1` flag, off by default; the local relay turns it on):
  - `GET /v1/agent/calendars`: list calendars and assignments
  - `POST /v1/agent/calendars` with `op: "publish"` or `"assign"`: needs `workspace.manage`
  - `GET /v1/agent/calendar-resolve?conversation=`: the calendar that applies now, and the version the conversation pinned

## 2. Files

| File | Change |
|---|---|
| `db/postgres/0024_calendars.sql`, `db/rollback/0024_calendars.sql` | Calendar names, assignments, `sla_v1` flag |
| `server/business-time.ts` | New engine, clock, validation; metrics wrapper |
| `server/calendars.ts` | Publish, assign, list, resolve, pinned versions |
| `server/conversations.ts`, `server/people.ts` | Pinning through resolution; seeded calendar named; flag seed |
| `server/api.ts`, `server/agent-bridge.ts`, `scripts/local-relay.ts` | Routes, bridge, local flag |
| `tests/business-clock.test.ts`, `tests/calendars.test.ts` | Coverage below |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 30 September 2026:

- **Node:** 54/54 pass. `tests/business-clock.test.ts` is the acceptance matrix. Its expected values were worked out by hand:
  - **Office hours:** 17:00 Friday plus 4 hours is due 13:00 Monday; starting before opening, exactly at opening, exactly at closing, and 1 millisecond after; a zero target; weekends.
  - **Holidays:** a Monday holiday; a short Christmas Eve followed by consecutive holidays; New Year; 29 February 2028; a special day opening a Saturday and closing a Monday.
  - **Time zones:** India (+05:30), Newfoundland (−03:30), Chatham Islands (+13:45) and Kiritimati (+14, where Monday starts on a UTC Sunday).
  - **Daylight saving:** London, New York and Lord Howe (a 30-minute shift) in both directions, with windows spanning the jump; skipped and repeated hours; office hours across the change.
  - **Overnight hours:** across midnight, over the week boundary, on a daylight-saving night, holiday ownership, and adjoining windows merging.
  - **Clocks:**
    - a snooze across closed hours, and a pause that accrues nothing
    - a breach with its time; met exactly at the deadline; breached 1 millisecond late
    - reopening after close continues the time already used
    - a pause and resume straddling a holiday
    - repeated and future events; not started; started while closed
    - reopened with the target used up: not breached until open time passes
  - **Always-open and validation:** 24/7, and 11 validation refusals.
  - **Generated cases:** 120 generated cases (7 time zones, dates near daylight-saving changes, the year boundary and a leap year, random overnight ranges, holidays and special days) agree with an independent minute-by-minute reference that reads the wall clock directly. For each, adding a target and measuring back returns exactly the target, and due times never move earlier as the target grows. It runs in about 1.5 seconds.
- **`tests/calendars.test.ts`** covers:
  - flag off; `workspace.manage` required; an invalid calendar refused with nothing stored
  - publishing a new version and a stale edit refused
  - a conversation started before a time-zone change keeps version 1 (London) while a later one pins version 2 (New York), with first-response metrics of 4 hours and 0 hours for the same wall-clock span
  - resolution order with fall-through, including the older brand setting and 24/7
  - assignment checks; workspace isolation (list, assign, publish and resolve)
- **Typecheck and lint:** clean on the new files.
- **Browser:** 32/32 pass. This step has no UI (API only, as agreed), so it adds no browser tests. B2's SLA UI will carry this phase's end-to-end tests.

## 4. Deferred and known gaps

- **No settings screen** for calendars or assignments.
- **No SLA policies, clocks on conversations or breach events yet.** Those are B2, which pins each clock's calendar version when it starts, uses `clock()`, and adds the "while in an automation" pause setting for phase 11.
- **A team change on a running conversation** doesn't move its pinned calendar. B2 decides how SLA clocks treat reassignment (by the approved rule, a running clock keeps its version).
- **Holidays are per calendar.** There are no shared regional holiday sets or imports.
- **Still open from phase 04:** a new teammate's first list stays empty until the page reloads.
