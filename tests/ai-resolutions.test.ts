import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command, conversation } from "../server/conversations";
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
import {
  recordResolution,
  resolveQuiet,
  reverseOnHandover,
  standing,
} from "../server/ai-resolutions";

/** The resolution ledger (phase 08, A3; docs/AI_STEP4.md). */
test("resolutions are recorded when the customer confirms or goes quiet after an answer, never otherwise; the ledger is append-only, reversed by an early handover, and kept per workspace", async () => {
  const db = await testDatabase();
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
  type Customer = { id: string; identityId: string };
  let n = 0;
  const start = async (text: string): Promise<Customer> => {
    const r = await tenant(db.connect, "a", async (q) => {
      const identity = await getIdentity(q, "a", "anonymous", "customer-" + ++n);
      const started = (await command(
        q,
        "a",
        { type: "contact", identityId: identity.identityId, brandId: "default" },
        "start-key-" + n,
        { action: "start", text },
      )) as { conversationId: string };
      return { id: started.conversationId, identityId: identity.identityId };
    });
    await drain("ai.reply");
    return r;
  };
  const as = (c: Customer) => ({
    type: "contact" as const,
    identityId: c.identityId,
    brandId: "default",
  });
  const say = async (c: Customer, text: string) => {
    await tenant(db.connect, "a", (q) =>
      command(q, "a", as(c), "say-" + crypto.randomUUID(), {
        action: "reply",
        conversationId: c.id,
        text,
      }),
    );
    await drain("ai.reply");
  };
  const lastReply = async (c: Customer) =>
    (
      await sql<{ id: string; body: string; data: any }>(
        "a",
        "SELECT id,body,data FROM conversation_parts WHERE conversation_id=$1 AND kind='ai_reply' ORDER BY seq DESC LIMIT 1",
        [c.id],
      )
    )[0];
  const helped = (c: Customer, partId: string, by: Customer = c) =>
    tenant(db.connect, "a", (q) =>
      command(q, "a", as(by), "helped-" + crypto.randomUUID(), {
        action: "ai_helped",
        conversationId: c.id,
        partId,
      }),
    );
  const ledger = (c: Customer) =>
    sql<any>(
      "a",
      "SELECT kind,rule,answer_ids,reply_part_ids,window_hours,detail,resolution_id FROM ai_resolutions WHERE conversation_id=$1 ORDER BY recorded_at,kind",
      [c.id],
    );
  const state = async (c: Customer) =>
    (await sql<{ ai_state: string }>("a", "SELECT ai_state FROM conversations WHERE id=$1", [c.id]))[0]
      .ai_state;
  const hours = (h: number) => Date.now() + h * 3_600_000;
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
      "INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_help_center) VALUES('a','refunds','article','owner','public',true,false)",
    );
    await sql(
      "a",
      "INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,published_title,published_text,published_revision,published_at) VALUES('a','refunds','en','published','Refunds','Refunds','Refunds take five working days to reach the card you paid with.',1,now())",
    );
    await scheduleIndex(db.connect, "a");
    await drain("knowledge.index");

    // 1. Confirmed: "That helped" under an answer from content.
    const happy = await start("How long do refunds take?");
    const answer = await lastReply(happy);
    assert.deepEqual(answer.data.confirm, {
      helped: "That helped",
      person: "Talk to a person",
      thanks: "Glad that helped! If you need anything else, just write here.",
    });
    const result = (await helped(happy, answer.id)) as any;
    assert.equal(result.resolved, true);
    const [row] = await ledger(happy);
    const [answerRow] = await sql<{ id: string }>(
      "a",
      "SELECT id FROM ai_answers WHERE conversation_id=$1 AND outcome='answered'",
      [happy.id],
    );
    assert.deepEqual(row, {
      kind: "resolution",
      rule: "confirmed",
      answer_ids: [answerRow.id],
      reply_part_ids: [answer.id],
      window_hours: 24,
      detail: "The customer said the answer helped.",
      resolution_id: null,
    });
    assert.equal(await state(happy), "resolved");
    assert.equal(
      (await lastReply(happy)).body,
      "Glad that helped! If you need anything else, just write here.",
    );
    const [event] = await sql<{ audience: string; data: any }>(
      "a",
      "SELECT audience,data FROM conversation_parts WHERE conversation_id=$1 AND kind='system_event' AND data->>'event'='ai_resolved'",
      [happy.id],
    );
    assert.equal(event.audience, "internal");
    assert.equal(event.data.rule, "confirmed");
    // Again: nothing new; one standing resolution per conversation.
    assert.equal(((await helped(happy, answer.id)) as any).resolved, false);
    assert.equal((await ledger(happy)).length, 1);

    // Only an answer from content can be confirmed, and only by its own customer.
    const unknown = await start("Do you sell gift vouchers for horses?");
    await assert.rejects(helped(unknown, (await lastReply(unknown)).id), /Only an answer from the AI agent/);
    const stranger = await start("How long do refunds take?");
    await assert.rejects(helped(happy, answer.id, stranger), /Conversation unavailable/);

    // 2. Quiet: no reply within 24 hours of an answer, never handed over.
    const quiet = await start("How long do refunds take?");
    assert.equal(await resolveQuiet(db.connect, "a", hours(23)), 0);
    await resolveQuiet(db.connect, "a", hours(25));
    const [quietRow] = await ledger(quiet);
    assert.equal(quietRow.rule, "quiet_window");
    assert.equal(quietRow.detail, "No reply from the customer within 24 hours of the answer.");
    assert.equal(await state(quiet), "resolved");
    // ...but never after "I don't know", a clarifying question, a teammate's reply or a handover.
    const clarify = await start("Hi!"); // a greeting gets a question back, not an answer
    const teammate = await start("How long do refunds take?");
    await tenant(db.connect, "a", (q) =>
      command(q, "a", { type: "teammate", principal: "owner-a" }, "t-" + crypto.randomUUID(), {
        action: "note",
        conversationId: teammate.id,
        text: "Looking",
      }),
    );
    await sql("a", "UPDATE conversations SET assigned='owner' WHERE id=$1", [teammate.id]);
    const human = await start("Can I talk to a human?");
    await resolveQuiet(db.connect, "a", hours(100));
    for (const c of [unknown, clarify, teammate, human])
      assert.deepEqual(await ledger(c), [], c.id);
    assert.equal(await state(unknown), "pending");

    // 3. The customer comes back after a resolution: answered again, still one resolution.
    await say(quiet, "And to a gift card?");
    assert.equal(await state(quiet), "pending");
    await resolveQuiet(db.connect, "a", hours(200));
    assert.equal((await ledger(quiet)).length, 1);

    // 4. A handover within the window reverses the resolution with a new row.
    const reversed = await start("How long do refunds take?");
    await helped(reversed, (await lastReply(reversed)).id);
    await say(reversed, "Actually, can I talk to a human?");
    const rows = await ledger(reversed);
    assert.deepEqual(
      rows.map((r: any) => [r.kind, r.rule]),
      [
        ["resolution", "confirmed"],
        ["reversal", "handed_over"],
      ],
    );
    assert.equal(rows[1].detail, "Handed to the team within 24 hours of the resolution.");
    assert.equal(await tenant(db.connect, "a", (q) => standing(q, "a", reversed.id)), null);
    // After the window it stands.
    const late = await start("How long do refunds take?");
    await helped(late, (await lastReply(late)).id);
    const kept = await tenant(db.connect, "a", async (q) =>
      reverseOnHandover(q, "a", await conversation(q, "a", late.id), "default", hours(25)),
    );
    assert.equal(kept, null);

    // 5. The ledger is append-only.
    await assert.rejects(sql("a", "UPDATE ai_resolutions SET detail='x'"), /append-only/);
    await assert.rejects(sql("a", "DELETE FROM ai_resolutions"), /append-only/);

    // 6. Settings: the window, and the ledger net of reversals.
    const settings = (await agent("ai-settings")).body;
    assert.equal(settings.agent.resolutionWindowHours, 24);
    // Confirmed: happy, reversed, late; quiet: quiet and the stranger's answered question.
    assert.deepEqual(settings.resolutions.last30Days, {
      resolutions: 5,
      reversals: 1,
      net: 4,
    });
    assert.equal(settings.resolutions.recent[0].kind, "resolution");
    assert.ok(settings.resolutions.recent.some((r: any) => r.kind === "reversal"));
    const refuse = await agent("ai-settings", {
      ...settings.agent,
      resolutionWindowHours: 5,
      version: settings.agent.version,
    });
    assert.equal(refuse.status, 400);
    assert.match(refuse.body.error.message, /1, 4, 12, 24, 48 or 72 hours/);
    const saved = await agent("ai-settings", {
      ...settings.agent,
      resolutionWindowHours: 1,
      version: settings.agent.version,
    });
    assert.equal(saved.status, 200);
    // A one-hour window: two hours later it's resolved.
    const hourly = await start("How long do refunds take?");
    await resolveQuiet(db.connect, "a", hours(2));
    assert.equal((await ledger(hourly))[0]?.window_hours, 1);

    // 7. Another workspace sees none of it, and can't record against these conversations.
    const other = (await agent("ai-settings", undefined, "owner-b", "b")).body;
    assert.deepEqual(other.resolutions, {
      last30Days: { resolutions: 0, reversals: 0, net: 0 },
      recent: [],
    });
    await assert.rejects(
      tenant(db.connect, "b", async (q) =>
        recordResolution(q, "b", await conversation(q, "b", happy.id), {
          agentId: "default",
          rule: "confirmed",
          windowHours: 24,
        }),
      ),
      /Conversation unavailable/,
    );
  } finally {
    await db.close();
  }
});
