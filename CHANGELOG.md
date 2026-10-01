# Changelog

## Unreleased: dark mode and the account menu for the agent app

- **An account menu** in the sidebar's lower corner:
  - your initials, name, role and status (and your email where the sign-in provides it)
  - **Away** and **Reassign replies** switches (moved from the top bar's status dropdown)
  - the workspace, a read-only **Your profile** panel, the theme, and **Sign out** where the hosting sign-in supports it

  A refused status change springs back with the reason.

- **A theme switch** (in the account menu): System, Light or Dark. It covers the whole agent app: the inbox, conversations, composer, sidebar, dialogs, bulk actions, Knowledge and help center settings. Light stays the default; System follows the device live, and the choice is remembered in the browser. Dark is neutral near-black, with green only for accents.
- **Readable in both themes:** every text and background pairing meets WCAG AA. A test checks this from the stylesheet, and a browser test measures every visible piece of text as rendered.
- **Light theme accessibility fixes:** muted text, form field borders, note text on the pressed note tab, and the empty-inbox icon now meet AA (they were below it). The mention list now uses the app's font.
- **Tests:** `tests/agent-theme.test.ts`, `tests/browser/dark-mode.spec.ts` and `tests/browser/account-menu.spec.ts`. Details: `docs/AGENT_DARK_MODE.md`.

## Unreleased: knowledge step C1a (files and images)

- **Upload files to Knowledge:** PDF, Word (.docx), HTML, Markdown and text, up to 20 MB. Each becomes a file record whose content is the text read from it, published and searchable once the file passes a type check and a virus scan.
- **Clear reasons when a file can't be used:** blocked by the scanner, the contents don't match the type, a password-protected PDF, a scan with no text, or a damaged file.
- **Managing files:** replace a file with a new version (the old one stays live until the new one is read), download it, or remove it. Knowledge search now finds content as well as titles.
- **Images in articles:** PNG, JPEG, GIF and WebP up to 5 MB.
  - Each is scanned and needs a description, and an article can't be published while an image is still being checked.
  - The help center shows only images of articles the visitor may read; the messenger uses one-hour signed addresses.
- **Help center theme:** a logo, a favicon and a social image for shared links.
- **Fixed:** the local relay refused agent requests over 24 KB, so long articles couldn't be saved locally. Images inside callouts and tables escaped the publish check.
- **Migration** 0033 (`knowledge_files`) with rollback. **Tests:** `tests/knowledge-files.test.ts` and `tests/browser/knowledge-files.spec.ts`. Details: `docs/KNOWLEDGE_STEP5.md`.

## Unreleased: knowledge step B2 (search and feedback)

- **Help center search:** language-aware stemming, accents ignored and typo tolerance ("pasword" finds "password"), ranked by title, then text, then closeness, showing only what the visitor may read in their language. It's in every help center header and the homepage, and works without JavaScript.
- **The messenger's Help space is live:** browse collections, search, and read articles inside the messenger.
- **"Was this helpful?"** on every article, in the help center and the messenger, with a comment after "No".
- **"Talk to us":** starts a conversation (in the messenger, or the portal for signed-in help center visitors) with the article attached for the teammate. The teammate also sees what the customer searched for. That context is teammate-only and built by the server.
- **"Search before contacting" now works:** a signed, 30-minute search receipt bound to the customer is needed to start a conversation, or coming from an article.
- **Reports:**
  - searches are logged without email addresses or long numbers and kept for 180 days
  - Knowledge shows searches with no results, searches nobody opened a result for, and the articles most often marked "not helpful"
  - each article shows its votes and comments
- **Migration** 0032 (`pg_trgm` and three tables) with rollback. **Tests:** `tests/help-search.test.ts` and `tests/browser/help-search.spec.ts`. Details: `docs/KNOWLEDGE_STEP4.md`.

## Unreleased: knowledge step B1 (the public help center)

- **Public pages:** home, collection, section, article, a 404 page and a sign-in page, rendered on the server with no client script. Behind a new `help_center_v1` flag, off by default. Addresses are `/help/{workspace}/{center}/{language}/…`, or the root of a custom domain already mapped for the portal.
- **SEO:**
  - language-aware canonical and `hreflang` (only languages a page really exists in, plus `x-default`)
  - meta description, Open Graph and Twitter tags
  - JSON-LD for articles, breadcrumbs and FAQs, the FAQ markup only for articles switched on as FAQs
  - a sitemap with language alternates, and `robots.txt` on custom domains
  - "Hide from search engines" adds `noindex` everywhere and empties the sitemap
- **Redirects:** old addresses and unsupported languages give a `301`, and the help center root sends visitors to their language.
- **Access:** a help center can be for signed-in customers only, and articles can be too. Signed in means the portal's verified customer session. Visitors without one get a sign-in page that names nothing, and restricted pages are never cached publicly or indexed.
- **Articles show the full format:**
  - callouts, tables, code, headings
  - privacy-respecting YouTube and Vimeo players
  - internal links that follow renamed addresses
- **Look:** a strict CSP with no scripts, styles allowed by hash, and pages cacheable with an ETag. The theme colour is applied with readable contrast in light and dark mode.
- **The portal** takes the help center's colour and links back to it, and "Your requests" appears in the help center.
- **Fixed:**
  - "Settings saved." and "Address saved." vanished when the article reloaded after saving
  - lists showed an article's alphabetically first language (now the teammate's language, or the help center's default)
- **Migration** 0031 with rollback. **Tests:** `tests/help-site.test.ts` and `tests/browser/help-site.spec.ts`. Details: `docs/KNOWLEDGE_STEP3.md`.

## Unreleased: knowledge step A2 (help center structure)

- **Help centers:** at most one per brand, each with languages, a theme (colour, header, font), a homepage layout (search, collections, featured articles, contact, in any order) and a "hide from search engines" switch. Behind `knowledge_v1`.
- **Structure:** collections with optional sections. An article can sit directly in a collection or in a section, and in several places. Only articles with "Show in the help center" on can be placed; turning it off hides the article but keeps where it was placed.
- **Clean addresses:** for articles (per language, set on first publish and editable), collections and sections (per language) and help centers. Every old address redirects to its current one: chains of renames work, renaming back never loops, and a live address wins over an old one.
- **Missing translations:** these fall back along the language chain (fr-CA → fr → default), with the shown language's page as canonical. `resolvePath` turns a public path into the page to show or a redirect, for step B1 to render.
- **The Knowledge section** gains a Help centers tab: settings, the collection tree with names per language, reordering, archiving, and adding and removing articles. The article editor gains a "Public address" field.
- **Migration 0030** with rollback. New routes: `/v1/agent/help-centers` and `/v1/agent/help-center`. The local relay seeds a help center.
- **Tests:** `tests/help-centers.test.ts` and `tests/browser/help-centers.spec.ts`. Details: `docs/KNOWLEDGE_STEP2.md`.

## Unreleased — knowledge step A1 (knowledge store core and the article editor)

- One knowledge store for everything the help center, the inbox and the AI agent will read: public articles, internal articles, snippets, files and synced pages, each with an owner, an audience, a last-reviewed date and three independent switches (AI agent, help center, inbox). Behind `knowledge_v1`, off by default.
- Internal content can never be offered to the AI agent or the help center (refused by the server and by a database check). Only public articles can be in the help center.
- Each language is drafted and published on its own. Drafts autosave and are protected against overwriting a newer save from another tab or teammate. Every publish is kept as an unchangeable version that can be restored into the draft.
- A Knowledge section in the inbox with an article editor: headings, lists, quotes, code blocks with a language, callouts, tables, YouTube and Vimeo videos, links, and links to other records by id. The server checks every save against the same article format.
- Writing and publishing need the new `knowledge.manage` capability (roles that manage the workspace). Other teammates read published content available to the inbox.
- Migration 0029 with rollback. New routes: `/v1/agent/knowledge` and `/v1/agent/knowledge-record`. The local relay turns knowledge on, with two sample records.
- Deferred: image upload and file and synced-page creation (step C1); chunking and embedding (step C2).
- Tests: `tests/knowledge.test.ts` and `tests/browser/knowledge.spec.ts`. Details: `docs/KNOWLEDGE_STEP1.md`.

## Unreleased — maintenance: open items from phases 04–06

- Fixed: a new teammate's first inbox list looked empty until a reload. The first-visit view list was selecting a shared view before the teammate's own "All open" existed, and keeping it. An automatic selection now moves to "All open"; a teammate's own choice is kept.
- Measured: first-screen speed with SLAs and routing on is unchanged (warm p95 16.6 ms against a 150 ms budget). Commands take 3–12 ms more at p95 (worst 18.2 ms), far below the 200 ms background-job threshold. New `scripts/measure-commands.ts`.
- Tested on real PostgreSQL 17 (`npm run test:postgres`, `embedded-postgres` dev dependency): racing claims never both win, a last slot is never overfilled, and teams sharing members drain in parallel without deadlock.
- Unexpected-error logs now include the error class, the PostgreSQL SQLSTATE code and the source location, never the message or request data. Five full browser runs didn't reproduce the one-off "Relay API failed".
- Fixed: reading older messages, a live update pulled the teammate back to the newest message (and sometimes stopped older history from loading, which made a phase 04 test fail intermittently). The timeline now keeps the reader's place unless they were at the bottom, opened the conversation, or sent something.
- Details: `docs/MAINTENANCE_2026-10.md`.

## Unreleased — routing step C (queue position and one office-hours source)

- One office-hours source: the messenger's availability and next opening now come from the business calendar that applies (team, then brand, then workspace), so holidays and special days count. The old `officeHours` brand setting is no longer read, and its minute-by-minute checker is removed. `openNow` is the helper for phase 11's automations and phase 14's reporting.
- Expected reply time in the messenger while open: the measured median first response (business hours, last 14 days, at least 20 conversations) in plain bands, or the brand's own phrase. Out of hours it shows "We'll reply from …" instead. With no calendar, no hours line is shown.
- Queue position: "You're 2nd in line" for customers waiting in an automatic team inbox, in routing's order, pushed live as the line moves (no polling). Brands can hide it. The phase 03 routing port is implemented.
- Tests: `tests/office-hours.test.ts` and `tests/browser/office-hours.spec.ts` (reply time and a live-updating place in line; a holiday showing when the team is back with no reply promise). 63/63 Node tests, typecheck and 40/40 browser tests pass.

## Unreleased — routing step B (away mode and workload in the inbox)

- Away mode: set your status (Active, Away, Away and reassign replies) from the inbox header, or anyone's with `teammates.manage`. A team can return a member's open conversations to its inbox when they go away. A customer's reply to an away-and-reassign teammate hands the conversation back to its team inbox.
- Returning from away is paced: at most 3 automatic assignments per rolling 5 minutes for 30 minutes, so a backlog isn't dumped on one person.
- "Next conversation" (button, `Shift+N`, palette) claims the first waiting item across your balanced team inboxes (priority, then SLA due, then longest waiting), refused at your limit with the reason.
- Workload: "Workload 3 / 5" in the header, and a Workload panel showing each of your teams' method (explained plainly: round robin ignores limits; balanced respects them and queues the rest), inbox load against limit, waiting count and members' loads. Managers can edit team settings there. Each saved team gets a shared "Team inbox" view.
- Migration 0028 adds presence times and team away and view options. New routes: `/v1/agent/presence`, `/v1/agent/next` and `/v1/agent/workload`. The local relay turns routing on, with Billing balanced.
- Tests: `tests/away-workload.test.ts` and `tests/browser/workload.spec.ts` (away, queue, paced return, Next conversation; refused at the limit). 61/61 Node tests, typecheck and 38/38 browser tests pass.

## Unreleased — routing step A (assignment engine and simulation)

- Team inboxes have an assignment method (manual, round robin, balanced), an inbox limit, an optional ticket limit, whether tickets count toward capacity, and whether round robin includes away teammates. Teammates have their own limits. Behind `routing_v1`, off by default.
- Round robin rotates through active members and ignores limits (by design, and documented). Balanced gives each conversation to the eligible member with the fewest active conversations, only while both the teammate's and the inbox's limits allow; otherwise it waits in the inbox.
- Assignment is atomic in the database (a conditional update plus row locks while capacity is counted), and decisions are a pure function of team state and rotation cursor.
- Waiting conversations are picked up when capacity appears (a close, snooze, reassignment, merge, raised limit, new member or return from away), with a sweep as a fallback. Assigning by hand beyond a limit is allowed, with a warning. A rule-based routing interface is ready for phase 11.
- Migration 0027 adds team and teammate routing columns and two indexes. New routes: `/v1/agent/teams` and `/v1/agent/teammate-limits`.
- Tests: `tests/routing.test.ts` and the acceptance simulation `tests/routing-simulation.test.ts` (20 teammates, mixed limits, random away, 2,000 arrivals: nothing lost, double-assigned or stranded, no limit exceeded, same-seed replay identical). 60/60 Node tests, typecheck and 36/36 browser tests pass.

## Unreleased — tickets and SLAs step C (customer ticket portal)

- A customer portal for verified customers, behind `portal_v1`: "Your requests" (own conversations and customer tickets with their customer labels), each request's messages and status lines, plain-text replies (reopening closed ones), and sign-out. Brand-styled, English and Arabic, light and dark.
- Sign-in with the workspace's signed identity token (a link from the customer's site) or a one-time 60-second code from a verified messenger session, via its new "Your tickets and requests" button. Credentials travel only in the URL fragment. The session is an HttpOnly cookie whose secret is stored as a hash. Anonymous visitors can't use the portal.
- Nothing internal is shown: the messenger's access check and delivery policy apply, back-office and tracker tickets and hidden ticket types never appear, and changes must come from the portal's own origin.
- Settings: visibility (company-wide is stored but acts as "own requests" until phase 01), custom domains routed to a brand (certificates in phase 17), and a per-ticket-type "show in portal" switch.
- Migration 0026 adds `portal_sessions`, `portal_handoffs`, `portal_settings`, `portal_domains` (tenant policy plus a read-only routing policy) and ticket-type portal columns. New routes: `/v1/portal/*`, `/v1/messenger/portal-handoff` and `/v1/agent/portal-settings`. New build: `npm run portal:build`.
- Tests: `tests/portal.test.ts` and `tests/browser/portal.spec.ts` (from the messenger to the portal, status shown, reply seen by the teammate; another customer can't see or open someone else's request). 56/56 Node tests, typecheck and 36/36 browser tests pass.

