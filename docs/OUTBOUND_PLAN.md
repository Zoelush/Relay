# Phase 13: Outbound and proactive messaging (plan)

Brief: `docs/BUILD_PHASES.md` phase 13. It needs phases 01, 03 and 11. Drafted on 15 October 2026. O1 was approved that day ("go ahead with O1 and also look at intercom on the live account"), with the recommendations below. On 15 October the scope was set to the brief's cut, O1 to O3 ("go ahead with O2", after the cut was offered as the default); O4 to O9 wait for customers to ask.

The brief's order is the plan's order: the shared engine first, then message types one at a time. Every message type goes through the same audience, caps, subscriptions, ledger and goals, so the acceptance criteria (opted-out contacts receive nothing; caps hold under a burst) are properties of the engine, not of each type.

## Where Relay is today

**Already there:**
- **Contacts:** visitor, lead and user, with emails and phones, `first_seen_at`, `last_seen_at`, `signed_up_at`, `origin_timezone`, and attributes in `contacts.profile`.
- **A single unsubscribe:** `contacts.global_unsubscribe`.
- **The messenger:** it knows the visitor's page URL and locale (`messenger_sessions`), and has Home, spaces and news-like cards (M1 to M5).
- **Channels (phase 12):** every non-messenger send goes through `channel.deliver` and `mayDeliver`, which has a `TODO(phase 13)` for subscription types.
- **Workflows (phase 11):**
  - conditions evaluated in code, with a live SQL estimate sharing one definition
  - versions, with runs finishing on their own version
  - the `@xyflow/react` canvas
  - `TODO(phase 13)`s for segment entry and exit, "a page visit starts a conversation", and "start a series"
- **Settings, Zoe and email sending,** as the types need them.

**Missing, though phase 13 needs it** (STATUS: phase 01 is partial):
- **Events:** nothing records "the contact did X", and nothing can be asked "in the last N days".
- **Segments:** saved audiences don't exist.
- **Subscription types:** there is one global unsubscribe, with no per-type opt-in or opt-out and no preference page.
- **Companies:** missing. Outbound doesn't strictly need them, so they stay in phase 01.

## Steps

| Step | Scope |
|---|---|
| **O1: Events, subscriptions and segments** | The phase 01 pieces outbound stands on. **Events:** `POST /v1/events` (server-side, signed) and `Relay('track', …)` from the messenger (signed-in users only), with metadata and an index for "in the last N days". **Subscription types:** email, SMS and in-app, each opt-in or opt-out. Each has a per-contact state with its history, and is checked by `mayDeliver` (the phase 12 TODO); a signed preference page is reached from every unsubscribe link. **Segments:** rules over role, attributes, emails, last seen, signed up, events and tags. Contacts are counted live (compiled to SQL), and segments are listed in a People area. |
| **O2: The engine, and in-app chat messages** | Outbound messages as data: a draft and immutable versions, with contacts kept on the version they entered.<br>**Audience:** a segment plus send-time rules (page URL, device, locale, time since signup, event in the last N days, conversation state), with a live size preview.<br>**Delivery modes:** one-off (a fixed audience), ongoing (a dynamic one), event-triggered with a delay, and recurring.<br>**Rules:** re-entry; frequency caps per contact across all outbound and per message; quiet hours in the contact's timezone; subscription enforcement with no bypass.<br>**Measuring:** the per-contact ledger (sent, seen, clicked, dismissed, converted); a goal measured within a window, against a holdout control group.<br>**First type:** the in-app chat message, which arrives in the messenger as a conversation and continues into the inbox on reply.<br>**Acceptance:** the burst of ten, under real concurrency (`test:postgres`). |
| **O3: The Outbound area, and banners** | `#outbound`: the message list with filters and saved views; an editor (content, audience builder with live size, schedule, goal, preview); per-message stats (sent, seen, goal, against control). Then the second type, banners: top or bottom of the host page, dismissible, with an optional action. |
| **O4: Posts and email** | Posts are full announcements in the messenger. Email reuses E3's sending: templates, a plain-text version, the unsubscribe link and the preference page. A lead who clicks through from an email is identified on the site (a signed, short-lived token in the link). Also: audiences from a CSV upload, and broadcasts over WhatsApp (approved templates only), SMS and Discord. |
| **O5: A/B tests and goals' readout** | Variants with a traffic split. The readout states significance honestly: a sample size is fixed up front, and no winner is declared before it's reached. Lift is measured against the holdout. |
| **O6: News items and surveys** | **News:** a news space in the messenger, permanent and browsable, optionally pushed to a segment. **Surveys:** rating, NPS, multiple choice, dropdown and free text, with branching between questions. They're delivered in the messenger, by email, or after a conversation closes (CSAT). Results are kept for phase 14. |
| **O7: Tooltips and checklists** | **Tooltips:** anchored to an element by several selector strategies. If none matches, the tooltip isn't shown and that's reported; it never floats over nothing. **Checklists:** ordered tasks completed by events, with progress kept across sessions. |
| **O8: Product tours** | Multi-step walkthroughs: anchored steps, waiting for the user's action, and branching. A no-code builder runs on the customer's own site (the messenger loader in a signed builder mode). **Acceptance:** a tour whose anchor disappears ends quietly, is reported, and never breaks the host page. |
| **O9: Series** | A campaign graph on the workflow canvas (messages, waits, conditions, splits and exits). Exit criteria remove a contact as soon as the goal is met or they stop matching. A per-contact view shows where they are and why each branch was taken. The workflow TODOs become real: segment entry and exit triggers, "start a series", and a page visit starting a conversation. |

