# Phase 12, step E3: Email out

Branch `omnichannel/e3-email-out`. Plan: `docs/OMNICHANNEL_PLAN.md`. Behind `channel_email_v1` (and `channels_v1`), both off by default and on for the local relay. Next: E4, email in the inbox.

## What it does

A reply on an email conversation is emailed to the customer, in its thread. Messenger customers who don't read a reply get an email of it. Everything goes through E1's delivery job and its single gate, so a suppressed address is never sent to.

**Replies by email:**
- **Every public part on an email conversation is emailed:** from a teammate, Zoe, a workflow, or a file. It goes as `multipart/alternative`, plain text first then HTML, so every HTML mail has a plain-text alternative. A file goes as an attachment, up to 10 MB, once its scan has passed.
- **The words:** the HTML is the reply's own rich document, rendered by the inbox's `RichText` (text escaped, never parsed as HTML). The plain text is its body. The customer's last message is quoted below ("On …, Robin wrote:").
- **From:** "Grace from Acme", or "Zoe from Acme", at the brand's support address once its domain is proven. Until then it goes from Relay's address for the brand (`<workspace>+<token>@<Relay's sending domain>`).
- **Reply-To:** the conversation's own address, `<workspace>+r-<token>@<inbound domain>`. The token is random and unguessable, made the first time the conversation is emailed. Mail to it joins that conversation whatever its headers or subject say.
- **Threading:** the subject is "Re: " and the first email's subject. In-Reply-To is the customer's last message, and References holds the last ten messages either way. Each message Relay sends is recorded as a thread key, so the customer's reply to it threads even at the brand's own address.
- **The composer says where a reply goes:** "Emailed to robin@customer.example · Re: Damaged order", in place of "Visible to the customer".

**Sending domains** (Settings › Email, per brand):
- **Which domain:** the brand's support address's domain is checked when the address is saved. Free mailboxes (Gmail, Outlook.com, iCloud and the like) never are, and their brands keep sending from Relay's address.
- **The records:**
  - **Relay ownership:** a TXT at `_relay.<domain>` with this workspace's own token. Required: another workspace that sets up the same domain can't send as it on the strength of someone else's DNS.
  - **DKIM:** three CNAMEs from the provider. Required.
  - **Bounces:** an MX and SPF on `bounce.<domain>`, so SPF aligns. Advised.
  - **DMARC:** a TXT at `_dmarc.<domain>`. Advised.
- **Checking:** each record is shown with its status (Found, Not found, Different value) and a Copy button. The domain is proven when the required records are found and the provider has verified it. It's checked when saved, on "Check now", every 10 minutes while pending (for three days), and daily once proven (records can be removed).
- **The rate limit:** each sending domain has a limit per minute (60 by default, 1 to 10,000). Relay's shared address allows 30 a minute per workspace. Over it, a delivery waits for the next minute, and the sweep sends it then.