## Unreleased — tickets and SLAs step B2 (SLAs)

- SLA policies (API only; behind `sla_v1`): ordered, with conditions in the saved-view filter language, targets for first response, next response, time to close and time to resolve, business or all hours, and pause rules (snoozed, waiting on the customer; "in an automation" stored for phase 11).
- Clocks run on real conversations and are recomputed from each conversation's timeline after every change: first response, next-response cycles, time to close (reopening continues) and, for tickets, time to resolve. A policy change keeps the time used and applies the new targets. Clocks pin their calendar version.
- Breaches are recorded once and never cleared: an internal "First response SLA breached (Policy)" timeline event, an `sla.breached` outbox event for phase 11, and a mark on the conversation. They're found by the Worker's per-conversation alarm (now shared with snooze), the sweep and the local relay's check.
- Inbox: the sidebar SLA section with live countdowns ("Due Tue 13:00 · in 1h 42m", "Overdue by 5m", "Paused · 35m left", "Met", "Breached"); "SLA 42m" or "SLA overdue" on list rows; a "SLA due soonest" sort; SLA (overdue or breached) and ticket-type view filters; timeline wording.
- Migration 0025 adds `sla_policies`, `sla_clocks`, SLA columns on conversations and an SLA sort key on view members. New route: `/v1/agent/sla-policies`.
- The local seed adds a "Standard support" policy on the seeded office hours.
- Tests: `tests/sla.test.ts` and `tests/browser/sla.spec.ts` (a countdown met by a reply; a live breach turning the sidebar, timeline and row red and sorting first). 55/55 Node tests, typecheck and 34/34 browser tests pass.

