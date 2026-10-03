/**
 * Phase 07's acceptance check for the AI index (docs/KNOWLEDGE_STEP7.md): re-embed 10,000
 * records without taking search offline. Builds the index once, then re-embeds everything with a
 * new model version while searching after every job step, and fails if any search comes back
 * not ready or empty. It also counts searches that missed the record they should find.
 * Run: node --import tsx scripts/reembed-load.ts [records=10000]
 * Local embedded PostgreSQL (PGlite) and the in-memory vector store.
 */
import { localDatabase } from "./local-db";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { runJob, type Job } from "../server/jobs";
import {
  memoryVectorStore,
  rebuildIndex,
  retrieveKnowledge,
  runIndex,
  scheduleIndex,
  testEmbedder,
  type IndexEnvironment,
} from "../server/knowledge-index";

const records = Number(process.argv[2] ?? 10000);
const db = await localDatabase();
const w = "demo";
const store = memoryVectorStore();
let env: IndexEnvironment = {
  embedders: [testEmbedder({ version: "1", dimensions: 1024 })],
  vectors: store,
};
const handlers = {
  "knowledge.index": (job: Job) => runIndex(db.connect, env, job),
};
await tenant(db.connect, w, async (sql) => {
  await seedFoundation(sql, w, "owner-demo", {
    origins: [],
    master: "m".repeat(40),
    identitySecret: new TextEncoder().encode("i".repeat(32)),
    enable: true,
  });
  await sql.query(
    "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name IN ('knowledge_v1','knowledge_index_v1')",
    [w],
  );
  // Each record has two paragraphs and a code word of its own ("kz123"), so a search for that
  // record's words has one right answer.
  await sql.query(
    `INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_inbox)
     SELECT $1,'r-'||lpad(i::text,6,'0'),'article','owner','public',true,true FROM generate_series(1,$2::int) i`,
    [w, records],
  );
  await sql.query(
    `INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,published_title,published_text,published_revision,published_at)
     SELECT $1,'r-'||lpad(i::text,6,'0'),'en','published','Guide '||i,'Guide '||i,
       'Guide kz'||i||' covers plan '||(i%97)||' and region '||(i%31)||'.'||E'\\n\\n'||'Customers on tier '||(i%13)||' ask about step kz'||i||' often.',1,now()
     FROM generate_series(1,$2::int) i`,
    [w, records],
  );
});
await db.pg.exec("ANALYZE");

async function drain(between?: () => Promise<void>) {
  const jobId =
    (await scheduleIndex(db.connect, w)) ??
    (await tenant(
      db.connect,
      w,
      async (sql) =>
        (
          await sql.query<{ id: string }>(
            "SELECT id FROM jobs WHERE kind='knowledge.index' AND state IN ('queued','running')",
          )
        ).rows[0]?.id,
    ));
  const steps: number[] = [];
  for (;;) {
    const s = performance.now();
    const r = await runJob(db.connect, w, jobId!, handlers);
    steps.push(performance.now() - s);
    await between?.();
    if (r.state === "succeeded") return steps;
    if (r.state !== "queued") throw new Error("Index job failed: " + r.state);
  }
}
const pct = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[
    Math.min(xs.length - 1, Math.floor(xs.length * p))
  ];

let t0 = performance.now();
const first = await drain();
console.log(
  `build ${records} records: ${((performance.now() - t0) / 1000).toFixed(1)}s, ${first.length} steps, step p95 ${pct(first, 0.95).toFixed(0)}ms`,
);

// Re-embed with a new model version, searching after every step.
env = {
  embedders: [
    testEmbedder({ version: "2", dimensions: 1024 }),
    env.embedders[0],
  ],
  vectors: store,
};
await tenant(db.connect, w, (sql) => rebuildIndex(sql, w, "owner-demo", env));
let searches = 0,
  failures = 0,
  misses = 0;
const searchTimes: number[] = [];
t0 = performance.now();
const rebuild = await drain(async () => {
  for (let k = 0; k < 3; k++) {
    const i = 1 + Math.floor(Math.random() * records);
    const s = performance.now();
    const r = await retrieveKnowledge(db.connect, env, w, {
      query: `step kz${i} plan ${i % 97} region ${i % 31}`,
      purpose: "ai",
      log: false,
    });
    searchTimes.push(performance.now() - s);
    searches++;
    if (!r.ready || !r.results.length) failures++;
    else if (
      !r.results.some((x) => x.recordId === "r-" + String(i).padStart(6, "0"))
    )
      misses++;
  }
});
const generations = await tenant(
  db.connect,
  w,
  async (sql) =>
    (
      await sql.query<{ model_version: string; status: string }>(
        "SELECT model_version,status FROM knowledge_index_generations ORDER BY created_at",
      )
    ).rows,
);
console.log(
  `re-embed ${records} records: ${((performance.now() - t0) / 1000).toFixed(1)}s, ${rebuild.length} steps, step p95 ${pct(rebuild, 0.95).toFixed(0)}ms`,
);
console.log(
  `searches during re-embed: ${searches}, not ready or empty: ${failures}, without the expected record: ${misses}, search p50 ${pct(searchTimes, 0.5).toFixed(1)}ms p95 ${pct(searchTimes, 0.95).toFixed(1)}ms`,
);
console.log(
  "versions:",
  generations.map((g) => `${g.model_version} ${g.status}`).join(", "),
  "| vectors left in the store:",
  store.size(),
);
await db.close();
// Offline means a search that isn't ready or finds nothing. A rare miss of the expected record
// is the test model's word hashing mixing up two near-identical guides, not the index.
if (failures) process.exit(1);
