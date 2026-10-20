# Relay API reference

Generated from `lib/api-spec.ts` by `npm run api:doc`; don't edit by hand. The machine-readable spec is at `/rest/openapi.json`, and this page at `/developers`.

Relay's REST API: conversations, contacts, tags, teammates and teams. Authenticate with a personal access token (Settings › Developers) as `Authorization: Bearer <token>`. Name a version with `Relay-Version`; without one, the token's own version is used.

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
