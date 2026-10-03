# Phase 07, step C2a: the AI index

Branch `phase-07/c2a-ai-index`. Plan: `docs/KNOWLEDGE_PLAN.md`. Approved on 3 October 2026 ("Yes, go ahead with all four"):
1. **Split C2** into C2a (this step: chunking, embeddings, retrieval, re-embedding without downtime) and C2b (the content health report).
2. **Index internal content too**, so the inbox and the phase 10 copilot can use it. Access is checked in PostgreSQL at query time.
3. **A "Try a question" box** on the index page.
4. **Near-duplicates** (for C2b): cosine similarity of 0.92 or more, checked nightly and on demand.

## What it does

**Chunking** (`chunkLocale` in `server/knowledge-index.ts`) splits every published locale into passages of about 1,200 characters (at most 1,600).
- **Articles** split at their headings. Each passage keeps its heading path ("Refunds › Card payments"), and the model reads it with the title and heading so a passage makes sense on its own.
- **Files and synced pages** (text only) split into paragraphs.
- **Long runs** are cut at sentence ends.
- **Images and videos** are left out, and repeated text within a locale is kept once.

**Chunks** are stored in PostgreSQL (`knowledge_chunks`). A chunk's id is a hash of its record, locale, heading and text, so unchanged text keeps its id and its vectors across edits. **Vectors never enter PostgreSQL;** they live in the vector store.

**What starts indexing:**
- **A trigger** on `knowledge_locales` marks a record (`knowledge_index_dirty`) whenever what it publishes changes: publishing, unpublishing, archiving, a new revision, a new title or text. That covers manual publishing, file processing and website sync without changing any of them.
- **The scheduled sweep** (`scheduleIndex`) starts the `knowledge.index` job when there is work and none is running: once a minute in the Worker, every second in the local relay.

**The job** (`runIndex`) does one of these each step, then asks to run again while work remains:
1. **Marked records:** ten records into every live index version. A record is re-chunked, only chunks a version lacks are embedded, and vectors of chunks that are gone are removed.
2. **A version being built:** the next 25 records, with the cursor saved after each batch. When the build is complete, one transaction retires the old version and activates the new one.
3. **A retired version:** 500 of its vectors removed from the store.

**Idempotent and resumable:**
- A repeated step changes nothing.
- A mark is cleared only after its record is fully indexed, and only if no newer change arrived meanwhile. A change during indexing moves the mark's time, so it's indexed next.
- **Write order:** a vector is written before the row that records it, and removed before that row. A failure at any point is repaired by the retry, and no vector is ever left without a row to find it by.

**Index versions** (`knowledge_index_generations`) each record their model, model version and dimensions.
- **Searches** read only the active version.
- **"Re-embed everything"** builds a new version with the current model beside the active one. Changes are written to both meanwhile, and the switch happens in one update. The old version's vectors are then removed.
- **Search never goes offline,** and a second re-embed while one runs is refused.

**Retrieval** (`retrieveKnowledge`) is what phase 08's AI agent will call. It embeds the question with the active version's model, takes the nearest vectors, then reads the passages back from PostgreSQL with access applied there:
- **`ai`:** records switched on for the AI agent, with a public audience. Signed-in-only content is included only when the customer is signed in.
- **`inbox`:** records available in the inbox, internal content included.
- **Result limits:** at most two passages from one record.
- **Each result carries:** record, title, locale, kind, heading, text and score.
- **Counting:** every record found is counted per day and purpose in `knowledge_retrievals`, which C2b's "not retrieved in 90 days" reads.
- Because access is read at query time, switching a record off for the AI agent applies at once, without re-indexing. An internal or unpublished record can never be returned to a customer-facing search, even if its vectors are stale.

**The AI index page** (Knowledge → AI index, for `knowledge.manage`):
- the current index's model, version, dimensions, records and passages, and when it came into use
- what is waiting, and the last indexing error if a step failed (it retries)
- a re-embed's progress
- **Re-embed everything**
- **Try a question:** as the AI agent or the inbox, it lists the passages found with their kind, language, heading and match. Each opens its record. Shown as for a signed-in customer, and not counted as retrievals.

## Models and stores

They sit behind `EmbeddingPort` and `VectorStorePort`.

**Deployed (not provisioned yet):**
- Workers AI `@cf/baai/bge-m3` (multilingual, 1,024 dimensions) and a Cloudflare Vectorize index (cosine), as the optional `AI` and `KNOWLEDGE_VECTORS` bindings.
- Without them the Worker doesn't run the job, and the page says the index is unavailable.
- **Model version:** Cloudflare doesn't version the model, so the version is ours. Raise it when the model's output changes.
- **Vector ids** include the index version, so two versions never collide in one Vectorize index.
- **Model dimensions:** a model with different dimensions needs its own Vectorize index (TODO phase 17, with provisioning).

