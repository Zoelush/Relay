# Phase 12, step E6: SMS

Branch `omnichannel/e6-sms`. Plan: `docs/OMNICHANNEL_PLAN.md`. Behind `channel_sms_v1` (and `channels_v1`), both off by default and on for the local relay. Next: E7, Instagram and Facebook Messenger.

## What it does

SMS is a channel (E1's contract) through Twilio, with each workspace's own account.

**The account and numbers** (Settings › SMS, for managers):
- **The account:** its Account SID and auth token. The token is sealed with `RELAY_CONNECTOR_KEY` and never shown again (only its last four characters). A job checks the account with Twilio: Connected (with its name), or Not connected with Twilio's reason.
- **Numbers per country:**
  - each brand's numbers in the account, each with its calling code (+44, +1, +234)
  - adding one finds it in the account and points its incoming texts at `/v1/hooks/sms/<workspace>/message`, or says why not ("That number isn't in the Twilio account.")
  - a reply goes from the brand's number with the customer's calling code, else its default (the first, or the one marked), else any
  - numbers can be removed
- **What a text costs:** per segment, by calling code, for the composer's estimate. Where none is set, a rough figure in US dollars is used and labelled an estimate. Twilio's invoice is the bill.
- **The reply to HELP:** it must say how to opt out, because carriers require it.

**The webhook:**
- **Checking:** Twilio's calls are checked against `X-Twilio-Signature` (HMAC-SHA1 with the auth token over the exact URL and the sorted form) and the account SID. Anything else is refused, with nothing kept.
- **Answering:** signed calls are kept, then read by the `sms.receive` job. Twilio is answered with empty TwiML, because replies go out through the delivery job, never in the webhook's answer.

**Texts in:**
- **A text** becomes the customer's message, threaded by number within 7 days.
- **The number is unverified:** anyone can claim one by text, so it never joins a contact by itself.
- **MMS** images and documents are downloaded with the account's credentials (only from Twilio), scanned, and published.

**Texts out** (through the delivery job and its gate):
- **What goes:** plain text. A workflow's options are written out ("1) Track 2) Return").
- **Status:** delivered, or not delivered with Twilio's error code, comes back by the status callback.
- **What doesn't go:** files ("Files can't be texted: send a link instead.") and anything over 10 segments.
- **Twilio's own opt-out list:** error 21610 (the number replied STOP to Twilio) suppresses the number too.

**Segments and cost in the composer** (`lib/sms.ts`, shared with the server):
- **The reply line:** "Sent by SMS from +447700900100 to +447700900456".
- **The meter, as you type:** "1 segment (22/70, Unicode) · about 0.0524 USD". It says when a text is too long: "11 segments · too long: 10 at most".
- **How segments are counted:**
  - GSM-7: 160 characters in one segment, 153 each when there are several; its extension characters (€ [ ] { } ~ ^ | \) count twice
  - anything else is Unicode (UCS-2): 70 in one, 67 each, in UTF-16 units, so an emoji counts twice

**Keywords:**
- **STOP and the local equivalents** (STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, ARRÊT, STOPP, BASTA, PARAR, BAJA, AFMELDEN, CANCELAR and others) opt the number out. That's a suppression record (an opt-out) kept for good: lifting it is recorded, never erased. Nothing is texted to the number.
- **When a teammate replies to an opted-out number,** the reply is refused at once ("This number opted out (STOP): nothing can be texted to it until it texts START."). A reply from Zoe or a workflow is held by the gate.
- **A teammate can't record consent** over an opt-out.
- **START (or UNSTOP)** lifts it and records consent.
- **HELP (or INFO, AIDE, HILFE, AYUDA)** is answered with the brand's HELP reply, delivered like any reply.

**Consent:** a number is texted only when it texted first, or a teammate recorded consent given elsewhere (with where), or it sent START. Without it, a teammate's reply is refused at once ("This number hasn't agreed to texts: record their consent first."). Settings lists the numbers that agreed and how.

**Zoe doesn't text:** her capability is off on SMS, because anyone can claim a number and every segment costs.

## How it works

**Migration `0067_sms`:**
- `sms_accounts`: SID, sealed token, status, HELP reply
- `sms_numbers`: phone, calling code, Twilio's SID, default, status
- `sms_consents`: one active per number
- `sms_prices`: per calling code
- `sms_inbound`: each signed call until it's read
- row-level security, and the flag
- **The rollback:** the flag goes off (the webhook refuses), and unsent texts and unread calls fail. The account, numbers, consents, prices and the suppression list (opt-outs included) stay.

**SMS:**
- **`server/sms.ts`:**
  - the adapter (`refuses`: files, opt-out, consent; `prepare`: the number by country, the 10-segment limit; `send`; `replyDetails`: the from number, the limit, the price)
  - the webhook's check (`twilioSignature`, `receiveSmsWebhook`)
  - the jobs: `sms.receive` (keywords first), `sms.check` and `sms.number`
  - Settings' read and actions: `connect`, `number`, `remove`, `price`, `help`, `consent`
- **`server/sms-api.ts`:** the `SmsApi` port and Twilio's REST API. 4xx is `SmsRejected` (not retried); 429 and outages are retried. Media is fetched only from `api.twilio.com`.
- **`lib/sms.ts`:** `segmentsOf`, `callingCode`, `DEFAULT_PRICES` and `MAX_SEGMENTS`.

**Elsewhere:**
- **Routes:**
  - `POST /v1/hooks/sms/<workspace>/<message|status>`: the form is read as text and checked over the exact URL, at most 100 KB
  - `GET` and `POST sms-settings`
- **The Worker:** the jobs, `twilioApi()`, and the delivery job's SMS environment (status callbacks to `PUBLIC_ORIGIN`).
- **Local relay:**
  - the stand-in (`scripts/local-sms.ts`: Twilio in memory, and calls signed as Twilio signs them)
  - the jobs
  - `POST /dev/sms` (`{from, text}`): a customer's text to the demo's UK number, through the signed route
  - the seed: the demo's account and the default brand's UK number, connected
- **UI:**
  - `agent/settings-sms.tsx`
  - the composer's reply line and `SmsMeter` (`agent/reply-target.tsx`)
  - the label "SMS"

## Trying it locally

Run `npm run dev:relay`, then text yourself (8788 is the API port):

```bash
curl -X POST http://localhost:8788/dev/sms -H "content-type: application/json" -d '{"from":"+447700900456","text":"Hi, is my order on its way?"}'
```

## Deploying (not done: needs you)

- **A Twilio account** with SMS-capable numbers in the countries you text (and, for the US, A2P 10DLC registration or a toll-free number's verification).
- **Settings › SMS:** the Account SID and auth token. Then each number is added, which points its incoming texts at Relay's public HTTPS address.
- **`RELAY_CONNECTOR_KEY`** (it seals the token) and **`PUBLIC_ORIGIN`** (status callbacks go there).

## Checks

- **`tests/sms.test.ts`:**
  - **Segments:** GSM-7, extension characters, UCS-2 and emoji, and the boundaries at 160/161, 306/307 and 70/71. Calling codes too.
  - **The account:** sealed and checked; a bad token fails with Twilio's reason; another workspace's is its own.
  - **Numbers:** added and pointed at Relay; one not in the account fails with why; a duplicate is refused.
  - **The webhook:** answered with TwiML. Another token's signature, another account's SID or another workspace is refused, with nothing kept.
  - **A text in:** unverified, with consent, threaded.
  - **Replies:** from the number in the customer's country (UK and US), with the price an estimate until one is set. Status callbacks move it forward or say why.
  - **Limits:** 11 segments refused; files refused; options written out.
  - **MMS:** scanned and published.
  - **Keywords:** HELP answered (its reply must mention STOP). STOP in French refuses the next reply at once, the gate holds an automated one, consent can't be recorded over it, and START lifts it with the record kept. Twilio's 21610 suppresses.
  - **Consent:** withdrawn, so a reply is refused at once, then recorded.
  - **The rollback.**
- **`tests/browser/sms.spec.ts`** (ports 9046 and 9047):
  - **Happy path:** a text becomes a conversation via SMS. The composer shows the from and to numbers, and the meter (GSM-7 with the cost, then Unicode with an emoji). The reply is texted and shown "Delivered". Settings shows the account, the number and the customer's consent.
  - **Failure path:** STOP shows as "Opted out". The meter says 1,600 characters is too long. The next reply is refused with the reason and nothing is sent. A number not in the account fails with why.

## Not included

- **Buying numbers from Relay** (searching and provisioning in Twilio): numbers are bought in Twilio's console and added here.
- **US A2P 10DLC brand and campaign registration,** which is done in Twilio.
- **Outbound campaigns and subscription types:** phase 13.
- **Quiet hours for texts:** phase 13, with outbound.
