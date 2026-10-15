# Phase 12, step E8: Slack and Discord

Branch `omnichannel/e8-slack-discord`. Plan: `docs/OMNICHANNEL_PLAN.md`. Behind `channel_slack_v1` and `channel_discord_v1` (and `channels_v1`), off by default and on for the local relay. Next: E9, voice.

## What it does

Two channels (E1's contract) for community support. A connected Slack workspace's or Discord server's messages become conversations, and replies go back into their thread.

**Connecting** (Settings › Slack & Discord, for managers):
- **Slack:** the workspace's own Slack app, with its bot token and signing secret (both sealed with `RELAY_CONNECTOR_KEY`, never shown again). A job checks it (`auth.test`) and finds the Slack workspace and the bot's user. The page shows the events URL to set up (`/v1/hooks/slack/<workspace>`), the scopes and the events to subscribe to.
- **Discord:** the server's bot token (sealed). A job checks it (`/users/@me`) and starts the bot's gateway. The page shows the gateway's state (connected, reconnecting, or why it stopped).
- **Duplicates:** a second connection to the same Slack workspace or Discord bot is refused ("That workspace or server is already connected.").
- **Check again and Disconnect.**

**Slack's Events API:**
- **Checking each call:** Slack's signature (`v0`, HMAC-SHA256 with the signing secret over the timestamp and body) must check out, and the timestamp must be within 5 minutes (anything older could be a replay).
- **The URL check:** Slack's check while the app is set up is answered for any connection's secret.
- **Events:** they're taken only for a connected Slack workspace from its own team. Each is kept once by its event id, because Slack retries, and read by the `community.receive` job.

**Discord's gateway:**
- **Why a gateway:** Discord has no webhook for messages, so a Durable Object per connected bot (`DiscordGateway`, `workers/discord-gateway.ts`) holds its gateway connection.
- **The protocol** is `DiscordGatewaySession` (`server/community.ts`), apart from any socket. HELLO starts the heartbeat, then IDENTIFY (guild messages, direct messages and message content), or RESUME with the session and last sequence. A missed heartbeat ACK closes a zombie connection; RECONNECT and INVALID_SESSION close it for a resume or a fresh start.
- **Reconnecting:** the object reconnects from an alarm with backoff (2 seconds up to 5 minutes). It stops for good on Discord's fatal codes (a bad token, intents not allowed), or when the connection is disconnected or the flag is off.
- **Kept running:** the sweep keeps every connected bot's gateway up.
- **Messages:** each MESSAGE_CREATE goes to `ingestDiscordMessage`: kept once by its id, then read by the job.

**Messages in:**
- **Ignored:** bots' messages (Relay's own included), edits, deletions and joins.
- **Slack threading:** a message starts a conversation, and replies in its thread join it (keyed by the thread's root). A new top-level message is a new conversation.
- **Discord threading:** a message starts a conversation. A reply to it, or the same person in the same channel within a day, joins it; another channel doesn't.
- **Identity:** people are the platforms' own accounts (Slack's `<team>:<user>`, Discord's user id), named from their profile and verified by the platform. They join no other contact.
- **Files:** images and documents shared on Slack are fetched with the bot's token (from `files.slack.com` only), or from Discord's CDN, and scanned.

**Replies out** (through the delivery job and its gate):
- **Slack:** into the message's thread (`chat.postMessage` with `thread_ts`).
- **Discord:** as a reply to the person's latest message there, pinging nobody (`allowed_mentions` empty).
- **Formatting:** a workflow's options are written out.
- **Not sent:** files ("Files can't be posted to Slack from Relay yet: send a link instead."). A platform's refusal (an archived channel) is said with its reason.

**Zoe stays out:** her capability is off on both, since these are public community spaces.

## How it works

**Migration `0069_community`:**
- `community_connections`: platform, brand, team or bot id, name, bot user, sealed token and secret, status, and the gateway's state
- `community_inbound`: each event until it's read, once per event id
- row-level security, and the two flags
- **The rollback:** both flags go off (Slack's webhook refuses, Discord's gateway stops taking messages), and unsent replies and unread events fail.

**Slack and Discord:**
- **`server/community.ts`:**
  - the adapters (`slackChannel`, `discordChannel`)
  - `slackSignature` and `receiveSlackWebhook`
  - `DiscordGatewaySession`, `ingestDiscordMessage`, `reportGateway`, `gatewayCredentials` and `discordConnections`
  - the jobs: `community.receive` and `community.check`
  - Settings' read and actions: `connect`, `check`, `disconnect`
- **`server/community-api.ts`:** the `SlackApi` (Web API) and `DiscordApi` (REST v10) ports. Refusals are `CommunityRejected` (not retried); 429 and outages are retried.
- **`workers/discord-gateway.ts`:** the Durable Object.

**Elsewhere:**
- **The Worker:**
  - `DiscordGateway` (its database by Hyperdrive), the `DISCORD_GATEWAY` binding, and migration tag `relay-v2` in `scripts/worker-config.mjs`
  - the jobs
  - the sweep keeping gateways up
  - the delivery job's `community` environment
- **Routes:** `POST /v1/hooks/slack/<workspace>`, and `GET` and `POST community-settings`.
- **Local relay:**
  - the stand-ins (`scripts/local-community.ts`)
  - `POST /dev/slack` (`{channel, user, name, text, thread_ts}`), signed as Slack signs it
  - `POST /dev/discord` (`{channel, author, username, content, replyTo}`), handed over as the gateway would; the gateway itself only runs deployed
  - the seed: a Slack workspace and a Discord server for the demo brand
- **UI:** `agent/settings-community.tsx`, and the labels "Slack" and "Discord".

## Trying it locally

Run `npm run dev:relay`, then (8788 is the API port):

```bash
curl -X POST http://localhost:8788/dev/slack -H "content-type: application/json" -d '{"channel":"C0SUPPORT","user":"U0ADA","name":"Ada","text":"Is the API down?"}'
```

```bash
curl -X POST http://localhost:8788/dev/discord -H "content-type: application/json" -d '{"channel":"700000000000000001","author":"600000000000000001","username":"Grace","content":"How do I rotate my key?"}'
```

## Deploying (not done: needs you)

- **Slack:** a Slack app with a bot user, the scopes `channels:history`, `groups:history`, `im:history`, `chat:write`, `users:read` and `files:read`, and Event Subscriptions pointed at Relay's public events URL (`message.channels`, `message.groups`, `message.im`). Invite the bot to the channels to watch.
- **Discord:** a Discord application with a bot, the Message Content privileged intent switched on, and the bot added to the server with Read Messages and Send Messages.
- **The Worker:** deploy with the new Durable Object (migration `relay-v2`), and `RELAY_CONNECTOR_KEY` set.

## Checks

- **`tests/community.test.ts`:**
  - **The gateway protocol** with a fake socket: identify (the intents), READY and MESSAGE_CREATE dispatched, the sequence kept, heartbeats, the zombie connection closed, a resume at Discord's address, a heartbeat on request, RECONNECT, and an invalid session starting over.
  - **Connecting:** bad tokens refused; Slack's team and Discord's bot found; the gateway started; a duplicate refused; another workspace's are its own; secrets never returned.
  - **Slack's webhook:** the URL check answered. A forged signature, a stale timestamp, another team and another workspace are refused, with nothing kept.
  - **Slack messages:** named and verified; a retried event counts once; the thread joins; a new top-level message is new; bots, edits and our own ignored.
  - **Slack replies:** into the thread; options written out; files refused; a shared image scanned.
  - **Discord:** kept once; bots and our own ignored; a reply, or the same person in the channel, joins; another channel doesn't; the reply answers their latest message, pinging nobody.
  - **Disconnected:** Discord's messages aren't kept, and the sweep stops asking for its gateway.
  - **The rollback.**
- **`tests/browser/community.spec.ts`** (ports 9050 and 9051):
  - **Happy path:** a Slack message becomes a conversation via Slack. The reply goes into its thread, and the customer's thread reply joins. A Discord message becomes one via Discord, and the reply answers it. Settings shows both connected and the gateway's state.
  - **Failure path:** a forged Slack call is refused and nothing appears. A bad Slack token is "Not connected" with Slack's reason. A disconnected Discord server's messages are ignored.

## Not included

- **Posting files** to Slack or Discord (a link instead).
- **Slack Connect and Enterprise Grid** specifics.
- **Discord threads and forum posts** as their own conversations (they're channels to Discord; messages in them thread as above).
- **Slash commands and interactive components.**
- **The gateway's end-to-end run:** it runs only in the deployed Worker. Here its protocol is tested apart, and its messages come by `/dev/discord`.
