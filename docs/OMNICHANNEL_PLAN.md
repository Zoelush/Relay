# Phase 12: Omnichannel (plan)

Brief: `docs/BUILD_PHASES.md` phase 12. It needs phase 04 (done). Drafted on 13 October 2026. E1 was approved that day ("go ahead with E1"), with the recommendations below.

The brief's order is the plan's order:
1. the adapter contract
2. email, completely (the hard one)
3. the other channels, as repetitions of the contract

Every provider sits behind a port with an offline stand-in, as Zoe's models do. Tests use recorded exchanges (`tests/fixtures/`), never the network. Locally, the dev relay delivers to a mailbox you can read (and the same for each channel), so everything works before any account exists.

## Where Relay is today

**Already there:**
- `conversations.channel` and `conversation_parts.channel` exist, always `messenger`.
- Attachments have storage and a scanner.
- People have contacts with several emails and phones. Identities are `anonymous` or `user` (the messenger's).
- Nothing sends or receives email yet. Customers are only told of replies in the messenger.

**Messenger assumptions in the code** (each becomes a question to the channel's adapter):
- Zoe answers only on the messenger (`queueAiReply`).
- Verification rules are messenger-only.
- Part delivery assumes the messenger.
- Office hours are per brand or team, not per channel.

## Steps

| Step | Scope |
|---|---|
| **E1: The channel contract** | One interface every channel implements: `receive` (inbound payload to a part), `send` (outbound part to a delivery with status), `capabilities` (rich text, attachments, buttons, length limits, session windows), and `identify` (the channel's own identifier to a contact). The messenger becomes its first adapter, and the messenger assumptions above go through it. Also: a delivery record per outbound part (queued, sent, delivered, read, failed, with the reason); one suppression list consulted by every send path; the channel shown on each part; office hours per channel; and identities for channel addresses (email, phone, and so on) resolving to one contact, without merging an unverified address into a signed-in user. |
| **E2: Email in** | MIME parsing (multipart, inline images, character sets, attachments, size limits). Threading by Message-ID, In-Reply-To and References, with a subject-and-participants fallback. Quoted history and signatures stripped, with the full original behind a control. Auto-replies, out-of-office and bounces detected and never treated as the customer's reply. Inbound HTML sanitised, with remote content blocked by default. Attachments scanned. Each brand gets an inbound address, and forwarding from the brand's own support address is verified. Acceptance: **the 50-email corpus** (forwarded chains, Outlook and Gmail quoting, mobile signatures, auto-replies, bounces, non-Latin character sets), each with its expected result. |
| **E3: Email out** | A per-brand sending domain, with its SPF, DKIM and DMARC records shown and checked (with status in Settings). A plain-text alternative for every HTML mail. Reply-to routing back to the conversation, with a signed address per conversation. The composer replies by email on email conversations. Messenger conversations email the customer when they're away, with a switch for whether the email includes the conversation's content. Deliverability: bounce and complaint webhooks, the suppression list (hard bounces and complaints added), per-domain rate limiting, and a reputation dashboard. Acceptance: **a suppressed address is never sent to, through any path**, tested by enumerating every send path (teammate, workflow, Zoe, notifications). |
| **E4: Email in the inbox** | The email view: subject, recipients and CC, quoted history shown on request, and blocked images loaded on request. Side conversations (from the gap audit, deferred here): an email thread attached to a conversation, inheriting its assignment, with replies cross-posted into the parent timeline. Workflows gain "inbound email" (a trigger) and "send an email" (a step), from the `TODO(phase 12)`s. Zoe on email, including the gap audit's "human in the loop" (she drafts and a teammate approves) as a setting. Monitor incident alerts by email. |
| **E5: WhatsApp Business** | Number registration, template messages (submitted for approval, stored, with their status), the 24-hour customer-service window with a clear "window closed: send a template" state in the composer, opt-in records, media, and delivery and read receipts. |
| **E6: SMS** | Numbers per country, segment counting and cost estimate in the composer, the mandatory opt-out keywords (STOP and local equivalents) writing a permanent suppression record, and the consent model. |
| **E7: Instagram and Facebook Messenger** | Account connection, messages and story replies, the platforms' own messaging windows, and attachments. |
| **E8: Slack and Discord** | Connect a Slack workspace or Discord server: community messages become conversations, and replies go back to their thread. |
| **E9: Voice** | Number provisioning, inbound calls answered, recording and transcription with a consent step and per-region settings, the transcript written to the conversation as parts, voicemail, and warm transfer to a teammate with context. Zoe on voice uses the phase 08 pipeline, with speakable formatting and a strict barge-in and silence policy. |

Each step ships the usual: migration and rollback, seed, unit tests, an end-to-end happy path and failure path, a CHANGELOG entry and a handoff (`docs/OMNICHANNEL_STEP<n>.md`). Each channel has its own flag, off by default: `channel_email_v1`, `channel_whatsapp_v1`, and so on.

## Decisions (proposed)

1. **Providers sit behind ports, chosen per deployment.** Each channel's provider is an adapter. Its webhook signatures are verified before anything is read, and its credentials are encrypted like connector secrets.
2. **Email in arrives through Cloudflare Email Routing,** into the Worker Relay already deploys on (an Email Worker). It costs nothing extra and keeps mail out of third parties until it's parsed. A brand's own support address forwards to its Relay inbound address. Locally, `.eml` files are posted to the dev relay.
3. **Email out goes through Amazon SES** (with its SNS bounce and complaint notifications), over the AWS request signing Relay already uses for storage (`aws4fetch`). Postmark is the alternative: its transactional deliverability is better, but it costs more per message. The port allows either.
4. **WhatsApp uses Meta's Cloud API directly,** not through a reseller: no markup, and templates and windows straight from the source. **SMS and voice use Twilio:** it has the widest country coverage, and programmable voice with recording, transcription and media streams (for Zoe on calls). **Instagram and Facebook use Meta's Graph API. Slack** uses its Events API (a webhook). **Discord** has no webhook for incoming messages, so a Durable Object keeps its gateway connection.
5. **Who a channel's sender is:** an inbound email's From address is believed only when the message passes DMARC (the inbound authentication results).
   - **When it doesn't pass:** the conversation still opens, but the address isn't verified, isn't merged into a signed-in user, and can't satisfy verification rules for connectors.
   - **Phones:** the same for SMS. WhatsApp numbers are verified by Meta.
6. **One delivery pipeline:** every outbound part to a non-messenger channel is a job, retried with backoff, then dead-lettered.
   - **Status:** its status is a delivery row the inbox shows ("Sent", "Delivered", "Failed: mailbox full").
   - **The single gate:** every send passes `mayDeliver` (suppression, the channel's window, consent). A send path that skips it is a test failure, through the enumeration in E3.
7. **Subscription types arrive in phase 13** (outbound). Phase 12's suppression list covers hard bounces, complaints, opt-out keywords and manual blocks, and `mayDeliver` has a place for subscription checks: `TODO(phase 13)`.
8. **Inbound HTML is sanitised on the server once, when it's received**, to an allowlist, with remote images rewritten to load only on request. The inbox never renders raw mail.
9. **Size limits:** 25 MB a message, 10 MB an attachment, 100 attachments a message. Larger mail is kept as "too large" with its headers, and the sender is told.

## Needs you

- **Providers (decision 3 and 4):** SES (recommended) or Postmark for email; Meta direct for WhatsApp; Twilio for SMS and voice. Say if you'd rather use others (for example Vonage or Telnyx).
- **Accounts:** none are needed to build and test (stand-ins and recorded exchanges). Each channel needs its own to go live: an AWS account with SES out of the sandbox, a Meta Business account with a WhatsApp number, a Twilio account, and Slack and Discord apps. Credentials go in `.dev.vars` and `wrangler secret put`, never in chat.
- **The 50-email corpus:** I'll assemble it from public, synthetic examples of each kind (no real people's mail). If you have real ones you're allowed to use, anonymised, they'd make it stronger.
- **Scope:** E5 to E9 are large, and each is a whole integration. If you'd rather stop after email (E1 to E4) and come back to the others later, say so. The brief's acceptance criteria are both email ones.

10. **E1 decisions** (13 October 2026):
    - **The messenger's own path stays.** Its customers have a signed session and its parts are delivered as they're written, so it's an adapter without `receive` or `send`, and without deliveries. Other channels come in through `receiveInbound`.
    - **Replies go to the conversation's current channel,** the one the customer last wrote on: `conversations.current_channel`, with `channel` kept as the first.
    - **A channel's address is an identity of kind `channel`,** with the address kept (`identity_addresses`) so there's somewhere to send.
    - **The gate is in the delivery job,** right before sending, so no path can reach a provider around it.
    - **Suppression is per channel and address.** Opt-outs and complaints can't be lifted by a teammate.
    - **Office hours by channel** come after the team's and before the brand's.

11. **E2 decisions** (13 October 2026):
    - **The workspace is in the inbound address** (`<workspace>+<token>@<domain>`), so mail is routed without a cross-workspace lookup. The token finds the brand and can be replaced.
    - **Mail is refused at the door** when the address is unknown or it's over 25 MB, so the sender's server tells the sender (decision 9 said "kept as too large"). Nothing about it is kept.
    - **The raw email is kept only until it's read,** in quarantine storage, then deleted. The part holds only the new text, and `email_messages` the full email with its safe HTML.
    - **A DMARC pass is believed only from a trusted receiver's Authentication-Results** (Cloudflare's, deployed), never from headers an earlier hop could have written.
    - **Threading's fallback** is the same subject from the same sender within 30 days, for messages only, never for automatic mail.
    - **Forwarding is confirmed by a forwarded message** that names the support address (To, Cc or Delivered-To). Gmail's confirmation email is shown in Settings, not opened as a conversation.
    - **Until E3, the email adapter has no `send`.** A reply on an email conversation fails at once with a reason, rather than retrying.

12. **E3 decisions** (14 October 2026):
    - **SES, as recommended** (decision 3), behind a port (`EmailSender`), so Postmark can follow.
    - **A brand sends from its support address's domain** once proven, and from Relay's address for the brand until then. Proven means:
      - Relay's own ownership TXT (this workspace's token, so one workspace's DNS never lets another send as the domain)
      - the provider's DKIM
      - the provider's own check

      SPF (on a `bounce.` subdomain, with SES's MAIL FROM) and DMARC are checked and advised.
    - **Each conversation's reply address is a random token, kept in the database,** not a signature over its id. It's as unguessable, needs no key to manage, and the address stays short (a local part has 64 characters at most).
    - **Adapters can `prepare`** inside the gate's transaction (threading, the sender, the rate limit), so `send` stays outside any transaction and nothing reaches the provider but through the job.
    - **The rate limit defers, it doesn't fail:** a delivery over it waits for the next minute (`not_before`), and the sweep queues it again.
    - **Away emails are a delivery of the latest unread reply,** with purpose `away`, so they pass the same gate. Content is off by default, and internal notes are never read for them.
    - **Reports find their workspace by the message's tags,** set when sending and signed (with the rest) by SNS.

13. **E4 decisions** (14 October 2026):
    - **Zoe's approval is a delivery state:** her reply is written as usual, and on email its delivery is held until a teammate sends or discards it. The gate is unchanged, and every path she writes from (answers, handovers, procedures) is covered. Discarding hands the conversation to the team.
    - **Zoe never answers unverified senders or list mail on email,** whatever the setting: the adapter decides (`aiAnswers`).
    - **Side conversations are internal parts of the conversation,** not conversations of their own, so they inherit its assignment and history and can't reach the customer. Their emails are deliveries through the same gate. No contact is made for the third party, and their files aren't kept.
    - **Reply all offers the customer's Cc,** not its To (that's the brand's own address, forwarded).
    - **"Send an email" is customer-facing** and goes to the customer's email address on any channel. On the messenger it's shown in the conversation as well.
    - **Incident alerts go to addresses the managers set:** teammates have no email in Relay (sign-in is the platform's). Alerts are sent from Relay's no-reply address, past the suppression list.

14. **E5 decisions** (14 October 2026):
    - **Each workspace connects its own Meta app** (Meta direct, decision 4): its number's ids, a system user's token and the app secret, sealed with the connector key. Embedded signup through Relay's own app (Tech Provider) waits for hosting.
    - **The webhook is per workspace** (`/v1/hooks/whatsapp/<workspace>`), so no lookup crosses workspaces. Every call is signed with the workspace's app secret, and kept only if the signature checks out.
    - **The window is the adapter's `refuses`,** given the part: a template passes when nothing else does. A teammate's free reply outside it is refused when it's written, not when it would be sent.
    - **A template needs an opt-in.** Writing to the business counts; STOP is a suppression (an opt-out, lifted only by START).
    - **Threading is by number, within 7 days** (the fallback key), since WhatsApp has no threads of its own.
    - **Zoe may answer on WhatsApp,** inside the window: Meta verifies the number.

15. **E6 decisions** (14 October 2026):
    - **Twilio with each workspace's own account** (decision 4). Its auth token is sealed, and it also checks Twilio's calls (`X-Twilio-Signature`).
    - **"Numbers per country" is a choice of sender:** a reply goes from the brand's number with the customer's calling code, else its default. Numbers are bought in Twilio and added here; buying them from Relay waits.
    - **An opt-out is a suppression record kept for good.** START lifts it (recorded, not erased), as US carriers expect. A teammate's reply to an opted-out number, or one without consent, is refused when it's written.
    - **Consent:** texting in, a teammate's record (with where), or START.
    - **Segments are counted in one place** (`lib/sms.ts`), for the composer's meter and the server's 10-segment limit. The cost is an estimate from per-country prices, never a bill.
    - **No files and no Zoe on SMS:** MMS isn't sent (a link is), and anyone can claim a number while every segment costs.

16. **E7 decisions** (15 October 2026):
    - **Two channels, one connection:** a brand's Facebook Page (Messenger) and the Instagram business account linked to it, each channel with its own flag. They share a per-workspace signed webhook and the Page's token.
    - **The windows are the adapter's `refuses`, told who wrote the part.** In 24 hours anything goes. Up to 7 days, only a teammate's reply, tagged `HUMAN_AGENT`. After that, nothing.
    - **Attachments go out by a short-lived signed link,** never a public one, and come in only from Meta's CDN.
    - **Page-scoped ids are verified but join no other contact.** That fixes E1's identity query for accounts.
    - **Zoe may answer within 24 hours** (Meta verifies the account).

17. **E8 decisions** (15 October 2026):
    - **Slack through each workspace's own app,** by the Events API: signed, within 5 minutes, each event once, and only for a connected Slack workspace's own team.
    - **Discord's gateway in a Durable Object per bot** (decision 4). The protocol is kept apart from the socket (`DiscordGatewaySession`) and tested on its own. The object reconnects with backoff, the sweep keeps it up, and it stops for good on Discord's fatal codes.
    - **Threads:** Slack's thread is the conversation. On Discord, a reply to the message, or the same person in the channel within a day, joins it.
    - **Zoe stays out** of public community spaces, and **files aren't posted** (a link instead).

18. **E9 decisions** (15 October 2026):
    - **Voice uses SMS's Twilio account and numbers:** a number takes calls when switched on, and numbers can be bought from Settings (confirmed, since it costs money).
    - **Recording consent per calling code:** don't record, record and say so, or ask first (the default). Zoe and transcripts need recording, so she never hears a call that isn't recorded.
    - **Zoe hears by Twilio's speech recognition, turn by turn,** not media streams (decision 4): each utterance is a customer message answered by her own pipeline, and the call waits for her reply. This is simpler and keeps every guard. Media streams can come later for lower latency.
    - **Warm transfer to teammates' own phones,** one at a time, with a whisper and press 1. Voicemail when nobody takes the call or office hours are closed.
    - **Transcripts by Workers AI's Whisper** behind `TranscriptionPort`. They're internal: a call's lines are events, and a voicemail is the caller's message.
    - **A call can't be answered in writing:** a teammate's reply is refused when written.

Handoffs: `docs/OMNICHANNEL_STEP1.md` (E1), `docs/OMNICHANNEL_STEP2.md` (E2), `docs/OMNICHANNEL_STEP3.md` (E3), `docs/OMNICHANNEL_STEP4.md` (E4), `docs/OMNICHANNEL_STEP5.md` (E5), `docs/OMNICHANNEL_STEP6.md` (E6), `docs/OMNICHANNEL_STEP7.md` (E7), `docs/OMNICHANNEL_STEP8.md` (E8), `docs/OMNICHANNEL_STEP9.md` (E9). Email (E1 to E4) is complete, and so is the plan (E1 to E9).
