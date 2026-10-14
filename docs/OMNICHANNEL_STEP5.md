# Phase 12, step E5: WhatsApp Business

Branch `omnichannel/e5-whatsapp`. Plan: `docs/OMNICHANNEL_PLAN.md`. Behind `channel_whatsapp_v1` (and `channels_v1`), both off by default and on for the local relay. Next: E6, SMS.

## What it does

WhatsApp is a channel (E1's contract) through Meta's Cloud API, directly, with each workspace's own Meta app.

**Connecting a number** (Settings › WhatsApp, for managers):
- **What a brand's number needs:** its phone number ID, its WhatsApp Business account ID, a system user's access token and the app's secret.
- **The credentials:** the token and secret are sealed with `RELAY_CONNECTOR_KEY`, like connector secrets, and never shown again (only the token's last four characters).
- **The check:** a job asks Meta for the number's details, which proves the credentials. The number is then Connected, showing its display number, verified name and quality rating, or Not connected with Meta's reason.
- **The webhook to set up at Meta:** the page shows the callback URL (`/v1/hooks/whatsapp/<workspace>`), the number's verify token, and the fields to subscribe to (`messages`, `message_template_status_update`).
- **Check again and Disconnect.** A disconnected number keeps its templates, and reconnecting reuses it.

**The webhook:**
- **Setting it up:** Meta's check is answered with its challenge, but only for a number's verify token.
- **Every call:** it must carry an `X-Hub-Signature-256` made with one of the workspace's app secrets, or it's refused with nothing kept. A signed call is kept and read by the `whatsapp.receive` job, so Meta is answered at once.

**Messages in:**
- **What becomes the customer's message:** text, reply buttons and list choices (their title), template quick replies, locations, and files (images, videos, audio, documents, stickers, with their caption).
- **Threading:** by number. The same customer on the same number within 7 days joins their conversation, and after that starts a new one.
- **Who it's from:** Meta vouches for the number, so the identity is verified and joins a contact who has it verified.
- **Images and documents:** PNG, JPEG, PDF and plain text are downloaded with the number's token, scanned, and published as the customer's attachments.

**Messages out** (through the delivery job and its gate):
- **Text.**
- **Reply buttons:** a workflow's options become three buttons, or a list of up to ten.
- **Files:** uploaded to Meta and sent as an image, video, audio or document, within Meta's size limits.
- **Templates.**
- **Status:** sent, delivered and read come back from Meta's statuses, and a failure shows Meta's reason. Meta's "the customer stopped your messages" (131050) suppresses the number.

**The 24-hour window** (the adapter's `refuses`):
- **Open:** for 24 hours after the customer's last message, anything may be sent.
- **Closed:** only an approved template may go, and only to a number that opted in.
- **When it's checked:**
  - a teammate's free reply is refused at once (409, "The 24-hour window has closed: send an approved template instead.")
  - a reply from Zoe or a workflow isn't sent, with the reason on it
- **In the composer:** the reply line says "Sent by WhatsApp to +44… · window open until Tue 14:05". When the window has closed it says so, and "Send a template" opens a picker: choose a template, fill in its values, see the preview, send.

**Templates:**
- **Writing one:** in Settings, with a name (lower case and underscores), language, category, and text with `{{1}}`, `{{2}}` values (numbered in order, with an example each for Meta's review).
- **Review:** each is submitted to Meta by a job. Its status (In review, Approved, Rejected with the reason, Paused, Disabled) comes from Meta's review webhook, or from "Update their status from Meta".
- **Sending:** a template reply renders its text in the conversation and goes as Meta's template message with the values. Each value is checked, and must be on one line.

**Opt-ins:**
- **How a number opts in:** by writing to the business, by a teammate recording consent given elsewhere (with where), or by START.
- **STOP** (and its common equivalents, in several languages) puts the number on the suppression list as an opt-out. Nothing more is sent to it, not even a template. A teammate can't record consent over it, and only START lifts it.
- **The list:** Settings shows the opted-in numbers and how each opted in.

**Zoe** may answer on WhatsApp (her capability is on, and Meta verifies the number), inside the window.

## How it works

**Migration `0066_whatsapp`:**
- `whatsapp_numbers`: ids, sealed credentials, verify token, status and details
- `whatsapp_templates`: name, language, category, text, examples, value count, status and Meta's id
- `whatsapp_opt_ins`: one active per number
- `whatsapp_inbound`: each signed webhook call until it's read
- row-level security, and the flag
- **The rollback:** the flag goes off (the webhook refuses), and unsent WhatsApp deliveries and unread calls fail. Numbers, templates, opt-ins and the suppression list stay.

**The contract (`server/channels.ts`):**
- **`refuses`** is given the part, so a template may go when nothing else may. `mayDeliver` passes it, and the reply command asks it too, so a closed window is said at once.
- **`templateReply`:** a new adapter hook, used by the reply command's `template` (`{id, params}`).
- **`replyDetails`** can carry more than strings (the window and the templates).

**WhatsApp:**
- **`server/whatsapp.ts`:**
  - the adapter: `refuses`, `prepare`, `send`, `replyDetails`, `templateReply`
  - the webhook's check and receipt
  - the jobs: `whatsapp.receive`, `whatsapp.check`, `whatsapp.template` and `whatsapp.sync`
  - Settings' read and actions: `connect`, `check`, `disconnect`, `template`, `sync`, `opt_in`
  - `whatsappClock`: the window's time, which tests move on, since parts can't be back-dated
- **`server/whatsapp-api.ts`:** the `WhatsAppApi` port and Meta's Graph API (v21.0). Bad requests are `WhatsAppRejected` (not retried); throttling and outages are retried.
- **`server/connectors.ts`:** exports `unseal`.

**Elsewhere:**
- **Routes:**
  - `GET` and `POST /v1/hooks/whatsapp/<workspace>`; the POST body is read as text, so the signature covers its exact bytes, at most 1 MB
  - `GET` and `POST whatsapp-settings`
- **The Worker:** the jobs, `graphApi()`, and the delivery job's WhatsApp environment.
- **Local relay:**
  - the stand-in (`scripts/local-whatsapp.ts`: Meta in memory, and webhook calls signed as Meta signs them)
  - the jobs
  - `POST /dev/whatsapp` (`{from, name, text}`): a customer's message to the demo's number, through the signed route
  - the seed: the demo brand's number, connected, and the approved template `order_update`
- **UI:**
  - `agent/settings-whatsapp.tsx`
  - the composer's window line and `TemplatePicker` (`agent/reply-target.tsx`)
  - the label "WhatsApp"

## Trying it locally

Run `npm run dev:relay`, then send yourself a message (8788 is the API port):

```bash
curl -X POST http://localhost:8788/dev/whatsapp -H "content-type: application/json" -d '{"from":"447700900456","name":"Ada","text":"Hi, where is my order?"}'
```

Replies show on the stand-in's side in the server's memory. The tests read them as `relay.whatsapp.sent`.

## Deploying (not done: needs you)

- **A Meta Business account** with a WhatsApp Business number, and a Meta app with WhatsApp added.
- **The credentials:** a system user with a permanent access token (`whatsapp_business_messaging` and `whatsapp_business_management`), and the app secret.
- **The webhook:** set up at the callback URL with the verify token Settings shows, subscribed to the two fields. The callback must be Relay's public HTTPS address.
- **`RELAY_CONNECTOR_KEY`** set, because it seals the credentials.

## Checks

- **`tests/whatsapp.test.ts`:**
  - **Connecting:** bad details refused. The credentials are sealed and never returned (only the token's last four). Meta's check connects, or a bad token fails with Meta's reason. Another workspace's numbers are its own.
  - **The webhook:** the verify token is answered (and refused when wrong, or for another workspace). A forged signature is refused, with nothing kept.
  - **Messages in:** text, verified, with an opt-in. A button reply threads.
  - **Out:** text in the window. Receipts move forward only, and a failure has Meta's reason. A workflow's buttons go as buttons.
  - **Media in:** downloaded, scanned, published.
  - **Templates:** malformed ones refused. Submitted with only the draft, approved by webhook, rejected by sync.
  - **The window:** closed 25 hours on. A free reply is refused at once, and Zoe's isn't sent. A template is refused with wrong values, then sent filled in.
  - **Opt-ins:** STOP suppresses (even a template); a teammate can't record over an opt-out; START lifts it. Address normalisation is checked too.
  - **The rollback.**
- **`tests/browser/whatsapp.spec.ts`** (ports 9044 and 9045):
  - **Happy path:** a message becomes a conversation via WhatsApp, the composer shows the open window, and the reply is sent and then read. Settings shows the connected number, the webhook, the approved template and the opt-in.
  - **Failure path:** 25 hours later the composer says the window has closed and a free reply is refused. The template is previewed and sent. STOP shows as "Opted out" and the next reply isn't sent. A number with a token Meta refuses is "Not connected", with Meta's reason.

## Not included

- **Embedded signup** (connecting through Relay's own Meta app as a Tech Provider): `TODO(phase 17)` with the hosting.
- **Templates beyond a text body** (headers, media, buttons), and outbound business-initiated campaigns: phase 13's.
- **Reactions,** which are ignored for now.
- **Locations and contacts** are shown as text.