## Unreleased — tickets and SLAs step B1 (business-time engine)

- A new business-time engine that works with whole time periods, exact to the millisecond. Opening hours are local wall-clock times: a skipped hour is never open, a repeated one counts twice. It supports overnight hours, holidays and special days. `dueAt`, `businessBetween` and a pure `clock()` over start, pause, resume and stop events report elapsed, remaining, due time and breach; a clock stopped exactly at its due time has met it.
- Calendars are named and versioned: each publish adds an immutable version, and editing from a stale version is refused. They can be assigned to the workspace default, a brand or a team; resolution is team, then brand, then workspace, then 24/7. New conversations pin the version in force, so later edits don't change their metrics.
- The first-response business-time metric uses the new engine; its results are unchanged apart from being exact to the millisecond.
- Migration 0024 adds `calendars`, `calendar_assignments` and the `sla_v1` flag (off; on in the local relay). New routes: `/v1/agent/calendars` and `/v1/agent/calendar-resolve`.
- Tests: the clock acceptance matrix `tests/business-clock.test.ts` covers office-hours boundaries, holidays, special days, a leap day, half-hour, 45-minute and +14 time zones, daylight saving in London, New York and Lord Howe, overnight hours, snooze, reopen, breach, and 120 generated cases against a minute-by-minute reference. Also `tests/calendars.test.ts`. 54/54 Node tests, typecheck and 32/32 browser tests pass.

