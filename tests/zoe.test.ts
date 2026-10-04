import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { runJob, type Job } from "../server/jobs";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { bootBrand, handleApi, type ApiEnvironment } from "../server/api";
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
import { processBrandAsset } from "../server/brand-assets";
import { localAttachmentStorage } from "../scripts/local-storage";
import { PNG_PIXEL } from "./fixtures/documents";

/** Zoe in the agent app (phase 08, Z1; docs/AI_STEP5.md). */
test("Zoe: her identity per brand, the Playground that writes nothing, and her pages' numbers, for managers and per workspace", async () => {
  const db = await testDatabase();
  const local = localAttachmentStorage();
  const index: IndexEnvironment = {
    embedders: [testEmbedder()],
    vectors: memoryVectorStore(),
  };
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
    attachments: local.storage,
    ai,
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "knowledge.index": (job: Job) => runIndex(db.connect, index, job),
    "ai.reply": (job: Job) => runAiReply(db.connect, ai, job),
    "messenger.asset.process": (job: Job) =>
      processBrandAsset(db.connect, local.storage, job),
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
      if (r.state === "queued" && !(r as { continued?: boolean }).continued)
        return;
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
  let n = 0;
  const start = async (text: string) => {
    const r = await tenant(db.connect, "a", async (q) => {
      const identity = await getIdentity(q, "a", "anonymous", "customer-" + ++n);
      return (await command(
        q,
        "a",
        { type: "contact", identityId: identity.identityId, brandId: "default" },
        "start-key-" + n,
        { action: "start", text },
      )) as { conversationId: string };
    });
    await drain("ai.reply");
    return r.conversationId;
  };
  const booted = (w = "a") =>
    tenant(db.connect, w, async (q) => {
      const b = (
        await q.query<{ id: string; name: string; settings: Record<string, unknown> }>(
          "SELECT id,name,settings FROM brands WHERE id='default'",
        )
      ).rows[0];
      return (await bootBrand(q, w, b, "https://relay.test")) as any;
    });
  const writes = async () =>
    (
      await sql<{ parts: number; answers: number; retrievals: number; ledger: number }>(
        "a",
        `SELECT (SELECT count(*) FROM conversation_parts)::int AS parts,(SELECT count(*) FROM ai_answers)::int AS answers,
           (SELECT coalesce(sum(count),0) FROM knowledge_retrievals)::int AS retrievals,(SELECT count(*) FROM ai_resolutions)::int AS ledger`,
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
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name IN ('knowledge_v1','knowledge_index_v1','ai_agent_v1','settings_v1')",
        [w],
      );
      await sql(w, "DELETE FROM calendar_assignments");
    }
    await sql(
      "a",
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')",
    );
    await sql(
      "a",
      "INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_help_center) VALUES('a','refunds','article','owner','public',true,false),('a','old','article','owner','public',false,false),('a','staff','internal_article','owner','internal',false,false)",
    );
    await sql(
      "a",
      `INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,published_title,published_text,published_revision,published_at) VALUES
       ('a','refunds','en','published','Refunds','Refunds','Refunds take five working days to reach the card you paid with.',1,now()),
       ('a','old','en','published','Old policy','Old policy','Refunds took ten days.',1,now()),
       ('a','staff','en','published','Staff','Staff','Internal only.',1,now())`,
    );
    await scheduleIndex(db.connect, "a");
    await drain("knowledge.index");

    // She's Zoe from the start; managers only.
    const settings = (await agent("ai-settings")).body;
    assert.equal(settings.agent.name, "Zoe");
    assert.equal(settings.agent.threshold, 0.5);
    assert.deepEqual(settings.identities, [
      {
        brandId: "default",
        brandName: settings.identities[0].brandName,
        name: "Zoe",
        avatar: "",
        avatarDark: "",
        disclosure: "",
        greeting: "",
      },
    ]);
    for (const path of ["zoe?view=overview", "zoe?view=content", "ai-settings"])
      assert.equal((await agent(path, undefined, "agent-1-a")).status, 403, path);
    assert.equal(
      (await agent("zoe-playground", { question: "Hi" }, "agent-1-a")).status,
      403,
    );
    // The inbox knows her name; only managers get her area.
    const inbox = (await agent("inbox")).body;
    assert.deepEqual(inbox.ai, { name: "Zoe", enabled: true, specialists: [] });
    assert.equal(inbox.capabilities.zoe, true);
    assert.equal((await agent("inbox", undefined, "agent-1-a")).body.capabilities.zoe, false);

    // Identity: checked, saved per brand; the default brand's name is hers everywhere.
    for (const [change, text] of [
      [{ name: "" }, /the name to 40 characters, and give it one/],
      [{ name: "x".repeat(41) }, /the name to 40 characters/],
      [{ disclosure: "x".repeat(201) }, /the AI disclosure to 200/],
      [{ greeting: "x".repeat(301) }, /the greeting to 300/],
      [{ avatar: "https://cdn.example.com/zoe.png" }, /Upload the avatar as an image/],
    ] as const) {
      const r = await agent(
        "zoe-identity",
        Object.assign({ brandId: "default", name: "Zoe" }, change),
      );
      assert.equal(r.status, 400, JSON.stringify(change));
      assert.match(r.body.error.message, text);
    }
    assert.equal(
      (await agent("zoe-identity", { brandId: "nope", name: "Zoe" })).status,
      404,
    );
    // An avatar is uploaded (the AI agent's own permission, not the messenger's drafts).
    const prepared = await agent("messenger-assets", {
      op: "prepare",
      brandId: "default",
      purpose: "agent_avatar",
      name: "zoe.png",
      type: "image/png",
      size: PNG_PIXEL.length,
    });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    await local.handle(
      new Request("https://relay.test" + prepared.body.url, {
        method: "PUT",
        headers: prepared.body.headers,
        body: PNG_PIXEL as BodyInit,
      }),
    );
    const done = await agent("messenger-assets", {
      op: "complete",
      assetId: prepared.body.assetId,
    });
    await runJob(db.connect, "a", done.body.jobId, handlers);
    const avatar = "asset:" + prepared.body.assetId;
    // In the wrong place (the dark slot) it's refused; in its own, saved.
    const misplaced = await agent("zoe-identity", {
      brandId: "default",
      name: "Zoe",
      avatarDark: avatar,
    });
    assert.match(misplaced.body.error.message, /dark-theme avatar isn't available/);
    const saved = await agent("zoe-identity", {
      brandId: "default",
      name: "Ada",
      avatar,
      disclosure: "I'm Ada, an AI agent.",
      greeting: "Hello! Ask me anything about your order.",
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await agent("ai-settings")).body.agent.name, "Ada");
    // The messenger's boot: her name, Relay's address for the avatar, and the disclosure.
    const boot = await booted();
    assert.deepEqual(boot.agent, {
      name: "Ada",
      avatar: `https://relay.test/v1/messenger/brand-asset?w=a&id=${prepared.body.assetId}`,
      avatarDark: "",
      disclosure: "I'm Ada, an AI agent.",
    });
    const served = await handleApi(new Request(boot.agent.avatar), env);
    assert.equal(served.status, 200);
    // Her greeting in the brand's language; other languages get the built-in one.
    const hello = await start("Hi!");
    const [greeting] = await sql<{ body: string }>(
      "a",
      "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='ai_reply'",
      [hello],
    );
    assert.equal(greeting.body, "Hello! Ask me anything about your order.");
    // Off: no identity in the boot.
    await sql("a", "UPDATE ai_agents SET enabled=false");
    assert.equal((await booted()).agent, undefined);
    await sql("a", "UPDATE ai_agents SET enabled=true");

    // The Playground: the real decision, and nothing written.
    const before = await writes();
    const answered = await agent("zoe-playground", {
      question: "How long do refunds take?",
      brandId: "default",
    });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body.outcome, "answered");
    assert.match(answered.body.reply, /five working days/);
    assert.deepEqual(answered.body.sources, [{ title: "Refunds" }]);
    assert.ok(answered.body.confidence >= answered.body.threshold);
    assert.equal(answered.body.candidates[0].title, "Refunds");
    assert.equal(answered.body.candidates[0].used, true);
    const unknown = await agent("zoe-playground", {
      question: "Do you sell gift vouchers for horses?",
    });
    assert.equal(unknown.body.outcome, "unknown");
    assert.deepEqual(unknown.body.options, ["Talk to a person"]);
    // A rule on a signed-in customer's email domain hands over.
    await agent("ai-settings", {
      ...(await agent("ai-settings")).body.agent,
      rules: [
        {
          name: "Big Corp",
          enabled: true,
          match: "all",
          conditions: [
            { field: "signed_in", op: "is", value: true },
            { field: "email_domain", op: "is", value: "bigcorp.com" },
          ],
        },
      ],
      version: (await agent("ai-settings")).body.agent.version,
    });
    const ruled = await agent("zoe-playground", {
      question: "How long do refunds take?",
      signedIn: true,
      email: "ada@bigcorp.com",
    });
    assert.equal(ruled.body.outcome, "escalated");
    assert.equal(ruled.body.trigger, "rule");
    assert.equal(
      ruled.body.reply,
      "I'm connecting you with someone from the team. They'll reply here.",
    );
    // The greeting comes from her identity here too.
    assert.equal(
      (await agent("zoe-playground", { question: "Hi!" })).body.reply,
      "Hello! Ask me anything about your order.",
    );
    assert.equal(
      (await agent("zoe-playground", { question: "Hi!", locale: "fr" })).body.reply,
      "Bonjour ! Comment puis-je vous aider ?",
    );
    assert.deepEqual(await writes(), before, "the Playground wrote nothing");
    assert.equal((await agent("zoe-playground", { question: "  " })).status, 400);

    // Her pages' numbers: two answers, one handover, gaps grouped, the article she leans on.
    await start("How long do refunds take?");
    const gap1 = await start("Do you sell gift vouchers for horses?");
    await start("do you sell  gift vouchers for horses?");
    await start("Can I talk to a human?");
    const overview = (await agent("zoe?view=overview")).body;
    assert.equal(overview.agent.name, "Ada");
    assert.equal(overview.stats.handovers, 1);
    assert.equal(overview.stats.answers, 4); // the greeting, the answer, and two she couldn't give
    assert.equal(overview.stats.involved, 5);
    assert.equal(overview.stats.resolutionRate, 0);
    assert.deepEqual(overview.escalation, { rules: 1, topics: 0, guidance: 0 });
    assert.equal(overview.content, 1, "switched-off and internal content isn't hers");
    assert.equal(overview.gaps[0].count, 2);
    assert.match(overview.gaps[0].question, /gift vouchers for horses/i);
    assert.equal(overview.gaps[0].conversationId !== gap1, true, "the latest asking");
    assert.deepEqual(overview.articles, [
      { recordId: "refunds", title: "Refunds", source: "article", count: 1 },
    ]);
    const performance = (await agent("zoe?view=performance")).body;
    assert.equal(performance.outcomes.answered, 1);
    assert.equal(performance.outcomes.unknown, 2);
    assert.equal(performance.outcomes.escalated, 1);
    assert.deepEqual(performance.triggers, [{ trigger: "asked_for_person", count: 1 }]);
    const content = (await agent("zoe?view=content")).body;
    assert.deepEqual(
      content.records.map((r: any) => [r.recordId, r.used]),
      [["refunds", 1]],
    );
    assert.deepEqual(content.excluded, { switchedOff: 2, internal: 1 });
    const deploy = (await agent("zoe?view=deploy")).body;
    assert.deepEqual(
      deploy.brands.map((b: any) => [b.brandId, b.identity]),
      [["default", "Ada"]],
    );
    assert.equal((await agent("zoe?view=gaps")).body.gaps.length, 1);

    // Another workspace: her own name, no numbers, none of this one's content.
    const other = (await agent("zoe?view=overview", undefined, "owner-b", "b")).body;
    assert.equal(other.agent.name, "Zoe");
    assert.deepEqual(other.stats, {
      resolutionRate: null,
      resolutions: 0,
      involved: 0,
      answers: 0,
      handovers: 0,
      confidence: null,
    });
    assert.deepEqual(other.gaps, []);
    const theirs = await agent(
      "zoe-playground",
      { question: "How long do refunds take?" },
      "owner-b",
      "b",
    );
    assert.equal(theirs.body.outcome, "unknown");
    assert.equal((await booted("b")).agent.name, "Zoe");
    // A's avatar can't be used by B.
    const stolen = await agent(
      "zoe-identity",
      { brandId: "default", name: "Zoe", avatar },
      "owner-b",
      "b",
    );
    assert.equal(stolen.status, 400);
    // Off for the workspace: no area, no boot identity.
    await sql("b", "UPDATE workspace_features SET enabled=false WHERE name='ai_agent_v1'");
    assert.equal((await agent("zoe?view=overview", undefined, "owner-b", "b")).status, 404);
    assert.equal((await agent("inbox", undefined, "owner-b", "b")).body.ai, null);
    assert.equal((await booted("b")).agent, undefined);
  } finally {
    await db.close();
  }
});
