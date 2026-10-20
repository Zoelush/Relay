# Relay API reference

Generated from `lib/api-spec.ts` by `npm run api:doc`; don't edit by hand. The machine-readable spec is at `/rest/openapi.json`, and this page at `/developers`.

Relay's REST API: conversations, contacts, tickets, articles and knowledge, macros, workflows, outbound, events, attributes, segments, search, export and webhooks. Authenticate with a personal access token (Settings › Developers) as `Authorization: Bearer <token>`. Name a version with `Relay-Version`; without one, the token's own version is used.

Base URL: `https://api.<your domain>/rest` (locally, the API server's `/rest`).

## Authentication

Make a personal access token in **Settings › Developers**. Send it on every request as `Authorization: Bearer <token>`.

A token acts as the teammate who made it, within the scopes they chose. A scope is one of their role's capabilities, so a token never has more than its maker, and if their role loses a capability, so does the token.

Tokens are shown once and kept only as hashes. Revoke one in Settings; it stops working at once.

## Versions

Name a version with the `Relay-Version` header (`2026-10-20`). Without one, the token's own version is used (chosen when it was made). Every response says which version answered.

Supported: `2026-10-20`.

**Deprecation policy:** a new version is announced in the changelog with what changed. The one before stays supported for at least 12 months after that, so at least two versions are supported once there's a second. A version is retired only after a warning on every token still using it.

## Errors

An error is `{"type":"error","request_id":"…","errors":[{"code":"…","message":"…","field":"…"}]}`. `code` is stable and meant for your code (`invalid_field`, `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `invalid_version`…). `message` is for a person. `field` names what's wrong, when something is.

An unexpected failure is `internal_error`, with no detail: quote its `request_id`.

## Pagination

Lists are `{"type":"list","data":[…],"pages":{"next":"…"}}`. Pass `pages.next` as `starting_after` for the next page; it's `null` on the last. `per_page` is 1 to 100 (20 by default). There's no offset paging.

## Rate limits

Each token may make bursts of up to 100 requests, refilling at 10 a second (600 a minute). Each workspace may make up to 1,500 a minute across all its tokens.

Every response carries `X-RateLimit-Limit` (a minute's allowance), `X-RateLimit-Remaining` and `X-RateLimit-Reset` (seconds until the burst is full again). Over the limit, you get `429` with `Retry-After` (seconds).

Each token's calls and refusals over the last hour are on the Developers page.

## Searching

`POST /conversations/search` and `POST /contacts/search` take `{"query":…, "sort":{"field","order"}, "per_page", "starting_after"}`. A query is a condition, `{"field":"status","operator":"=","value":"open"}`, or a group, `{"operator":"AND","value":[…]}` (`AND` or `OR`), nested up to 3 groups deep with up to 20 conditions.

Example: open conversations on email or SMS, waiting since before 9 this morning: `{"query":{"operator":"AND","value":[{"field":"status","operator":"=","value":"open"},{"field":"channel","operator":"IN","value":["email","sms"]},{"field":"waiting_since","operator":"<","value":"2026-10-20T09:00:00Z"}]}}`.

Each field's type decides its operators. **string:** `=` `!=` `IN` `NIN` `~` `!~` `^` `$`; **enum:** `=` `!=` `IN` `NIN`; **number:** `=` `!=` `<` `>` `<=` `>=`; **time:** `=` `!=` `<` `>` `<=` `>=`; **boolean:** `=` `!=`.

Operators: `=` equals; `!=` doesn't equal; `IN` is one of (a list); `NIN` is none of (a list); `~` contains; `!~` doesn't contain; `^` starts with; `$` ends with; `<` is before / less than; `>` is after / more than; `<=` at or before / at most; `>=` at or after / at least. Text comparisons ignore case; times need an offset.

A refused query names the part at fault, as `query.value[1].operator`.

## Webhooks

Subscribe a public https address to topics (Settings › Developers › Webhooks, or `POST /webhooks`). Each event is POSTed as JSON: `{"type":"webhook_event","id","topic","created_at","workspace_id","data":{"item":…}}`, where `item` is the resource as this API shows it (a conversation, ticket, contact, event or article), with `data.part`, `data.tag`, `data.changes` or `data.metric` when the topic has one. Internal notes are never sent.

Headers: `Relay-Signature`, `Relay-Event-Id` (the same across retries and replays: dedupe on it), `Relay-Webhook-Id` (this delivery) and `Relay-Topic`. Events are sent in the order they happened, but a retry can arrive after a later event: order by `created_at` if it matters.

**Delivery** is at least once. Answer with a 2xx within 10 seconds. Anything else is retried with exponential backoff (a minute, doubling, at most two hours apart) for 24 hours. A webhook that has failed for 24 hours without a success is turned off, and its creator is told (by email too, if it names an alert email). Its deliveries are kept 30 days and any one can be replayed.

**Verifying:** `Relay-Signature` is `t=<unix seconds>,v1=<hex>`. The hex is HMAC-SHA256 of `<t>.<the raw body>` under your secret. While a secret is being rotated, a second `v1` signs under the previous one for 24 hours. Accept the delivery if any `v1` matches and `t` is within 5 minutes. The SDKs do this: `verifyWebhook(secret, rawBody, header)` in JavaScript, `verify_webhook(secret, raw_body, header)` in Python.

```js
import { createHmac, timingSafeEqual } from "node:crypto";
export function verify(secret, rawBody, header, now = Date.now() / 1000) {
  const items = header.split(",").map((p) => p.split("="));
  const t = Number(items.find(([k]) => k === "t")?.[1]);
  if (!t || Math.abs(now - t) > 300) return false;
  const want = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return items.some(([k, v]) => { if (k !== "v1") return false; const got = Buffer.from(v, "hex"); return got.length === want.length && timingSafeEqual(got, want); });
}
```

```python
import hashlib, hmac, time
def verify(secret, raw_body, header, tolerance=300):
    items = [p.split("=", 1) for p in header.split(",")]
    t = next((int(v) for k, v in items if k == "t"), 0)
    if not t or abs(time.time() - t) > tolerance:
        return False
    want = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(v, want) for k, v in items if k == "v1")
```

## Retries

Send `Idempotency-Key` (up to 200 letters, digits and `_.:-`) on a `POST` to make it safe to retry. The same key from the same token does the work once and returns the same result.

## Tokens

### Who the token is

`GET /me`

The workspace, the teammate the token acts as, its scopes and its version.

**Scope:** none (any token).

**Returns:** `200`, Me.

## Conversations

### List conversations

`GET /conversations`

Customer-facing conversations, most recently updated first.

**Scope:** `conversations.read`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `status` | query | string: `open`, `snoozed`, `closed` | no | Only conversations in this state. |
| `assignee_id` | query | string | no | Only those assigned to this teammate (`none` for unassigned). up to 100 characters |
| `team_id` | query | string | no | Only those with this team. up to 100 characters |
| `per_page` | query | integer | no | How many to return, 1 to 100. 1 to 100; default 20 |
| `starting_after` | query | string | no | The cursor from the previous page's `pages.next`. up to 400 characters |

**Returns:** `200`, object.

### Start a conversation for a contact

`POST /conversations`

A new conversation, started by the contact with their message (as if they'd written in). Send `Idempotency-Key` to make retries safe.

**Scope:** `conversations.reply`.

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `contact_id` | string | yes | The contact's id. up to 100 characters |
| `body` | string | yes | The contact's first message, as plain text. up to 10000 characters |

**Returns:** `201`, Conversation.

### Retrieve a conversation

`GET /conversations/{id}`

One conversation. Its messages and notes are its parts.

**Scope:** `conversations.read`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The conversation's id. up to 100 characters |

**Returns:** `200`, Conversation.

### List a conversation's parts

`GET /conversations/{id}/parts`

Its messages, replies, notes and events, oldest first. Internal notes are marked `internal`; they're never shown to the customer.

**Scope:** `conversations.read`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The conversation's id. up to 100 characters |
| `per_page` | query | integer | no | How many to return, 1 to 100. 1 to 100; default 20 |
| `starting_after` | query | string | no | The cursor from the previous page's `pages.next`. up to 400 characters |

**Returns:** `200`, object.

### Reply

`POST /conversations/{id}/reply`

A reply to the customer, as the token's teammate. Send `Idempotency-Key` to make retries safe.

**Scope:** `conversations.reply`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The conversation's id. up to 100 characters |

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `body` | string | yes | The reply, as plain text. up to 10000 characters |

**Returns:** `200`, Conversation.

### Add an internal note

`POST /conversations/{id}/notes`

A note only teammates see.

**Scope:** `conversations.note`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The conversation's id. up to 100 characters |

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `body` | string | yes | The note, as plain text. up to 10000 characters |

**Returns:** `200`, Conversation.

### Assign

`POST /conversations/{id}/assign`

Assign to a teammate and/or a team; `null` clears either.

**Scope:** `conversations.assign`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The conversation's id. up to 100 characters |

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `assignee_id` | string or null | no | The teammate's id. up to 100 characters |
| `team_id` | string or null | no | The team's id. up to 100 characters |

**Returns:** `200`, Conversation.

### Snooze

`POST /conversations/{id}/snooze`

Snooze until a time (with its offset).

**Scope:** `conversations.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The conversation's id. up to 100 characters |

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `until` | string (date-time) | yes | When it wakes, with an offset (2026-10-21T09:00:00+01:00). |

**Returns:** `200`, Conversation.

### Close

`POST /conversations/{id}/close`

Close the conversation.

**Scope:** `conversations.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The conversation's id. up to 100 characters |

**Returns:** `200`, Conversation.

### Reopen

`POST /conversations/{id}/open`

Reopen a closed or snoozed conversation.

**Scope:** `conversations.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The conversation's id. up to 100 characters |

**Returns:** `200`, Conversation.

### Tag

`POST /conversations/{id}/tags`

Add a tag to the conversation.

**Scope:** `conversations.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The conversation's id. up to 100 characters |

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `tag_id` | string | yes | The tag's id. up to 100 characters |

**Returns:** `200`, Conversation.

### Remove a tag

`DELETE /conversations/{id}/tags/{tag_id}`

Remove a tag from the conversation.

**Scope:** `conversations.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The conversation's id. up to 100 characters |
| `tag_id` | path | string | yes | The tag's id. up to 100 characters |

**Returns:** `200`, Conversation.

## Contacts

### List contacts

`GET /contacts`

Contacts (not merged away), by id.

**Scope:** `contacts.personal_data`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `email` | query | string (email) | no | Only the contact with this email. up to 320 characters |
| `external_id` | query | string | no | Only the contact with your id for them. up to 200 characters |
| `per_page` | query | integer | no | How many to return, 1 to 100. 1 to 100; default 20 |
| `starting_after` | query | string | no | The cursor from the previous page's `pages.next`. up to 400 characters |

**Returns:** `200`, object.

### Create a contact

`POST /contacts`

A user (with your `external_id` for them) or a lead (with an email). Creating one that exists (the same `external_id`) returns it, so retries are safe.

**Scope:** `contacts.personal_data`.

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `external_id` | string | no | Your id for them: makes them a user. up to 200 characters |
| `email` | string (email) | no | up to 320 characters |
| `name` | string | no | up to 200 characters |
| `custom_attributes` | CustomAttributes | no | Your own facts about them: up to 50, each a string (up to 255), a number, a boolean or null. |

**Returns:** `201`, Contact.

### Retrieve a contact

`GET /contacts/{id}`

One contact. A merged contact's id leads to the contact it joined.

**Scope:** `contacts.personal_data`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The contact's id. up to 100 characters |

**Returns:** `200`, Contact.

### Update a contact

`PATCH /contacts/{id}`

Change the name, or set custom attributes (`null` removes one). Others are left as they are.

**Scope:** `contacts.personal_data`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The contact's id. up to 100 characters |

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `name` | string | no | up to 200 characters |
| `custom_attributes` | CustomAttributes | no | Your own facts about them: up to 50, each a string (up to 255), a number, a boolean or null. |

**Returns:** `200`, Contact.

## Tags

### List tags

`GET /tags`

The workspace's tags (archived ones are left out).

**Scope:** `conversations.read`.

**Returns:** `200`, object.

### Create a tag

`POST /tags`

A new tag. A name that's taken returns the existing tag.

**Scope:** `workspace.manage`.

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `name` | string | yes | The tag's name. up to 60 characters |

**Returns:** `201`, Tag.

## Teammates and teams

### List teammates

`GET /teammates`

Everyone in the workspace.

**Scope:** `conversations.read`.

**Returns:** `200`, object.

### Retrieve a teammate

`GET /teammates/{id}`

One teammate.

**Scope:** `conversations.read`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The teammate's id. up to 100 characters |

**Returns:** `200`, Teammate.

### List teams

`GET /teams`

The workspace's teams and their members.

**Scope:** `conversations.read`.

**Returns:** `200`, object.

### Retrieve a team

`GET /teams/{id}`

One team and its members.

**Scope:** `conversations.read`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The team's id. up to 100 characters |

**Returns:** `200`, Team.

## Search

### Search conversations

`POST /conversations/search`

Conversations matching a query, sorted and cursor-paged. Fields: id, status, channel, brand_id, assignee_id, team_id, contact_id, tag_id, priority, created_at, updated_at, waiting_since.

**Scope:** `conversations.read`.

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `query` | object | yes | A condition `{"field","operator","value"}` or a group `{"operator":"AND"|"OR","value":[…]}`. See Search for the conversation fields and operators. |
| `sort` | object | no |  |
| `per_page` | integer | no | 1 to 100; default 20 |
| `starting_after` | string | no | up to 400 characters |

**Returns:** `200`, object.

### Search contacts

`POST /contacts/search`

Contacts matching a query, sorted and cursor-paged. Fields: id, role, name, email, external_id, first_seen_at, last_seen_at, signed_up_at, and custom_attributes.<name>.

**Scope:** `contacts.personal_data`.

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `query` | object | yes | A condition `{"field","operator","value"}` or a group `{"operator":"AND"|"OR","value":[…]}`. See Search for the contact fields and operators. |
| `sort` | object | no |  |
| `per_page` | integer | no | 1 to 100; default 20 |
| `starting_after` | string | no | up to 400 characters |

**Returns:** `200`, object.

## Events

### List a contact's events

`GET /contacts/{id}/events`

What they did, newest first (from your server, or the messenger while they're signed in).

**Scope:** `contacts.personal_data`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The contact's id. up to 100 characters |
| `per_page` | query | integer | no | How many to return, 1 to 100. 1 to 100; default 20 |
| `starting_after` | query | string | no | The cursor from the previous page's `pages.next`. up to 400 characters |

**Returns:** `200`, object.

### Record an event

`POST /contacts/{id}/events`

Something the contact did. `id` is yours: an event with an id that's been seen is ignored, so retries are safe.

**Scope:** `contacts.personal_data`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The contact's id. up to 100 characters |

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `id` | string | yes | Your id for this event (dedupes). up to 200 characters |
| `name` | string | yes | What happened (`upgraded plan`). up to 100 characters |
| `metadata` | object | no | Up to 10 facts about it. |
| `occurred_at` | string (date-time) | no | When it happened (now if left out). |

**Returns:** `201`, Event.

## Tickets

### List tickets

`GET /tickets`

Tickets, newest first, by type or state.

**Scope:** `conversations.read`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `ticket_type_id` | query | string | no | Only this type. up to 100 characters |
| `state` | query | string: `submitted`, `in_progress`, `waiting_on_customer`, `resolved` | no | Only tickets in a state of this kind. |
| `per_page` | query | integer | no | How many to return, 1 to 100. 1 to 100; default 20 |
| `starting_after` | query | string | no | The cursor from the previous page's `pages.next`. up to 400 characters |

**Returns:** `200`, object.

### Make a conversation a ticket

`POST /tickets`

Turn a conversation into a ticket of a type (in its first state, or the one given).

**Scope:** `conversations.manage`.

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `conversation_id` | string | yes | The conversation's id. up to 100 characters |
| `ticket_type_id` | string | yes | The ticket type's id. up to 100 characters |
| `state_id` | string | no | The ticket state's id. up to 100 characters |

**Returns:** `201`, Ticket.

### Retrieve a ticket

`GET /tickets/{id}`

One ticket (its id is its conversation's).

**Scope:** `conversations.read`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The ticket's id. up to 100 characters |

**Returns:** `200`, Ticket.

### Change a ticket's state

`POST /tickets/{id}/state`

Move a ticket to another of its type's states.

**Scope:** `conversations.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The ticket's id. up to 100 characters |

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `state_id` | string | yes | The ticket state's id. up to 100 characters |

**Returns:** `200`, Ticket.

### List ticket types

`GET /ticket_types`

The workspace's ticket types and their states (archived ones left out).

**Scope:** `conversations.read`.

**Returns:** `200`, object.

### Retrieve a ticket type

`GET /ticket_types/{id}`

One ticket type and its states.

**Scope:** `conversations.read`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The ticket type's id. up to 100 characters |

**Returns:** `200`, TicketType.

## Help centers and articles

### List help centers

`GET /help_centers`

Each brand's help center and its collections.

**Scope:** `knowledge.manage`.

**Returns:** `200`, object.

### Retrieve a help center

`GET /help_centers/{id}`

One help center and its collections.

**Scope:** `knowledge.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The help center's id. up to 100 characters |

**Returns:** `200`, HelpCenter.

### List articles

`GET /articles`

Articles, most recently updated first.

**Scope:** `conversations.read`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `state` | query | string: `published`, `draft` | no | Only published ones, or drafts never published. |
| `per_page` | query | integer | no | How many to return, 1 to 100. 1 to 100; default 20 |
| `starting_after` | query | string | no | The cursor from the previous page's `pages.next`. up to 400 characters |

**Returns:** `200`, object.

### Create an article

`POST /articles`

A new article, as a draft. Paragraphs are separated by a blank line. Publish it to put it live.

**Scope:** `knowledge.manage`.

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `title` | string | yes | Its title. up to 200 characters |
| `body` | string | no | Its text; a blank line starts a paragraph. up to 100000 characters |
| `locale` | string | no | at least 2 characters; up to 35 characters; default en |

**Returns:** `201`, Article.

### Retrieve an article

`GET /articles/{id}`

One article: its draft and, if published, what's live.

**Scope:** `conversations.read`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The article's id. up to 100 characters |

**Returns:** `200`, Article.

### Update an article's draft

`PATCH /articles/{id}`

Change the draft's title or text. What's live doesn't change until it's published again.

**Scope:** `knowledge.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The article's id. up to 100 characters |

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `title` | string | no | Its title. up to 200 characters |
| `body` | string | no | up to 100000 characters |

**Returns:** `200`, Article.

### Publish an article

`POST /articles/{id}/publish`

Put the draft live (wherever it's placed: help centers, Zoe, the inbox).

**Scope:** `knowledge.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The article's id. up to 100 characters |

**Returns:** `200`, Article.

## Knowledge

### List knowledge

`GET /knowledge_records`

Everything Zoe and the inbox may draw on: articles, internal articles, snippets, files and synced pages.

**Scope:** `conversations.read`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `source` | query | string: `article`, `internal_article`, `snippet`, `file`, `external_page` | no | Only this kind. |
| `per_page` | query | integer | no | How many to return, 1 to 100. 1 to 100; default 20 |
| `starting_after` | query | string | no | The cursor from the previous page's `pages.next`. up to 400 characters |

**Returns:** `200`, object.

### Retrieve knowledge

`GET /knowledge_records/{id}`

One knowledge record.

**Scope:** `conversations.read`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The knowledge record's id. up to 100 characters |

**Returns:** `200`, KnowledgeRecord.

## Macros

### List macros

`GET /macros`

Shared macros, and the token's teammate's own.

**Scope:** `macros.use`.

**Returns:** `200`, object.

### Retrieve a macro

`GET /macros/{id}`

One macro: its text and its actions.

**Scope:** `macros.use`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The macro's id. up to 100 characters |

**Returns:** `200`, Macro.

### Apply a macro

`POST /conversations/{id}/macros`

Apply a macro to a conversation: its reply or note, and its actions. Send `Idempotency-Key` to make retries safe.

**Scope:** `macros.use`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The conversation's id. up to 100 characters |

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `macro_id` | string | yes | The macro's id. up to 100 characters |

**Returns:** `200`, Conversation.

## Workflows

### List workflows

`GET /workflows`

The workspace's workflows (archived ones left out).

**Scope:** `workspace.manage`.

**Returns:** `200`, object.

### Retrieve a workflow

`GET /workflows/{id}`

One workflow.

**Scope:** `workspace.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The workflow's id. up to 100 characters |

**Returns:** `200`, Workflow.

### List a workflow's runs

`GET /workflows/{id}/runs`

Its runs, newest first.

**Scope:** `workspace.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The workflow's id. up to 100 characters |
| `per_page` | query | integer | no | How many to return, 1 to 100. 1 to 100; default 20 |
| `starting_after` | query | string | no | The cursor from the previous page's `pages.next`. up to 400 characters |

**Returns:** `200`, object.

### Run a workflow

`POST /workflows/{id}/trigger`

Run a live, manually triggered workflow on a conversation. It runs in the background.

**Scope:** `conversations.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The workflow's id. up to 100 characters |

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `conversation_id` | string | yes | The conversation's id. up to 100 characters |

**Returns:** `202`, WorkflowRunQueued.

## Outbound

### List outbound messages

`GET /outbound_messages`

Chats and banners, with what they reached.

**Scope:** `workspace.manage`.

**Returns:** `200`, object.

### Retrieve an outbound message

`GET /outbound_messages/{id}`

One outbound message and its numbers.

**Scope:** `workspace.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The outbound message's id. up to 100 characters |

**Returns:** `200`, OutboundMessage.

## Data attributes

### List data attributes

`GET /data_attributes`

The workspace's attributes for conversations and contacts.

**Scope:** `conversations.read`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `model` | query | string: `conversation`, `contact` | no | Only conversation or contact attributes. |

**Returns:** `200`, object.

### Create a conversation attribute

`POST /data_attributes`

A new attribute teammates fill in on conversations.

**Scope:** `workspace.manage`.

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `name` | string | yes | Its name. up to 60 characters |
| `value_type` | string: `string`, `integer`, `float`, `boolean`, `date`, `options` | yes |  |
| `options` | array of string | no |  |

**Returns:** `201`, DataAttribute.

## Segments

### List segments

`GET /segments`

Saved and built-in segments of contacts.

**Scope:** `contacts.personal_data`.

**Returns:** `200`, object.

### List a segment's contacts

`GET /segments/{id}/contacts`

Who's in a segment now.

**Scope:** `contacts.personal_data`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The segment's id. up to 100 characters |
| `per_page` | query | integer | no | How many to return, 1 to 100. 1 to 100; default 20 |
| `starting_after` | query | string | no | The cursor from the previous page's `pages.next`. up to 400 characters |

**Returns:** `200`, object.

## Data export

### Export data

`POST /exports`

Start an export of conversations, contacts and/or tickets (as newline-delimited JSON). It runs in the background; fetch it to see when it's ready.

**Scope:** `data.export`.

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `resources` | array of string: `conversations`, `contacts`, `tickets` | yes |  |
| `created_after` | string (date-time) | no | Only what was created at or after this. |
| `created_before` | string (date-time) | no | Only what was created before this. |

**Returns:** `202`, Export.

### Retrieve an export

`GET /exports/{id}`

Its progress, and when it's done, links to its files (each valid for an hour).

**Scope:** `data.export`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The export's id. up to 100 characters |

**Returns:** `200`, Export.

## Webhooks

### List webhooks

`GET /webhooks`

The workspace's webhook subscriptions.

**Scope:** `workspace.manage`.

**Returns:** `200`, object.

### Create a webhook

`POST /webhooks`

Subscribe a public https address to topics. The response carries its signing `secret`, this once.

**Scope:** `workspace.manage`.

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `url` | string | yes | Where deliveries are POSTed (https). at least 8 characters; up to 2000 characters |
| `topics` | array of string: `conversation.created`, `conversation.customer_replied`, `conversation.teammate_replied`, `conversation.assigned`, `conversation.closed`, `conversation.rated`, `conversation.tagged`, `ticket.created`, `ticket.state_changed`, `contact.created`, `contact.updated`, `contact.merged`, `event.received`, `ai_agent.resolved`, `ai_agent.escalated`, `sla.breached`, `article.published` | yes |  |
| `alert_email` | string or null (email) | no | Told if it's turned off after failing for 24 hours. up to 320 characters |

**Returns:** `201`, Webhook.

### Retrieve a webhook

`GET /webhooks/{id}`

One webhook subscription and its state.

**Scope:** `workspace.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The webhook's id. up to 100 characters |

**Returns:** `200`, Webhook.

### Update a webhook

`PATCH /webhooks/{id}`

Change its address, topics or alert email, or turn it off or back on (back on forgives its failures).

**Scope:** `workspace.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The webhook's id. up to 100 characters |

**Body:**

| Field | Type | Required | About |
|---|---|---|---|
| `url` | string | no | at least 8 characters; up to 2000 characters |
| `topics` | array of string: `conversation.created`, `conversation.customer_replied`, `conversation.teammate_replied`, `conversation.assigned`, `conversation.closed`, `conversation.rated`, `conversation.tagged`, `ticket.created`, `ticket.state_changed`, `contact.created`, `contact.updated`, `contact.merged`, `event.received`, `ai_agent.resolved`, `ai_agent.escalated`, `sla.breached`, `article.published` | no |  |
| `alert_email` | string or null (email) | no | up to 320 characters |
| `active` | boolean | no |  |

**Returns:** `200`, Webhook.

### Delete a webhook

`DELETE /webhooks/{id}`

Stop sending to it; deliveries still waiting are abandoned.

**Scope:** `workspace.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The webhook's id. up to 100 characters |

**Returns:** `200`, object.

### Rotate a webhook's secret

`POST /webhooks/{id}/rotate_secret`

A new signing secret (returned this once). For 24 hours, deliveries are signed with both, so you can switch without missing any.

**Scope:** `workspace.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The webhook's id. up to 100 characters |

**Returns:** `200`, Webhook.

### Send a test delivery

`POST /webhooks/{id}/test`

A `ping` delivery, to check the address and your signature check.

**Scope:** `workspace.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The webhook's id. up to 100 characters |

**Returns:** `202`, WebhookDelivery.

### List deliveries

`GET /webhooks/{id}/deliveries`

What was sent to it, newest first (kept 30 days).

**Scope:** `workspace.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The webhook's id. up to 100 characters |
| `per_page` | query | integer | no | How many to return, 1 to 100. 1 to 100; default 20 |
| `starting_after` | query | string | no | The cursor from the previous page's `pages.next`. up to 400 characters |

**Returns:** `200`, object.

### Retrieve a delivery

`GET /webhooks/{id}/deliveries/{delivery_id}`

One delivery: its body, and every attempt with what came back.

**Scope:** `workspace.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The webhook's id. up to 100 characters |
| `delivery_id` | path | string | yes | The delivery's id. up to 100 characters |

**Returns:** `200`, WebhookDelivery.

### Replay a delivery

`POST /webhooks/{id}/deliveries/{delivery_id}/replay`

Send the same event and body again, as a new delivery.

**Scope:** `workspace.manage`.

| Parameter | In | Type | Required | About |
|---|---|---|---|---|
| `id` | path | string | yes | The webhook's id. up to 100 characters |
| `delivery_id` | path | string | yes | The delivery's id. up to 100 characters |

**Returns:** `202`, WebhookDelivery.

## Search fields

### Conversations

| Field | Type | Sortable | About |
|---|---|---|---|
| `id` | string | no | Its id. |
| `status` | enum: `open`, `snoozed`, `closed` | no | open, snoozed or closed. |
| `channel` | string | no | messenger, email, whatsapp, sms, … |
| `brand_id` | string | no | Its brand. |
| `assignee_id` | string | no | The teammate it's assigned to. |
| `team_id` | string | no | Its team. |
| `contact_id` | string | no | The contact who wrote in. |
| `tag_id` | string | no | A tag on it (= has it, != doesn't). |
| `priority` | boolean | no | Marked as a priority. |
| `created_at` | time | yes | When it started. |
| `updated_at` | time | yes | When it last changed. |
| `waiting_since` | time | no | When the customer's unanswered message came in. |

Sorted by `updated_at`, newest first, unless you choose.

### Contacts

| Field | Type | Sortable | About |
|---|---|---|---|
| `id` | string | no | Its id. |
| `role` | enum: `visitor`, `lead`, `user` | no | visitor, lead or user. |
| `name` | string | yes | Their name. |
| `email` | string | no | One of their email addresses. |
| `external_id` | string | no | Your id for them. |
| `first_seen_at` | time | yes | When they were first seen. |
| `last_seen_at` | time | yes | When they were last seen. |
| `signed_up_at` | time | yes | When they signed up. |

Also `custom_attributes.<name>` (text, or a number when the value is one). Sorted by `last_seen_at`, newest first, unless you choose.

## Webhook topics

| Topic | When | `data.item` |
|---|---|---|
| `conversation.created` | A customer (or an API call for them) started a conversation. | conversation |
| `conversation.customer_replied` | A customer's message, with `data.part`. | conversation |
| `conversation.teammate_replied` | A public reply by a teammate, with `data.part` (internal notes never). | conversation |
| `conversation.assigned` | Its teammate or team changed, with `data.part`. | conversation |
| `conversation.closed` | It was closed. | conversation |
| `conversation.rated` | The customer rated it, with `data.part`. | conversation |
| `conversation.tagged` | A tag was added, with `data.tag`. | conversation |
| `ticket.created` | A conversation became a ticket. | ticket |
| `ticket.state_changed` | With `data.changes` (from and to state ids). | ticket |
| `contact.created` | A new visitor, lead or user. | contact |
| `contact.updated` | Their name, role, your id for them, or custom attributes. | contact |
| `contact.merged` | The contact that remains, with `data.merged_contact_id`. | contact |
| `event.received` | From your server or the messenger. | event |
| `ai_agent.resolved` | A confirmed or assumed resolution. | conversation |
| `ai_agent.escalated` | Zoe passed the conversation to the team, with `data.part`. | conversation |
| `sla.breached` | With `data.metric` (first response, next response, time to close or resolve). | conversation |
| `article.published` | A new or updated article went live. | article |

Company topics and `contact.tagged` come with companies and tags on people (phase 01).

## Objects

### Pages

| Field | Type | Always present | About |
|---|---|---|---|
| `next` | string or null | yes | Pass as `starting_after` for the next page; null on the last. |

### Error

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `error` | yes |  |
| `request_id` | string | yes | Quote it if you contact us. |
| `errors` | array of object | yes |  |

### CustomAttributes

Your own facts about them: up to 50, each a string (up to 255), a number, a boolean or null.

### Me

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `token` | yes |  |
| `workspace_id` | string | yes |  |
| `teammate` | Teammate | yes |  |
| `scopes` | array of string | yes |  |
| `version` | string | yes |  |

### Conversation

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `conversation` | yes |  |
| `id` | string | yes |  |
| `title` | string | no |  |
| `status` | string: `open`, `snoozed`, `closed` | yes |  |
| `channel` | string | yes | messenger, email, whatsapp, sms, … |
| `brand_id` | string or null | no |  |
| `contact_id` | string or null | no |  |
| `assignee_id` | string or null | no |  |
| `team_id` | string or null | no |  |
| `priority` | boolean | no |  |
| `tags` | array of Tag | no |  |
| `snoozed_until` | string or null (date-time) | no |  |
| `waiting_since` | string or null (date-time) | no | When the customer's unanswered message came in; null when they aren't waiting. |
| `created_at` | string (date-time) | yes |  |
| `updated_at` | string (date-time) | yes |  |

### Part

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `conversation_part` | yes |  |
| `id` | string | yes |  |
| `seq` | integer | yes |  |
| `kind` | string | yes | customer_message, teammate_reply, internal_note, ai_reply, state_change, assignment_change, … |
| `audience` | string: `public`, `internal` | yes |  |
| `author` | object | no |  |
| `body` | string | no |  |
| `created_at` | string (date-time) | yes |  |

### Contact

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `contact` | yes |  |
| `id` | string | yes |  |
| `role` | string: `visitor`, `lead`, `user` | yes |  |
| `name` | string | no |  |
| `email` | string or null | no |  |
| `external_id` | string or null | no |  |
| `custom_attributes` | CustomAttributes | no | Your own facts about them: up to 50, each a string (up to 255), a number, a boolean or null. |
| `first_seen_at` | string (date-time) | no |  |
| `last_seen_at` | string (date-time) | no |  |
| `signed_up_at` | string or null (date-time) | no |  |

### Tag

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `tag` | yes |  |
| `id` | string | yes |  |
| `name` | string | yes |  |

### Teammate

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `teammate` | yes |  |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `presence` | string: `active`, `away`, `away_reassigning` | no |  |

### Team

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `team` | yes |  |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `member_ids` | array of string | yes |  |

### Event

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `event` | yes |  |
| `id` | string | yes |  |
| `contact_id` | string | no |  |
| `name` | string | yes |  |
| `metadata` | object | no |  |
| `source` | string: `api`, `messenger` | no |  |
| `occurred_at` | string (date-time) | yes |  |

### Ticket

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `ticket` | yes |  |
| `id` | string | yes |  |
| `number` | integer | yes | Its number in this workspace (#123). |
| `title` | string | no |  |
| `ticket_type_id` | string | yes |  |
| `state` | object | yes |  |
| `conversation_id` | string | no |  |
| `created_at` | string (date-time) | no |  |
| `updated_at` | string (date-time) | no |  |

### TicketType

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `ticket_type` | yes |  |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `category` | string: `customer`, `back_office`, `tracker` | yes |  |
| `description` | string | no |  |
| `states` | array of object | yes |  |

### HelpCenter

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `help_center` | yes |  |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `brand_id` | string | no |  |
| `slug` | string | no |  |
| `access` | string: `public`, `signed_in` | no |  |
| `default_locale` | string | no |  |
| `locales` | array of string | no |  |
| `collections` | array of object | yes |  |

### Article

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `article` | yes |  |
| `id` | string | yes |  |
| `title` | string | yes | The draft's title. |
| `body` | string | no | The draft's text. |
| `state` | string: `draft`, `published` | yes |  |
| `published_title` | string or null | no |  |
| `published_body` | string or null | no |  |
| `locale` | string | no |  |
| `audience` | string: `public`, `signed_in`, `internal` | no |  |
| `updated_at` | string (date-time) | no |  |
| `published_at` | string or null (date-time) | no |  |

### KnowledgeRecord

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `knowledge_record` | yes |  |
| `id` | string | yes |  |
| `source` | string: `article`, `internal_article`, `snippet`, `file`, `external_page` | yes |  |
| `title` | string | yes |  |
| `audience` | string | no |  |
| `for_ai` | boolean | no |  |
| `for_help_center` | boolean | no |  |
| `for_inbox` | boolean | no |  |
| `published` | boolean | no |  |
| `updated_at` | string (date-time) | no |  |

### Macro

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `macro` | yes |  |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `mode` | string: `reply`, `note` | yes |  |
| `shared` | boolean | no |  |
| `body` | string | no |  |
| `actions` | array of object | no |  |

### Workflow

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `workflow` | yes |  |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `trigger` | string | yes |  |
| `state` | string: `draft`, `live`, `paused` | yes |  |
| `updated_at` | string (date-time) | no |  |

### WorkflowRun

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `workflow_run` | yes |  |
| `id` | string | yes |  |
| `workflow_id` | string | no |  |
| `conversation_id` | string or null | no |  |
| `status` | string | yes |  |
| `started_at` | string (date-time) | no |  |
| `finished_at` | string or null (date-time) | no |  |

### WorkflowRunQueued

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `workflow_run` | yes |  |
| `queued` | boolean | yes |  |

### OutboundMessage

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `outbound_message` | yes |  |
| `id` | string | yes |  |
| `title` | string | yes |  |
| `kind` | string: `chat`, `banner` | yes |  |
| `state` | string: `draft`, `live`, `paused`, `archived` | yes |  |
| `live_version` | integer or null | no |  |
| `stats` | object | no |  |
| `updated_at` | string (date-time) | no |  |

### DataAttribute

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `data_attribute` | yes |  |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `model` | string: `conversation`, `contact` | yes |  |
| `value_type` | string | yes |  |
| `options` | array of string | no |  |
| `archived` | boolean | no |  |

### Segment

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `segment` | yes |  |
| `id` | string | yes |  |
| `name` | string | yes |  |
| `predefined` | boolean | no |  |

### Export

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `export` | yes |  |
| `id` | string | yes |  |
| `status` | string: `queued`, `running`, `done`, `failed` | yes |  |
| `resources` | array of string | yes |  |
| `rows` | integer | no |  |
| `files` | array of object | no |  |
| `created_at` | string (date-time) | no |  |

### Webhook

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `webhook` | yes |  |
| `id` | string | yes |  |
| `url` | string | yes |  |
| `topics` | array of string | yes |  |
| `version` | string | no | The API version its bodies follow. |
| `status` | string: `active`, `failing`, `disabled` | yes |  |
| `failing_since` | string or null (date-time) | no |  |
| `disabled_at` | string or null (date-time) | no |  |
| `disabled_reason` | string or null | no |  |
| `alert_email` | string or null | no |  |
| `previous_secret_until` | string or null (date-time) | no | While rotating: until when the previous secret also signs. |
| `secret` | string | no | Only when it's created or its secret rotated. |
| `created_at` | string (date-time) | no |  |

### WebhookDelivery

| Field | Type | Always present | About |
|---|---|---|---|
| `type` | string: `webhook_delivery` | yes |  |
| `id` | string | yes |  |
| `event_id` | string | yes | The same across retries and replays: dedupe on it. |
| `topic` | string | yes |  |
| `status` | string: `pending`, `delivered`, `abandoned` | yes |  |
| `attempts` | integer | no |  |
| `next_attempt_at` | string or null (date-time) | no |  |
| `delivered_at` | string or null (date-time) | no |  |
| `last_status` | integer or null | no |  |
| `last_error` | string or null | no |  |
| `replay_of` | string or null | no |  |
| `payload` | object | no | The body sent (on a single delivery). |
| `attempt_log` | array of object | no | Each attempt (on a single delivery). |
| `created_at` | string (date-time) | no |  |
