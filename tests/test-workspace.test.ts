import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { isTest, mayActIn, pairOf } from "../server/test-workspace";
import { COPIED, NOT_COPIED, SAMPLE_PEOPLE } from "../server/test-copy";
import { issueDueInvoices } from "../server/invoices";
import { registerChannel, runDelivery, type ChannelAdapter, type Outbound, type SendResult } from "../server/channels";
import type { Job } from "../server/jobs";
import { periodOf } from "../lib/seats";

/**
 * The paired test workspace (docs/TEST_WORKSPACE_PLAN.md, T1a): a workspace of its own, owned by a
 * production one, that a teammate reaches with the session they already have — and that cannot
 * reach a real person or be billed.
 */
test("what a test workspace is made of covers every table, once", async () => {
  const db = await testDatabase();
  try {
    const tables = (
      await db.pg.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
    ).rows.map((r) => r.t);
    const copied = new Set(COPIED.map((c) => c.table));
    const not = new Set(Object.keys(NOT_COPIED));
    assert.deepEqual(
      tables.filter((t) => !copied.has(t) && !not.has(t)),
      [],
      "every table is copied into a test workspace or says why it isn't",
    );
    assert.deepEqual([...copied].filter((t) => not.has(t)), [], "never both");
    assert.deepEqual([...copied, ...not].filter((t) => !tables.includes(t)), [], "no table that isn't there");
    // Nothing that could reach a person or sign someone in comes with it.
    for (const table of ["ai_providers", "api_tokens", "teammate_credentials", "teammate_sessions", "sso_connections", "email_domains", "whatsapp_numbers", "portal_domains", "invoices"])
      assert.ok(not.has(table), `${table} must never be copied into a test workspace`);
  } finally {
    await db.close();
  }
});

/** A channel that records what it was asked to send, so "it was never asked" can be proved. */
const sent: Outbound[] = [];
const mail: ChannelAdapter = {
  id: "mail",
  capabilities: { richText: false, attachments: false, buttons: false, maxLength: 1000, windowHours: null, ai: false, receipts: "none", address: "email" },
  address: (raw) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim()) ? raw.trim().toLowerCase() : null),
  async send(out): Promise<SendResult> {
    sent.push(out);
    return { status: "sent", providerId: "p-" + sent.length };
  },
};

