# Tickets — step A2 handoff (categories and linking)

Step A2 is the second step of phase 05 in `docs/TICKETS_PLAN.md`. The A1 handoff is `docs/TICKETS_STEP1.md`. Step B1, the business-time engine, is next.

Decisions approved on 30 September 2026:

- Broadcasts go to open and snoozed linked conversations; closed ones are skipped.
- A broadcast can optionally close the conversations after sending.
- Back-office tickets are created only from a conversation. Trackers can be created on their own or from a conversation.
- Customers see messenger event lines only (number, type name, customer label).

## 1. What changed

**Migration 0023 (`db/postgres/0023_ticket_links.sql`):**

- `conversations.visibility` (`customer` or `internal`)
- `ticket_links`: a back-office ticket or tracker linked to a customer conversation
- `ticket_broadcasts` and `broadcast_items`: the same shape as bulk operations

All new tables use workspace row-level security. The rollback turns `tickets_v1` off and drops nothing.

**Customer tickets tell the customer (`server/tickets.ts`):**

- **When:** converting, each state change that changes the customer label, and a type change. A move between two states with the same customer label adds nothing.
- **What:** a public `ticket_status` event with only the number, type name and customer label (plus the author name every teammate part carries).
- **In the messenger:** "Ticket #12 (Bug report): Received". The teammate's timeline shows the same line as "Customer sees: …".
- **Delivery rule:** a customer can now only see these system events: `human_joined` and `ticket_status` (`server/delivery-policy.ts`). Any other system event stays with teammates, even if it was marked public by mistake.

**Back-office tickets and trackers are internal conversations (`server/ticket-links.ts`):**

- **Created through `POST /v1/agent/tickets` (`op: "create"`),** which is safe to retry.
  - A back-office ticket needs its originating conversation (`TICKET_ORIGIN`). A tracker can be created on its own or from a conversation, which it is then linked to.
  - The new conversation has no customer identity, `visibility='internal'`, channel `internal`, and "Back-office" or "Tracker" as its name, so it shows that way in views.
- **Guards:**
  - Replies are refused (`INTERNAL_TICKET`: "This ticket has no customer to reply to. Add an internal note instead."); notes work.
  - Customers can't be added as participants, and internal tickets can't be merged.
  - Customer access to an internal conversation is refused even with a matching brand, and the messenger's list query excludes internal conversations explicitly.
  - Customer conversations can't be "converted" into back-office or tracker tickets (`TICKET_CATEGORY`).
- **Back-office progress:** each state change leaves an internal `linked_ticket_state` event on the originating conversation. The customer sees nothing.

**Linking:**

- The `ticket_link` and `ticket_unlink` commands work on a customer conversation. Linking twice does nothing, and internal conversations can't be linked (`TICKET_LINK`).
- A tracker holds at most 5,000 linked conversations (`TRACKER_FULL`).
- Both sides get internal events.
- `ticket_link` is also a macro and bulk action; bulk undo unlinks.
- `GET /v1/agent/tickets` lists open trackers.

**Broadcasts (`op: "broadcast-prepare"` / `"broadcast-commit"`, `GET /v1/agent/ticket-broadcast`):**

- **Prepare:** snapshots the linked conversations. Open and snoozed ones will receive it; closed ones are recorded as skipped. It returns both counts for the confirmation.
- **Commit:** safe to retry, and must happen within 10 minutes of preparing. It queues `ticket.broadcast`, registered in the Worker and the local relay.
- **The job:** each step sends the message to 25 conversations as a public reply from the teammate, through the ordinary reply command. Each reply has its own idempotency key and savepoint, so a redelivered step sends nothing twice and one failure stops nothing else. With "close after", each conversation is then closed; if a close is refused (for example a ticket missing a required field), the reply stays sent and the reason is reported.
- **Privacy:** each customer gets an individual reply in their own conversation. The tracker's title and timeline stay internal.

**Bulk undo wording.** A ticket state that can't be moved back is now counted separately ("could not be moved back") instead of as "changed since and left alone".

**UI:**

