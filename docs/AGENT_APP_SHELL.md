# Agent app shell: the icon strip and side menus

Branch `phase-04/app-shell`, a follow-up to phase 04 (the agent inbox) and the first of two layout steps. Not a step of `docs/BUILD_PHASES.md`.

The user shared a screenshot of an Intercom-style inbox and asked for that layout. The inbox, Knowledge and other areas should sit in a navigation that can be hidden and comes back when the mouse goes there. Approved on 2 October 2026 ("Yes, go ahead"), with two choices:
- **Team inboxes** are added automatically, one for each team you're on.
- **The theme** stays each person's choice, with Light as the default.

Intercom was looked at read-only: menus were hovered and read, and nothing was clicked that changes anything. What follows describes behaviour in Relay's own words.

**Step 2, next session:**
- list cards with a message preview, channel icon and assignee
- the conversation header with the customer's avatar
- the composer with Reply and Note tabs on top
- the details panel open by default on wide screens

## What it does

**The icon strip** (`agent/shell.tsx`, `Rail`) replaces the old labelled sidebar.
- **Contents:**
  - **Top:** the Relay mark, then Inbox and Knowledge. Inbox shows your inbox's open count.
  - **Bottom:** Notifications (with its unread count), Shortcuts, and your account menu.
- **Hover:** after a short pause it slides out with labels, lying over the page rather than pushing it. It slides back a moment after the mouse leaves. A quick pass across it doesn't open it.
- **Keyboard:** focusing into it opens it, and Escape closes it.
- **Using anything in it** (a destination, Notifications, the account menu) closes it, so it never covers what you just opened. It stays closed until the mouse leaves the strip or Tab moves within it.
- **Pinning:** a pin keeps it open; it then takes its full width in the layout.
- **Names:** collapsed, every button keeps its name for screen readers.

**Each area has its own side menu** (`SideMenu`).
- **Inbox menu:**
  - your inbox, Mentions, Unassigned and All, with counts
  - **Team inboxes:** one for each team you're on
  - **Views:** your saved views, grouped in their folders
  - **Header:** a ＋ for a new view
  - **Footer:** **Manage views**, holding New, Edit, Duplicate, Move up, Move down and Archive for the view you're on
- **Sections fold.**
- **"Your inbox"** is how the menu shows the built-in Mine view. Its saved name is unchanged.
- **Knowledge menu:** Content, then Help centers and Websites for managers. These replace the old tabs.
- **Hiding:** "Hide menu" puts a menu away and the list takes its place.
  - Hovering the list's "Show menu" button, or the thin edge where the menu was, brings it back over the page. It goes when the mouse moves away or you press Escape.
  - Clicking "Show menu" keeps it open again.
- **Remembered:** each menu's choice is kept in this browser. Below 1,100 pixels wide, menus start hidden unless you chose otherwise.
- **Blocked storage:** everything works for the visit and starts fresh next time.

**The list header** shows the view's name (for example "Billing").
- **Beside the name:** the connection ("● Live", with the store as its tooltip).
- **Below it:** Workload and Next conversation, when routing is on.
- **Top bar:** removed. What it held now sits here.

**Team inboxes** are built-in views named `team:<team id>`, created by the idempotent initialize action (`seedTeamInboxes` in `server/inbox-views.ts`).
- **One per team you're on**, listing that team's conversations. The status picker narrows them, as elsewhere.
- **Kept in step:**
  - A renamed team renames its inbox.
  - Leaving a team archives its inbox; rejoining brings the same view back.
  - The views response now names your teams, and the client runs initialize once when its team inboxes don't match.
- **Fixed order:** team inboxes and default views can't be moved or archived. Moving now reorders only your own views.

## Not included yet

Each has a TODO in `components/relay/postgres-inbox.tsx`, naming its phase.

| In Intercom | In Relay |
|---|---|
| Reports | phase 14 |
| Outbound | phase 13 |
| Contacts | phase 01 (the people model; its screen isn't built yet) |
| The AI agent ("With Ray") | phase 08 |
| Copilot tab | phase 10 |
| "Created by you" | needs a creator recorded on conversations |
| Spam | not in the plan yet |
| Teammates' inboxes | deferred |

## Migration

None. Team inboxes use the existing `inbox_views.builtin` column and its unique index. They sit behind the saved-views flag (`agent_inbox_views_v1`, off by default). The local relay already puts the owner in Billing, so the Billing team inbox shows there.

## Tests

**`tests/team-inboxes.test.ts`:**
- one inbox per team, alphabetical, with open counts and the team's conversations
- initialize is idempotent
- team inboxes refuse archive and move
- rename, leave and rejoin (the same view comes back, ready)
- another workspace sees none of them and can't read one by id

**`tests/inbox-views.test.ts`:** moves only your own views, and a default view refuses to move.

**`tests/browser/app-shell.spec.ts`** (ports 8904/8905):
- **Happy path:**
  - the strip's badge, hover slide-out without moving the list, pin and reload, keyboard open and Escape
  - the inbox menu's entries, a team inbox, folding a section, Manage views
  - hiding, peeking from "Show menu" and from the edge, the choice surviving a reload
  - the Knowledge menu
- **Failure path:** with browser storage blocked, hiding and pinning work for the visit, a reload starts fresh, and no errors are thrown.

**Updated browser specs:**
- `inbox-views.spec.ts`: "Your inbox"
- the Knowledge specs: menu buttons instead of tabs
- `dark-mode.spec.ts`: the contrast probe sits in the list header

## Checks

Results on 2 October 2026:
- `npm test`: 87/87 pass.
- `npm run typecheck`: clean.
- Lint shows nothing new (the existing `agent/views.tsx` findings remain).
- `npm run test:e2e`: 64/64.
- `npm run test:postgres`: passes.
- **Checked in screenshots, light and dark:**
  - the strip collapsed and slid out
  - the inbox menu shown, hidden and peeking
  - Manage views
  - the Knowledge menu
