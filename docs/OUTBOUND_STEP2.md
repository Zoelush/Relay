# Phase 13, step O2: The engine, and in-app chat messages

Branch `outbound/o2-engine-chat`. Plan: `docs/OUTBOUND_PLAN.md` (scope: O1 to O3). Behind `outbound_v1` (and `segments_v1`), off by default and on for the local relay. Next: O3, the Outbound area and banners.

## What it does

The engine every outbound message goes through, and its first type: the in-app chat message. O2 is the engine and its API; the Outbound area to build messages in is O3.

**A message:**
- **Versions:** each has a draft and immutable versions. Publishing makes a new version, now or at a scheduled time, and the version in force is the latest whose time has come. A contact who entered a message stays on the version they entered: an in-flight message doesn't change under them.
- **Audience:** a segment (predefined or saved; an archived one reaches nobody) and the message's own rules (O1's), plus send-time rules checked on the page: its address (is, contains, starts with, doesn't contain), the device (desktop or mobile), the language, and whether they have an open conversation.
- **Delivery:**
  - **once:** the audience when it goes live, fixed. The sweep enters it in batches of 500 (`outbound.launch`).
  - **ongoing:** whoever matches, when they visit.
  - **event:** an event enters them, after a delay.
  - **recurring:** daily or weekly at a time, each occurrence once, never one from before its version went live.
- **Re-entry:** once ever, once every N days, or every time. "Every time" needs the message's own cap.
- **Start and stop times,** and **pause, resume and archive.**
- **A subscription type,** always; an in-app message needs an in-app type. There's no way round it.
- **A goal:** an event within N days of entering.
- **A holdout:** 0 to 50% of the audience, chosen by a stable hash of the person and the message. They enter but are never sent it, and the goal is measured on both groups.
- **What stops it going live is said in words,** the first refusing the publish ("An in-app message needs an in-app subscription type.").

**The decision, per person** (`admit`, one transaction):
1. **The lock:** their lock row is taken (`FOR UPDATE`), so when many messages match at once, the decisions are one at a time.
2. **Re-entry:** an entry already decided by its re-entry key isn't decided again.
3. **The holdout:** entered, not sent.
4. **Subscription:** not subscribed to its type means suppressed ("Not subscribed to Tips."), recorded.
5. **Waiting:** quiet hours in their timezone (else the workspace's), the workspace's cap across all outbound, and the message's own cap all make the entry wait, with the reason recorded.
6. **Delivery:** the type delivers it, and the ledger says so.

**The in-app chat:**
- **When it's delivered:** when the messenger asks what's due (after boot, and on each page change), at most one per page view. Entries waiting for them (fixed audiences, events, occurrences) come first, on their version; then ongoing messages they match now.
- **What it is:** a conversation from its sender (a teammate), created closed so it isn't anyone's work yet, and unread for them.
- **How it appears:** the messenger opens on it.
- **Their reply** is never refused by the "no replies once closed" rule (an unanswered outbound chat is exempt). It reopens the conversation for the team, as any reply does.

**The ledger** (`outbound_entries`): one row per entry, with its message, version, group (sent or control), status (pending, sent, held out, suppressed), the reason for the last decision, the delivery (channel, conversation, part), and when it was entered, seen, clicked, dismissed and replied to.
- **Seen and replied** come from the messenger (reading the conversation, replying).
- **Clicks and dismissals** arrive with banners (O3).
- **Converted** is worked out from the goal: the goal event within its window after entering.

**The readout:**
- **Counts:** sent, seen, replied, held out, suppressed and pending.
- **The goal for each group,** with the lift said honestly: "Too few to say" until each group has 100 people. Then the difference with its 95% interval: "It helps", "It hurts", or "No clear difference yet". Full A/B testing is O5, if phase 13 goes that far.

**Settings › Outbound › Limits** (managers): the cap across all outbound (default 3 in 7 days), quiet hours (21:00 to 08:00), and the timezone for people whose own isn't known.

## How it works

**Migration `0072_outbound`:**
- `outbound_settings`, `outbound_messages`, `outbound_versions` (immutable), `outbound_entries` (the ledger)
- `outbound_contact_locks` (the row each decision locks), `outbound_occurrences` (each audience snapshot, once)
- `conversations.outbound_message_id`
- row-level security, and the flag
- **The rollback:** the flag goes off and live messages are paused, so nothing more is sent. Conversations and the ledger stay.

**Outbound:**
- **`lib/outbound.ts`:**
  - the definition and `outboundProblems`
  - send-time rules (`sendTimeMatches`, `deviceOf`)
  - `bucket` (the holdout), `inQuietHours`, and `goalReadout`
- **`server/outbound.ts`:**
  - `admit`, the chat's delivery, and `dueInApp`
  - `launchJob` (`outbound.launch`), `outboundOnEvent` (from `recordEvent`), `outboundSweep`, and `lastSlot` (recurring slots in a timezone)
  - `outboundSeen` and `outboundReplied`
  - the API: `outbound`, `outbound-message` (`create`, `save`, `audience` for the live size, `publish` with `at`, `pause`, `resume`, `archive`) and `outbound-settings`

**Elsewhere:**
- **`server/conversations.ts`:** the closed-reply exemption, and replies into the ledger.
- **`server/events.ts`:** events enter event-triggered messages.
- **The messenger:**
  - `POST /v1/messenger/due` (the device from the user agent; the page without its query string)
  - `read` marks a chat seen
  - the loader asks after boot and on each page change, and opens on a chat
  - the frame opens the conversation, passed through its handshake when it isn't loaded yet
- **The Worker and local relay:** the launch job and the sweep.
- **Local relay seed:** "Product tips" (in-app, opt-out) and a live "Welcome to Pro" chat to the Pro users segment (Ada gets it on her next visit, `/?user=ada-demo`).
- **UI:** `OutboundPage` in `agent/settings-outbound.tsx`.

## Trying it locally

Run `npm run dev:relay` and open `/?user=ada-demo` on the host: the messenger opens on the welcome chat. Reply, and it's in the inbox. Messages are created through the API until the Outbound area arrives in O3.

## Checks

- **`tests/outbound.test.ts`:**
  - **The pure parts:** definitions checked with reasons; send-time rules; quiet hours (crossing midnight, a timezone, an unknown one); the bucket (stable, about the right share); the readout (too few, helps, hurts, no clear difference); recurring slots (daily, in London, weekly).
  - **The engine:** off by default, managers only.
    - **Publishing:** what stops a draft is said; an email type is refused for an in-app chat; the live size.
    - **Ongoing:** only the audience, once ever; a closed conversation from the sender, unread for them; seen, then a reply reopens it, both in the ledger.
    - **Send-time rules:** the page, an open conversation, visitors too.
    - **Subscriptions:** someone who said no gets nothing, and the ledger says why.
    - **Caps:** the workspace's across messages, and a message's own with "every time".
    - **Quiet hours:** in the contact's timezone, waiting and then going.
    - **One-off:** a fixed audience, launched once, in flight on its version after a new one is published.
    - **A scheduled edit:** taking over at its time, and refused for the past.
    - **Event-triggered:** after its delay.
    - **Recurring:** once per slot.
    - **The holdout:** a control group entered and not sent, its goal counted, and the honest readout.
    - **Pause and resume.**
    - **Another workspace:** its own messages; a's aren't its.
    - **The rollback.**
- **`tests/postgres/outbound.test.ts`** (`npm run test:postgres`), the phase's acceptance:
  - ten live messages match each of 20 people, and ten page views ask at once, each its own connection on real PostgreSQL
  - every person gets exactly the cap (3), no message twice, and the opted-out person gets nothing
- **`tests/browser/outbound.spec.ts`** (ports 9056 and 9057):
  - **Happy path:** Ada's visit opens the messenger on the welcome chat. Her reply is in the ledger (seen, replied) and in the inbox, after the chat. A reload doesn't send it again.
  - **Failure path:** Grace says no to product tips on her preference page. A tip to all users never reaches her (suppressed, with why), and no conversation is made. A bad timezone is refused in Settings, then the limits save.

## Not included

- **The Outbound area** (list, editor, audience builder, stats): O3, with banners.
- **Clicks and dismissals:** O3, with banners.
- **Goals on an attribute changing:** contact attributes keep no history yet (phase 01's typed values).
- **Email, posts and other types, CSV audiences, A/B tests, series:** O4 and later. The plan stops at O3 for now.
