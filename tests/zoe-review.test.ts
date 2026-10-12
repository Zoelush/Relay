import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
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
import { standInAnswerModel, standInClassifier, standInReranker } from "../server/ai-model";
import { runAiReply, type AiEnvironment } from "../server/ai-agent";
import { sampleForReview } from "../server/zoe-review";

/** Zoe's review queue and content gaps (phase 08, C2a; docs/AI_STEP11.md). */
test("Zoe's review queue: pushbacks and a daily sample, rated once, bad content becoming gaps; managers only, per workspace", async () => {
  const db = await testDatabase();
  const index: IndexEnvironment = { embedders: [testEmbedder()], vectors: memoryVectorStore() };
  const ai: AiEnvironment = {
    model: standInAnswerModel(),
    rerank: standInReranker(),
    index,
    classify: standInClassifier(),
  };
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    knowledgeIndex: index,
    ai,
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "knowledge.index": (job: Job) => runIndex(db.connect, index, job),
    "ai.reply": (job: Job) => runAiReply(db.connect, ai, job),
  };
  const drain = async (kind: string, w = "a") => {
    for (let i = 0; i < 50; i++) {
      const job = (
        await sql<{ id: string }>(
          w,
          "SELECT id FROM jobs WHERE kind=$1 AND state IN ('queued','running') ORDER BY created_at LIMIT 1",
          [kind],
        )
      )[0];
      if (!job) return;
      const r = await runJob(db.connect, w, job.id, handlers);
      if (r.state === "queued" && !(r as { continued?: boolean }).continued) return;
    }
  };
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
      (r) => handleApi(r, env),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  let n = 0;
  const start = async (text: string, w = "a") => {
    const r = await tenant(db.connect, w, async (q) => {
      const identity = await getIdentity(q, w, "anonymous", "customer-" + ++n);
      const started = (await command(
        q,
        w,
        { type: "contact", identityId: identity.identityId, brandId: "default" },
        "start-key-" + n,
        { action: "start", text },
      )) as { conversationId: string };
      return { id: started.conversationId, identityId: identity.identityId };
    });
    await drain("ai.reply", w);
    return r;
  };
  const say = async (c: { id: string; identityId: string }, text: string, w = "a") => {
    await tenant(db.connect, w, (q) =>
      command(
        q,
        w,
        { type: "contact", identityId: c.identityId, brandId: "default" },
        "say-" + crypto.randomUUID(),
        { action: "reply", conversationId: c.id, text },
      ),
    );
    await drain("ai.reply", w);
  };
  const outcomes = (id: string, w = "a") =>
    sql<{ outcome: string; trigger: string | null }>(
      w,
      "SELECT outcome,trigger FROM ai_answers WHERE conversation_id=$1 ORDER BY created_at",
      [id],
    ).then((r) => r.map((x) => x.outcome + (x.trigger ? ":" + x.trigger : "")));
  const DAY = 86_400_000;
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
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name IN ('knowledge_v1','knowledge_index_v1','ai_agent_v1','knowledge_health_v1')",
        [w],
      );
      await sql(w, "DELETE FROM calendar_assignments");
      await sql(
        w,
        `INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_help_center) VALUES
         ($1,'refunds','article','owner','public',true,true),($1,'invoices','article','owner','public',true,true)`,
        [w],
      );
      await sql(
        w,
        `INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,published_title,published_text,published_revision,published_at) VALUES
         ($1,'refunds','en','published','Refunds','Refunds','Refunds take five working days to reach the card you paid with.',1,now()),
         ($1,'invoices','en','published','Invoices','Invoices','Invoices are emailed on the first day of each month.',1,now())`,
        [w],
      );
      await scheduleIndex(db.connect, w);
      await drain("knowledge.index", w);
    }
    await sql(
      "a",
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')",
    );

    // Off by default: no page, no sampling, nothing in the overview.
    assert.equal((await agent("zoe?view=review")).body.error.code, "REVIEW_DISABLED");
    assert.equal((await agent("zoe-review", { action: "sample", size: 5 })).status, 404);
    assert.equal((await agent("zoe?view=overview")).body.review, null);
    assert.equal((await agent("zoe?view=gaps")).body.reviewed, null);

    // Answers to review: one the customer pushed back on (asked for a person straight after), one
    // met by an upset customer, and three that went quietly.
    const pushed = await start("How long do refunds take?");
    await say(pushed, "Can I talk to a person?");
    assert.deepEqual(await outcomes(pushed.id), ["answered", "escalated:asked_for_person"]);
    const upset = await start("When are invoices emailed?");
    await say(upset, "This is ridiculous, absolutely useless and I'm furious.");
    assert.deepEqual(await outcomes(upset.id), ["answered", "escalated:negative_sentiment"]);
    const quiet = [];
    for (const q of ["How long do refunds take to reach my card?", "When do invoices arrive?", "Refund time?"])
      quiet.push(await start(q));
    for (const c of quiet) assert.deepEqual(await outcomes(c.id), ["answered"]);
    // A handover after a question she couldn't answer isn't a pushback on an answer.
    const unknown = await start("Do you sell tandem bikes?");
    await say(unknown, "Can I talk to a person?");
    assert.deepEqual(await outcomes(unknown.id), ["unknown", "escalated:asked_for_person"]);
    assert.deepEqual(await sampleForReview(db.connect, "a"), { pushbacks: 0, sampled: 0 });

    await sql("a", "UPDATE workspace_features SET enabled=true WHERE name='zoe_review_v1'");
    // Today isn't over, so only pushbacks join; again, nothing more.
    const first = await sampleForReview(db.connect, "a");
    assert.equal(first.pushbacks, 2);
    assert.deepEqual(await sampleForReview(db.connect, "a"), { pushbacks: 0, sampled: 0 });
    // Once today is over: a sample of two of the three quiet answers (pushbacks aren't sampled
    // again), once.
    await sql("a", "UPDATE ai_agents SET review_sample=2");
    const tomorrow = Date.now() + DAY;
    assert.deepEqual(await sampleForReview(db.connect, "a", tomorrow), { pushbacks: 0, sampled: 2 });
    assert.deepEqual(await sampleForReview(db.connect, "a", tomorrow), { pushbacks: 0, sampled: 0 });
    // Each sweep marks the day before it; yesterday had nothing to pick.
    assert.deepEqual(await sql("a", "SELECT sample,picked FROM ai_review_days ORDER BY day"), [
      { sample: 10, picked: 0 },
      { sample: 2, picked: 2 },
    ]);

    // The page: pushbacks first, with the question, her answer and its sources.
    const page = await agent("zoe?view=review");
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.equal(page.body.sample, 2);
    assert.equal(page.body.stats.waiting, 4);
    assert.deepEqual(
      page.body.pending.map((r: any) => [r.source, r.pushback]),
      [
        ["pushback", "asked_for_person"],
        ["pushback", "negative_sentiment"],
        ["sample", null],
        ["sample", null],
      ],
    );
    const top = page.body.pending[0];
    assert.equal(top.question, "How long do refunds take?");
    assert.match(top.answer, /five working days/);
    assert.deepEqual(top.sources, [{ id: "refunds", title: "Refunds" }]);
    assert.equal(top.conversationId, pushed.id);
    assert.deepEqual((await agent("zoe?view=overview")).body.review, { waiting: 4, gaps: 0 });

    // Managers only, and only their own workspace's answers.
    assert.equal((await agent("zoe?view=review", undefined, "agent-1-a")).status, 403);
    assert.equal(
      (await agent("zoe-review", { action: "rate", reviewId: top.id, rating: "good" }, "agent-1-a")).status,
      403,
    );
    await sql("b", "UPDATE workspace_features SET enabled=true WHERE name='zoe_review_v1'");
    const theirs = await agent("zoe?view=review", undefined, "owner-b", "b");
    assert.equal(theirs.status, 200);
    assert.deepEqual(theirs.body.pending, []);
    const across = await agent("zoe-review", { action: "rate", reviewId: top.id, rating: "good" }, "owner-b", "b");
    assert.equal(across.status, 404);
    assert.equal(across.body.error.code, "REVIEW_NOT_FOUND");

    // Rating: good or bad; bad says what was wrong; a note has a limit.
    const code = async (body: unknown) => (await agent("zoe-review", body)).body.error?.code;
    assert.equal(await code({ action: "rate", reviewId: top.id, rating: "fine" }), "INVALID_REVIEW");
    assert.equal(await code({ action: "rate", reviewId: top.id, rating: "bad" }), "INVALID_REVIEW");
    assert.equal(await code({ action: "rate", reviewId: top.id, rating: "bad", problem: "rude" }), "INVALID_REVIEW");
    assert.equal(
      await code({ action: "rate", reviewId: top.id, rating: "bad", problem: "wrong", note: "x".repeat(1001) }),
      "INVALID_REVIEW",
    );
    assert.equal(await code({ action: "rate", reviewId: "review_nope", rating: "good" }), "REVIEW_NOT_FOUND");

    // Bad for missing content: rated once (a replay returns the same; a second rating is refused),
    // and a content gap opens.
    const note = "We never say refunds go to a different card when the original is closed.";
    const rate = {
      action: "rate",
      reviewId: top.id,
      rating: "bad",
      problem: "missing_content",
      note,
    };
    const rated = await agent("zoe-review", rate, "owner-a", "a", "rate-top-key");
    assert.equal(rated.status, 200, JSON.stringify(rated.body));
    assert.deepEqual(
      (await agent("zoe-review", rate, "owner-a", "a", "rate-top-key")).body,
      rated.body,
    );
    const again = await agent("zoe-review", { ...rate, problem: "tone" });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "ALREADY_RATED");
    const done = rated.body.rated.find((r: any) => r.id === top.id);
    assert.equal(done.rating, "bad");
    assert.equal(done.problem, "missing_content");
    assert.equal(done.note, note);
    assert.equal(done.ratedBy, "Support teammate");
    assert.ok(done.gapId);
    assert.equal(rated.body.stats.waiting, 3);

    // A good rating, and a bad one that isn't the content's: no gap.
    const [upsetReview, sampled] = rated.body.pending;
    await agent("zoe-review", { action: "rate", reviewId: upsetReview.id, rating: "bad", problem: "tone" });
    const last = await agent("zoe-review", { action: "rate", reviewId: sampled.id, rating: "good" });
    assert.deepEqual(
      { ...last.body.stats, problems: last.body.stats.problems },
      {
        waiting: 1,
        rated: 3,
        good: 1,
        bad: 2,
        goodRate: 33.3,
        problems: [
          { problem: "missing_content", count: 1 },
          { problem: "tone", count: 1 },
        ],
      },
    );
    assert.deepEqual(await sql("a", "SELECT review_id FROM ai_content_gaps"), [{ review_id: top.id }]);

    // The gap: on Knowledge gaps, the Overview, and content health's topics.
    const gaps = (await agent("zoe?view=gaps")).body.reviewed;
    assert.equal(gaps.open.length, 1);
    const gap = gaps.open[0];
    assert.equal(gap.question, "How long do refunds take?");
    assert.equal(gap.problem, "missing_content");
    assert.equal(gap.note, note);
    assert.equal(gap.createdBy, "Support teammate");
    assert.deepEqual((await agent("zoe?view=overview")).body.review, { waiting: 1, gaps: 1 });
    const health = (await agent("knowledge-health")).body.gaps;
    assert.equal(health.available, true);
    assert.deepEqual(health.topics, [{ topic: "How long do refunds take?", conversations: 1, examples: [note] }]);
    assert.equal((await agent("knowledge-health", undefined, "owner-b", "b")).body.gaps.topics.length, 0);

    // Fixed (naming the content), by version; dismissed and reopened likewise.
    const move = (body: Record<string, unknown>, principal = "owner-a", w = "a") =>
      agent("zoe-review", { action: "gap", gapId: gap.id, ...body }, principal, w);
    assert.equal((await move({ version: gap.version, status: "closed" })).body.error.code, "INVALID_REVIEW");
    assert.equal((await move({ version: gap.version, status: "fixed", recordId: "nope" })).status, 404);
    assert.equal((await move({ version: gap.version, status: "fixed" }, "owner-b", "b")).body.error.code, "GAP_NOT_FOUND");
    const fixed = await move({ version: gap.version, status: "fixed", recordId: "refunds" });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.deepEqual(fixed.body.gaps, { open: [], fixed: 1 });
    assert.deepEqual(await sql("a", "SELECT status,record_id,resolved_by FROM ai_content_gaps"), [
      { status: "fixed", record_id: "refunds", resolved_by: "owner" },
    ]);
    assert.equal((await move({ version: gap.version, status: "dismissed" })).status, 409);
    const reopened = await move({ version: String(Number(gap.version) + 1), status: "open" });
    assert.equal(reopened.body.gaps.open.length, 1);
    assert.deepEqual(await sql("a", "SELECT status,record_id,resolved_at FROM ai_content_gaps"), [
      { status: "open", record_id: null, resolved_at: null },
    ]);
    assert.deepEqual((await agent("knowledge-health")).body.gaps.topics.length, 1);

    // The daily sample: 0 to 50; 0 stops it.
    assert.equal(await code({ action: "sample", size: 51 }), "INVALID_REVIEW");
    assert.equal(await code({ action: "sample", size: 2.5 }), "INVALID_REVIEW");
    assert.equal((await agent("zoe-review", { action: "sample", size: 0 })).body.sample, 0);
    await start("When are invoices emailed each month?");
    assert.deepEqual(await sampleForReview(db.connect, "a", tomorrow + DAY), { pushbacks: 0, sampled: 0 });

    // Reviews are internal: nothing reviewers wrote is in any conversation.
    assert.deepEqual(
      await sql("a", "SELECT id FROM conversation_parts WHERE body LIKE '%different card%'"),
      [],
    );

    // The rollback hides it everywhere; the ratings and gaps are kept.
    const rollback = await readFile("db/rollback/0052_zoe_review.sql", "utf8");
    await tenant(db.connect, "a", (q) => q.query(rollback));
    assert.deepEqual(await sql("a", "SELECT enabled FROM workspace_features WHERE name='zoe_review_v1'"), [
      { enabled: false },
    ]);
    assert.equal((await agent("zoe?view=review")).body.error.code, "REVIEW_DISABLED");
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM ai_reviews"))[0].n, 4);
  } finally {
    await db.close();
  }
});
