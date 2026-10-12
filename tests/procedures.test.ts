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
import { memoryVectorStore, testEmbedder, type IndexEnvironment } from "../server/knowledge-index";
import { standInAnswerModel, standInClassifier, standInReranker } from "../server/ai-model";
import { runAiReply, type AiEnvironment } from "../server/ai-agent";
import { CompileError, compile, describe, validSource } from "../lib/procedure-plan";
import { ORDER_LOOKUP, SHOP_KEY, recordedFetch } from "./fixtures/connectors";

const ORDER_STEPS = `1. Ask for order_id.
2. Look up Order lookup.
3. If status is "shipped", go to step 6.
4. Say "Your order {{order_id}} is {{status}}. We'll email you when it ships."
5. Resolve.
6. Say "Your order {{order_id}} is on its way and should arrive on {{eta}}."
7. Resolve.`;
const WHERE_IS_MY_ORDER = {
  description: "Tells customers where their order is.",
  keywords: ["where is my order", "order status"],
  inputs: [{ name: "order_id", label: "Order number", question: "What's your order number? It looks like A1234.", pattern: "[A-Z]\\d{4}" }],
  steps: ORDER_STEPS,
  onFailure: "Sorry, I couldn't look up your order just now.",
};

test("a procedure's steps compile into a fixed plan, or say which step to fix", () => {
  const refs = [{ id: "c1", name: "Order lookup", asks: ["order_id"], outputs: ["status", "eta"] }];
  const plan = compile(validSource(WHERE_IS_MY_ORDER), refs);
  assert.deepEqual(plan.steps.map((s) => s.kind), ["ask", "call", "branch", "say", "end", "say", "end"]);
  assert.deepEqual(plan.connectors, [{ id: "c1", name: "Order lookup" }]);
  assert.equal(describe(plan)[2], "3. If status is “shipped”, go to step 6; otherwise continue.");
  const fails = (steps: string, message: string, source: Record<string, unknown> = {}) =>
    assert.throws(
      () => compile(validSource({ ...WHERE_IS_MY_ORDER, ...source, steps }), refs),
      (e) => e instanceof CompileError && e.message === message,
    );
  fails("1. Ask for email.\n2. Resolve.", "Step 1: Add email to what to collect first.");
  fails("1. Look up Billing.\n2. Resolve.", "Step 1: There's no published connector called “Billing”.");
  fails("1. Look up Order lookup.\n2. Resolve.", "Step 1: Order lookup needs order_id from the customer: add it to what to collect.", { inputs: [] });
  fails('1. If colour is "red", go to step 2.\n2. Resolve.', "Step 1: “colour” isn't something collected or looked up.");
  fails('1. Say "Hi {{nickname}}".\n2. Resolve.', "Step 1: “nickname” isn't something collected or looked up.");
  fails("1. Go to step 9.", "Step 1: There's no step 9.");
  fails("1. Ask for order_id.\n3. Resolve.", "Step 2: Number the steps 1, 2, 3 in order.");
  fails("1. Ask for order_id.", "Step 1: Finish the last step with Resolve, Hand over, Stop or Go to step.");
  fails("1. Refund the order.\n2. Resolve.", "Step 1: Start the step with Ask for, Look up, If, Say, Go to step, Resolve, Hand over or Stop.");
  fails("1. Resolve.", "Give at least one keyword that starts it.", { keywords: [] });
});

