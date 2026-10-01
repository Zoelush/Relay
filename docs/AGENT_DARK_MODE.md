# Agent app dark mode

Branch `phase-04/dark-mode`, a follow-up to phase 04 (the agent inbox). Not a step of `docs/BUILD_PHASES.md`. Approved on 1 October 2026 ("Go ahead with all, it's the whole agent view that should have a dark mode"):
- the choice is kept in the browser
- Light stays the default, and the teammate's own choice turns dark on, so no workspace flag is needed
- WCAG AA contrast is checked by tests
- this branch

## What it does

**A theme switch in the sidebar:** System, Light or Dark.
- **System** follows the device, live.
- **Kept per browser:** the choice is saved in this browser, and other open tabs follow a change (through the browser's storage event; not covered by a test).
- **Storage blocked:** where browser storage is blocked, the switch still works for the visit and the app starts in Light next time.
- **Small screens:** in the narrow sidebar (850px and below) the switch shows icons only, with their names still announced.

**The whole agent app is themed:**
- the inbox, list, conversation, composer and notes, sidebar, SLA clocks and tickets
- views, bulk actions, dialogs (palette, shortcuts, snooze, macros, workload, notifications), mentions and variables
- Knowledge: the article editor, the file panel, help center settings and insights

The public help center, the messenger and the portal keep their own theming.

**How the colours work** (`agent/inbox.css`):
- **Named colours:** every colour is one of 51 named colours (`--pg-…`) with a light and a dark value, defined once at the top of the stylesheet.
- **Applying the theme:** `agent/theme.ts` sets `data-agent-theme` on the root element before the first render, so a dark choice never flashes light. Popups attached outside the app, like the mention list, are themed too.
- **Browser controls:** `color-scheme` is set to match, so the browser's own inputs, selects, checkboxes and scrollbars follow the theme.
- **Plain buttons:** in dark mode, buttons that have no styling of their own become quiet surfaces (zero-weight rules, so any button with its own colours keeps them). The light theme keeps the browser's buttons.
- **No stray colours:** a test fails if a colour is written anywhere else in the stylesheet.

## Changes to the light theme

The light theme looks as it did, apart from these:
- **Accessibility fixes**, from the agreed contrast check. These were failures before this change:
  - **Muted text** (timestamps, hints, "Open · Messenger") was 3.2–3.6:1 and is now at least 4.6:1.
  - **Form field borders** were 1.4:1 and are now 3.1:1 (WCAG's non-text minimum), so text boxes and selects are visibly darker-edged.
  - **Internal note text** on the pressed "Internal note" tab was 4.25:1 and is now 4.9:1.
  - **The empty-inbox icon** is a shade darker, to reach 3:1.
- **Merged shades:** near-identical shades were merged into one named colour. For example, message text was `#263c31` and is now the body colour `#183a31`. These differences aren't visible.
- **The mention list** now uses the app's font and text colour. It was attached outside the app and fell back to the browser's serif default.
- **The theme switch** is new in the sidebar.

**Measured:** screenshots of six screens before and after differ only in those places: 1–6% of pixels change, all in muted text, field borders, message text, the sidebar and the SLA box. Nothing else moved.

## Tests

**`tests/agent-theme.test.ts`:**
- Both themes define the same colours, and no colour is written outside them.
- Every text pairing the stylesheet uses meets 4.5:1 in both themes. Focus rings, field borders and status lines meet 3:1.
- Saving and reading the choice works, including unknown values and blocked storage.
- System resolves correctly.

**`tests/browser/dark-mode.spec.ts`** (ports 8952/8953):
- **Happy path:**
  - Light by default even on a dark device.
  - Switch to Dark, then sweep the screen for contrast on: the inbox, a conversation with a reply and a note, the note composer, the mention list, the shortcuts dialog, a Knowledge article and help center settings.
  - Still Dark after a reload.
  - System follows the device as it changes.

  The sweep measures every visible piece of text against the colours actually behind it. It is checked against a planted low-contrast element first, so its clean passes count.
- **Failure path:** with browser storage blocked, Dark works for the visit, the next visit starts in Light, and there are no errors.

## Notes

- **Deferred:**
  - **Following the teammate across devices** (saving the choice on their profile) needs a migration and an API change.
  - **Narrow phones:** below 600px the sidebar is hidden (as before), so the switch isn't reachable there. A teammate on a phone gets the choice saved on that browser, or Light.
  - **The legacy D1 inbox** (`components/relay/inbox.tsx`, shown when `RELAY_AGENT_INBOX_V1` is off) isn't themed. It is being retired.
- **The browser's own buttons:** in light mode the app keeps using them. Restyling them for consistency would be a visible light-theme change, so it's left for a design pass.

## Checks

Results on 1 October 2026:
- `npm test`: 80/80 pass.
- `npm run typecheck`: clean.
- Lint shows nothing new.
- `npm run test:e2e`: 53/53, with no "Relay API failed".
- The agent bundle builds.
