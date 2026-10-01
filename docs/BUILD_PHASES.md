# Build phases

The eighteen-phase plan for Relay, converted from the "Build Prompts for an Intercom Alternative" page. Phases are numbered 00–17. The phase prompts assume the standing context block is sent first; in Claude Code, `CLAUDE.md` carries those rules instead.

Your MVP came out basic because the brief was "build Intercom," and no model can hold that much surface area in one pass. This document breaks the real thing into eighteen buildable phases and gives you the prompt for each one.

## Phase index

| # | Phase | Ships | Needs |
|---|---|---|---|
| 00 | [Audit and architecture baseline](#phase-00--audit-and-architecture-baseline) | A written report, not code | Nothing |
| 01 | [Tenancy, identity and the people model](#phase-01--tenancy-identity-and-the-people-model) | Workspaces, teammates, contacts, companies, attributes, segments | Phase 0 |
| 02 | [Conversation core and realtime](#phase-02--conversation-core-and-realtime) | The conversation engine every other phase writes to | Phase 1 |
| 03 | [The messenger](#phase-03--the-messenger) | The embeddable widget customers actually touch | Phase 2 |
| 04 | [The agent inbox](#phase-04--the-agent-inbox) | Where your customers' support teams live all day | Phases 2, 3 |
| 05 | [Tickets and SLAs](#phase-05--tickets-and-slas) | Structured work items and the clocks that govern them | Phase 4 |
| 06 | [Routing, teams and workload](#phase-06--routing-teams-and-workload) | Getting the right conversation to the right person, fairly | Phase 5 |
| 07 | [Help center and knowledge store](#phase-07--help-center-and-knowledge-store) | Public self-service, and the corpus the AI will read | Phase 3 |
| 08 | [The AI agent](#phase-08--the-ai-agent) | Autonomous resolution, grounded and measurable | Phases 2, 7 |
| 09 | [AI actions and data connectors](#phase-09--ai-actions-and-data-connectors) | The agent doing things, not just answering | Phase 8 |
| 10 | [Agent copilot](#phase-10--agent-copilot) | The AI helping the human, inside the inbox | Phases 4, 8 |
| 11 | [The workflow builder](#phase-11--the-workflow-builder) | No-code automation over everything built so far | Phases 5, 6, 8 |
| 12 | [Omnichannel](#phase-12--omnichannel) | Email, WhatsApp, SMS, social and voice landing in one inbox | Phase 4 |
| 13 | [Outbound and proactive messaging](#phase-13--outbound-and-proactive-messaging) | Reaching customers before they contact you | Phases 1, 3, 11 |
| 14 | [Reporting and analytics](#phase-14--reporting-and-analytics) | The numbers teams are judged on | Phases 5, 6, 8, 13 |
| 15 | [Developer platform](#phase-15--developer-platform) | API, webhooks and an app framework | Phases 1–6 |
| 16 | [Security, compliance, admin and billing](#phase-16--security-compliance-admin-and-billing) | The things procurement asks about, and getting paid | All prior |
| 17 | [Scale, migration and launch](#phase-17--scale-migration-and-launch) | Surviving real customers, and taking them from Intercom | All prior |

## How to run this

Six rules. They matter more than the prompts themselves.

- **One phase per session, one phase per branch.** Pasting two phases at once is how you got a shallow MVP the first time. The model spreads its attention thin and stubs everything.
- **Always send the standing context block first,** in the same message, above the phase prompt. It is the part that keeps the codebase coherent across sessions.
- **Demand the plan before the code.** Every prompt below ends by asking for a plan first. Read it. If the plan is wrong, the code will be wrong, and reading a plan costs you two minutes instead of two days.
- **Phase 0 is not optional.** The model that built your MVP has no memory of it. Every new session starts blind, and a blind session rewrites working code.
- **Do not skip ahead to the AI agent.** It is the most exciting phase and the most dependent on everything beneath it. An AI agent on top of a weak conversation model produces a demo, not a product.
- **Cut ruthlessly.** The last section of this document lists what to drop if you are building alone. Most of phase 13 and half of phase 12 can wait a year.

Every prompt uses square brackets for things only you know — `[PRODUCT]`, `[STACK]`, `[REPO PATH]`. Fill them in before sending.

## The standing context block

Paste this above every single phase prompt, every session, forever. It is the difference between eighteen features and one product.

**Prepend to every phase**

```text
You are continuing work on [PRODUCT], a customer communication and
support platform. Stack: [STACK]. Repository: [REPO PATH].

Before writing any code in this session:

1. Read the repository. Restate in under 200 words: the stack, the
   directory layout, the data access pattern, the auth model, the
   realtime transport, the background job runner, and the test setup.
2. List every existing table, model and route this phase will touch.
3. Tell me where my request conflicts with what already exists, and
   propose the smaller change before the larger one.

Standing rules for every phase:

- Multi-tenant by default. Every table carries a workspace id. Every
  query is scoped to it. Include a test that proves a cross-workspace
  read fails.
- Additive migrations only. Never drop or rename a column in the same
  deploy that stops writing to it. Always supply the rollback.
- Any write path an external system can retry must be idempotent on a
  client-supplied idempotency key.
- Anything that takes longer than 200ms moves to a background job with
  retries, a dead-letter queue, and a status the UI can read.
- All money, time and counts are computed server-side. The client
  renders, it does not decide.
- Store timestamps in UTC with the originating timezone alongside.
  Every duration that a human will be judged on must be computable in
  business hours as well as wall-clock.
- Ship behind a feature flag, defaulted off.
- Every phase ends with: migration plus rollback, seed data, unit
  tests, one end-to-end test of the happy path, one test of the main
  failure path, and a CHANGELOG entry.
- Do not scaffold features belonging to later phases. If you need
  something that does not exist yet, define the interface, leave a
  TODO, and tell me which phase owns it.
- If a requirement in this prompt is ambiguous, ask me. Do not choose
  silently.

Output in this order: (1) your reading of the current code, (2) the
plan, (3) file-by-file changes, (4) how I run and verify it locally.
Stop after the plan if the plan is longer than you expected and ask me
to confirm scope.
```

## Phase 00 — Audit and architecture baseline

**Ships:** A written report, not code  
**Needs:** Nothing

Every new AI session starts with amnesia. This phase converts your existing codebase into a document the model can be handed at the start of any future phase, and forces the expensive irreversible decisions into the open while they are still cheap.

*Establishes what your MVP actually is, so no later session guesses.*

```text
Do not write feature code in this session.

Audit the repository and produce a written report with these sections.

1. Inventory. Every route, model, service, background job and UI
   component, each with a one-line purpose. Flag anything dead,
   duplicated or obviously generated and unused.

2. Trace. Follow one message end to end: a customer types in the
   widget, an agent sees it, the agent replies, the customer sees the
   reply. Name every hop, the transport at each hop, where state is
   persisted, where it is duplicated, and every place the trace would
   break if a process restarted mid-flight.

3. Gap analysis. Compare what exists against this target surface:
   workspaces and teammates; contacts, companies, custom attributes,
   custom objects, events and segments; conversations with typed parts
   and states; realtime delivery; an embeddable messenger; an agent
   inbox with views, macros and notes; tickets and SLAs; routing and
   workload management; a help center; a knowledge store for AI; an AI
   answering agent; AI actions against external systems; an agent
   copilot; a visual workflow builder; email, WhatsApp, SMS, social and
   voice channels; outbound and proactive messaging; reporting;
   a public API, webhooks and an app framework; SSO, roles, audit log
   and data deletion; seat and usage billing.
   For each: Present, Partial or Absent, plus a one-line note and a
   rough size in engineer-days.

4. Load-bearing decisions. For each of these, state what the code
   currently does, whether it survives 10,000 workspaces and
   50 million conversation parts, and what you would change now while
   it is still cheap: primary key strategy; tenancy model (shared
   tables, schema per tenant, or database per tenant); realtime
   transport; full-text and vector search; the analytics store and
   whether it is the same database as the application; file storage
   and attachment scanning; the job queue and its delivery guarantees;
   internationalisation; timestamp and timezone handling; how
   plan-based feature gating is expressed.

5. Refactors required before phase 1, ordered, each with the reason it
   gets more expensive the longer it is deferred.

Write the report to docs/ARCHITECTURE.md so future sessions can be
handed it directly. Then stop and wait for me. Do not begin the
refactors.
```

## Phase 01 — Tenancy, identity and the people model

**Ships:** Workspaces, teammates, contacts, companies, attributes, segments  
**Needs:** Phase 0

Everything else hangs off this. Get the identity model wrong and you will be writing merge-and-dedupe migrations for years. The specific trap: an anonymous visitor who chats, then signs up, then emails you from a different address, must end up as one person with one history.

*Intercom's core primitives: contacts (users, leads, visitors), companies, custom data attributes, custom objects, events, tags and segments.*

```text
Build the tenancy and people data model.

Entities and behaviour:

- Workspace. The tenant boundary. Owns a timezone, default locale,
  and a settings document. Support brands within a workspace: a brand
  is a customer-facing identity with its own name, logo, colours,
  sending address and, later, its own help center. Design for many
  brands per workspace from the start; retrofitting brands is painful.

- Teammate. A human on the support side. Belongs to a workspace, may
  belong to many teams. Has a presence status (active, away, away and
  reassigning), an availability schedule, a seat type (full or
  limited), and a role.

- Role and permission. Do not hardcode role checks. Build a
  permission registry of named capabilities and a policy layer that
  answers "can this teammate do this action on this resource". Seed
  three roles but make custom roles possible. Capabilities to seed, at
  minimum: reply to conversations, add notes, delete replies, delete
  notes, manage macros, reassign conversations, access reports, create
  and share reports, export data, manage teammates, manage billing,
  manage workspace settings, view contact personal data.

- Contact. One table, with a role field of visitor, lead, or user.
  A visitor is anonymous and identified only by a device or session
  token. A lead has contact details but no verified identity. A user
  is verified by your application. Support: multiple email addresses
  and phone numbers per contact; an external id supplied by the
  customer's own system; last seen, first seen, signed up at; browser,
  device, locale, location; unsubscribed state per subscription type.

- Identity resolution. Implement a deterministic merge: given an
  anonymous visitor who later logs in, merge the visitor into the
  identified user, moving conversations, events and attributes, and
  writing a merge audit record so the merge can be traced and, within
  a window, reversed. Define and test precedence rules for conflicting
  attribute values.

- Company. Contacts belong to many companies with a role on each
  relationship. Companies carry their own attributes, plan, seat count
  and monthly spend, because routing and reporting will segment on
  them.

- Data attribute. A typed, workspace-defined attribute on contacts,
  companies or conversations. Types: string, integer, float, boolean,
  date, list of options. Attributes can be archived but never hard
  deleted. Store the definition separately from the value, and index
  values so segments can filter on them at scale.

- Custom object. A workspace-defined object type with its own typed
  attributes and its own instances, referenceable from a contact,
  company or conversation. This is how customers model orders,
  subscriptions, shipments, policies. Full CRUD plus lookup by the
  customer's own external id.

- Event. A timestamped named action performed by a contact, with a
  free-form metadata document. Events are append-only and
  high-volume; design the write path and retention for that, and keep
  them out of the tables that feed the inbox.

- Tag. Applies to contacts, companies and conversations.

- Segment. A saved filter over contacts or companies. Must support
  nested and-or groups, attribute comparisons, tag membership, event
  occurrence with counts and time windows, and company attributes on a
  contact query. Provide: evaluate to a count, evaluate to a page of
  members, and evaluate membership for a single contact cheaply, since
  targeting and routing will call the last one on every message.

- Subscription type. Named communication categories a contact can opt
  out of independently, plus a global unsubscribe. Every outbound
  message will later be required to declare one.

Added after the Intercom gap audit (docs/INTERCOM_GAP_AUDIT.md):
- Attribute write sources: every contact, company and conversation
  attribute declares whether the API, the messenger and the inbox may
  write it. Company membership and company attributes must be
  lockable against messenger writes, because company-wide visibility
  (the phase 5 portal) depends on it.
- A teammate reference attribute type (for example the owner of a lead
  or user).
- An event-name registry: each name has a description and recent
  usage, can be archived, and the number of enabled names per
  workspace is capped explicitly.
- Company filters on people: state and test the rule that a person
  matches when any one of their companies matches.
- Tags apply to articles and outbound messages as well, in the same
  namespace.
- Blocked contacts: a blocked person cannot send messages; the block
  is audited and reversible.

Acceptance criteria:
- Seed a workspace with 50,000 contacts, 5,000 companies, 20 custom
  attributes and 2 million events, then show me the query plan and
  timing for a segment combining an attribute filter, a tag, and an
  event count in the last 30 days. If it is slower than 500ms, fix the
  indexing before moving on.
- A test proving visitor to user merge preserves all conversations and
  events and leaves no orphan rows.
- A test proving workspace isolation on every new route.
```

## Phase 02 — Conversation core and realtime

**Ships:** The conversation engine every other phase writes to  
**Needs:** Phase 1

The single most important phase. A conversation is not a list of messages — it is an append-only log of typed events, some of which happen to be visible to the customer. Model it that way now and tickets, SLAs, reporting, AI handover and audit all become easy later. Model it as a chat log and all of those become rewrites.

*Conversations composed of typed parts, with states, participants, priority, ratings and a full event timeline.*

```text
Build the conversation core and the realtime layer.

Conversation:
- Belongs to a workspace and a brand. Has one primary contact and
  optional additional participants (the equivalent of cc).
- State: open, snoozed (with a wake time), or closed. Closing and
  reopening are events, not a flag flip — a conversation may open and
  close repeatedly and reporting must count each cycle.
- Carries: channel of origin, assigned teammate, assigned team,
  priority, tags, topics, custom conversation attributes, first
  response time, last contact reply at, last teammate reply at,
  rating, and a title that can be set by a human or generated.

Conversation part (append-only, never updated in place except for the
narrow edit cases below):
- Types: customer message, teammate reply, internal note, AI agent
  reply, assignment change, state change, priority change, tag change,
  participant change, attribute change, rating, attachment, system
  event, channel handover, merge marker.
- Every part records author (contact, teammate, AI agent, or system),
  timestamp, delivery status, and the channel it was delivered on.
- Editing: allow editing and deleting notes and replies as new
  superseding parts with an audit trail, not destructive updates.

Required operations: reply, note, assign, snooze, wake, close, reopen,
change priority, add and remove participants, merge two conversations
preserving both timelines in order, and convert to a ticket (leave the
ticket type as an interface for phase 5).

Realtime:
- One transport for: new parts, typing indicators, presence, unread
  counts, assignment changes, and collision signals ("another
  teammate is replying").
- Delivery must be at-least-once with client-side deduplication on a
  part id, and strictly ordered per conversation. Clients reconnect
  with a cursor and receive everything missed; do not rely on the
  socket being the source of truth.
- Presence and typing are ephemeral and must never touch the primary
  database.
- Unread counts are computed server-side per teammate and per view,
  and must not require counting rows on every render.

Search: index conversations and parts for full-text search scoped by
workspace, with filters on state, channel, assignee, team, tag, date
range and contact. Reindexing must be incremental and resumable.

Attachments: signed upload directly to storage, virus and type
checking, size limits, private URLs with expiry, and an inline preview
path for images.

Acceptance criteria:
- A load test: 200 concurrent agents, 5,000 open conversations,
  50 messages per second sustained. Report p50 and p99 delivery
  latency from write to client render.
- A test where a client disconnects for 60 seconds mid-conversation
  and, on reconnect, its timeline matches the server exactly with no
  duplicates and no gaps.
- A test that merging two conversations produces one correctly ordered
  timeline and that both original ids still resolve.
```

## Phase 03 — The messenger

**Ships:** The embeddable widget customers actually touch  
**Needs:** Phase 2

This runs inside someone else's website, so it has to be paranoid: it cannot leak styles, cannot be styled by the host, cannot let one customer impersonate another, and cannot slow the host page down. The security piece is not optional — without verified identity, anyone can read anyone's support history.

*Intercom's Messenger: spaces for home, messages and help; brand styling; JWT identity verification; web plus iOS and Android SDKs.*

```text
Build the embeddable messenger.

Loader and isolation:
- A tiny async loader script (target under 15KB gzipped) that renders
  only the launcher, and lazily loads the full widget on first open.
- The widget itself renders inside an iframe or shadow root so the host
  page's CSS cannot affect it and it cannot affect the host page.
- Document the exact Content-Security-Policy directives a customer must
  add, and test the widget under a strict CSP.
- Performance budget: no layout shift on the host page, no blocking
  requests, and a measured effect on host page load of under 50ms.

Boot and identity:
- A boot call carrying workspace id, brand, page URL, locale, and
  either an anonymous device token or an identified user payload.
- Identity verification: the customer's server signs a JWT containing
  the user id and email with a workspace secret; the widget passes it;
  the server rejects any identified request without a valid, unexpired
  signature when enforcement is on. Support key rotation with two live
  keys, an enforcement toggle, and a clear error when a stale client
  sends an unsigned request. Support HMAC as a legacy fallback.
- Current page URL updates on navigation, because the AI agent and
  targeting both depend on knowing where the customer is.

Spaces:
- Home: configurable blocks — start a conversation, search help, recent
  conversations, announcements, and custom cards supplied by the
  workspace.
- Messages: the customer's conversation and ticket history, with
  unread state and titles.
- Help: in-widget article search and reading, with the article view
  able to hand off to a conversation carrying the article as context.

Behaviour and configuration, all per brand:
- Colours, logo, launcher shape and position, light and dark, custom
  launcher element on the host page.
- Team introduction, expected reply time derived from office hours, and
  an out-of-hours message.
- Whether visitors may start conversations, whether search is required
  before starting one, and whether the widget opens directly into a
  conversation.
- Queue position display when the customer is waiting for a human.
- Clear labelling of who is responding: AI agent, automation, or named
  teammate, including an explicit in-thread marker when a human joins.

Also required: file upload from the customer side; typing indicators
both directions; unread badge on the launcher; sound and browser
notification options; full keyboard operability; screen reader labels;
right-to-left layouts; and per-locale strings with a fallback chain.

Finally, specify (do not implement yet) the mobile SDK surface for iOS
and Android that mirrors this: present the widget, present a specific
space, present an article or a survey, set the user, log out, unread
count callback, and push notification handling. Write it as an
interface document at docs/MOBILE_SDK.md.

Acceptance criteria: a demo host page with a deliberately hostile
stylesheet and a strict CSP where the widget still renders and behaves
correctly; a test proving a forged identity token is rejected.
```

## Phase 04 — The agent inbox

**Ships:** Where your customers' support teams live all day  
**Needs:** Phases 2, 3

This is the screen an agent stares at for eight hours. Speed and keyboard control are the entire product here — a beautiful inbox that takes 400ms to open a conversation will lose to an ugly one that takes 40ms. Build it list-virtualised and optimistic from the first commit.

*Shared omnichannel inbox with views and folders, macros with bundled actions, internal notes, side conversations, snooze, bulk edit and a context sidebar.*

```text
Build the agent inbox.

Queue and views:
- Default views: mine, unassigned, all open, snoozed, closed, mentions.
- Custom views: a named saved filter over channel, state, assignee,
  team, tag, topic, priority, SLA status, brand, contact attribute,
  company attribute and date. Views are personal or shared, can be
  grouped into folders, duplicated, and reordered.
- Sorting including by SLA urgency (time remaining to breach), newest,
  oldest, and longest waiting.
- Live counts per view that update without a refresh, and a virtualised
  list that stays smooth at 10,000 rows.
- Search within a view.

Conversation pane:
- Timeline rendering every part type from phase 2, with system events
  collapsed by default and expandable.
- Composer with: reply and note modes visually distinct, rich text,
  inline images, file attachment, article insertion, macro insertion,
  emoji, and autosaved drafts that survive a refresh and are visible
  only to their author.
- Mentions of teammates and teams in notes, generating notifications.
- Collision detection: show when another teammate is viewing or
  composing on the same conversation.
- Keyboard shortcuts for every frequent action, a discoverable shortcut
  sheet, and a command palette for search, assign, macro, snooze, tag,
  close and navigate.

Macros:
- A saved reply plus an optional bundle of actions applied in one
  click: assign to teammate or team, add or remove tags, change
  priority, snooze, close, reopen, set conversation attributes, set
  ticket state.
- Personal and shared macros, with separate create, edit and delete
  permissions.
- Variable interpolation from contact, company and conversation fields,
  with a safe fallback when a variable is empty.

Collaboration:
- Internal notes, never visible to the customer, with a visual
  treatment impossible to confuse with a reply.
- Side conversations: a separate thread attached to the conversation,
  sent by email to a third party (or to a chat tool), whose replies
  land back on the conversation without ever reaching the customer.
- Snooze with presets and a custom time, waking back into the assignee's
  queue, and unassigning on wake as a configurable option.

Context sidebar:
- Contact details with inline editing of attributes, company details,
  recent conversations, related custom object instances, and a slot
  system where phase 15 apps will later render cards. Build the slot
  contract now.

Bulk actions on selected conversations: assign, tag, snooze, close,
reopen, change priority, set ticket state, with a confirmation showing
the count and an undo window.

Added after the Intercom gap audit (docs/INTERCOM_GAP_AUDIT.md). This
phase was built before the audit: deliver these as follow-up steps.

- A table layout for any view, with attributes as columns, beside the
  list layout.
- A spam folder as its own destination, and a "created by you" view
  for conversations a teammate started.
- Macro folders; macro availability limited to chosen teams or
  teammates; availability per context (starting a conversation,
  replying, adding a note), several per macro; usage counts per macro
  and export of usage and content.
- Snooze until the customer replies (no wake time), and workspace
  settings for which internal events wake a snoozed conversation
  (notes, assignments, back-office ticket state changes).
- Bulk reply and bulk note, with the same confirmation and audit as
  other bulk actions.
- Per-teammate sidebar layout: each teammate chooses which attributes,
  events and app cards are pinned.
- Conversation attributes visible only to chosen teams, and
  conditional attributes shown only when another attribute has a
  given value.
- Teammate aliases: a workspace default alias and a per-teammate alias
  that customers see instead of real names.
- A workspace setting to hide CSAT scores from agents.

Acceptance criteria:
- Opening a conversation from the list renders the first screen of the
  timeline in under 150ms on a warm cache; show me the measurement.
- Every action is optimistic in the UI and reconciles against the
  server, including when the server rejects it.
- A test proving notes can never be delivered to a customer through any
  channel, including email notifications and the messenger.
```

## Phase 05 — Tickets and SLAs

**Ships:** Structured work items and the clocks that govern them  
**Needs:** Phase 4

A ticket is a conversation that has grown a schema and a promise. The two details teams actually evaluate you on: whether SLA clocks respect office hours and pause correctly, and whether a single tracker ticket can update fifty affected customers at once.

*Three ticket types — customer-facing, back-office, and tracker — plus custom ticket attributes, a customer ticket portal, and SLAs for first response, next response and resolution.*

```text
Build tickets and service level agreements on top of conversations.

Ticket types:
- Ticket type is workspace-defined, with a name, icon, category and its
  own set of typed attributes.
- Three categories with different behaviour:
  1. Customer ticket. Visible to the customer, who receives state
     updates and can follow progress.
  2. Back-office ticket. Internal only. The customer sees nothing. Used
     by teams the customer never speaks to, while staying linked to the
     originating conversation.
  3. Tracker ticket. One internal ticket linked to many customer
     conversations. Updating the tracker can broadcast an update to
     every linked conversation in one action. This is how outages and
     known bugs are handled and it is a genuine differentiator if done
     well.

Ticket behaviour:
- Convert a conversation to a ticket, choosing type and initial state.
- Change ticket type after creation, mapping or clearing attributes
  with an explicit warning about what will be lost.
- Custom states per ticket type with a defined transition graph, not a
  free-text status. Every transition is an event on the timeline and is
  exposed in the API and in reporting.
- Attributes can be marked required to close, blocking closure until
  filled, with a clear inline error.
- Linking: a customer conversation to a back-office ticket, and many
  conversations to one tracker.

Customer ticket portal:
- A hosted page where a signed-in customer sees their tickets and
  conversations, their states, and can reply.
- Visibility rules: individual only, or all tickets from their company,
  configurable per workspace and per ticket type.
- Brand-styled, on a custom domain, and accessible from the messenger.

SLAs:
- Targets: first response time, next response time, time to close, and
  time to resolve.
- Conditions on which conversations an SLA applies to, evaluated at
  creation and re-evaluated when relevant attributes change.
- Office-hours-aware clocks, per team and per brand, including
  holidays. A four-hour target starting at 5pm on Friday is due
  Monday morning, not Friday evening.
- Pause rules: while snoozed, while waiting on the customer, while in
  an automation, each individually configurable.
- Breach handling: mark the conversation, emit an event, and allow
  phase 11 to act on it. Never silently expire.
- Expose time remaining on the conversation and as a sortable field in
  views.

Added after the Intercom gap audit (docs/INTERCOM_GAP_AUDIT.md). This
phase was built before the audit: deliver these as follow-up steps.

- Customer-submitted tickets: a ticket form sent in the messenger or by
  a workflow, so customers (or the AI agent on their behalf) create
  tickets. Ticket attributes gain flags: required to create, required
  for customers, visible on create, and visible to customers. Add a
  file attribute type.
- A customer notification switch per ticket state: whether entering
  this state notifies the customer.

Acceptance criteria: a test matrix covering SLA clocks across office
hours boundaries, holidays, timezone changes, snooze, reopen after
close, and daylight saving transitions. This is where competitors have
bugs; do not have bugs here.
```

## Phase 06 — Routing, teams and workload

**Ships:** Getting the right conversation to the right person, fairly  
**Needs:** Phase 5

Round robin distributes in order and ignores how loaded anyone is. Balanced assignment routes to whoever has the fewest active conversations and respects limits. Support both, and be honest in the UI about the difference, because teams pick the wrong one and then blame the tool.

*Team inboxes, office hours, manual, round robin and balanced assignment, per-teammate and per-inbox assignment limits, away mode handling.*

```text
Build routing, teams and workload management.

Teams:
- A team owns an inbox, a set of member teammates, office hours, a
  default assignment method, and a set of limits.
- A conversation may be assigned to a team (sitting in its inbox) or to
  a teammate. Assigning to a team clears the teammate assignment.

Office hours:
- Per workspace, overridable per team and per brand. Weekly schedule,
  multiple windows per day, timezone, and a holiday calendar with
  one-off closures. Everything downstream — SLAs, expected reply time,
  out-of-hours automations, reporting durations — reads from this one
  source.

Assignment methods:
- Manual: nothing auto-assigns; teammates claim work.
- Round robin: distributes new arrivals in rotation to active members,
  skipping away teammates by default with a per-team toggle to include
  them. Document clearly that round robin does not respect assignment
  limits.
- Balanced: assigns to the eligible teammate with the fewest active
  conversations, respecting both the teammate's limit and the inbox's
  limit. A conversation is assigned only when both allow it; otherwise
  it queues.
- Rule-based routing lives in phase 11 and calls into this module. Build
  the interface now: given a conversation, return an assignee.

Workload:
- Assignment limits per teammate and per team inbox, with an optional
  separate limit for tickets, and a toggle for whether tickets count
  toward conversation capacity at all.
- A "give me the next conversation" action that pulls the highest
  priority waiting item across the teammate's balanced inboxes.
- Away mode: away, and away with reassignment of incoming replies.
  Auto-unassign on away is configurable. Returning from away must not
  dump a backlog on one person.
- Capacity visible in the UI as used against limit, for both inbox and
  teammate.
- Queue position, exposed to the messenger from phase 3.

Correctness requirements:
- Assignment must be atomic. Two concurrent assignment attempts on the
  same conversation must not both succeed. Use a database-level
  guarantee, not an application check.
- Assignment must be deterministic and replayable in tests: inject the
  clock and the rotation cursor.
- When every eligible teammate is at limit or away, the conversation
  waits in the team inbox and is picked up automatically when capacity
  appears. Test that it is picked up, because this is the failure
  everyone ships.

Added after the Intercom gap audit (docs/INTERCOM_GAP_AUDIT.md). This
phase was built before the audit: deliver these as follow-up steps.

- Inbox limit semantics: decide and document what an inbox limit
  means before extending it. It can be a total for the team inbox (as
  built), a cap per teammate within that inbox, or both, each named so
  the difference is obvious in the UI.
- Primary inboxes: teammates can have inboxes they work first.
- Skills-based routing: a teammate skills attribute that routing can
  match against conversation attributes.
- A default assignee for new conversations that nothing else assigns,
  and a workspace choice of whether replying to an unassigned or
  team-assigned conversation assigns it to the replier.
- Automatic away after a configurable period of inactivity, optionally
  pausing the teammate's assigned conversations and tickets.
- Away reasons: workspace-defined reasons chosen when going away,
  optionally required, recorded on each presence change for reporting.
- When a snoozed conversation wakes and its assignee is at capacity or
  away, return it to the team inbox (configurable).

Acceptance criteria: a simulation of 20 teammates, mixed limits, random
away transitions, and 2,000 arriving conversations. Report the
distribution per teammate and prove nothing was lost, double-assigned,
or stranded.
```

## Phase 07 — Help center and knowledge store

**Ships:** Public self-service, and the corpus the AI will read  
**Needs:** Phase 3

Two things at once. The public help center is a content site with SEO and theming needs. The knowledge store behind it is the retrieval corpus for phase 8, and it must accept far more than articles — internal docs, PDFs, snippets, and synced external pages. Build them as one store with different surfaces, or you will maintain two.

*Help Center with collections, multilingual articles and custom domains, plus a Knowledge Hub unifying articles, internal articles, snippets, files and synced external pages.*

```text
Build the help center and the knowledge store.

Knowledge store (the substrate):
- One content record type with a source discriminator: public article,
  internal article, snippet, uploaded file (PDF, doc, text), or synced
  external page.
- Every record carries: title, body, owner, locale, status (draft,
  published, archived), last reviewed date, audience restriction, and
  whether it is available to the AI agent, to the help center, to the
  agent inbox, or some combination. These are independent switches.
- External page sync: given a source URL or sitemap, crawl on a
  schedule, upsert by a stable external id, respect robots rules, and
  detect removals. Store the fetch time and the content hash.
- Chunking and embedding pipeline that runs on publish and on change,
  is idempotent, is resumable, and records which model and version
  produced each embedding so you can re-embed without downtime.
- Content health report: records never reviewed, records with no
  retrievals in 90 days, near-duplicates, and topics customers ask
  about with no matching content. This last one depends on phase 14;
  leave the interface.

Help center (the public surface):
- Collections containing sections containing articles. Collections
  belong to one help center; an article may appear in several.
- Multiple help centers per workspace, each bound to a brand, each with
  its own theme, homepage layout, domain and default language.
- Custom domain with automatic certificates, plus a default hosted
  subdomain.
- Multilingual: an article is one record with per-locale versions, each
  independently drafted and published. Locale fallback chain, language
  switcher, and hreflang tags.
- Editor: rich text, headings, images with alt text, video embeds,
  callouts, code blocks, internal article links that survive slug
  changes, and tables. Autosave, drafts, version history, and restore.
- SEO: server-rendered HTML, clean slugs with redirects on change,
  sitemap, canonical tags, meta and Open Graph, structured data for
  articles and FAQs, and a setting to exclude from indexing.
- Search: typo tolerant, locale aware, ranked, with query logging so
  you learn what customers cannot find.
- Article feedback (helpful or not, with an optional comment) and a
  path from an unhelpful vote straight into a conversation.
- Access control: fully public, or restricted to signed-in customers
  via the same identity mechanism as the messenger.
- The tickets portal from phase 5 mounted as a section.

Added after the Intercom gap audit (docs/INTERCOM_GAP_AUDIT.md):
Steps A1–B2 were built before the audit; these belong to C1, C2 or
follow-up steps.

- Website sync: exclusion URL globs, CSS selectors to strip, and
  JavaScript rendering for sites that need it.
- Manually managed redirects per help center, and a redirect map
  generated when articles are imported, so links from a previous help
  desk keep working.
- A connector interface for third-party knowledge sources, with
  Zendesk (public articles), Notion, Confluence and Guru (internal) as
  the first candidates.
- Decide whether collections nest beyond two levels, and provide
  privacy-preserving built-in help center analytics instead of
  third-party tracking scripts.

Acceptance criteria: publish an article in three locales, verify each
renders server-side with correct metadata; verify a slug change leaves
a working redirect; verify a re-embed of 10,000 records runs without
taking search offline.
```

## Phase 08 — The AI agent

**Ships:** Autonomous resolution, grounded and measurable  
**Needs:** Phases 2, 7

The temptation is to wire a model to your articles and call it done. The difference between a demo and a product is everything around the model: when it refuses, how it escalates, how you prove an answer was grounded, how you count a resolution, and how you know a prompt change did not make it worse. Build the evaluation harness in the same phase as the agent, not after.

*Intercom's Fin: grounded answers from the knowledge store, guidance rules for tone and policy, escalation to humans, 45-plus languages, and pricing per resolution.*

```text
Build the AI answering agent.

Retrieval:
- Hybrid retrieval over the phase 7 store: keyword and vector, fused
  and reranked. Filter by locale, brand, audience rules and the
  availability flags before ranking, never after.
- Return passages with source ids so every sentence in an answer can be
  traced to a record.

Answering:
- Generate only from retrieved passages plus the conversation history
  and permitted customer attributes. If retrieval is weak, the agent
  must say it does not know and offer a human, not improvise. Make this
  a hard gate with a measurable threshold, not a prompt instruction.
- Cite sources, rendered as article links to the customer where
  appropriate.
- Multi-turn: the agent asks a clarifying question when the query is
  ambiguous rather than answering the most likely interpretation.
- Format per channel: short and conversational in chat, structured and
  complete in email, plain and brief in SMS, speakable in voice.

Configuration surfaces (each targetable to an audience segment, each
versioned):
- Guidance: natural-language rules for tone, policy and behaviour, with
  channel selectors. Guidance must never be able to grant the agent
  powers it does not have; it shapes language and decisions, not
  permissions.
- Identity: name, avatar and persona per brand.
- Content targeting: which records this audience's agent may use.
- Language: detect the customer's language and answer in it, with a
  configurable allowlist and a fallback.

Escalation and handover:
- Explicit triggers: the customer asks for a human, the agent has
  failed twice, sentiment turns negative, the topic is on a
  never-handle list, the customer is in a segment configured for humans
  only, or office hours rules require it.
- On handover, write a summary part to the conversation so the human
  starts informed, and route through phase 6.
- Out-of-hours behaviour is configurable: continue unattended, take a
  message, or promise a reply time from office hours.

Resolution accounting:
- Define a resolution precisely and implement it as a ledger: the
  customer confirms the answer resolved it, or the customer does not
  come back within a configurable window after the last answer and the
  conversation was never escalated. Every resolution row records the
  conversation, the answers involved, the rule that fired, and the
  time. Billing in phase 16 reads this ledger and it must be
  reconcilable by a human reading a support thread.

Safety:
- Prompt injection defence: treat all retrieved content and all
  customer text as untrusted data, never as instructions. Test with a
  corpus containing deliberately hostile article text.
- Never disclose another customer's data, internal record contents
  marked internal, or system prompts.
- Filter inbound spam and phishing before the agent answers on email.
- Redact personal data from anything sent to a third-party model
  provider where the workspace has enabled that setting, and record
  what was sent for audit.

Evaluation (build this in the same phase):
- A golden set of at least 200 question and expected-behaviour pairs
  covering: answerable, unanswerable, ambiguous, multi-turn,
  out-of-scope, hostile, and multilingual cases.
- An automated run that scores groundedness, correctness, refusal
  appropriateness and escalation appropriateness, and fails the build
  on regression.
- A human review queue in the product where a support lead samples real
  answers, rates them, and sends bad answers straight into a content
  gap list.

Added after the Intercom gap audit (docs/INTERCOM_GAP_AUDIT.md):
- Escalation rules (deterministic data conditions on people, company
  or conversation; when one matches the agent does not answer and
  hands over) kept separate from escalation guidance (natural
  language).
- An AI conversation state alongside open, snoozed and closed:
  resolved, needs teammate input, escalated, pending. Inbox views by
  this state.
- Several agents with different purposes (for example service and
  sales), each with its own content availability, guidance and
  connectors.
- Human-in-the-loop email replies: the agent drafts, a teammate
  approves or edits before anything is sent; reported separately.
- Formality (formal or informal address, per language) and answer
  length settings.
- An explicit decision on memory across a customer's conversations,
  behind a workspace switch, with what was remembered recorded on the
  conversation.
- Simulated-customer tests for multi-step behaviour, alongside the
  golden set.
- Monitors that alert when the agent's behaviour or performance
  changes sharply (an incident view).

Acceptance criteria: show me the eval scores before and after a
deliberate prompt change, and show me the agent correctly refusing a
question that the knowledge store cannot answer.
```

## Phase 09 — AI actions and data connectors

**Ships:** The agent doing things, not just answering  
**Needs:** Phase 8

This is where an AI agent stops being a search box. It is also where it can do real damage, so every write action needs identity verification, a guardrail, and an audit row. Build read actions first and make write actions explicitly opt-in per action.

*Intercom's data connectors and procedures: the agent calls external systems to look up an order, process a return, or update an account mid-conversation.*

```text
Build AI actions and data connectors.

Connector definition:
- A workspace-defined HTTP integration: name, description, base URL,
  auth (API key header, bearer token, OAuth 2 client credentials, or
  OAuth on behalf of the workspace), request schema, response schema,
  timeout, retry policy, and a rate limit.
- Request templating from conversation and contact context, with
  explicit declaration of every field that may be sent outward.
- Response mapping: pick fields out of the response and expose them as
  named values the agent may use, so the agent never sees the raw
  payload and cannot leak it.
- Test console: run the connector against sample input and show the
  exact request and response, with secrets masked.
- Versioning: editing a live connector creates a version; running
  conversations continue on the version they started with.

Classification: read or write. Write connectors require an explicit
enablement step with a warning, and may require human approval per
invocation (configurable), which posts an approval request into the
inbox and blocks until a teammate approves.

Procedures:
- A workspace writes a procedure in plain language: the goal, the
  conditions under which it applies, the steps, the information that
  must be gathered first, and what to do on failure.
- Compile each procedure into a deterministic plan: required inputs,
  ordered steps, connector calls, branch conditions, and a terminal
  outcome (resolved, escalated, or abandoned). The model fills in
  conversation, it does not invent the control flow.
- Preconditions: a procedure that performs a write must declare an
  identity requirement, and the runtime must refuse to execute it for
  an unverified contact.

Runtime:
- Every connector invocation writes an audit row: who, which
  conversation, which version, inputs (with declared sensitive fields
  redacted), outputs, duration, result.
- Failures degrade gracefully: on timeout or error, the agent tells the
  customer plainly and escalates, and never retries a write action that
  may have partially succeeded without an idempotency key.
- A per-workspace kill switch that disables all write actions
  immediately.

Added after the Intercom gap audit (docs/INTERCOM_GAP_AUDIT.md):
- A customer verification rule table per channel and audience, with a
  fallback rule, evaluated before any connector runs (not only for
  write procedures).

Acceptance criteria:
- Recorded fixtures for every connector so tests run offline.
- A test proving a write action is refused for an unverified contact.
- A test proving a connector timeout ends in a clean escalation with the
  customer informed, not a hung conversation.
- The audit log for one conversation, rendered readably, as a
  demonstration.
```

## Phase 10 — Agent copilot

**Ships:** The AI helping the human, inside the inbox  
**Needs:** Phases 4, 8

Cheaper to build than phase 8 because it reuses the same retrieval, and it is often what actually sells the product — support leads who will not let AI talk to customers will happily let it help their team. Keep every output editable and never send anything on the agent's behalf without an explicit action.

*Copilot: answer suggestions, summaries, translation, tone rewriting and auto-titling for the human agent.*

```text
Build the agent copilot inside the inbox.

Capabilities:
- Suggested reply, grounded in the same knowledge store as phase 8,
  with visible sources, inserted into the composer as an editable draft
  and never sent automatically.
- Ask copilot: a side panel where the agent asks a question in natural
  language and gets a grounded answer with sources, usable as internal
  research without touching the customer.
- Conversation summary on demand and automatically when a conversation
  is reassigned or handed over, written as a part so it persists.
- Catch-up: what changed since this agent last looked at the thread.
- Compose assists: expand a terse note into a reply, adjust tone, make
  it shorter, fix grammar, all applied to text the agent selected.
- Real-time translation in both directions, with the original preserved
  alongside the translation and a per-message feedback control on
  quality.
- Auto-title and auto-topic on conversations, correctable by a human,
  with the correction fed back into phase 14's topic model.
- Similar past conversations, retrieved by semantic similarity and
  filtered to ones that were resolved.

Controls:
- Per-workspace and per-teammate enable switches per capability.
- A visible indication of which text came from the copilot before it is
  edited, and none after it is sent (the customer sees a human reply,
  because it is one).
- Cost controls: token budgets per workspace with alerts, caching of
  repeated summaries, and a hard cap that degrades to disabled rather
  than to a surprise invoice.
- Latency budget: suggestions stream, and the composer is never blocked
  waiting for a model.

Added after the Intercom gap audit (docs/INTERCOM_GAP_AUDIT.md):
- Translation tone (for example friendly, neutral, professional) and a
  workspace glossary of terms that must translate a fixed way.
- Copilot access set per teammate, exposed to phase 16 as a billable
  seat dimension.

Acceptance criteria: copilot works with the knowledge store empty
(it should degrade to general assistance and say so, not hallucinate
policy); no copilot output can reach a customer without a human action;
measured time from request to first streamed token under 800ms.
```

## Phase 11 — The workflow builder

**Ships:** No-code automation over everything built so far  
**Needs:** Phases 5, 6, 8

The workflow builder is how customers make your product theirs, and it is the feature most likely to become an unmaintainable pile. Design it as a versioned, executable graph with a run log from day one. If you cannot show a customer exactly why their workflow did something, they will stop trusting it.

*Intercom Workflows: a visual builder with triggers, conditions, branching, waits, actions, SLAs, connector calls and handover to the AI agent.*

```text
Build the visual workflow builder.

Model:
- A workflow is a directed graph of nodes with a single trigger root.
  Persist it as data, not as generated code.
- Versioning: a live version and a draft. Publishing creates an
  immutable version. In-flight runs complete on the version they
  started. Rollback restores a prior version in one action.

Triggers: a new conversation starts in the messenger; a customer sends
their first message; a customer sends any message; a conversation is
assigned, tagged, closed or reopened; a ticket is created or changes
state; an SLA is breached; a conversation attribute changes; a contact
attribute changes; an event is received; an inbound email matches a
condition; a contact enters or leaves a segment; a schedule; a manual
trigger from the inbox; a webhook.

Conditions: nested and-or groups over conversation, contact, company,
custom object, channel, brand, office hours, teammate availability,
tags, topics, language, and event history. Show a live estimate of how
many current records match while editing.

Actions: assign to teammate, team or via a routing method; add or
remove tags; set priority; snooze; close; reopen; apply or clear an
SLA; set conversation or contact attributes; add an internal note; send
a message to the customer (chat, email, or the conversation's own
channel); ask a question and branch on the answer; hand over to the AI
agent; hand over to a human; call a data connector and branch on its
result; create a ticket; start an outbound series; send a webhook;
wait for a duration or until a condition or until office hours open.

Builder requirements:
- Canvas with drag, connect, zoom, undo and redo. Nodes readable at a
  glance. Invalid graphs (unreachable nodes, missing branches,
  unterminated paths) blocked at publish with a clear message.
- Simulation mode: run the workflow against a chosen real conversation
  without side effects, showing the path taken and every decision.
- A template library seeded with at least ten useful workflows:
  triage and route by topic, out-of-hours autoresponder, VIP fast lane,
  collect email before chat, qualify a lead, escalate on negative
  sentiment, close stale conversations, request a rating after
  closure, alert on SLA breach, and route by language.

Runtime:
- A run record per execution with every node visited, every condition
  evaluated and its inputs, every action taken and its result, and the
  total duration. Surfaced in the UI, filterable, retained.
- Loop protection: maximum nodes per run, maximum runs per conversation
  per hour, and detection of workflows that trigger each other.
- Failure isolation: one failing node fails that run, never the queue.
  Retries with backoff for transient failures, dead-letter for the
  rest, and a visible alert when a workflow is failing repeatedly.

Added after the Intercom gap audit (docs/INTERCOM_GAP_AUDIT.md):
- More triggers: a customer visits a page, clicks a page element,
  calls, or has been unresponsive; a teammate adds a note; a quality
  score is received; a set time before an SLA breaches.
- More steps: collect a customer reply, send a ticket form, reply
  buttons built from custom-object records, show the expected reply
  time, and pass to a reusable sub-workflow.
- More actions: notify a Slack channel; turn off customer replies.
- Decide explicitly whether several customer-facing workflows may run
  on one trigger or only the highest-priority match, and show the
  choice in the UI.
- Refuse to publish conditions that cannot be evaluated (for example
  too complex) instead of letting them fall through to "else" at run
  time. Automated changes (bulk actions, the AI agent) must either
  fire triggers or be documented, per trigger, as not firing them.

Acceptance criteria: publish a workflow that tags, routes by language,
waits for office hours, hands to the AI agent, and escalates on
failure; show me its run log for three different conversations; break
it deliberately and show the alert.
```

## Phase 12 — Omnichannel

**Ships:** Email, WhatsApp, SMS, social and voice landing in one inbox  
**Needs:** Phase 4

Build the adapter interface first and one channel properly, then the rest are repetitions. Email is the hard one and the one you cannot skip: threading, deliverability and quoted-reply stripping are where support tools quietly fail. Do email before anything glamorous.

*Intercom unifies email, live chat, phone, WhatsApp, SMS, Instagram, Facebook Messenger, Slack and Discord into one inbox.*

```text
Build the omnichannel layer.

First, the adapter contract. Define one interface every channel
implements: receive an inbound payload and normalise it to a
conversation part; send an outbound part and report delivery status;
report capabilities (rich text, attachments, buttons, message length
limits, session windows); handle identity resolution from the channel's
own identifier to a contact. No channel-specific logic may leak into
the inbox, the workflow engine or reporting. Everything below is an
implementation of this contract.

Email (build this first and completely):
- Inbound: MIME parsing, multipart and inline images, character sets,
  attachments, size limits. Thread by Message-ID, In-Reply-To and
  References, with a subject-and-participant fallback. Strip quoted
  history and signatures reliably, keeping the full original available
  behind a control. Detect auto-replies, out-of-office and bounces and
  do not treat them as customer replies.
- Outbound: per-brand sending domain with SPF, DKIM and DMARC setup
  flow and verification status in the UI. Plain-text alternative for
  every HTML mail. Correct reply-to routing back to the conversation.
- Deliverability: bounce and complaint webhooks, a suppression list
  that outbound sending must consult, per-domain rate limiting, and a
  reputation dashboard.
- Security: sanitise inbound HTML before rendering in the inbox, block
  remote content by default, scan attachments.

WhatsApp Business: template message approval and storage, the 24-hour
customer service window with clear UI state when it has closed, opt-in
records, media, delivery and read receipts, number registration.

SMS: per-country number provisioning, segment counting and cost
estimation, mandatory opt-out keyword handling with a permanent
suppression record, and a clear consent model.

Instagram and Facebook Messenger: account connection, message and story
reply handling, the platform's own messaging windows, and attachment
support.

Slack and Discord: connect a workspace or server so community messages
become conversations and replies return to the thread.

Voice: number provisioning, inbound call answering, recording and
transcription with a consent step and per-region configuration, the
transcript written to the conversation as parts, voicemail, and warm
transfer to a teammate with context. If the AI agent is enabled on
voice, it must use the phase 8 pipeline with speakable formatting and a
strict barge-in and silence policy.

Cross-cutting: one contact may reach you on several channels and must
resolve to one person; a conversation records which channel each part
arrived on and displays it; channel availability respects office hours
per channel; and every channel's outbound respects subscription types
and suppression.

Acceptance criteria: a test corpus of 50 real-world inbound emails
(forwarded chains, Outlook quoting, Gmail quoting, mobile signatures,
auto-replies, bounces, non-Latin character sets) parsed correctly; a
test that a suppressed address is never sent to, through any path.
```

## Phase 13 — Outbound and proactive messaging

**Ships:** Reaching customers before they contact you  
**Needs:** Phases 1, 3, 11

The largest phase by surface area and the easiest to over-build. The engine underneath — audience evaluation, scheduling, frequency capping, subscription enforcement, goal attribution — is shared by every message type. Build the engine, then add message types one at a time in the order your customers ask for them.

*Intercom Outbound: chats, posts, banners, tooltips, checklists, product tours, surveys, news items, push, mobile carousels and Series orchestration, with A/B testing and control groups.*

```text
Build outbound and proactive messaging. Build the shared engine
first; then implement message types in the order listed.

The engine:
- Audience: a segment from phase 1 plus additional rules evaluated at
  send time (current page URL, device, locale, time since signup, event
  in the last N days, conversation state). Live size preview.
- Delivery modes: one-off send to a matching audience; ongoing, so
  contacts receive it when they first match; event-triggered with a
  delay; recurring on a schedule.
- Re-entry rules: once ever, once per period, or every time.
- Frequency capping per contact across all outbound, plus per-message
  caps, plus quiet hours in the contact's timezone.
- Subscription enforcement: every message declares a subscription type
  and the engine refuses to send to an opted-out contact. No exceptions
  and no bypass flag.
- Goal: a named event or attribute change, measured within a window
  from delivery, with a holdout control group so the reported lift is
  real.
- A/B testing: variants with traffic split, a statistical readout that
  states significance honestly and refuses to declare a winner early.
- Versioning and scheduling of edits; an in-flight message must not
  change under contacts already in it.
- A per-contact delivery ledger: what was sent, when, through what,
  whether it was seen, clicked, dismissed or converted.

Message types, in build order:
1. In-app chat message. Arrives in the messenger as a conversation,
   and a reply continues into the inbox.
2. Banner. Top or bottom, on web pages where the messenger runs,
   dismissible, with an optional action.
3. Post. A full in-messenger announcement, larger than a chat.
4. Email. Reuses the phase 12 sending infrastructure.
5. News item. Published to a news space in the messenger, permanent,
   browsable, optionally pushed to a segment.
6. Survey. Question types: rating, NPS, multiple choice, dropdown,
   free text. Conditional branching between questions. Delivery in the
   messenger, by email, or triggered after a conversation closes for
   CSAT. Results flow into phase 14.
7. Tooltip. Anchored to a page element. Selectors must degrade safely
   when the customer's DOM changes; never leave a floating tooltip
   pointing at nothing.
8. Checklist. An ordered list of tasks with completion detected from
   events, persisting progress across sessions.
9. Product tour. Multi-step guided walkthrough with element anchoring,
   waiting for a user action, branching, and a no-code builder that
   runs against the customer's own site.
10. Push notification and mobile carousel, once the mobile SDKs exist.

Series:
- A campaign graph: nodes are messages, waits, conditions, splits and
  exits. Contacts move through it and their position is visible.
- Exit criteria that remove a contact immediately when the goal is met
  or they no longer match.
- A per-contact view showing where they are and why they took each
  branch.

Added after the Intercom gap audit (docs/INTERCOM_GAP_AUDIT.md):
- Dynamic audiences (everyone who matches now and later) and fixed
  audiences (only those who match at send), and audiences from a CSV
  upload.
- Broadcasts over WhatsApp, Discord and Telegram once phase 12
  provides those channels.
- Collecting subscription consent inside a conversation.
- Identifying a lead who clicks through from an email link, so the
  site can greet them.

Acceptance criteria: an opted-out contact receives nothing through any
type; frequency caps hold under a burst of ten simultaneously matching
messages; a tour whose anchor element disappears fails quietly and is
reported rather than breaking the host page.
```

## Phase 14 — Reporting and analytics

**Ships:** The numbers teams are judged on  
**Needs:** Phases 5, 6, 8, 13

Reporting decides deals more often than founders expect, and it is where a naive implementation collapses: querying live tables for analytics will take your inbox down. Separate the stores, define every metric precisely in writing, and snapshot attributes at conversation start so historical reports do not silently change when someone edits a contact.

*Intercom's reporting: pre-built templates for conversations, responsiveness, SLAs, teammate and team performance, tickets, CSAT and AI agent performance; custom reports; conversation topics; real-time dashboards; scheduled exports.*

```text
Build reporting and analytics.

Architecture:
- A separate analytical store fed by an append-only event stream from
  the application. Reporting queries never touch the tables that serve
  the inbox.
- Snapshot the contact, company and conversation attributes at
  conversation start, and record later changes as separate rows.
  Historical reports must not change when someone edits a contact
  today. Explicitly exempt a small set of live-resolved fields (contact
  name and email) and document the exemption in the UI.
- Every duration is computed in both wall-clock and office hours, using
  phase 6 as the single source of business hours.

Metric dictionary. Write docs/METRICS.md defining every metric: exact
formula, which timestamp it is anchored to, what is included and
excluded, and how it treats automation. At minimum define: new
conversations; conversations replied to; replies sent; closed
conversations; reopened conversations; open and snoozed at end of
period; first response time (median and average, wall and business);
next response time; time to close; time to resolve; handling time and
handling time excluding idle; SLA hit rate, miss rate and count; CSAT
percentage happy and response rate; AI agent resolution rate,
escalation rate, answer rate and involvement; deflection; conversations
per teammate per hour; and busiest period.

Datasets, each a documented table of metrics and breakdown attributes:
conversation, conversation rating, SLA, ticket, AI agent, teammate,
team, outbound message, survey response, article and search.

Pre-built reports: overview (human and AI together), conversations,
responsiveness, SLAs, team performance, teammate performance, tickets,
CSAT with dissatisfaction drivers, AI agent performance, copilot usage,
help center and search, and outbound performance.

Custom report builder: pick a dataset, a metric, a breakdown, filters
and a chart type; several charts to a report; date range with
comparison to previous period; save, share and set access; drill from
any chart point to the underlying rows, permission permitting.

Conversation topics: cluster conversations semantically, suggest topics
to a support lead, let them accept, rename, merge or reject, then
classify incoming conversations against the accepted taxonomy. Report
volume, CSAT, first response time and time to close per topic, and let
every other report be filtered by topic. Surface topics with high
volume and no matching help center article as a content gap list,
feeding back into phase 7.

Real-time dashboard: open now, unassigned now, waiting longest,
teammates online and their status, current queue by team, live SLA
risk. Separate infrastructure from historical reporting; this is a
cheap aggregate refreshed frequently, not a query over history.

Export and sharing: CSV download, scheduled email delivery, a shareable
external link with an expiry and optional password, and a warehouse
export (object storage or a direct connector) of conversations,
tickets, contacts and events with a documented schema.

Added after the Intercom gap audit (docs/INTERCOM_GAP_AUDIT.md):
- Custom metrics: percentage, ratio or absolute, with separate filters
  on numerator and denominator, reusable across reports. Saved filter
  sets reusable across reports.
- A report timezone chosen per report or viewer.
- METRICS.md also defines first-contact resolution, repeat contact,
  adjusted handling time and reassignment count.
- Pre-built effectiveness, calls, email deliverability and
  human-in-the-loop reports.
- Conversation quality review: a review queue in the inbox, reviewers
  assigned to teammates' conversations, scorecards and issues, and
  optionally an AI quality score on every closed conversation with
  reasons, able to trigger workflows. This is large enough to become
  its own phase; decide before starting phase 14.

Acceptance criteria:
- Build a dataset of 10 million conversation parts across 5,000
  workspaces and report query timings for every pre-built report.
- A test proving an attribute edited today does not change a report for
  last month.
- A test proving office-hours durations are correct across a daylight
  saving transition.
```

## Phase 15 — Developer platform

**Ships:** API, webhooks and an app framework  
**Needs:** Phases 1–6

This is how you stop being a tool and start being a platform, and it is also how a prospect's integrations team says yes. The app framework matters more than it looks: letting a customer render their own data in the agent sidebar removes the biggest objection to switching.

*A versioned REST API with an OpenAPI spec, OAuth apps, signed webhooks, and Canvas Kit — a declarative framework for apps that render inside the inbox and messenger.*

```text
Build the developer platform.

API:
- REST, versioned by header with a documented deprecation policy and at
  least two supported versions at any time.
- The OpenAPI specification is the source of truth: generate the
  reference documentation, the client SDKs (start with JavaScript and
  Python) and the request validation from it. Never hand-write the spec
  after the fact.
- Coverage: contacts, companies, data attributes, custom objects,
  events, tags, notes, segments, conversations (list, retrieve, create,
  reply, note, assign, snooze, close, tag, search), tickets and ticket
  types, teammates and teams, articles and collections, help centers,
  knowledge records, macros, workflows (read and trigger), outbound
  messages, and data export.
- A search endpoint with a documented query grammar supporting nested
  and-or, operators per attribute type, sorting and cursor pagination.
- Pagination is cursor-based everywhere. No offset pagination on
  anything that can exceed a few thousand rows.
- Rate limiting per workspace and per token, communicated in response
  headers, with a 429 carrying a retry-after and a documented burst
  allowance. Rate limits must be visible in the customer's dashboard.
- Errors: a stable machine-readable code, a human message, and the
  offending field. Never leak internals.

Authentication:
- Personal access tokens scoped to a workspace, revocable, with last
  used timestamps.
- OAuth 2 for third-party apps, with granular scopes mapping to the
  phase 1 permission registry, a consent screen listing exactly what is
  being granted, refresh tokens and revocation.

Webhooks:
- Subscribe per topic: conversation created, replied, assigned, closed,
  rated, tagged; ticket created and state changed; contact created,
  updated, merged, tagged; company created and updated; event received;
  AI agent resolved or escalated; SLA breached; article published.
- Signed payloads with a rotating secret and a documented verification
  routine.
- At-least-once delivery, retry with exponential backoff over 24 hours,
  automatic disabling after sustained failure with an email alert, a
  delivery log the customer can inspect, and manual replay of any
  delivery.

App framework:
- Apps are declarative: your servers request a canvas from the app's
  URL and render the returned component tree. Components: text, image,
  button, link, input, textarea, dropdown, checkbox, list, data table,
  divider, spacer. No arbitrary code executes in your UI.
- Lifecycle endpoints: initialize (first render), submit (a user
  interacted), configure (workspace setup during install).
- Placements: the inbox context sidebar, the conversation composer, the
  messenger home, and settings.
- Signed requests so the app can verify they came from you; short
  timeouts with a clear failure card; per-app error rates visible to
  both the app developer and the workspace.
- A developer workspace with a sandbox, an app manifest, versioning, a
  review process, and a directory with install and uninstall flows that
  cleanly revoke tokens and remove placements.

Acceptance criteria: build one real app end to end against your own API
(an order lookup card in the inbox sidebar) and use it as the example
in the documentation.
```

## Phase 16 — Security, compliance, admin and billing

**Ships:** The things procurement asks about, and getting paid  
**Needs:** All prior

Every item here has blocked a deal for someone. Build the permission layer as one policy module, not scattered conditionals, because you will be adding permissions for years. On billing, the hard part is not charging cards — it is a resolution ledger a customer can audit when they dispute an invoice.

*SSO and identity management, custom roles, granular permissions, HIPAA support, data deletion and export, plus seat-based pricing combined with per-resolution AI billing.*

```text
Build security, compliance, administration and billing.

Identity and access:
- SSO via SAML 2.0 and OIDC, per workspace, with enforced-SSO mode and
  a documented break-glass path.
- SCIM provisioning and deprovisioning, with role mapping from
  directory groups.
- Two-factor authentication for password accounts, session lifetime
  policy, device list and remote sign-out, and optional IP allowlisting.
- Custom roles built on the phase 1 permission registry, with a
  permission editor that explains each capability in plain language.
  Include restricted roles for outsourced teams that can see only their
  assigned conversations and cannot see customer personal data.

Auditing:
- An append-only audit log of every administrative and sensitive
  action: sign-ins, permission changes, role changes, data exports,
  deletions, settings changes, API token creation, connector changes,
  workflow publishes, and any access to a customer record by a
  teammate. Searchable, exportable, retained for a configurable period,
  and immutable from the product UI.

Data protection:
- Retention policies per data class with automatic deletion, including
  conversation auto-deletion after a configurable period.
- Data subject requests: export everything about one contact in a
  machine-readable form, and delete everything about one contact with a
  documented cascade covering conversations, parts, attachments,
  events, analytics rows, search indexes, embeddings, backups and third
  party processors. Deletion produces a certificate the workspace can
  keep.
- Personal data redaction in logs, error reports and any payload sent to
  a model provider, with per-workspace controls and a record of what
  left the system.
- Encryption in transit and at rest, documented key management, and a
  written subprocessor list surfaced in the product.
- Optional stricter mode for regulated customers: no third-party model
  training, restricted attachment types, mandatory audit review,
  configurable data region.

Billing:
- Plans expressed as one policy document mapping features and limits to
  plan tiers, read by a single gating module. No feature checks
  scattered through the codebase.
- Seats: full seats and limited seats, prorated changes, and a clear
  view of who occupies one.
- Usage metering: AI resolutions from the phase 8 ledger, outbound
  messages sent, connector calls, and any other metered unit. Each
  metered unit must be traceable from the invoice line back to the
  specific conversation or message, viewable by the customer. Assume
  every invoice will be disputed once.
- Limits and overage: soft limits with warnings, hard caps that degrade
  the feature rather than failing the whole product, and a spend cap
  the customer controls.
- Trials, upgrades, downgrades with a defined behaviour for data that
  exceeds the lower plan's limits, dunning, and invoices.

Added after the Intercom gap audit (docs/INTERCOM_GAP_AUDIT.md):
- Link safety: warnings on untrusted links, malicious-link detection
  teammates must acknowledge, and workspace policies of trusted and
  blocked domains.
- Content redaction rules (built in and custom) applied to
  conversation text.
- Separate IP allowlists for the app and for the API.
- A session length policy (already listed under identity and access).
- A security health check summarising the workspace's settings.
- Workspace switches for risky merges: merging conversations across
  different people, and merging unverified leads into users by email.
- A test workspace paired with a production workspace (also serves
  phase 15's sandbox).
- Granting the vendor's support team temporary account access, time
  limited and audited.
- Metering covers every billable unit (AI outcomes, SMS segments, bulk
  email, bulk WhatsApp, phone segments, outbound messages by type),
  each with alerts (notify only) and limits (pause the feature).
- Limited seats: their capability limits are written into the seat
  policy (for example no inbox search).

Acceptance criteria: a deletion test proving no trace of a contact
remains in any store including the search index and the embeddings;
an invoice reconciliation test where every metered unit resolves to a
source record; a permissions test matrix over every role and every
sensitive route.
```

## Phase 17 — Scale, migration and launch

**Ships:** Surviving real customers, and taking them from Intercom  
**Needs:** All prior

Two jobs. First, prove the system holds under load and fails gracefully when parts of it do not. Second, build the importer, because the single largest obstacle to a team leaving Intercom is not features — it is three years of conversation history and a help center they do not want to rewrite.

*Nobody migrates a support history by hand. The importer is a sales tool disguised as an engineering task.*

```text
Build for scale, migration and launch readiness.

Scale:
- Write a load model: target workspaces, conversations per workspace per
  day, parts per conversation, concurrent agents, concurrent messenger
  sessions, events per second, and the ratio of reads to writes. Derive
  targets from it and state them as service level objectives.
- Address, with measurements not assertions: read replicas and which
  queries use them; partitioning strategy for conversation parts and
  events; index review with the slow query log; caching layers and
  their invalidation; websocket connection limits and horizontal
  scaling of the realtime tier; job queue throughput, priority lanes so
  a bulk outbound send cannot starve inbound message delivery, and
  backpressure.
- Graceful degradation: if the AI provider is down, the agent is
  disabled and conversations route to humans with a notice. If realtime
  is down, the inbox polls. If search is down, the inbox falls back to
  a database query. If analytics is down, the inbox is unaffected.
  Write each of these as a test.

Observability:
- Distributed tracing from the messenger through the API, the job
  queue, the model provider and back. One trace id visible in the
  support tooling so you can debug one customer's one conversation.
- Dashboards and alerts on the stated objectives, plus business alerts:
  message delivery failures, webhook failure rates, AI escalation rate
  spikes, and outbound send anomalies.
- A backup and restore rehearsal with a measured recovery time and a
  documented runbook.

Migration importers (build the Intercom one first):
- Import contacts and their attributes, companies, tags, conversations
  with every part and its original timestamps and authors,
  attachments rehosted, notes, tickets, help center articles and
  collections across locales, macros, and teammates.
- Preserve original ids in a mapping table so a customer's existing
  links, exports and reports can be reconciled.
- Resumable and idempotent: it will be interrupted. Running it twice
  must not duplicate anything.
- Dry run producing a diff report of what would be created, skipped or
  conflicted, and a post-run verification report of counts by object
  type with discrepancies listed.
- Rate-limit aware against the source API, with progress visible to the
  customer.
- A documented cutover plan: dual-run period, redirecting the messenger
  snippet, forwarding the support email address, and rollback.

Launch checklist: write docs/LAUNCH.md covering security review,
penetration test items, uptime page, incident process and on-call,
support for your own support tool, documentation completeness,
onboarding flow for a brand new workspace with zero data, and the empty
states for every screen. Empty states are a first impression; review
every one.

Acceptance criteria: a full import of a realistic Intercom export
(100,000 conversations) completed, verified, and timed; the degradation
tests passing; the restore rehearsal documented with an actual measured
recovery time.
```

## Repair prompts

The output will drift. These are the six corrections you will need most, worded so the model fixes rather than rewrites.

**When it stubbed the hard part**

```text
You marked [FEATURE] as a TODO or returned mock data. That is the part
of this phase I actually needed. Implement it properly now. Do not
touch any other file. If it cannot be implemented without something
from a later phase, name the exact dependency and the smallest real
version you can build today.
```

**When it is not tenant-scoped**

```text
Audit every query, job, cache key, websocket channel, search index
write and file path you added in this phase for workspace scoping.
Produce a table: location, scoped yes or no, fix. Then apply the fixes
and add a test that authenticates as workspace A and fails to read a
record belonging to workspace B through each new route.
```

**When the diff is too big to review**

```text
This change is too large to review safely. Split it into three
sequential pull requests that each leave the application working and
tested: (1) schema and data layer only, (2) server logic and API,
(3) UI. Give me the first one now and nothing else.
```

**When it invented an abstraction**

```text
You introduced [ABSTRACTION]. Justify it against the code that exists:
how many current call sites use it, and what concrete future change
does it make cheaper? If the honest answer is fewer than three call
sites and a hypothetical future, remove it and inline the logic.
```

**When it broke something quietly**

```text
Run the full test suite and report failures verbatim. Then list every
behaviour that existed before this phase and could plausibly have been
changed by it, including anything touching [CONVERSATION STATE,
ASSIGNMENT, UNREAD COUNTS, REALTIME DELIVERY]. For each, tell me how
you verified it still works. Verified means a test or a command I can
run, not a reassurance.
```

**Before you merge any phase**

```text
Review this phase as a hostile senior engineer who will maintain it
for three years and was not in the room. List, in priority order:
correctness bugs, race conditions, N+1 queries, missing indexes,
unbounded queries, anything that breaks at 10,000 workspaces or
50 million conversation parts, anything that leaks across tenants, and
anything a customer could abuse. For each, give severity and the fix.
Do not fix anything yet. Just the list.
```

## What to cut if you are building alone

Intercom has hundreds of people and fifteen years. You do not need parity to win a customer — you need one wedge done better than they do it, plus enough platform underneath that a team can switch without losing anything.

| Build first, no matter what | Safe to defer a year |
|---|---|
| Phases 0–5, plus 7 and 8 | Phase 13 beyond banners and simple in-app messages |
| Email as a channel (phase 12). Email is not optional; chat-only tools lose enterprise deals. | Voice, Instagram, Discord, mobile carousels, product tours |
| A credible metric layer (phase 14). Buyers evaluate on reporting more than they admit. | Custom report builder. Ship eight excellent fixed reports first. |
| Public API and webhooks (phase 15). This is how you get out of "cannot replace our stack." | App framework and app store |
| SSO, audit log, data deletion (phase 16) | HIPAA mode, data residency, SCIM |
| An importer from Intercom (phase 17). Nobody migrates by hand. | Zendesk, Freshdesk, Help Scout importers |

The two places to spend your differentiation: the quality of the AI agent's answers when the knowledge base is messy, and the speed of the agent inbox. Everything else in this document is table stakes that you are building so that the wedge has somewhere to live.
