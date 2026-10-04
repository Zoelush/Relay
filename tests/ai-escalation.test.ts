import test from "node:test";
import assert from "node:assert/strict";
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
  buildClassifyPrompt,
  standInAnswerModel,
  standInClassifier,
  standInReranker,
  type AnswerModel,
  type ClassifierPort,
  type ClassifyRequest,
} from "../server/ai-model";
import { runAiReply, type AiEnvironment } from "../server/ai-agent";
import { matchKeywords } from "../server/ai-escalation";

/** Escalation rules, never-handle topics and guidance (phase 08, A2b; docs/AI_STEP3.md). */
test("escalation rules, never-handle topics and guidance hand over without answering, are validated in Settings, and stay in their workspace", async () => {
  const db = await testDatabase();
  const index: IndexEnvironment = {
    embedders: [testEmbedder()],
    vectors: memoryVectorStore(),
  };
  let answered = 0;
  const answering: AnswerModel = {
    model: "spy",
    answer: async (r) => {
      answered++;
      return standInAnswerModel().answer(r);
    },
  };
  const classified: ClassifyRequest[] = [];
  let classifierDown = false;
  const classify: ClassifierPort = {
    model: "spy-classify",
    async classify(r) {
      classified.push(r);
      if (classifierDown) throw new Error("down");
      return standInClassifier().classify(r);
    },
  };
  const ai: AiEnvironment = {
    model: answering,
    rerank: standInReranker(),
    index,
    classify,
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
  let n = 0;
  /** A customer starts a conversation: a visitor, or a signed-in user with a verified email. */
  const start = async (
    text: string,
    who: { email?: string; page?: string; locale?: string } = {},
  ) => {
    const r = await tenant(db.connect, "a", async (q) => {
      const identity = await getIdentity(
        q,
        "a",
        who.email ? "user" : "anonymous",
        "customer-" + ++n,
        who.email ? { email: who.email } : {},
      );
      if (who.page || who.locale)
        await q.query(
          "INSERT INTO messenger_sessions(workspace_id,id,brand_id,identity_id,secret_hash,expires_at,page_url,locale) VALUES('a',$1,'default',$2,'x',now()+interval '1 hour',$3,$4)",
          [crypto.randomUUID(), identity.identityId, who.page ?? "https://shop.test/", who.locale ?? "en"],
        );
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
  const say = async (c: { id: string; identityId: string }, text: string) => {
    await tenant(db.connect, "a", (q) =>
      command(
        q,
        "a",
        { type: "contact", identityId: c.identityId, brandId: "default" },
        "say-" + crypto.randomUUID(),
        { action: "reply", conversationId: c.id, text },
      ),
    );
    await drain("ai.reply");
  };
  const audit = async (id: string) =>
    (
      await sql<{ outcome: string; trigger: string | null; reason: string }>(
        "a",
        "SELECT outcome,trigger,reason FROM ai_answers WHERE conversation_id=$1 ORDER BY created_at",
        [id],
      )
    ).at(-1)!;
  let settings: any;
  const save = async (change: Record<string, unknown>, w = "a") => {
    const current = (await agent("ai-settings", undefined, "owner-" + w, w)).body;
    return agent(
      "ai-settings",
      { ...current.agent, ...change, version: current.agent.version },
      "owner-" + w,
      w,
    );
  };
  const rule = (name: string, conditions: unknown[], extra = {}) => ({
    name,
    enabled: true,
    match: "all",
    conditions,
    ...extra,
  });
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
      // No office hours, so answers don't depend on the day.
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
    await sql("a", "INSERT INTO tags(workspace_id,id,name) VALUES('a','vip','VIP')");
    await sql(
      "a",
      "INSERT INTO attribute_definitions(workspace_id,id,name,owner_type,value_type) VALUES('a','plan','Plan','conversation','string')",
    );

    // Refusals, each with its reason; nothing is saved.
    settings = (await agent("ai-settings")).body;
    assert.deepEqual(settings.choices.tags, [{ id: "vip", name: "VIP" }]);
    assert.deepEqual(settings.choices.attributes, [{ id: "plan", name: "Plan" }]);
    for (const [change, text] of [
      [{ rules: [rule("", [{ field: "signed_in", op: "is", value: true }])] }, /rule 1 a name/],
      [{ rules: [rule("Empty", [])] }, /“Empty”.*one to ten conditions/],
      [{ rules: [rule("Domain", [{ field: "email_domain", op: "is", value: "" }])] }, /“Domain”: give an email domain/],
      [{ rules: [rule("Brand", [{ field: "brand", op: "is", value: "nope" }])] }, /choose one of your brands/],
      [{ rules: [rule("Tag", [{ field: "tag", op: "has", value: "gold" }])] }, /choose one of your tags/],
      [{ rules: [rule("Attr", [{ field: "attribute", key: "size", op: "is", value: "x" }])] }, /conversation attributes/],
      [{ rules: [rule("Company", [{ field: "company", op: "is", value: "x" }])] }, /arrive with the people service/],
      [{ topics: [{ name: "", description: "", keywords: [] }] }, /topic 1 a name/],
      [{ topics: [{ name: "Legal", description: "", keywords: ["x".repeat(61)] }] }, /up to 20 keywords/],
      [{ guidance: ["x".repeat(501)] }, /guidance 1 up to 500/],
      [{ guidance: Array(11).fill("Hand over") }, /10 pieces of escalation guidance/],
    ] as const) {
      const r = await save(change);
      assert.equal(r.status, 400, JSON.stringify(change));
      assert.match(r.body.error.message, text);
    }
    assert.deepEqual((await agent("ai-settings")).body.rules, []);

    // Saved: two rules (one off), a topic, guidance; read back in order.
    const saved = await save({
      rules: [
        rule("Big Corp", [
          { field: "signed_in", op: "is", value: true },
          { field: "email_domain", op: "is", value: "@BigCorp.com" },
        ]),
        rule("Switched off", [{ field: "signed_in", op: "is", value: false }], {
          enabled: false,
        }),
        rule(
          "VIP or enterprise",
          [
            { field: "tag", op: "has", value: "vip" },
            { field: "page", op: "contains", value: "/enterprise" },
            { field: "attribute", key: "plan", op: "is", value: "Enterprise" },
            { field: "language", op: "is", value: "de" },
          ],
          { match: "any" },
        ),
      ],
      topics: [
        {
          name: "Legal",
          description: "Complaints that mention legal action",
          keywords: ["lawyer", " solicitor ", ""],
        },
        { name: "Chargebacks", description: "", keywords: [] },
      ],
      guidance: ["Hand over if the customer mentions “cancel my account”."],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(
      saved.body.rules.map((r: any) => [r.name, r.enabled, r.match]),
      [
        ["Big Corp", true, "all"],
        ["Switched off", false, "all"],
        ["VIP or enterprise", true, "any"],
      ],
    );
    assert.equal(saved.body.rules[0].conditions[1].value, "bigcorp.com");
    assert.deepEqual(saved.body.topics[0].keywords, ["lawyer", "solicitor"]);
    // Saving without rules, topics or guidance leaves them as they were.
    await save({ failedLimit: 3 });
    assert.equal((await agent("ai-settings")).body.rules.length, 3);

    // Rules: a signed-in Big Corp customer goes straight to the team, unanswered and unclassified.
    const before = { answered, classified: classified.length };
    const corp = await start("How long do refunds take?", { email: "ada@bigcorp.com" });
    const corpAudit = await audit(corp.id);
    assert.equal(corpAudit.trigger, "rule");
    assert.equal(corpAudit.reason, "An escalation rule matched: “Big Corp”.");
    assert.equal(answered, before.answered);
    assert.equal(classified.length, before.classified);
    const [note] = await sql<{ body: string }>(
      "a",
      "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='internal_note'",
      [corp.id],
    );
    assert.match(note.body, /An escalation rule matched: “Big Corp”\./);
    // Another domain, and a visitor (the switched-off rule would match them), are answered.
    assert.equal((await audit((await start("How long do refunds take?", { email: "bo@small.com" })).id)).outcome, "answered");
    assert.equal((await audit((await start("How long do refunds take?")).id)).outcome, "answered");
    // Any of: the page, the language, an attribute, or a tag added mid-conversation.
    assert.equal((await audit((await start("How long do refunds take?", { page: "https://shop.test/enterprise/pricing" })).id)).trigger, "rule");
    // Z2: the language is what the customer writes in; a German browser alone doesn't make an
    // English message German.
    assert.equal((await audit((await start("Wie lange dauert eine Rückerstattung?", { locale: "de-AT" })).id)).trigger, "rule");
    assert.equal((await audit((await start("Wie lange dauert eine Rückerstattung?")).id)).trigger, "rule");
    assert.notEqual((await audit((await start("How long do refunds take?", { locale: "de-AT" })).id)).trigger, "rule");
    const later = await start("How long do refunds take?");
    assert.equal((await audit(later.id)).outcome, "answered");
    await sql("a", "INSERT INTO conversation_tags(workspace_id,conversation_id,tag_id) VALUES('a',$1,'vip')", [later.id]);
    await say(later, "And for gift cards?");
    assert.equal((await audit(later.id)).trigger, "rule");
    const planned = await start("Hello there, how long do refunds take?");
    await sql("a", `UPDATE conversations SET attributes='{"plan":"Enterprise"}' WHERE id=$1`, [planned.id]);
    await say(planned, "And for gift cards?");
    assert.equal((await audit(planned.id)).trigger, "rule");

    // Topics: a keyword hands over before the classifier, and holds while it's down.
    const asked = classified.length;
    const legal = await start("My solicitor says refunds take too long");
    assert.equal((await audit(legal.id)).reason, "The message is about a never-handle topic: “Legal”.");
    assert.equal(classified.length, asked, "keywords need no model");
    classifierDown = true;
    assert.equal((await audit((await start("I will call my lawyer about refunds")).id)).trigger, "topic");
    // A topic without keywords needs the model: down, the agent answers.
    assert.equal((await audit((await start("Refunds and chargebacks: how long do refunds take?")).id)).outcome, "answered");
    classifierDown = false;
    // With the model, by its name (the stand-in reads the topic's name in the message).
    assert.equal((await audit((await start("Refunds and chargebacks: how long do refunds take?")).id)).trigger, "topic");
    // The classifier was given the topics and guidance, as data.
    const sent = classified.at(-1)!;
    assert.deepEqual(sent.topics, [
      { name: "Legal", description: "Complaints that mention legal action" },
      { name: "Chargebacks", description: "" },
    ]);
    assert.equal(sent.guidance?.length, 1);
    const { user } = buildClassifyPrompt(sent);
    assert.match(user, /<topics>\n0\. Legal: Complaints that mention legal action\n1\. Chargebacks\n<\/topics>/);

    // Guidance: applied by the classifier.
    const cancel = await start("Please cancel my account today");
    assert.match((await audit(cancel.id)).reason, /^Escalation guidance says a person should handle this: “Hand over if the customer mentions/);

    // Keywords are whole words, accents ignored.
    assert.equal(matchKeywords([{ name: "Legal", description: "", keywords: ["lawyer"] }], "lawyers"), null);
    assert.equal(matchKeywords([{ name: "Legal", description: "", keywords: ["café"] }], "the CAFE is shut")?.name, "Legal");

    // Another workspace: its own empty settings, and it can't use this one's brands or tags.
    const other = (await agent("ai-settings", undefined, "owner-b", "b")).body;
    assert.deepEqual([other.rules, other.topics, other.guidance], [[], [], []]);
    assert.deepEqual(other.choices.tags, []);
    const cross = await save(
      { rules: [rule("Theirs", [{ field: "tag", op: "has", value: "vip" }])] },
      "b",
    );
    assert.equal(cross.status, 400);
    assert.equal((await sql("b", "SELECT count(*)::int AS n FROM ai_escalation_rules"))[0].n, 0);
  } finally {
    await db.close();
  }
});
