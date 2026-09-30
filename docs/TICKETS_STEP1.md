# Tickets — step A1 handoff (ticket core)

Step A1 is the first step of phase 05 in `docs/TICKETS_PLAN.md`. Step A2, ticket categories and linking, is next.

## 1. What changed

**Migration 0022 (`db/postgres/0022_tickets.sql`).** New tables, all with workspace row-level security:

- `ticket_types`: name, icon, category (customer, back-office or tracker), description and version.
- `ticket_states`: each type's own states. Each has a name, a customer-facing label, and one of four kinds: submitted, in progress, waiting on customer, or resolved. State ids are `<type id>.<key>`.
- `ticket_transitions`: the allowed moves between a type's states.
- `ticket_type_attributes`: which conversation attributes are the type's fields, and which must be filled before closing.
- `tickets`: the record attached to a conversation, with a per-workspace number, type, state and version.
- `ticket_counters`: the next ticket number per workspace.

Composite foreign keys ensure a ticket's state belongs to its type. The migration also:

- grants the new `tickets.manage` capability to every role that already holds `workspace.manage`
- adds the `tickets_v1` flag, off, for every workspace

The rollback turns the flag off and drops nothing.

**Ticket types (`server/tickets.ts`, `GET` and `POST /v1/agent/ticket-types`).** Defining a type needs `tickets.manage`, and the whole definition is checked before anything is stored:

- 1 to 30 states, with unique keys and names
- at least one resolved state and at least one that isn't
- transitions only between the type's own states
- **every open state has a path to a resolved state**
- fields that are active conversation attributes

Other rules:

- The category can't change after creation.
- Saving a type requires its current version (`TICKET_TYPE_CONFLICT` otherwise).
- A state that tickets are currently in can't be removed (`TICKET_STATE_IN_USE`). Other removed states are archived, so history keeps their names.
- Types can be archived.