- **On a customer conversation:** the sidebar's Ticket section offers "Create back-office ticket" and "Link to tracker", and lists linked tickets, which open when clicked.
- **On a back-office ticket or tracker:** it lists linked conversations (up to 50, with the total), with "Unlink" on trackers.
- **Broadcasting:** a tracker offers "Broadcast update…": message, "Close linked conversations after sending", review ("Send this as a reply to 2 conversations? 1 already closed will be skipped."), then pushed progress and a result listing anything that needs attention.
- **Palette and bulk bar:** "Create tracker ticket" in the command palette; "Link to tracker" in the bulk bar.
- **Timeline wording** for the new events.
- **Bundle:** the agent bundle grows by 2 KB gzip (236 to 238 KB).

**Seed data.** The local relay adds a Refund approval back-office type and an Incident tracker type.

## 2. Files

| File | Change |
|---|---|
| `db/postgres/0023_ticket_links.sql`, `db/rollback/0023_ticket_links.sql` | Visibility, links, broadcasts |
| `server/ticket-links.ts` | Internal tickets, linking, trackers list, broadcasts, sidebar links |
| `server/tickets.ts` | Customer status events, back-office progress notes, links in the context |
| `server/conversations.ts`, `server/delivery-policy.ts` | Link commands; guards for internal conversations; system-event allowlist for customers |
| `server/api.ts`, `server/agent-bridge.ts`, `workers/relay.ts`, `scripts/local-relay.ts` | Routes, bridge, job handler, seed |
| `server/macros.ts`, `server/bulk.ts` | `ticket_link` action and undo; separate count for undos that couldn't be applied |
| `agent/tickets.tsx`, `agent/sidebar.tsx`, `agent/timeline.tsx`, `agent/bulk.tsx`, `agent/inbox.css`, `components/relay/postgres-inbox.tsx`, `messenger/frame.tsx`, `messenger/strings.ts` | UI |
| `tests/ticket-links.test.ts`, `tests/browser/ticket-links.spec.ts`; `tests/tickets.test.ts`, `tests/browser/tickets.spec.ts` updated | Coverage below |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 30 September 2026:

- **Node:** 44/44 pass. `tests/ticket-links.test.ts` covers:
  - **What customers see:** exactly three status updates for four state changes (two states share "In progress"), and none of the internal state names, field values or internal event names.
  - **Back-office tickets:** the internal record (no identity, internal visibility); origin required; replies, conversion and merging refused; the originating customer can't open it; its progress is noted internally on the origin.
  - **Linking:** a standalone tracker; linking twice does nothing; internal and non-tracker links refused; another workspace refused (404) and sees no trackers.
  - **Broadcast counts:** 3 sending and 1 skipped; a repeated commit returns the same job; a second commit is refused.
  - **Broadcast delivery:** a redelivered step sends nothing twice (each customer has exactly one reply); a ticket missing a required field is sent the message but not closed, with the reason reported; the tracker's title never reaches a customer.
  - **Bulk:** bulk link and its undo; unlinking.
- **Typecheck and lint:** clean on the changed files.
- **Browser:** 32/32 pass. `tests/browser/ticket-links.spec.ts`:
  - **Happy path:** a tracker created from the palette; two customers' conversations linked from their sidebars; a broadcast with "close after" reviewed as "2 conversations" and reported "Sent to 2 conversations. Closed 2 conversations."; each customer's messenger shows the update once and nothing about the tracker.
  - **Failure path:** converting shows "Ticket #N (Refund request): Submitted" in the messenger; a back-office ticket refuses a reply with the explanation; approving it notes the origin internally; the customer sees none of it.
  - The A1 browser test now expands the timeline's folded updates, because converting adds two events.

## 4. Deferred and known gaps

- **Broadcasts are plain text.** They have no rich text, variables or attachments, and send to all linked open and snoozed conversations with no per-conversation opt-out.
- **The macro editor has no "Link to tracker" option.** The server accepts it, so macros saved through the API work.
- **A tracker's own state changes notify no one.** Broadcasts are the customer-facing channel.
- **There's no inbox view filter for internal tickets yet.** They appear in views like other conversations, named "Back-office" or "Tracker". Ticket filters can join B2's SLA sort.
- **Not yet built:** email or push delivery of ticket status to customers (not built anywhere yet), and the customer portal (step C).
- **Still open from phase 04:** a new teammate's first list stays empty until the page reloads (see `docs/AGENT_INBOX_STEP11.md` §4).
