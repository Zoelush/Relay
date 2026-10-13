import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { append, command, conversation } from "../server/conversations";
import { runJob, type Job } from "../server/jobs";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { resumeWorkflow, startWorkflows } from "../server/workflow-engine";
import { resolveCalendar } from "../server/calendars";
import { deliveryReport, receiveInbound, registerChannel, runDelivery, type ChannelAdapter, type Inbound, type Outbound, type SendResult } from "../server/channels";

/**
 * The channel contract (phase 12, E1; docs/OMNICHANNEL_STEP1.md), through a stand-in channel shaped
 * like email: no formatting, no buttons, a 100-character limit, no Zoe, addresses for identities.
 */
const sent: Outbound[] = [];
let next: (out: Outbound) => Promise<SendResult> = async () => ({ status: "sent", providerId: "p-" + sent.length });
const mail: ChannelAdapter = {
  id: "mail",
  capabilities: { richText: false, attachments: true, buttons: false, maxLength: 100, windowHours: null, ai: false, receipts: "read", address: "email" },
  address: (raw) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim()) ? raw.trim().toLowerCase() : null),
  async send(out) {
    const r = await next(out);
    if (r.status !== "failed") sent.push(out);
    return r;
  },
};
const message = (m: Partial<Inbound> & { externalId: string; address: string; text: string }): Inbound => ({ verified: false, threadKeys: [], brandId: "default", ...m });

