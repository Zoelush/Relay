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
import { runAiReply, runProcedureResume, type AiEnvironment } from "../server/ai-agent";
import { runConnectorTest } from "../server/connectors";
import { expireApprovals } from "../server/procedures";
import { validateDefinition, DefinitionError } from "../lib/connector-definition";
import { CANCEL_ORDER, SHOP_KEY, recordedFetch } from "./fixtures/connectors";

const CANCEL_STEPS = `1. Ask for order_id.
2. Use Cancel order.
3. If status is "cancelled", go to step 5.
4. Hand over.
5. Say "Your order {{order_id}} is cancelled."
6. Resolve.`;

test("a write connector's definition: any method but GET, and retried only with an idempotency header", () => {
  const refuse = (change: Record<string, unknown>, message: RegExp) =>
    assert.throws(() => validateDefinition({ ...CANCEL_ORDER.definition, ...change }), (e) => e instanceof DefinitionError && message.test(e.message));
  refuse({ method: "GET" }, /A write connector uses POST, PUT, PATCH or DELETE/);
  refuse({ idempotencyHeader: "" }, /never retried: set retries to 0, or name the header/);
  refuse({ idempotencyHeader: "Authorization" }, /can't send the idempotency key as Authorization/);
  refuse({ access: "read", method: "DELETE" }, /A read connector uses GET or POST/);
  const def = validateDefinition({ ...CANCEL_ORDER.definition, idempotencyHeader: "", retries: 0, approval: "never" });
  assert.deepEqual([def.access, def.approval, def.retries], ["write", "never", 0]);
  // A read connector never carries write settings.
  const read = validateDefinition({ ...CANCEL_ORDER.definition, access: "read", method: "POST", approval: "never" });
  assert.deepEqual([read.approval, read.idempotencyHeader], ["always", ""]);
});

/** Write actions (phase 09, D3; docs/ACTIONS_STEP3.md). */
test("write actions: turned on past a warning, refused for unverified customers, approved per call by a teammate, sent once with an idempotency key, and stopped by the kill switch", async () => {
  const db = await testDatabase();
  const recorded = recordedFetch();
  const index: IndexEnvironment = { embedders: [testEmbedder()], vectors: memoryVectorStore() };
  const connectors = { key: "k".repeat(48), policy: { fetch: recorded.fetch }, sleep: async () => {} };
  const ai: AiEnvironment = { model: standInAnswerModel(), rerank: standInReranker(), index, classify: standInClassifier(), connectors };
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
  const handlers = {
    "ai.reply": (j: Job) => runAiReply(db.connect, ai, j),
    "procedure.resume": (j: Job) => runProcedureResume(db.connect, ai, j),
    "connector.test": (j: Job) => runConnectorTest(db.connect, connectors, j),
  };
  const drain = async (w = "a") => {
    for (let i = 0; i < 20; i++) {
      const job = (await sql<{ id: string }>(w, "SELECT id FROM jobs WHERE kind IN ('ai.reply','procedure.resume','connector.test') AND state IN ('queued','running') ORDER BY created_at LIMIT 1"))[0];
      if (!job) return;
      await runJob(db.connect, w, job.id, handlers);
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
  /** A customer starts a conversation (signed in: verified by the website). */
  const start = async (text: string, signedIn = true) => {
    const c = await tenant(db.connect, "a", async (q) => {
      const identity = await getIdentity(q, "a", signedIn ? "user" : "anonymous", "u-" + crypto.randomUUID(), { name: "Ada" });
      const { conversationId } = (await command(q, "a", { type: "contact", identityId: identity.identityId, brandId: "default" }, crypto.randomUUID(), {
        action: "start",
        text,
      })) as { conversationId: string };
      return { id: conversationId, identityId: identity.identityId };
    });
    await drain();
    return c;
  };
  const say = async (c: { id: string; identityId: string }, text: string) => {
    await tenant(db.connect, "a", (q) =>
      command(q, "a", { type: "contact", identityId: c.identityId, brandId: "default" }, crypto.randomUUID(), { action: "reply", conversationId: c.id, text }),
    );
    await drain();
  };
  const replies = (id: string) =>
    sql<{ body: string }>("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='ai_reply' ORDER BY seq", [id]).then((r) => r.map((x) => x.body));
  const runOf = async (id: string) => (await sql("a", "SELECT status,waiting_for,reason FROM ai_procedure_runs WHERE conversation_id=$1", [id]))[0];
  const approvalOf = async (id: string) => (await sql("a", "SELECT id,status,version::text AS version,note_part_id,summary FROM ai_action_approvals WHERE conversation_id=$1 ORDER BY requested_at DESC", [id]))[0];
  const writesSent = (order: string) => recorded.sent.filter((s) => s.url === `https://api.shop.example/v1/orders/${order}/cancel`);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
      );
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name IN ('ai_agent_v1','ai_actions_v1')", [w]);
      await sql(w, "DELETE FROM calendar_assignments");
      // Always open: a handover says the team will reply, whatever time the tests run.
      await sql(w, "UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
    }
    await sql("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");

    // A write connector, published; Zoe can't use it until a manager turns its writes on.
    const made = await agent("zoe-connector", { action: "create", name: "Cancel order" });
    const cid = made.body.connector.id;
    let v = (await agent("zoe-connector", { action: "save", id: cid, version: made.body.connector.version, name: "Cancel order", definition: CANCEL_ORDER.definition })).body.connector.version;
    v = (await agent("zoe-connector", { action: "secret", id: cid, name: "api_key", value: SHOP_KEY })).body.connector.version;
    let c = (await agent("zoe-connector", { action: "publish", id: cid, version: v })).body.connector;
    assert.deepEqual([c.liveVersion, c.liveAccess, c.writes.enabled], [1, "write", false]);

    const p = await agent("zoe-procedure", { action: "create", name: "Cancel my order" });
    const pid = p.body.procedure.id;
    const source = {
      description: "Cancels an order for a signed-in customer.",
      keywords: ["cancel my order"],
      inputs: [{ name: "order_id", label: "Order number", question: "Which order? It looks like A1234.", pattern: "[A-Z]\\d{4}" }],
      steps: CANCEL_STEPS,
      onFailure: "Sorry, I couldn't cancel it just now.",
    };
    let saved = await agent("zoe-procedure", { action: "save", id: pid, version: p.body.procedure.version, name: "Cancel my order", source });
    assert.equal(saved.body.compiled.error, "Step 2: Cancel order changes things: turn on its writes under Actions first.");

    assert.equal((await agent("zoe-connector", { action: "writes", id: cid, version: c.version, enabled: true })).body.error.message, "Confirm that Zoe may change things in this service.");
    assert.equal((await agent("zoe-connector", { action: "writes", id: cid, version: c.version, enabled: true, acknowledged: true }, "agent-1-a")).status, 403);
    c = (await agent("zoe-connector", { action: "writes", id: cid, version: c.version, enabled: true, acknowledged: true })).body.connector;
    assert.deepEqual([c.writes.enabled, c.writes.by], [true, "Support teammate"]);
    saved = await agent("zoe-procedure", { action: "save", id: pid, version: saved.body.procedure.version, name: "Cancel my order", source });
    assert.equal(saved.body.compiled.error, null);
    assert.equal(saved.body.compiled.steps[1], "2. Change something with Cancel order: a signed-in customer only, after a teammate approves it.");
    assert.equal((await agent("zoe-procedure", { action: "publish", id: pid, version: saved.body.procedure.version })).body.procedure.liveVersion, 1);
    // Visitors are allowed look-ups; writes still need a signed-in customer.
    await agent("zoe-procedure", {
      action: "verification",
      fallback: "none",
      rules: [],
    });

    // Acceptance: a write is refused for an unverified customer, and nothing is sent.
    const anon = await start("Please cancel my order A1001", false);
    assert.deepEqual(await replies(anon.id), [
      "I can only look that up for customers who are signed in.",
      "I'm connecting you with someone from the team. They'll reply here.",
    ]);
    assert.equal((await runOf(anon.id)).status, "escalated");
    assert.match((await runOf(anon.id)).reason, /Cancel order changes things, so it needs a signed-in customer, and this one isn't\. Nothing was sent\./);
    assert.equal(writesSent("A1001").length, 0);
    assert.equal(await approvalOf(anon.id), undefined);

    // Signed in: she asks a teammate, and waits; nothing is sent until they approve.
    const ada = await start("cancel my order A1001, I ordered the wrong size");
    assert.deepEqual(await replies(ada.id), ["I've asked a teammate to approve this. I'll carry on here as soon as they do."]);
    let approval = await approvalOf(ada.id);
    assert.equal(approval.status, "pending");
    assert.deepEqual(approval.summary, { "Order number": "A1001", Reason: null });
    const [note] = await sql("a", "SELECT body,data,audience FROM conversation_parts WHERE id=$1", [approval.note_part_id]);
    assert.equal(note.audience, "internal");
    assert.deepEqual(note.data.aiApproval, { id: approval.id });
    assert.match(note.body, /^Zoe asks to run Cancel order \(POST\) for this customer:\n• Order number: A1001\n• Reason: —\nApprove or deny it here\. It expires in 24 hours\.$/);
    assert.equal((await runOf(ada.id)).waiting_for, `approval:${approval.id}`);
    assert.equal(writesSent("A1001").length, 0);
    await say(ada, "hello?");
    assert.equal((await replies(ada.id)).at(-1), "A teammate still needs to approve this. I'll carry on here as soon as they do.");

    // The card: anyone who can read; only its workspace.
    const card = await agent(`ai-approval?id=${approval.id}`, undefined, "agent-1-a");
    assert.deepEqual([card.body.status, card.body.connector, card.body.method], ["pending", "Cancel order", "POST"]);
    assert.equal((await agent(`ai-approval?id=${approval.id}`, undefined, "owner-b", "b")).status, 404);
    assert.equal((await agent("ai-approval", { id: approval.id, version: approval.version, decision: "approve" }, "owner-b", "b")).status, 404);

    // A teammate approves (anyone who can reply): the write runs, once, with its key, and she carries on.
    const approved = await agent("ai-approval", { id: approval.id, version: approval.version, decision: "approve", note: "Fine, not shipped yet." }, "agent-1-a", "a", "approve-key");
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual([approved.body.status, approved.body.decidedBy], ["approved", "Agent one"]);
    assert.equal((await agent("ai-approval", { id: approval.id, version: approval.version, decision: "approve", note: "Fine, not shipped yet." }, "agent-1-a", "a", "approve-key")).status, 200);
    assert.equal((await agent("ai-approval", { id: approval.id, version: approval.version, decision: "deny" })).body.error.code, "APPROVAL_DECIDED");
    await drain();
    assert.equal((await replies(ada.id)).at(-1), "Your order A1001 is cancelled.");
    assert.equal((await runOf(ada.id)).status, "resolved");
    const sent = writesSent("A1001");
    assert.equal(sent.length, 1);
    assert.match(sent[0].headers["idempotency-key"], /^[0-9a-f]{32}$/);
    // The reason wasn't collected: sent as null, never guessed.
    assert.deepEqual(JSON.parse(sent[0].body!), { reason: null });
    const [audit] = await sql("a", "SELECT approval_id,idempotency_key,result,inputs FROM ai_connector_calls WHERE conversation_id=$1", [ada.id]);
    assert.deepEqual([audit.approval_id, audit.idempotency_key, audit.result], [approval.id, sent[0].headers["idempotency-key"], "ok"]);
    assert.equal((await agent(`ai-approval?id=${approval.id}`)).body.result, "ok");
    // A retried resume job never sends an approved write twice.
    await sql("a", "UPDATE ai_procedure_runs SET status='waiting',waiting_for=$2,ended_at=NULL WHERE conversation_id=$1", [ada.id, `approval:${approval.id}`]);
    await tenant(db.connect, "a", async (q) => (await import("../server/jobs")).enqueueJob(q, "a", "procedure.resume", { approvalId: approval.id }, {}));
    await drain();
    assert.equal(writesSent("A1001").length, 1);
    assert.match((await runOf(ada.id)).reason, /already attempted once under this approval; it isn't sent again/);

    // Denied: she says so and hands over; nothing is sent.
    const bo = await start("cancel my order A2002");
    approval = await approvalOf(bo.id);
    await agent("ai-approval", { id: approval.id, version: approval.version, decision: "deny", note: "Already shipped." });
    await drain();
    assert.deepEqual((await replies(bo.id)).slice(-2), [
      "A teammate decided not to go ahead with this.",
      "I'm connecting you with someone from the team. They'll reply here.",
    ]);
    assert.match((await runOf(bo.id)).reason, /A teammate denied Cancel order: “Already shipped\.”\. Nothing was sent\./);
    assert.equal(writesSent("A2002").length, 0);

    // Unanswered for 24 hours: it expires, she says so and hands over.
    const cy = await start("cancel my order A2002");
    approval = await approvalOf(cy.id);
    await sql("a", "UPDATE ai_action_approvals SET expires_at=now()-interval '1 minute' WHERE id=$1", [approval.id]);
    assert.equal(await expireApprovals(db.connect, "a"), 1);
    await drain();
    assert.equal((await replies(cy.id)).at(-2), "This couldn't be approved in time.");
    assert.equal((await approvalOf(cy.id)).status, "expired");
    assert.equal(writesSent("A2002").length, 0);

    // Asking for a person while waiting ends the procedure and cancels the approval.
    const dee = await start("cancel my order A2002");
    await say(dee, "Talk to a person");
    assert.equal((await approvalOf(dee.id)).status, "cancelled");
    assert.equal((await runOf(dee.id)).status, "abandoned");

    // A write that times out is retried only with the same key, then handed over as possibly done.
    const eve = await start("cancel my order A9999");
    approval = await approvalOf(eve.id);
    await agent("ai-approval", { id: approval.id, version: approval.version, decision: "approve" });
    await drain();
    const slow = writesSent("A9999");
    assert.equal(slow.length, 2);
    assert.equal(slow[0].headers["idempotency-key"], slow[1].headers["idempotency-key"]);
    assert.match((await runOf(eve.id)).reason, /timeout: No answer within 1 seconds; it may have gone through/);
    assert.equal((await replies(eve.id)).at(-2), "Sorry, I couldn't cancel it just now.");

    // Without an idempotency header, a failed write is never sent again.
    const latest = (await agent(`zoe?view=connector&id=${cid}`)).body.connector;
    v = (await agent("zoe-connector", { action: "save", id: cid, version: latest.version, name: "Cancel order", definition: { ...CANCEL_ORDER.definition, idempotencyHeader: "", retries: 0, approval: "never" } })).body.connector.version;
    assert.equal((await agent("zoe-connector", { action: "publish", id: cid, version: v })).body.connector.writes.enabled, true);
    const fay = await start("cancel my order A5000");
    assert.equal(writesSent("A5000").length, 1);
    assert.equal(writesSent("A5000")[0].headers["idempotency-key"], undefined);
    assert.match((await runOf(fay.id)).reason, /Cancel order failed \(http_error: The service answered 500\.\)/);

    // The kill switch: every write stops at once, for Zoe and the test console.
    assert.equal((await agent("zoe-connector", { action: "pause", paused: true }, "agent-1-a")).status, 403);
    const paused = await agent("zoe-connector", { action: "pause", paused: true });
    assert.deepEqual([paused.body.writes.paused, paused.body.writes.by], [true, "Support teammate"]);
    const before = recorded.sent.length;
    const gus = await start("cancel my order A1001");
    assert.match((await runOf(gus.id)).reason, /Cancel order failed \(refused: Write actions are paused for this workspace\.\)/);
    const t = await agent("zoe-connector", { action: "test", id: cid, values: { order_id: "A1001" } });
    await drain();
    assert.equal((await agent("job?id=" + t.body.jobId)).body.result.error, "Write actions are paused for this workspace.");
    assert.equal(recorded.sent.length, before);
    await agent("zoe-connector", { action: "pause", paused: false });

    // Turning writes off stops Zoe using it (the procedure can't publish again until it's back on).
    const now = (await agent(`zoe?view=connector&id=${cid}`)).body.connector;
    await agent("zoe-connector", { action: "writes", id: cid, version: now.version, enabled: false });
    const hal = await start("cancel my order A1001");
    assert.match((await runOf(hal.id)).reason, /refused: Writes aren't turned on for this connector/);
    assert.deepEqual(recorded.unmatched, []);

    // The rollback: write connectors archived, writes paused, pending approvals cancelled.
    await agent("zoe-procedure", { action: "verification", fallback: "none", rules: [] });
    const rollback = await readFile("db/rollback/0056_ai_write_actions.sql", "utf8");
    for (const statement of rollback.split("\n").filter((l) => !l.startsWith("--")).join("\n").split(";").filter((s) => s.trim()))
      await tenant(db.connect, "a", (q) => q.query(statement));
    assert.deepEqual(await sql("a", "SELECT archived,writes_enabled FROM ai_connectors WHERE id=$1", [cid]), [{ archived: true, writes_enabled: false }]);
    assert.deepEqual(await sql("a", "SELECT writes_paused FROM ai_agents"), [{ writes_paused: true }]);
    assert.deepEqual(await sql("a", "SELECT 1 FROM ai_action_approvals WHERE status='pending'"), []);
  } finally {
    await db.close();
  }
});
