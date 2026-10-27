# Phase 16, step C5a: data subject requests (export and deletion in PostgreSQL)

Branch `security/c5a-data-requests`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decisions 17 and 18). C5 was split, as asked: this is C5a. C5b covers the analytical store, embeddings, third-party processors, the backup window and the acceptance test over every store. The page is behind `security_v1`. One new dependency, `fflate` (pinned 0.8.3), builds the export zip.

## What it does

**Settings › Security › Data requests** (for who manages security):
- **Find a person** by email, phone number, external ID or contact ID. The page shows their name, addresses, how many conversations they started, how many others they took part in, and any merged records.
- **Export their data:** a zip with `person.json` and their files, made in the background.
  - **`person.json` holds:** their profile and attributes, emails, phones, channel addresses, subscriptions, events, every conversation they started with its customer-visible messages, their messages in others' conversations, their tickets, and a list of their files.
  - **Left out:** internal notes and Zoe's internal records.
  - **Files:** those they sent and those sent to them, up to 50 MB in all. Any beyond are listed by name.
  - **Download:** for seven days, after which the sweep deletes the zip and the request forgets who it was for.
- **Delete everything about them,** after typing their email address (or the word "delete"). This happens in the background. When it's done:
  - **Their records are deleted:** the contact, any contacts merged into it, their identities, every conversation they started (messages, files, tickets, emails, calls, Zoe's answers and reviews, workflow runs), and their own messages and addresses in conversations someone else started.
  - **So is what was kept about them:** opt-outs and consents, raw inbound payloads, webhook payloads, queued jobs, and their earlier exports.
  - **Their files** are deleted from storage.
  - **Records others rely on keep their counts, stripped of them:** Zoe's resolution ledger (billing counts it), the connector call log and the audit log.
  - **A deletion certificate** can be downloaded (JSON, signed), and the request keeps nothing about them.
- **The requests list** shows each request's kind, who it's about (until it's done or expires), who asked, its status, and the download for an export or a certificate.
- **In the audit log** by request ID only: an export asked for, made and downloaded, and a deletion asked for and done.

## How it works

**`server/erasure.ts`: the documented cascade.**
- **`ERASURE`** is an ordered list of statements, children before parents as the foreign keys require. Each deletes (or, for ledgers, scrubs) by the person's contacts, identities, conversations, addresses, their own messages in others' conversations, or text that names them.
- **`NO_PERSONAL_DATA`** names every other table, with why: workspace settings, teammates' own data, or counts.
- **The rule is tested:** a table in neither list fails `tests/erasure.test.ts`.
- **Who the person is** (`findSubject`):
  - **Their records:** the contact and every contact merged with it; their identities; the conversations they're the customer in.
  - **Others' conversations:** the ones they only took part in, and their own messages there.
  - **What names them:** their addresses (emails, phones, channel addresses) and external IDs.
  - **Text matching:** payloads, job data and similar fields are searched for their addresses, external IDs and contact, identity, conversation and message IDs, escaped for LIKE.
- **One transaction:** `erase` runs the whole cascade in a single transaction with `relay.erasure` set, so a person is wholly erased from PostgreSQL or not at all. Each statement gets only the parameters it uses, and it returns rows per table for the certificate.

**Append-only records** (migration 0087), during a deletion only:
- **Rows that may be deleted:** messages, delivery events, snapshots, subscription changes, contact changes, job events and workflow run steps.
- **Rows that may only be scrubbed:**
  - **Zoe's resolution ledger:** only its conversation link, detail and ID lists may be cleared; its kind, agent, rule, window and time must stay.
  - **The connector call log:** only its conversation, inputs, outputs, error and idempotency key may be cleared; the address keeps only its host.
  - **The audit log:** only its target and details may be cleared; who acted, what and when must stay.
- **Anything else is refused,** and outside a deletion every change is refused, as before (tested).

**`server/data-requests.ts`:**
- **`readDataRequests` and `changeDataRequests`:** find, export, delete (with the confirmation), and download (a signed link).
- **`dataExportJob` (`dsr.export`):** the zip.
- **`dataDeleteJob` (`dsr.delete`):** the steps in order:
  1. **The transaction:** the cascade, with the storage keys kept on the request.
  2. **The files:** deleted, safe to retry.
  3. **The certificate:** signed, and the request cleared.
- **The certificate:** the request ID, the workspace, when it was asked and done, rows per table and files removed, and a SHA-256 digest of the identifiers erased, never the identifiers themselves.
  - **Signature:** HMAC-SHA-256 over its canonical JSON, with a key derived from the connector key (`signCertificate`). `verifyCertificate` confirms Relay issued it, unchanged.
  - **Not yet covered:** it names what C5b adds (`notYetCovered`).
- **`expireDataExports`** runs from the sweep.

**Wiring:**
- **The API:** the agent route `data-requests` (GET and POST, `security.manage`).
- **Jobs:** `dsr.export` and `dsr.delete`, registered on Workers and in the local relay.
- **The sweep** expires exports.
- **The page:** `agent/settings-data-requests.tsx` (`#settings/data-requests`). It checks again every few seconds while a request is working.

**Migration `0087_data_requests`:**
- **New:** `data_requests` (under row-level security).
- **Changed:** `ai_resolutions.conversation_id` becomes nullable, and the append-only trigger functions are taught the exceptions above.
- **Its rollback** puts the triggers back to refusing everything and marks running requests failed. Scrubbed rows can't be restored.

**Seed data:** none. Find any local customer in Settings › Data requests.

**Not in C5a (C5b):**
- **Other stores:** the analytical store and embeddings.
- **Third-party processors:** Twilio's call recordings and email and messaging providers. The list, with what's sent to each, comes in C5b.
- **The backup window.**
- **The acceptance test over every store.**

**Not planned:** a REST API for requests, unless asked.

## Checks

- **`tests/erasure.test.ts`:**
  - **The catalog:** every table in the schema is in the cascade or says why it holds no one's data, never both, and nothing that isn't there.
  - **The acceptance test:**
    - **Seeded, through Relay's own code** (`getIdentity`, `command`, `recordEvent`, `recordContactView`): Ada has two conversations (a reply, an internal note), a message in Bob's conversation, a phone, an event and an audit row.
    - **Seeded directly:** a file and a raw email in storage, a copy on Bob's email, a suppression, a raw SMS payload, a resolution-ledger row and a webhook payload.
    - **Finding her:** only for who manages security; by email (any case), phone, external ID or contact ID; nobody found otherwise; not across workspaces.
    - **The export:** two conversations, three messages and one file, and the internal note left out. The zip's file is hers, and the link is signed.
    - **The deletion:** a wrong confirmation is refused, her email (any case) is accepted, and the job runs.
    - **The certificate** verifies, but not once changed or with another key. It counts her conversations and files, and names nobody.
    - **Storage:** her raw email and file are gone.
    - **Every column of every table in workspace a,** searched for her email, phone, external ID, name, a marker in her messages, and her contact, identity and conversation IDs: nothing is found.
    - **What stays:** the ledger row (no conversation, no detail) and the audit row about her (no target).
    - **Bob:** his conversation keeps his message, loses hers, and drops her from the email's copy list.
    - **Workspace b's** record of the same person is untouched.
    - **The audit log** has the five request actions by ID.
    - **Her earlier export** went with her.
    - **Append-only** still refuses changes outside a deletion.
    - **Exports expire,** and the request forgets them.
    - **Rollback.**
- **`tests/browser/data-requests.spec.ts`:**
  - **Happy path:**
    - **Export:** a manager finds Ada and exports her; the zip downloads with her messages.
    - **Delete:** the manager deletes her with her email typed. The request shows "Deleted person", her export is no longer downloadable, the certificate downloads (signed, naming nobody), and she can't be found again.
  - **Failure path:** a wrong confirmation is refused and Bob is still there. Grace (an agent) doesn't see the page, and the API answers 403.
- **`tests/permissions-matrix.test.ts`** covers `data-requests`. **`tests/ai-resolutions.test.ts`** and **`tests/audit.test.ts`** pass with the triggers' exceptions.
