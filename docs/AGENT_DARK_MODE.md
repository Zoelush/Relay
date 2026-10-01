# Agent app dark mode and account menu

Branch `phase-04/dark-mode`, a follow-up to phase 04 (the agent inbox). Not a step of `docs/BUILD_PHASES.md`. Approved on 1 October 2026 ("Go ahead with all, it's the whole agent view that should have a dark mode"):
- the choice is kept in the browser
- Light stays the default, and the teammate's own choice turns dark on, so no workspace flag is needed
- WCAG AA contrast is checked by tests
- this branch

The account menu was added on the same branch, approved on 1 October 2026 ("go ahead"):
- New workspace and Workspace settings are left out (phases 17 and 16)
- the top-bar status dropdown is removed
- Your profile is read only
- same branch and pull request

## What it does

**A theme switch in the account menu:** System, Light or Dark.
- **System** follows the device, live.
- **Kept per browser:** the choice is saved in this browser, and other open tabs follow a change (through the browser's storage event; not covered by a test).
- **Storage blocked:** where browser storage is blocked, the switch still works for the visit and the app starts in Light next time.

**The whole agent app is themed:**
- the inbox, list, conversation, composer and notes, sidebar, SLA clocks and tickets
- views, bulk actions, dialogs (palette, shortcuts, snooze, macros, workload, notifications), mentions and variables
- Knowledge: the article editor, the file panel, help center settings and insights

The public help center, the messenger and the portal keep their own theming.

**The dark palette is neutral near-black** (backgrounds from `#0a0a0b` to `#2d2d31`, text from `#ececee` down to `#96969b`). Green is kept for accents only: links, the Live dot, focus rings, the selected conversation's marker and primary buttons. A first version used green-tinted backgrounds, which were found distracting in review.

**How the colours work** (`agent/inbox.css`):
- **Named colours:** every colour is one of 51 named colours (`--pg-…`) with a light and a dark value, defined once at the top of the stylesheet.
- **Applying the theme:** `agent/theme.ts` sets `data-agent-theme` on the root element before the first render, so a dark choice never flashes light. Popups attached outside the app, like the mention list, are themed too.
- **Browser controls:** `color-scheme` is set to match, so the browser's own inputs, selects, checkboxes and scrollbars follow the theme.
- **Plain buttons:** in dark mode, buttons that have no styling of their own become quiet surfaces (zero-weight rules, so any button with its own colours keeps them). The light theme keeps the browser's buttons.
- **No stray colours:** a test fails if a colour is written anywhere else in the stylesheet.

## The account menu

The sidebar's lower corner is now a button with your initials, name and a presence dot (green when active, amber when away). It opens the menu upwards (`agent/account-menu.tsx`):
- **Who you are:** initials, name, role, status, and your email where the hosting sign-in gives one. The deployed page passes the email and the sign-out link from the platform sign-in (`app/page.tsx`). Relay doesn't store teammate emails.
- **Away** and **Reassign replies** switches, using phase 06 presence.
  - Reassigning only applies while away. Turning Away off makes you active, which switches reassigning off with it.
  - A hint explains it: while you're away, a customer's reply to one of your conversations sends it back to its team inbox.
  - The switches show the change at once and spring back with the server's reason if it's refused.
  - When routing is off for the workspace there's no status, and the switches aren't shown.
  - The status dropdown in the inbox top bar is gone; the workload bar reloads when your status changes.
- **Workspace:** the current one, ticked. **Your profile** opens a read-only panel with role, workspace, status, teams, and open conversations and tickets against your limits.
- **Theme:** System, Light or Dark (moved here from the sidebar).
- **Sign out:** only where the hosting sign-in supports it; not on the local relay.
- **Opening and closing:** it opens with the keyboard and moves focus in. Escape (from anywhere) or a click outside closes it, and focus returns to the button. In the narrow sidebar the button shows just the initials.

The agent snapshot (`GET /v1/agent/inbox`) now also returns `account`: the role's name and the workspace's name. It's in the same workspace-scoped transaction as the rest of the snapshot.

**Not built, by agreement:**
- **New workspace** (TODO(phase 17), with onboarding)
- **Workspace settings and editing your profile** (TODO(phase 16), with teammate administration)
- **Language and help links**, as in Intercom's menu

## Changes to the light theme

The light theme looks as it did, apart from these:
- **Accessibility fixes**, from the agreed contrast check. These were failures before this change:
  - **Muted text** (timestamps, hints, "Open · Messenger") was 3.2–3.6:1 and is now at least 4.6:1.
  - **Form field borders** were 1.4:1 and are now 3.1:1 (WCAG's non-text minimum), so text boxes and selects are visibly darker-edged.
  - **Internal note text** on the pressed "Internal note" tab was 4.25:1 and is now 4.9:1.
  - **The empty-inbox icon** is a shade darker, to reach 3:1.
- **Merged shades:** near-identical shades were merged into one named colour. For example, message text was `#263c31` and is now the body colour `#183a31`. These differences aren't visible.
- **The mention list** now uses the app's font and text colour. It was attached outside the app and fell back to the browser's serif default.
- **The account menu** replaces the teammate's name in the sidebar's lower corner.

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
- The open account menu is included in the contrast sweep, in both themes. The sweep caught the avatar initials at 4.33:1 in light mode, now fixed.

**`tests/browser/account-menu.spec.ts`** (ports 8958/8959):
- **Happy path:**
  - the status is no longer in the top bar
  - the menu opens from the keyboard, with focus on Away
  - it shows name, role and workspace, and no sign-out locally
  - Reassign replies is disabled until away; going away and then reassigning are checked in the database and on the button's name
  - Escape closes it and returns focus
  - Your profile is read only
  - turning Away off makes you active
  - a click outside closes it
- **Failure path:** a refused status change springs back and shows the reason, and nothing changes in the database.

**`tests/browser/workload.spec.ts`** now sets the status through the account menu.

## Notes

- **Deferred:**
  - **Following the teammate across devices** (saving the choice on their profile) needs a migration and an API change.
  - **Narrow phones:** below 600px the sidebar is hidden (as before), so the account menu isn't reachable there. A teammate on a phone gets the theme saved on that browser, or Light.
  - **Narrow sidebar labels:** at 850px and below, the sidebar's "Knowledge" label is cut off. This was already the case before this branch, and it's left for a later pass.
  - **The legacy D1 inbox** (`components/relay/inbox.tsx`, shown when `RELAY_AGENT_INBOX_V1` is off) isn't themed. It is being retired.
- **Found while checking, not fixed here:** the @-mention list stays open after Escape, because the composer's own Escape handler takes the key first. It was already there before dark mode, so it's flagged as its own task.
- **The browser's own buttons:** in light mode the app keeps using them. Restyling them for consistency would be a visible light-theme change, so it's left for a design pass.

## Checks

Results on 1 October 2026:
- `npm test`: 80/80 pass.
- `npm run typecheck`: clean.
- Lint shows nothing new.
- `npm run test:e2e`: 55/55, with no "Relay API failed".
- The agent bundle builds.
