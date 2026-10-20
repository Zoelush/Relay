# Phase 13, step O3: The Outbound area, and banners

Branch `outbound/o3-area-banners`. Plan: `docs/OUTBOUND_PLAN.md` (scope: O1 to O3). Behind `outbound_v1` (and `segments_v1`), off by default and on for the local relay. This is the last step in the current scope; O4 to O9 wait for customers to ask.

## What it does

**The Outbound area** (`#outbound`, in the strip after People, for managers):
- **The list:**
  - **Views:** All messages, Live, Drafts and Paused, with counts.
  - **A content-type filter:** chats or banners.
  - **Each row:** title, type, state, sent, engagement (replied for chats, clicked for banners), goal reached, and when it was updated.
  - **New message:** a title and a type (chat or banner) opens its editor.
- **The editor** (`#outbound/m/<id>`):
  - **Content:**
    - **A chat:** who it's from, and its message.
    - **A banner:** its text (300 characters), top or bottom of the page, whether people can close it, and an optional button (a label and an https link).
  - **Audience:** a segment (or everyone), its own rules (People's rule editor), and page rules (address, device, language, open conversation). The live count updates as you change it ("12 people match now, then the page rules when they visit").
  - **Delivery:**
    - **When:** once to who matches at launch, ongoing, after an event (with a delay), or daily or weekly at a time.
    - **How often each person gets it:** once, once a period, or every time.
    - **Its own cap,** whether it waits during quiet hours, and start and stop times.
  - **Subscription type** (in-app types only), **the goal** (an event within N days) and **the control group** (%).
  - **What stops it going live,** listed in words. "Set live" (or "Publish changes") saves and publishes, now or at a scheduled time; a refusal says why and the message stays as it was.
  - **Pause, resume and archive.**
  - **Numbers:** sent, seen, and replied (chats) or clicked and closed (banners); the control group, not subscribed, waiting; and the goal with its honest readout.
  - **Versions,** and **who it reached** (the latest 50, each with their group, status and why).

**Banners** (the second type):
- **Delivery:** in-app, when the messenger asks what's due (after boot and on each page change), at most one per page. A new one goes through `admit` like any message: caps, quiet hours, subscription and holdout.
- **How it's shown:**
  - **Once shown, it stays:** on every page its page rules allow, until the person closes it or it stops being live. It's counted once, as one entry.
  - **On the page:** the loader draws it at the top or bottom in its own shadow root, in the brand's colours (`theme.css`), with neutral layout (`banner.css`), so the host page's styles can't reach it.
  - **Its button** opens its https link.
  - **The close button** (if it can be closed) hides it for good.
- **Clicks and closes** are recorded on the person's own entry (`POST /v1/messenger/outbound`). Only their own entries; a banner that can't be closed can't be recorded as closed.

## How it works

**Migration `0073_outbound_banners`:**
- the message type's check widens to `chat` and `banner` (every existing row still passes)
- **The rollback:** live banners are paused, so none is shown again; their rows and ledger stay.

**Outbound:**
- **`lib/outbound.ts`:** `OutboundContent` (a chat's sender, a banner's position, closing and button) and the banner's checks.
- **`server/outbound.ts`:**
  - `dueBanner`, and `outboundAction` (clicked and closed)
  - `prepare` and `tries`, shared with `dueInApp`
  - creating either type, with a message's type kept as made
  - stats with clicks and closes, entries with when they happened
  - the editor's choices: senders, in-app subscription types, segments, events and attributes

**Elsewhere:**
- **Routes:** `POST /v1/messenger/due` now also returns `banners`; `POST /v1/messenger/outbound`; the `outbound` capability.
- **The loader:** `showBanner` and `report` (sent with `keepalive`, so a click that navigates away is still recorded); `due` runs on every page change.
- **UI:**
  - `agent/outbound.tsx`
  - People's `RuleEditor` reused
  - the Outbound strip entry and its routes in `components/relay/postgres-inbox.tsx`
  - layout styles in `agent/inbox.css` (tokens only)
- **Local relay seed:** a "Maintenance tonight" banner draft, to try.

**The banner's shadow root is open,** unlike the launcher's. A banner holds only public text, and tools that read the page (tests, assistive software) can reach it; the host's styles still can't.

## Trying it locally

Run `npm run dev:relay`, then:
1. Open Outbound, then "Maintenance tonight", and choose "Set live".
2. Open the host page as a customer (`/?user=grace-demo`): the banner is at the top.

## Checks

- **`tests/outbound.test.ts`** (added to O2's):
  - **Banner checks:** text length, https button, its label, its position.
  - **Through the API:** a banner made; its type can't change; set live.
  - **Showing:**
    - not on a page its rules exclude
    - shown once and counted once, the same banner on the next page
    - clicks and closes only by its person (not another person or workspace)
    - closed means gone for good
    - one that can't be closed stays, and its close is refused
    - paused means not shown
  - **Numbers:** sent, seen, clicked and closed.
  - **The editor's choices:** only in-app subscription types.
- **`tests/browser/outbound-area.spec.ts`** (ports 9058 and 9059):
  - **Happy path:** a manager filters the list to banners, opens the seeded draft, sees its audience counted and sets it live (version 1). A customer sees the banner at the top of the site, follows its button (recorded) and closes it (recorded, and gone after a reload). The message's numbers show 1 sent, 1 clicked and 1 closed, and who it reached.
  - **Failure path:** a new banner can't go live without its text, nor with an http button. Each refusal says why, and it stays a draft.
- **O1 and O2's checks,** including the burst on real PostgreSQL, still pass.

## Not included

- **Saved views of messages** (Intercom's "Latest" and "Recent drafts"): the built-in views and the type filter cover the list for now.
- **A visual preview of a message on a page:** the banner shows on the site itself once live.
- **Posts, email, news, surveys, tooltips, checklists, tours, A/B tests and series:** O4 to O9, outside the current scope.