**Commands** (through the existing `/v1/agent/command`, so the teammate's permissions, idempotency keys, realtime and unread tracking all apply):

- **`ticket` (convert):** a customer ticket type and a starting state that isn't resolved.
  - Back-office and tracker types are refused (`TICKET_CATEGORY`) until A2 links them.
  - A conversation can only become a ticket once (`TICKET_EXISTS`).
- **`ticket_state`:** only along the type's transitions (`TICKET_TRANSITION`, with a message such as "A Bug report ticket cannot move from New to Fixed.").
- **Required before closing:** moving to a resolved state, or closing the conversation, needs the required fields. Otherwise it's refused with `TICKET_FIELDS_REQUIRED` ("Fill in Severity before closing this ticket."), and the error's new `details.fields` lists the missing fields.
- **`ticket_type`:** changes type within the same category, with a preview (`GET /v1/agent/ticket-preview`).
  - The preview says which fields are kept (both types have them), moved (to a compatible field of the new type, if the teammate asks), and cleared, and shows each cleared value.
  - Applying requires the preview's token, which is tied to the ticket's version. If the ticket changed after the preview, the change is refused as stale (`TICKET_PREVIEW_STALE`).
  - Cleared values are kept in the internal timeline event, so nothing is lost without a record.
- **Every change is a timeline event:** `ticket_created`, `ticket_state_change` and `ticket_type_change`, recorded as internal system events.

**Ticket fields.** Fields are ordinary conversation attributes linked to a type. Linked fields:

- appear in the ticket section instead of among the general attributes
- can only be set on a ticket whose type has them (`TICKET_FIELD`)

**Other guards.** Merging a ticket into another conversation is refused (`TICKET_MERGE`), because it would detach the ticket. Merging a conversation into a ticket is allowed.

**Macros and bulk actions.** `ticket_state` is now a working macro and bulk action, replacing the `TICKETS_UNAVAILABLE` refusal:

- On a conversation that isn't a ticket, it fails like any refused action: a macro is refused whole, and bulk actions record that conversation as failed.
- Bulk undo moves the ticket back only if the type's transitions allow it. Otherwise that conversation is reported as left alone.

**Sidebar (`agent/tickets.tsx`, `agent/sidebar.tsx`).** A Ticket section appears when the flag is on:

- **Not a ticket yet:** "Convert to ticket" (choose a type and starting state).
- **A ticket:**
  - the number, type and a state badge
  - "Move to", offering only the allowed next states
  - the type's fields, with required ones marked "Required to close"
  - a refused closure is explained inline, and the missing fields are highlighted
  - "Change type…" opens a dialog listing what will be kept, moved and cleared, with a "Move to…" choice for each cleared field; the change applies only from that preview

The timeline describes the new events. The macro editor and bulk bar offer ticket states as "Type: State". The agent bundle grows by 2 KB gzip (233 to 236 KB).

**Seed data.** The local relay turns tickets on (`tickets: false` turns them off) and adds two customer types:

- **Bug report:** New → Investigating ⇄ Waiting on customer, Investigating → Fixed and back. Severity is required before closing; affected version is optional.
- **Refund request:** Submitted → Reviewing → Refunded. Refund amount is required; refund reason is optional.

They use four new conversation attributes, so the D2 sample attributes stay general. Deployed workspaces keep the flag off.

## 2. Files

| File | Change |
|---|---|
| `db/postgres/0022_tickets.sql`, `db/rollback/0022_tickets.sql` | Tables, capability, flag |
| `server/tickets.ts` | Types, conversion, transitions, required fields, type change, sidebar context |
| `server/conversations.ts` | `ticket`, `ticket_state` and `ticket_type` commands; close, attribute and merge guards; `append` exported |
| `server/api.ts`, `server/agent-bridge.ts`, `server/context.ts` | Routes, bridge access, ticket block in the context, error `details` |
| `server/db.ts`, `server/policy.ts`, `server/people.ts` | Error details, `tickets.manage`, flag seed |
| `server/macros.ts`, `server/bulk.ts` | Ticket state action, with apply and undo |
| `agent/tickets.tsx`, `agent/sidebar.tsx`, `agent/timeline.tsx`, `agent/macros.tsx`, `agent/bulk.tsx`, `agent/inbox.css`, `components/relay/postgres-inbox.tsx` | UI |
| `scripts/local-relay.ts` | Sample types, local flag |
| `tests/tickets.test.ts`, `tests/browser/tickets.spec.ts`; `tests/macros.test.ts`, `tests/bulk.test.ts` updated | Coverage below |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 30 September 2026:

- **Node:** 43/43 pass. `tests/tickets.test.ts` covers:
  - **Flag:** off by default.
  - **Defining types:** only `tickets.manage` may define them; five invalid definitions are each refused with nothing stored; version conflicts; a fixed category.
  - **Workspaces:** another workspace sees no types, can't move a ticket (404), and can't use another workspace's type.
  - **Converting:** field guard before conversion; category and starting-state rules; a retried conversion returns the same result and a new one is refused; numbers 1 and 2.
  - **Sidebar data:** next states and fields, with ticket fields kept out of the general attributes.
  - **States:** transitions enforced; resolving and closing refused with the missing field named in `details`, then allowed once filled; timeline events are internal; a state in use can't be removed.
  - **Changing type:** kept, cleared and moved fields; an incompatible move refused; a stale preview refused; values moved and cleared in both stores; the cleared values recorded in the event.
  - **Merging:** refused for a ticket.
  - **Macros and bulk:** a macro setting ticket state, and refused whole on a non-ticket; bulk ticket state with one failure, then undone.
- **Typecheck and lint:** clean on the changed files.
- **Browser:** 30/30 pass. `tests/browser/tickets.spec.ts`:
  - **Happy path:** convert to Bug report #1; only "Investigating" is offered from New; resolving is refused until Severity is checked, then Fixed; the timeline shows each change.
  - **Changing type:** "Change type…" lists Severity and Affected version as cleared; moving Affected version to Refund reason shows it as moved; after the change, the ticket is a Refund request in Submitted, the reason holds "2.1", and the timeline notes what was cleared.
  - **Failure path:** E on a Refund request without a refund amount is refused with the message, and the conversation stays open.

## 4. Deferred and known gaps

- **No settings screen for ticket types yet.** Types are defined through the API (and the local seed). The route validates everything a settings screen would send.
- **Customers see nothing of tickets yet.** Ticket events are internal. Customer-visible state updates (using each state's customer label) come with the categories in A2; the portal is step C.
- **Back-office and tracker tickets** can be defined but not created until A2.
- **Bulk undo of ticket state** can't go back where the type has no transition back. Such conversations are reported as "changed since and left alone", which is imprecise wording for this case.
- **Views can't filter or sort by ticket type or state yet.** Sorting by SLA time remaining comes in B2; ticket filters can join it.
- **Still open from phase 04:** a new teammate's first list stays empty until the page reloads (see `docs/AGENT_INBOX_STEP11.md` §4).
