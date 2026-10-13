# Phase 12, step E1: The channel contract

Branch `omnichannel/e1-channel-contract`. Plan: `docs/OMNICHANNEL_PLAN.md`. Behind `channels_v1`, off by default and on for the local relay. Next: E2, email in.

## What it does

Nothing changes yet for the messenger, the only channel. E1 is what every channel after it plugs into.

**One contract per channel** (`server/channels.ts`, `ChannelAdapter`):
- **`capabilities`:** formatting, attachments, buttons, the longest message, a session window, whether Zoe answers, what receipts it reports, and what an address is (`lib/channels.ts`).
- **`receive`:** the provider's payload as a message.
- **`send`:** an outbound part, with how it went.
- **`address`:** a customer's address, normalised.
- **`refuses`:** the channel's own rule on sending now, such as a closed window.

**The messenger is the first adapter.** Code that assumed the messenger now asks the conversation's channel instead:
- Zoe answers only where its adapter allows her (`queueAiReply`).
- A reply must fit the channel's length limit.
- Workflows' "Channel" condition reads the channel the conversation is on now.

**In:** `receiveInbound`
- **Once:** each provider message is received once (`channel_messages`), so a retried webhook adds nothing.
- **Threading:** a message is threaded by the adapter's keys (`channel_threads`). Email's are its Message-ID, In-Reply-To and References.
- **What it creates:** a message starts or continues a conversation as the customer's, on its channel. The part records the channel, and its extra data (a subject, say) is kept beside it for the inbox.
- **Automatic messages** (auto-replies, bounces) are kept for teammates only, and answer nothing.

**Identity:**
- **One identity per address:** a customer on a channel is an identity of kind `channel` with its address kept (`identity_addresses`), so replies have somewhere to go.
- **Verified addresses:** an address the channel vouches for (for email, a DMARC pass) joins the contact that already has it verified, so one person is one contact across channels.
- **Unverified addresses:** these get their own contact. A forged sender never joins a signed-in user's history.
- **Merging later:** an address that later arrives verified is marked so, but earlier contacts aren't merged. That's phase 01's, with its merge controls.

**Current channel:** the customer's message moves the conversation to the channel it came on, and replies go there. `conversations.current_channel` is new; `channel` stays the first one.

**Out:**
- **Deliveries:** every public part from the team, Zoe or a workflow (replies, messages, attachments) on a conversation whose current channel isn't the messenger becomes a delivery (`channel_deliveries`). It goes to the address the customer last wrote from, and is sent by the `channel.deliver` job.
- **Status:** a delivery is Sending, Sent, Delivered, Read, Not delivered (with the reason), or Not sent because the address is suppressed. Providers' reports (`deliveryReport`) only move it forward, so a late "delivered" never undoes "read".
- **Failures:** a failure the provider calls permanent stops it, and a hard bounce, complaint or opt-out also suppresses the address. Anything else is retried by the job five times, then marked as not delivered and dead-lettered.
- **The messenger** delivers as it's written (realtime), so it has no deliveries.

**The single gate:** every send goes through `mayDeliver`: the suppression list, then the channel's own refusal. `TODO(phase 13)`: subscription types and consent.

**Settings › Suppression list** (Channels):
- **Who adds entries:** addresses nothing is sent to on their channel. Hard bounces, complaints and opt-outs are added by channels; managers block addresses by hand, with a note.
- **Lifting:** a manual block or a hard bounce can be lifted, and is kept as history. An opt-out or a complaint can't be: only the customer can opt back in.
- **Not yet:** with only the messenger, there's no address to block. The page says so until email arrives.

**Office hours per channel:** a calendar can be assigned to a channel (Settings › Office hours). A conversation uses its team's hours, else its channel's, else its brand's, else the workspace's. Zoe, SLAs and workflows use the conversation's current channel.

**In the inbox,** a message on another channel says "via Email" (and so on), and a reply shows its delivery status.

## How it works

**Migration `0062_channels`:**
- identities of kind `channel`, and `identity_addresses`
- `conversations.current_channel`
- `channel_threads` and `channel_messages`
- `channel_deliveries` and `suppressions` (one active entry per channel and address)
- the `channel` scope for calendar assignments
- the flag
- **The rollback:** turns the flag off, fails unsent deliveries (nothing is sent after it), and removes channel office hours. Identities, threads, delivery history and the suppression list stay, so a re-deploy still never sends to a suppressed address.

**Code:**
- **`server/channels.ts`:** the contract, the registry (`registerChannel`, `adapterOf`, `capabilitiesOf`), the messenger adapter, `channelIdentity`, `receiveInbound`, `queueDelivery` (called by `append`), `mayDeliver`, `runDelivery` (the job), `deliveryReport`, `readDeliveries`, and the suppression list's API.
- **`server/conversations.ts`:**
  - `append` takes the channel a part arrived on, and queues deliveries
  - the customer's message moves the current channel
  - a reply is checked against the channel's length
- **Elsewhere:** `server/calendars.ts` adds the `channel` scope. Zoe, SLAs, office hours, workflows and simulation pass the conversation's current channel.
- **Routes:**
  - `GET suppressions` and `POST suppression` (managers)
  - `GET deliveries?conversation=` (anyone who can read the conversation)
- **Jobs:** `channel.deliver` in the worker and the local relay. The worker has no provider credentials yet: `TODO(phase 12 E3)`, email's.
- **Local relay:** `channels` (stand-in adapters, for tests) and `channelsFlag` options.
- **UI:** `agent/settings-suppressions.tsx`, the Office hours page's channel rows, and the timeline's channel label and delivery status.

## Not included

Every channel itself comes in its own step: email in (E2), email out (E3), email in the inbox (E4), then WhatsApp, SMS, Instagram and Facebook, Slack and Discord, and voice (E5 to E9). Subscription types and consent are phase 13's, with a place in `mayDeliver`.

## Checks

- **`tests/channels.test.ts`,** with a stand-in channel shaped like email:
  - **Flag:** off by default.
  - **In:** a message starts a conversation on its channel, with its data; the customer's address is kept unverified; a repeat is ignored; the next message threads by key; Zoe isn't queued; an auto-reply is internal or dropped.
  - **Identity:** an unverified address doesn't join a signed-in user with it; a verified one joins the person who has it verified.
  - **Out:**
    - a teammate's reply is delivered as plain text, and reports move it forward only
    - deliveries are hidden from another workspace
    - a too-long reply is refused
    - writing on the messenger moves replies there, and back by the channel
  - **The gate:** the same suppressed address through every send path (a teammate's reply, a workflow's message, Zoe's reply, an attachment): each "suppressed", nothing sent.
  - **Failures:** a permanent failure with a hard bounce fails and suppresses; a transient one is retried five times, then marked failed and dead-lettered.
  - **Lifting:** manual and bounce entries lift; opt-outs refuse with a reason; invalid channel or address refused; another workspace's list is its own.
  - **Office hours:** per channel, with an unknown channel refused.
  - **The rollback.**
- **`tests/browser/channels.spec.ts`** (ports 9036 and 9037):
  - **Happy path:** a message on the stand-in channel shows "via Mail"; the teammate's reply is sent there, shown "Sent", then "Read" after the provider's report.
  - **Failure path:** an address blocked in Settings; the reply shows "Not sent: the address is suppressed" and nothing is sent; an opt-out has no Lift; the manual block is lifted into history.
