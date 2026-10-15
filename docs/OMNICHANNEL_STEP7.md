# Phase 12, step E7: Instagram and Facebook Messenger

Branch `omnichannel/e7-instagram-facebook`. Plan: `docs/OMNICHANNEL_PLAN.md`. Behind `channel_facebook_v1` and `channel_instagram_v1` (and `channels_v1`), off by default and on for the local relay. Next: E8, Slack and Discord.

## What it does

Two channels (E1's contract), Facebook Messenger and Instagram direct messages, from one connection: a brand's Facebook Page and the Instagram business account linked to it, through Meta's Graph API with the workspace's own Meta app.

**Connecting a Page** (Settings › Instagram & Facebook, for managers):
- **What a Page needs:** its ID, a Page access token (a system user's, with `pages_messaging`, and `instagram_manage_messages` for Instagram) and the app secret.
- **The credentials:** both are sealed with `RELAY_CONNECTOR_KEY` and never shown again (only the token's last four characters).
- **The check:** a job asks Meta for the Page, which proves the token, and finds the Instagram account linked to it. The Page is then Connected, with its name and the Instagram @username, or Not connected with Meta's reason.
- **The webhook to set up at Meta:** the callback URL (`/v1/hooks/meta/<workspace>`), the Page's verify token, and the fields to subscribe to.
- **Check again and Disconnect.** A disconnected Page keeps its id, and reconnecting seals the credentials again under it.

**The webhook:** Meta's set-up check is answered only for a Page's verify token. Every call must carry an `X-Hub-Signature-256` made with one of the workspace's app secrets, or it's refused with nothing kept. Calls about anything but a Page or Instagram are ignored. The rest are read by the `meta.receive` job.

**Messages in:**
- **What becomes the person's message:** text, quick replies, and attachments. Images and documents come from Meta's CDN only (`fbcdn.net`, `fbsbx.com`, `cdninstagram.com`) and are scanned; anything elsewhere isn't fetched.
- **Instagram stories:** a story reply ("Replied to your story: …") and a mention ("Mentioned you in their story") carry the story's link.
- **Threading and identity:**
  - one conversation per person and platform, within 7 days
  - the person is named from their profile (best effort)
  - their id is Meta's own, scoped to the Page, and verified, but it joins no other contact (an account isn't an email or a phone)
- **Echoes:** the Page's own messages (from Relay, or from Meta's inbox) come back as echoes and are ignored.

**Messages out** (through the delivery job and its gate):
- **What goes:**
  - text: 2,000 characters on Messenger, 1,000 on Instagram
  - a workflow's options, as quick replies (13 at most)
  - files, by a short-lived signed link Meta fetches at once: pictures, video and audio on both, and documents on Messenger only ("Instagram takes pictures, video and audio, not documents: send a link instead.")
- **Receipts:**
  - delivered, by message id
  - read: by watermark on Messenger (everything sent before it), by message id on Instagram
  - a refusal from Meta, with its reason (not retried)

**The windows** (the adapter's `refuses`, now told who wrote the part):
- **24 hours** after the person's last message, anything may go, as a response.
- **Up to 7 days,** only a teammate's reply, sent with Meta's `HUMAN_AGENT` tag (allowed for human support). Zoe's and a workflow's replies aren't sent, with the reason.
- **After 7 days,** nothing until the person writes again. A teammate's reply is refused at once.
- **In the composer:** "window open until …", or the channel's own note, e.g. "Messenger's 24-hour window has closed: you can still reply until … UTC (as a person, not automation)."

**Zoe** may answer on both, within the 24 hours: Meta verifies the account.

**A fix to E1:** a verified address of the "account" kind (these ids) sent parameters to a query that has none. Accounts now simply join no contact.

## How it works

**Migration `0068_meta_messaging`:**
- `meta_pages`: the Page and its Instagram account, the sealed credentials, the verify token, and status
- `meta_inbound`: each signed call until it's read
- row-level security, and the two flags
- **The rollback:** both flags go off (the webhook refuses), and unsent replies and unread calls fail. Pages and conversations stay.

**The contract (`server/channels.ts`):**
- **`OutboundPart`** gains `author`. `runDelivery` and the reply command pass it to `refuses`.
- **`channelIdentity`** joins only by a verified email or phone.

**Meta messaging:**
- **`server/meta-messaging.ts`:**
  - the adapter factory (`facebookChannel`, `instagramChannel`)
  - the webhook's check and receipt
  - the jobs: `meta.receive` and `meta.check`
  - Settings' read and actions: `connect`, `check`, `disconnect`
  - `metaClock`: the windows' time, which tests move on
- **`server/meta-api.ts`:** the `MetaApi` port and the Graph API (v21.0).
  - Bad requests are `MetaRejected` (not retried).
  - Throttling (codes 4 and 613) and outages are retried.
  - Downloads come from Meta's CDN only, without redirects.

**Elsewhere:**
- **Routes:**
  - `GET` and `POST /v1/hooks/meta/<workspace>`: the body is read as text, so the signature covers its exact bytes, at most 1 MB
  - `GET` and `POST meta-settings`
- **The Worker:** the jobs, `graphMessaging()`, and the delivery job's `meta` environment.
- **Local relay:**
  - the stand-in (`scripts/local-meta.ts`)
  - the jobs
  - `POST /dev/meta` (`{platform, from, name, text}`)
  - the seed: the demo brand's Page and Instagram account, connected
- **UI:**
  - `agent/settings-meta.tsx`
  - the composer's window note (`windowNote`)
  - the labels "Facebook Messenger" and "Instagram"

## Trying it locally

Run `npm run dev:relay`, then send yourself a message (8788 is the API port):

```bash
curl -X POST http://localhost:8788/dev/meta -H "content-type: application/json" -d '{"platform":"instagram","from":"17841400000000002","name":"Ada","text":"Hi!"}'
```

## Deploying (not done: needs you)

- **A Meta app** with Messenger and Instagram (Graph API), and the Facebook Page linked to an Instagram business (or creator) account.
- **A system user's Page access token** with `pages_messaging` and `instagram_manage_messages`, and app review for them (plus "Human Agent" for the 7-day tag).
- **The webhook,** set up at Relay's public HTTPS callback with the verify token Settings shows, subscribed to the Page's and Instagram's fields.
- **`RELAY_CONNECTOR_KEY`** set.

## Checks

- **`tests/meta-messaging.test.ts`:**
  - **Connecting:** bad details refused; sealed; Meta's check finds the Instagram account; a bad token fails with Meta's reason (in another workspace).
  - **The webhook:** the verify token is answered; a forged signature is refused, with nothing kept.
  - **Messenger in:** named, verified, threaded; the echo ignored.
  - **Instagram:** its own conversation; a story reply and a mention, with their links.
  - **Files in:** from the CDN, scanned; elsewhere, not fetched.
  - **Out:** a response in the window; delivered and read (by watermark, and by message id on Instagram); quick replies.
  - **Files out:** a picture by a signed link; a PDF refused on Instagram.
  - **Meta refusing:** said with its reason.
  - **The windows:** 25 hours on, a teammate's reply goes tagged `HUMAN_AGENT` and Zoe's doesn't; 8 days on, a teammate's reply is refused at once; the composer's notes.
  - **The rollback.**
- **`tests/browser/meta.spec.ts`** (ports 9048 and 9049):
  - **Happy path:** a Messenger message becomes a conversation; the composer shows the open window; the reply is sent and then delivered. An Instagram story reply shows. Settings shows the Page, the Instagram account and the webhook.
  - **Failure path:** a day on, the composer says only a person may reply, and the reply goes tagged `HUMAN_AGENT`. A week on, the reply is refused with the reason and nothing is sent. A Page with a token Meta refuses is "Not connected", with Meta's reason.

## Not included

- **Connecting through Relay's own Meta app** (Facebook Login for Business): `TODO(phase 17)` with the hosting.
- **Comments on posts,** private replies to comments, and ice-breakers.
- **Instagram's "Like" reactions and unsends,** which are ignored.
- **Postbacks from persistent menus:** Relay doesn't set a menu.