/** Procedures (phase 09, D2; docs/ACTIONS_STEP2.md). */
test("procedures: started by keywords, asking for what they need, looking up only for verified customers, and handing over cleanly when a look-up fails", async () => {
  const db = await testDatabase();
  const recorded = recordedFetch();
  const index: IndexEnvironment = { embedders: [testEmbedder()], vectors: memoryVectorStore() };
  const connectors = { key: "k".repeat(48), policy: { fetch: recorded.fetch }, sleep: async () => {} };
  const ai: AiEnvironment = {
    model: standInAnswerModel(),
    rerank: standInReranker(),
    index,
    classify: standInClassifier(),
    connectors,
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
    connectors,
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const drain = async (w = "a") => {
    for (let i = 0; i < 20; i++) {
      const job = (await sql<{ id: string }>(w, "SELECT id FROM jobs WHERE kind='ai.reply' AND state IN ('queued','running') ORDER BY created_at LIMIT 1"))[0];
      if (!job) return;
      await runJob(db.connect, w, job.id, { "ai.reply": (j: Job) => runAiReply(db.connect, ai, j) });
    }
  };
  const agent = async (path: string, data?: unknown, principal = "owner-a", workspace = "a", key: string = crypto.randomUUID()) => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: { origin: "https://app.test", "content-type": "application/json", "idempotency-key": key },
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
  /** A customer (with ada@example.com) starts a conversation; Zoe takes the message. */
  const start = async (text: string) => {
    const c = await tenant(db.connect, "a", async (q) => {
      const identity = await getIdentity(q, "a", "anonymous", crypto.randomUUID(), { name: "Ada" });
      const contact = (
        await q.query<{ contact_id: string }>("SELECT contact_id FROM identity_contact_mappings WHERE workspace_id='a' AND identity_id=$1", [identity.identityId])
      ).rows[0].contact_id;
      await q.query("INSERT INTO contact_emails(workspace_id,contact_id,email) VALUES('a',$1,'ada@example.com') ON CONFLICT DO NOTHING", [contact]);
      const { conversationId } = (await command(
        q,
        "a",
        { type: "contact", identityId: identity.identityId, brandId: "default" },
        crypto.randomUUID(),
        { action: "start", text },
      )) as { conversationId: string };
      return { id: conversationId, identityId: identity.identityId };
    });
    await drain();
    return c;
  };
  const say = async (c: { id: string; identityId: string }, text: string) => {
    await tenant(db.connect, "a", (q) =>
      command(q, "a", { type: "contact", identityId: c.identityId, brandId: "default" }, crypto.randomUUID(), {
        action: "reply",
        conversationId: c.id,
        text,
      }),
    );
    await drain();
  };
  /** What the customer sees from Zoe, in order. */
  const replies = (id: string) =>
    sql<{ body: string }>("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='ai_reply' ORDER BY seq", [id]).then((r) => r.map((x) => x.body));
  const answers = (id: string) =>
    sql<{ outcome: string; trigger: string | null; reason: string }>("a", "SELECT outcome,trigger,reason FROM ai_answers WHERE conversation_id=$1 ORDER BY created_at", [id]);
  const runOf = async (id: string) => (await sql("a", 'SELECT status,step,waiting_for,retries,"values",reason,procedure_version FROM ai_procedure_runs WHERE conversation_id=$1', [id]))[0];
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
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name IN ('ai_agent_v1')", [w]);
      await sql(w, "DELETE FROM calendar_assignments");
    }
    await sql("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");

    // Off by default.
    assert.equal((await agent("zoe?view=procedures")).body.error.code, "ACTIONS_DISABLED");
    await sql("a", "UPDATE workspace_features SET enabled=true WHERE name='ai_actions_v1'");
    await sql("b", "UPDATE workspace_features SET enabled=true WHERE name='ai_actions_v1'");

    // A procedure drafted before its connector exists: saved, but it can't be published.
    const made = await agent("zoe-procedure", { action: "create", name: "Where's my order" });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const pid = made.body.procedure.id;
    const saved = await agent("zoe-procedure", { action: "save", id: pid, version: made.body.procedure.version, name: "Where's my order", source: WHERE_IS_MY_ORDER });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.compiled.error, "Step 2: There's no published connector called “Order lookup”.");
    assert.equal(
      (await agent("zoe-procedure", { action: "publish", id: pid, version: saved.body.procedure.version })).body.error.message,
      "Step 2: There's no published connector called “Order lookup”.",
    );
    assert.equal((await agent("zoe-procedure", { action: "create", name: "X" }, "agent-1-a")).status, 403);

    // The connector, published; now the procedure compiles and publishes.
    const c = await agent("zoe-connector", { action: "create", name: "Order lookup" });
    const cid = c.body.connector.id;
    let cv = (await agent("zoe-connector", { action: "save", id: cid, version: c.body.connector.version, name: "Order lookup", definition: ORDER_LOOKUP.definition })).body.connector.version;
    cv = (await agent("zoe-connector", { action: "secret", id: cid, name: "api_key", value: SHOP_KEY })).body.connector.version;
    assert.equal((await agent("zoe-connector", { action: "publish", id: cid, version: cv })).body.connector.liveVersion, 1);
    const view = await agent(`zoe?view=procedure&id=${pid}`);
    assert.equal(view.body.compiled.error, null);
    assert.equal(view.body.compiled.steps[1], "2. Look up Order lookup (a verified customer only, by your verification rules).");
    const published = await agent("zoe-procedure", { action: "publish", id: pid, version: view.body.procedure.version });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.procedure.liveVersion, 1);
    await assert.rejects(sql("a", "UPDATE ai_procedure_versions SET plan='{}'"), /never changed/);

    // Verification first: by default only signed-in customers have connectors run for them.
    const anon = await start("Where is my order A1001?");
    assert.deepEqual(await replies(anon.id), [
      "I can only look that up for customers who are signed in.",
      "I'm connecting you with someone from the team. They'll reply here.",
    ]);
    assert.deepEqual((await answers(anon.id)).map((a) => [a.outcome, a.trigger]), [["escalated", "procedure"]]);
    assert.match((await answers(anon.id))[0].reason, /Order lookup needs a signed-in customer \(the fallback rule\)/);
    assert.equal((await runOf(anon.id)).status, "escalated");
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM ai_connector_calls WHERE source='agent'"))[0].n, 0);
    assert.equal((await sql("a", "SELECT ai_state FROM conversations WHERE id=$1", [anon.id]))[0].ai_state, "escalated");

    // A rule lets visitors on the messenger through (the order number and their email suffice).
    const rules = await agent("zoe-procedure", {
      action: "verification",
      fallback: "signed_in",
      rules: [{ name: "Messenger visitors", enabled: true, match: "all", conditions: [{ field: "signed_in", op: "is", value: false }], requirement: "none" }],
    });
    assert.equal(rules.status, 200, JSON.stringify(rules.body));
    assert.deepEqual(rules.body.verification.rules.map((r: any) => [r.name, r.channel, r.requirement]), [["Messenger visitors", "messenger", "none"]]);
    assert.equal((await agent("zoe-procedure", { action: "verification", fallback: "maybe", rules: [] })).body.error.code, "INVALID_PROCEDURE");

    // The number in the first message: looked up, branched on, answered, resolved.
    const happy = await start("Hi, where is my order A1001?");
    assert.deepEqual(await replies(happy.id), ["Your order A1001 is on its way and should arrive on 2026-10-15."]);
    const [done] = await answers(happy.id);
    assert.equal(done.outcome, "procedure");
    assert.match(done.reason, /^Procedure “Where's my order” \(version 1\), steps 1, 2, 3, 6, 7: Resolved\.$/);
    const run = await runOf(happy.id);
    assert.equal(run.status, "resolved");
    assert.deepEqual([run.values.order_id, run.values.status], ["A1001", "shipped"]);
    const [call] = await sql("a", "SELECT source,conversation_id,version,result,inputs FROM ai_connector_calls WHERE conversation_id=$1", [happy.id]);
    assert.deepEqual([call.source, call.version, call.result, call.inputs], ["agent", 1, "ok", { order_id: "A1001", email: "[redacted]" }]);
    assert.equal(recorded.sent.at(-1)!.url, "https://api.shop.example/v1/orders/A1001?email=ada%40example.com");

    // Without the number: she asks; something that isn't one gets asked again; then the answer.
    const asked = await start("What's my order status?");
    assert.deepEqual(await replies(asked.id), ["What's your order number? It looks like A1234."]);
    assert.deepEqual([(await runOf(asked.id)).status, (await runOf(asked.id)).waiting_for], ["waiting", "order_id"]);
    await say(asked, "i don't remember it, a5000 maybe");
    assert.equal((await replies(asked.id)).at(-1), "Sorry, I didn't catch that. What's your order number? It looks like A1234.");
    await say(asked, "It's A5000");
    assert.equal((await replies(asked.id)).at(-1), "Your order A5000 is processing. We'll email you when it ships.");
    assert.deepEqual((await answers(asked.id)).map((a) => a.outcome), ["procedure", "procedure", "procedure"]);
    assert.equal((await runOf(asked.id)).status, "resolved");

    // The look-up times out (and is retried once): the customer is told plainly, and handed over.
    const slow = await start("where is my order A9999");
    assert.deepEqual(await replies(slow.id), [
      "Sorry, I couldn't look up your order just now.",
      "I'm connecting you with someone from the team. They'll reply here.",
    ]);
    const [timedOut] = await answers(slow.id);
    assert.deepEqual([timedOut.outcome, timedOut.trigger], ["escalated", "procedure"]);
    assert.match(timedOut.reason, /Order lookup failed \(timeout: No answer within 1 seconds\.\)/);
    assert.equal((await runOf(slow.id)).status, "escalated");
    assert.equal((await sql("a", "SELECT ai_state FROM conversations WHERE id=$1", [slow.id]))[0].ai_state, "escalated");
    const notes = await sql("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='internal_note'", [slow.id]);
    // Teammates' note says what happened; the customer never sees it.
    assert.ok(notes.some((n: any) => /Handed over by Zoe\. Procedure “Where's my order” \(version 1\), steps 1, 2: Order lookup failed \(timeout/.test(n.body)), JSON.stringify(notes));

    // Asking for a person mid-procedure ends it; her usual handover takes the message.
    const left = await start("order status please");
    await say(left, "Talk to a person");
    assert.equal((await runOf(left.id)).status, "abandoned");
    assert.deepEqual((await answers(left.id)).map((a) => [a.outcome, a.trigger]), [["procedure", null], ["escalated", "asked_for_person"]]);

    // Three tries at the number, then a person.
    const lost = await start("where is my order");
    for (const t of ["no idea", "sorry?", "hmm"]) await say(lost, t);
    assert.equal((await runOf(lost.id)).status, "escalated");
    assert.match((await answers(lost.id)).at(-1)!.reason, /She couldn't get Order number after 3 tries\./);

    // A running procedure keeps its version when a new one is published.
    const pinned = await start("where is my order");
    const v1 = (await agent(`zoe?view=procedure&id=${pid}`)).body.procedure;
    const edited = await agent("zoe-procedure", {
      action: "save",
      id: pid,
      version: v1.version,
      name: "Where's my order",
      source: { ...WHERE_IS_MY_ORDER, steps: ORDER_STEPS.replace("is on its way", "has shipped") },
    });
    assert.equal((await agent("zoe-procedure", { action: "publish", id: pid, version: edited.body.procedure.version })).body.procedure.liveVersion, 2);
    await say(pinned, "A1001");
    assert.equal((await replies(pinned.id)).at(-1), "Your order A1001 is on its way and should arrive on 2026-10-15.");
    assert.equal((await runOf(pinned.id)).procedure_version, 1);
    const fresh = await start("where is my order A1001");
    assert.equal((await replies(fresh.id)).at(-1), "Your order A1001 has shipped and should arrive on 2026-10-15.");

    // Messages without its keywords are hers as usual.
    const other = await start("Do you sell tandem bikes?");
    assert.notEqual((await answers(other.id))[0].outcome, "procedure");
    assert.equal(await runOf(other.id), undefined);

    // The list, its runs; managers only; per workspace.
    const list = (await agent("zoe?view=procedures")).body;
    assert.deepEqual(list.procedures.map((p: any) => [p.name, p.liveVersion, p.changed]), [["Where's my order", 2, false]]);
    assert.ok(list.runs.length >= 7);
    assert.equal((await agent("zoe?view=procedures", undefined, "agent-1-a")).status, 403);
    assert.equal((await agent(`zoe?view=procedure&id=${pid}`, undefined, "owner-b", "b")).status, 404);
    assert.deepEqual((await agent("zoe?view=procedures", undefined, "owner-b", "b")).body.procedures, []);

    // Archived: a waiting run ends, and the keywords start nothing.
    const waiting = await start("where is my order");
    const current = (await agent(`zoe?view=procedure&id=${pid}`)).body.procedure;
    assert.equal((await agent("zoe-procedure", { action: "archive", id: pid, version: current.version })).status, 200);
    assert.equal((await runOf(waiting.id)).status, "abandoned");
    const after = await start("where is my order A1001");
    assert.equal(await runOf(after.id), undefined);
    assert.deepEqual(recorded.unmatched, []);

    // The rollback ends waiting runs.
    const rollback = await readFile("db/rollback/0055_ai_procedures.sql", "utf8");
    for (const statement of rollback.split("\n").filter((l) => !l.startsWith("--")).join("\n").split(";").filter((s) => s.trim()))
      await tenant(db.connect, "a", (q) => q.query(statement));
    assert.deepEqual(await sql("a", "SELECT 1 FROM ai_procedure_runs WHERE status='waiting'"), []);
  } finally {
    await db.close();
  }
});
