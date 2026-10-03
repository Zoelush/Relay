import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import { manager, requireKnowledge } from "./knowledge";
import { indexEnabled, type IndexEnvironment } from "./knowledge-index";

/**
 * Content health (phase 07, step C2b; docs/KNOWLEDGE_STEP8.md), behind `knowledge_health_v1`, for
 * those who manage knowledge. One report of what needs attention:
 *
 * - **Never reviewed:** published records nobody has marked as reviewed.
 * - **Not retrieved in 90 days:** published records the AI agent or the inbox can use that no
 *   search returned in 90 days. Retrievals are counted from the workspace's first AI index (C2a),
 *   so a record is listed only once it has been usable for 90 days of counting; until then the
 *   report says when counting started, rather than calling everything unused.
 * - **Near-duplicates:** pairs of different records with passages 0.92 or more alike (cosine), found
 *   by the `knowledge.duplicates` job over the active index version, nightly and on demand. The
 *   report shows the latest finished check while the next runs; a dismissed pair stays hidden
 *   until either record publishes a change.
 * - **Topics with no content:** an interface only (`ContentGapsPort`); TODO(phase 14).
 */
export const DUPLICATE_SIMILARITY = 0.92;
/** Neighbours asked of the vector store per passage. */
const NEIGHBOURS = 8;
/** Passages checked per job step. */
const CHECK_BATCH = 50;
const LIST_LIMIT = 100;
const DAY = 86_400_000;

/**
 * Topics customers ask about with no matching content. Reporting (phase 14) clusters customer
 * questions and implements this; until then the report says it isn't available.
 */
export type ContentGap = {
  topic: string;
  conversations: number;
  examples: string[];
};
export interface ContentGapsPort {
  gaps(w: string, since: Date): Promise<ContentGap[]>;
}
// TODO(phase 14): a ContentGapsPort over clustered customer questions, passed to knowledgeHealth.

export async function healthEnabled(db: Sql, w: string) {
  return (
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='knowledge_health_v1' AND enabled",
        [w],
      )
    ).rows.length > 0
  );
}
async function requireHealth(db: Sql, w: string) {
  await requireKnowledge(db, w);
  assert(
    await healthEnabled(db, w),
    "HEALTH_DISABLED",
    "Content health is not enabled for this workspace.",
    404,
  );
}

/** A record's title (its first published locale) and when it was first published. */
const RECORD_FIELDS = `r.id,r.source,r.owner_id,t.name AS owner_name,r.created_at,r.for_ai,r.for_inbox,
  (SELECT l.published_title FROM knowledge_locales l WHERE l.workspace_id=r.workspace_id AND l.record_id=r.id AND l.status='published' ORDER BY l.published_at,l.locale LIMIT 1) AS title,
  COALESCE((SELECT min(v.created_at) FROM knowledge_revisions v WHERE v.workspace_id=r.workspace_id AND v.record_id=r.id),
           (SELECT min(l.published_at) FROM knowledge_locales l WHERE l.workspace_id=r.workspace_id AND l.record_id=r.id AND l.status='published')) AS first_published`;
const PUBLISHED = `EXISTS(SELECT 1 FROM knowledge_locales l WHERE l.workspace_id=r.workspace_id AND l.record_id=r.id AND l.status='published')`;
type RecordRow = {
  id: string;
  source: string;
  owner_id: string;
  owner_name: string;
  created_at: string;
  for_ai: boolean;
  for_inbox: boolean;
  title: string | null;
  first_published: string | null;
};
const iso = (v: string | Date | null) =>
  v === null ? null : new Date(v).toISOString();
const recordView = (r: RecordRow) => ({
  id: r.id,
  title: r.title ?? "",
  source: r.source,
  owner: { id: r.owner_id, name: r.owner_name },
  firstPublishedAt: iso(r.first_published),
});

