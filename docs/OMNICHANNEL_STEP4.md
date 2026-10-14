# Phase 12, step E4: Email in the inbox

Branch `omnichannel/e4-email-inbox`. Plan: `docs/OMNICHANNEL_PLAN.md`. Behind `channel_email_v1` (and `channels_v1`), both off by default and on for the local relay. With E1 to E4, email is complete; next are the other channels (E5 to E9).

## What it does

**The email view in the timeline:**
- **Recipients:** each email shows its subject and who it was to and copied to ("To help@acme.example · Cc lee@customer.example"). A reply that copied people in shows its Cc and Bcc.
- **Quoted history and blocked images:** as in E2, they're behind "Show the full email". It now works for side-conversation emails too.

**Cc and Bcc on replies:**
- **The composer:** on an email conversation, the composer has its own line, "Emailed to robin@… · Re: …", with a "Cc / Bcc" control.
- **Reply all:** Cc starts as whoever the customer's last email copied in (its Cc, never its To, which is the brand's own address). The brand's addresses and Relay's are left out.
- **The rules:**
  - each copy passes the same suppression list as the main address (a suppressed one is left out)
  - Bcc is never written into the message
  - up to ten addresses each
  - a channel that can't copy (the messenger) refuses them (`capabilities.copies`)

**Side conversations:** an email thread with someone other than the customer (a supplier, another department), attached to a conversation.
- **Starting one:** "Side conversation" in the composer opens a dialog (To, Subject, Message). The count of existing ones shows on the button.
- **In the timeline:** its messages show there for the team only ("Side conversation · Grace to orders@supplier.example · Team only"). They're internal parts (`system_event` of `side_conversation`), so they inherit the conversation's assignment, team and history. The customer is never sent or shown them.
- **Answers:** they come back to the side conversation's own reply address (`<workspace>+s-<token>@<inbound domain>`), or by In-Reply-To to one of its messages at the brand's address. They post into the same timeline, and a teammate replies under any message ("Reply in the side conversation").
- **What goes out:** an email to the third party is only what the teammate wrote, never the customer's messages.
- **Files and contacts:** files in side-conversation emails aren't kept (listed on the full email with why), and no contact or conversation is made for the third party.

**Workflows:**
- **"A customer emails"** (trigger): every email from a customer, new or in a conversation. Automatic replies and bounces don't fire it.
- **"Send an email"** (step): a subject and text to the customer's email address, whatever channel the conversation is on. On an email conversation, it's the reply. On a messenger conversation, it's emailed as well as shown in the conversation. It's skipped, and says why in the run log, when the customer has no email address. The step is customer-facing (Zoe waits for it, as for other customer steps).

**Zoe on email** (Zoe › Settings › Email):
- **Off, the default:** email goes to the team.
- **Draft replies for a teammate to approve:** her reply is written to the conversation, and its delivery is held ("Waiting for a teammate's approval"). A teammate presses "Send it", or "Discard", which hands the conversation to the team.
- **Answer email:** her answers are sent as she writes them, as in the messenger.
- **Whom she never answers:** a sender their domain didn't confirm (DMARC), and list mail (List-Id or List-Unsubscribe). The adapter decides (`aiAnswers`), so this holds whatever the setting.

**Monitor incident alerts by email** (Zoe › Monitors › Email alerts):
- **Where they go:** up to five addresses each new incident is emailed to, as well as the app's notification.
- **How:** from Relay's own address (`no-reply@<sending domain>`), once per incident and address, past the suppression list.

## How it works

**Migration `0065_email_inbox`:**
- **On `ai_agents`:** `email_mode` (off, approve, answer) and `incident_emails` (at most five).
- **On `channel_deliveries`:** the `held` status and `side` purpose (the checks are widened), and `decided_by` and `decided_at`.
- **New tables:**
  - `side_conversations`: subject, participants and reply token
  - `side_messages`: each message out and in, with its Message-ID
  - `email_alerts`: one per incident and address, with its status
