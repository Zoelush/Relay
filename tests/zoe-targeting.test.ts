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
import {
  standInAnswerModel,
  standInClassifier,
  standInReranker,
} from "../server/ai-model";
import { runAiReply, type AiEnvironment } from "../server/ai-agent";
import { runSync } from "../server/knowledge-sync";
import { passes } from "../server/ai-targeting";
import { testSite } from "./fixtures/site";

/** Content targeting (phase 08, Z3b; docs/AI_STEP8.md). */
test("targeting: an item passes when it has no conditions, or its conditions hold (all or any)", () => {
  const facts = {
    signedIn: true,
    emailDomains: ["bigcorp.com"],
    brand: "default",
    language: "en",
    page: "https://shop.test/enterprise",
    tags: [],
    attributes: {},
  };
  assert.equal(passes({ match: "all", conditions: [] }, facts), true);
  const corp = { field: "email_domain" as const, op: "is" as const, value: "bigcorp.com" };
  const french = { field: "language" as const, op: "is" as const, value: "fr" };
  assert.equal(passes({ match: "all", conditions: [corp] }, facts), true);
  assert.equal(passes({ match: "all", conditions: [corp, french] }, facts), false);
  assert.equal(passes({ match: "any", conditions: [corp, french] }, facts), true);
  assert.equal(passes({ match: "all", conditions: [corp] }, { ...facts, emailDomains: [] }), false);
});

