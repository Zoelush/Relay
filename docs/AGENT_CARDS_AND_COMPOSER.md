# Agent inbox: conversation cards, header, composer and details card

Branch `phase-04/cards-composer`, the second layout step after `docs/AGENT_APP_SHELL.md`. It is a follow-up to phase 04 (the agent inbox), not a step of `docs/BUILD_PHASES.md`.

The user approved this on 3 October 2026 ("Yes, go ahead with both"), with two choices:
- **Previews** are read when the list loads, with no stored copy.
- **Internal notes** are shown in previews, labelled.

While it was being built, the user also asked for **chat bubbles** like Intercom's:
- the team's replies in a very light olive green, adapted to both themes
- the customer's messages in black or white depending on the theme
- the two on different sides

## What it does

**Conversation cards** (`agent/card.tsx`) replace the list rows, in both the saved-views list and the plain list. Each card has four lines:
1. **Who and when:**
   - the customer's initials, name and time since the last activity ("now", "26m", "3h", "2d", then the date), with the full date on hover
   - unread conversations get a dot and a bold name
2. **The conversation:** a channel icon and the title.
3. **The latest message**, on one line:
   - **A teammate's reply** starts with their name, or "You" for your own.
   - **An internal note** starts with "Note".
   - **An AI agent reply** starts with "AI agent".
   - **A customer message** has no label.
   - **No message yet:** says "No messages yet".
4. **Status markers:**
   - the SLA timer as a chip, which turns amber when the target is close and red when it's overdue
   - a flag for priority
   - the assignee's initials, with their name for screen readers and on hover

**Chat bubbles in the conversation:**
- **Customer messages** sit on the left in a neutral bubble: near-black text on light grey, or near-white on dark grey in the dark theme.
- **Your team's replies and AI replies** sit on the right in light olive green, a darker olive in the dark theme.
- **Internal notes** sit on the right too, in their yellow, so a note can't be mistaken for a reply.
- **Initials:** each bubble has the writer's initials beside it, and the corner nearest them is squared off.
- **System events** stay centred between them.
- **New colours:** `team-bg`, `team-border`, `customer-bg`, `customer-border` and `customer-text`, with light and dark values. `tests/agent-theme.test.ts` checks their contrast in both themes.

**The conversation header:**
- **Left:** the customer's avatar, name and email, with the title beneath. The title is still the heading.
- **Right:** the SLA chip, then the existing actions.

**The composer:**
- **Top:** Reply and Internal note, then a hint ("Visible to the customer" or "Only your team can see this"), then a **Macros** button. It opens the macro picker, as M does.
- **Below the message:** the formatting buttons, then Send.
- **The channel label** ("Messenger") is gone; the hint already says who will see it.
- **The whole composer** highlights while you're typing in it.
- **"Internal note"** keeps its full name, rather than Intercom's "Note", so it's always clear a note is private.

**The details panel:**
- **Contact card at the top:** a large avatar, the contact's name and a badge for their type (visitor, lead or user).
- **The details below** follow as before. Name and type now appear once, in the card.

## How the preview is read

`listPreviews` in `server/conversations.ts` is used by both list endpoints, `view-page` and the `inbox` snapshot.
- **Which message:** for the page's conversations (at most 100), it takes each one's latest message: customer message, teammate reply, internal note, AI reply or attachment.
- **What it skips:**
  - the older versions of edited messages (their newest version counts)
  - deleted messages
  - system events
- **Cost:** each is a short backwards scan of the existing `parts_timeline` index.
- **Scoping:** every lookup is scoped to the workspace.
- **Shape of the result:** where it came from (customer, teammate, note or AI), the teammate's name and id, and up to 160 characters of text with whitespace folded. Attachments read "Attachment: name".

**Why a second query:** previews are read after the page is chosen, not joined into the page's query. Joined in, the database ran the lookup for every conversation in the view before sorting and cutting the page, on the last-activity and priority sorts.

**Measured** with `scripts/load-views.ts` (20 teammates, 10,000 conversations, 200,000 messages), now seeded with twenty messages per conversation, including notes and trailing system events.

| Sort | Without previews (p50 / p95) | Joined into the query | Read after paging (final) |
|---|---|---|---|
| Last activity | 19 / 29 ms | 61 / 115 ms | 20 / 24 ms |
| Priority | 21 / 24 ms | 60 / 64 ms | 22 / 25 ms |
| Date started | 7 / 8 ms | 9 / 10 ms | 8 / 8 ms |
| Waiting since | 7 / 8 ms | 7 / 8 ms | 8 / 8 ms |

The list's target is 150 ms at p95. The load script had also still asked for the retired "open" view and sorts; it now uses "All" and the current sorts.

**Privacy:** internal notes appear in previews because the list is only ever served to teammates, through the agent API. Nothing here reaches the customer's side. The customer's own list (`server/api.ts`, the messenger) is unchanged.

## Not included yet

| Item | When |
|---|---|
| The AI button in the composer | phase 10 (the agent copilot) |
| The Copilot tab beside Details | phase 10 |
| Customer avatars from photos | needs a contact photo, not in the people model yet |
| Filter chips above the list (Assigned to, Tag, Channel, Brand) | deferred; saved views do this today |

## Tests

**`tests/conversation-preview.test.ts`:**
- **Text handling:** whitespace folded, long text cut to 160 characters, attachments named, and who wrote it (customer, teammate with name and id, AI, and internal parts as notes).
- **Both lists agree:**
  - the latest message is a labelled note
  - a later system event changes nothing
  - deleting the note shows the reply before it
  - an edit shows the newest version
  - a conversation with no messages has no preview
- **Cross-workspace:** workspace B has a conversation with the same id and its own message. Neither workspace sees the other's.

**`tests/browser/cards-composer.spec.ts`** (ports 8906/8907):
- **Happy path:**
  - cards with initials, name, time, "Note:", "You:" and an unlabelled customer message
  - the priority flag, the assignee, and the 112-pixel card height
  - the header's avatar, name and title heading
  - the composer's layout: tabs and Macros on one line, formatting beside Send below the message
  - Macros opening the picker
  - the details card's name and type
  - **chat bubbles:** the customer's on the left and the team's on the right, in different colours, with the note on the team's side
- **Failure path:** a deleted last message previews the one before it and never the deleted text. A conversation imported with no messages says "No messages yet".

**Updated browser specs:**
- `inbox-views.spec.ts`: expects the card height (112) in its row arithmetic
- `sla.spec.ts`: reads the card's "SLA due in …"
- `dark-mode.spec.ts`: looks for a note's text in the timeline, since the card's preview shows it too

## Checks

Results on 3 October 2026:
- `npm test`: 89/89 pass.
- `npm run typecheck`: clean.
- Lint shows nothing new; the existing `agent/views.tsx` and `scripts/load-views.ts` findings remain.
- `npm run test:e2e`: 66/66.
- `npm run test:postgres`: passes.
- **Checked in screenshots, light and dark:** cards, the header, bubbles, the composer and the details card.
