import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { runJob, type Job } from "../server/jobs";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import {
  memoryVectorStore,
  runIndex,
  scheduleIndex,
  testEmbedder,
  type IndexEnvironment,
} from "../server/knowledge-index";
import {
  DUPLICATE_SIMILARITY,
  runDuplicates,
  scheduleDuplicateCheck,
} from "../server/knowledge-health";

/** Content health (phase 07, C2b; docs/KNOWLEDGE_STEP8.md). */
test("content health: never reviewed, not retrieved in 90 days counted from the first index, near-duplicates found at 0.92 and resumed after a failure, dismissals until a change, nightly once a day, and kept to the workspace", async () => {
  const db = await testDatabase();
  const store = memoryVectorStore();
  const failing = { query: 0 };
  const index: IndexEnvironment = {
    embedders: [testEmbedder()],
    vectors: {
      ...store,
      async query(ns, vector, topK) {
        if (failing.query > 0) {
          failing.query--;
          throw new Error("vector store down");
        }
        return store.query(ns, vector, topK);
      },
    },
  };
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    knowledgeIndex: index,
  };
  const send = (r: Request) => handleApi(r, env);
  const agent = async (
    path: string,
    data?: unknown,
    principal = "owner-a",
    workspace = "a",
    key: string = crypto.randomUUID(),
  ) => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
          "idempotency-key": key,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      principal,
      {
        RELAY_AGENT_INBOX_V1: "true",
        RELAY_STORAGE_AUTHORITY: "postgres",
        RELAY_API_ORIGIN: "https://relay.test",
        RELAY_WORKSPACE_ID: workspace,
        RELAY_BRIDGE_SECRET: env.bridgeSecret,
      },
      send,
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const code = (r: { body: any }) => r.body.error?.code;
  const handlers = {
    "knowledge.index": (job: Job) => runIndex(db.connect, index, job),
    "knowledge.duplicates": (job: Job) => runDuplicates(db.connect, index, job),
  };
  /** Runs a queued job of this kind until it finishes or stops on an error. */
  const drain = async (kind: string, w = "a") => {
    for (;;) {
      const job = (
        await sql<{ id: string }>(
          w,
          "SELECT id FROM jobs WHERE kind=$1 AND state IN ('queued','running') ORDER BY created_at LIMIT 1",
          [kind],
        )
      )[0];
      if (!job) return "idle";
      const r = await runJob(db.connect, w, job.id, handlers);
      if (r.state !== "queued" && r.state !== "succeeded") return r.state;
      if (r.state === "queued" && !(r as { continued?: boolean }).continued)
        return "retrying";
    }
  };
  const publish = async (
    w: string,
    id: string,
    title: string,
    text: string,
    opts: { forAi?: boolean; forInbox?: boolean; daysAgo?: number } = {},
  ) => {
    await sql(
      w,
      "INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_inbox) VALUES($1,$2,'article','owner','public',$3,$4)",
      [w, id, opts.forAi ?? true, opts.forInbox ?? true],
    );
    await sql(
      w,
      `INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,published_title,published_text,published_revision,published_at)
       VALUES($1,$2,'en','published',$3,$3,$4,1,now()-make_interval(days=>$5))`,
      [w, id, title, text, opts.daysAgo ?? 0],
    );
  };
  const report = async (w = "a", principal = "owner-" + w) =>
    agent("knowledge-health", undefined, principal, w);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, {
          origins: [],
          master: env.identityMaster,
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        }),
      );
      await sql(
        w,
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name IN ('knowledge_v1','knowledge_index_v1')",
        [w],
      );
      await sql(
        w,
        "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES($1,'agent-1','agent-1-'||$1,'Agent one','agent')",
        [w],
      );
    }
    // Off by default.
    assert.equal(code(await report()), "HEALTH_DISABLED");
    await sql(
      "a",
      "UPDATE workspace_features SET enabled=true WHERE workspace_id='a' AND name='knowledge_health_v1'",
    );
    assert.equal((await report("a", "agent-1-a")).status, 403);

    const refund =
      "Refunds go back to the card you paid with within five working days of approval.";
    await publish("a", "refunds", "Refunds", refund, { daysAgo: 200 });
    await publish(
      "a",
      "refunds-copy",
      "Refunds",
      refund.replace("of approval", "after approval"),
      { daysAgo: 150 },
    );
    await publish(
      "a",
      "shipping",
      "Shipping",
      "Parcels ship by courier the next working day and arrive within three days.",
      { daysAgo: 120 },
    );
    await publish(
      "a",
      "new",
      "Gift cards",
      "Gift cards never expire and can be used online.",
      {},
    );
    await publish("a", "hidden", "Old promo", "Summer promotion codes.", {
      forAi: false,
      forInbox: false,
      daysAgo: 300,
    });
    // Nothing indexed yet: no counting, and duplicates wait for the index.
    let r = (await report()).body;
    assert.equal(r.neverReviewed.total, 5);
    assert.equal(r.notRetrieved.countingSince, null);
    assert.deepEqual(r.duplicates.available, false);
    assert.match(r.duplicates.reason, /hasn't finished building/);
    assert.equal(r.gaps.available, false);
    assert.equal(
      code(await agent("knowledge-health", { action: "check" })),
      "INDEX_NOT_READY",
    );

    // Index, then: counting starts with the first index.
    await scheduleIndex(db.connect, "a");
    assert.equal(await drain("knowledge.index"), "idle");
    r = (await report()).body;
    assert.ok(r.notRetrieved.countingSince);
    // Counting began today, so nothing is listed yet, and the page says from when.
    assert.equal(r.notRetrieved.total, 0);
    assert.equal(
      new Date(r.notRetrieved.listedFrom).getTime() -
        new Date(r.notRetrieved.countingSince).getTime(),
      90 * 86_400_000,
    );
    // 100 days of counting: old usable content without a retrieval in 90 days is listed.
    await sql(
      "a",
      "UPDATE knowledge_index_generations SET activated_at=now()-interval '100 days'",
    );
    await sql(
      "a",
      `INSERT INTO knowledge_retrievals(workspace_id,record_id,day,purpose,count) VALUES
       ('a','refunds',(now() AT TIME ZONE 'UTC')::date-10,'ai',3),
       ('a','shipping',(now() AT TIME ZONE 'UTC')::date-95,'inbox',1)`,
    );
    r = (await report()).body;
    assert.deepEqual(
      r.notRetrieved.records.map((x: any) => [
        x.id,
        x.lastRetrievedOn,
        x.usedBy,
      ]),
      [
        // Never retrieved first; "new" is too recent; "hidden" can't be retrieved at all.
        ["refunds-copy", null, ["ai", "inbox"]],
        [
          "shipping",
          r.notRetrieved.records[1].lastRetrievedOn,
          ["ai", "inbox"],
        ],
      ],
    );
    assert.ok(r.notRetrieved.records[1].lastRetrievedOn);

    // Never reviewed, until marked.
    assert.equal(
      (await agent("knowledge", { op: "review", id: "shipping" })).status,
      200,
    );
    r = (await report()).body;
    assert.equal(r.neverReviewed.total, 4);
    assert(!r.neverReviewed.records.some((x: any) => x.id === "shipping"));

    // Near-duplicates: a check started once for a retried key, resumed after a failure.
    const key = crypto.randomUUID();
    const started = await agent(
      "knowledge-health",
      { action: "check" },
      "owner-a",
      "a",
      key,
    );
    assert.equal(started.status, 200);
    assert.equal(started.body.started, true);
    assert.deepEqual(
      (
        await agent(
          "knowledge-health",
          { action: "check" },
          "owner-a",
          "a",
          key,
        )
      ).body,
      started.body,
    );
    // A second check while one runs returns the running one.
    assert.deepEqual(
      (await agent("knowledge-health", { action: "check" })).body,
      { runId: started.body.runId, started: false },
    );
    failing.query = 1;
    assert.equal(await drain("knowledge.duplicates"), "retrying");
    r = (await report()).body;
    assert.equal(
      r.duplicates.running.checked,
      0,
      "nothing recorded by the failed step",
    );
    assert.equal(await drain("knowledge.duplicates"), "idle");
    r = (await report()).body;
    assert.equal(r.duplicates.running, null);
    assert.equal(r.duplicates.last.status, "done");
    assert.equal(r.duplicates.threshold, DUPLICATE_SIMILARITY);
    assert.deepEqual(
      r.duplicates.pairs.map((x: any) => [x.a.id, x.b.id]),
      [["refunds", "refunds-copy"]],
    );
    assert(r.duplicates.pairs[0].similarity >= DUPLICATE_SIMILARITY);
    // Other pairs score below the threshold.
    const [shipping] = await sql<{ vector_id: string; generation_id: string }>(
      "a",
      "SELECT vector_id,generation_id FROM knowledge_chunk_vectors WHERE record_id='shipping'",
    );
    const [vec] = await store.get(shipping.generation_id, [shipping.vector_id]);
    const near = await store.query(shipping.generation_id, vec.values, 3);
    assert(near[1].score < DUPLICATE_SIMILARITY);

    // Dismissed: hidden, until either record publishes a change.
    assert.equal(
      (
        await agent("knowledge-health", {
          action: "dismiss",
          recordA: "refunds-copy",
          recordB: "refunds",
        })
      ).status,
      200,
    );
    assert.deepEqual((await report()).body.duplicates.pairs, []);
    await sql(
      "a",
      "UPDATE knowledge_locales SET published_at=now()+interval '1 second' WHERE record_id='refunds-copy'",
    );
    assert.equal((await report()).body.duplicates.pairs.length, 1);
    assert.equal(
      code(
        await agent("knowledge-health", {
          action: "dismiss",
          recordA: "refunds",
          recordB: "refunds",
        }),
      ),
      "INVALID_PAIR",
    );

    // Nightly: once in 20 hours.
    await sql(
      "a",
      "UPDATE knowledge_duplicate_runs SET started_at=now()-interval '1 day'",
    );
    const nightly = await scheduleDuplicateCheck(db.connect, "a");
    assert.ok(nightly);
    assert.equal(await scheduleDuplicateCheck(db.connect, "a"), null);
    // The previous finished check stays visible while the new one runs.
    r = (await report()).body;
    assert.equal(r.duplicates.running.id, nightly);
    assert.equal(r.duplicates.pairs.length, 1);
    // A check whose job is gone shows as stopped, and doesn't block the next.
    await sql(
      "a",
      "UPDATE jobs SET state='dead_letter' WHERE kind='knowledge.duplicates' AND state IN ('queued','running')",
    );
    r = (await report()).body;
    assert.equal(r.duplicates.running, null);
    assert.match(r.duplicates.last.error, /stopped unexpectedly/);
    const again = await agent("knowledge-health", { action: "check" });
    assert.equal(again.body.started, true);
    // A check outlived by its index version ends as failed.
    await sql("a", "UPDATE knowledge_index_generations SET status='retired'");
    assert.equal(await drain("knowledge.duplicates"), "idle");
    assert.equal(
      (
        await sql(
          "a",
          "SELECT status,error FROM knowledge_duplicate_runs WHERE id=$1",
          [again.body.runId],
        )
      )[0].error,
      "The AI index changed during the check. Check again.",
    );
    await sql("a", "UPDATE knowledge_index_generations SET status='active'");

    // Kept to the workspace.
    await sql(
      "b",
      "UPDATE workspace_features SET enabled=true WHERE workspace_id='b' AND name='knowledge_health_v1'",
    );
    r = (await report("b")).body;
    assert.equal(r.neverReviewed.total, 0);
    assert.equal(r.notRetrieved.countingSince, null);
    assert.equal(
      code(
        await agent(
          "knowledge-health",
          { action: "dismiss", recordA: "refunds", recordB: "shipping" },
          "owner-b",
          "b",
        ),
      ),
      "RECORD_NOT_FOUND",
    );
    assert.equal((await report("b", "owner-a")).status, 403);
    assert.equal(
      (
        await sql(
          "b",
          "SELECT count(*)::int AS n FROM knowledge_duplicate_runs",
        )
      )[0].n,
      0,
    );
    // With the AI index off, the duplicate section says why and "Check now" is refused.
    await sql(
      "a",
      "UPDATE workspace_features SET enabled=false WHERE workspace_id='a' AND name='knowledge_index_v1'",
    );
    r = (await report()).body;
    assert.equal(r.duplicates.available, false);
    assert.match(r.duplicates.reason, /which is off/);
    assert.equal(
      code(await agent("knowledge-health", { action: "check" })),
      "INDEX_DISABLED",
    );
  } finally {
    await db.close();
  }
});
