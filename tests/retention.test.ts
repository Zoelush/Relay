import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyticsDatabase, testDatabase } from "./database";
import { tenant, type Sql } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { checkEvent, recordEvent } from "../server/events";
import { seal } from "../server/connectors";
import { projectJob, type AnalyticsStore } from "../server/analytics";
import { changeRetention, readRetention, retentionJob, scheduleRetention } from "../server/retention";
import { localAttachmentStorage } from "../scripts/local-storage";
import { localSms, LOCAL_TWILIO } from "../scripts/local-sms";
import type { Job } from "../server/jobs";

/**
 * Retention policies (phase 16, C6a; docs/SECURITY_STEP9.md). With every policy at 90 days, a run
 * deletes what's older and nothing else: a closed conversation untouched for 100 days goes through
 * C5's cascade (its files too; reports keep the count; the contact stays), while a recent closed one
 * and an old open one stay; an old file is deleted and marked expired; an old call recording goes,
 * at Twilio too; old events and logs go. Periods are checked, previewed before saving, applied in the
 * job only (the append-only logs refuse otherwise), recorded in the audit log, run at most hourly by
 * the sweep, and never reach another workspace. The rollback puts every policy back to keep.
 */
test("retention: policies checked and previewed; a run deletes only what's older, everywhere; hourly; per workspace; rollback", async () => {
  const db = await testDatabase();
  const storage = localAttachmentStorage().storage;
  const KEY = "k".repeat(64);
  const store = await analyticsDatabase();
  const analytics: AnalyticsStore = { connect: store.connect };
  const twilio = localSms();
  const env = { storage, key: KEY, analytics, sms: twilio.api };
  const q = <T = Record<string, unknown>>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
    }
    const start = async (w: string, external: string, text: string) => {
      const who = await tenant(db.connect, w, (x) => getIdentity(x, w, "user", external, { name: "Ada", email: `${external}@customer.example` }));
      const r = (await tenant(db.connect, w, (x) =>
        command(x, w, { type: "contact", identityId: who.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text } as unknown as Parameters<typeof command>[4]),
      )) as { conversationId: string };
      return { ...who, conversationId: r.conversationId };
    };
    const old = await start("a", "ada", "An old, closed question");
    const recent = await start("a", "bob", "A recent, closed question");
    const open = await start("a", "cy", "An old question still open");
    const elsewhere = await start("b", "ada", "Workspace b's old question");
    await q("a", "UPDATE conversations SET status='closed',updated_at=$2 WHERE id=$1", [old.conversationId, ago(100)]);
    await q("a", "UPDATE conversations SET status='closed',updated_at=$2 WHERE id=$1", [recent.conversationId, ago(10)]);
    await q("a", "UPDATE conversations SET status='open',updated_at=$2 WHERE id=$1", [open.conversationId, ago(200)]);
    await q("b", "UPDATE conversations SET status='closed',updated_at=$2 WHERE id=$1", [elsewhere.conversationId, ago(100)]);
    const partOf = async (c: string) => (await q<{ id: string }>("a", "SELECT id FROM conversation_parts WHERE conversation_id=$1 ORDER BY seq LIMIT 1", [c]))[0].id;
    const oldContact = (await q<{ contact_id: string }>("a", "SELECT contact_id FROM identity_contact_mappings WHERE identity_id=$1", [old.identityId]))[0].contact_id;

    // Files: one in the old conversation, an old one and a new one in the recent conversation, and an old call recording.
    const file = async (conversation: string, key: string, days: number, recording = false) => {
      const id = crypto.randomUUID();
      await storage.putClean(key, new TextEncoder().encode("bytes"), "text/plain", key);
      await q(
        "a",
        "INSERT INTO attachments(workspace_id,id,conversation_id,object_key,name,size,mime,status,checksum,clean_key,audience,created_at) VALUES('a',$1,$2,$3,$3,5,'text/plain','clean','x',$3,'internal',$4)",
        [id, conversation, key, ago(days)],
      );
      if (recording)
        await q("a", "INSERT INTO conversation_parts(workspace_id,id,conversation_id,seq,kind,author_type,author_id,audience,channel,body,data) VALUES('a',$1,$2,99,'attachment','system','voice','internal','voice','',$3)", [
          crypto.randomUUID(),
          conversation,
          JSON.stringify({ attachmentId: id, voice: { recording: "call" } }),
        ]);
      return id;
    };
    await file(old.conversationId, "c/in-old-conversation", 100);
    const oldFile = await file(recent.conversationId, "c/old-file", 100);
    const newFile = await file(recent.conversationId, "c/new-file", 5);
    const recording = await file(recent.conversationId, "c/old-recording", 100, true);
    await q("a", "INSERT INTO sms_accounts(workspace_id,account_sid,token_sealed,created_by) VALUES('a',$1,$2,'owner')", [LOCAL_TWILIO.sid, await seal(KEY, "a", "sms:account", "token", LOCAL_TWILIO.token)]);
    await q("a", "INSERT INTO sms_numbers(workspace_id,id,brand_id,phone,calling_code,created_by) VALUES('a','num','default','+441000000000','44','owner')");
    await q("a", "INSERT INTO voice_calls(workspace_id,id,call_sid,conversation_id,number_id,from_phone,to_phone,status,recording_sid,started_at) VALUES('a','call','CAold',$1,'num','+447700900001','+441000000000','completed','REold',$2)", [
      recent.conversationId,
      ago(100),
    ]);
    // Events and logs, old and new.
    for (const [key, days] of [["e-old", 100], ["e-new", 5]] as const) {
      await tenant(db.connect, "a", (x) => recordEvent(x, "a", oldContact, checkEvent({ name: key, metadata: {} }), "api", key));
      await q("a", "UPDATE contact_events SET occurred_at=$2 WHERE dedupe_key=$1", [key, ago(days)]);
    }
    const recentPart = await partOf(recent.conversationId);
    for (const days of [100, 5])
      await q("a", "INSERT INTO ai_model_calls(workspace_id,id,conversation_id,question_part_id,kind,model,sent,redacted,redactions,created_at) VALUES('a',$1,$2,$3,'answer','stand-in','text',false,'{}',$4)", [
        crypto.randomUUID(),
        recent.conversationId,
        recentPart,
        ago(days),
      ]);
    for (const days of [100, 5]) await q("a", "INSERT INTO sms_inbound(workspace_id,id,kind,payload,status,received_at) VALUES('a',$1,'message','{}','read',$2)", [crypto.randomUUID(), ago(days)]);
    await q("a", "INSERT INTO sms_inbound(workspace_id,id,kind,payload,status,received_at) VALUES('a',$1,'message','{}','received',$2)", [crypto.randomUUID(), ago(100)]);

    // Reports have every conversation, before any retention.
    await projectJob(db.connect, analytics, { workspace_id: "a", payload: {}, result: null } as never);
    const reported = async () => (await tenant(store.connect, "a", async (x) => (await x.query<{ n: number }>("SELECT count(*)::int AS n FROM a_conversations")).rows))[0].n;
    const before = await reported();

    // Settings: for who manages security; periods checked; a change previewed before it's saved.
    const retention = (p: Record<string, unknown>, principal = "owner-a", w = "a") => tenant(db.connect, w, (x) => changeRetention(x, w, principal, p));
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','grace','grace-a','Grace','agent')");
    await assert.rejects(tenant(db.connect, "a", (x) => readRetention(x, "a", "grace-a")));
    await assert.rejects(retention({ action: "policies", policies: { conversations: 10 } }), /30 days to 7 years/);
    await assert.rejects(retention({ action: "policies", policies: { logs: 4000 } }), /30 days to 7 years/);
    const all = { conversations: 90, attachments: 90, recordings: 90, events: 90, logs: 90 };
    assert.deepEqual(((await retention({ action: "preview", policies: all })) as { wouldDelete: unknown }).wouldDelete, { conversations: 1, attachments: 2, recordings: 1, events: 1 });
    assert.deepEqual(((await retention({ action: "preview", policies: { conversations: 365 } })) as { wouldDelete: unknown }).wouldDelete, { conversations: 0, attachments: 0, recordings: 0, events: 0 });
    assert.deepEqual((await tenant(db.connect, "a", (x) => readRetention(x, "a", "owner-a"))).policies, { conversations: null, attachments: null, recordings: null, events: null, logs: null }, "keep by default");
    assert.equal(await scheduleRetention(db.connect, "a"), false, "nothing to do while everything is kept");
    const saved = await retention({ action: "policies", policies: all });
    assert.deepEqual((saved as { policies: unknown }).policies, all);

    // The append-only logs refuse a deletion outside a run.
    await assert.rejects(q("a", "DELETE FROM conversation_parts WHERE conversation_id=$1", [old.conversationId]), /append-only/);

    // A run (queued by the sweep): only what's older goes.
    assert.equal(await scheduleRetention(db.connect, "a"), true);
    assert.equal(await scheduleRetention(db.connect, "a"), false, "one run queued at a time");
    const job = (await q<Job>("a", "SELECT * FROM jobs WHERE kind='retention.apply' ORDER BY created_at DESC LIMIT 1"))[0];
    const result = (await retentionJob(db.connect, env, job)).result;
    assert.equal(result.conversations, 1);
    assert.deepEqual(
      (await q<{ id: string }>("a", "SELECT id FROM conversations ORDER BY id")).map((c) => c.id).sort(),
      [recent.conversationId, open.conversationId].sort(),
      "the old closed conversation went; the recent one and the old open one stay",
    );
    assert.equal((await q("a", "SELECT 1 FROM conversation_parts WHERE conversation_id=$1", [old.conversationId])).length, 0);
    assert.equal((await q("a", "SELECT 1 FROM contacts WHERE id=$1", [oldContact])).length, 1, "the contact stays");
    assert.equal(await reported(), before, "reports keep the count");
    assert.equal((await tenant(store.connect, "a", async (x) => (await x.query("SELECT 1 FROM a_conversations WHERE conversation_id=$1", [old.conversationId])).rows)).length, 0);
    assert.equal((await storage.readClean!("c/in-old-conversation")).status, 404, "its file went with it");
    // Files: the old one deleted and expired, the new one kept; the old recording too, and Twilio's copy.
    const status = async (id: string) => (await q<{ status: string; clean_key: string | null }>("a", "SELECT status,clean_key FROM attachments WHERE id=$1", [id]))[0];
    assert.deepEqual(await status(oldFile), { status: "expired", clean_key: null });
    assert.equal((await storage.readClean!("c/old-file")).status, 404);
    assert.deepEqual(await status(newFile), { status: "clean", clean_key: "c/new-file" });
    assert.equal((await status(recording)).status, "expired");
    assert.deepEqual(twilio.deleted, [{ kind: "recording", sid: "REold" }]);
    assert.deepEqual(await q("a", "SELECT recording_sid FROM voice_calls WHERE id='call'"), [{ recording_sid: null }], "not asked again");
    // Events and logs: old gone, new kept; an unprocessed payload is never removed.
    assert.deepEqual((await q<{ dedupe_key: string }>("a", "SELECT dedupe_key FROM contact_events")).map((e) => e.dedupe_key), ["e-new"]);
    assert.equal((await q("a", "SELECT 1 FROM ai_model_calls")).length, 1);
    assert.deepEqual((await q<{ status: string }>("a", "SELECT status FROM sms_inbound ORDER BY status")).map((r) => r.status), ["read", "received"]);
    // Recorded: in the audit log with its counts, and on the page.
    const audit = await q<{ details: Record<string, number> }>("a", "SELECT details FROM audit_events WHERE action='data.retention_applied'");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].details.conversations, 1);
    const page = await tenant(db.connect, "a", (x) => readRetention(x, "a", "owner-a"));
    assert.ok(page.lastRunAt);
    assert.deepEqual(page.lastResult, result);
    // At most hourly; a second run has nothing left.
    assert.equal(await scheduleRetention(db.connect, "a"), false, "not again within the hour");
    await retention({ action: "run" });
    const again = (await q<Job>("a", "SELECT * FROM jobs WHERE kind='retention.apply' ORDER BY created_at DESC LIMIT 1"))[0];
    assert.deepEqual((await retentionJob(db.connect, env, again)).result, {});
    // Another workspace's old conversation isn't touched.
    assert.equal((await q("b", "SELECT 1 FROM conversations WHERE id=$1", [elsewhere.conversationId])).length, 1);
    await assert.rejects(tenant(db.connect, "b", (x) => readRetention(x, "b", "owner-a")));

    // The rollback: every policy back to keep, and a run can't delete append-only rows any more.
    await db.pg.exec(await readFile("db/rollback/0088_retention.sql", "utf8"));
    assert.deepEqual((await tenant(db.connect, "a", (x) => readRetention(x, "a", "owner-a"))).policies, { conversations: null, attachments: null, recordings: null, events: null, logs: null });
    await assert.rejects(
      tenant(db.connect, "a", async (x: Sql) => {
        await x.query("SELECT set_config('relay.retention','on',true)");
        await x.query("DELETE FROM conversation_parts WHERE conversation_id=$1", [recent.conversationId]);
      }),
      /append-only/,
    );
  } finally {
    await store.close();
    await db.close();
  }
});
