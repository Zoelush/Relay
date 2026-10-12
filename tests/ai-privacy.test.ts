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
  type AnswerModel,
  type AnswerRequest,
  type RerankPort,
} from "../server/ai-model";
import { runAiReply, type AiEnvironment } from "../server/ai-agent";
import { purgeModelCalls, redactor } from "../server/ai-privacy";

/** Zoe's privacy: redaction, the record of model calls, and memory (phase 08, B2b; docs/AI_STEP9.md). */
test("redaction: personal data becomes placeholders, the same value the same one, and the customer's own values come back", () => {
  const r = redactor(true, ["Ada Lovelace", "Lovelace"]);
  const sent = r.redact(
    "I'm Ada Lovelace (ada@lovelace.example, ADA@lovelace.example), card 4111 1111 1111 1111, IBAN GB82 WEST 1234 5698 7654 32, from 192.168.4.20, phone +44 20 7946 0958, on 2026-10-12, order 48213.",
  );
  assert.equal(
    sent,
    "I'm [name] ([email 1], [email 1]), card [card 1], IBAN [iban 1], from [ip 1], phone [phone 1], on 2026-10-12, order 48213.",
  );
  assert.deepEqual(r.counts(), { name: 1, email: 1, card: 1, iban: 1, ip: 1, phone: 1 });
  assert.equal(r.restore("Thanks [name], we'll write to [email 1]."), "Thanks Ada Lovelace, we'll write to ada@lovelace.example.");
  // An unknown placeholder stays as it is; off, nothing changes.
  assert.equal(r.restore("[email 9]"), "[email 9]");
  const off = redactor(false, ["Ada"]);
  assert.equal(off.redact("Ada, ada@x.example"), "Ada, ada@x.example");
  assert.deepEqual(off.counts(), {});
});