test("Zoe uses targeted content only for customers who match it, on records and whole websites, before ranking; teammates see what she skipped", async () => {
  const db = await testDatabase();
  const site = await testSite();
  site.routes.set("/robots.txt", { type: "text/plain", body: "User-agent: *\nAllow: /\n" });
  site.page("/", "Developer docs", '<p>Our developer docs.</p><a href="/limits">Limits</a>');
  site.page("/limits", "Rate limits", "<p>The API rate limit is one hundred requests per minute.</p>");
  const index: IndexEnvironment = { embedders: [testEmbedder()], vectors: memoryVectorStore() };
  const ai: AiEnvironment = {
    model: standInAnswerModel(),
    rerank: standInReranker(),
    index,
    classify: standInClassifier(),
  };
  const sync = { policy: { allowHosts: [site.host] } };
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    knowledgeIndex: index,
    ai,
    sync,
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "knowledge.index": (job: Job) => runIndex(db.connect, index, job),
    "ai.reply": (job: Job) => runAiReply(db.connect, ai, job),
    "knowledge.sync.run": (job: Job) => runSync(db.connect, sync, job),
  };
  const drain = async (kind: string, w = "a") => {
    for (let i = 0; i < 200; i++) {
      const job = (
        await sql<{ id: string }>(
          w,
          "SELECT id FROM jobs WHERE kind=$1 AND state IN ('queued','running') ORDER BY created_at LIMIT 1",
          [kind],
        )
      )[0];
      if (!job) return;
      await runJob(db.connect, w, job.id, handlers);
    }
  };
  const agent = async (
    path: string,
    data?: unknown,
    principal = "owner-a",
    workspace = "a",
  ) => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
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
  const ask = (question: string, more: Record<string, unknown> = {}, w = "a") =>
    agent("zoe-playground", { question, ...more }, "owner-" + w, w);
  const record = async (id: string, w = "a") =>
    (await agent("knowledge-record?id=" + id, undefined, "owner-" + w, w)).body;
  const settle = async (id: string, change: Record<string, unknown>, w = "a") =>
    agent("knowledge", { op: "settings", id, version: (await record(id, w)).version, ...change }, "owner-" + w, w);
  const writes = async () =>
    (
      await sql<{ parts: number; answers: number }>(
        "a",
        "SELECT (SELECT count(*) FROM conversation_parts)::int AS parts,(SELECT count(*) FROM ai_answers)::int AS answers",
      )
    )[0];
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
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name IN ('knowledge_v1','knowledge_index_v1','ai_agent_v1','settings_v1','knowledge_sync_v1')",
        [w],
      );
      await sql(w, "DELETE FROM calendar_assignments");
      await sql(
        w,
        `INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_help_center) VALUES
         ($1,'enterprise','article','owner','public',true,false),($1,'refunds','article','owner','public',true,false)`,
        [w],
      );
      await sql(
        w,
        `INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,published_title,published_text,published_revision,published_at) VALUES
         ($1,'enterprise','en','published','Enterprise support','Enterprise support','Enterprise customers get a dedicated support manager.',1,now()),
         ($1,'refunds','en','published','Refunds','Refunds','Refunds take five working days to reach the card you paid with.',1,now())`,
        [w],
      );
    }
    await sql("a", "INSERT INTO brands(workspace_id,id,name) VALUES('a','acme','Acme')");

    // Checked like an escalation rule's conditions, named after the item.
    for (const [conditions, reason] of [
      [[{ field: "brand", op: "is", value: "nope" }], /“Enterprise support”: choose one of your brands/],
      [[{ field: "email_domain", op: "is", value: "" }], /“Enterprise support”: give an email domain/],
      [Array.from({ length: 11 }, () => ({ field: "signed_in", op: "is", value: true })), /one to ten conditions/],
    ] as const) {
      const r = await settle("enterprise", { aiMatch: "all", aiConditions: conditions });
      assert.equal(r.status, 400, JSON.stringify(conditions));
      assert.match(r.body.error.message, reason);
    }
    assert.deepEqual((await record("enterprise")).aiConditions, []);

    // Enterprise support: only for customers with a bigcorp.com address.
    const saved = await settle("enterprise", {
      aiMatch: "all",
      aiConditions: [{ field: "email_domain", op: "is", value: "BigCorp.com" }],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const enterprise = await record("enterprise");
    assert.deepEqual(enterprise.aiConditions, [{ field: "email_domain", op: "is", value: "bigcorp.com" }]);
    assert.deepEqual(
      enterprise.targetingChoices.brands.map((b: any) => b.id).sort(),
      ["acme", "default"],
    );
    // Saving other settings leaves it as it is.
    await settle("enterprise", { forInbox: false });
    assert.equal((await record("enterprise")).aiConditions.length, 1);

    // A whole website, signed-in customers only: its pages get it as they sync, and keep it.
    const created = await agent("knowledge-sources", {
      op: "create",
      url: site.origin + "/",
      locale: "en",
      audience: "public",
      forAi: true,
      aiMatch: "all",
      aiConditions: [{ field: "signed_in", op: "is", value: true }],
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    await drain("knowledge.sync.run");
    const pages = await sql<{ id: string; ai_conditions: unknown[] }>(
      "a",
      "SELECT r.id,r.ai_conditions FROM knowledge_records r JOIN knowledge_source_pages g ON g.workspace_id=r.workspace_id AND g.record_id=r.id WHERE g.source_id=$1",
      [created.body.id],
    );
    assert.equal(pages.length, 2);
    assert.ok(pages.every((p) => p.ai_conditions.length === 1));
    const source = (await agent("knowledge-source?id=" + created.body.id)).body;
    assert.deepEqual(source.aiConditions, [{ field: "signed_in", op: "is", value: true }]);
    for (const w of ["a", "b"]) {
      await scheduleIndex(db.connect, w);
      await drain("knowledge.index", w);
    }

    // The Playground: a visitor doesn't get either; Zoe says which she skipped. Nothing is written.
    const before = await writes();
    const visitor = await ask("Do enterprise customers get a dedicated support manager?");
    assert.equal(visitor.status, 200, JSON.stringify(visitor.body));
    assert.equal(visitor.body.outcome, "unknown");
    assert.deepEqual(visitor.body.skipped, {
      count: 3,
      titles: ["Developer docs", "Enterprise support", "Rate limits"],
    });
    const corp = await ask("Do enterprise customers get a dedicated support manager?", {
      signedIn: true,
      email: "ada@bigcorp.com",
    });
    assert.equal(corp.body.outcome, "answered");
    assert.deepEqual(corp.body.sources.map((s: any) => s.title), ["Enterprise support"]);
    assert.equal(corp.body.skipped.count, 0);
    const other = await ask("What is the API rate limit?", { signedIn: true, email: "bo@small.com" });
    assert.equal(other.body.outcome, "answered");
    assert.deepEqual(other.body.sources.map((s: any) => s.title), ["Rate limits"]);
    assert.deepEqual(other.body.skipped.titles, ["Enterprise support"]);
    // A specialist with all of Zoe's content still doesn't get it for a visitor.
    const specialist = await ask("Do enterprise customers get a dedicated support manager?", {
      specialist: { name: "Sales", handles: "Plans for companies.", knowledge: { all: true } },
    });
    assert.equal(specialist.body.outcome, "unknown");
    assert.equal(specialist.body.skipped.count, 3);
    assert.deepEqual(await writes(), before, "the Playground wrote nothing");

    // A real conversation records what was skipped; teammates see it in "Why this reply".
    const conversation = await tenant(db.connect, "a", async (q) => {
      const identity = await getIdentity(q, "a", "anonymous", "visitor-1");
      return (await command(
        q,
        "a",
        { type: "contact", identityId: identity.identityId, brandId: "default" },
        "start-key-1",
        { action: "start", text: "Do enterprise customers get a dedicated support manager?" },
      )) as { conversationId: string };
    });
    await drain("ai.reply");
    const [answer] = await sql<{ targeted_out: string[] }>(
      "a",
      "SELECT targeted_out FROM ai_answers WHERE conversation_id=$1",
      [conversation.conversationId],
    );
    assert.equal(answer.targeted_out.length, 3);
    assert.ok(answer.targeted_out.includes("enterprise"));
    const why = (await agent("ai-answers?conversation=" + conversation.conversationId)).body.answers[0];
    assert.equal(why.targetedOut.count, 3);
    assert.equal(why.targetedOut.titles.length, 3);

    // Zoe's Content page counts and describes it.
    const content = (await agent("zoe?view=content")).body;
    assert.equal(content.targeted, 3);
    assert.deepEqual(
      content.records.find((r: any) => r.recordId === "enterprise").targeting,
      { match: "all", conditions: [{ field: "email_domain", op: "is", value: "bigcorp.com" }] },
    );
    assert.deepEqual(content.records.find((r: any) => r.recordId === "refunds").targeting.conditions, []);

    // Changing the website's targeting changes every page; back to everyone, they're used again.
    const everyone = await agent("knowledge-sources", {
      op: "update",
      id: created.body.id,
      version: (await agent("knowledge-source?id=" + created.body.id)).body.version,
      aiMatch: "all",
      aiConditions: [],
    });
    assert.equal(everyone.status, 200, JSON.stringify(everyone.body));
    assert.ok(
      (
        await sql<{ ai_conditions: unknown[] }>(
          "a",
          "SELECT r.ai_conditions FROM knowledge_records r JOIN knowledge_source_pages g ON g.workspace_id=r.workspace_id AND g.record_id=r.id WHERE g.source_id=$1",
          [created.body.id],
        )
      ).every((p) => p.ai_conditions.length === 0),
    );
    assert.deepEqual((await ask("What is the API rate limit?")).body.skipped.titles, ["Enterprise support"]);

    // Another workspace: its own content, untouched; it can't name this one's brand.
    const theirs = await ask("Do enterprise customers get a dedicated support manager?", {}, "b");
    assert.equal(theirs.body.outcome, "answered");
    assert.equal(theirs.body.skipped.count, 0);
    const refused = await settle("enterprise", {
      aiConditions: [{ field: "brand", op: "is", value: "acme" }],
    }, "b");
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.message, /choose one of your brands/);
    assert.equal((await agent("knowledge-record?id=enterprise", undefined, "owner-b", "b")).body.aiConditions.length, 0);

    // Rolling back switches Zoe off for targeted content, rather than using it for everyone.
    const rollback = await readFile("db/rollback/0050_content_targeting.sql", "utf8");
    await tenant(db.connect, "a", () => db.pg.exec(rollback));
    assert.deepEqual(
      await sql<{ id: string; for_ai: boolean }>("a", "SELECT id,for_ai FROM knowledge_records WHERE id IN ('enterprise','refunds') ORDER BY id"),
      [
        { id: "enterprise", for_ai: false },
        { id: "refunds", for_ai: true },
      ],
    );
  } finally {
    await site.close();
    await db.close();
  }
});