## Unreleased — tickets step A2 (categories and linking)

- Customer tickets tell the customer: converting, each change of customer label, and a type change add a messenger line such as "Ticket #12 (Bug report): Received", carrying only the number, type name and customer label. The delivery policy now only lets customers see `human_joined` and `ticket_status` system events.
- Back-office tickets and trackers are internal conversations (no customer identity, `visibility='internal'`). A back-office ticket is created from and linked to its conversation, allows notes only, and notes its progress internally on the origin. A tracker is created on its own or from a conversation.
- Link and unlink customer conversations to a tracker (up to 5,000) from the sidebar, a macro or the bulk bar (bulk undo unlinks).
- Tracker broadcast: one update sent as a public reply to every open and snoozed linked conversation (closed ones skipped), optionally closing them. It runs as a background job, 25 per step, safe to retry, with progress and a list of anything needing attention.
- Bulk undo reports ticket states that couldn't be moved back separately from "changed since".
- Migration 0023 adds `conversations.visibility`, `ticket_links`, `ticket_broadcasts` and `broadcast_items`. New routes: `/v1/agent/tickets` and `/v1/agent/ticket-broadcast`.
- The local seed adds Refund approval (back-office) and Incident (tracker) types.
- Tests: `tests/ticket-links.test.ts` and `tests/browser/ticket-links.spec.ts` (a tracker broadcast reaching two messengers and closing them; a back-office ticket refusing replies and staying invisible to the customer). 44/44 Node tests, typecheck and 32/32 browser tests pass.

## Unreleased — tickets step A1 (ticket core)