test("privacy settings: redaction before the model, every call recorded for managers for 90 days, and memory for signed-in customers only", async () => {
  const db = await testDatabase();
  const index: IndexEnvironment = { embedders: [testEmbedder()], vectors: memoryVectorStore() };
  const seen: AnswerRequest[] = [];
  const base = standInAnswerModel();
  // The stand-in, recording what it was given, and echoing the customer's placeholders back.
  const spy: AnswerModel = {
    model: "spy",
    async answer(r) {
      seen.push(r);
      const reply = await base.answer(r);
      const placeholder = r.question.match(/\[email \d+\]/)?.[0];
      return reply.kind === "answer" && placeholder
        ? { ...reply, sentences: [...reply.sentences, { text: `We'll write to ${placeholder}.`, sources: reply.sentences[0].sources }] }
        : reply;
    },
  };
  const rerank: RerankPort = { model: "fixed", score: async (_q, texts) => texts.map(() => 0.9) };
  const ai: AiEnvironment = { model: spy, rerank, index, classify: standInClassifier() };
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
      await runJob(db.connect, w, job.id, handlers);
    }
  };
  const agent = async (path: string, data?: unknown, principal = "owner-a", workspace = "a") => {
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
  /** A customer writes: signed in (with a verified email and a name) or a visitor. */
  const start = async (text: string, who: { user?: string; name?: string; email?: string } = {}) => {
    const c = await tenant(db.connect, "a", async (q) => {
      const identity = await getIdentity(
        q,
        "a",
        who.user ? "user" : "anonymous",
        who.user ?? "visitor-" + ++n,
        who.user ? { name: who.name, email: who.email } : {},
      );
      const r = (await command(
        q,
        "a",
        { type: "contact", identityId: identity.identityId, brandId: "default" },
        "start-key-" + ++n,
        { action: "start", text },
      )) as { conversationId: string };
      return { id: r.conversationId, identityId: identity.identityId };
    });
    await drain("ai.reply");
    return c;
  };
  const settings = async (change: Record<string, unknown>) => {
    const current = (await agent("ai-settings")).body;
    return agent("ai-settings", { ...current.agent, ...change, version: current.agent.version });
  };
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
      "INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_help_center) VALUES('a','refunds','article','owner','public',true,false)",
    );
    await sql(
      "a",
      `INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,published_title,published_text,published_revision,published_at) VALUES
       ('a','refunds','en','published','Refunds','Refunds','Refunds take five working days to reach the card you paid with.',1,now())`,
    );
    await scheduleIndex(db.connect, "a");
    await drain("knowledge.index");

    // Both off to start with; managers switch them on.
    const initial = (await agent("ai-settings")).body.agent;
    assert.deepEqual([initial.redactPersonalData, initial.memory], [false, false]);
    const message =
      "I'm Ada Lovelace, my card 4111 1111 1111 1111 was charged twice. Write to ada@lovelace.example. How long do refunds take?";

    // Off: what was sent is recorded as it was.
    const plain = await start(message, { user: "ada-1", name: "Ada Lovelace", email: "ada@lovelace.example" });
    const [plainCall] = await sql<{ sent: string; redacted: boolean }>(
      "a",
      "SELECT sent,redacted FROM ai_model_calls WHERE conversation_id=$1 AND kind='answer'",
      [plain.id],
    );
    assert.equal(plainCall.redacted, false);
    assert.match(plainCall.sent, /ada@lovelace\.example/);

    const on = await settings({ redactPersonalData: true, memory: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.deepEqual([on.body.agent.redactPersonalData, on.body.agent.memory], [true, true]);

    // On: neither model is sent the customer's details; she still answers, with them put back.
    seen.length = 0;
    const redacted = await start(message, { user: "ada-1", name: "Ada Lovelace", email: "ada@lovelace.example" });
    const calls = await sql<{ kind: string; sent: string; redacted: boolean; redactions: Record<string, number> }>(
      "a",
      "SELECT kind,sent,redacted,redactions FROM ai_model_calls WHERE conversation_id=$1 ORDER BY kind",
      [redacted.id],
    );
    assert.deepEqual(calls.map((c) => c.kind), ["answer", "classify"]);
    for (const c of calls) {
      assert.equal(c.redacted, true);
      assert.ok(!/Lovelace|4111|ada@lovelace/.test(c.sent), c.sent);
      assert.match(c.sent, /\[name\]/);
      assert.match(c.sent, /\[email 1\]/);
      assert.match(c.sent, /\[card 1\]/);
      assert.deepEqual(c.redactions, { name: 1, card: 1, email: 1 });
    }
    assert.ok(!JSON.stringify(seen).includes("ada@lovelace.example"));
    const [reply] = await sql<{ body: string }>(
      "a",
      "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='ai_reply'",
      [redacted.id],
    );
    assert.match(reply.body, /Refunds take five working days/);
    assert.match(reply.body, /We'll write to ada@lovelace\.example\./);

    // Memory: her earlier conversations (public messages only) were given to her, and recorded.
    assert.equal(seen.length, 1);
    assert.deepEqual(
      seen[0].memory!.map((m) => m.turns[0].text),
      ["I'm [name], my card [card 1] was charged twice. Write to [email 1]. How long do refunds take?"],
    );
    const [answer] = await sql<{ remembered: string[] }>(
      "a",
      "SELECT remembered FROM ai_answers WHERE conversation_id=$1",
      [redacted.id],
    );
    assert.deepEqual(answer.remembered, [plain.id]);
    // A visitor gets no memory, even with earlier conversations from the same browser.
    seen.length = 0;
    const visitor = await start("How long do refunds take?", {});
    await tenant(db.connect, "a", (q) =>
      command(
        q,
        "a",
        { type: "contact", identityId: visitor.identityId, brandId: "default" },
        "visitor-second",
        { action: "start", text: "And for gift cards, how long do refunds take?" },
      ),
    );
    await drain("ai.reply");
    assert.ok(seen.every((r) => !r.memory?.length));
    // Another signed-in customer never gets Ada's conversations.
    seen.length = 0;
    await start("How long do refunds take?", { user: "bo-1", name: "Bo Martin", email: "bo@other.example" });
    assert.deepEqual(seen[0].memory, []);

    // "Why this reply": what was sent, for managers only; what she remembered.
    const why = (await agent("ai-answers?conversation=" + redacted.id)).body.answers[0];
    assert.equal(why.remembered, 1);
    assert.deepEqual(why.sent.map((c: any) => c.kind), ["classify", "answer"]);
    assert.match(why.sent[1].sent, /\[email 1\]/);
    const asAgent = (await agent("ai-answers?conversation=" + redacted.id, undefined, "agent-1-a")).body.answers[0];
    assert.equal(asAgent.sent, null);
    // The Playground shows what would be sent, and records nothing.
    const calls0 = (await sql<{ n: number }>("a", "SELECT count(*)::int AS n FROM ai_model_calls"))[0].n;
    const tried = (await agent("zoe-playground", { question: "My email is x@y.example. How long do refunds take?" })).body;
    assert.match(tried.sent.find((c: any) => c.kind === "answer").sent, /\[email 1\]/);
    assert.equal((await sql<{ n: number }>("a", "SELECT count(*)::int AS n FROM ai_model_calls"))[0].n, calls0);

    // Kept 90 days.
    await sql(
      "a",
      "INSERT INTO ai_model_calls(workspace_id,id,conversation_id,question_part_id,kind,model,sent,redacted,created_at) VALUES('a','old',$1,'q','answer','x','old text',false,now()-interval '91 days')",
      [plain.id],
    );
    assert.equal(await purgeModelCalls(db.connect, "a"), 1);
    assert.equal((await sql("a", "SELECT 1 FROM ai_model_calls WHERE id='old'")).length, 0);
    assert.ok((await sql("a", "SELECT 1 FROM ai_model_calls")).length > 0, "recent calls are kept");

    // Another workspace: its own settings, none of these calls, and no reading them.
    assert.equal((await agent("ai-settings", undefined, "owner-b", "b")).body.agent.redactPersonalData, false);
    assert.equal((await sql("b", "SELECT 1 FROM ai_model_calls")).length, 0);
    assert.equal((await agent("ai-answers?conversation=" + redacted.id, undefined, "owner-b", "b")).status, 404);

    // Rolling back can't redact, so a workspace that redacts has its agent switched off.
    const rollback = await readFile("db/rollback/0051_ai_safety_privacy.sql", "utf8");
    await tenant(db.connect, "a", () => db.pg.exec(rollback));
    assert.equal((await sql<{ enabled: boolean }>("a", "SELECT enabled FROM ai_agents"))[0].enabled, false);
    assert.equal((await sql<{ enabled: boolean }>("b", "SELECT enabled FROM ai_agents"))[0]?.enabled ?? true, true);
  } finally {
    await db.close();
  }
});
