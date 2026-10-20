# Phase 15, step D3: Webhooks

Branch `platform/d3-webhooks`. Plan: `docs/DEVELOPER_PLATFORM_PLAN.md` (scope: D1 to D5). Behind `developer_api_v1`. Next: D4, OAuth apps.

## What it does

**Subscriptions** to an https address and topics, in Settings › Developers › Webhooks (for who manages the workspace) or through the API (`/webhooks`):
- **The signing secret** is shown once, and again only when it's rotated.
- **Rotating** keeps the previous secret signing alongside the new one for 24 hours, so a receiver switches without missing anything.
- **An optional alert email** is told if the webhook is turned off.
- **It can be turned off and on again,** and deleted.

**Topics** (`lib/webhook-topics.ts`; the reference lists each with what it carries):
- **Conversations:** created, customer replied, teammate replied, assigned, closed, rated, tagged.
- **Tickets:** created, state changed.
- **Contacts:** created, updated, merged.
- **Events:** received.
- **Zoe:** resolved, escalated.
- **SLAs:** breached.
- **Articles:** published.
- **Waiting for phase 01:** company topics and `contact.tagged`.

**Each delivery** is a signed JSON POST:
- **The body** is `{type: "webhook_event", id, topic, created_at, workspace_id, data: {item, …}}`. `item` is the resource exactly as the API shows it, with `part`, `tag`, `changes`, `metric` or `merged_contact_id` when the topic has one.
- **Internal notes are never sent.** They aren't a topic, and never a part.
- **Headers:**
  - `Relay-Signature: t=<unix>,v1=<HMAC-SHA256 of "t.body">`, with a second `v1` while a secret is rotated.
  - `Relay-Event-Id`, the same across retries and replays, to dedupe on.
  - `Relay-Webhook-Id` and `Relay-Topic`.

**Delivery:**
- **At least once,** in the order events happened.
- **A 2xx within 10 seconds counts.**
- **Anything else is retried** with exponential backoff (a minute, doubling, at most two hours apart), for 24 hours.
- **Turned off after 24 hours failing** with no success. Its creator gets a notification in Relay, and its alert email gets a message. On again, it starts afresh.
- **The delivery log** is in Settings and the API: every attempt, its status, time and the first 1 KB of the answer, kept 30 days. Any delivery can be replayed (same event, same body), and a test ping can be sent.

**Verifying** is documented in the reference, with JavaScript and Python code (a test runs both). Both SDKs have it built in: `verifyWebhook(secret, rawBody, header)` and `verify_webhook(secret, raw_body, header)`. Each checks the signature in constant time and refuses one older than 5 minutes.

## How it works

**Events are written by the database** (migration `0078_webhooks`):
- **Triggers** on conversation parts, conversations, contacts, contact events, tickets, Zoe's resolutions and article revisions call `webhook_emit`. It writes a `webhook_events` row in the same transaction as the change, so every way something changes is covered and nothing is announced that didn't happen.
- **Only when wanted:** it writes only while an active subscription wants that topic, so a workspace without webhooks writes nothing extra (tested).
- **A test holds the triggers' topics to the list.**

**Delivery is the `webhooks.run` job** (`server/webhooks.ts`), scheduled by the sweep when there's work:
1. **Fan-out:** each event goes to its subscriptions with its body built once, in the API's shapes, and kept, so retries and replays send exactly the same bytes.
2. **Sending:** due deliveries go out through `safeRequest`. That's public https only, except what a test's policy allows. Each is sent between transactions, so a slow receiver never holds a lock.
3. **Recording:** each attempt is logged, and a failure is rescheduled, abandoned, or turns the webhook off.
4. **Pruning:** the log and dispatched events older than 30 days are pruned by the sweep.

**Secrets** are sealed with the connector key (AES-GCM, as connectors' credentials are), and decrypted only to sign.

**The alert email** goes through `sendAlert`, the one alert path. The suppression list is checked first, and the guard test still finds only two `sendRaw` calls. `email_alerts` gained a kind, and the notification kind `webhook_disabled` opens Settings › Webhooks.

**Code:**
- `server/webhooks.ts` (management, delivery, and the API's handlers)
- `lib/webhook-topics.ts`
- `agent/settings-webhooks.tsx`
- the D3 block of `lib/api-spec.ts`, with SDK helpers in `lib/api-sdk.ts`
- `sendAlert`'s new kind
- the routes `developer-webhooks`, `developer-webhook-deliveries`, `developer-webhook-delivery` and `developer-webhook`
- the job and sweep in the local relay and the Worker

**Migration 0078:** the four tables, the triggers, `notifications.webhook_subscription_id` with the kind's constraint, and `email_alerts.kind`.
- **Its rollback** drops the triggers (no more events). Turning `developer_api_v1` off stops delivery.

**Seed data:** none. A webhook needs your address.

## Checks

- **`tests/webhooks.test.ts`:**
  - **The triggers' topics** equal the list.
  - **Nothing is written** without a subscription.
  - **Subscription validation:**
    - a non-https address and an unknown topic are named
    - the secret is shown once
  - **Delivery:**
    - every subscribed topic is delivered in order
    - each signature is accepted by the SDK's check, which refuses a wrong secret, a changed body or an old time
    - the payloads are right
    - no internal note is ever sent
  - **Failures:**
    - a 500 is retried after about a minute, with its answer logged
    - nothing is sent before it's due
    - the same body goes on success, and failures are forgiven
  - **Replay and rotation:**
    - a replay sends the same body
    - during rotation both secrets sign
    - a test ping is delivered
  - **Giving up:**
    - abandoned after 24 hours
    - turned off after failing 24 hours, with the creator's notification and the alert email (subject and text)
    - nothing sent while off, then on again
  - **Isolation:** another workspace can't see, read or replay it, and its own webhook gets none of these events.
  - **Deleting** stops waiting deliveries.
  - **The reference's JavaScript and Python snippets** accept Relay's signature and refuse a wrong one.
- **`tests/browser/webhooks.spec.ts`,** with a real receiver on this machine:
  - **Happy path:** a webhook made in Settings receives a customer's messenger message, signed and verified.
  - **Failure path:** the receiver failing a test ping shows "Retrying", the 500 and the receiver's words in the log, and a replay delivers once it's fixed.