- Workspace-defined ticket types (customer, back-office, tracker), each with its own states, allowed transitions and typed fields. A whole definition is checked before saving: at least one resolved state, transitions only within the type, and every open state able to reach a resolved one. Defining types needs the new `tickets.manage` capability.
- Convert a conversation to a customer ticket (numbered per workspace) with a starting state. Move it only along its type's transitions. Resolving, or closing the conversation, is refused until the fields required to close are filled, and the refusal names them.
- Change a ticket's type after reviewing what will be kept, moved to a compatible field, or cleared. The change applies only with that preview's token; cleared values are kept in the internal timeline event.
- Every ticket change is an internal timeline event. Ticket fields appear with the ticket and can't be set on other conversations, and merging a ticket away is refused.
- Macros and bulk actions can set ticket state (bulk undo goes back where the type allows).
- Sidebar: convert, state badge and "Move to", fields marked "Required to close", and a type-change dialog. Timeline wording for ticket events.
- Migration 0022 adds six ticket tables, the capability and the `tickets_v1` flag (off). Errors can now carry `details`.
- The local seed adds Bug report and Refund request types, and turns tickets on locally only.
- Tests: `tests/tickets.test.ts` and `tests/browser/tickets.spec.ts` (convert, move and resolve once filled; change type with a moved field; closing without a required field refused). 43/43 Node tests, typecheck and 30/30 browser tests pass.

## Unreleased — agent inbox step D3 (bulk actions with undo)

- Bulk actions from the saved-views list:
  - **Selecting:** row checkboxes, Shift-click ranges, X for the open conversation, and "Select all N in this view".
  - **Actions:** close, reopen, assign, add or remove a tag, priority and snooze.
  - **Confirming:** the confirmation shows the server's count, at most 5,000 conversations.
- A background job applies 25 conversations per step through the ordinary commands, as the teammate and with their permissions. Each conversation's failure is recorded with its reason without stopping the rest.
- Undo is available for 10 seconds from commit (server time), with a live countdown. Conversations not yet reached are cancelled. A reversing command runs only if the changed field still holds what the bulk action set; otherwise that conversation is left alone and reported as changed since.
- Migration 0021 adds `bulk_operations` and `bulk_items`, with a rollback. New route `POST`/`GET /v1/agent/bulk`, which alone accepts bodies up to 256 KB, so 5,000 ids fit.
- Tests: `tests/bulk.test.ts` and `tests/browser/bulk.spec.ts` (tag three by Shift-click and undo; select all, close, and undo with a conflict; per-conversation failures and an expired undo refused). 42/42 Node tests, typecheck and 27/27 browser tests pass. Flags remain off.

## Unreleased — agent inbox step D2 (context sidebar and app slot)

- A conversation details sidebar showing:
  - the customer, resolved through contact merges: name, emails, phones and external id for teammates with personal-data access, and type, times, time zone and live local time for everyone
  - conversation attributes, editable inline by type through the existing typed command, reverting on rejection
  - up to five of the customer's other recent conversations, across their merged contacts
  - participants
- New route: `GET /v1/agent/context`. No migration.
- The sidebar is open by default on wide screens and toggled with I, "Details" or the palette; the choice is remembered in the browser as a UI preference only.
- The phase-15 app-slot contract (`lib/app-slots.ts`): versioned types, a scoped context, declared capabilities, loading/error/ready states, and a host that refuses undeclared capabilities and other conversations. No app code is loaded, and no cards appear until phase 15.
- Local seed adds three conversation attributes. In development, a customer with an email and two earlier conversations.
- Tests: `tests/context.test.ts` (merges, personal-data gating, same-customer history, attributes, workspaces, app-slot host) and `tests/browser/sidebar.spec.ts` (details, local time, inline attribute save, history navigation, the toggle remembered; an invalid value reverted). 41/41 Node tests, typecheck and 24/24 browser tests pass. Flags remain off.

## Unreleased — agent inbox step D1 (macros)

- Personal and shared macros: a saved reply or note, with variables, plus up to 10 actions (assign, add or remove a tag, priority, snooze preset, close, reopen, set an attribute). Migration 0020 adds the `macros` table.
- Permissions: `macros.use` lets a teammate apply macros and manage their own personal ones. `macros.create`, `macros.edit` and `macros.delete` govern shared macros and are granted only to roles already holding `macros.manage`.
- Variables (customer name, first name and email, conversation title, your name, brand name) are filled on the server as plain text, with fallbacks when a value is empty or the teammate lacks personal-data access. Variables are refused anywhere but a macro body.
- Applying (M, or "Apply macro: …" in the command palette) validates the whole bundle, then runs every action in one transaction as the applying teammate, with their own permissions: any failure rolls back everything. It is idempotent and publishes only after commit. The filled text goes to the composer for review. Ticket actions are rejected whole until phase 5.
- The macro manager edits the name, mode, sharing, rich text with a variable picker, and actions, with version conflicts.
- Fixed keyboard traps found by the browser tests: "Insert variable" kept focus, so a space re-inserted it; and Escape could not close the manager after saving.
- Local seed adds two sample macros per workspace.
- Tests: `tests/macros.test.ts`, variable cases in `tests/rich-doc.test.ts`, and `tests/browser/macros.spec.ts` (create, apply and send; a macro with a removed assignee refused whole). 39/39 Node tests, typecheck and 22/22 browser tests pass. Flags remain off.

