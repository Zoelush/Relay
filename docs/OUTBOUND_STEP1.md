# Phase 13, step O1: Events, subscriptions and segments

Branch `outbound/o1-events-segments`. Plan: `docs/OUTBOUND_PLAN.md`. Behind `segments_v1`, off by default and on for the local relay. Next: O2, the engine and in-app chat messages.

## What it does

The phase 01 pieces outbound stands on: what people do (events), what they agree to get (subscription types), and who's who (segments).

**Events:**
- **From the messenger:** `Relay("track", {name, metadata})`, for signed-in users only. A visitor's claim about themselves proves nothing.
- **From the customer's server:** `POST /v1/events`, with `{events: [{id, name, metadata?, occurredAt?}]}` (100 at most).
  - **Signing:** the request carries `Authorization: Bearer <JWT>`, signed with the workspace's identity key (the one its server already signs messenger users with) for one user.
  - **The JWT's claims:** HS256 with the key's `kid`, issuer `relay-customer:<workspace>`, audience `relay-events`, `sub` the user's id, and an hour at most.
  - **The user** is found, or added, as the messenger would.
  - **Order of checks:** the signature is checked before anything about the workspace is said.
- **Rules for each event:**
  - Kept once by its id (the messenger's idempotency key, or the server's `id`), so a retry counts once.
  - A name is 1 to 100 letters, digits, spaces and `. _ : -`.
  - Up to 10 metadata values (text up to 255 characters, numbers, true or false).
  - It happened within the last 30 days.
- **Settings › Events** (managers):
  - lists each name with its count and when it was last seen
  - describes one, or archives it (no longer kept) or tracks it again
  - 120 can be tracked; a new name past that is refused
- `TODO(phase 15)`: API keys, and events for leads.

**Subscription types** (Settings › Subscriptions, managers):
- **Each type:** a name, a description, its consent (opt-in: sent only once they agree; opt-out: sent until they say no) and its channel (email, SMS, WhatsApp, in-app).
- **Changes:** consent and channel are fixed once made, since people chose on those terms. Archiving a type means nothing of its kind is sent again.
- **What a contact gets** is `effectiveSubscriptions`: the type's default, their own choice, and unsubscribing from everything. It's the one answer for segments and for the gate.
- **The preference page** (`/v1/preferences/<token>`, the link every unsubscribe will open from O4):
  - a plain form, with no script and a strict content security policy
  - each live type switched on or off, and "Unsubscribe from everything"
  - the token is signed, so it reveals and changes only that person's choices; a forged one is "This link isn't valid."
- **Every change is a row** (`contact_subscription_changes`, append-only), saying where it came from.
- **Merges:** when a visitor merges into a user, their opt-outs (and unsubscribing from everything) carry over; opt-ins don't, because they need the user's own consent. A reversed merge leaves them, which errs on the side of not sending.

**The delivery gate** (`mayDeliver`) now also refuses a delivery of a subscription type to a contact who isn't subscribed ("Not subscribed to Product updates."), with no bypass. Outbound sets the type on its deliveries from O2 (`queueDeliveryTo`'s new argument). A reply in a conversation the customer started has no type, so their subscriptions don't affect it; suppressions still do.

