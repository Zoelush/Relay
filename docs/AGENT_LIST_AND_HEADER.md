# Agent inbox: status picker, sort menu and conversation header

Branch `phase-04/list-status-sort`, a follow-up to phase 04 (the agent inbox). Not a step of `docs/BUILD_PHASES.md`.

Approved on 2 October 2026 ("yes, go ahead"):
- built into the saved-views list, with saved views on for the local dev relay
- built-in sorts only, with field sorts later
- new sort keys and open counts on the view index
- browser tests for the happy and failure paths

In the same message, the user asked to look at Intercom's conversation header (close, snooze, convert to ticket, the "⋯" menu, priority) and implement the recommendations for Relay.

Intercom was looked at read-only: menus were opened and closed without choosing anything, and no message content was recorded. What follows describes behaviour in Relay's own words.

## What it does

**The status picker** sits at the top of the conversation list.
- **The button** shows the count and status ("12 Open").
- **The menu** lists Open, Snoozed and Closed, then (after a line) the ticket states Submitted, In progress, Waiting on customer and Resolved, each with an icon, a count and a tick on the current one.
- **Ticket states** list tickets in that state whatever the conversation's own status.
- **Counts** stop at 999+ so they stay fast, and show "…" while a view is still being prepared. The list then says "This view is being prepared…".

**The sort menu** is searchable; Enter picks the first match.
- **Sorts:** Last activity (the new default), Date started, Waiting since, Next SLA, Priority (priority first, then last activity) and Snoozed until.
- **Direction:** a separate button reverses the order. Each sort starts in its most useful direction: newest activity first, longest waiting first, soonest SLA or wake first.
- **Last activity** means the last reply from either side, so tagging or reading a conversation doesn't move it.
- **Saved views:** views saved with the old sorts keep their order (newest is date started, descending).

**Views say whose conversations, not which status.**
- **Built-ins:** Mine, Mentions, Unassigned and All. The status picker does the rest.
- **The upgrade:** teammates' existing views are brought up to date the next time the list loads. Mine and Unassigned stop filtering to open, and All open, Snoozed and Closed are archived (kept, not deleted) in favour of All.
- **New custom views** start with "any status".
- **Sidebar counts:** a view's count is its open conversations.

**Bulk "select all in this view"** covers the status shown, so a bulk close never reaches conversations the teammate can't see.

**The conversation header**, in Intercom's order:
- **The buttons:**
  - Assign to me
  - icon buttons with tooltips for Priority (filled when on), More actions (⋯), Convert to ticket and Snooze
  - Close or Reopen as the labelled button
  - the details panel toggle
- **More actions:** show or hide conversation details, export the conversation as text, the command palette, and keyboard shortcuts.
- **Export as text:** the whole conversation as the customer saw it, oldest first. It fetches every page, not just what's on screen. Internal notes and system events are left out; the file says notes aren't included.
- **Convert to ticket:** opens the details sidebar (if closed) and starts its conversion form, focused on the ticket type.
- **Snooze presets** show the time each wakes: later today, tomorrow, next week (Monday), one week, and one month (the same day next month, or its last day, at 09:00). One week and one month are new on the server too.

**Relay is written with a capital R** in the agent sidebar, the old D1 inbox, and the old messenger demo.

## Migration

`db/postgres/0035_inbox_status_sort.sql` is additive:
- **View members** carry the conversation's status, its ticket state's kind, last activity, priority and snooze time, with indexes for each sort.
- **Open counts:** each filter set keeps an open count, maintained by the existing statement triggers plus a new one for updates.
- **Tickets:** a trigger on tickets re-projects a conversation when its ticket's state changes.
- **Saved sorts:** the view sort check now allows the new sorts. It also allows `sla`, which the server accepted but the database refused before.

The rollback restores the previous count functions, drops the two triggers, and resets views saved with a new sort to newest.

## Tests

**`tests/list-status-sort.test.ts`:**
- saved sorts from before the menu
- every status, including ticket states, and the counts
- every sort in both directions
- a priority change and a ticket state change re-projecting
- paging 153 conversations by priority both ways with no duplicates; cursors that belong to one status and direction
- bulk select-all following the status
- another workspace's conversations never appearing

**`tests/inbox-views.test.ts`** is updated for the new built-ins and adds:
- the upgrade of old built-ins (Mine and Unassigned drop the open filter; three archived)
- open counts
- the status counts on the first page

**Other unit tests:**
- `tests/snooze.test.ts`: one week, and one month across a daylight-saving change and at month end
- `tests/conversation-export.test.ts`: no notes, events, deleted or replaced parts; oldest first
- `tests/agent-theme.test.ts`: now fails if a colour token lands inside a property name

**`tests/browser/list-status-sort.spec.ts`** (ports 8954/8955):
- **Happy path:** pick Snoozed and a ticket state; drive the status menu by keyboard (focus returns); search the sort menu and pick with Enter; reverse the order.
- **Failure path:** a view still being prepared shows "…" counts and says so.

**`tests/browser/conversation-header.spec.ts`** (ports 8956/8957):
- **Happy path:** priority; the more-actions menu by keyboard; export (the file has the reply and not the note); convert to ticket from the header; snooze presets with times, with One week waking seven days on.
- **Failure path:** a refused priority change is put back and explained.

**Updated browser specs:**
- `inbox-views.spec.ts`: All instead of All open
- `sla.spec.ts`: sorts through the menu

## Fixed along the way

- **`white-space` broken by dark mode** (merged in #28). Replacing the colour "white" with a token also hit the word inside `white-space`, breaking five rules: conversation titles stopped truncating, line breaks in messages and notes weren't kept, and visually-hidden labels could wrap. They're restored, and the colour test now catches a token inside a property name.
- **A saved `sla` sort** was refused by the database. It is now allowed.

## Notes

- **Deferred:**
  - **Sorting by any conversation field** needs a sortable copy of each field kept up to date (TODO, phase 04 follow-up).
  - **Priority levels:** Intercom has Urgent, High, Medium and Low; Relay's priority is on or off. Levels touch routing order, view filters and SLA conditions, so they're a separate change.
  - **More actions items Relay has no UI or feature for yet:**
    - **Merge into…** (the server supports merging; a picker is needed)
    - **Manage participants** (the server supports it)
    - **New conversation** (outbound, phase 13)
    - **Mark as spam** (in the gap audit, not yet in the plan)
    - **Export as PDF**
    - **Timestamps in the customer's timezone**
- **Saved views on locally:** the dev relay (`npm run dev:relay`) now has saved views on (`RELAY_LOCAL_INBOX_VIEWS=false` turns them off). Tests still choose explicitly, and deployed workspaces default to off.
- **Menus** (`agent/menu.tsx`) position themselves against the window, so a narrow or scrolling column never clips them.

## Checks

Results on 2 October 2026:
- `npm test`: 86/86 pass.
- `npm run typecheck`: clean.
- Lint shows nothing new (the existing `agent/views.tsx` finding remains).
- `npm run test:e2e`: 62/62.
- `npm run test:postgres`: passes.
- **Checked in screenshots:** the status and sort menus, the header and its menu, and the snooze dialog, in light and dark.