test("the channel contract: inbound threaded once, identities kept apart unless verified, replies delivered by the channel's job through one gate, office hours per channel", async () => {
  const off = registerChannel(mail);
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "channel.deliver": (j: Job) => runDelivery(db.connect, {}, j),
    "workflow.start": (j: Job) => startWorkflows(db.connect, j),
    "workflow.resume": (j: Job) => resumeWorkflow(db.connect, j),
  };
  const drain = async (w = "a") => {
    for (let i = 0; i < 100; i++) {
      const job = (
        await sql<{ id: string }>(w, "SELECT id FROM jobs WHERE (kind LIKE 'workflow.%' OR kind='channel.deliver') AND state IN ('queued','running') ORDER BY created_at LIMIT 1")
      )[0];
      if (!job) return;
      await runJob(db.connect, w, job.id, handlers);
    }
  };
  const agent = async (path: string, data?: unknown, principal = "owner-a", workspace = "a") => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: { origin: "https://app.test", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
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
  const inbound = (m: Inbound, w = "a") => tenant(db.connect, w, (q) => receiveInbound(q, w, mail, m));
  const reply = (id: string, text: string) => tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "reply", conversationId: id, text }));
  const deliveries = (id: string) =>
    sql<{ status: string; address: string; error: string }>("a", "SELECT status,address,error FROM channel_deliveries WHERE conversation_id=$1 ORDER BY created_at", [id]);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
      );
      await sql(w, "DELETE FROM calendar_assignments");
      await sql(w, "UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE name IN ('ai_agent_v1','workflows_v1','sla_v1')");
    }

    // Off by default: nothing is received, and the list isn't there.
    await assert.rejects(inbound(message({ externalId: "m0", address: "pat@example.com", text: "Hi" })), /Channels are not enabled/);
    assert.equal((await agent("suppressions")).status, 404);
    for (const w of ["a", "b"]) await sql(w, "UPDATE workspace_features SET enabled=true WHERE name='channels_v1'");

    // In: a new conversation on the channel, the customer's address kept (unverified), threaded by
    // keys, each provider message once. Zoe doesn't answer on a channel that doesn't allow her.
    const first = await inbound(message({ externalId: "m1", address: "Pat@Example.com", name: "Pat", text: "My order is late", ownKeys: ["<m1@mail>"], data: { subject: "Late order" } }));
    const c1 = first.conversationId!;
    const [row] = await sql("a", "SELECT channel,current_channel FROM conversations WHERE id=$1", [c1]);
    assert.deepEqual(row, { channel: "mail", current_channel: "mail" });
    const [part] = await sql("a", "SELECT channel,body,data FROM conversation_parts WHERE id=$1", [first.partId]);
    assert.deepEqual(part, { channel: "mail", body: "My order is late", data: { subject: "Late order" } });
    const contact = await sql(
      "a",
      `SELECT k.name,e.email,e.verified,x.address FROM conversations c JOIN identity_contact_mappings m ON m.workspace_id=c.workspace_id AND m.identity_id=c.primary_identity_id
       JOIN contacts k ON k.workspace_id=m.workspace_id AND k.id=m.contact_id JOIN contact_emails e ON e.workspace_id=k.workspace_id AND e.contact_id=k.id
       JOIN identity_addresses x ON x.workspace_id=c.workspace_id AND x.identity_id=c.primary_identity_id WHERE c.id=$1`,
      [c1],
    );
    assert.deepEqual(contact, [{ name: "Pat", email: "pat@example.com", verified: false, address: "pat@example.com" }]);
    assert.deepEqual(await inbound(message({ externalId: "m1", address: "pat@example.com", text: "My order is late" })), { conversationId: c1, partId: first.partId, duplicate: true, identityId: null });
    const second = await inbound(message({ externalId: "m2", address: "pat@example.com", text: "Any news?", threadKeys: ["<m1@mail>"] }));
    assert.equal(second.conversationId, c1);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM conversation_parts WHERE conversation_id=$1 AND kind='customer_message'", [c1]))[0].n, 2);
    assert.deepEqual(await sql("a", "SELECT 1 FROM jobs WHERE kind='ai.reply'"), []);
    // An automatic message (an auto-reply) is kept for teammates only, and answers nothing.
    const auto = await inbound(message({ externalId: "m3", address: "pat@example.com", text: "I'm away", threadKeys: ["<m1@mail>"], automatic: true }));
    const [autoPart] = await sql("a", "SELECT kind,audience FROM conversation_parts WHERE id=$1", [auto.partId]);
    assert.deepEqual(autoPart, { kind: "system_event", audience: "internal" });
    const dropped = await inbound(message({ externalId: "m4", address: "nobody@example.com", text: "Out of office", automatic: true }));
    assert.deepEqual({ ...dropped, identityId: undefined }, { conversationId: null, partId: null, automatic: true, identityId: undefined });

    // Identity: an unverified address never joins a signed-in user with it; a verified one does.
    await tenant(db.connect, "a", async (q) => {
      const user = await getIdentity(q, "a", "user", "user-42", { name: "Sam", email: "sam@example.com" });
      await q.query("UPDATE contact_emails SET verified=true WHERE workspace_id='a' AND contact_id=$1", [user.contactId]);
    });
    const samContact = (await sql("a", "SELECT contact_id FROM contact_emails WHERE email='sam@example.com' AND verified"))[0].contact_id;
    const forged = await inbound(message({ externalId: "f1", address: "sam@example.com", text: "Refund me", verified: false }));
    const verified = await inbound(message({ externalId: "f2", address: "SAM@example.com", text: "Hello again", verified: true }));
    const contactOf = async (id: string) =>
      (await sql("a", "SELECT m.contact_id FROM conversations c JOIN identity_contact_mappings m ON m.workspace_id=c.workspace_id AND m.identity_id=c.primary_identity_id WHERE c.id=$1", [id]))[0].contact_id;
    assert.notEqual(await contactOf(forged.conversationId!), samContact);
    // The same address arriving verified marks its identity so, but doesn't merge the earlier contact.
    assert.equal(forged.conversationId !== verified.conversationId, true);
    assert.equal((await sql("a", "SELECT verified FROM identity_addresses WHERE address='sam@example.com'"))[0].verified, true);
    const fresh = await inbound(message({ externalId: "f3", address: "lee@example.com", text: "Hi", verified: true }));
    await tenant(db.connect, "a", async (q) => {
      const user = await getIdentity(q, "a", "user", "user-43", { name: "Lee", email: "lee2@example.com" });
      await q.query("UPDATE contact_emails SET verified=true WHERE workspace_id='a' AND contact_id=$1", [user.contactId]);
    });
    const lee2 = await inbound(message({ externalId: "f4", address: "lee2@example.com", text: "Hi from my other address", verified: true }));
    const leeContact = (await sql("a", "SELECT contact_id FROM contact_emails WHERE email='lee2@example.com' AND verified ORDER BY contact_id LIMIT 1"))[0].contact_id;
    assert.equal(await contactOf(lee2.conversationId!), leeContact, "a verified address joins the person who has it");
    void fresh;

    // Out: a teammate's reply is delivered on the conversation's channel, to the customer's address,
    // as plain text; reports move it forward only.
    await reply(c1, "We're on it.");
    assert.deepEqual(await deliveries(c1), [{ status: "queued", address: "pat@example.com", error: "" }]);
    await drain();
    assert.deepEqual(sent.map((s) => [s.address, s.text]), [["pat@example.com", "We're on it."]]);
    assert.equal((await deliveries(c1))[0].status, "sent");
    await tenant(db.connect, "a", (q) => deliveryReport(q, "a", "mail", "p-0", { status: "read" }));
    await tenant(db.connect, "a", (q) => deliveryReport(q, "a", "mail", "p-0", { status: "delivered" }));
    assert.equal((await deliveries(c1))[0].status, "read", "a late report doesn't go back");
    const shown = (await agent(`deliveries?conversation=${c1}`)).body.deliveries;
    assert.deepEqual(shown.map((d: { status: string; channel: string }) => [d.channel, d.status]), [["mail", "read"]]);
    assert.equal((await agent(`deliveries?conversation=${c1}`, undefined, "owner-b", "b")).status, 404);
    // Too long for the channel: refused, nothing written or sent.
    await assert.rejects(reply(c1, "x".repeat(101)), /takes messages of up to 100 characters/);
    // The customer writes on the messenger: replies go there now, not by the channel.
    const identity = (await sql("a", "SELECT primary_identity_id FROM conversations WHERE id=$1", [c1]))[0].primary_identity_id;
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "contact", identityId: identity, brandId: "default" }, crypto.randomUUID(), { action: "reply", conversationId: c1, text: "Now on the website" }));
    assert.equal((await sql("a", "SELECT current_channel FROM conversations WHERE id=$1", [c1]))[0].current_channel, "messenger");
    await reply(c1, "Got you here.");
    assert.equal((await deliveries(c1)).length, 1, "no delivery for the messenger");
    await inbound(message({ externalId: "m5", address: "pat@example.com", text: "Back by email", threadKeys: ["<m1@mail>"] }));
    assert.equal((await sql("a", "SELECT current_channel FROM conversations WHERE id=$1", [c1]))[0].current_channel, "mail");

    // The gate: a suppressed address is sent nothing, through any path (a teammate's reply, a
    // workflow's message, Zoe's reply, an attachment).
    const added = await agent("suppression", { action: "add", channel: "mail", address: "PAT@example.com", note: "Asked us to stop" });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.deepEqual(
      added.body.entries.map((e: { address: string; reason: string; liftable: boolean }) => [e.address, e.reason, e.liftable]),
      [["pat@example.com", "manual", true]],
    );
    const before = sent.length;
    await reply(c1, "Teammate's reply");
    const flow = await agent("workflow", {
      action: "create",
      name: "Say thanks",
      definition: { trigger: { type: "note_added" }, paths: [{ id: "A", label: "", steps: [{ id: "s", type: "message", options: { text: "Workflow's message" } }], next: { type: "end" } }] },
    });
    await agent("workflow", { action: "publish", id: flow.body.workflow.id, version: flow.body.workflow.version });
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "note", conversationId: c1, text: "Thanking them" }));
    await tenant(db.connect, "a", async (q) => {
      const c = await conversation(q, "a", c1);
      await append(q, "a", c, { type: "ai", id: "zoe" }, "ai_reply", "Zoe's reply", {});
      await append(q, "a", c, { type: "teammate", id: "owner-a" }, "attachment", "", { name: "invoice.pdf" });
    });
    await drain();
    const blocked = await deliveries(c1);
    assert.deepEqual(blocked.slice(1).map((d) => d.status), ["suppressed", "suppressed", "suppressed", "suppressed"]);
    assert.equal(blocked[1].error, "The address is suppressed (manual).");
    assert.equal(sent.length, before, "nothing was sent");
    await sql("a", "UPDATE workflows SET state='paused' WHERE id=$1", [flow.body.workflow.id]);

    // A provider's permanent failure suppresses the address (a hard bounce); a transient one is
    // retried by the job, then given up on and marked as not delivered.
    const c2 = (await inbound(message({ externalId: "n1", address: "kim@example.com", text: "Hello" }))).conversationId!;
    next = async () => ({ status: "failed", error: "Mailbox doesn't exist", permanent: true, suppress: "hard_bounce" });
    await reply(c2, "Hi Kim");
    await drain();
    assert.deepEqual((await deliveries(c2)).map((d) => [d.status, d.error]), [["failed", "Mailbox doesn't exist"]]);
    const listed = (await agent("suppressions")).body.entries;
    assert.deepEqual(listed.find((e: { address: string }) => e.address === "kim@example.com").reason, "hard_bounce");
    const c3 = (await inbound(message({ externalId: "o1", address: "ola@example.com", text: "Hello" }))).conversationId!;
    next = async () => {
      throw new Error("Provider unreachable");
    };
    await reply(c3, "Hi Ola");
    for (let i = 0; i < 6; i++) {
      const job = (await sql<{ id: string }>("a", "SELECT id FROM jobs WHERE kind='channel.deliver' AND state IN ('queued','running') ORDER BY created_at LIMIT 1"))[0];
      if (job) await runJob(db.connect, "a", job.id, handlers);
    }
    assert.deepEqual((await deliveries(c3)).map((d) => d.status), ["failed"]);
    assert.match((await deliveries(c3))[0].error, /Gave up after 5 attempts: Provider unreachable/);
    assert.equal((await sql("a", "SELECT state FROM jobs WHERE kind='channel.deliver' ORDER BY created_at DESC LIMIT 1"))[0].state, "dead_letter");
    next = async () => ({ status: "sent", providerId: "p-later" });

    // Lifting: a manual block or a hard bounce can be lifted; an opt-out or complaint can't.
    const kim = listed.find((e: { address: string }) => e.address === "kim@example.com");
    assert.equal((await agent("suppression", { action: "lift", id: kim.id })).status, 200);
    await tenant(db.connect, "a", (q) => q.query("INSERT INTO suppressions(workspace_id,id,channel,address,reason,source) VALUES('a','opt','mail','ola@example.com','opt_out','keyword')"));
    const refused = await agent("suppression", { action: "lift", id: "opt" });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.message, "The customer opted out: only they can opt back in.");
    assert.equal((await agent("suppression", { action: "add", channel: "messenger", address: "x" })).body.error.code, "INVALID_CHANNEL");
    assert.equal((await agent("suppression", { action: "add", channel: "mail", address: "not an address" })).body.error.code, "INVALID_ADDRESS");
    // Another workspace's list is its own.
    assert.deepEqual((await agent("suppressions", undefined, "owner-b", "b")).body.entries, []);
    assert.equal((await agent("suppressions", undefined, "owner-b", "b")).body.channels.some((ch: { id: string }) => ch.id === "mail"), true);

    // Office hours per channel: a channel's calendar applies before the brand's, after the team's.
    await sql(
      "a",
      `INSERT INTO business_calendars(workspace_id,id,version,timezone,schedule) VALUES('a','mail-hours',1,'UTC','{"weekly":{"1":[["09:00","17:00"]]},"holidays":[]}')`,
    );
    await sql("a", "INSERT INTO calendars(workspace_id,id,name,current_version) VALUES('a','mail-hours','Mail hours',1)");
    const assigned = await agent("calendars", { op: "assign", scope: "channel", scopeId: "mail", calendarId: "mail-hours" });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal((await agent("calendars", { op: "assign", scope: "channel", scopeId: "fax", calendarId: "mail-hours" })).body.error.message, "Channel unavailable.");
    const resolved = (at: Parameters<typeof resolveCalendar>[2]) => tenant(db.connect, "a", (q) => resolveCalendar(q, "a", at));
    assert.equal((await resolved({ brandId: "default", channel: "mail" })).calendarId, "mail-hours");
    assert.equal((await resolved({ brandId: "default", channel: "messenger" })).calendarId, null);

    // The rollback: the flag goes off, unsent deliveries fail, channel hours go; the list stays.
    await sql("a", "UPDATE channel_deliveries SET status='queued' WHERE conversation_id=$1", [c3]);
    const rollback = await readFile("db/rollback/0062_channels.sql", "utf8");
    for (const statement of rollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await sql("a", statement);
    assert.deepEqual((await deliveries(c3)).map((d) => [d.status, d.error]), [["failed", "Stopped by rollback."]]);
    assert.equal((await resolved({ brandId: "default", channel: "mail" })).calendarId, null);
    assert.ok((await sql("a", "SELECT count(*)::int AS n FROM suppressions WHERE lifted_at IS NULL"))[0].n > 0);
  } finally {
    off();
    await db.close();
  }
});