**Segments and People** (`#people`, for teammates who may see people's details):
- **The list:** contacts by segment, latest seen first, 50 at a time, with name, type, email, last seen, first seen and signed up.
- **Predefined segments** (code, never edited): All users, All leads, Active (users seen in 30 days) and New (users who signed up in 7 days).
- **Rules:** all or any of up to 20, on:
  - type, name, email, phone, user ID
  - first seen, last seen, signed up (more or less than N days ago)
  - unsubscribed from everything
  - an attribute (is, contains, known, greater or less than)
  - an event (done at least N times, within D days or ever; or not)
  - a subscription (subscribed or not)
- **Rules on later phases' data** (companies, tags on people, custom objects) are refused, naming phase 01.
- **Live count:** changing the rules shows how many match before saving, as a new segment or over a saved one. Saved segments are archived, never deleted.
- **A person** opens beside the list: their details and attributes, subscriptions, and latest 20 events.

## How it works

**Migration `0071_people_data`:**
- `contact_events` and `event_definitions`
- `subscription_types`, `contact_subscriptions` and `contact_subscription_changes` (append-only)
- `segments`
- `channel_deliveries.subscription_type_id`
- row-level security, and the flag
- **The rollback:** the flag goes off (events are refused, and the pages and preference links close). Everything recorded stays, and the gate still checks types.

**One meaning for a rule:**
- `lib/segments.ts` defines the rules, checks them (`segmentProblems`, with reasons) and evaluates them in code (`matches`, against `ContactFacts`).
- `server/segments.ts` compiles the same rules to SQL (`compileSegment`) for counts and lists, and loads the facts (`contactFacts`).
- **The corpus test** checks that both agree, rule by rule and in combinations, on 48 generated contacts.

**Elsewhere:**
- **`server/events.ts`:** `checkEvent`, `recordEvent`, `messengerEvent`, `apiEvents`, and Settings' read and actions.
- **`server/subscriptions.ts`:** `effectiveSubscriptions`, `setSubscription`, Settings' read and actions, `preferenceToken` and `preferencePage`.
- **`server/people.ts`:** `carryOptOuts` on a merge.
- **`server/channels.ts`:** the gate's check.
- **Routes:**
  - `POST /v1/events`
  - `GET` and `POST /v1/preferences/<token>`
  - `POST /v1/messenger/events`
  - `GET` and `POST people`, `events-settings` and `subscription-settings`
- **Messenger loader:** the `track` command.
- **UI:**
  - `agent/people.tsx`, the People area in the strip
  - `agent/settings-outbound.tsx`: Events and Subscriptions, in a new "Outbound" group
- **Local relay:**
  - **The seed:** Ada (a pro user who upgraded), Grace (a free user) and Linus (a lead); "Product updates" (email, opt-out) and "Offers by SMS" (opt-in); and a "Pro users" segment.
  - `POST /dev/event` (`{userId, name, metadata}`) and `GET /dev/preferences/<contact id>`.

## Seen in Intercom (15 October 2026, read-only)

- **Contacts:** predefined segments (All users, All leads, Active, New) with counts. The filter menu covers people data (name, email, seen and signed-up dates, location, browser, UTM, unsubscribed, hard bounced, subscription opt-ins and opt-outs, current page, segment, tag) and company data, plus a CSV audience.
- **Settings › People:** attributes, segments, events (an enabled limit, archived events, recent usage), lead qualification.
- **Settings › Subscriptions:** each type has a name, description, opt-in or opt-out consent, message type (SMS here) and state, with a preview of the unsubscribe page and localisation.
- **Outbound:** a message list with state, sender, type, sent, goal and people type. A message has versions, content, rules (a dynamic audience, people types) and frequency and scheduling (every time they match, start now, never stop, any time). These shape O2.

## Trying it locally

Run `npm run dev:relay`, then open People in the strip (8788 is the API port):

```bash
curl -X POST http://localhost:8788/dev/event -H "content-type: application/json" -d '{"userId":"grace-demo","name":"upgraded plan","metadata":{"plan":"pro"}}'
```

Open a person's preference page from their contact id: `http://localhost:8788/dev/preferences/<contact id>`.

## Checks

- **`tests/segments.test.ts`:**
  - **Rules:** checked with reasons; later phases' data refused by name; the predefined segments valid.
  - **One meaning:** every rule (and 40 random combinations) gives the same people in SQL and in code, on a generated corpus.
  - **Events from the server:** kept once; signed only with this workspace's key for `relay-events`, for an hour at most; refused unsigned or with another key, audience or workspace. Bad names, metadata and times are refused with reasons.
  - **Events from the messenger:** only a signed-in user's, kept once.
  - **Settings › Events:** described, archived (then ignored), restored; the limit of 120.
  - **Subscription types:** checked; consent fixed; archived last; history append-only.
  - **The preference page:** shows live types and their states with no script; records changes only; unsubscribing from everything; forged links and another secret refused.
  - **The gate:** a reply passes; an opted-out, opt-in-by-default, archived or unsubscribed-from-everything contact is refused, also through the delivery job.
  - **A merge** carries opt-outs, not opt-ins.
  - **People:** predefined counts, a draft's list, saving, a taken name, predefined segments unchangeable, archiving, one person.
  - **Another workspace:** its own people and settings; a's person, segment, type and preference link aren't its.
  - **The rollback.**
- **`tests/browser/people.spec.ts`** (ports 9054 and 9055):
  - **Happy path:** an event rule narrows the list live and is saved as a segment. A person shows their subscriptions and events. Their preference page stops product updates, and People shows it. Settings lists events and who chose what.
  - **Failure path:** a forged preference link, a rule without its attribute, a taken segment name, an unsigned event and a taken subscription name, each refused with its reason.

## Not included

- **Teammates recording a person's consent** (the gap audit's "collecting subscription consent in a conversation"). That comes with outbound's types (O4).
- **The one-click unsubscribe header** for email (RFC 8058): O4, with outbound email.
- **CSV audiences:** O4.
- **Segment entry and exit triggers for workflows:** O9.
- **Localised preference pages.**
- **Companies, tags on people and custom objects:** phase 01.
