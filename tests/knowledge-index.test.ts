import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant, type Sql } from "../server/db";
import { seedFoundation } from "../server/people";
import { runJob, type Job } from "../server/jobs";
import {
  chunkId,
  chunkLocale,
  CHUNK_TARGET,
  indexStatus,
  memoryVectorStore,
  rebuildIndex,
  retrieveKnowledge,
  runIndex,
  scheduleIndex,
  testEmbedder,
  type EmbeddingPort,
  type IndexEnvironment,
} from "../server/knowledge-index";
import type { RichDoc } from "../lib/rich-doc";

/** The AI index (phase 07, C2a; docs/KNOWLEDGE_STEP7.md). */

const p = (text: string) => ({
  type: "paragraph" as const,
  content: [{ type: "text" as const, text }],
});
const h = (level: 2 | 3, text: string) => ({
  type: "heading" as const,
  attrs: { level },
  content: [{ type: "text" as const, text }],
});

test("chunking: sections by heading with their path, packed near the target, long text split, repeats kept once", async () => {
  const sentence = "Refunds go back to the card used to pay. ";
  const doc: RichDoc = {
    type: "doc",
    content: [
      p("An overview of refunds."),
      h(2, "Card payments"),
      p(sentence.repeat(20)),
      p("Card refunds can take a few days. ".repeat(24)),
      h(3, "Chargebacks"),
      p("Open a chargeback only after 14 days."),
      p("Open a chargeback only after 14 days."),
      h(2, "Bank transfers"),
      p(Array.from({ length: 800 }, (_, i) => "w" + i).join("")),
      { type: "image", attrs: { attachmentId: "a1", alt: "A receipt" } },
    ],
  };
  const chunks = chunkLocale(doc, "");
  assert.deepEqual(
    [...new Set(chunks.map((c) => c.heading))],
    ["", "Card payments", "Card payments › Chargebacks", "Bank transfers"],
  );
  assert(
    chunks.every((c) => c.text.length <= 1600),
    "never above the maximum",
  );
  // Two 820-character paragraphs don't fit one chunk, so each is its own.
  assert.equal(chunks.filter((c) => c.heading === "Card payments").length, 2);
  // The repeated paragraph is one chunk; the long run is split; images are left out.
  assert.equal(
    chunks.filter((c) => c.heading === "Card payments › Chargebacks").length,
    1,
  );
  assert(chunks.filter((c) => c.heading === "Bank transfers").length >= 3);
  assert(!chunks.some((c) => c.text.includes("[Image")));
  // Text-only records (files, synced pages) split into paragraphs and pack them.
  const text = Array.from({ length: 12 }, (_, i) =>
    `Paragraph ${i} `.repeat(20),
  ).join("\n\n");
  const plain = chunkLocale(null, text);
  assert(plain.length > 1 && plain.every((c) => c.heading === ""));
  assert(plain.every((c) => c.text.length <= CHUNK_TARGET + 400));
  // Ids are stable for the same text, and differ by record, locale or text.
  const id = await chunkId("r1", "en", chunks[0]);
  assert.equal(await chunkId("r1", "en", chunks[0]), id);
  assert.notEqual(await chunkId("r2", "en", chunks[0]), id);
  assert.notEqual(await chunkId("r1", "fr", chunks[0]), id);
  assert.equal(id.length, 64);
});

/**
 * An embedder that records the chunks it embeds (not search queries: a chunk's input always has
 * its title on a line of its own), and can be made to fail.
 */
function counting(base: EmbeddingPort, fail = { next: 0 }) {
  const seen: string[] = [];
  return {
    seen,
    fail,
    embedder: {
      ...base,
      async embed(texts: string[]) {
        if (fail.next > 0) {
          fail.next--;
          throw new Error("model down");
        }
        seen.push(...texts.filter((t) => t.includes("\n")));
        return base.embed(texts);
      },
    } as EmbeddingPort,
  };
}

