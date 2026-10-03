# Phase 07, step C2b: content health

Branch `knowledge/c2b-content-health`. Plan: `docs/KNOWLEDGE_PLAN.md` (decision 7). Approved on 3 October 2026 ("Yes, go ahead with all four"):
1. **"Not retrieved in 90 days" counts from the first AI index.** A record is listed only once it has been usable for 90 days of counting, and the report says when counting started.
2. **Near-duplicates are found from stored vectors,** a job that can resume, nightly and on demand, at a cosine similarity of 0.92 or more. Results and dismissals are kept in PostgreSQL. A dismissed pair returns only if either record publishes a change.
3. **Access:** the report is for `knowledge.manage`, behind a new `knowledge_health_v1` flag that is off by default and on for the local relay. The duplicate section also needs the AI index.
4. **"Never reviewed" means exactly that:** no "overdue for review" list.

This is the last step of the phase 07 plan.

## What it does

A **Content health** page in Knowledge's side menu, also linked from Settings › Knowledge & AI. It opens with three counts, then four sections.

**Never reviewed:**
- published records nobody has marked reviewed, oldest first, each with its kind, owner and publish date
- **Mark reviewed** (the existing review action), and each title opens the record

**Not retrieved in 90 days:**
- **What's listed:** published records the AI agent or the inbox can use (switched on for either) that no search returned in 90 days. Never retrieved come first, then by last retrieval.
- **When counting started:** "Retrievals counted since 3 October 2026", and until a record can have gone 90 days, the date the first can appear (1 January 2027 for content indexed today).
- **Not listed:** content switched off for both is never listed, because nothing could retrieve it.

**Near-duplicates:**
- **The pairs:** pairs of different records with passages 92% or more alike, best first, each with its similarity and both records' kinds.
- **Check now** starts a check and shows its progress ("Checking… 40 of 120 passages"), then "Last checked …".
  - If a check is running, Check now joins it.
  - A failed or stopped check says why.
- **Not duplicates** hides a pair until either record publishes a change.
- **While checking:** the previous check's pairs stay visible until the new one finishes.
- **With the AI index off,** or not yet built, the section says so and offers no check.

**Topics with no content:** "arrive with reporting" (phase 14).

## How the check works

`server/knowledge-health.ts`, job `knowledge.duplicates`:
- **The run:** a check is a run over the active index version's passages, in chunk-id order.
  - **Each step:** 50 passages. Each passage's stored vector is read back (`VectorStorePort.get`, new; Vectorize `getByIds`), and its 8 nearest neighbours are asked for.
  - **Recording pairs:** neighbours from another record at 0.92 or more record the pair (`record_a < record_b`) with its best score.
  - **Resuming:** the pairs and the run's cursor are written in one transaction, so a failed step records nothing and its retry starts where the run was.
- **Finishing:** when no passages are left, the run is done and replaces the previous run's pairs.
- **When it ends as failed:**
  - its index version stops being active (a re-embed finished): "The AI index changed during the check. Check again."
  - content health is switched off
  - its job is gone, its retries exhausted. This shows as "The check stopped unexpectedly", and doesn't block the next check.
- **Nightly:** the sweep during 03:00 UTC (the local relay, once a day) starts a check when content health and the index are on, an index version is active, and none started in the last 20 hours.
- **The vector store interface** gains `get(namespace, ids)`: in memory and in Vectorize (20 ids per call).

## Server

- **Routes:** `GET /v1/agent/knowledge-health` (the report) and `POST` (`action: "check"` or `"dismiss"`), with the idempotency key (`once`), allowed through the agent bridge.
- **The knowledge list** says whether to offer the page (`health`).
- **`settingsOverview`** adds the `content-health` link.
- **`ContentGapsPort`:** the interface for topics with no content. TODO(phase 14): reporting implements it, and the report shows its topics.

## Migration

`db/postgres/0039_knowledge_health.sql` is additive:
- **Tables:**
  - `knowledge_duplicate_runs` (one running per workspace)
  - `knowledge_duplicate_pairs`
  - `knowledge_duplicate_dismissals`
  - all with row-level security
- **The flag:** `knowledge_health_v1`, off. New workspaces get it from `seedFoundation`.

The rollback switches the flag off and marks a running check failed; the tables stay.

**Seed:** the local relay adds a published internal snippet, "Start a conversation", repeating the seeded article's passage, so the report has a near-duplicate to show. It's internal, so it is never in the help center or used by the AI agent.

## Tests

**`tests/knowledge-health.test.ts`:**
- **Visibility:** off by default; agents refused.
- **Never reviewed:** listed until marked.
- **Not retrieved in 90 days:**
  - no counting before an index
  - nothing listed on the first day
  - the "listed from" date 90 days after counting starts
  - after 100 days of counting: old content without a retrieval is listed (never retrieved first); recent and switched-off content is not
- **Near-duplicates:**
  - **Starting:** a check started once for a retried key; a second check joins the running one.
  - **Resuming:** a failing vector store records nothing and the check resumes.
  - **The result:** the near-copy pair is found at 0.92 or more, and other pairs score below it.
  - **Dismissing:** a dismissal hides the pair until a change; a pair with itself is refused.
- **Nightly:** once in 20 hours, with the previous pairs shown while it runs.
- **Ending checks:** a check whose job died shows as stopped and doesn't block the next one; a check outlived by its index version fails with the reason.
- **Cross-workspace:** another workspace has none of it, and A's records can't be dismissed from B.
- **With the AI index off:** the reason is shown, and Check now is refused.

**`tests/browser/knowledge-health.spec.ts`** (ports 8968/8969):
- **Happy path** (opened from Settings):
  - the article marked reviewed
  - "Retrievals counted since" shown
  - Check now finding the seeded near-duplicate, then dismissing it ("No near-duplicates."), checked in the database
  - a record opened from the report
- **Failure path:** with the AI index off, the section says why and offers no Check now, while the rest of the report works.

**Updated:** `app-shell.spec.ts`, `help-centers.spec.ts`, `help-site.spec.ts` and `knowledge-sync.spec.ts` find Knowledge's "Content" by its exact name, since "Content health" now sits beside it.

## Checks

Results on 3 October 2026:
- `npm test`: 97/97 pass.
- `npm run typecheck`: clean.
- Lint shows nothing in the new files.
- `npm run test:e2e`: 80/80.
- `npm run test:postgres`: passes.
- **Checked in screenshots, light and dark:** the report after a check.