export async function knowledgeHealth(
  db: Sql,
  w: string,
  principal: string,
  gapsPort?: ContentGapsPort,
) {
  await manager(db, w, principal);
  await requireHealth(db, w);

  // Never reviewed.
  const neverReviewed = (
    await db.query<RecordRow & { total: string }>(
      `SELECT ${RECORD_FIELDS},count(*) OVER()::text AS total
       FROM knowledge_records r JOIN teammates t ON t.workspace_id=r.workspace_id AND t.id=r.owner_id
       WHERE r.workspace_id=$1 AND r.last_reviewed_at IS NULL AND ${PUBLISHED}
       ORDER BY first_published NULLS LAST,r.id LIMIT $2`,
      [w, LIST_LIMIT],
    )
  ).rows;

  // Not retrieved in 90 days, counted from the first index.
  const since = (
    await db.query<{ since: string | null }>(
      "SELECT min(activated_at) AS since FROM knowledge_index_generations WHERE workspace_id=$1",
      [w],
    )
  ).rows[0]?.since;
  const unused = since
    ? (
        await db.query<
          RecordRow & { last_retrieved: string | null; total: string }
        >(
          `SELECT * FROM (
             SELECT ${RECORD_FIELDS},
               (SELECT max(day) FROM knowledge_retrievals k WHERE k.workspace_id=r.workspace_id AND k.record_id=r.id)::text AS last_retrieved
             FROM knowledge_records r JOIN teammates t ON t.workspace_id=r.workspace_id AND t.id=r.owner_id
             WHERE r.workspace_id=$1 AND (r.for_ai OR r.for_inbox) AND ${PUBLISHED}
               AND NOT EXISTS(SELECT 1 FROM knowledge_retrievals k WHERE k.workspace_id=r.workspace_id AND k.record_id=r.id
                 AND k.day>=((now() AT TIME ZONE 'UTC') - interval '90 days')::date)
           ) x
           WHERE greatest($2::timestamptz,COALESCE(x.first_published,x.created_at)) <= now() - interval '90 days'
           ORDER BY x.last_retrieved NULLS FIRST,x.id`,
          [w, since],
        )
      ).rows
    : [];

  return {
    neverReviewed: {
      total: Number(neverReviewed[0]?.total ?? 0),
      records: neverReviewed.map(recordView),
    },
    notRetrieved: {
      countingSince: iso(since ?? null),
      // The first day a record can have gone 90 days without a retrieval.
      listedFrom: since
        ? new Date(new Date(since).getTime() + 90 * DAY).toISOString()
        : null,
      total: unused.length,
      records: unused.slice(0, LIST_LIMIT).map((r) => ({
        ...recordView(r),
        usedBy: [r.for_ai && "ai", r.for_inbox && "inbox"].filter(Boolean),
        lastRetrievedOn: r.last_retrieved,
      })),
    },
    duplicates: await duplicates(db, w),
    gaps: gapsPort
      ? {
          available: true,
          topics: await gapsPort.gaps(w, new Date(Date.now() - 90 * DAY)),
        }
      : {
          available: false,
          reason:
            "Topics customers ask about with no matching content arrive with reporting.",
        },
  };
}

/**
 * Ends a check whose job is gone (its retries ran out): without this, a check stuck as running
 * would block every later one.
 */
const STOPPED = "The check stopped unexpectedly. Check again.";
async function endStalled(db: Sql, w: string) {
  await db.query(
    `UPDATE knowledge_duplicate_runs r SET status='failed',error=$2,finished_at=now()
     WHERE r.workspace_id=$1 AND r.status='running' AND NOT EXISTS(
       SELECT 1 FROM jobs j WHERE j.workspace_id=r.workspace_id AND j.kind='knowledge.duplicates'
         AND j.state IN ('queued','running') AND j.payload->>'runId'=r.id)`,
    [w, STOPPED],
  );
}

async function activeGeneration(db: Sql, w: string) {
  return (
    await db.query<{ id: string }>(
      "SELECT id FROM knowledge_index_generations WHERE workspace_id=$1 AND status='active'",
      [w],
    )
  ).rows[0]?.id;
}

