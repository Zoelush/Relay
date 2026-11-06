# Phase 16, step C8b: full and limited seats

Branch `billing/c8b-seats`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decision 32). This completes C8 (C8a was plans and the one gate). No new dependency.

## What it does

**Two kinds of seat:**
- **A full seat** is paid, and can do everything the teammate's role allows.
- **A limited seat** is free on every plan, in any number. It reads conversations opened from a link, a mention or a notification, writes internal notes, and sees reports.
  - **No lists:** it has no conversation lists, views, counts or search.
  - **No replies or assignment,** whatever the role.
  - **In the inbox:** a banner says "Limited seat · open conversations from a link, a mention or a notification", and the composer offers internal notes only.
- **New teammates** get a full seat: invited, or joining through single sign-on.
- **The owner** always has a full seat.

**Conversation links:** `/agent#conversation/<id>` opens a conversation in the inbox, for anyone who can read it. It's how a limited seat reaches one.

**Settings › Billing › Seats** (for who manages billing):
- **This period:** the full seats now and limited seats now; the full seats at the start of the period, each charged for the whole period; each full seat added since then, with its prorated share; and the full seats carried into the next period.
- **Amounts** show as "Price not set" while prices are placeholders.
- **Changing seats:** every teammate's seat can be changed there, and each change is recorded.

**Proration:**
- **An addition:** a full seat added mid-period is charged for the rest of the period, by the second.
- **A removal:** one moved to a limited seat stays paid until the period ends, with no credit, and stops counting from the next period.
- **No double charge:** a teammate already paid for this period isn't charged again when moved back to full.

**Removing a teammate** isn't built yet. Moving them to a limited seat frees their full seat, and the People page says so.

## How it works

**`lib/seats.ts`** (pure, for the server and C10's invoices):
- **`LIMITED_CAPABILITIES`:** reading conversations and contacts, notes (and deleting one's own), and reports.
- **`periodOf`:** monthly billing periods from the anchor, clamped to short months.
- **`seatBill`:** a period's full seats at its start, its prorated additions, and the full seats for the next period, from the seat ledger.

**The seat ledger, `seat_changes`:**
- **Append-only:** it's written by a trigger on `teammates`, in the change's own transaction, when a teammate joins or their seat changes.
- **What it keeps:** the from and to seat, the time and the transaction's actor.
- **Not counted:** proration is computed from it, never counted.
- **The period:** it runs monthly from `workspace_plans.period_anchor`, which C10's subscriptions will own.

**The policy (`server/policy.ts`):**
- **`authorize` and `can`** grant a limited seat only `LIMITED_CAPABILITIES`, whatever its role.
- **`scopeSql`** is `false` for it, so every list, count and search it reaches is empty.
- **`visibleTo`** still lets it open a conversation.
- **Views and counts:** the saved views snapshot and the status counts are empty for it, and so are the inbox's counters.

**`server/seats.ts`:**
- **`readSeats`:** the page.
- **`changeSeat`:** `billing.manage` only, and the owner can't be limited. The ledger and the audit log ("Teammate changed") are written by the database.
- **Prices** come through `seatPrice` in `server/plans.ts`, the one gate.

**Wiring:**
- **The route:** `seats` (GET and POST, `billing.manage`).
- **The page:** `agent/settings-seats.tsx` (`#settings/seats`, in Billing).
- **The inbox:** the snapshot's `limitedSeat`, the banner, note-only composing, and the `#conversation/<id>` link.

**Migration `0093_seats`:**
- **`workspace_plans.period_anchor`.**
- **`seat_changes`,** with its trigger and its append-only guard. Teammates already here get their seat as of the period's start.
- **Its rollback** stops the ledger being written and moves limited seats back to full, since the earlier code limits them in nothing. The ledger's rows stay.

`seat_changes` holds teammates' names, not customers' data, so it's listed in `NO_PERSONAL_DATA`.

**Seed data:** every teammate already here on the seat they had; the ledger starts at the migration.

## Checks

- **`tests/seats.test.ts`:**
  - **Periods:** from the anchor, clamped to short months.
  - **`seatBill`:**
    - **The start:** two full seats at the start.
    - **Additions:** a mid-period addition is charged half, and one added then removed keeps its share.
    - **No credit:** a removal is never credited.
    - **No double charge:** a teammate moved back to full in the same period isn't charged again.
    - **A limited seat** is free.
    - **The next period** counts three full seats.
    - **Amounts** appear only with a price.
  - **The ledger:**
    - **Joins are recorded** (the owner too).
    - **Changing a seat:** `billing.manage` only, and the owner stays full. The change is recorded with its actor and audited.
    - **It can't be edited.**
  - **A limited seat:**
    - **Empty:** no list, counters or views, and search finds nothing (it finds the conversation for a full seat).
    - **What it can do:** it opens a conversation by its id, and writes a note.
    - **What it can't do:** reply or assign, nor use macros, even though its role can.
    - **Back on full,** its list returns.
  - **The Seats page:** a teammate added three days into the period shows its prorated share, with no amount while prices aren't set. An agent is refused, another workspace has its own seats, and nothing crosses over.
  - **Rollback:** limited seats are back to full, and the ledger is no longer written.
- **`tests/settings.test.ts`** lists Seats for owners.
- **`tests/browser/seats.spec.ts`:**
  - **Happy path:** a manager gives Grace a limited seat. Her inbox shows the banner and no conversations, but a `#conversation/<id>` link opens one to read, with no reply box. Back on a full seat, her list returns.
  - **Failure path:** the owner's seat can't be changed, and the API refuses with "The owner always has a full seat.". A limited seat doesn't see the Seats page, and the API answers 403.
- **`tests/permissions-matrix.test.ts`** covers the route. **`tests/erasure.test.ts`** passes.
