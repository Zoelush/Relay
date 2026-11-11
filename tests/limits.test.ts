import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { runJob, type Job } from "../server/jobs";
import { runAiReply, type AiEnvironment } from "../server/ai-agent";
import { standInAnswerModel, standInClassifier, type RerankPort } from "../server/ai-model";
import { memoryVectorStore, testEmbedder } from "../server/knowledge-index";
import { admit } from "../server/outbound";
import { runDelivery, releaseDeferred } from "../server/channels";
import { runConnector, type ConnectorEnvironment } from "../server/connectors";
import { changeLimits, pausedFor, readLimits } from "../server/limits";
import { blankDefinition, type OutboundDefinition } from "../lib/outbound";
import { ORDER_LOOKUP } from "./fixtures/connectors";
import "../server/email-in";

/** Limits and the spend cap (phase 16, C9b; docs/SECURITY_STEP17.md). */
test("limits: set by billing managers; reaching one pauses automated sends only (Zoe, outbound, automated messages, connector calls); raising it resumes them; per workspace; rollback", async () => {
  const db = await testDatabase();
  const rerank: RerankPort = { model: "fixed", score: async (_q, texts) => texts.map(() => 0.9) };
  const ai: AiEnvironment = { model: standInAnswerModel(), rerank, index: { embedders: [testEmbedder()], vectors: memoryVectorStore() }, classify: standInClassifier() };
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const t = <T>(w: string, fn: (x: Parameters<Parameters<typeof tenant>[2]>[0]) => Promise<T>) => tenant(db.connect, w, fn);
  const drain = async (w = "a") => {
    for (let i = 0; i < 50; i++) {
      const job = (await q<{ id: string }>(w, "SELECT id FROM jobs WHERE kind='ai.reply' AND state IN ('queued','running') ORDER BY created_at LIMIT 1"))[0];
      if (!job) return;
      await runJob(db.connect, w, job.id, { "ai.reply": (j: Job) => runAiReply(db.connect, ai, j) });
    }
  };
  const start = async (text: string) =>
    t("a", async (x) => {
      const who = await getIdentity(x, "a", "user", "u-" + crypto.randomUUID(), { name: "Ada", email: `${crypto.randomUUID()}@customer.example` });
      const r = (await command(x, "a", { type: "contact", identityId: who.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text } as unknown as Parameters<typeof command>[4])) as {
        conversationId: string;
      };
      const part = (await x.query<{ id: string }>("SELECT id FROM conversation_parts WHERE conversation_id=$1 AND body<>'' ORDER BY seq LIMIT 1", [r.conversationId])).rows[0].id;
      return { id: r.conversationId, part, identityId: who.identityId, contactId: who.contactId };
    });
  try {
    for (const w of ["a", "b"]) {
      await t(w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
      await q(w, "DELETE FROM calendar_assignments");
      await q(w, "INSERT INTO ai_agents(workspace_id,id,name) VALUES($1,'default','Zoe') ON CONFLICT DO NOTHING", [w]);
    }
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");
    // A billing period running since a few days ago.
    await q("a", "UPDATE workspace_plans SET period_anchor=now()-interval '3 days'");

    // Nothing is limited by default.
    const initial = await t("a", (x) => readLimits(x, "a"));
    assert.deepEqual([initial.spendCapCents, initial.paused, initial.capApplies], [null, {}, false]);
    assert.ok(Object.values(initial.limits).every((v) => v === null));

    // Setting limits: billing managers only; whole numbers; a cap of at least $1.
    await assert.rejects(t("a", (x) => changeLimits(x, "a", "agent-1-a", { limits: { emails: 5 } })), /permission/);
    await assert.rejects(t("a", (x) => changeLimits(x, "a", "owner-a", { limits: { emails: 0 } })), /whole number of emails, at least 1/);
    await assert.rejects(t("a", (x) => changeLimits(x, "a", "owner-a", { limits: { nothing: 5 } })), /Choose a meter/);
    await assert.rejects(t("a", (x) => changeLimits(x, "a", "owner-a", { spendCapCents: 50 })), /at least \$1\.00/);

    // Zoe: one AI resolution allowed this period, and one already recorded: she stops answering.
    const first = await start("How do refunds work?");
    await drain(); // answered (or not) before any limit
    await q("a", "INSERT INTO ai_resolutions(workspace_id,id,kind,conversation_id,agent_id,rule,window_hours,recorded_at) VALUES('a','r1','resolution',$1,'default','confirmed',24,now())", [first.id]);
    const set = await t("a", (x) => changeLimits(x, "a", "owner-a", { limits: { ai_resolutions: 1, emails: 1, outbound_chats: 1, connector_calls: 1 } }));
    assert.equal(set.limits.ai_resolutions, 1);
    assert.match(set.paused.ai_resolutions!, /limit for AI resolutions \(1\) is reached/);
    assert.equal((await q("a", "SELECT count(*)::int AS n FROM audit_events WHERE action='usage_limit.created'"))[0].n, 4);
    const second = await start("And shipping?");
    await drain();
    const note = await q<{ body: string; audience: string }>("a", "SELECT body,audience FROM conversation_parts WHERE conversation_id=$1 AND kind='internal_note'", [second.id]);
    assert.equal(note.length, 1);
    assert.match(note[0].body, /^Zoe didn't answer: This period's limit for AI resolutions \(1\) is reached\. A teammate needs to reply\.$/);
    assert.equal(note[0].audience, "internal", "never delivered to the customer");
    assert.equal((await q("a", "SELECT count(*)::int AS n FROM conversation_parts WHERE conversation_id=$1 AND kind='ai_reply'", [second.id]))[0].n, 0);
    assert.deepEqual(await q("a", "SELECT ai_state FROM conversations WHERE id=$1", [second.id]), [{ ai_state: "escalated" }]);
    assert.deepEqual(await q("a", "SELECT outcome FROM ai_answers WHERE conversation_id=$1", [second.id]), [{ outcome: "skipped" }]);

    // Outbound: over its limit, a chat waits ("later", with the reason); a banner has its own limit.
    await q("a", "INSERT INTO subscription_types(workspace_id,id,name,consent,channel,created_by) VALUES('a','t','Tips','opt_out','in_app','owner')");
    await q("a", "INSERT INTO outbound_messages(workspace_id,id,type,title,state,draft,created_by,updated_by) VALUES('a','m0','chat','Earlier','live','{}','owner','owner')");
    await q("a", "INSERT INTO outbound_entries(workspace_id,id,message_id,version,contact_id,entry_key,status,entered_at) VALUES('a','e0','m0',1,$1,'k0','sent',now())", [first.contactId]);
    const def = (type: "chat" | "banner"): OutboundDefinition => ({ ...blankDefinition(type, "owner"), subscriptionTypeId: "t", holdoutPercent: 0, quietHours: false } as OutboundDefinition);
    const live = { id: "m1", title: "Welcome", version: 1, def: def("chat"), effective_at: new Date() };
    await q("a", "INSERT INTO outbound_messages(workspace_id,id,type,title,state,draft,created_by,updated_by) VALUES('a','m1','chat','Welcome','live','{}','owner','owner')");
    let delivered = 0;
    const deliver = async () => {
      delivered++;
      return { channel: "in_app", conversationId: null, partId: null };
    };
    const chat = await t("a", (x) => admit(x, "a", live, def("chat"), 1, second.contactId, "k1", deliver));
    assert.deepEqual([chat.status, chat.reason, delivered], ["later", "This period's limit for outbound chats (1) is reached.", 0]);
    assert.equal((await t("a", (x) => pausedFor(x, "a", "outbound_banners"))), null, "banners have their own limit");

    // Automated channel messages are held to the period's end; a teammate's reply never is.
    const workflowPart = (await q<{ id: string }>("a", "INSERT INTO conversation_parts(workspace_id,id,conversation_id,seq,kind,author_type,author_id,audience,channel,body,data) VALUES('a',$1,$2,200,'workflow_message','system','workflow:w1','public','email','Thanks for writing','{}') RETURNING id", [crypto.randomUUID(), first.id]))[0].id;
    const teammatePart = (await q<{ id: string }>("a", "INSERT INTO conversation_parts(workspace_id,id,conversation_id,seq,kind,author_type,author_id,audience,channel,body,data) VALUES('a',$1,$2,201,'teammate_reply','teammate','owner','public','email','Hello from a person','{}') RETURNING id", [crypto.randomUUID(), first.id]))[0].id;
    const queue = async (part: string, status = "queued") => {
      const id = crypto.randomUUID();
      await q("a", "INSERT INTO channel_deliveries(workspace_id,id,part_id,conversation_id,channel,identity_id,address,status) VALUES('a',$1,$2,$3,'email',$4,'ada@customer.example',$5)", [id, part, first.id, crypto.randomUUID(), status]);
      return id;
    };
    await queue(first.part, "sent"); // one email already sent this period: the limit (1) is reached
    const automated = await queue(workflowPart);
    const human = await queue(teammatePart);
    const deliver1 = (id: string) => runDelivery(db.connect, {}, { workspace_id: "a", id: crypto.randomUUID(), kind: "channel.deliver", state: "running", payload: { deliveryId: id }, result: null, attempts: 1 } as unknown as Job);
    await deliver1(automated);
    await deliver1(human).catch(() => undefined);
    const held = (await q<{ status: string; limit_held: boolean; not_before: Date | null; error: string }>("a", "SELECT status,limit_held,not_before,error FROM channel_deliveries WHERE id=$1", [automated]))[0];
    assert.deepEqual([held.status, held.limit_held, held.error], ["queued", true, "This period's limit for emails (1) is reached."]);
    assert.ok(held.not_before && new Date(held.not_before).getTime() > Date.now() + 86_400_000, "held to the period's end");
    assert.equal((await q<{ limit_held: boolean }>("a", "SELECT limit_held FROM channel_deliveries WHERE id=$1", [human]))[0].limit_held, false, "a teammate's reply is never held");

    // Connector calls by Zoe stop at the limit (refused calls are free).
    await q("a", "INSERT INTO ai_connectors(workspace_id,id,name,draft,created_by) VALUES('a','k','Orders',$1,'owner')", [JSON.stringify(ORDER_LOOKUP.definition)]);
    await q("a", "INSERT INTO ai_connector_calls(workspace_id,id,connector_id,draft,source,invoked_by,method,url,duration_ms,result) VALUES('a','c0','k',true,'agent','zoe','GET','https://x',5,'ok')");
    const env: ConnectorEnvironment = { key: "k".repeat(48), sleep: async () => {} };
    const call = await runConnector(db.connect, env, "a", { connectorId: "k", version: "draft", values: { order_id: "A1234" }, source: "agent", invokedBy: "zoe", conversationId: first.id });
    assert.deepEqual([call.result, call.error], ["refused", "This period's limit for connector calls (1) is reached."]);

    // The spend cap: saved, but not applied while prices are placeholders.
    const capped = await t("a", (x) => changeLimits(x, "a", "owner-a", { spendCapCents: 1000 }));
    assert.deepEqual([capped.spendCapCents, capped.capApplies, capped.spentCents], [1000, false, null]);

    // Raising the limits: held messages go (through the sweep), and everything resumes.
    const raised = await t("a", (x) => changeLimits(x, "a", "owner-a", { limits: { ai_resolutions: null, emails: 100, outbound_chats: 100, connector_calls: null } }));
    assert.deepEqual(raised.paused, {});
    const released = (await q<{ limit_held: boolean; not_before: Date | null }>("a", "SELECT limit_held,not_before FROM channel_deliveries WHERE id=$1", [automated]))[0];
    assert.equal(released.limit_held, false);
    assert.ok(released.not_before && new Date(released.not_before).getTime() <= Date.now() + 1000);
    await releaseDeferred(db.connect, "a");
    assert.equal((await q("a", "SELECT 1 FROM jobs WHERE kind='channel.deliver' AND payload->>'deliveryId'=$1", [automated])).length, 1, "queued to send");
    assert.equal((await t("a", (x) => admit(x, "a", live, def("chat"), 1, second.contactId, "k1", deliver))).status, "sent");
    assert.equal(delivered, 1);

    // Phone minutes: a completed 120-second call is 2 minutes, over a limit of 1. (Zoe checks this on a
    // call, in runAiReply; a real call needs the voice channel, covered by its own tests.)
    await q("a", "INSERT INTO voice_calls(workspace_id,id,call_sid,conversation_id,number_id,from_phone,to_phone,status,duration_seconds,started_at) VALUES('a','v1','CA1',$1,'n1','+1','+2','completed',120,now())", [first.id]);
    await t("a", (x) => changeLimits(x, "a", "owner-a", { limits: { phone_minutes: 1 } }));
    assert.equal(await t("a", (x) => pausedFor(x, "a", "phone_minutes")), "This period's limit for phone minutes (1) is reached.");
    await t("a", (x) => changeLimits(x, "a", "owner-a", { limits: { phone_minutes: null } }));

    // Another workspace's limits are its own.
    assert.deepEqual((await t("b", (x) => readLimits(x, "b"))).limits.emails, null);
    await assert.rejects(t("b", (x) => changeLimits(x, "b", "owner-a", { limits: { emails: 1 } })), /permission/);

    // The rollback: limits and the cap gone; anything held is released for the sweep.
    await t("a", (x) => changeLimits(x, "a", "owner-a", { limits: { emails: 1 } }));
    const heldAgain = await queue(workflowPart);
    await deliver1(heldAgain);
    assert.equal((await q<{ limit_held: boolean }>("a", "SELECT limit_held FROM channel_deliveries WHERE id=$1", [heldAgain]))[0].limit_held, true);
    await db.pg.exec(await readFile("db/rollback/0095_limits.sql", "utf8"));
    assert.deepEqual((await t("a", (x) => readLimits(x, "a"))).paused, {});
    assert.equal((await q<{ limit_held: boolean }>("a", "SELECT limit_held FROM channel_deliveries WHERE id=$1", [heldAgain]))[0].limit_held, false);
  } finally {
    await db.close();
  }
});
