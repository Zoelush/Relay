# Phase 16, step C5b: deletion beyond PostgreSQL

Branch `security/c5b-other-stores`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decisions 19 and 20). This finishes C5, which C5a (`docs/SECURITY_STEP7.md`) began with the request workflow and PostgreSQL. A deletion now reaches every store Relay keeps, Twilio, and the backup window, and the certificate says so. No new dependency.

## What it does

**A deletion now reaches:**
- **The analytical store** (reports). As agreed, past reports keep their counts and lose the person:
  - **New IDs:** each of their conversations takes a new random ID everywhere in the store at once, so a report's joins still hold.
  - **Unlinked:** their contact IDs are replaced the same way, their profile snapshots and profile history are emptied, and their messages lose their author.
  - **The result:** response times, volumes, SLA results and Zoe's resolutions are unchanged, and nothing leads back to them.
- **Twilio:** their call recordings (including voicemails) and text message records are deleted through Twilio's API.
  - **Already gone** counts as deleted.
  - **When Twilio refuses one for good** (a 4xx other than 404), the refusal is recorded in the certificate and on the request, and the deletion still finishes.
  - **Passing failures** are retried with the job.
- **Embeddings:** nothing to delete. Relay embeds only knowledge content (articles, synced pages, files), and the vector store holds only those chunks' numbers, never text. Zoe's memory of earlier conversations reads PostgreSQL. The certificate states this.
- **Backups:** PostgreSQL's point-in-time history keeps a deleted person until its window passes, and the certificate gives that date.
  - **The window** is `RELAY_BACKUP_DAYS`, 7 days by default; Neon's history retention must be set no longer.
  - **Until Neon is provisioned,** this document is where the window is recorded.

**Where customer data goes** (Settings › Security › Data requests, and every certificate): every service outside Relay that receives customer data. Each entry says what it receives, when, how long it keeps it, and what a deletion does there.

| Service | Receives | On deletion |
|---|---|---|
| Twilio | Texts sent and received; calls and their recordings | Deleted by Relay |
| Anthropic (Claude) | Messages Zoe answers (redacted when the setting is on) | Kept by the provider under its API data retention terms |
| Cloudflare Workers AI | Knowledge to embed, customers' questions to search it with, call audio to transcribe | Not kept |
| Amazon SES | Emails Relay sends | Kept by the provider (sending and delivery events) |
| Meta | WhatsApp, Instagram and Messenger messages | Kept by the provider; messages stay in the customer's own app |
| Slack and Discord | Messages in the workspace's community spaces | The workspace's own destination |
| The workspace's webhooks | Event payloads | The workspace's own destination |
| Data connectors and apps | Declared inputs, and what apps read through the API | The workspace's own destination |
| Cloudflare and Neon (hosting) | Everything Relay stores | Deleted by Relay, with backups clear by the window's date |

**The certificate now has:**
- **`stores`:** `postgresql`, `files`, `analyticalStore` (rows unlinked per table), `embeddings`, and `twilio` (recordings and messages deleted, and any refusals).
- **`processors`:** the list above, with each entry's deletion kind.
- **`backups`:** the window and its `clearBy` date.
- **`notYetCovered`** is gone.

## How it works

**`server/erasure-analytics.ts`:**
- **The catalog:** `ANALYTICS_ERASURE` (12 tables) and `ANALYTICS_NO_PERSONAL_DATA` (searches, feedback, outbound counts, teammates, office hours and bookkeeping, each with why). A test holds them to `db/analytics`'s schema.
- **`eraseAnalytics`** runs them in one transaction on the analytical store, from the IDs the deletion kept. Run again, it finds nothing left to change.

**The deletion job** (`dataDeleteJob`) now runs in stages. Each stage's result is kept on the request as it finishes, so a retry carries on where it stopped:
1. **PostgreSQL,** in one transaction. Before the rows go, it keeps what the later stages need: storage keys, the analytical store's IDs, and Twilio's recording and message IDs (from `voice_calls`, `voice_inbound`, `channel_deliveries` and `channel_messages`).
2. **Files.**
3. **The analytical store.**
4. **Twilio,** with the workspace's account.
5. **The certificate.**

The kept IDs are cleared when the request finishes.

**The Twilio port** gains `deleteRecording` and `deleteMessage` (HTTP DELETE; a 404 counts as done). The local stand-in records what it was asked to delete.

**`lib/processors.ts`** is the one processor registry, shown on the page and copied into certificates. A new outside service that receives customer data gets its entry.

**Wiring:**
- **Workers:** pass the analytical store, the Twilio client and `RELAY_BACKUP_DAYS` to `dsr.delete`.
- **The local relay:** passes its analytical store and its Twilio stand-in.

**Migration:** none; C5a's `data_requests.pending_objects` holds the new stages' state.

**Seed data:** none.

## Checks

- **`tests/erasure.test.ts`:**
  - **The analytical store's catalog** covers every table, once.
  - **Only the knowledge index writes vectors** (a test reads every module that could).
  - **The acceptance test, extended to every store:**
    - **Seed:** her conversations are projected into the analytical store, and Twilio holds an SMS record and a call recording.
    - **After the deletion:**
      - **The certificate** covers every store (the analytical store unlinked, embeddings none, Twilio one recording and one message), lists every processor, and gives the backup date seven days on.
      - **Twilio's stand-in** was asked to delete both.
      - **The analytical store** has the same number of conversations, and no column of any of its tables holds her email, phone, external ID, name, or contact, identity or conversation IDs.
    - **Everything C5a checked** still holds.
  - **Twilio's answers:**
    - **Through the real client** with a stub `fetch`: 204 and 404 count as deleted; a 403 is a refusal; a 503 is retried.
    - **Through a deletion:** a refused text is recorded in the certificate and on the request, which still finishes.
- **`tests/browser/data-requests.spec.ts`:** the page lists where customer data goes (Twilio deleted by Relay; Anthropic kept under its terms). The downloaded certificate covers the analytical store and embeddings, lists the processors and gives the backup window.