**Away emails** (per brand):
- **When:** a messenger customer who hasn't read a public reply after the brand's minutes (10 by default) gets one email of what they missed. It goes to their contact's email (a verified one first), else the one they gave in the conversation.
- **What it carries:** with "Include the replies themselves" off (the default), it says only that there's a reply. With it on, it carries the unread replies, the last ten. It never carries an internal note: only public replies, files and messages are read for it.
- **Automatic:** it carries `Auto-Submitted: auto-generated` and `X-Auto-Response-Suppress: All`, so out-of-office replies to it can't start a loop.
- **Answering it:** the customer's reply comes back to the conversation's reply address. The conversation then moves to email (E1's current channel).
- **Once:** each reply is emailed once. A read conversation gets nothing.

**Reports from the provider** (`/v1/hooks/ses`):
- **How they arrive:** SES publishes deliveries, bounces and complaints to SNS, which posts them here.
- **The check:** nothing is believed until the SNS signature checks out. The signing certificate must come from an `sns.<region>.amazonaws.com` address, and the message must be for the configured topic. The subscription confirmation is followed only to an SNS address.
- **Each counts once**, by its SNS message id.
- **What they do:**
  - a delivery moves the reply to "Delivered"
  - a hard bounce marks it "Not delivered", with the reason, and suppresses the address
  - a soft bounce marks it not delivered, without suppressing
  - a complaint suppresses the address
- **Finding the workspace:** the workspace and delivery come from the message's tags, which Relay set when sending.

**Sending reputation** (Settings › Email): each sending domain's last 7 and 30 days, with a 30-day daily chart. It shows sent, delivered, bounced and complaints. Its standing:
- **At risk:** a bounce rate of 5% or complaints of 0.1%.
- **Poor:** 10% or 0.5%.
- **Too few emails to judge:** under 20 sent.

**Failures:**
- **Not retried:** a message the provider refuses (rejected, an unverified sender) fails with its reason. So do "Email sending isn't set up for Relay yet." (no provider) and a file that hasn't passed its scan or is over 10 MB.
- **Retried:** a provider that doesn't answer is retried by the job (five attempts), then marked not delivered.

## The acceptance: a suppressed address is never sent to, through any path

**The paths:** `tests/email-out.test.ts` sends to suppressed addresses through every path that makes email. Each ends "suppressed", and the provider is given nothing:
- a teammate's reply
- a workflow's message
- Zoe's reply
- a file
- an away email

**The code check:** a test reads the code to prove there's no other way to send:
- the provider's `sendRaw` is called only in `server/email-out.ts`
- `sendEmail` is only wired into the adapter, never called
- an adapter's `send` is called once, in `runDelivery`, after `mayDeliver`

## How it works

**Migration `0064_email_out`:**
- `email_domains`: the domain, its ownership token, DKIM tokens, the records as last checked, status, and rate
- `email_reply_addresses`: one token per conversation
- `email_send_counts`: per domain, per minute
- `email_events`: the provider's reports, once each
- `email_away`: what each conversation was last emailed through
- away settings on `email_settings`
- on `channel_deliveries`: `purpose` (reply or away), `domain` and `not_before` (the rate limit)
- row-level security on the new tables
- **The rollback:** email deliveries not yet sent fail ("Stopped by rollback."). E2's code sends nothing and no away emails. Domains, reply addresses, reports and the suppression list stay.

**The contract (`server/channels.ts`):**
- **`prepare`:** an adapter can have one. It runs inside the gate's transaction, after `mayDeliver`, and returns what sending needs (`out.prepared`), a later time (`not_before`, released by `releaseDeferred` in the sweep), or a refusal. `send` still runs outside any transaction.
- **`replyDetails`:** what the composer says.
- **Outbound** gains the workspace, part, purpose and prepared data.
- `readReplyTarget` (`GET reply-target?conversation=`).

**Email:**
- **`server/email-out.ts`:** the adapter's `prepareEmail` and `sendEmail`, and the domain records and check (`email.domain.check`, `scheduleDomainChecks`). Also away emails (`checkAwayEmails`, in the sweep), reputation (`readReputation`) and Settings' sending view.
- **`server/email-mime.ts`:** the message, with headers encoded (RFC 2047 and 2231) and folded only by it. A line break in a name or subject can't add a header, and an address with one is refused.
- **`server/email-compose.tsx`:** a reply's and an away email's words, as HTML and text.
- **`server/email-providers.ts`:** the ports, `EmailSender` (`sendRaw`, `identity`) and `DnsResolver`. Amazon SES v2 is signed with `aws4fetch`, creating a domain's identity and its MAIL FROM, and DNS is looked up over HTTPS.
- **`server/email-sns.ts`:** SNS's signature check (the certificate's key is read from its DER) and the events applied.
- **`server/email-in.ts`:** the adapter now has `prepare`, `send` and `replyDetails`. Reply addresses are accepted, and their mail threads by them first. Settings has new actions: `check_domain`, `rate` and `away`.

