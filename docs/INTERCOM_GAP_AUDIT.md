# Intercom gap audit

**Status: complete (areas 1–10).** Areas 1–5 were reviewed first; areas 6–10, the closing lists and the proposed plan edits follow. The edits to BUILD_PHASES.md were approved and applied.

## Method

- **Sources:**
  - a live Intercom workspace ("Frontline Prop"), read in the app's built-in browser on 1 October 2026
  - intercom.com/help and developers.intercom.com, where the screens were ambiguous or a feature was locked on the workspace's plan
  - Relay as of `main` at `5d48ce1` (phase 07 step B2 merged). STATUS.md rows were current; claims about Relay below were checked against the code and migrations.
- **Read-only.** Nothing was saved, published, sent or deleted. Settings editors were opened only to read their sections; no Save or Publish control was used.
  - One side effect: opening the inbox loaded the most recent conversation automatically, which may have marked it as read.
  - No customer data from that page (or anywhere else) is recorded here.
- **Plan limits.** Several features are locked on this workspace's plan:
  - workload management and teammate assignment limits
  - SLAs and automatic away
  - the CX score and the admin agent
  - custom metrics

  For those, the structure comes from the help docs, marked *(docs)*.
- **No personal data or metrics recorded.** Pages that showed customer data, teammate names or the workspace's own metrics were read only for structure. None of those values appear here.
- **Describe, don't transcribe.** No interface copy, article text or screen design is reproduced. The notes describe structure and behaviour.
- **Columns.**
  - **Present in Relay:**
    - **yes:** built and tested locally
    - **partial:** some of it is built; the note says what's missing
    - **no:** not built
  - **Phase:** the BUILD_PHASES.md phase that owns it. "not in plan" means no phase mentions it.

---

## 1. Inbox

