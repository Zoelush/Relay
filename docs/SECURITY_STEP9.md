# Phase 16, step C6a: retention policies

Branch `security/c6a-retention`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decisions 21 and 22). C6 was split, as asked: this is C6a. C6b covers content redaction rules, personal data in logs and error reports, and model-provider controls. The page is behind `security_v1`. No new dependency.

## What it does

**Settings › Security › Retention** (for who manages security) sets how long Relay keeps each kind of data. Each policy is "Keep" (the default: never deleted by age) or 30 days, 90 days, 6 months, 1, 2, 3 or 7 years.

| Kind | What a run deletes |
|---|---|
| Conversations | Closed conversations not touched for the period, with their messages, files and tickets (C5's cascade). Their Twilio records go too. Reports keep their counts, and the customer's contact record stays. Open and snoozed conversations are never deleted. |
| Attachments | Files older than the period. The message stays; opening the file says it was deleted under the workspace's retention policy. |
| Call recordings | Recordings (and voicemails) older than the period, here and at Twilio. Transcripts stay. |
| Events | Events recorded about contacts, older than the period. |
| Logs | Records of model calls (never kept beyond 90 days anyway), connector calls, webhook deliveries and their attempts, processed incoming payloads (email, SMS, WhatsApp, Meta, Slack/Discord, voice, and the raw files of emails that failed to read), email events, finished workflow runs, finished background work, and published outbox entries. The audit log keeps its own retention. |

**Before saving,** the page shows how much the new periods would delete on the next run (for example "Conversations: 1"), with a warning that it can't be undone.

**Relay applies the policies** about once an hour. "Run now" applies them at once. The page shows the last run and what it deleted, and each run is in the audit log with its counts. Changing a policy is in the audit log too.

A customer's whole record (contact, identities and everything else) is deleted only by a data request (C5).

**Raw emails, a correction to the C6 question:** Relay already deletes an email's raw file once it has read it. Only emails that failed to be read keep theirs. Those raw files go with the logs policy here. C6b's choice to delete raw emails once read, while a redaction rule is on, is therefore already how it works.

## How it works

**`server/retention.ts`:**
- **`RETENTION`:** the kinds, their wording, and the periods.
- **`readRetention` and `changeRetention`:** `policies`, `preview` (bounded counts of what the next run would delete) and `run`.
- **`scheduleRetention`,** from the sweep: queues `retention.apply` at most hourly, for a workspace with a policy or an unfinished run, one at a time.
- **`retentionJob`** applies the policies in bounded batches (200 conversations, 1,000 rows per kind), so a backlog clears over several runs:
  - **Conversations:** `erase` with only those conversations, so the same documented cascade as a data request. Then `outsideStores` (shared with C5's deletion) removes their files, rekeys their report rows and deletes their Twilio records. What those later stages need is kept in `retention_settings.pending` until they're done, so a run that fails partway finishes on the next.
  - **Attachments and recordings:** storage deleted, then the record marked `expired`.
  - **Twilio's recording copies:** for calls (`voice_calls.recording_sid`) and voicemails (`voice_inbound`'s `RecordingSid`), deleted and then forgotten, so they aren't asked about again.
  - **Events and logs:** deleted in the run's own transaction with `relay.retention` set.

**Append-only logs** (migration 0088) accept a retention deletion only while `relay.retention` is set, which only the job does:
- **Rows that may be deleted:** messages and delivery events (with a conversation), workflow run steps, job events, and the connector call log.
- **Not among them:** the audit log.
- **Outside a run,** they still refuse.

**Downloads:** an expired file answers 410, "This file was deleted under the workspace's retention policy."

**Wiring:**
- **The API:** the agent route `retention` (GET and POST, `security.manage`).
- **The job:** `retention.apply`, on Workers and in the local relay.
- **The sweep:** calls `scheduleRetention`.
- **The page:** `agent/settings-retention.tsx` (`#settings/retention`).

**Migration `0088_retention`:**
- **New:** `retention_settings`, with an audit trigger on the policies.
- **Changed:** attachments gain the `expired` state, and the append-only trigger functions accept `relay.retention`.
- **Its rollback** sets every policy back to keep and removes the triggers' retention exception. Files already expired stay expired.

**Seed data:** none. Every policy is keep by default.

## Checks

- **`tests/retention.test.ts`:**
  - **The page:** for who manages security, not across workspaces.
  - **Periods:** below 30 days or above 7 years are refused.
  - **The preview:** counts what a change would delete. Policies are keep by default.
  - **Outside a run:** append-only rows refuse deletion.
  - **The sweep:** queues one run, not two, and not again within the hour.
  - **A run at 90 days:**
    - **Conversations:** the closed conversation untouched for 100 days goes, with its messages and file. The recent closed one and an old open one stay. The contact stays. Reports keep the same count, without the old conversation's ID.
    - **Files:** an old file is deleted and marked expired; a new one stays. An old recording is expired, and Twilio was asked to delete it (then forgotten).
    - **Events and logs:** old events and model calls go and new ones stay. An unprocessed payload stays.
  - **Recorded:** in the audit log with its counts, and on the page.
  - **A second run** finds nothing.
  - **Another workspace's** old conversation is untouched.
  - **Rollback.**
- **`tests/browser/retention.spec.ts`:**
  - **Happy path:** conversations set to 30 days warns "Conversations: 1" before saving. Saved and run now, the old closed conversation is gone, the recent one stays, and the last run lists it.
  - **Failure path:** 7 days is refused by the API with the reason. An agent doesn't see the page, and the API answers 403.
- **`tests/permissions-matrix.test.ts`** covers `retention`. **`tests/erasure.test.ts`** passes, with `retention_settings` listed as holding no one's data.
