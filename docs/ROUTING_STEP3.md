# Routing — step C handoff (queue position and one office-hours source)

Step C is the last step of phase 06 in `docs/ROUTING_PLAN.md`, so it completes the phase's plan locally. The B handoff (away mode and workload) is `docs/ROUTING_STEP2.md`.

Decisions approved on 1 October 2026:

- **Expected reply time:** measured (the median business-time first response over 14 days, from at least 20 conversations), shown in bands, falling back to a brand phrase, then nothing.
- **Queue position:** shown by default, with a per-brand switch to hide it.
- **What it says:** "You're 3rd in line" in routing's own order, with no wait estimate.
- **No calendar at all:** no hours line in the messenger.

## 1. What changed

**One source for office hours (`server/office-hours.ts`):**

- **`openNow(calendar, at)`:** whether a calendar is open now and, if not, the next opening. It uses the B1 engine's time periods, so holidays, special days, overnight hours and daylight saving all count. It's the helper phase 11's out-of-hours automations and phase 14's reporting will call (TODOs in place).
- **`availabilityFor(brand, team?)`:** resolves the calendar as SLAs do (team, then brand, then workspace) and labels the next opening in the calendar's time zone and the customer's language. It returns nothing when no calendar applies.
- **The messenger boot** now uses it. The `officeHours` brand setting is no longer read (it already seeded each brand's default calendar), and `server/availability.ts`, the minute-by-minute checker that ignored holidays, is removed.

**Expected reply time (`expectedReply`):**

- **Measured:** the median `first_response_business_ms` for the brand's conversations in the last 14 days, from at least 20 conversations, shown as a band:
  - under 10 minutes: "a few minutes"
  - under an hour: "under an hour"
  - under 4 hours: "a few hours"
  - otherwise: "about a day"
- **Fallback:** the brand's own `replyTime` phrase (80 characters at most), or nothing.
- **Where it shows:** only while the team is open. Out of hours the messenger shows the out-of-hours message and "We'll reply from Tuesday 09:00 GMT" instead.

**Queue position (`queuePosition`, `routingPort`):**

- **Who sees it:** a customer whose conversation is open, unassigned and waiting in a team that assigns automatically. Brands can turn it off with `showQueuePosition: false`.
- **The order** is the same as routing's (priority, then soonest SLA due, then longest waiting), computed by the server. Priority conversations can move ahead, so a position can occasionally go back up.
- **Where it's delivered:** in every customer timeline frame (`waiting.queue`), along with when the conversation's team is next open.
- **Live updates:** when the line moves (an assignment by routing, "Next conversation" or a teammate by hand), the first 100 conversations still waiting in that team get an outbox notification. Their messengers re-read, so nothing polls.
- **The phase 03 `RoutingPort.queuePosition`** is now implemented, and the messenger's `queue` capability is on.

**Messenger:**

- **Home screen:** the hours line only when a calendar applies; the reply time while open; "We'll reply from …" when closed.
- **Inside a conversation:** "You're 2nd in line" (English ordinals; Arabic uses the number) and, if the team is closed, when it's back.
- **Strings:** English and Arabic.
- **Bundle:** the messenger frame grows by under 1 KB gzip (69.7 to 70.4 KB).
- **Lint:** two helpers live outside the component so the React compiler keeps its memoization.

## 2. Files

| File | Change |
|---|---|
| `server/office-hours.ts` (new), `server/availability.ts` (removed) | One office-hours source; reply time |
| `server/routing.ts`, `server/ports.ts` | Queue position, line-moved announcements, routing port |
| `server/api.ts` | Boot availability, reply time and `queue` capability; waiting details in customer timeline frames |
| `messenger/frame.tsx`, `messenger/strings.ts`, `messenger/frame.css` | Hours, reply time, place in line |
| `docs/MESSENGER.md` | Brand settings for reply time and queue position |
| `tests/office-hours.test.ts`, `tests/browser/office-hours.spec.ts` | Coverage below |

There's no migration: the new brand settings live in the existing settings JSON.

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 1 October 2026:

- **Node:** 63/63 pass. `tests/office-hours.test.ts` covers:
  - **`openNow`:** open, a holiday with the next opening, and a special Saturday.
  - **Availability:** from the seeded calendar; a brand calendar's holiday winning over the old setting, labelled "Tuesday 09:00 GMT"; a team's night-shift calendar inside its conversations; an Arabic label; null when no calendar applies.
  - **Reply time:** the phrase when fewer than 20 measurements exist; measurements older than 14 days ignored; bands at the 20th measurement and after more.
  - **Boot:** reply time, no availability line, and the queue capability.
  - **Queue position:**
    - routing's order (priority first) through the messenger's own history route and the routing port
    - another customer's position unreadable (404), and another workspace's null
    - a teammate's return takes the first: it leaves the line, the others move up, and exactly those still waiting are announced
    - taking one by hand moves the line and announces it
    - the brand switch hides positions; manual inboxes have no line
- **Typecheck and lint:** clean.
- **Browser:** 40/40 pass, with no stray server errors logged this time. `tests/browser/office-hours.spec.ts` passed 4 out of 4 on repeat:
  - **Happy path:** with a calendar open all week, the messenger shows the reply-time phrase. Two customers wait in Billing, the second seeing "You're 2nd in line". When the owner returns and takes the first, the second's messenger changes to "You're 1st in line" without reloading. When Grace returns and takes it, the line disappears.
  - **Failure path:** on today's holiday the messenger shows the away message and "We'll reply from" tomorrow, with no reply-time line.

## 4. Deferred and known gaps

- **No wait estimate** (decision 3). It would need throughput statistics.
- **Priority changes and SLA re-sorting** don't announce the line; the next line movement or the customer's own activity refreshes it.
- **The brand's old `officeHours` setting** is still stored (it seeded the default calendar) but no longer read. Removing it is a later, separate change.
- **Out-of-hours automations** (phase 11) and reporting durations (phase 14) will call `openNow` and the same calendars; TODOs are in place.
- **Still open:**
  - a new teammate's first list stays empty until the page reloads (phase 04)
  - first-screen timing with SLAs on (phase 05)
  - parallel-claim testing on real PostgreSQL (phase 06 A)
  - the one-off "Relay API failed" log (phase 06 B)