**Elsewhere:**
- **The Worker (`workers/relay.ts`):**
  - **SES:** `RELAY_SES_REGION` (eu-west-2 by default), and `RELAY_SES_ACCESS_KEY_ID` and `RELAY_SES_SECRET_ACCESS_KEY` (secrets).
  - **Reports:** `RELAY_SES_CONFIGURATION_SET` and `RELAY_SES_TOPIC_ARN`.
  - **Relay's sending domain:** `RELAY_SENDING_DOMAIN`, the inbound domain unless set.
  - **Jobs and sweep:** the jobs, and the sweep's `releaseDeferred`, `checkAwayEmails` and `scheduleDomainChecks`.
- **Local relay:** stand-in providers (`scripts/local-email.ts`: an outbox and DNS, and an SNS signer whose key the real route checks) and the same jobs and sweep. Also:
  - `GET /dev/outbox` (sent emails, read back)
  - `POST /dev/dns` (`{name, type, value}`)
  - the seed: the demo brand's support address `help@acme.example`, with its records published, so it sends from its own domain
- **UI:**
  - `agent/settings-email.tsx` (Sending, Away emails, Sending reputation)
  - `agent/reply-target.tsx` (the composer)

## Trying it locally

Run `npm run dev:relay`, reply to an email conversation, then open `http://localhost:8788/dev/outbox` to see what was sent. To set up another domain, save its support address, then publish its records with `POST /dev/dns` and press "Check now".

## Deploying (not done: needs you)

- **An AWS account with SES** in the chosen region, out of the sandbox, with an access key that can send and manage identities. The key and secret go in `wrangler secret put`.
- **Relay's own sending domain**, verified in SES (it can be the inbound domain).
- **Reports:** a configuration set with an event destination to an SNS topic (deliveries, bounces and complaints), and an HTTPS subscription to `https://<relay>/v1/hooks/ses`. Then `RELAY_SES_CONFIGURATION_SET` and `RELAY_SES_TOPIC_ARN`.
- **Account limits:** SES's own sending quota and rate apply above Relay's per-domain limits.

## Checks

- **`tests/email-out.test.ts`:**
  - **The message:** plain text and HTML alternatives, encoded subject and names, threading headers, an attachment, and no header injection.
  - **SNS signatures:** a changed message, another topic, a certificate from elsewhere, and no topic all fail. The key is read from a real certificate made with openssl, when it's installed.
  - **The code check:** the provider is called only through the delivery job.
  - **Replies:** sent from Relay's address with the reply address and thread, the customer quoted. Replies come back by the reply address, and by In-Reply-To. The composer's target, hidden from another workspace.
  - **Domains:** records missing, then published and proven. Another workspace isn't proven by this one's DNS, and a free mailbox is never a domain. The record list is checked too.
  - **The rate limit:** deferred, then released.
  - **Sending:** a file attached; a refusal not retried; an outage retried.
  - **SES reports:** delivered, once; a forged one refused; a soft bounce, a hard bounce and a complaint; the route without a topic. Then reputation.
  - **Away emails:** not before the minutes, once, never the note, with and without content; read ones get none.
  - **The acceptance enumeration**, and **the rollback**.
- **`tests/browser/email-out.spec.ts`** (ports 9040 and 9041):
  - **Happy path:** the composer says where a reply goes. The reply is emailed in its thread from Relay's address, shown "Sent", then "Delivered" by a signed report. In Settings, the domain's records are missing, then published, checked and proven, and the next reply goes from the brand's address. Away emails are saved with their content.
  - **Failure path:** a forged report is refused. A hard bounce shows "Not delivered" with the reason and suppresses the address (Hard bounce), and the next reply is "Not sent: the address is suppressed" with nothing sent. A Gmail support address keeps Relay's.
- **`tests/email-in.test.ts`:** a reply with no sending provider fails "Email sending isn't set up for Relay yet."

## Not included

- **E4:** email in the inbox (a rich email composer with Cc and Bcc, and Zoe on email).
- **Phase 13:** subscription types and consent (`mayDeliver`'s place for them), and unsubscribe links.