/** The near-duplicate section: why it's unavailable, or the latest check and its pairs. */
async function duplicates(db: Sql, w: string) {
  if (!(await indexEnabled(db, w)))
    return {
      available: false,
      reason:
        "Near-duplicates are found with the AI index, which is off for this workspace.",
    };
  if (!(await activeGeneration(db, w)))
    return {
      available: false,
      reason:
        "Near-duplicates are found with the AI index, which hasn't finished building yet.",
    };
  // A check whose job is gone shows as stopped (the report itself changes nothing).
  const stalled = new Set(
    (
      await db.query<{ id: string }>(
        `SELECT r.id FROM knowledge_duplicate_runs r WHERE r.workspace_id=$1 AND r.status='running' AND NOT EXISTS(
           SELECT 1 FROM jobs j WHERE j.workspace_id=r.workspace_id AND j.kind='knowledge.duplicates'
             AND j.state IN ('queued','running') AND j.payload->>'runId'=r.id)`,
        [w],
      )
    ).rows.map((r) => r.id),
  );
  const runs = (
    await db.query<{
      id: string;
      status: string;
      chunks_total: number;
      chunks_done: number;
      pairs: number;
      error: string | null;
      started_at: string;
      finished_at: string | null;
    }>(
      `SELECT id,status,chunks_total,chunks_done,pairs,error,started_at,finished_at FROM knowledge_duplicate_runs
       WHERE workspace_id=$1 ORDER BY started_at DESC LIMIT 5`,
      [w],
    )
  ).rows.map((r) =>
    stalled.has(r.id) ? { ...r, status: "failed", error: STOPPED } : r,
  );
  const running = runs.find((r) => r.status === "running");
  const last = runs.find((r) => r.status !== "running");
  const done = runs.find((r) => r.status === "done");
  const pairs = done
    ? (
        await db.query<{
          record_a: string;
          record_b: string;
          score: number;
          title_a: string | null;
          title_b: string | null;
          source_a: string;
          source_b: string;
        }>(
          `SELECT p.record_a,p.record_b,p.score,
             (SELECT l.published_title FROM knowledge_locales l WHERE l.workspace_id=p.workspace_id AND l.record_id=p.record_a AND l.status='published' ORDER BY l.published_at,l.locale LIMIT 1) AS title_a,
             (SELECT l.published_title FROM knowledge_locales l WHERE l.workspace_id=p.workspace_id AND l.record_id=p.record_b AND l.status='published' ORDER BY l.published_at,l.locale LIMIT 1) AS title_b,
             a.source AS source_a,b.source AS source_b
           FROM knowledge_duplicate_pairs p
           JOIN knowledge_records a ON a.workspace_id=p.workspace_id AND a.id=p.record_a
           JOIN knowledge_records b ON b.workspace_id=p.workspace_id AND b.id=p.record_b
           WHERE p.workspace_id=$1 AND p.run_id=$2
             -- Still published, both of them.
             AND EXISTS(SELECT 1 FROM knowledge_locales l WHERE l.workspace_id=p.workspace_id AND l.record_id=p.record_a AND l.status='published')
             AND EXISTS(SELECT 1 FROM knowledge_locales l WHERE l.workspace_id=p.workspace_id AND l.record_id=p.record_b AND l.status='published')
             -- Not dismissed, unless either record published a change since.
             AND NOT EXISTS(SELECT 1 FROM knowledge_duplicate_dismissals d WHERE d.workspace_id=p.workspace_id AND d.record_a=p.record_a AND d.record_b=p.record_b
               AND NOT EXISTS(SELECT 1 FROM knowledge_locales l WHERE l.workspace_id=p.workspace_id AND l.record_id IN (p.record_a,p.record_b) AND l.published_at>d.dismissed_at))
           ORDER BY p.score DESC,p.record_a,p.record_b LIMIT $3`,
          [w, done.id, LIST_LIMIT],
        )
      ).rows
    : [];
  const run = (r: (typeof runs)[number] | undefined) =>
    r && {
      id: r.id,
      status: r.status,
      checked: r.chunks_done,
      total: Math.max(r.chunks_total, r.chunks_done),
      pairs: r.pairs,
      error: r.error,
      startedAt: iso(r.started_at),
      finishedAt: iso(r.finished_at),
    };
  return {
    available: true,
    threshold: DUPLICATE_SIMILARITY,
    running: run(running) ?? null,
    last: run(last) ?? null,
    pairs: pairs.map((p) => ({
      a: { id: p.record_a, title: p.title_a ?? "", source: p.source_a },
      b: { id: p.record_b, title: p.title_b ?? "", source: p.source_b },
      similarity: Math.round(Math.min(p.score, 1) * 1000) / 1000,
    })),
  };
}