## Unreleased — agent inbox step C3b (viewing and writing indicators)

- One routing table for live signals, `fanOutSignal`, now used by both the Worker and the local relay, which previously disagreed.
  - Viewing and a teammate's note typing reach teammates only, never customers.
  - A teammate's reply typing still shows "Someone is typing…" to the customer.
  - Presence reaches teammates only; signals never echo to the sender or cross workspaces.
  - Teammate typing without `mode: "reply"` is treated as a note.
- Viewing: joins are announced both ways, a newcomer learns who is already there, the inbox refreshes every 30 seconds and entries expire after 45, and leaving or a closed socket is announced at once.
- Writing: the composer sends "writing a note" or "writing a reply" at most every 2 seconds, and stops after 4 idle seconds, on send, on a mode switch and on leaving.
- The conversation header shows who is viewing or writing (for example "Grace is writing a note"), and warns "Grace is also replying" while you are in reply mode.
- Fixed: a stop signal used up the 200ms typing throttle, so the next mode's signal after a mode switch was dropped. Only active typing is throttled now.
- Tests: `tests/signals.test.ts` (the whole routing table, joins, refreshes, departures and the throttle regression) and `tests/browser/collision.spec.ts` (two teammates and a customer; departure clears indicators). 37/37 Node tests, typecheck and 20/20 browser tests pass. No migration. Flags remain off.

## Unreleased — agent inbox step C3a (mentions and notifications)