test("the AI index: indexes on publish, finds by meaning with access checked at query time, re-indexes only what changed, survives a failing model, re-embeds without going offline, and keeps workspaces apart", async () => {
  const db = await testDatabase();
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const store = memoryVectorStore();
  const v1 = counting(testEmbedder({ version: "1" }));
  let env: IndexEnvironment = { embedders: [v1.embedder], vectors: store };
  const handlers = {
    "knowledge.index": (job: Job) => runIndex(db.connect, env, job),
  };
  /** Runs the indexing job to the end; `between` runs after every step. */
  const drain = async (w = "a", between?: () => Promise<void>) => {
    // A job the scheduler starts, or one already queued (a rebuild queues its own).
    const jobId =
      (await scheduleIndex(db.connect, w)) ??
      (
        await sql(
          w,
          "SELECT id FROM jobs WHERE kind='knowledge.index' AND state IN ('queued','running')",
        )
      )[0]?.id;
    if (!jobId) return 0;
    let steps = 0;
    for (;;) {
      const r = await runJob(db.connect, w, jobId, handlers);
      steps++;
      await between?.();
      if (r.state === "succeeded") return steps;
      assert.equal(r.state, "queued", "a step either finishes or continues");
    }
  };
  const search = (
    query: string,
    purpose: "ai" | "inbox" = "ai",
    w = "a",
    signedIn = false,
  ) => retrieveKnowledge(db.connect, env, w, { query, purpose, signedIn });
  const ids = async (
    query: string,
    purpose: "ai" | "inbox" = "ai",
    w = "a",
    signedIn = false,
  ) =>
    (await search(query, purpose, w, signedIn)).results.map((r) => r.recordId);
  /** A record with one published English locale. */
  const publish = async (
    w: string,
    id: string,
    title: string,
    text: string,
    opts: {
      audience?: string;
      forAi?: boolean;
      forInbox?: boolean;
      source?: string;
    } = {},
  ) => {
    await sql(
      w,
      "INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_inbox) VALUES($1,$2,$3,'owner',$4,$5,$6)",
      [
        w,
        id,
        opts.source ?? "article",
        opts.audience ?? "public",
        opts.forAi ?? opts.audience !== "internal",
        opts.forInbox ?? true,
      ],
    );
    await sql(
      w,
      "INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,published_title,published_text,published_revision,published_at) VALUES($1,$2,'en','published',$3,$3,$4,1,now())",
      [w, id, title, text],
    );
  };
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, {
          origins: [],
          master: "m".repeat(40),
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        }),
      );
      await sql(
        w,
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name='knowledge_v1'",
        [w],
      );
    }
    await publish(
      "a",
      "refunds",
      "Refunds",
      "Refunds go back to the card you paid with within five working days.",
    );
    await publish(
      "a",
      "shipping",
      "Shipping",
      "Parcels ship by courier the next working day and arrive within three days.",
    );
    await publish(
      "a",
      "escalation",
      "Escalation playbook",
      "Escalate angry refund requests to the billing lead before replying.",
      { audience: "internal" },
    );
    await publish(
      "a",
      "beta",
      "Beta features",
      "Beta features are switched on per workspace by the product team.",
      { forAi: false },
    );
    await publish(
      "a",
      "vip",
      "VIP refunds",
      "Signed in VIP customers get refunds to store credit instantly.",
      { audience: "signed_in" },
    );
    await publish(
      "b",
      "b-refunds",
      "Workspace B refunds",
      "Refunds in workspace B take thirty days and go back to the card.",
    );

    // Off by default: nothing is scheduled.
    assert.equal(await scheduleIndex(db.connect, "a"), null);
    for (const w of ["a", "b"])
      await sql(
        w,
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name='knowledge_index_v1'",
        [w],
      );

    // The first run creates the first version and builds it; every record is embedded once.
    assert((await drain()) > 0);
    const [first] = await sql(
      "a",
      "SELECT id,model,model_version,dimensions,status FROM knowledge_index_generations",
    );
    assert.deepEqual(
      {
        model: first.model,
        version: first.model_version,
        dimensions: first.dimensions,
        status: first.status,
      },
      {
        model: "relay-test-hash",
        version: "1",
        dimensions: 512,
        status: "active",
      },
    );
    assert.equal(v1.seen.length, 5);
    assert.equal(store.size(first.id), 5);
    assert.equal(await drain(), 0, "nothing left to do");

    // Found by meaning; the AI agent sees only what is switched on for it with a public audience.
    assert.equal(
      (await ids("how long does a refund to my card take"))[0],
      "refunds",
    );
    assert(
      !(await ids("escalate angry refund billing lead")).includes("escalation"),
    );
    assert(!(await ids("beta features product team")).includes("beta"));
    assert(!(await ids("VIP store credit refunds")).includes("vip"));
    assert(
      (await ids("VIP store credit refunds", "ai", "a", true)).includes("vip"),
    );
    // The inbox sees internal content too.
    assert.equal(
      (await ids("escalate angry refund billing lead", "inbox"))[0],
      "escalation",
    );
    // Switching a record off for the AI agent applies at once, without re-indexing.
    await sql(
      "a",
      "UPDATE knowledge_records SET for_ai=false WHERE id='shipping'",
    );
    assert(!(await ids("parcels courier delivery days")).includes("shipping"));
    await sql(
      "a",
      "UPDATE knowledge_records SET for_ai=true WHERE id='shipping'",
    );
    // Results carry what phase 08 needs, and each retrieval is counted for the health report.
    const found = await search("refund card five working days");
    assert.deepEqual(Object.keys(found.results[0]).sort(), [
      "heading",
      "locale",
      "recordId",
      "score",
      "source",
      "text",
      "title",
    ]);
    assert.equal(found.results[0].title, "Refunds");
    const [logged] = await sql(
      "a",
      "SELECT sum(count)::int AS n FROM knowledge_retrievals WHERE record_id='refunds' AND purpose='ai'",
    );
    assert(logged.n >= 2);

    // An edit re-embeds only the new text; the old vector goes from the store.
    const before = v1.seen.length;
    await sql(
      "a",
      "UPDATE knowledge_locales SET published_text=$1,published_revision=2 WHERE record_id='refunds'",
      ["Refunds go back to the card you paid with within ten working days."],
    );
    await drain();
    assert.equal(v1.seen.length - before, 1);
    assert.equal(store.size(first.id), 5);
    assert.equal(
      (await search("refund ten working days")).results[0].text,
      "Refunds go back to the card you paid with within ten working days.",
    );
    // Re-marking without a change embeds nothing (idempotent).
    await sql(
      "a",
      "INSERT INTO knowledge_index_dirty(workspace_id,record_id) VALUES('a','shipping')",
    );
    await drain();
    assert.equal(v1.seen.length - before, 1);
    // Archiving removes its chunks and vectors.
    await sql(
      "a",
      "UPDATE knowledge_locales SET status='archived' WHERE record_id='beta'",
    );
    await drain();
    assert.equal(store.size(first.id), 4);
    assert(
      !(await ids("beta features product team", "inbox")).includes("beta"),
    );

    // A failing model: the step fails and retries, and the change isn't lost.
    v1.fail.next = 1;
    await sql(
      "a",
      "UPDATE knowledge_locales SET published_text=$1,published_revision=3 WHERE record_id='shipping'",
      ["Parcels ship by express courier the same day."],
    );
    const jobId = (await scheduleIndex(db.connect, "a"))!;
    const failed = await runJob(db.connect, "a", jobId, handlers);
    assert.equal(failed.state, "queued");
    const [job] = await sql("a", "SELECT last_error FROM jobs WHERE id=$1", [
      jobId,
    ]);
    assert.equal(job.last_error, "JOB_EXECUTION_FAILED");
    assert.equal(
      (
        await sql(
          "a",
          "SELECT 1 FROM knowledge_index_dirty WHERE record_id='shipping'",
        )
      ).length,
      1,
      "the change is still waiting",
    );
    for (let i = 0; i < 10; i++)
      if (
        (await runJob(db.connect, "a", jobId, handlers)).state === "succeeded"
      )
        break;
    assert.equal(
      (await search("express courier same day")).results[0].recordId,
      "shipping",
    );

    // Re-embed with a new model version while searching after every step: search never goes
    // offline, the switch happens once, and the old version's vectors are removed.
    for (let i = 0; i < 120; i++)
      await publish(
        "a",
        `bulk-${String(i).padStart(3, "0")}`,
        `Topic ${i}`,
        `Bulk article number ${i} about warehouse topic ${i}.`,
      );
    await drain();
    const v2 = counting(testEmbedder({ version: "2" }));
    env = { embedders: [v2.embedder, v1.embedder], vectors: store };
    const started = await tenant(db.connect, "a", (q) =>
      rebuildIndex(q, "a", "owner-a", env),
    );
    let checks = 0;
    await drain("a", async () => {
      const r = await search("refund ten working days");
      assert.equal(r.ready, true);
      assert.equal(
        r.results[0]?.recordId,
        "refunds",
        "search stays online throughout",
      );
      checks++;
    });
    assert(checks > 5, "searched between many steps");
    const generations = await sql(
      "a",
      "SELECT id,model_version,status FROM knowledge_index_generations ORDER BY created_at",
    );
    assert.deepEqual(
      generations.map((g) => [g.model_version, g.status]),
      [
        ["1", "retired"],
        ["2", "active"],
      ],
    );
    assert.equal(generations[1].id, started.generationId);
    assert.equal(store.size(first.id), 0, "the old version's vectors are gone");
    assert.equal(store.size(started.generationId), 124);
    assert.equal(v2.seen.length, 124);
    const status = await tenant(db.connect, "a", (q) =>
      indexStatus(q, "a", "owner-a", env),
    );
    assert.equal(status.active!.version, "2");
    assert.equal(status.active!.records, 124);
    assert.equal(status.building, null);
    // A second rebuild while one runs is refused.
    await tenant(db.connect, "a", (q) => rebuildIndex(q, "a", "owner-a", env));
    await assert.rejects(
      tenant(db.connect, "a", (q) => rebuildIndex(q, "a", "owner-a", env)),
      { code: "INDEX_BUILDING" },
    );
    await drain();

    // Workspaces stay apart: B finds only its own content, and A never B's.
    await drain("b");
    assert.deepEqual(await ids("refunds card thirty days", "inbox", "b"), [
      "b-refunds",
    ]);
    assert(
      !(await ids("refunds card thirty days", "inbox", "a")).includes(
        "b-refunds",
      ),
    );
    assert.equal(
      (await sql("b", "SELECT count(*)::int AS n FROM knowledge_chunks"))[0].n,
      1,
    );
    // Teammates who can't manage knowledge can't see the index page or start a rebuild.
    await sql(
      "a",
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent','agent')",
    );
    const refused: ((q: Sql) => Promise<unknown>)[] = [
      (q) => indexStatus(q, "a", "agent-1-a", env),
      (q) => rebuildIndex(q, "a", "agent-1-a", env),
    ];
    for (const action of refused)
      await assert.rejects(tenant(db.connect, "a", action), { status: 403 });
  } finally {
    await db.close();
  }
});