/** Starts a near-duplicate check, unless one is running (then that one is returned). */
async function startCheck(db: Sql, w: string, by: string | null) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    "knowledge.duplicates:" + w,
  ]);
  await endStalled(db, w);
  const running = (
    await db.query<{ id: string }>(
      "SELECT id FROM knowledge_duplicate_runs WHERE workspace_id=$1 AND status='running'",
      [w],
    )
  ).rows[0];
  if (running) return { runId: running.id, started: false };
  const generation = await activeGeneration(db, w);
  assert(
    generation,
    "INDEX_NOT_READY",
    "The AI index hasn't finished building yet, so there's nothing to compare.",
    409,
  );
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO knowledge_duplicate_runs(workspace_id,id,generation_id,status,chunks_total,started_by)
     VALUES($1,$2,$3,'running',(SELECT count(*) FROM knowledge_chunk_vectors WHERE workspace_id=$1 AND generation_id=$3),$4)`,
    [w, id, generation, by],
  );
  await enqueueJob(
    db,
    w,
    "knowledge.duplicates",
    { runId: id },
    by ? { teammateId: by } : {},
  );
  return { runId: id, started: true };
}

/** "Check now", and "Not duplicates" on a pair. */
export async function changeHealth(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const t = await manager(db, w, principal);
  await requireHealth(db, w);
  if (p.action === "check") {
    assert(
      await indexEnabled(db, w),
      "INDEX_DISABLED",
      "Near-duplicates are found with the AI index, which is off for this workspace.",
      409,
    );
    return startCheck(db, w, t.id);
  }
  if (p.action === "dismiss") {
    const [a, b] = [String(p.recordA ?? ""), String(p.recordB ?? "")].sort();
    assert(a && b && a !== b, "INVALID_PAIR", "Choose two records.");
    const found = (
      await db.query(
        "SELECT 1 FROM knowledge_records WHERE workspace_id=$1 AND id=ANY($2::text[])",
        [w, [a, b]],
      )
    ).rows.length;
    assert(found === 2, "RECORD_NOT_FOUND", "Record unavailable.", 404);
    await db.query(
      `INSERT INTO knowledge_duplicate_dismissals(workspace_id,record_a,record_b,dismissed_by) VALUES($1,$2,$3,$4)
       ON CONFLICT(workspace_id,record_a,record_b) DO UPDATE SET dismissed_by=$4,dismissed_at=now()`,
      [w, a, b, t.id],
    );
    return { recordA: a, recordB: b };
  }
  throw new DomainError("INVALID_ACTION", "Choose check or dismiss.", 400);
}

/**
 * The nightly check (the scheduled sweep calls this during 03:00 UTC, the local relay once a
 * day): starts one when content health and the index are on, an index version is active, and no
 * check started in the last 20 hours.
 */
export async function scheduleDuplicateCheck(connect: Connect, w: string) {
  return tenant(connect, w, async (db) => {
    if (!(await healthEnabled(db, w)) || !(await indexEnabled(db, w)))
      return null;
    if (!(await activeGeneration(db, w))) return null;
    const recent = (
      await db.query(
        "SELECT 1 FROM knowledge_duplicate_runs WHERE workspace_id=$1 AND started_at>now()-interval '20 hours'",
        [w],
      )
    ).rows.length;
    if (recent) return null;
    return (await startCheck(db, w, null)).runId;
  });
}

/**
 * One step of a check: the next batch of the run's passages, each compared with its nearest
 * neighbours; pairs at or above the threshold are recorded. Resumable from the run's cursor, and
 * a repeated step only re-records the same pairs. A check whose index version stopped being
 * active (a re-embed finished) ends as failed; the next check uses the new version.
 */
export async function runDuplicates(
  connect: Connect,
  env: IndexEnvironment,
  job: Job,
): Promise<{ done: boolean; result: Record<string, unknown> }> {
  const w = job.workspace_id;
  const runId = String(job.payload.runId ?? "");
  const state = await tenant(connect, w, async (db) => {
    const run = (
      await db.query<{
        generation_id: string;
        cursor: string | null;
        status: string;
        active: boolean;
      }>(
        `SELECT r.generation_id,r.cursor,r.status,(g.status='active') AS active FROM knowledge_duplicate_runs r
         JOIN knowledge_index_generations g ON g.workspace_id=r.workspace_id AND g.id=r.generation_id
         WHERE r.workspace_id=$1 AND r.id=$2`,
        [w, runId],
      )
    ).rows[0];
    if (!run || run.status !== "running") return null;
    if (!run.active || !(await healthEnabled(db, w))) {
      await db.query(
        "UPDATE knowledge_duplicate_runs SET status='failed',error=$3,finished_at=now() WHERE workspace_id=$1 AND id=$2",
        [
          w,
          runId,
          run.active
            ? "Content health was switched off."
            : "The AI index changed during the check. Check again.",
        ],
      );
      return null;
    }
    const batch = (
      await db.query<{
        chunk_id: string;
        record_id: string;
        vector_id: string;
      }>(
        `SELECT chunk_id,record_id,vector_id FROM knowledge_chunk_vectors
         WHERE workspace_id=$1 AND generation_id=$2 AND ($3::text IS NULL OR chunk_id>$3)
         ORDER BY chunk_id LIMIT $4`,
        [w, run.generation_id, run.cursor, CHECK_BATCH],
      )
    ).rows;
    return { generation: run.generation_id, batch };
  });
  if (!state) return { done: true, result: { stopped: true } };
  const { generation, batch } = state;

  if (!batch.length) {
    // Finished: this check's pairs replace the previous ones.
    await tenant(connect, w, async (db) => {
      await db.query(
        "UPDATE knowledge_duplicate_runs SET status='done',finished_at=now(),pairs=(SELECT count(*) FROM knowledge_duplicate_pairs WHERE workspace_id=$1 AND run_id=$2) WHERE workspace_id=$1 AND id=$2",
        [w, runId],
      );
      await db.query(
        "DELETE FROM knowledge_duplicate_pairs WHERE workspace_id=$1 AND run_id<>$2",
        [w, runId],
      );
    });
    return { done: true, result: { finished: runId } };
  }

  const vectors = await env.vectors.get(
    generation,
    batch.map((c) => c.vector_id),
  );
  const byVector = new Map(batch.map((c) => [c.vector_id, c]));
  const found = new Map<string, { vectorId: string; score: number }[]>();
  for (const v of vectors) {
    const matches = (
      await env.vectors.query(generation, v.values, NEIGHBOURS + 1)
    ).filter((m) => m.id !== v.id && m.score >= DUPLICATE_SIMILARITY);
    if (matches.length)
      found.set(
        v.id,
        matches.map((m) => ({ vectorId: m.id, score: m.score })),
      );
  }
  await tenant(connect, w, async (db) => {
    const neighbours = [...found.values()].flat().map((m) => m.vectorId);
    const recordOf = new Map(
      neighbours.length
        ? (
            await db.query<{ vector_id: string; record_id: string }>(
              "SELECT vector_id,record_id FROM knowledge_chunk_vectors WHERE workspace_id=$1 AND generation_id=$2 AND vector_id=ANY($3::text[])",
              [w, generation, neighbours],
            )
          ).rows.map((r) => [r.vector_id, r.record_id])
        : [],
    );
    // The best score per pair of different records.
    const pairs = new Map<string, number>();
    for (const [vectorId, matches] of found) {
      const from = byVector.get(vectorId)!.record_id;
      for (const m of matches) {
        const to = recordOf.get(m.vectorId);
        if (!to || to === from) continue;
        const key = [from, to].sort().join("\u0000");
        pairs.set(key, Math.max(pairs.get(key) ?? 0, m.score));
      }
    }
    for (const [key, score] of pairs) {
      const [a, b] = key.split("\u0000");
      await db.query(
        `INSERT INTO knowledge_duplicate_pairs(workspace_id,run_id,record_a,record_b,score) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(workspace_id,run_id,record_a,record_b) DO UPDATE SET score=greatest(knowledge_duplicate_pairs.score,EXCLUDED.score)`,
        [w, runId, a, b, Math.min(score, 1)],
      );
    }
    await db.query(
      "UPDATE knowledge_duplicate_runs SET cursor=$3,chunks_done=chunks_done+$4 WHERE workspace_id=$1 AND id=$2 AND status='running'",
      [w, runId, batch.at(-1)!.chunk_id, batch.length],
    );
  });
  return { done: false, result: { checked: batch.length } };
}
