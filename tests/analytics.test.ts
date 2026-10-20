import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyticsDatabase, testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { runJob } from "../server/jobs";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { conversationSummary, projectJob, scheduleProjection, type AnalyticsStore } from "../server/analytics";

/**
 * Reporting's store and feed (phase 14, R1; docs/REPORTING_STEP1.md), with the application and the
 * analytical store as two databases: the projection is the backfill, continues in batches,
 * changes nothing when run again, copies no message text, and keeps the facts current; a contact
 * edited today doesn't change last month's report (the brief's acceptance test); the status page
 * is for who may view reports; another workspace's data is its own; the rollback stops it.
 */
test("reporting's store: fed from the application in batches, idempotent, snapshots that hold, per workspace", async () => {
  const db = await testDatabase();
  const store = await analyticsDatabase();
  const analytics: AnalyticsStore = { connect: store.connect };
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    analytics,
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const asql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(store.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const agent = async (path: string, principal = "owner-a", workspace = "a") => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, { headers: { origin: "https://app.test" } }),
      principal,
      { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: workspace, RELAY_BRIDGE_SECRET: env.bridgeSecret },
      (r) => handleApi(r, env),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  /** The sweep, then the projection's job run until it's done. */
  const project = async (w = "a") => {
    await scheduleProjection(db.connect, w);
    let runs = 0;
    for (;;) {
      const job = (await sql<{ id: string }>(w, "SELECT id FROM jobs WHERE kind='analytics.project' AND state IN ('queued','running') ORDER BY created_at LIMIT 1"))[0];
      if (!job) return runs;
      await runJob(db.connect, w, job.id, { "analytics.project": (j) => projectJob(db.connect, analytics, j) });
      runs++;
    }
  };
  const start = async (identityId: string, text: string, w = "a") =>
    (await tenant(db.connect, w, (q) => command(q, w, { type: "contact", identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text }))) as { conversationId: string };
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) => seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE name='settings_v1'");
    }
    await sql("a", "INSERT INTO roles(workspace_id,id,name) VALUES('a','limited','Limited')");
    await sql("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','grace','grace-a','Grace','limited')");

    // Off by default: nothing is projected, and there's no page.
    const ada = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "user", "u-ada", { name: "Ada" }));
    await sql("a", "UPDATE contacts SET profile='{\"plan\":\"pro\"}' WHERE id=$1", [ada.contactId]);
    const last = await start(ada.identityId, "A question last month");
    assert.equal(await project(), 0);
    assert.equal((await agent("reporting-status")).status, 404);
    await sql("a", "UPDATE workspace_features SET enabled=true WHERE name='reports_v1'");
    assert.equal((await agent("reporting-status", "grace-a")).status, 403, "who may view reports only");

    // Last month: Ada (a pro user then) asked, and was answered 10 minutes later. The snapshot is
    // taken by the database when the conversation starts.
    const lastMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 10, 9));
    // (Moved back in time as the database's owner: parts are append-only to everyone else.)
    const backdate = async (text: string, values: unknown[]) => {
      await db.pg.exec("ALTER TABLE conversation_parts DISABLE TRIGGER immutable_parts");
      await db.pg.query(text, values);
      await db.pg.exec("ALTER TABLE conversation_parts ENABLE TRIGGER immutable_parts");
    };
    await db.pg.query("UPDATE conversations SET created_at=$2 WHERE id=$1", [last.conversationId, lastMonth.toISOString()]);
    await backdate("UPDATE conversation_parts SET created_at=$2 WHERE conversation_id=$1", [last.conversationId, lastMonth.toISOString()]);
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "reply", conversationId: last.conversationId, text: "Here you go" }));
    await backdate("UPDATE conversation_parts SET created_at=$2 WHERE conversation_id=$1 AND kind='teammate_reply'", [last.conversationId, new Date(lastMonth.getTime() + 600_000).toISOString()]);
    assert.deepEqual(await sql("a", "SELECT role,profile FROM conversation_snapshots WHERE conversation_id=$1", [last.conversationId]), [{ role: "user", profile: { plan: "pro" } }]);

    // The backfill: 250 more conversations, projected in two batches; run again, nothing changes.
    for (let i = 0; i < 250; i++) {
      const v = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "anonymous", `device-${i}`));
      await start(v.identityId, `Question ${i}`);
    }
    assert.equal(await project(), 2, "two batches (200, then 51)");
    assert.equal((await asql<{ n: number }>("a", "SELECT count(*)::int AS n FROM a_conversations"))[0].n, 251);
    const before = await asql("a", "SELECT conversation_id,projected_seq,first_response_ms,teammate_replies FROM a_conversations ORDER BY conversation_id");
    const partsBefore = (await asql<{ n: number }>("a", "SELECT count(*)::int AS n FROM a_parts"))[0].n;
    await asql("a", "UPDATE a_projection SET watermark='-infinity',changes_watermark='-infinity'");
    await project();
    assert.deepEqual(await asql("a", "SELECT conversation_id,projected_seq,first_response_ms,teammate_replies FROM a_conversations ORDER BY conversation_id"), before, "idempotent");
    assert.equal((await asql<{ n: number }>("a", "SELECT count(*)::int AS n FROM a_parts"))[0].n, partsBefore);
    // No message text or personal data in the store: only what metrics read.
    const stored = JSON.stringify(await asql("a", "SELECT data FROM a_parts"));
    assert.doesNotMatch(stored, /A question last month|Here you go|Question \d/);
    const facts = (await asql("a", "SELECT first_response_ms,first_response_business_ms,teammate_replies,customer_messages,status FROM a_conversations WHERE conversation_id=$1", [last.conversationId]))[0];
    assert.deepEqual(facts, { first_response_ms: 600000, first_response_business_ms: facts.first_response_business_ms, teammate_replies: 1, customer_messages: 1, status: "open" });

    // Facts stay current: a close today is projected on the next run.
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "close", conversationId: last.conversationId }));
    await project();
    assert.deepEqual((await asql("a", "SELECT closes,status FROM a_conversations WHERE conversation_id=$1", [last.conversationId]))[0], { closes: 1, status: "closed" });

    // The acceptance test: Ada's plan is edited today; last month's report still says "pro" (her
    // plan when that conversation started), and the change is kept as its own row.
    const monthStart = new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth(), 1));
    const monthEnd = new Date(Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 1));
    const report = () => conversationSummary(analytics, "a", { from: monthStart, to: monthEnd }, "plan");
    const was = await report();
    assert.deepEqual(was, { newConversations: 1, firstResponseMedianMs: 600_000, firstResponseMedianBusinessMs: was.firstResponseMedianBusinessMs, byAttribute: [{ value: "pro", count: 1 }] });
    await sql("a", "UPDATE contacts SET profile='{\"plan\":\"free\"}' WHERE id=$1", [ada.contactId]);
    await project();
    assert.deepEqual(await report(), was, "an edit today doesn't change last month");
    // Each change is its own row: setting her plan to pro before she wrote, then to free today.
    assert.deepEqual(await asql("a", "SELECT contact_id,profile FROM a_contact_changes ORDER BY changed_at"), [
      { contact_id: ada.contactId, profile: { plan: "pro" } },
      { contact_id: ada.contactId, profile: { plan: "free" } },
    ]);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM contact_changes"))[0].n, 2);
    await assert.rejects(sql("a", "DELETE FROM contact_changes"), /append-only/);
    await assert.rejects(sql("a", "UPDATE conversation_snapshots SET role='lead'"), /append-only/);

    // The status page: as of when, how many, and the dictionary.
    const status = (await agent("reporting-status")).body;
    assert.equal(status.connected, true);
    assert.equal(status.conversations, 251);
    assert.ok(Date.now() - Date.parse(status.asOf) < 60_000);
    assert.ok(status.metrics.some((m: { id: string }) => m.id === "first_response_time"));

    // Another workspace: its store rows are its own; a's aren't visible to it.
    await sql("b", "UPDATE workspace_features SET enabled=true WHERE name='reports_v1'");
    const vb = await tenant(db.connect, "b", (q) => getIdentity(q, "b", "anonymous", "device-b"));
    await start(vb.identityId, "B's question", "b");
    await project("b");
    assert.equal((await asql<{ n: number }>("b", "SELECT count(*)::int AS n FROM a_conversations"))[0].n, 1);
    assert.equal((await agent("reporting-status", "owner-b", "b")).body.conversations, 1);
    assert.equal((await conversationSummary(analytics, "b", { from: monthStart, to: monthEnd })).newConversations, 0);

    // The rollback: the flag off, the projection stops and the page closes; the snapshots stay.
    const rollback = readFileSync("db/rollback/0074_reporting_sources.sql", "utf8");
    for (const statement of rollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await sql("a", statement);
    await start(ada.identityId, "After the rollback");
    assert.equal(await project(), 0);
    assert.equal((await asql<{ n: number }>("a", "SELECT count(*)::int AS n FROM a_conversations"))[0].n, 251);
    assert.equal((await agent("reporting-status")).status, 404);
    // The store's own rollback: it starts again from the beginning, changing nothing.
    const storeRollback = readFileSync("db/analytics-rollback/0001_facts.sql", "utf8");
    for (const statement of storeRollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await asql("a", statement);
    assert.deepEqual(await asql("a", "SELECT watermark='-infinity' AS reset FROM a_projection"), [{ reset: true }]);
  } finally {
    await db.close();
    await store.close();
  }
});
