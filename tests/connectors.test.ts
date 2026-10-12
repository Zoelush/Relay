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
import { pinnedVersion, runConnector, runConnectorTest, type ConnectorEnvironment } from "../server/connectors";
import {
  DefinitionError,
  mapOutputs,
  pick,
  renderRequest,
  validateDefinition,
} from "../lib/connector-definition";
import { ACCOUNT_STATUS, CRM_CLIENT_SECRET, ORDER_LOOKUP, SHOP_KEY, recordedFetch } from "./fixtures/connectors";

test("a connector's definition: only declared inputs are sent, typed values come back", () => {
  const def = validateDefinition(ORDER_LOOKUP.definition);
  const refuse = (change: Record<string, unknown>, message: RegExp) =>
    assert.throws(() => validateDefinition({ ...ORDER_LOOKUP.definition, ...change }), (e) => e instanceof DefinitionError && message.test(e.message));
  refuse({ path: "/orders/{{order}}" }, /\{\{order\}\} isn't one of the inputs/);
  refuse({ query: [{ name: "q", value: "{{ email" }] }, /Write placeholders as \{\{name\}\}/);
  refuse({ headers: [{ name: "Authorization", value: "x" }] }, /Relay sets Authorization itself/);
  refuse({ headers: [{ name: "X-Api-Key", value: "x" }] }, /Relay sets X-Api-Key itself/);
  refuse({ baseUrl: "https://user:pw@api.shop.example" }, /credentials in Authentication/);
  refuse({ baseUrl: "https://api.shop.example?x=1" }, /query values in Query/);
  refuse({ method: "POST", body: "{not json" }, /Write the body as JSON/);
  refuse({ inputs: [ORDER_LOOKUP.definition.inputs[0], ORDER_LOOKUP.definition.inputs[0]] }, /Two inputs are called order_id/);
  refuse({ outputs: [{ name: "x", label: "X", path: "a..b", type: "string" }] }, /path should look like/);
  refuse({ timeoutMs: 30_000 }, /timeout/);

  // Path values are encoded; a body placeholder alone keeps its type.
  const get = renderRequest(def, { order_id: "A1/0 1", email: "a+b@example.com" });
  assert.equal(get.url, "https://api.shop.example/v1/orders/A1%2F0%201?email=a%2Bb%40example.com");
  assert.equal(get.headers["X-Shop"], "fernhill");
  const post = renderRequest(validateDefinition(ACCOUNT_STATUS.definition), { user_id: "u-42" });
  assert.deepEqual(JSON.parse(post.body!), { user: "u-42", include: ["plan", "seats"], note: "asked about u-42" });

  assert.equal(pick({ a: { b: [{ c: 1 }] } }, "a.b[0].c"), 1);
  assert.equal(pick({ a: null }, "a.b"), undefined);
  assert.deepEqual(
    mapOutputs(def, { order: { status: "shipped", total: 10, paid: false, items: [{ name: 7 }] } }),
    { status: "shipped", eta: null, first_item: "7", total: 10, paid: false, tracking: null },
  );
  assert.throws(() => mapOutputs(def, { order: { total: "10" } }), /Total \(order\.total\) wasn't a number/);
});

/** Data connectors (phase 09, D1; docs/ACTIONS_STEP1.md). */
test("data connectors: drafted, credentialed, tested and published by managers; calls are offline-recorded, masked, rate limited and audited; per workspace", async () => {
  const db = await testDatabase();
  const recorded = recordedFetch();
  const connectors: ConnectorEnvironment = {
    key: "k".repeat(48),
    policy: { fetch: recorded.fetch },
    sleep: async () => {},
  };
  const index: IndexEnvironment = { embedders: [testEmbedder()], vectors: memoryVectorStore() };
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    knowledgeIndex: index,
    ai: { model: standInAnswerModel(), rerank: standInReranker(), index, classify: standInClassifier() },
    connectors,
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
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
  /** Runs the test console's job and returns what it found. */
  const console = async (id: string, values: Record<string, unknown>, w = "a") => {
    const r = await agent("zoe-connector", { action: "test", id, values });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await runJob(db.connect, w, r.body.jobId, { "connector.test": (job: Job) => runConnectorTest(db.connect, connectors, job) });
    const job = await agent("job?id=" + r.body.jobId);
    assert.equal(job.body.state, "succeeded");
    return job.body.result;
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
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name IN ('ai_agent_v1')", [w]);
    }
    await sql("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");

    // Off by default.
    assert.equal((await agent("zoe?view=connectors")).body.error.code, "ACTIONS_DISABLED");
    await sql("a", "UPDATE workspace_features SET enabled=true WHERE name='ai_actions_v1'");
    await sql("b", "UPDATE workspace_features SET enabled=true WHERE name='ai_actions_v1'");

    // Created blank; names are unique; managers only.
    const created = await agent("zoe-connector", { action: "create", name: "Order lookup" }, "owner-a", "a", "create-order-key");
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.connector.id;
    assert.equal(created.body.connector.access, "read");
    assert.equal(created.body.connector.liveVersion, null);
    assert.equal(
      (await agent("zoe-connector", { action: "create", name: "Order lookup" }, "owner-a", "a", "create-order-key")).body.connector.id,
      id,
    );
    assert.equal((await agent("zoe-connector", { action: "create", name: "order LOOKUP" })).body.error.message, "There's already a connector called order LOOKUP.");
    assert.equal((await agent("zoe-connector", { action: "create", name: "X" }, "agent-1-a")).status, 403);
    assert.equal((await agent("zoe?view=connectors", undefined, "agent-1-a")).status, 403);

    // Saved by version; a bad definition or a private address is refused with the reason.
    const save = (definition: unknown, version: string, name = "Order lookup") =>
      agent("zoe-connector", { action: "save", id, version, name, definition });
    let version = created.body.connector.version;
    const message = async (definition: unknown) => (await save(definition, version)).body.error?.message;
    assert.equal(await message({ ...ORDER_LOOKUP.definition, path: "/orders/{{id}}" }), "{{id}} isn't one of the inputs. Add it as an input first.");
    for (const baseUrl of ["http://api.shop.example", "https://localhost/v1", "https://10.0.0.5/v1", "https://metadata.internal"])
      assert.equal(
        await message({ ...ORDER_LOOKUP.definition, baseUrl }),
        "Relay only calls public https addresses; the base address isn't one.",
        baseUrl,
      );
    const saved = await save(ORDER_LOOKUP.definition, version);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal((await save(ORDER_LOOKUP.definition, version)).status, 409);
    version = saved.body.connector.version;

    // Publishing needs its credential; the credential is stored encrypted and never shown.
    assert.equal((await agent("zoe-connector", { action: "publish", id, version })).body.error.message, "Set its credential before publishing.");
    const keyed = await agent("zoe-connector", { action: "secret", id, name: "api_key", value: SHOP_KEY });
    assert.equal(keyed.status, 200, JSON.stringify(keyed.body));
    assert.deepEqual(keyed.body.connector.secrets.map((s: any) => [s.name, s.hint]), [["api_key", "d4e5"]]);
    assert.ok(!JSON.stringify(keyed.body).includes(SHOP_KEY));
    const [stored] = await sql("a", "SELECT wrapped FROM ai_connector_secrets");
    assert.ok(!stored.wrapped.includes(SHOP_KEY));

    // The test console: the draft against sample values, the exact request with the key masked,
    // the response, and the named values.
    const tried = await console(id, { order_id: "A1001", email: "ada@example.com" });
    assert.equal(tried.result, "ok");
    assert.equal(tried.status, 200);
    assert.deepEqual(tried.outputs, {
      status: "shipped",
      eta: "2026-10-15",
      first_item: "Road bike",
      total: 899.5,
      paid: true,
      tracking: null,
    });
    assert.equal(tried.request.method, "GET");
    assert.equal(tried.request.url, "https://api.shop.example/v1/orders/A1001?email=ada%40example.com");
    assert.equal(tried.request.headers["X-Api-Key"], "••••");
    assert.equal(tried.request.headers["X-Shop"], "fernhill");
    assert.match(tried.response.body, /"card_last4":"4242"/); // the teammate sees the raw response here only
    assert.ok(!JSON.stringify(tried).includes(SHOP_KEY));
    assert.equal(recorded.sent.at(-1)!.headers["x-api-key"], SHOP_KEY);
    // Inputs are checked before anything is sent.
    const before = recorded.sent.length;
    const wrong = await console(id, { order_id: "1001", email: "ada@example.com" });
    assert.deepEqual([wrong.result, wrong.error], ["invalid_input", "Order number isn't in the expected format."]);
    assert.equal(recorded.sent.length, before);

    // The audit: inputs with the sensitive one redacted (in the address too), mapped values only.
    const audit = await sql("a", "SELECT source,draft,version,inputs,outputs,url,result,invoked_by FROM ai_connector_calls ORDER BY created_at");
    assert.deepEqual(audit[0].inputs, { order_id: "A1001", email: "[redacted]" });
    assert.equal(audit[0].url, "https://api.shop.example/v1/orders/A1001?email=[redacted]");
    assert.deepEqual([audit[0].source, audit[0].draft, audit[0].version, audit[0].invoked_by], ["test", true, null, "owner"]);
    assert.ok(!JSON.stringify(audit).includes("4242") && !JSON.stringify(audit).includes("ada@example.com"));
    assert.equal(audit[1].result, "invalid_input");
    await assert.rejects(sql("a", "UPDATE ai_connector_calls SET result='ok'"), /append-only/);

    // Published: version 1, immutable; an edited draft shows as changed, and publishes as 2.
    let r = await agent("zoe-connector", { action: "publish", id, version: keyed.body.connector.version });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.connector.liveVersion, r.body.connector.changed], [1, false]);
    await assert.rejects(sql("a", "UPDATE ai_connector_versions SET definition='{}'"), /never changed/);
    r = await save({ ...ORDER_LOOKUP.definition, retries: 0 }, r.body.connector.version);
    assert.equal(r.body.connector.changed, true);
    const list = (await agent("zoe?view=connectors")).body.connectors;
    assert.deepEqual(list.map((c: any) => [c.name, c.liveVersion, c.changed, c.lastCall.result]), [["Order lookup", 1, true, "invalid_input"]]);

    // A conversation keeps the version it started with; a new one gets the next.
    const conversation = async (w = "a", user?: string) =>
      tenant(db.connect, w, async (q) => {
        const identity = await getIdentity(q, w, user ? "user" : "anonymous", user ?? crypto.randomUUID(), { name: "Ada", email: "ada@example.com" });
        const { conversationId } = (await command(
          q,
          w,
          { type: "contact", identityId: identity.identityId, brandId: "default" },
          crypto.randomUUID(),
          { action: "start", text: "Where's my order?" },
        )) as { conversationId: string };
        const contact = (
          await q.query<{ contact_id: string }>("SELECT contact_id FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2", [w, identity.identityId])
        ).rows[0].contact_id;
        await q.query("INSERT INTO contact_emails(workspace_id,contact_id,email) VALUES($1,$2,'ada@example.com') ON CONFLICT DO NOTHING", [w, contact]);
        if (user) await q.query("UPDATE contacts SET external_id=$3 WHERE workspace_id=$1 AND id=$2", [w, contact, user]);
        return conversationId;
      });
    const early = await conversation();
    assert.equal(await tenant(db.connect, "a", (q) => pinnedVersion(q, "a", id, early)), 1);
    r = await agent("zoe-connector", { action: "publish", id, version: r.body.connector.version });
    assert.equal(r.body.connector.liveVersion, 2);
    assert.deepEqual(r.body.versions.map((v: any) => v.version), [2, 1]);
    const late = await conversation();
    assert.equal(await tenant(db.connect, "a", (q) => pinnedVersion(q, "a", id, early)), 1);
    assert.equal(await tenant(db.connect, "a", (q) => pinnedVersion(q, "a", id, late)), 2);

    // Zoe's calls: context inputs come only from the conversation, never from what's given.
    const call = (values: Record<string, unknown>, conversationId = early, v = 1) =>
      runConnector(db.connect, connectors, "a", { connectorId: id, version: v, values, source: "agent", invokedBy: "zoe", conversationId });
    const zoe = await call({ order_id: "A1001", email: "someone-else@example.com" });
    assert.equal(zoe.result, "ok");
    assert.equal(recorded.sent.at(-1)!.url, "https://api.shop.example/v1/orders/A1001?email=ada%40example.com");
    assert.equal(zoe.request, undefined); // Zoe gets the values, not the exchange
    assert.deepEqual(Object.keys(zoe.outputs).sort(), ["eta", "first_item", "paid", "status", "total", "tracking"]);

    // Failures, each with a plain reason: a 500 retried, a 404, a timeout (retried once), not JSON,
    // a value of the wrong type, a refused key.
    let x = await call({ order_id: "A5000" });
    assert.deepEqual([x.result, x.attempts, x.outputs.status], ["ok", 2, "processing"]);
    x = await call({ order_id: "A4040" });
    assert.deepEqual([x.result, x.status, x.error], ["http_error", 404, "The service answered 404."]);
    x = await call({ order_id: "A9999" });
    assert.deepEqual([x.result, x.attempts, x.error], ["timeout", 2, "No answer within 1 seconds."]);
    x = await call({ order_id: "A2222" });
    assert.deepEqual([x.result, x.error], ["invalid_response", "The response wasn't JSON."]);
    x = await call({ order_id: "A3333" });
    assert.deepEqual([x.result, x.error, x.outputs], ["invalid_response", "Total (order.total) wasn't a number in the response.", {}]);
    await agent("zoe-connector", { action: "secret", id, name: "api_key", value: "sk_test_wrong_000000" });
    x = await call({ order_id: "A1001" });
    assert.deepEqual([x.result, x.status], ["auth_failed", 401]);
    await agent("zoe-connector", { action: "secret", id, name: "api_key", value: SHOP_KEY });

    // The rate limit: over it, nothing is sent.
    const limited = await agent("zoe-connector", { action: "create", name: "Limited" });
    const lid = limited.body.connector.id;
    let lv = (await agent("zoe-connector", { action: "save", id: lid, version: limited.body.connector.version, name: "Limited", definition: { ...ORDER_LOOKUP.definition, rateLimit: 1 } })).body.connector.version;
    lv = (await agent("zoe-connector", { action: "secret", id: lid, name: "api_key", value: SHOP_KEY })).body.connector.version;
    assert.equal((await console(lid, { order_id: "A1001", email: "ada@example.com" })).result, "ok");
    const sentBefore = recorded.sent.length;
    const over = await console(lid, { order_id: "A1001", email: "ada@example.com" });
    assert.deepEqual([over.result, over.error], ["rate_limited", "Over its limit of 1 calls a minute."]);
    assert.equal(recorded.sent.length, sentBefore);
    assert.equal((await agent("zoe-connector", { action: "archive", id: lid, version: lv })).status, 200);
    assert.equal((await agent(`zoe?view=connector&id=${lid}`)).status, 404);

    // OAuth 2 client credentials: one token, kept encrypted until it expires, sent as a bearer.
    const crm = await agent("zoe-connector", { action: "create", name: "Account status" });
    const cid = crm.body.connector.id;
    await agent("zoe-connector", { action: "save", id: cid, version: crm.body.connector.version, name: "Account status", definition: ACCOUNT_STATUS.definition });
    await agent("zoe-connector", { action: "secret", id: cid, name: "client_secret", value: CRM_CLIENT_SECRET });
    const signedIn = await conversation("a", "user-42");
    const account = (values = {}) =>
      runConnector(db.connect, connectors, "a", { connectorId: cid, version: "draft", values, source: "agent", invokedBy: "zoe", conversationId: signedIn });
    const first = await account();
    assert.equal(first.result, "ok", first.error);
    assert.deepEqual(first.outputs, { plan: "Pro", seats: 12, features: ["sso", "audit"] });
    assert.ok(!JSON.stringify(first).includes("billing@acme.example"));
    await account();
    assert.equal(recorded.sent.filter((s) => s.url === "https://auth.crm.example/oauth/token").length, 1);
    const crmCall = recorded.sent.filter((s) => s.url === "https://api.crm.example/accounts/search").at(-1)!;
    assert.equal(crmCall.headers.authorization, "Bearer crm-token-1");
    assert.deepEqual(JSON.parse(crmCall.body!), { user: "user-42", include: ["plan", "seats"], note: "asked about user-42" });
    const [token] = await sql("a", "SELECT wrapped FROM ai_connector_tokens");
    assert.ok(!token.wrapped.includes("crm-token-1"));
    // An anonymous visitor has no user ID, whatever is given.
    const anon = await runConnector(db.connect, connectors, "a", {
      connectorId: cid,
      version: "draft",
      values: { user_id: "user-42" },
      source: "agent",
      invokedBy: "zoe",
      conversationId: late,
    });
    assert.deepEqual([anon.result, anon.error], ["invalid_input", "User ID is needed."]);

    // Per workspace.
    assert.equal((await agent(`zoe?view=connector&id=${id}`, undefined, "owner-b", "b")).status, 404);
    assert.equal((await agent("zoe-connector", { action: "test", id, values: {} }, "owner-b", "b")).status, 404);
    assert.deepEqual((await agent("zoe?view=connectors", undefined, "owner-b", "b")).body.connectors, []);
    await assert.rejects(
      runConnector(db.connect, connectors, "b", { connectorId: id, version: 1, values: {}, source: "agent", invokedBy: "zoe" }),
      /isn't available/,
    );
    const detail = (await agent(`zoe?view=connector&id=${id}`)).body;
    assert.ok(detail.calls.length >= 8);
    assert.ok(!JSON.stringify(detail).includes(SHOP_KEY));

    // Nothing left the recorded exchanges.
    assert.deepEqual(recorded.unmatched, []);

    // The rollback: off everywhere; cached tokens dropped.
    const rollback = await readFile("db/rollback/0054_ai_connectors.sql", "utf8");
    for (const statement of rollback.split("\n").filter((l) => !l.startsWith("--")).join("\n").split(";").filter((s) => s.trim()))
      await tenant(db.connect, "a", (q) => q.query(statement));
    assert.equal((await agent("zoe?view=connectors")).body.error.code, "ACTIONS_DISABLED");
    assert.deepEqual(await sql("a", "SELECT 1 FROM ai_connector_tokens"), []);
  } finally {
    await db.close();
  }
});