**Local and tests:**
- **The test model** (`testEmbedder`) is a deterministic stand-in: words, lightly trimmed of plain English endings, plus word pairs, hashed into 512 dimensions. It matches shared words, not meaning.
- **The vector store** is in memory (`memoryVectorStore`). The local relay saves it to `vectors.json` in its data folder, so the index survives a restart with the database that points into it.
- **Tests** pass their own model and store to `startLocalRelay({ index })`.

## Acceptance: re-embedding 10,000 records without search going offline

`node --import tsx scripts/reembed-load.ts 10000`:
- builds the index for 10,000 records (two paragraphs each)
- re-embeds them with a new model version, running three searches after every job step
- fails if any search isn't ready or finds nothing

Results on 3 October 2026 (PGlite, in-memory store, 1,024-dimension test model):

| | Result |
|---|---|
| First build | 63.5 s, 1,402 steps, step p95 69 ms |
| Re-embed | 74.8 s, 422 steps, step p95 209 ms (a background job, 25 records a step) |
| Searches during the re-embed | 1,266 |
| Searches not ready or empty | 0 |
| Searches missing the record they should find | 0 |
| Search time during the re-embed | p50 20.5 ms, p95 30.9 ms |
| After the re-embed | version 1 retired, version 2 active, 10,000 vectors in the store (the old version's all removed) |

An earlier run with the first test model missed one record in 1,266. That was its hashing confusing two near-identical guides, not the index; the script now reports misses but fails only on searches that aren't ready or are empty.

## Migration

`db/postgres/0036_knowledge_index.sql` is additive. It adds:
- **Tables:** five new ones (`knowledge_index_generations`, `knowledge_chunks`, `knowledge_chunk_vectors`, `knowledge_index_dirty`, `knowledge_retrievals`), with tenant row-level security.
- **The marking trigger.**
- **The flag:** `knowledge_index_v1`, off by default. New workspaces get it from `seedFoundation`, and the local relay turns it on.

The rollback drops the trigger and switches the flag off; the tables stay.

## Tests

**`tests/knowledge-index.test.ts`:**
- **Chunking:**
  - heading paths
  - packing and the maximum
  - long text split
  - repeats kept once
  - images left out
  - text-only records
  - stable chunk ids
- **The pipeline**, against PGlite with a counting model and the memory store:
  - off by default
  - the first build records model, version and dimensions, and embeds each record once
  - **AI and inbox access:**
    - the AI agent sees public content and not internal, switched-off or signed-in-only content (signed-in content only when signed in)
    - the inbox sees internal content
    - switching a record off applies at once
  - results carry their fields, and retrievals are counted
  - an edit re-embeds one passage and removes the old vector
  - re-marking without a change embeds nothing
  - archiving removes chunks and vectors
- **A failing model:**
  - the step fails with the error recorded
  - the change stays marked
  - the retry indexes it
- **Re-embedding 124 records** with a new model version, searching after every step:
  - never offline
  - one switch
  - the old vectors all removed
  - status reports the new version
- **Refusals and isolation:**
  - a second re-embed while one runs is refused
  - workspace B finds only its own content and A never B's
  - a teammate without `knowledge.manage` can't see the index page or start a re-embed

**`tests/browser/knowledge-index.spec.ts`** (ports 8912/8913):
- **Happy path:**
  - the page's current index
  - "Try a question" as the AI agent and the inbox (internal content only in the inbox)
  - newly published content indexed on its own
  - a passage opening its record
  - "Re-embed everything" switching to a new version, with search still answering
- **Failure path:** with the model down, a published change waits, the page shows the error and the waiting record, and the current index is untouched. When the model is back, the change is indexed and found.

## Notes

- **The page refreshes itself** while indexing is busy. Otherwise it shows the state when opened.
- **A model a deployment can no longer run:** an index version needing one stops the job with `INDEX_MODEL_UNAVAILABLE`. Keep the old model registered until a re-embed with the new one completes.
- **Next, C2b:** the content health report. It covers records never reviewed, records not retrieved in 90 days (from `knowledge_retrievals`), and near-duplicates (vector neighbours at 0.92 or more). For "topics customers ask about with no matching content", C2b defines the interface only; phase 14 supplies the data.

## Fixed along the way

- **Local relay refreshes:** it sent every workspace a refresh after each background job step. Indexing steps now run at startup and after every publish, so those refreshes made idle inboxes reload their list (the inbox test's no-polling check caught it). Index steps no longer send one. The Worker never did; it only reports the job's own status.

## Checks

Results on 3 October 2026:
- `npm test`: 91/91 pass.
- `npm run typecheck`: clean.
- Lint shows nothing in the new files.
- `npm run test:e2e`: 68/68.
- `npm run test:postgres`: passes.
- `scripts/reembed-load.ts 10000`: passes (see Acceptance).
