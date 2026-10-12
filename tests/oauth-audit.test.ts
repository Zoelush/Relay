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
import { BOOKINGS, CALENDAR_SECRET, recordedFetch } from "./fixtures/connectors";

/** OAuth on the workspace's behalf, and one conversation's audit (phase 09, D4; docs/ACTIONS_STEP4.md). */
test("a connector connected on the workspace's behalf: PKCE, one-time state, refresh and rotation, disconnect; and a conversation's audit, readable and permissioned", async () => {
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
  const test_ = async (id: string) => {
    const r = await agent("zoe-connector", { action: "test", id, values: { email: "ada@example.com" } });
    await drain();
    return (await agent("job?id=" + r.body.jobId)).body.result;
  };
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

    const made = await agent("zoe-connector", { action: "create", name: "Bookings" });
    const id = made.body.connector.id;
    await agent("zoe-connector", { action: "save", id, version: made.body.connector.version, name: "Bookings", definition: BOOKINGS.definition });
    const start = (redirectUri = "https://app.test/agent") => agent("zoe-connector", { action: "oauth_start", id, redirectUri });

    // Connecting needs its client secret, and a return address that's the app's own.
    assert.equal((await start()).body.error.message, "Set its client secret first.");
    await agent("zoe-connector", { action: "secret", id, name: "client_secret", value: CALENDAR_SECRET });
    for (const bad of ["http://evil.example/agent", "https://app.test/agent?next=x", "javascript:alert(1)"])
      assert.equal((await start(bad)).body.error.code, "INVALID_CONNECTOR", bad);
    assert.equal((await agent("zoe-connector", { action: "oauth_start", id, redirectUri: "https://app.test/agent" }, "agent-1-a")).status, 403);

    // The address: the provider's, with PKCE and a one-time state that's stored only hashed.
    const first = new URL((await start()).body.url);
    assert.equal(first.origin + first.pathname, "https://auth.calendar.example/authorize");
    const q = Object.fromEntries(first.searchParams);
    assert.deepEqual(
      [q.response_type, q.client_id, q.redirect_uri, q.scope, q.code_challenge_method],
      ["code", "relay-fernhill", "https://app.test/agent", "bookings.read offline_access", "S256"],
    );
    assert.match(q.state, /^relay_[A-Za-z0-9_-]{43}$/);
    assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!JSON.stringify(await sql("a", "SELECT * FROM ai_connector_oauth_states")).includes(q.state));

    // Finishing: the state is used once, by whoever started it; a refused code uses it up.
    const finish = (state: string, code: string, principal = "owner-a") => agent("zoe-connector", { action: "oauth_finish", state, code }, principal);
    assert.equal((await finish("relay_forged", "good-code")).body.error.code, "OAUTH_STATE");
    assert.equal((await finish(q.state, "bad-code")).body.error.message, "The service refused the connection (400). Start again.");
    assert.equal((await finish(q.state, "good-code")).body.error.code, "OAUTH_STATE");
    const noRefresh = new URL((await start()).body.url).searchParams.get("state")!;
    assert.match((await finish(noRefresh, "no-refresh")).body.error.message, /didn't give a refresh token/);
    // Another workspace can't finish this one's connection.
    const theirs = new URL((await start()).body.url).searchParams.get("state")!;
    assert.equal((await agent("zoe-connector", { action: "oauth_finish", state: theirs, code: "good-code" }, "owner-b", "b")).body.error.code, "OAUTH_STATE");
    const good = new URL((await start()).body.url).searchParams.get("state")!;
    const connected = await finish(good, "good-code");
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    assert.deepEqual([connected.body.connector.oauth.connected, connected.body.connector.oauth.by], [true, "Support teammate"]);
    assert.ok(!connected.body.connector.secrets.some((s: any) => s.name === "refresh_token"));
    const exchange = recorded.sent.filter((s) => s.url === "https://auth.calendar.example/oauth/token" && s.body?.includes("good-code")).at(-1)!;
    assert.match(exchange.body!, /code_verifier=[A-Za-z0-9_-]{43}/);
    const sealed = JSON.stringify(await sql("a", "SELECT wrapped FROM ai_connector_secrets UNION ALL SELECT wrapped FROM ai_connector_tokens"));
    assert.ok(!sealed.includes("cal-refresh-1") && !sealed.includes("cal-token-1"));

    // Calls use the token; an expired one is refreshed, and a rotated refresh token is kept.
    let t = await test_(id);
    assert.deepEqual([t.result, t.outputs.next_booking], ["ok", "Tuesday 14 October, 10:00"]);
    assert.equal(t.request.headers.authorization, "Bearer ••••");
    assert.equal(recorded.sent.at(-1)!.headers.authorization, "Bearer cal-token-1");
    await sql("a", "UPDATE ai_connector_tokens SET expires_at=now()-interval '1 minute'");
    t = await test_(id);
    assert.equal(t.result, "ok");
    assert.equal(recorded.sent.at(-1)!.headers.authorization, "Bearer cal-token-2");
    await sql("a", "UPDATE ai_connector_tokens SET expires_at=now()-interval '1 minute'");
    assert.equal((await test_(id)).result, "ok");
    assert.equal(recorded.sent.at(-1)!.headers.authorization, "Bearer cal-token-3");
    assert.ok(!JSON.stringify(await test_(id)).includes("cal-refresh"));

    // Published, used by a procedure in a conversation.
    const c = (await agent(`zoe?view=connector&id=${id}`)).body.connector;
    assert.equal((await agent("zoe-connector", { action: "publish", id, version: c.version })).body.connector.liveVersion, 1);
    const p = await agent("zoe-procedure", { action: "create", name: "My booking" });
    const saved = await agent("zoe-procedure", {
      action: "save",
      id: p.body.procedure.id,
      version: p.body.procedure.version,
      name: "My booking",
      source: { description: "", keywords: ["my booking"], inputs: [], steps: '1. Look up Bookings.\n2. Say "Your next booking is {{next_booking}}."\n3. Resolve.', onFailure: "" },
    });
    await agent("zoe-procedure", { action: "publish", id: p.body.procedure.id, version: saved.body.procedure.version });
    await agent("zoe-procedure", { action: "verification", fallback: "none", rules: [] });
    const conv = await tenant(db.connect, "a", async (q2) => {
      const identity = await getIdentity(q2, "a", "anonymous", crypto.randomUUID(), { name: "Ada" });
      const contact = (await q2.query<{ contact_id: string }>("SELECT contact_id FROM identity_contact_mappings WHERE workspace_id='a' AND identity_id=$1", [identity.identityId])).rows[0].contact_id;
      await q2.query("INSERT INTO contact_emails(workspace_id,contact_id,email) VALUES('a',$1,'ada@example.com')", [contact]);
      return ((await command(q2, "a", { type: "contact", identityId: identity.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text: "When is my booking?" })) as { conversationId: string }).conversationId;
    });
    await drain();
    assert.deepEqual(
      (await sql("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='ai_reply'", [conv])).map((r: any) => r.body),
      ["Your next booking is Tuesday 14 October, 10:00."],
    );

    // The audit for one conversation: in order, readable, with details for those allowed.
    const audit = (await agent(`ai-audit?conversation=${conv}`)).body;
    assert.deepEqual(audit.entries.map((e: any) => e.kind), ["procedure", "call"]);
    const [run, call] = audit.entries;
    assert.deepEqual([run.procedure, run.version, run.status], ["My booking", 1, "resolved"]);
    assert.deepEqual([call.connector, call.version, call.by, call.result, call.status], ["Bookings", 1, "Zoe", "ok", 200]);
    assert.deepEqual(call.inputs, { email: "[redacted]" });
    assert.equal(call.url, "https://api.calendar.example/v1/bookings?email=[redacted]");
    assert.deepEqual(call.outputs, { next_booking: "Tuesday 14 October, 10:00" });
    assert.match(audit.text, /^Zoe's actions in conversation .+\n\n/);
    assert.match(audit.text, /UTC {2}Procedure “My booking” \(version 1\) started; resolved at .+ UTC\.\n {4}Procedure “My booking” \(version 1\), steps 1, 2, 3: Resolved\./);
    assert.match(audit.text, /UTC {2}Zoe called Bookings \(version 1\): ok \(200\) in \d+ ms\.\n {4}GET https:\/\/api\.calendar\.example\/v1\/bookings\?email=\[redacted\]\n {4}Sent: \{"email":"\[redacted\]"\}\n {4}Got: \{"next_booking":"Tuesday 14 October, 10:00"\}/);
    assert.ok(!audit.text.includes("ada@example.com") && !audit.text.includes("cal-token"));
    // Without permission to see personal data: what happened, not what was sent.
    await sql("a", "DELETE FROM role_capabilities WHERE role_id='agent' AND capability='contacts.personal_data'");
    const limited = (await agent(`ai-audit?conversation=${conv}`, undefined, "agent-1-a")).body;
    assert.equal(limited.details, false);
    assert.deepEqual([limited.entries[1].inputs, limited.entries[1].outputs, limited.entries[1].url], [null, null, null]);
    assert.match(limited.text, /What was sent and returned is hidden/);
    assert.equal((await agent(`ai-audit?conversation=${conv}`, undefined, "owner-b", "b")).status, 404);

    // Disconnected: Zoe can't use it until someone connects it again.
    const now = (await agent(`zoe?view=connector&id=${id}`)).body.connector;
    assert.equal((await agent("zoe-connector", { action: "oauth_disconnect", id, version: now.version })).body.connector.oauth.connected, false);
    t = await test_(id);
    assert.deepEqual([t.result, t.error], ["auth_failed", "It isn't connected yet: connect it under Actions."]);
    assert.deepEqual(recorded.unmatched, []);

    // The rollback: connections in progress dropped; connectors using it archived.
    await start();
    const rollback = await readFile("db/rollback/0057_ai_oauth_audit.sql", "utf8");
    for (const statement of rollback.split("\n").filter((l) => !l.startsWith("--")).join("\n").split(";").filter((s) => s.trim()))
      await tenant(db.connect, "a", (q2) => q2.query(statement));
    assert.deepEqual(await sql("a", "SELECT 1 FROM ai_connector_oauth_states"), []);
    assert.deepEqual(await sql("a", "SELECT archived FROM ai_connectors WHERE id=$1", [id]), [{ archived: true }]);
  } finally {
    await db.close();
  }
});