| Feature | Present in Relay | Phase | Notes |
|---|---|---|---|
| Default folders: your inbox, mentions, created by you, all, unassigned, spam | partial | 04 | Relay has mine, unassigned, all open, snoozed, closed, mentions. **Missing:** "created by you" (conversations a teammate started outbound) and a **spam folder**. Spam is its own destination in Intercom, not a tag. Relay's plan only mentions spam filtering for the AI agent on email (phase 08). |
| Custom views: saved filters, AND/OR | yes | 04 | **Intercom's filters:** assignee, team, tag, SLA due in, waiting for teammate reply, started, current and initial channel, AI-agent involvement, ticket type, state and category, linked customer reports, created by, conversation attributes and ticket attributes. **Two limits:** views **cannot filter on company attributes**, and AND/OR is one level (no nested groups). Relay's plan includes company attributes, which Relay can't do yet because companies don't exist (phase 01). |
| View sharing model | yes (different) | 04 | In Intercom **every view is workspace-wide**: there are no personal views. Creating one needs a separate "manage views" permission, and teammates pin the views they want. Relay has personal and shared views. |
| View folders | yes | 04 | Intercom folders are **personal only** (sharing is an opt-in that support switches on). Relay has personal and shared folders. |
| View order | yes | 04 | Intercom keeps a teammate's **view order in browser local storage only**, so it's lost when switching device or browser *(docs)*. Relay stores position on the server. |
| How views are computed | yes (different) | 04 | Intercom evaluates views live and documents **timeouts on complex filters** ("contains" on custom data, five or more filters). Relay keeps a projection (`inbox_view_memberships`), so view cost doesn't grow with filter complexity. |
| Table layout | no | not in plan | The conversation list switches between a list and a **table with columns** (attributes as columns, search above the table). The plan only specifies a virtualised list. |
| Real-time inbox dashboard | no | 14 | A dashboard reached from the inbox nav: live queue, teammate status and SLA state. Phase 14 lists a real-time dashboard, but under reporting, not as an inbox destination. |
| AI-agent lifecycle views | no | 08 | A separate section lists AI-agent conversations by outcome: resolved, needs teammate input, escalated or handed off, pending, and spam. It implies an **AI resolution state machine on the conversation**, separate from open, snoozed and closed. |
| Review queue (QA) | no | not in plan | Inbox destinations for **conversation reviews**: all reviews, assigned to me, reviews received, issues. It's a quality-assurance workflow in which teammates' conversations are reviewed. Nothing like it is in the plan. |
| Macros: saved reply plus actions | yes | 04 | Same core. |
| Macro folders | no | not in plan | Macros are grouped into folders and filterable. |
| Macro availability by teammate or team | partial | 04 | Intercom's "available for" can limit a macro to specific teams or teammates. Relay has only personal or shared. |
| Macro availability by context | partial | 04 | A macro is available when starting a conversation, replying, and/or adding a note: several contexts per macro. Relay's macro has one mode (reply or note). |
| Macro usage and export | no | not in plan | Each macro shows its creator and how often it's been used. Usage and content can be exported (CSV). It makes macros an auditable, reportable object. |
| Macros as AI knowledge | no | 10 | Copilot recommends macros, and macros are listed as a knowledge source (area 5). |
| Notes and mentions | yes | 04 | Same core. |
| Side conversations | no | 04 (deferred to 12) | **Model:** an email or Slack thread attached to a conversation or ticket, with several per parent and a mix of channels. It **inherits the parent's assignment** (reassigning moves them too), and inbound replies are **cross-posted into the parent timeline**. Teammates can't be emailed through it (they're told to use a note). It can be translated, sent from a custom shared address, and exported. Relay's inbox plan deferred it until the email channel exists. |
| Snooze: presets and custom time | yes | 04 | Same core. |
| Snooze until the customer replies | partial | 04 | Intercom has an open-ended snooze that ends only on a reply. In Relay a reply does wake a snoozed conversation, but a snooze always needs a wake time. |
| Waking at capacity | partial | 06 | A workspace setting: when a conversation wakes and its assignee is **at capacity or away**, it's unassigned back to the team inbox. Relay has "unassign on wake" per snooze, but it doesn't check capacity or presence. |
| Bulk actions | partial | 04 | Intercom's bulk actions include **sending a reply or note**, **triggering a data connector** and **adding a topic**, and select "all matching" up to 10,000 *(docs)*. Relay has assign, tag, snooze, close, reopen, priority and ticket state, up to 5,000 with undo. Bulk reply and bulk data-connector runs aren't in the plan. |
| Context sidebar | partial | 04, 01 | **What Intercom shows:** user and company details, recent events, custom-object records linked to the conversation, and pinned apps. **Each teammate chooses** which attributes, events and apps to pin (personal layout). Relay has contact details with inline editing, recent conversations and the app-slot contract. Company, events and custom objects wait on phase 01, and per-teammate pinning isn't in the plan. |
| Search | partial | 04 | **Intercom's search:** keyword search with stemming and exact phrases in quotes, but **no boolean operators** and **tuned for English** *(docs)*. Filters: assignee, team, tag, customer, **company**, created, status, **topic, AI topic and subtopic**, **brand**, created by, and conversation and ticket attributes. Search inside a view is text-only. **"Lite" seats can't search at all.** Relay has full-text conversation search with workspace isolation; company, topic and AI-topic filters depend on phases 01 and 14. |
| Teammate presence on a conversation | yes | 04 | Intercom has a workspace switch to turn the viewing indicator off. Relay always shows it. |
| Default assignee | no | not in plan | A workspace setting: if no workflow assigns a new inbound conversation, it goes to this team or teammate. |
| Self-assign on reply | no | not in plan | A workspace choice: replying to an unassigned or team-assigned conversation either assigns it to you or leaves it where it is. |

## 2. Tickets

| Feature | Present in Relay | Phase | Notes |
|---|---|---|---|
| Three categories: customer, back-office, tracker | yes | 05 | Same model. |
| Ticket types: name, icon, description, attributes | yes | 05 | Same core. |
| Ticket attribute flags | partial | 05 | Per the API model *(docs)*, each attribute has: **required to create** (for teammates), **required to create for customers**, **visible on create**, and **visible to customers**, with types text, list, number, decimal, boolean, date and files. Relay has typed fields and **required to close**, but no create-time or customer visibility flags, and no file-type attribute. |
| Customer-submitted tickets | no | not in plan | Those create-time flags exist because **customers create tickets themselves** (a form in the messenger, or the AI agent filling the attributes). Relay converts conversations to tickets but has no customer-facing ticket form. The plan doesn't mention one. |
| Ticket states | yes (different) | 05 | In Intercom, **states are workspace-level objects** in four fixed categories (submitted, in progress, waiting on customer, resolved). Each has an internal label, a customer label, a **notification switch**, and a many-to-many link to ticket types. There's **no transition graph**: any state can follow any other. Relay's states are per type with an explicit transition graph and the same four kinds, which is stricter. |
| Notification per state | no | 05 | Whether the customer is notified on entering a state is set per state. Relay always sends a customer-visible status event. |
| Ticket state filter in the inbox | yes | 05 | Intercom offers a workspace switch to filter tickets by state category in the inbox. |
| Customer portal | partial | 05, 01 | **Company-wide:** customers see all of their company's tickets. **To prevent impersonation, it requires** a help center custom domain with **cookie forwarding**, JWT-verified identity, and **company-attribute updates from the messenger switched off**, so nobody can claim a company. Notification emails are customisable. Relay's portal is individual only (company visibility waits on phase 01), signs in with a signed link or messenger hand-over, and has no customisable emails yet. |
| Tracker broadcasts and linked reports | yes | 05 | Intercom exposes the linked customer reports as an inbox filter. |
| SLA targets | yes | 05 | The same four: first response, next response, time to close, time to resolve. |
| How SLAs are applied | yes (different) | 05 | In Intercom an SLA is **applied by a workflow step**, not a standalone policy with conditions, and it's **plan-gated**. Relay's policies have conditions evaluated at creation and on change, which is easier to reason about. |
| SLA pause rules and office hours | yes | 05 | Same: pause while snoozed or waiting on the customer; follows office hours *(docs)*. |
| Before-breach trigger | no | 11 | A workflow can run a set time **before** a target breaches, not only at breach. It's skipped if a teammate replies, snoozes or closes first *(docs)*. Relay emits a breach event; there's no early warning. |

## 3. Routing and workload

| Feature | Present in Relay | Phase | Notes |
|---|---|---|---|
| Team inboxes | yes | 06 | Same. |
| Assignment methods: manual, round robin, balanced | yes | 06 | Same, and round robin ignores limits in both. In Intercom a **balanced tie goes to whoever has waited longest since their last assignment** *(docs)*; Relay rotates ties. Intercom's balanced queue order uses priority, SLA and waiting time. |
| Teammate limit, and a separate ticket limit | yes | 06 | Same. With separate limits, a teammate at their conversation limit can still receive tickets *(docs)*. |
| Inbox limit | yes (different) | 06 | Intercom's inbox limit is **per teammate within that inbox**: it caps how many conversations each person can hold from that inbox. It applies only to balanced inboxes and is plan-gated *(docs)*. Relay's inbox limit is a **total for the team**. Neither covers the other, and the plan doesn't say which. |
| Primary inboxes per teammate | no | not in plan | Teammates can be given primary inboxes to focus on. It's part of the plan-gated limits feature. |
| Skills-based routing | no | not in plan | Named in the workload docs. Phase 11 has rule-based routing but no teammate skills. |
| Default assignee and self-assign on reply | no | not in plan | See area 1. |
| Away and away with reassignment | yes | 06 | Same. |
| Automatic away after inactivity | no | not in plan | Status switches after a period of inactivity, such as the tab in the background or the screen off. Optionally, the teammate's **assigned conversations and tickets are paused** when that happens. Plan-gated. |
| Away reasons | no | not in plan | Custom reasons a teammate picks when going away, optionally **required**. The implied data model is a reason on each presence change, which reporting can use. |
| Office hours: workspace default and per team | yes | 06 | Intercom has a workspace default and **custom office hours per team**, and **not per teammate** *(docs)*. Relay also has brand-level hours (team, then brand, then workspace). |
| Holidays and closures | yes | 06 | Same. |
| Reply-time expectation | yes (different) | 06 | Intercom has a **manually chosen** typical reply time per workspace or team, from a fixed set of durations. Relay shows the measured median, or the brand's own phrase. |
| AI agent out of hours | no | 08 | Office hours link to running the AI agent when the team is offline, through a workflow. |
| Assignment by workflow | no | 11 | The default assignee applies only when no workflow assigned the conversation. Relay has the routing interface ready for phase 11. |

## 4. Contacts and companies

| Feature | Present in Relay | Phase | Notes |
|---|---|---|---|
| Contact roles: user, lead, visitor | partial | 01 | Relay has contacts and identities and merges a visitor into a user. Segments and the role-based predefined segments aren't built. |
| Standard contact attributes | partial | 01 | **About 48 built in**, including: an **owner** (a teammate who owns a lead or user), lead category, **qualification status** (a list), last conversation rating, name and email. Relay has contacts with several emails and phones, and typed custom attributes. Owner, qualification and rating aren't modelled. |
| Attribute types | partial | 01 | Text, number, decimal, boolean, date, list. **There's also a teammate reference type** (the owner attribute), which the plan's type list doesn't have. **Limits** *(docs)*: 250 custom people and company attributes per workspace; text values up to 255 characters; manual lists up to 35 options, which can't be raised. |
| Attribute protections | no | not in plan | Three per-attribute writability flags: **API, messenger and UI** *(docs)*. They're shown as "protections" on attributes such as name and email. Turning off messenger writes stops a browser from changing a verified fact; the portal depends on this for company. The plan doesn't mention per-attribute write sources. |
| Conversation attributes | partial | 04, 01 | **Each conversation attribute has:** type; **which source set the value** (teammate, workflow or **AI agent**); **teams it's visible to**; **required to close**; and **conditions** (shown only when another attribute has a given value). Relay has typed conversation attributes with inline editing. Visibility by team, conditional fields and AI-set values are missing, and required-to-close exists only on ticket fields. |
| AI-classified attributes | no | 08 | The AI agent can fill a list attribute by classifying the conversation (an example here: issue type, set by the AI agent). |
| Companies | no | 01 | **Standard attributes:** name, external ID, last seen, created, people count, web sessions, plan, monthly spend, size, industry, website. A contact can belong to several companies. **In filters, a person matches if *any one* of their companies matches** *(docs)*, which the plan should state explicitly. |
| Custom objects | no | 01 | **Model:** workspace-defined types with typed attributes and **reference attributes** (to people, conversations or other objects; **reference one or reference many**). Records are created through the API or data connectors. They're shown in the inbox sidebar and usable in workflows, which use a reference-many conversation attribute to hold options and a reference-one to hold the choice *(docs)*. This workspace has none. Relay reserves `owner_type = 'object'` on attribute definitions but has no object tables. |
| Segments | no | 01 | **Operators by type** *(docs)*: text (starts with, ends with, contains, contains exact word, is, is not, unknown, has any value); number (greater, less, is, is not, unknown, any); boolean; date (more than, less than, exactly, after, on, before, unknown, any). **Predefined segments** cover active, all leads, all users and new. AND/OR combinations. |
| Events | no | 01 | **A registry of event names** with descriptions and recent-usage stats, **capped at 120 enabled names per workspace** (archived ones don't count). Each event keeps metadata, first, last and count, but **metadata can't be used in segments** *(docs)*. One built-in event ("viewed article") feeds help center data into people data. The plan asks for event occurrence with counts and windows; it doesn't mention a name registry or limits. |
| Tags | partial | 01 | **One tag namespace over six object types:** people, companies, conversations, **outbound messages, articles and AI answers**, with per-type counts. Teammates can **hide tags for themselves** ("visible to you"). Relay tags conversations. |
| Lead qualification | no | 11 | Pick which attributes qualify a lead. They show on the profile and are collected by a bot. Phase 11 mentions qualifying a lead in workflows, but not the attribute set. |
| Delete a person (GDPR) | no | 16 | A hard delete of a user or lead and their conversations, by ID or email, including archived people. |
| Blocking a person | no | not in plan | A blocked list of people who can't send messages. |
| Imports and exports | no | 17 | Import from Zendesk and other sources. |
| AI topics | no | 14 | Topics generated from conversations, managed under data settings and usable as **search filters and bulk actions** (area 1). Phase 14 mentions topics only as a reporting gap. |

## 5. Knowledge

| Feature | Present in Relay | Phase | Notes |
|---|---|---|---|
| Several help centers per workspace | yes | 07 | One is the default. Relay has one per brand. |
| Collections and nesting | partial | 07 | Collections **nest up to three levels** *(docs)*. Relay has a fixed two: collection, then optional section. |
| An article in several places | yes (ahead) | 07 | **In Intercom an article can be in only one collection within a help center** (it can appear in other help centers), and changing this isn't planned *(docs)*. Relay already allows several placements in one help center. |
| Languages | yes | 07 | Default plus extra languages. **Intercom picks the visitor's language from device settings.** Relay uses `Accept-Language` and a fallback chain, and redirects. |
| Domains | partial | 07, 17 | A default hosted address (`intercom.help/…`) plus a custom domain, with a choice of HTTPS quick setup, manual HTTPS or plain HTTP. Relay has the hosted path and custom domains through the portal domain table. The default subdomain and certificates are deferred to phase 17. |
| Redirects | partial | 07 | Intercom has **manually managed redirects**, **also generated automatically when importing articles**, so links from an old help desk keep working. Relay generates redirects only for its own slug changes; there's no manual redirect list and no import mapping. |
| Analytics tracking ID | no | not in plan | A Google Analytics ID per help center. Relay's help center sends no scripts by design (CSP), so this would be a deliberate decision either way. |
| Restricted articles: login link | yes | 07 | A configurable login URL for visitors who reach articles meant for users. Relay's sign-in page points at the portal; there's no configurable login URL yet. |
| Search engine indexing switch | yes | 07 | Same. |
| Social sharing image and favicon | no | 07 (C1) | Per help center. Relay's theme logo and images wait on knowledge files (C1). |
| Article audience | partial | 07, 01 | Intercom targets **audience rules on segments** (people or company data). Relay has public, signed-in or internal. Segment targeting waits on phase 01. |
| AI-agent audiences | no | 08 | **"Fin audiences"** are reusable segments that control **what content the AI uses, which guidance it follows, and which data connectors and workflows it may trigger** for a group of customers. **An article is used only if the customer passes both the help center audience and the AI audience** *(docs)*. Phase 08 lists audience targeting per configuration surface, which covers the idea, but the intersection rule isn't stated. |
| Availability per consumer | yes | 07 | Intercom's content list has a column per consumer: help center, Copilot, and **each AI-agent persona** (service, sales, ecommerce). Relay has three switches: help center, inbox and AI. |
| Several AI-agent personas | no | 08 | Separate AI agents for service, sales and ecommerce, **each with its own content availability**. Phase 08 has identity and persona per brand, not several agents with different purposes. |
| Sources: public articles, internal articles, snippets | yes | 07 | Same. |
| Uploaded documents | no | 07 (C1) | Next step. |
| Websites | no | 07 (C1) | **Website sync settings** *(docs)*: start URLs, extra URLs, **exclude-URL globs**, **CSS selectors to strip**, **sitemap discovery**, and JavaScript rendering. The refresh is **weekly**, slowed to **every 14 days** for very large or JavaScript-heavy sites. Useful input for C1, which asks for robots rules, stable ids, hashes and removal detection, but not exclusion globs or CSS stripping. |
| Third-party knowledge connectors | no | not in plan | **Public:** Zendesk (sync or import). **Internal:** **Guru, Notion and Confluence** (sync or import). **Copilot** can also read Zendesk tickets imported as history. The plan has files and synced web pages only. |
| Past conversations as knowledge | no | 10 | Copilot can draw on the team's conversations and tickets from the **last four months**. Phase 10 mentions retrieving similar past conversations. |
| Content preview and audience filter | no | 08 | The content list has an audience filter and a preview, showing which content a given customer group would get. |
| Search and feedback | yes | 07 | B2 built both. |

---

## 6. The AI agent

| Feature | Present in Relay | Phase | Notes |
|---|---|---|---|
| Lifecycle: train, test, deploy, analyse | no | 08 | The agent area is organised around a loop. **Train:** content, guidance, procedures, escalations. **Test:** previews, batch tests, simulations. **Deploy:** channels and audiences. **Analyse:** performance, recommendations, topics, trends, incidents, monitors. It also has a changelog of configuration changes. |
| Guidance | no | 08 | Natural-language rules for tone, policy and behaviour. Matches phase 08's guidance surface. |
| Escalation: rules vs guidance | no | 08 | **Built in:** escalation when the customer asks for a human, is clearly frustrated, or is stuck in a loop. **Configurable** *(docs)*: **escalation rules** (data conditions on people, company or conversation data; when one matches, the agent doesn't answer at all) and **escalation guidance** (natural language). Workflows then route after escalation. Phase 08 lists triggers but doesn't separate data rules (deterministic, no answer) from language guidance. |
| Procedures | no | 09 | Plain-language step-by-step tasks with data-connector calls and **handoff steps**. They're versioned and published separately, and tested with **simulations** (an AI customer plays the scenario and is judged against success criteria you write) *(docs)*. Phase 09 covers procedures; the AI-simulated customer as a test method isn't in the plan. |
| Testing | no | 08 | *(docs)* **Previews:** manual, with an event log. **Batch tests:** many questions at once, checked for coverage across audiences, brands and languages. **Simulations:** procedure end to end. Phase 08's golden set and build gate go further on regression. Intercom's tests are run by hand, not as part of CI. |
| Identity, tone and length | no | 08 | Name and avatar, then tone of voice and answer length, plus a **formal or informal pronoun setting for languages that have one**. Phase 08 has identity and persona per brand; it doesn't mention formality or answer length. |
| Languages | no | 08 | A set of languages to answer in. The workspace also has default and extra languages (area 10). |
| Email behaviour | no | 08, 12 | Separate settings for how the agent answers by email. **"Human in the loop":** the AI drafts an email reply and a **teammate reviews it before it's sent**, with its own report and dataset fields. This mode isn't in the plan. |
| Separate inbox for AI conversations | no | 08 | An option to keep the AI agent's conversations in their own inbox. |
| Several agents with different purposes | no | 08 | Separate agents for **service, sales and ecommerce**, each with its own content availability (area 5). The sales agent captures email and phone, notes prior contact and **books meetings** (dataset fields). Phase 08 has one agent with personas per brand. |
| Audiences | no | 08 | Reusable segments that decide content, guidance, connectors and workflows per customer group (area 5). |
| AI memory | no | not in plan | A workspace switch that lets the agent **remember context from a customer's previous conversations**. A dataset field records when it was used. This is a privacy decision, and the plan doesn't mention it. |
| Outcomes and billing | no | 08, 16 | *(docs)* **Resolution:** confirmed by the customer, or **assumed after at least 24 hours of no reply**, and **deducted if the customer comes back** to the same conversation. **Also billable:** procedure handoffs, lead qualification and disqualification, at most once per conversation. Phase 08's ledger has the same shape. The plan doesn't bill handoffs or qualification; that's a decision for phase 16. |
| Spend alerts and hard limits | no | 16 | Alerts at chosen levels. A hard monthly limit **pauses the agent and sends conversations to humans** *(docs)*. Matches phase 16's spend cap. |
| CX score | no | 14 | A paid add-on. **An AI rates every conversation 1–5**, with an explanation and reason categories (product feedback, answer quality, customer emotion, policy feedback, customer effort), about 2–3 hours after close. Scores can **trigger a workflow** and are a dataset column. The plan measures CSAT only from surveys. |
| Recommendations | no | 08, 14 | Suggestions for content, data and action gaps, applied in one click *(docs)*. Phase 08 has a human review queue feeding a content-gap list. |
| Incidents and monitors | no | not in plan | Analyse pages for the agent's **incidents** and **monitors** (alerting on changes in agent behaviour or performance). The pages didn't render in the pane, so the details are unverified. |
| An admin agent ("Operator") | no | not in plan | An agent for the team running support. It analyses performance, finds content gaps, drafts or edits articles, reviews guidance and builds procedures, and **every change is a proposal with a diff that a human approves**. A paid add-on *(docs)*. |
| Copilot seats | no | 10, 16 | Copilot access is set per teammate (a column on the teammate list). Phase 10 has switches per teammate; billing per Copilot seat isn't in phase 16. |

## 7. Workflows

| Feature | Present in Relay | Phase | Notes |
|---|---|---|---|
| Triggers | no | 11 | *(docs)* The list has 13 triggers plus SLA ones:
- **Customer behaviour:** visits a page; **clicks an element on the site**; opens a new conversation in the messenger; sends their first message; sends any message; **calls**; **has been unresponsive**.
- **Teammate actions:** sends any message; changes conversation state; changes assignment; **adds a note**.
- **Tickets:** a ticket is created; ticket state changes.
- **Quality:** a CX score is received.
- **SLAs:** before or at a breach.

**Phase 11 has triggers Intercom lacks:** attribute change, event received, segment entry or exit, schedule, webhook. **Intercom has triggers phase 11 lacks:** page visit, element click, inbound call, unresponsive customer, note added, CX score. |
| Who fires a trigger | no | 11 | The teammate triggers **ignore changes made by the AI agent**, and **bulk assignments don't fire the assignment trigger** *(docs)*. Automation silently skips some changes. |
| One workflow per trigger | no | 11 | Workflows are grouped by trigger. **Only the highest-priority matching customer-facing workflow runs** (teammates order them by dragging), while background-only workflows can run alongside. That's an exclusivity rule the plan doesn't mention. |
| Customer-facing vs background | no | 11 | Some triggers allow **background actions only**: no customer messages, and some can't set ticket state. |
| Conditions and branches | no | 11 | Person, company, message and conversation data, availability (office hours, teammates) and topics. **The first matching branch wins.** A separate "apply rules" action handles several independent conditions. **A branch whose conditions are too complex is treated as no match and falls to "else"** *(docs)*: a silent failure. |
| Customer-facing steps | no | 11 | Send a bot message; collect a reply; reply buttons; **buttons built from custom-object records**; **send a ticket form**; let the AI agent answer; show expected reply time; send an app; pass to a **reusable workflow**. |
| Actions | no | 11 | Apply rules; tag or untag the conversation or person; assign; snooze; wait; mark priority; **apply an SLA (only one per conversation; later ones are ignored)**; call a data connector or custom action; add a note; set ticket state; **notify a Slack channel**; **turn off customer replies**; close; set conversation data; integration actions. |
| Versioning | no | 11 | Live, paused and draft. **One draft at a time.** Version history with preview. **Rollback creates a new draft** rather than overwriting *(docs)*. Phase 11's immutable versions and in-flight pinning go further. |
| Preview | no | 11 | A preview with a chosen preview user, excluded from reporting. Phase 11's "simulate against a real conversation without side effects" is stronger. |
| Run log | no | 11 | **No per-run log was found.** The list shows aggregate sent, goal, engaged and completed counts per workflow, plus trigger troubleshooting pages. Phase 11's per-run record would be a clear advantage. |
| Simple automations | no | 11 | A separate lightweight area (switches for common automations) next to full workflows. |
| Templates | no | 11 | Not inspected. Phase 11 asks for ten. |

## 8. Outbound

| Feature | Present in Relay | Phase | Notes |
|---|---|---|---|
| Message types | no | 13 | The type filter lists chat, banner, tooltip, post, email, mobile push, product tour, checklist, SMS, survey, mobile carousel, workflow, broadcast, **Discord broadcast, Telegram broadcast** and WhatsApp. News items live in their own **newsfeeds and news labels** (settings). Phase 13 covers most of these. **Broadcasts to WhatsApp, Discord and Telegram, and outbound workflows, aren't listed.** |
| Audiences | no | 13 | **Dynamic** (everyone who matches now or later) or **fixed** (only those who match now). Audiences can come from rules or a **CSV upload**. Email audience checks run **hourly and can't be triggered by hand** *(docs)*. Phase 13 evaluates rules at send time, which is more responsive. |
| Frequency | no | 13 | *(docs)* Rule-based messages send **at most once a day**; event-based ones can repeat at shorter intervals, with a maximum count. **No workspace-wide cap per contact across all outbound was found**; limits are per message and per channel (for example a monthly SMS allowance). Phase 13's frequency capping across all outbound is ahead. |
| Subscriptions | no | 13, 01 | Email or SMS subscription types, **opt-in or opt-out consent**, a preference page from the unsubscribe link, an **opt-in form app** to collect consent in conversations, and webhooks on subscribe and unsubscribe *(docs)*. Phase 13 has no bypass flag; Intercom documents **sending email to unsubscribed contacts** as an option. |
| Goals, A/B tests, control groups | no | 13 | Same concepts *(docs)*. |
| Series | no | 13 | A visual journey builder across message types *(docs)*. Matches phase 13. |
| Email templates and customisation | no | 13 | Reusable email templates, and message settings including **universal links** (links that open in the app). |
| Saved views of messages | no | 13 | The message list has saved views ("latest", "recent drafts"), much like inbox views. |
| Per-message stats | no | 13 | Sent, goal, and people types targeted (visitors, leads, users). |

## 9. Reports

| Feature | Present in Relay | Phase | Notes |
|---|---|---|---|
| Overview | partial | 14 | Human and AI together:
- **Funnel:** AI involved, chatbot replied, teammate replied, closed with no reply, pending, AI resolved or escalated, closed by bot or teammate
- **Volume:** by source and by channel
- **Time to close:** by channel
- **AI:** deflection and resolution rates
- **Teammates:** median first response, response, close and handling times
- **Quality:** CX score

**Reports can be viewed in a chosen timezone.** Relay has only measured first-response medians (for reply-time expectations) and the help center search report. |
| Pre-built reports | no | 14 | Calls, conversation tags, conversations, Copilot, CX score, **effectiveness**, AI agent, **human in the loop**, responsiveness, SLAs, surveyed CSAT, team inbox performance, teammate performance, tickets, and several legacy reports (articles, email deliverability, leads, sales, workflows). Phase 14's list has no **effectiveness**, **calls**, **email deliverability** or **human-in-the-loop** reports. |
| Conversation dataset | no | 14 | The export lists about 100 columns *(seen)*:
- timing in wall-clock and office hours
- ratings from teammates, the AI and chatbots, with remarks
- initiator, and who first contacted the customer
- AI involvement, resolution state, deflection, a **"constrained" reason**, content referenced, **memory referenced**, guidance applied, procedures triggered or failed, escalation rules applied
- human-in-the-loop fields
- sales-agent outcomes
- handling time **and adjusted handling time**, total snoozed time, number of reassignments, replies to close
- **resolved on first contact**, **time since prior resolution**, **recurring subtopic**
- source URL, CX score and explanation

Phase 14's metric dictionary lacks **first-contact resolution, repeat contact, adjusted handling time and reassignment count**. |
| Custom reports | no | 14 | Pick from over 100 chart templates or build your own. **Nine chart types:** KPI, column, bar, donut, line, combo, area, heatmap, table. Aggregations: average, median, percentile, min, max, sum *(docs)*. Same shape as phase 14. |
| Custom metrics | no | 14 | Reusable metrics of three kinds: **percentage, ratio or absolute**, with **separate filters on the numerator and the denominator** (for example reopen rate or email close rate). Both sides must come from the same dataset *(docs)*. Not in phase 14. |
| Saved filters | no | 14 | Filter sets reusable across reports. |
| Topics | no | 14 | A topics explorer and trends (AI-generated topics and subtopics). Matches phase 14's topic model. |
| Access and sharing | no | 14 | *(docs)* Private, shared with teammates, or **shared with roles**, with view, edit and filter rights. **Scheduled delivery** to teammates, roles or **external emails** as a public link that **expires after 30 days, with no password**. Phase 14's expiring, optionally passworded link is stricter. |
| Dataset export | no | 14 | CSV export of a dataset, by hand or **on a schedule**. Phase 14 adds a warehouse export with a documented schema. |
| Real-time dashboard | no | 14 | Reached from the inbox nav. Inbox health and team capacity, **refreshed every 60 seconds only while it's the active browser tab** *(docs)*. Matches phase 14. |

## 10. Settings: permissions, security, data, billing

| Feature | Present in Relay | Phase | Notes |
|---|---|---|---|
| Teammates list | partial | 01, 16 | **Columns:** status, **seat type**, **Copilot access**, permission (role), teams, 2FA, **alias**. **Also:** an **invitations** tab, **roles**, **SCIM provisioning**, **activity logs** (filterable, exportable to CSV), and CSV export of teammates. Relay has teammates, roles, a capability registry and team membership. |
| Permissions | partial | 01, 16 | Grouped capabilities, for example export people and company data, access workspace data settings, access reports, share reports, manage teammates and seats, manage general and security settings *(docs)*. **Views have their own "manage views" permission.** Relay's registry has 21 capabilities. |
| Seats | no | 16 | **Full** and **Lite**. Lite has limited access, **can't search the inbox**, and needs a direct link to open a conversation. Each plan includes some free Lite seats *(docs)*. Phase 16 has full and limited seats. |
| Teammate alias | no | not in plan | Customers see an alias instead of the teammate's real name: a **workspace default alias** plus a **per-teammate alias**, which wins. Useful for outsourced teams and privacy. |
| Workspace basics | partial | 01 | **Covers:** name, a **customer-facing name** (separate), timezone; a **companies** switch with **company attributes blocked from the messenger**; a **test workspace** (a paired sandbox for trying integrations); **deleting the workspace after a 14-day delay**; an Intercom attribution switch; **turning team mentions off**; **hiding CSAT scores from agents**. |
| What wakes a snoozed conversation | partial | 04 | Workspace switches to stop **internal notes, assignments, and back-office ticket state changes** from waking snoozed conversations. Customer replies, the timer, and assignments with a reply always wake them. In Relay, a fixed set of events wakes them. |
| Workspace owners | no | 16 | Who receives service announcements. A **security contact** is separate. |
| Brands | yes | 01 | A brand groups a help center and an AI agent identity. Relay has brands with their own help center, messenger settings and calendar. |
| Authentication | partial | 16 | 2FA (can be required), Google sign-in, SAML SSO, **custom session length** (by default, re-authentication after 4 days of inactivity). Relay signs teammates in through the hosting platform; none of these exist yet. |
| IP allowlists | no | 16 | **Separate allowlists for the app and for the REST API.** Phase 16 has one optional IP allowlist. |
| Messenger security | yes | 03 | Identity verification **enforced per platform** (web, iOS, Android) with **named secret keys showing last use**. Relay enforces signed identity per brand on the web messenger. |
| Customer verification before data connectors | no | 09 | **Rules per channel and audience** setting how a customer must be verified before connectors run, with a fallback rule. Phase 09 has an identity requirement on write procedures, not a configurable rule table per channel. |
| Content redaction | no | 16 | **Built-in and custom rules** that replace sensitive content in conversations with asterisks. Phase 16 redacts logs and model payloads; redacting conversation content isn't in the plan. |
| Notification email content | no | 12 | A switch to include or leave out conversation content in customers' reply notification emails. |
| Lead identification from email links | no | 13 | A lead who clicks through from an email is identified on the site. |
| Merge controls | partial | 01 | Switches for **merging conversations across different people** (a privacy risk) and **merging unverified leads into users by email** (only on verified requests). Relay merges through identity resolution, with an audit trail and no such switches. |
| Attachments | yes | 03 | **Allowed:** default file types plus extra extensions, with forbidden types; display conditions; which **input types** the messenger offers (camera, images and video, files, GIFs, voice notes). Relay has a type allowlist and virus scanning; no voice notes or GIFs. |
| Link safety | no | not in plan | **Warnings on untrusted links**, **malicious-link detection** that teammates must acknowledge, and **trusted and blocked link policies** (blocked links can't be opened). |
| Security health check | no | not in plan | A health-check tab scoring the workspace's security setup (it didn't render; existence only). |
| AI memory and training | no | 16 | Switches for AI memory and for **training and fine-tuning on customer data**. Phase 16 has "no third-party model training" in its stricter mode. |
| Translation | no | 10 | Inbox translation both ways, default plus up to ten languages, 68 supported, a **translation tone** (friendly, neutral, professional) and a **glossary**. Phase 10 has two-way translation; tone and glossary aren't in it. |
| Usage and limits | no | 16 | Usage so far this billing period; **alerts per metric** (email to billing contacts) versus **limits that pause the feature**. **Metered units** include AI outcomes, SMS segments, bulk email, bulk WhatsApp, phone segments, and messages sent per type (posts, tours, push, carousels, surveys). Chats, banners, tooltips and inbound WhatsApp are free *(docs)*. Matches phase 16's metering, with a longer list of units. |
| Plan gating | no | 16 | Many features are locked by plan or add-on, as this audit kept hitting. Phase 16's single gating policy fits. |
| Personal settings | partial | 04 | Theme, language, notification preferences, **tags visible to you**, personal API tokens, **giving Intercom's support team temporary access to the account**, and personal translation settings. |

---

## Things Intercom has that the plan doesn't account for at all

1. **Conversation quality review (QA).** An inbox review queue (all, assigned to me, received, issues) where leads review teammates' conversations. Together with the AI **CX score** (every conversation rated 1–5 with reasons, able to trigger workflows), it's a whole quality layer with no home in the plan.
2. **Customer-submitted tickets.** Ticket forms sent in the messenger or by workflows, with ticket attributes flagged **required to create**, **required for customers**, **visible on create** and **visible to customers**, plus a file attribute type. The plan has teammates converting conversations only.
3. **Per-attribute write sources.** Each attribute says whether the API, the messenger or the inbox may change it, and company attributes can be locked against messenger updates. **Intercom's company-wide portal relies on this**, so Relay's planned company visibility needs it.
4. **Workload details:**
   - **skills-based routing** and **primary inboxes per teammate**
   - a **default assignee** and **self-assign on reply**
   - **automatic away on inactivity**, which can also pause the teammate's assigned work
   - **away reasons**, optionally required
   - unassigning a woken conversation whose owner is at capacity or away
   - workspace switches for **what wakes a snoozed conversation**
5. **AI agent capabilities:**
   - **several AI agents with different jobs** (service, sales with **meeting booking**, ecommerce), each with its own content
   - **human-in-the-loop email**: the AI drafts, a teammate approves
   - **AI memory** across a customer's conversations
   - **simulated-customer tests** for procedures
   - **incidents and monitors** on agent behaviour
   - a **formal or informal pronoun** setting
   - an **admin agent** that proposes changes to content, guidance and procedures as diffs for approval
6. **Conversation attributes that are** visible only to chosen teams, **conditional** on other fields, or **filled in by the AI**.
7. **Macros:** folders, availability by team or teammate, several contexts per macro (start, reply, note), and **usage counts with export**.
8. **Knowledge connectors and redirects:** **Zendesk** (public articles), **Guru, Notion and Confluence** (internal), imported support tickets as Copilot knowledge; **manually managed redirects and redirects generated on import**; website sync **exclusion globs and CSS-selector stripping**.
9. **Security and data controls:**
   - **link safety** (untrusted warnings, malicious-link detection, trusted and blocked domains)
   - **content redaction rules** on conversation text
   - **customer verification rules per channel and audience** before data connectors run
   - **separate IP allowlists** for the app and the REST API
   - a **security health check**
   - switches for **cross-user conversation merging** and **merging unverified leads by email**
10. **Workspace and teammate details:**
    - **teammate aliases** (workspace default and per teammate)
    - a separate **customer-facing name**
    - a paired **test workspace**
    - **hiding CSAT from agents**
    - turning team mentions off
    - giving the vendor's support team temporary account access
11. **Reporting:**
    - **custom metrics** (percentage, ratio or absolute, with separate numerator and denominator filters)
    - **saved filters**
    - a **report timezone**
    - **first-contact resolution, repeat contact, adjusted handling time and reassignment counts**
    - effectiveness, calls, email deliverability and human-in-the-loop reports
12. **Inbox:** a **table layout**, a **spam folder**, "created by you", **bulk reply and bulk note**, bulk data-connector runs and bulk topic, and **per-teammate pinning in the sidebar**.
13. **Translation tone and a glossary**; **Discord, Telegram and WhatsApp broadcasts**; **outbound audiences from a CSV upload**.

## Things in the plan that Intercom doesn't appear to have

Ahead, and worth keeping:
- **Workflow run log** per execution, with every node, decision and input. Intercom shows only aggregate counts per workflow.
- **Workflow simulation against a real conversation** without side effects. Intercom previews with a test user.
- **Workflow triggers** on attribute change, event received, segment entry or exit, schedule and webhook.
- **Loop protection** and immutable versions with in-flight runs pinned. Intercom allows one draft per workflow, and rollback creates a draft.
- **Global frequency cap per contact across all outbound.** Intercom caps per message and per channel. Also **send-time audience evaluation**, where Intercom checks hourly.
- **Subscriptions with no bypass.** Intercom documents sending email to unsubscribed contacts.
- **Ticket state transition graph** per type, and **SLAs as standalone policies with conditions** rather than a workflow step that applies only once.
- **Shared views and folders, a precomputed projection, and server-stored order.** Intercom: workspace-only views, personal-only folders, live evaluation that can time out, order kept in the browser.
- **Several placements of one article** within a help center.
- **AI evaluation as a build gate** (a golden set that fails the build on regression). Intercom's batch tests and simulations are run by hand.
- **Report links with a password**, and a **warehouse export with a documented schema**.
- **Attribute snapshots at conversation start** so history doesn't change; Intercom doesn't document this.
- **A metric dictionary** (METRICS.md) with exact formulas.
- **Deletion certificates**, and deletion that covers embeddings and analytics.

Possibly invented work (Intercom does without, so treat it as optional):
- **Phase 08's out-of-hours modes** (take a message, promise a reply time). Intercom just runs the AI agent out of hours through a workflow.
- **An inbox limit as a team total.** Intercom's limit is per teammate within an inbox; consider whether Relay needs both before building more.

## Things Intercom does that look weak or awkward

- **Workflows fail quietly.**
  - A branch whose conditions are too complex is treated as "no match" and falls to "else".
  - Teammate triggers ignore changes made by the AI agent and by bulk assignment.
  - Only the top-priority customer-facing workflow per trigger runs, which is easy to miss.
  - **There's no per-run log** to explain any of this.
  - **Relay can be better:** run logs, explicit validation of conditions, and a visible explanation when a workflow doesn't run.
- **Inbox views.**
  - They can't filter on company attributes.
  - They're evaluated live and **can fail to load** with complex "contains" filters.
  - Their **order is kept in the browser**, and folders are personal only.
  - Relay's projection model and shared folders avoid all of these.
- **Inbox search is tuned for English**, with no boolean operators, and Lite seats can't search at all. That's a poor fit for multilingual teams; Relay's per-language stemming (B2) could carry over to inbox search.
- **SLAs only through a workflow step**, one per conversation (later ones are silently ignored), and plan-gated.
- **AI billing.**
  - A resolution is **assumed after 24 hours of silence** and taken back if the customer returns, which isn't easy to audit.
  - **Handoffs and lead (dis)qualifications are billable too.**
  - Relay's ledger, where every billed row has its rule and conversation, answers the obvious dispute.
- **"Inbox assignment limit"** means a per-teammate cap within one inbox, which the name doesn't suggest. Relay should name its limits unambiguously.
- **One collection per article** within a help center, with no plan to change it.
- **Outbound:**
  - audience checks only hourly, with no manual refresh
  - rule-based messages limited to once a day
  - no workspace-wide frequency cap per contact
- **Report sharing:** public links expire after 30 days with no password option, and scheduled snapshots don't update.
- **Real-time dashboard** refreshes every 60 seconds and **only while it's the active tab**.
- **Plan and add-on gating everywhere:** workload limits, SLAs, CX score, the admin agent, custom metrics and automatic away each sit behind a different tier. A single, legible gating policy (phase 16) and fewer cliffs would be a selling point.
- **Reply-time expectations are typed in by hand** from a fixed list, not measured; Relay measures them.

## Edits to BUILD_PHASES.md (approved and applied, 1 October 2026)

Each is in its phase's prompt, in a block marked "Added after the Intercom gap audit", just before the acceptance criteria. Phases 04–06 were already built, and phase 07 steps A1–B2 too, so their additions are marked as follow-up work. The inbox-limit question in phase 06 is recorded as a decision to make, not settled.


1. **Phase 01:**
   - Add per-attribute **write sources** (API, messenger, inbox), with company attributes lockable against the messenger. The portal's company visibility depends on it.
   - Add a **teammate reference** attribute type (lead or user owner).
   - Add an **event-name registry** with descriptions and an explicit cap.
   - State the **"any one company matches"** rule for company filters on people.
   - Extend tags to articles and outbound messages.
   - Add **blocked contacts**.
2. **Phase 04:**
   - A **table layout**.
   - A **spam folder** and a "created by you" view.
   - **Macro folders**, macro availability by team and by context, and **macro usage stats** with export.
   - **Snooze until the customer replies**, and workspace control of **what wakes a snoozed conversation**.
   - **Bulk reply and note**.
   - **Per-teammate sidebar pinning**.
   - **Conversation attributes** visible to chosen teams and conditional on other fields.
   - **Teammate aliases** and **hiding CSAT from agents**.
3. **Phase 05:**
   - **Customer-submitted tickets** (a form in the messenger or a workflow) with **create-time and customer-visible attribute flags**, and a **file** attribute type.
   - A **customer notification switch per state**.
4. **Phase 06:**
   - **Decide and document the meaning of the inbox limit**: team total, per teammate within the inbox, or both.
   - **Primary inboxes**.
   - **Skills-based routing** (a teammate skill attribute used by routing).
   - **Default assignee** and **self-assign on reply**.
   - **Automatic away on inactivity**, optionally pausing assigned work.
   - **Away reasons**.
   - Capacity-aware wake reassignment.
5. **Phase 07 (C1 and C2):**
   - Website sync **exclusion globs, CSS-selector stripping and JavaScript rendering**.
   - **Manually managed redirects** and an import redirect map.
   - A **connector interface** for third-party knowledge sources (Zendesk, Notion, Confluence and Guru as candidates).
   - Decide on **nested collections** beyond two levels, and on **privacy-preserving help center analytics** instead of third-party scripts.
6. **Phase 08:**
   - Separate **escalation rules** (data conditions, no answer generated) from **escalation guidance**.
   - An **AI conversation state** (resolved, needs teammate input, escalated, pending) with its own inbox views.
   - **Several agents with different purposes**, each with its own content.
   - **Human-in-the-loop email replies**.
   - **Formality and answer-length** settings.
   - An explicit decision on **AI memory** across conversations, with a privacy switch.
   - **Simulated-customer tests** alongside the golden set.
   - **Incident monitors** on agent behaviour.
7. **Phase 09:** a **customer verification rule table per channel and audience**, checked before any connector runs.
8. **Phase 10:** a **translation tone and glossary**; **Copilot access per teammate** as a billable seat dimension (with phase 16).
9. **Phase 11:**
   - Add triggers for **page visit, element click, inbound call, unresponsive customer, note added, quality score received, and before an SLA breach**.
   - Steps: **collect a reply, send a ticket form, reply buttons built from custom-object records, show expected reply time, reusable sub-workflows**.
   - Actions: **notify Slack** and **turn off customer replies**.
   - **Decide explicitly** whether several customer-facing workflows can run on one trigger, and **refuse to save conditions that can't be evaluated** rather than falling through silently.
10. **Phase 13:** **dynamic vs fixed audiences** and **CSV-upload audiences**; **WhatsApp, Discord and Telegram broadcasts**; consent collection inside conversations; **lead identification from email clicks**.
11. **Phase 14:**
    - **Custom metrics** (percentage, ratio, absolute, with separate numerator and denominator filters) and **saved filters**.
    - A **report timezone**.
    - **First-contact resolution, repeat contact, adjusted handling time and reassignment count** in METRICS.md.
    - **Effectiveness, calls, email deliverability and human-in-the-loop** reports.
    - **Conversation quality review** (review queue, reviewers, issues), possibly with an **AI quality score**. It could be its own phase; it's large.
12. **Phase 16:**
    - **Link safety**.
    - **Content redaction rules** for conversation text.
    - **Separate app and API IP allowlists**.
    - **Session length policy** (already partly there).
    - A **security health check**.
    - **Switches for risky merges**.
    - A **test workspace** (also relevant to phase 15).
    - A **vendor support access** grant with an audit trail.
    - A **longer list of metered units** and **alerts vs hard limits** per metric.
    - **Lite-seat capability limits** written into the seat policy.

## Sources

Intercom help articles read for this audit:
- [Organize your Inbox with custom views and folders](https://www.intercom.com/help/en/articles/6588834-organize-your-inbox-with-custom-views-and-folders)
- [Inbox search and filter](https://www.intercom.com/help/en/articles/6516006-inbox-search-and-filter)
- [Side conversations](https://www.intercom.com/help/en/articles/8398956-side-conversations)
- [Snooze a conversation](https://www.intercom.com/help/en/articles/6564538-snooze-a-conversation)
- [Take bulk action on every conversation matching your search](https://www.intercom.com/changes/en/152435-take-bulk-action-on-every-conversation-matching-your-search)
- [Customize the Inbox to suit you](https://www.intercom.com/help/en/articles/7911926-customize-the-inbox-to-suit-you-and-how-you-work-best)
- [Set SLAs for conversations and tickets](https://www.intercom.com/help/en/articles/6546152-set-slas-for-conversations-and-tickets)
- [Trigger a Workflow before or when an SLA breaches](https://www.intercom.com/help/en/articles/15362781-trigger-a-workflow-before-or-when-an-sla-breaches)
- [Balanced assignment deep dive](https://www.intercom.com/help/en/articles/6553774-balanced-assignment-deep-dive)
- [Ticket Assignment Limit](https://www.intercom.com/help/en/articles/11955550-ticket-assignment-limit)
- [Inbox Assignment Limits](https://www.intercom.com/help/en/articles/12960865-inbox-assignment-limits)
- [Organize team inboxes](https://www.intercom.com/help/en/articles/197-organize-team-inboxes)
- [Workload management explained](https://www.intercom.com/help/en/articles/6560715-workload-management-explained)
- [Create and track custom data attributes](https://www.intercom.com/help/en/articles/179-create-and-track-custom-data-attributes-cdas)
- [Data Attribute (API model)](https://developers.intercom.com/docs/references/rest-api/api.intercom.io/data-attributes/data_attribute)
- [How to segment your contacts](https://www.intercom.com/help/en/articles/324-how-to-filter-and-segment-users)
- [Setting up references with Custom Objects](https://www.intercom.com/help/en/articles/6298283-setting-up-references-with-custom-objects)
- [Create collections in your Help Center](https://www.intercom.com/help/en/articles/56647-create-collections-in-your-help-center)
- [Sync and manage websites](https://www.intercom.com/help/en/articles/9357945-sync-and-manage-websites)
- [Control who can see your public articles](https://www.intercom.com/help/en/articles/2982784-control-who-can-see-your-public-articles)
- [Knowledge FAQs](https://www.intercom.com/help/en/articles/9357957-knowledge-faqs)
- [Manage Fin AI Agent's escalation guidance and rules](https://www.intercom.com/help/en/articles/12396892-manage-fin-ai-agent-s-escalation-guidance-and-rules)
- [Building Fin Procedures](https://www.intercom.com/help/en/articles/13449439-building-fin-procedures)
- [Fin AI Agent outcomes](https://www.intercom.com/help/en/articles/8205718-fin-ai-agent-outcomes)
- [Simulations vs. Batch tests vs. Previews](https://www.intercom.com/help/en/articles/14077180-simulations-vs-batch-tests-vs-previews)
- [Fin Operator explained](https://www.intercom.com/help/en/articles/14707198-fin-operator-explained)
- [Get notified of your Fin usage and set hard limits](https://www.intercom.com/help/en/articles/8060969-get-notified-of-your-fin-usage-and-set-hard-limits)
- [How to trigger a Workflow](https://www.intercom.com/help/en/articles/7434613-how-to-trigger-a-workflow)
- [How to use branches in Workflows](https://www.intercom.com/help/en/articles/7846212-how-to-use-branches-in-workflows)
- [Using actions in Workflows](https://www.intercom.com/help/en/articles/7836466-using-actions-in-workflows)
- [Using the Workflows builder](https://www.intercom.com/help/en/articles/6611595-using-the-workflows-builder)
- [Workflow version history and rollback](https://www.intercom.com/changes/en/134017-workflow-version-history-and-rollback)
- [Outbound explained](https://www.intercom.com/help/en/articles/3292835-outbound-explained)
- [Dynamic and Fixed audiences](https://www.intercom.com/help/en/articles/3467924-dynamic-and-fixed-audiences)
- [Message rules](https://www.intercom.com/help/en/articles/5296455-message-rules-when-how-and-to-whom-should-a-message-be-sent)
- [Manage multiple email lists with granular Subscriptions](https://www.intercom.com/help/en/articles/5181083-manage-multiple-email-lists-with-granular-subscriptions)
- [Create a custom report](https://www.intercom.com/help/en/articles/4549035-create-a-custom-report)
- [Custom metrics explained](https://www.intercom.com/help/en/articles/16974777-custom-metrics-explained)
- [Reporting datasets](https://www.intercom.com/help/en/articles/8825260-reporting-datasets)
- [Schedule sharing your reports externally](https://www.intercom.com/help/en/articles/13004328-schedule-sharing-your-reports-externally)
- [Real-time Dashboard](https://www.intercom.com/help/en/articles/5784131-real-time-dashboard)
- [Seats](https://www.intercom.com/help/en/articles/8205716-seats)
- [Teammate permissions](https://www.intercom.com/help/en/articles/176-teammate-permissions-how-to-control-workspace-access)
- [Review actions with Teammate activity logs](https://www.intercom.com/help/en/articles/4667982-review-actions-taken-in-your-workspace-with-teammate-activity-logs)
- [How to see and manage your usage](https://www.intercom.com/help/en/articles/8991894-how-to-see-and-manage-your-usage)
- [Usage-based channels](https://www.intercom.com/help/en/articles/9061703-usage-based-channels)