- Notes can @-mention teammates and teams through a keyboard picker in the composer. Mentions are refused in customer replies (`MENTION_IN_REPLY`). The server checks each mention against the directory (`MENTION_NOT_FOUND`), rewrites its label from the directory and derives the plain text as `@Name`.
- Teams expand to their members at send time. Duplicates are removed, and the author is never notified, even through a team. An edited note notifies only newly mentioned people.
- In-app notifications (migration 0019): a bell with a live unread count pushed over the socket, and a panel with who, where and a 140-character excerpt. Opening one goes to the conversation and marks it read; "Mark all as read" and a palette command are also there. Notifications are only ever read with the signed-in teammate's id.
- A Mentions default view for every teammate, through a new `mentioned` filter. Teammates set up earlier get it automatically.
- Local development seeds a second teammate, Grace, in Billing, and a loopback-only `/agent?as=grace` sign-in.
- Tests: `tests/mentions.test.ts`, mention cases in `tests/rich-doc.test.ts`, and `tests/browser/mentions.spec.ts` (live notification between two teammates; a removed teammate's mention refused with the note kept). The views test now expects six default views. 36/36 Node tests, typecheck and 18/18 browser tests pass. One full browser run logged two unexplained server errors that did not recur in five further runs. Flags remain off.

## Unreleased — agent inbox step C2b (inline images)

- Teammates can place PNG and JPEG images (up to 10 MB each, 10 per message) inside replies and notes by button, paste or drag-and-drop. Inline uploads use the existing prepare, upload, byte-check and scan flow but never become separate attachment messages (migration 0018 adds `attachments.purpose` and `conversation_part_images`). The image node holds an attachment id, never a URL.
- At send, each image must be the sender's own clean inline upload in this conversation, and a reply may only use customer-visible uploads. Each failure has its own error: `IMAGE_NOT_FOUND`, `IMAGE_NOT_READY`, `IMAGE_BLOCKED` or `IMAGE_AUDIENCE`. The composer shows uploading, checking, blocked and clean states, and keeps Send disabled until every image is clean.
- Customers can fetch an inline image only once a sent public reply references it, through the messenger's short-lived links. Note images never reach them; the tests cover downloads, history and live replay.
- Unreferenced inline uploads are deleted after 30 days, from storage (R2 `deleteClean`) and the database.
- Local development and browser tests use a new loopback storage adapter, never deployed; its scanner flags the EICAR test file. The local relay now accepts binary uploads.
- Tests: `tests/inline-images.test.ts`, image cases in `tests/rich-doc.test.ts`, and `tests/browser/inline-images.spec.ts` (image decoded in inbox and messenger; blocked image gates Send). 34/34 Node tests, typecheck and 16/16 browser tests pass. Flags remain off.

## Unreleased — agent inbox step C2a (rich text and drafts)

- Rich replies, notes and edits use a restricted document format: paragraphs, lists, quotes, code blocks, line breaks, bold, italic, inline code and links. Links must be https, http or mailto; limits are 5,000 characters, four levels of nesting and 2,000 nodes. The server rebuilds each document from allowed content only, stores it as `data.doc` and derives the plain-text `body` used by search and future plain channels. Customers cannot send documents.
- Documents render as React elements, never as HTML, in the inbox and in the customer messenger (the frame grows from 67.0 to 68.4 KB gzip). Notes stay private; a test places a secret in a note's text, link and code and checks it never reaches the customer.
- The composer is a TipTap 3.31.3 editor with an accessible formatting toolbar, lazy-loaded (about 130 KB gzip) so the list and timeline load first.
- Drafts are server-backed and visible only to their author (migration 0017). They autosave after 800ms, carry a version so another tab's newer save produces a "Keep mine" / "Use the other version" choice, are sent at once when the page is hidden, are kept in memory while offline, are deleted on send, and are purged after 30 days.
- Fixed while testing: a draft that loaded before the editor mounted was dropped; the editor's trailing empty paragraph counted as an edit; and `jsonb` key order made identical drafts compare unequal.
- Tests: `tests/rich-doc.test.ts`, `tests/drafts.test.ts` and `tests/browser/composer.spec.ts`. 32/32 Node tests, typecheck and 14/14 browser tests pass. Flags remain off.

## Unreleased — agent inbox step C1 (timeline and fast actions)

- The timeline gives every system part kind readable text, naming teammates, teams and tags (for example "Ada assigned this to Grace and team Billing" or "Snoozed until Thu 1 Oct, 09:00 BST"), instead of raw kind names. Consecutive system events collapse into an expandable "Show N updates" line. Edited parts are marked.
- Snooze presets (later today, tomorrow 09:00, next Monday 09:00) resolve on the server in the teammate's IANA zone, correctly on daylight-saving days. Custom times need an explicit offset. An optional "unassign when it wakes" flag applies only to the current snooze. Migration 0016 adds `snooze_unassign` and `snooze_timezone`; the rollback keeps them.
- Fixed: snooze versions were compared as strings to PGlite's numbers, so snoozed conversations never woke on the local relay.
- A thread toolbar (close/reopen, snooze, assign to me, priority) with optimistic updates that revert on rejection. Keyboard shortcuts: J/K, R, N, ⌘Enter, Esc, E, Shift E, S, A, P, /, ?, and ⌘K. A command palette covers conversation actions, assignment to any teammate or team, tags and views. Shortcuts are suppressed while typing.
- The inbox snapshot now includes teammates, teams, tags and the `manage` capability. The local seed adds a team and two tags per workspace.
- Tests: `tests/snooze.test.ts`, `tests/timeline.test.ts` and `tests/browser/triage.spec.ts` (keyboard-only triage; rejected snooze). 28/28 Node tests, typecheck and 12/12 browser tests pass. Flags remain off.

## Unreleased — agent inbox step B2 (first screen)

- An inbox conversation now opens on its newest 50 parts instead of replaying its whole history from the oldest part. Older history loads on scroll (100 parts per page) through `GET /v1/agent/history`, with signed per-teammate cursors that a merge invalidates. The live cursor resumes exactly after the first screen, with no gap or repeat. The customer messenger and other agent clients are unchanged.
- The inbox keeps an in-memory cache of 50 conversations, cleared on workspace, teammate or capability change. It prefetches a conversation's first screen after 100ms of hover or focus, one at a time, and keeps the reader's position when older parts load. A failed older page offers Retry.
- Measured locally on an Apple M1 over 10,000 rows, 20 conversations of 500 parts and 10 merged conversations:
  - Warm first screen: p50 9.1ms, **p95 15.6ms** (target: under 150ms).
  - Cold: p50 30.4ms, p95 40.8ms.
  - Scrolling all 9,990 rows: at most 15 rows mounted, no long tasks, frames at 16.7ms.
  - Reproduce with `scripts/measure-first-screen.ts`.
- Fixed in the views list (from step B1): every workspace notification reloaded it from page one, so paging could not get past 200 rows while activity arrived. A stale loading flag and a render-time ref read could also block "Load more". Activity now refreshes only the first page.
- Added `tests/agent-timeline.test.ts` and `tests/browser/agent-timeline.spec.ts`. The views browser test now pages through three pages. A development seed adds a 200-part conversation per workspace. 24/24 Node tests, typecheck and all 6 inbox browser tests pass. No migration. Flags remain off.

## Unreleased — agent inbox step B1 (saved views)

- Views with the same filter now share one conversation list and one count (migration 0015, `inbox_filter_sets`/`inbox_filter_members`). With 200 agents and 10,000 conversations, stored list rows fall from about 2.3 million to 15,000, and projecting 100 changed conversations across 1,005 views takes 101–134ms, down from 6.9s. A view whose filter is already in use is ready at once, with no rebuild.
- List members carry their sort keys, so a view page reads one index range: 5–12ms at 5,000 members, previously 58ms with table statistics and 5.7s without them.
- Counts are maintained by statement-level triggers, one update per list per statement.
- Added a server-side `move` action that renumbers a folder so view positions never collide, and made the UI render views in position order.
- Fixed: saving a view without `shared` or `folderId` un-shared it or removed it from its folder; new views were created at position 0; default views could be made shared; optimistic new views never appeared in the list, and a server refresh during a pending save dropped them.
- Added `tests/inbox-views.test.ts` (filter injection and unavailable filters; tenant, teammate and permission isolation; shared lists; live counts through state changes, merges and snoozes; keyset paging under concurrent inserts; cursor invalidation; search; move; crash-resumed rebuild; exposure rollback) and `tests/browser/inbox-views.spec.ts` (happy path with live counts and full paging; rejected save). Added a two-workspace views seed and `scripts/load-views.ts`.
- All 23 Node tests, typecheck and all 4 agent-inbox/views browser tests pass. The messenger hostile-CSS browser test fails on this branch and on `main`; it is outside this step.
- The "mentions" default view is deferred to step C, which introduces structured mentions. First-screen latency and the 150ms measurement are step B2. Flags remain off.

## Unreleased — agent inbox step 1

- Connected the platform-authenticated inbox to the signed PostgreSQL/Hyperdrive service bridge and WebSocket cursor replay, behind default-off application/workspace flags. Added reply/note optimistic reconciliation and visible storage-source evidence.
- Added migration 0013 for attachment audience/teammate ownership and a database constraint keeping internal notes private. Customer history/replay excludes private notes and files; internal files use authenticated proxy downloads rather than transferable signed GET URLs.
- Preserved the D1 polling UI and added legacy write/seed guards when PostgreSQL has authority. The rollback disables exposure and retains data/privacy; it does not switch writers or reverse-copy data.
- Added two-workspace privacy/isolation and rollback coverage plus browser happy/rejection tests. All 21 Node tests, typecheck, targeted lint, app build and Worker bundle checks pass. Browser tests remain unverified because Chrome launch was blocked by the host; manual browser inspection verified Live/PostgreSQL-local and widget rendering only.
- Recorded approved decisions and local verification in `docs/AGENT_INBOX_PLAN.md` and `docs/AGENT_INBOX_STEP1.md`. Later inbox steps and hosted cutover remain deferred.

## Unreleased — local conversation and messenger foundation

- Added additive PostgreSQL schemas, tenant-scoped transactions with forced RLS, retry receipts, D1 copy verification, source write fences and data-preserving rollback scripts.
- Added minimum brand/people/permission prerequisites, signed identities with two-key rotation, non-destructive contact merge audit and conflict-aware reversal.
- Added immutable typed conversation parts, lifecycle cycles, assignments, participants, merge aliases, superseding edits, typed attributes, search and versioned business-time metrics.
- Added authenticated cursor-based WebSocket replay, ephemeral signals, materialized counters, transactional publication intent, batched fanout and persistent job status.
- Added native Cloudflare Queue/Cron/DO handlers and private R2 upload/scan/preview adapters; no resources were provisioned or deployed.
- Added a lazy iframe messenger, small shadow-root loader, strict-CSP hostile-host demo, RTL/locales, keyboard support, upload/job UI and notification options.
- Added local SQL/HTTP/browser tests, a reproducible load harness, integration documentation and an interface-only mobile SDK specification.
- Fixed verified-contact unread totals across identity merges/reversals and conversation aliases while retaining device-scoped anonymous access. Added additive migration 0011, a resumable backfill job and exposure rollback.
- Fixed live delivery and superseding edits through repeated conversation aliases; persisted local data/keys now survive restart during the 60-second reconnect test.
- Added Hyperdrive runtime-role checks, local job/outbox repair, pushed job completion, localized launcher/notification labels, and explicit route allowlisting.
- Added migration 0012's conversation-scoped unread index and a data-preserving rollback. Consolidated customer command and agent replay authorization transactions; successful immediate fanout now acknowledges its captured outbox entries while preserving failure recovery and later commits.
- Added local connection-wait/transaction profiling, an indexed query plan, and regressions for revoked sessions, disabled flags, wrong origins and outbox acknowledgement races. The isolated 200-agent/5,000-conversation/50-message-per-second rerun reduced server-processing p95 from 720ms to 149ms; delivery p50/p99 is 68/1,082ms. All 3,000 messages rendered without duplicates; hosted/cold-cache acceptance remains unverified.
- Deferred messenger bootstrap to a separate task after the host load event. The host-load check first failed at 63.7ms p95, then measured 29.3ms after the fix; zero layout shift, with resource-timing assertions that bootstrap starts after load completes. The loader is 4,282 bytes gzip.
- Production flags remain off. The D1 app remains the default; the subsequent step-1 change adds explicit write-authority guards. Hosted migration/integration acceptance and the full people/events/segments phase remain incomplete; see `docs/LOCAL_READINESS.md`.
