# Phase 12, step E2: Email in

Branch `omnichannel/e2-email-in`. Plan: `docs/OMNICHANNEL_PLAN.md`. Behind `channel_email_v1` (and `channels_v1`), both off by default and on for the local relay. Next: E3, email out.

## What it does

Customers email a brand's own support address. It forwards to the brand's Relay inbound address, and each email becomes a conversation, or joins its thread, as a channel (E1's contract) called Email.

**Inbound addresses:**
- **The format:** each brand has `<workspace>+<token>@<inbound domain>`. The token is random and replaceable, so nobody can mail into a workspace without it. A new address retires the old one at once.
- **Where mail comes from:** Cloudflare Email Routing hands mail to the Worker's `email` handler. Locally, a raw `.eml` is posted to the dev relay's `/dev/email` (see "Trying it locally").
- **Refused at the door:** mail to an unknown or retired address, mail while the flag is off, and mail over 25 MB. The sender's server tells the sender.

**Reading an email** (the `email.receive` job, so receiving answers quickly):
- **Parsing:** MIME through `postal-mime`: multipart, quoted-printable and base64, and character sets (ISO-2022-JP, Shift_JIS, GB2312, Big5, EUC-KR, KOI8-R, Windows-1251, ISO-8859-7 among the corpus).
- **Only the new text goes in the part.** Quoted history is stripped: "On … wrote:" in thirteen languages (including two-line wraps), Outlook's From/Sent block, "Original Message" rules, trailing quote lines, and Gmail, Yahoo, Thunderbird and Outlook quote containers in HTML-only mail. The "-- " signature and mobile sign-offs ("Sent from my iPhone") go too. Forwarded mail is kept whole, because the forwarded message is the point.
- **The full email is behind a control:** "Show the full email" on the message opens it with its quoted history, From (with whether the sender is verified), To, Cc, the date and its attachments.
- **Threading:** by Message-ID, In-Reply-To and References. Failing that, by the same subject (without Re:/Fwd:/AW: and the like) from the same sender within 30 days.
- **Who sent it:** the From address is verified only when the message passed DMARC, as reported in Authentication-Results by a receiver Relay trusts (Cloudflare's when deployed). An unverified sender still opens a conversation, but never joins a signed-in customer's contact.
- **Automatic mail** never counts as the customer's reply. Auto-replies and out-of-office messages are recognised by `Auto-Submitted`, `X-Autoreply`, `X-Autorespond`, `Precedence` and subject wording in several languages. Bounces are recognised by delivery-status reports, Exchange NDRs and qmail's plain-text failures. Each shows to teammates as an event in the thread ("An automatic reply arrived by email"; "A delivery problem was reported by email"), answers nothing, and an unthreaded one opens nothing.
- **Hard bounces suppress the address** (E1's suppression list, "Hard bounce"), so nothing is sent to it once E3 sends.

**HTML is made safe once, when it arrives** (`server/email-html.ts`):
- an allowlist of tags, attributes and style properties; scripts, styles, forms, frames and the like go with their content
- links only to http, https and mailto, opening in a new tab without referrer or opener
- inline images (`cid:`) become data URLs; remote images are kept as `data-remote-src`, so they don't load
- the inbox never renders raw email HTML

**The full email in the inbox** is shown in a sandboxed frame: no scripts, its own origin, and a policy that loads nothing remote. Remote images load only when a teammate clicks "Load images", after being told that loading them tells the sender the email was opened. Its colours are tokens (`--pg-email-paper`, `--pg-email-ink`).

**Attachments:**
- PNG, JPEG, PDF and plain text up to 10 MB are kept (100 an email at most). They're published to the conversation like a messenger upload, after the same scan, and stay held if the scan flags them.
- Others are listed on the full email as not kept, with why.

**Settings › Email** (Channels, for managers), per brand:
- the inbound address, with Copy
- the brand's own support address, and whether forwarding from it is confirmed. A forwarded message confirms it when the support address is in its To, Cc or Delivered-To.
- Gmail's forwarding confirmation, when it arrives, shown here to finish setup instead of opening a conversation
- how to set up forwarding in Gmail, Microsoft 365 and elsewhere
- "New inbound address", after a confirmation
- the latest 20 emails received and what became of each

**Elsewhere:**
- **The inbox:** an email shows its subject and "via Email".
- **Settings:** the suppression list and Office hours now list Email.
- **The timeline:** a conversation's first state reads "The conversation started", not "reopened".
- **Replies:** a teammate's reply on an email conversation is queued as a delivery. Until E3 it fails with "Replies can't be sent by email yet." (suppressed addresses still show as suppressed).

## How it works

**Migration `0063_email_in`:**
- `email_settings`: per brand, the token, support address, forwarding confirmation and Gmail's confirmation
- `email_inbound`: every email received, its raw bytes' key, and what became of it
- `email_messages`: the full email behind each part (full text, safe HTML, headers worth keeping, attachments)
- row-level security on all three, and the flag `channel_email_v1`
- **The rollback:** turns the flag off (inbound addresses refuse mail) and fails emails received but not yet read. Settings, conversations and their emails stay.

**Code:**
- **`server/email-in.ts`:**
  - the `email` adapter (no `send` until E3), `acceptEmail`, and `receiveEmailJob`
  - `readEmailMessage` (`GET email-message?part=`, for anyone who can read the conversation)
  - `readEmailSettings` and `changeEmailSettings` (`GET`/`POST email-settings`, for managers). A brand gets its token when the page is first read.
- **`server/email-read.ts`:** `readEmail` (parsing, kind, DMARC, bounces, text, HTML, attachments) and `threadKeys`.
- **`server/email-quotes.ts`:** `stripReply` and `baseSubject`. **`server/email-html.ts`:** `sanitizeEmailHtml` and `htmlText`.
- **`server/channels.ts`:**
  - adapters can carry their own flag (`enabledChannels`)
  - `receiveInbound` takes the subject fallback and returns the identity
  - a delivery on a channel without `send` fails without retrying
- **Storage:** `AttachmentStorage.putQuarantine` keeps raw email (25 MB) and attachments before they're read or scanned.
- **The Worker (`workers/relay.ts`):**
  - an `email` handler (`setReject` on refusal), and the `email.receive` job
  - `RELAY_INBOUND_DOMAIN`: the inbound domain
  - `RELAY_EMAIL_AUTHSERV`: the trusted authentication service, `mx.cloudflare.net` by default
- **Local relay:** `/dev/email`, the `emailFlag` and `exampleEmail` options, and seeding:
  - the default brand's address, `demo+support@inbound.relay.localhost`
  - with `npm run dev:relay`, two corpus emails (a Gmail reply and one with attachments)
- **UI:**
  - `agent/settings-email.tsx` (Settings › Email)
  - `agent/email-view.tsx` (the full email)
  - the timeline's subject, "Show the full email" and automatic-mail events

## Trying it locally

Run `npm run dev:relay`, then post any `.eml` file:

```bash
curl -X POST http://localhost:8788/dev/email -H "X-Envelope-To: demo+support@inbound.relay.localhost" -H "X-Envelope-From: me@example.com" --data-binary @tests/fixtures/email/08-outlook-html.eml
```

(8788 is the relay's API port; `RELAY_LOCAL_API_PORT` changes it.) Locally, the trusted receiver is `relay.localhost`, so the corpus's Cloudflare results show as unverified.

## Deploying (not done: needs you)

- Email Routing on the inbound domain, with a catch-all rule to the Worker.
- `RELAY_INBOUND_DOMAIN` set to that domain.
- The R2 bucket's lifecycle should expire `*/email/*` objects after a week, as a backstop: they're deleted once read.
- **A risk to check before going live:** Workers' `TextDecoder` may not decode every legacy character set. If one doesn't, that email's text is garbled and its full email still opens. The corpus runs on Node.

## Checks

- **`tests/email-corpus.test.ts`:** the 50-email corpus (`tests/fixtures/email`, made by `scripts/email-corpus.py`; synthetic, no real people's mail). Each email is checked against `expected.json` for:
  - what it is
  - sender, subject and Message-ID
  - the new text (and what must not survive)
  - whether it was stripped or forwarded, and whether it's verified
  - bounce recipients
  - attachments, inline and remote images, and the safe HTML
  - threading for replies

  The corpus covers Gmail, Outlook (desktop, web, iOS, Android, in German and French), Apple Mail, iPhone, Android, Samsung, Yahoo and Thunderbird replies; forwarded chains; eight character sets; five kinds of auto-reply; four kinds of bounce; signatures; attachments; inline images; hostile HTML; and quoted-printable. Broken mail is tested too: empty, headers only, a missing boundary, and no sender.
- **`tests/email-in.test.ts`:**
  - **Refusals:** addresses and the flags.
  - **Receiving:** a Gmail reply into an email conversation; the full email, hidden from another workspace; a repeat is ignored; threading by reference and by subject; auto-replies and bounces (the hard one suppressed).
  - **Attachments:** published after the scan; an inline image.
  - **Settings:** save, refusal of Relay's own domain, Gmail's confirmation, forwarding confirmed, a new address.
  - **Replies:** fail with "Replies can't be sent by email yet."
  - **The rollback.**
- **`tests/browser/email.spec.ts`** (ports 9038 and 9039):
  - **Happy path:** an HTML email becomes a conversation with its subject, "via Email" and no quoted history. The customer's reply threads, without its quote. The full email shows the unverified sender, one remote image blocked (then loaded), no script and the quoted history. In Settings › Email, the support address is saved and a forwarded email confirms forwarding.
  - **Failure path:** an out-of-office and a hard bounce stay internal events and open no conversation. The address shows as a hard bounce in the suppression list, and a reply to it is suppressed. Mail to an unknown address is refused, Relay's own domain is refused as a support address, and a new inbound address retires the old one.

## Not included

- **E3:** sending replies (the provider, the brand's domain with SPF, DKIM and DMARC, and threading headers on the way out).
- **E4:** email in the inbox (a rich composer, Cc, and Zoe on email).
- **Phase 01:** merging earlier contacts once an address is verified.