test("the pair: made by a manager, reached with one sign-in, and unable to touch anyone", async () => {
  const off = registerChannel(mail);
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    storageTransport: "local-pglite",
  };
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  /** A request as the agent app makes it: the session's workspace, and the one chosen in it. */
  const agent = async (path: string, data?: unknown, principal = "owner-a", w = "a", actAs?: string) => {
    const r = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          ...(actAs ? { "x-relay-workspace": actAs } : {}),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      principal,
      { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: w, RELAY_BRIDGE_SECRET: env.bridgeSecret },
      (x) => handleApi(x, env),
    );
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
      await q(w, "DELETE FROM calendar_assignments");
    }
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");

    // Before there is one, the pair is just this workspace.
    const alone = await agent("workspaces");
    assert.deepEqual([alone.status, alone.body.here, alone.body.counterpart], [200, "production", null]);

    // Only a manager makes one.
    assert.equal((await agent("workspaces", { action: "create_test" }, "agent-1-a")).status, 403);
    const made = await agent("workspaces", { action: "create_test" });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const t = made.body.id as string;
    assert.equal(t, "a-test");
    assert.equal(await tenant(db.connect, t, (x) => isTest(x, t)), true);
    assert.equal(await tenant(db.connect, "a", (x) => isTest(x, "a")), false);
    // One per workspace, and a test workspace has none of its own.
    assert.equal((await agent("workspaces", { action: "create_test" })).body.error.code, "TEST_EXISTS");
    assert.equal((await agent("workspaces", { action: "create_test" }, "owner-a", "a", t)).body.error.code, "ALREADY_A_TEST");
    // Creating it is in the audit log of the workspace that made it.
    assert.equal((await q("a", "SELECT 1 FROM audit_events WHERE action='workspace.test_created'")).length, 1);

    // It carries the same plan, features, roles and people — so what you prove there means something.
    assert.equal((await q<{ plan: string }>(t, "SELECT plan FROM workspace_plans"))[0].plan, (await q<{ plan: string }>("a", "SELECT plan FROM workspace_plans"))[0].plan);
    assert.deepEqual(
      (await q<{ principal_id: string; role_id: string }>(t, "SELECT principal_id,role_id FROM teammates ORDER BY principal_id")).map((r) => [r.principal_id, r.role_id]),
      (await q<{ principal_id: string; role_id: string }>("a", "SELECT principal_id,role_id FROM teammates ORDER BY principal_id")).map((r) => [r.principal_id, r.role_id]),
    );
    assert.ok((await q(t, "SELECT 1 FROM roles")).length >= 3);

    // T1b: the configuration came with it, and made-up customers to work against.
    assert.deepEqual(
      (await q<{ name: string }>(t, "SELECT name FROM macros ORDER BY name")).map((r) => r.name),
      (await q<{ name: string }>("a", "SELECT name FROM macros ORDER BY name")).map((r) => r.name),
      "the macros a team wrote are there",
    );
    assert.deepEqual(
      (await q<{ id: string }>(t, "SELECT id FROM teams ORDER BY id")).map((r) => r.id),
      (await q<{ id: string }>("a", "SELECT id FROM teams ORDER BY id")).map((r) => r.id),
    );
    assert.deepEqual(
      (await q<{ id: string }>(t, "SELECT id FROM knowledge_records ORDER BY id")).map((r) => r.id),
      (await q<{ id: string }>("a", "SELECT id FROM knowledge_records ORDER BY id")).map((r) => r.id),
      "and what Zoe answers from",
    );
    // Nothing that could reach a person or sign someone in came with it.
    for (const table of ["api_tokens", "teammate_credentials", "teammate_sessions", "email_domains", "whatsapp_numbers", "invoices"])
      assert.equal((await q(t, `SELECT 1 FROM ${table}`)).length, 0, table);
    // Its customers are made up, and nobody could be written to if a reply were sent.
    const people = await q<{ name: string }>(t, "SELECT name FROM contacts ORDER BY name");
    assert.equal(people.length, SAMPLE_PEOPLE.length);
    assert.ok(people.every((x) => x.name.includes("(made up)")), JSON.stringify(people));
    const addresses = await q<{ email: string }>(t, "SELECT email FROM contact_emails");
    assert.ok(
      addresses.length > 0 && addresses.every((x) => x.email.endsWith("@example.invalid")),
      "a reserved name, so nothing could be delivered even if something tried: " + JSON.stringify(addresses),
    );
    assert.equal((await q(t, "SELECT 1 FROM conversations")).length, SAMPLE_PEOPLE.length, "each of them began one");
    assert.ok((await q(t, "SELECT 1 FROM conversation_parts WHERE body<>''")).length >= SAMPLE_PEOPLE.length);

    // The pair, from either side.
    const fromProduction = (await agent("workspaces")).body;
    assert.deepEqual([fromProduction.here, fromProduction.current.id, fromProduction.counterpart], ["production", "a", t]);
    const fromTest = (await agent("workspaces", undefined, "owner-a", "a", t)).body;
    assert.deepEqual([fromTest.here, fromTest.current.id, fromTest.counterpart], ["test", t, "a"]);
    assert.equal(fromTest.current.name, "Relay (test)");

    // One sign-in: the production session works in the pair, and the route runs there.
    const inTest = await agent("inbox", undefined, "owner-a", "a", t);
    assert.equal(inTest.status, 200, JSON.stringify(inTest.body).slice(0, 200));
    assert.equal(inTest.body.conversations.length, SAMPLE_PEOPLE.length, "its own inbox, with its own made-up people in it");

    // Nothing else: not another workspace, and not one where this teammate has no role.
    assert.equal((await agent("inbox", undefined, "owner-a", "a", "b")).body.error.code, "WORKSPACE_NOT_YOURS");
    // Someone who joined production after the pair was made is not in the test workspace, and
    // their session reaches only the workspace they are a teammate of.
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-2','agent-2-a','Agent two','agent')");
    assert.equal((await agent("inbox", undefined, "agent-2-a", "a", t)).body.error.code, "WORKSPACE_NOT_YOURS", "not a teammate there");
    assert.equal((await agent("inbox", undefined, "agent-2-a")).status, 200, "and at work in production as usual");
    assert.equal(await mayActIn(db.connect, "a", t, "owner-a"), true);
    assert.equal(await mayActIn(db.connect, "a", "b", "owner-a"), false);
    assert.equal(await mayActIn(db.connect, t, "a", "owner-a"), false, "the pair is not a way back the other way");

    // Nothing it does reaches a real person: a delivery ends in its own record of what would have
    // been sent, and the provider is never asked. The same conversation in production does send.
    assert.equal((await tenant(db.connect, t, (x) => pairOf(x, t)))?.here, "test");
    const conversation = async (w: string) => {
      await q(w, "INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,status,assigned,created_at,updated_at) VALUES($1,'c1','default','','Made up','made-up@test.invalid','A question','open','',now(),now())", [w]);
      await q(w, "INSERT INTO conversation_parts(workspace_id,id,conversation_id,seq,kind,author_type,author_id,audience,channel,body,data) VALUES($1,'p1','c1',1,'teammate_reply','teammate','owner','public','mail','Here is an answer','{}')", [w]);
      const id = crypto.randomUUID();
      await q(w, "INSERT INTO channel_deliveries(workspace_id,id,part_id,conversation_id,channel,identity_id,address,status,purpose) VALUES($1,$2,'p1','c1','mail','i1','someone@real.example','queued','reply')", [w, id]);
      return id;
    };
    const deliver = (w: string, id: string) => runDelivery(db.connect, {}, { id: "job-" + id, workspace_id: w, payload: { deliveryId: id }, attempts: 1 } as unknown as Job);
    const inTestWorkspace = await conversation(t);
    await deliver(t, inTestWorkspace);
    assert.deepEqual(sent, [], "the provider is never asked, in a test workspace");
    const recorded = await q<{ channel: string; address: string; body: string }>(t, "SELECT channel,address,body FROM test_deliveries");
    assert.deepEqual(
      recorded.map((r) => [r.channel, r.address, r.body]),
      [["mail", "someone@real.example", "Here is an answer"]],
      "what it would have sent is kept, so a team can see it",
    );
    assert.equal((await q<{ status: string }>(t, "SELECT status FROM channel_deliveries"))[0].status, "sent");
    // In production the same reply goes out, so the sink is the test workspace's own behaviour.
    const inProduction = await conversation("a");
    await deliver("a", inProduction);
    assert.equal(sent.length, 1, "production still sends");
    assert.equal((await q("a", "SELECT 1 FROM test_deliveries")).length, 0);

    // Billing never touches it.
    await q(t, "UPDATE workspace_features SET enabled=true WHERE name='billing_v1'");
    const anchor = new Date(Date.now() - 20 * 86_400_000);
    await q(t, "UPDATE workspace_plans SET period_anchor=$1", [anchor]);
    assert.equal(
      await issueDueInvoices(db.connect, t, {}, new Date(periodOf(anchor, new Date()).end.getTime() + 1000)),
      null,
      "a test workspace is never invoiced",
    );
    assert.equal((await q(t, "SELECT 1 FROM invoices")).length, 0);

    // Isolation: each side sees only its own rows — the same id in both is two different
    // conversations — and workspace b sees neither.
    assert.equal((await q("a", "SELECT 1 FROM workspace WHERE id=$1", [t])).length, 0, "production cannot even read the test workspace's row");
    assert.deepEqual(
      (await q<{ title: string }>("a", "SELECT title FROM conversations WHERE id='c1'")).length,
      (await q<{ title: string }>(t, "SELECT title FROM conversations WHERE id='c1'")).length,
      "one each, kept apart by tenancy like any other pair of workspaces",
    );
    assert.equal((await agent("workspaces", undefined, "owner-b", "b")).body.counterpart, null);
    assert.equal((await agent("inbox", undefined, "owner-b", "b", t)).body.error.code, "WORKSPACE_NOT_YOURS");

    // Rollback: the pair is undone, and the test workspace is simply a workspace of its own again.
    await q(t, "UPDATE workspace SET test_of=NULL WHERE id=$1", [t]);
    assert.equal(await tenant(db.connect, t, (x) => isTest(x, t)), false);
    assert.equal((await agent("inbox", undefined, "owner-a", "a", t)).body.error.code, "WORKSPACE_NOT_YOURS", "nobody switches into it any more");
  } finally {
    off();
    await db.close();
  }
});