- **Row-level security** on the new tables.
- **The rollback:**
  - Zoe's email mode goes off
  - held drafts and side conversations' unsent messages fail
  - queued alerts fail
  - live workflows that use the email trigger or step are paused (E3's code refuses them)

  Side conversations and the widened checks stay.

**The contract (`server/channels.ts`):**
- **New hooks:** an adapter can have `aiAnswers` (whether Zoe answers this message) and `holdsAi` (whether her replies wait for approval). `queueAiReply` and the reply job's skip check ask them.
- **`queueDeliveryTo`:** a delivery to a named address, used by side conversations and the email step. It still goes through the job and the gate.
- **`decideHeld`:** `POST delivery`, send or discard, for those who can reply.
- **`readDeliveries`** returns each delivery's id and purpose. **`readReplyTarget`** says whether the channel takes copies, and email's suggested Cc.

**Email:**
- **`server/email-side.ts`:** `POST side-conversation` (start, reply), `GET side-conversations?conversation=`, and `sideFor` and `receiveSideMail` for mail that answers one.
- **`server/email-out.ts`:**
  - `prepare` handles copies and side messages
  - `copiesOf` normalises addresses
  - `customerEmail` is shared with the workflow step
  - `sendAlert` is the `email.alert` job, the one other place the provider is called; it checks the suppression list itself
- **`server/email-in.ts`:** the adapter's new capabilities and hooks, the `s-` addresses, side mail routing, and recipients and list mail recorded on the part.
- **`server/email-mime.ts`** writes Cc. **`server/email-providers.ts`** sends to Cc and Bcc.

**Elsewhere:**
- **The reply command:** takes `email: {cc, bcc}` from a teammate where the channel can copy.
- **Workflows:**
  - the `email_received` trigger in `lib/workflow-definition.ts` (no longer a later trigger) and the engine
  - the `email` step in the definition, engine, simulation and builder
- **Zoe:** her settings (`emailMode`, and `email` when it's on) and the monitors' `alerts` action. `notify` is exported for tests.
- **UI:**
  - `agent/reply-target.tsx` (the reply line and Cc/Bcc)
  - `agent/side-conversations.tsx`: the button and dialog (portalled to the app's root, since the composer is a form) and the inline reply
  - the timeline: recipients, held drafts' buttons, and side-conversation messages
  - `EmailCard` on Zoe's settings, and the email alerts card on Monitors

## Checks

- **`tests/email-inbox.test.ts`:**
  - **Copies:** the customer's Cc is offered again. Cc and Bcc are sent, with Bcc never in the message and a suppressed copy left out. Bad copies are refused, and the messenger refuses copies.
  - **Side conversations:**
    - started, with its own reply address and nothing of the customer's in it
    - answers come in by that address and by In-Reply-To, as internal parts, with no new conversation
    - a reply in it threads
    - the list works, and is hidden from another workspace
    - the customer is sent nothing
  - **Workflows:** the trigger fires for email only, not for automatic mail or the messenger. The step emails a messenger customer. Its subject is checked.
  - **Zoe:**
    - off by default
    - answering: queued for a verified sender, not an unverified one or list mail
    - drafts: held, not sendable from another workspace, sent, not decided twice, or discarded (handed to the team)
    - an invalid mode is refused
  - **Alerts:** at most five addresses. They're sent, suppressed past the list, and once per incident.
  - **The rollback.**
- **`tests/email-out.test.ts`:** the provider is called in two places, both in `server/email-out.ts`. The alert job checks the suppression list before it calls the provider.
- **`tests/browser/email-inbox.spec.ts`** (ports 9042 and 9043):
  - **Happy path:** the recipients line, Cc pre-filled and Bcc added, both sent and shown. A side conversation is started from the dialog and shown team only, the supplier's answer arrives, and the reply in it threads. The customer was sent only their reply.
  - **Failure path:** Zoe's drafting is set in her settings. Her draft is held, then discarded: nothing is sent and the team has the conversation. A side conversation to an invalid address is refused with the reason.
- **Updated:** `tests/email-in.test.ts` (recipients and list mail on the part).

## Not included

- **E5 to E9:** the other channels.
- **Phase 12, still open:** content-based spam and phishing filtering on email (`TODO(phase 12)` in `server/ai-agent.ts`). Zoe already never answers unverified senders or list mail.
- **Phase 13:** subscription types and unsubscribe links.