**Not in this phase:**
- **Push notifications and mobile carousels** wait for mobile SDKs, which no phase builds yet (`TODO(phase 15)`).
- **Telegram** isn't a Relay channel.

Each step ships the usual: migration and rollback, seed, unit tests, an end-to-end happy path and failure path, a CHANGELOG entry and a handoff (`docs/OUTBOUND_STEP<n>.md`). The flags are `outbound_v1` for the engine and area, `segments_v1` for O1, and each type's own (`outbound_banner_v1` and so on), all off by default.

## Decisions (proposed)

1. **O1 builds what phase 13 needs from phase 01, and no more.** That means events, subscription types and segments. Companies and custom objects stay in phase 01, and a rule that names them is refused, naming phase 01 (the workflows' rule).
2. **One definition of a rule.** Audience rules are evaluated in code against a contact's facts, so the ledger can say why someone matched. The same definitions compile to SQL for the live size and fixed audiences, as workflows' estimate shares `evaluate`.
3. **Subscription is the gate, with no bypass.** Every message declares a subscription type.
   - **Two checks:** it's checked when a contact is chosen and again in `mayDeliver` right before sending (one gate, as in phase 12).
   - **Scope:** a teammate's reply in a conversation the customer started isn't outbound, and isn't subject to subscriptions. A suppression (bounce, STOP) still applies.
4. **Caps hold by locking the contact.** Choosing to send takes the contact's outbound counter row (`FOR UPDATE`), checks the caps, quiet hours and re-entry, and writes the ledger row, all in one transaction. Ten messages matching at once therefore send at most the cap, proven on real PostgreSQL.
5. **Holdout and variants are assigned deterministically**, by hashing the contact and the message, so a contact never switches groups. The holdout defaults to 10% (0 to 50).
6. **An honest readout:** a two-proportion test at a sample size fixed when the test starts (80% power, 5% significance, for the minimum lift the author sets). Until it's reached, the readout says "not enough data yet", with no early winner.
7. **Versions:** editing a live message makes a new version, now or at a scheduled time. Contacts already in it stay on theirs.
8. **In-app delivery comes from the messenger,** which asks for what's due when it boots and on each page view. Send-time rules (page URL, device) are evaluated then, and caps and quiet hours still go through decision 4. Seen, clicked and dismissed are reported back to the ledger.
9. **On the host page** (banners, tooltips, tours), content is drawn by the loader in a shadow root, with neutral styles and the brand's palette (`palette()`), never the host's CSS. A missing anchor is reported, never thrown.
10. **Large sends are jobs.** A one-off to a big audience is batched (500 contacts a job), and ongoing audiences are checked by the sweep and when a contact changes or an event arrives.

## Needs you

- **Scope.** This is the largest phase, and the brief says to add types "in the order your customers ask for them".
  - **The full plan:** O1 to O9.
  - **The brief's cut list** ("What to cut if you are building alone": "Phase 13 beyond banners and simple in-app messages" is safe to defer): O1 to O3, then stop and move on.
  - **Something in between,** for example O1 to O4 for email campaigns. Say which.
- **Intercom's Outbound:** I can look at the live account's Outbound pages (read-only, as before: nothing changed, sent or published) to match its shapes, as I did for workflows. Say if you want that before O2.
- **Nothing else is needed to build.** Email, SMS and WhatsApp sends use phase 12's stand-ins locally.

11. **O1 decisions** (15 October 2026):
    - **Events need proof of who:** from the messenger, only a signed-in user's. From the server, a JWT signed with the workspace's identity key, for one user and audience `relay-events`; there are no API keys until phase 15.
    - **One meaning for a segment rule,** evaluated in code and compiled to SQL, held together by a corpus test.
    - **Subscriptions are one function** (`effectiveSubscriptions`) used by segments and by `mayDeliver`. A delivery carries its type; a reply in the customer's own conversation carries none.
    - **The preference page** is a signed link and a plain form, with no script.
    - **Merges carry opt-outs, not opt-ins.**
    - **People sees the details `contacts.personal_data` allows** (agents included, as in Intercom). Events and subscription types are for managers.
    - **Seen in Intercom** (read-only, nothing changed): its predefined segments (All users, All leads, Active, New), events with a tracked limit and archiving, and subscription types with consent and channel, which Relay matches. The Outbound list and a banner's summary (versions, rules, frequency and scheduling) are noted in `docs/OUTBOUND_STEP1.md` for O2.

12. **O2 decisions** (16 October 2026):
    - **Scope:** O1 to O3 (the brief's cut), unless asked for more.
    - **In-app messages are delivered when the messenger asks** (`/v1/messenger/due`, after boot and on each page change), at most one chat a page view. The subscription check for in-app is in `admit`, right before delivering; channel messages (from O4) are also checked by `mayDeliver`.
    - **An outbound chat is a conversation created closed,** from its sender, so it's nobody's work until they reply. Its first reply is exempt from "no replies once closed".
    - **The holdout is decided when a person first qualifies:** at a snapshot or event for fixed audiences, at the visit for ongoing ones. It needs a goal, and a re-entry of once or once a period.
    - **Goals are events.** Attribute-change goals wait for attribute history (phase 01).
    - **The lift is said only with 100 people in each group,** with its 95% interval. Full A/B testing (O5) is out of the current scope.

Handoffs: `docs/OUTBOUND_STEP1.md` (O1), `docs/OUTBOUND_STEP2.md` (O2).
