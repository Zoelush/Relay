import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { testDatabase } from "./database";
import { tenant, type Sql } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { checkEvent, recordEvent } from "../server/events";
import { recordContactView } from "../server/audit";
import { ERASURE, NO_PERSONAL_DATA } from "../server/erasure";
import { changeDataRequests, dataDeleteJob, dataExportJob, expireDataExports, readDataRequests, verifyCertificate } from "../server/data-requests";
import { localAttachmentStorage } from "../scripts/local-storage";
import type { Job } from "../server/jobs";

/**
 * Deleting and exporting one person (phase 16, C5a; docs/SECURITY_STEP7.md). The catalog covers
 * every table. Then the acceptance test: Ada, a customer with conversations, messages, an internal
 * note, an attachment, email copies, events, a phone, a suppression, Zoe's ledger and connector log,
 * webhook payloads, raw inbound payloads, audit rows, and a part in Bob's conversation, is
 * exported (a zip of person.json and her files, no internal notes), then deleted. Every column of
 * every table is then searched for her: nothing remains but the ledger and audit rows that others
 * rely on, stripped of her. Bob is untouched, the certificate verifies, and nothing crosses workspaces.
 */
test("the erasure catalog covers every table, once", async () => {
  const db = await testDatabase();
  try {
    const tables = (await db.pg.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")).rows.map((r) => r.t);
    const steps = new Set(ERASURE.map((s) => s.table));
    const none = new Set(Object.keys(NO_PERSONAL_DATA));
    const missing = tables.filter((t) => !steps.has(t) && !none.has(t));
    assert.deepEqual(missing, [], "every table is in the cascade or says why it holds no one's data");
    assert.deepEqual([...steps].filter((t) => none.has(t)), [], "never both");
    assert.deepEqual([...steps, ...none].filter((t) => !tables.includes(t)), [], "no table that isn't there");
  } finally {
    await db.close();
  }
});

test("a person exported, then deleted: no trace in any PostgreSQL table, files gone, the certificate signed, others untouched", async () => {
  const db = await testDatabase();
  const storage = localAttachmentStorage().storage;
  const KEY = "k".repeat(64);
  const env = { storage, key: KEY };
  const q = <T = Record<string, unknown>>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const MARK = "kumquat-marmalade-7731";
  const ADA = { email: "ada.vexley@customer.example", phone: "+447700900731", external: "ada-ext-7731", name: "Ada Vexley" };
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
    }
    // Ada, and Bob (who stays).
    const ada = await tenant(db.connect, "a", (x) => getIdentity(x, "a", "user", ADA.external, { name: ADA.name, email: ADA.email }));
    const bob = await tenant(db.connect, "a", (x) => getIdentity(x, "a", "user", "bob-ext-1", { name: "Bob Keeps", email: "bob@customer.example" }));
    // The same person's identifiers in workspace b, which must be untouched.
    const elsewhere = await tenant(db.connect, "b", (x) => getIdentity(x, "b", "user", ADA.external, { name: ADA.name, email: ADA.email }));
    const as = (who: { identityId: string }) => ({ type: "contact" as const, identityId: who.identityId, brandId: "default" });
    const owner = { type: "teammate" as const, principal: "owner-a" };
    const run = (w: string, actor: Parameters<typeof command>[2], p: Record<string, unknown>) =>
      tenant(db.connect, w, (x) => command(x, w, actor, crypto.randomUUID(), p as unknown as Parameters<typeof command>[4])) as Promise<{ conversationId: string }>;
    const c1 = (await run("a", as(ada), { action: "start", text: `Hello, my order ${MARK} never came` })).conversationId;
    await run("a", owner, { action: "reply", conversationId: c1, text: "Sorry, Ada, looking into it." });
    await run("a", owner, { action: "note", conversationId: c1, text: `Internal: Ada is upset about ${MARK}` });
    const c2 = (await run("a", as(ada), { action: "start", text: "A second question" })).conversationId;
    const bc = (await run("a", as(bob), { action: "start", text: "Bob's own question" })).conversationId;
    await run("b", as(elsewhere), { action: "start", text: `In workspace b: ${MARK}` });
    // Ada takes part in Bob's conversation (an email copy) and writes once there.
    await q("a", "INSERT INTO conversation_participants(workspace_id,conversation_id,identity_id) VALUES('a',$1,$2)", [bc, ada.identityId]);
    await run("a", as(ada), { action: "reply", conversationId: bc, text: `Ada adds ${MARK} to Bob's thread` });
    const contactId = (await q<{ contact_id: string }>("a", "SELECT contact_id FROM identity_contact_mappings WHERE identity_id=$1", [ada.identityId]))[0].contact_id;
    const bobContact = (await q<{ contact_id: string }>("a", "SELECT contact_id FROM identity_contact_mappings WHERE identity_id=$1", [bob.identityId]))[0].contact_id;

    // Where else a person reaches: a phone, events, files, email copies, Zoe, webhooks, raw payloads, suppressions, the audit log.
    await q("a", "INSERT INTO contact_phones(workspace_id,contact_id,phone,verified) VALUES('a',$1,$2,true)", [contactId, ADA.phone]);
    await tenant(db.connect, "a", (x) => recordEvent(x, "a", contactId, checkEvent({ name: "ordered", metadata: { note: MARK } }), "api", "e1"));
    await storage.putQuarantine!("q/ada-raw.eml", new TextEncoder().encode(`From: ${ADA.email}\n\n${MARK}`), "message/rfc822");
    await storage.putClean("c/ada-receipt.txt", new TextEncoder().encode(`receipt ${MARK}`), "text/plain", "receipt.txt");
    await q(
      "a",
      `INSERT INTO attachments(workspace_id,id,conversation_id,owner_identity_id,object_key,name,size,mime,status,checksum,clean_key,audience)
       VALUES('a',$1,$2,$3,'q/ada-upload','receipt.txt',16,'text/plain','clean','x','c/ada-receipt.txt','customer_visible')`,
      [crypto.randomUUID(), c1, ada.identityId],
    );
    await q("a", "INSERT INTO email_inbound(workspace_id,id,brand_id,envelope_from,envelope_to,raw_key,size,status,kind,conversation_id) VALUES('a',$1,'default',$2,'in@relay.test','q/ada-raw.eml',10,'read','message',$3)", [
      crypto.randomUUID(),
      ADA.email,
      c1,
    ]);
    const bobPart = (await q<{ id: string }>("a", "SELECT id FROM conversation_parts WHERE conversation_id=$1 ORDER BY seq LIMIT 1", [bc]))[0].id;
    const bobInbound = crypto.randomUUID();
    await q("a", "INSERT INTO email_inbound(workspace_id,id,brand_id,envelope_from,envelope_to,raw_key,size,status,kind,conversation_id) VALUES('a',$1,'default','bob@customer.example','in@relay.test','q/bob.eml',10,'read','message',$2)", [
      bobInbound,
      bc,
    ]);
    await q(
      "a",
      `INSERT INTO email_messages(workspace_id,part_id,conversation_id,inbound_id,message_id,subject,from_address,from_name,to_addresses,cc_addresses,text_full,kind)
       VALUES('a',$1,$2,$4,'<m1@x>','Bob''s order','bob@customer.example','Bob',ARRAY['support@relay.test'],ARRAY[$3],'Bob writes','message')`,
      [bobPart, bc, ADA.email, bobInbound],
    );
    await q("a", "INSERT INTO suppressions(workspace_id,id,channel,address,reason,source) VALUES('a',$1,'email',$2,'opt_out','customer')", [crypto.randomUUID(), ADA.email]);
    await q("a", "INSERT INTO sms_inbound(workspace_id,id,kind,payload,status) VALUES('a',$1,'message',$2,'read')", [crypto.randomUUID(), JSON.stringify({ From: ADA.phone, Body: MARK })]);
    await q(
      "a",
      `INSERT INTO ai_resolutions(workspace_id,id,kind,resolution_id,conversation_id,agent_id,rule,answer_ids,reply_part_ids,window_hours,detail)
       VALUES('a',$1,'resolution',NULL,$2,'default','confirmed','{}','{}',24,$3)`,
      [crypto.randomUUID(), c1, `Ada said thanks for ${MARK}`],
    );
    await q("a", "INSERT INTO webhook_subscriptions(workspace_id,id,url,topics,version,secret_sealed,active,created_by) VALUES('a','wh','https://hooks.example/x','{conversation.created}','2026-10-01','s',true,'owner')");
    await q("a", "INSERT INTO webhook_deliveries(workspace_id,id,subscription_id,event_id,topic,payload,status,next_attempt_at) VALUES('a',$1,'wh',$2,'conversation.created',$3,'delivered',now())", [
      crypto.randomUUID(),
      crypto.randomUUID(),
      JSON.stringify({ contact: { email: ADA.email, external_id: ADA.external } }),
    ]);
    await tenant(db.connect, "a", async (x) => {
      await x.query("SELECT set_config('relay.actor_id','owner',true)");
      await recordContactView(x, "a", contactId, { where: "inbox", personalData: true });
    });
    const counts = async () => Object.fromEntries((await q<{ t: string; n: number }>("a", "SELECT 'parts' t,count(*)::int n FROM conversation_parts UNION ALL SELECT 'contacts',count(*)::int FROM contacts")).map((r) => [r.t, r.n]));
    const before = await counts();

    // Settings › Data requests: for who manages security; find Ada by any of her identifiers.
    const dr = (p: Record<string, unknown>, principal = "owner-a", w = "a") => tenant(db.connect, w, (x) => changeDataRequests(x, w, principal, env, "https://relay.example", p));
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','grace','grace-a','Grace','agent')");
    await assert.rejects(dr({ action: "find", query: ADA.email }, "grace-a"));
    for (const query of [ADA.email.toUpperCase(), ADA.phone, ADA.external, contactId]) assert.equal(((await dr({ action: "find", query })) as { found: { contactId: string } }).found.contactId, contactId, query);
    const found = ((await dr({ action: "find", query: ADA.email })) as { found: { conversations: number; takesPartIn: number; emails: string[]; phones: string[] } }).found;
    assert.deepEqual([found.conversations, found.takesPartIn, found.emails, found.phones], [2, 1, [ADA.email], [ADA.phone]]);
    await assert.rejects(dr({ action: "find", query: "nobody@nowhere.example" }), /Nobody here/);
    await assert.rejects(dr({ action: "find", query: ADA.email }, "owner-a", "b").then(() => tenant(db.connect, "b", (x) => changeDataRequests(x, "b", "owner-a", env, null, { action: "find", query: ADA.email }))));

    // The export: a zip of person.json and her files; her messages, never the internal note.
    const job = async (w: string, kind: string) => (await q<Job>(w, "SELECT * FROM jobs WHERE kind=$1 ORDER BY created_at DESC LIMIT 1", [kind]))[0];
    await dr({ action: "export", contactId });
    await dataExportJob(db.connect, env, await job("a", "dsr.export"));
    const listed = await tenant(db.connect, "a", (x) => readDataRequests(x, "a", "owner-a"));
    const exported = listed.requests[0];
    assert.deepEqual([exported.kind, exported.state, exported.exportReady, exported.counts], ["export", "done", true, { conversations: 2, messages: 3, files: 1 }]);
    const key = (await q<{ export_key: string }>("a", "SELECT export_key FROM data_requests WHERE id=$1", [exported.id]))[0].export_key;
    const zip = unzipSync(new Uint8Array(await (await storage.readClean!(key)).arrayBuffer()));
    const person = JSON.parse(strFromU8(zip["person.json"])) as { person: { name: string }[]; emails: string[]; phones: string[]; events: unknown[]; conversations: { messages: { from: string; text: string }[] }[]; messagesInOthersConversations: unknown[]; files: { inZip: string }[] };
    assert.equal(person.person[0].name, ADA.name);
    assert.deepEqual([person.emails, person.phones, person.events.length, person.messagesInOthersConversations.length], [[ADA.email], [ADA.phone], 1, 1]);
    const texts = person.conversations.flatMap((c) => c.messages.map((m) => m.text));
    assert.ok(texts.some((t) => t.includes(MARK)) && texts.includes("Sorry, Ada, looking into it."));
    assert.ok(!JSON.stringify(person).includes("Internal:"), "no internal notes");
    assert.equal(strFromU8(zip[person.files[0].inZip]), `receipt ${MARK}`);
    assert.match(((await dr({ action: "download", id: exported.id })) as { url: string }).url, /^https:\/\/relay\.example\//);

    // The deletion: confirmed by her email (or "delete"); a job; then nothing of her remains.
    await assert.rejects(dr({ action: "delete", contactId, confirm: "someone@else.example" }), /to confirm/);
    const asked = (await dr({ action: "delete", contactId, confirm: ADA.email.toUpperCase() })) as { requestId: string };
    await dataDeleteJob(db.connect, env, await job("a", "dsr.delete"));
    const done = (await tenant(db.connect, "a", (x) => readDataRequests(x, "a", "owner-a"))).requests.find((r) => r.id === asked.requestId)!;
    assert.deepEqual([done.state, done.label], ["done", null]);
    const certificate = done.certificate as Record<string, unknown> & { stores: { postgresql: Record<string, number>; files: { objects: number } } };
    assert.ok(await verifyCertificate(KEY, certificate), "the certificate verifies");
    assert.ok(!(await verifyCertificate(KEY, { ...certificate, workspace: "b" })), "a changed certificate doesn't");
    assert.ok(!(await verifyCertificate("x".repeat(64), certificate)), "nor with another key");
    assert.ok(certificate.stores.postgresql.conversations === 2 && certificate.stores.postgresql.contacts >= 1 && certificate.stores.files.objects >= 2);
    assert.ok(!JSON.stringify(certificate).includes(ADA.email) && !JSON.stringify(certificate).includes(contactId), "the certificate names nobody");
    assert.equal(storage.getQuarantine && (await storage.getQuarantine("q/ada-raw.eml")), null, "the raw email is gone");
    assert.equal((await storage.readClean!("c/ada-receipt.txt")).status, 404, "her file is gone");

    // The acceptance test: every column of every table, searched for her.
    const tables = (await db.pg.query<{ t: string }>("SELECT DISTINCT table_name AS t FROM information_schema.columns WHERE table_schema='public' AND column_name='workspace_id'")).rows.map((r) => r.t);
    const needles = [ADA.email, ADA.phone, ADA.external, "Vexley", MARK, contactId, ada.identityId, c1, c2].map((n) => `%${n}%`);
    const traces: string[] = [];
    for (const t of tables) {
      const n = (await q<{ n: number }>("a", `SELECT count(*)::int AS n FROM ${t} x WHERE workspace_id='a' AND to_jsonb(x)::text ILIKE ANY($1)`, [needles]))[0].n;
      if (n) traces.push(`${t}: ${n}`);
    }
    assert.deepEqual(traces, [], "no trace of her in any table");
    // What stays: the ledger's row (billing counts it) and the audit rows (who did what), stripped of her.
    assert.deepEqual(await q("a", "SELECT kind,conversation_id,detail FROM ai_resolutions"), [{ kind: "resolution", conversation_id: null, detail: "" }]);
    assert.ok((await q("a", "SELECT 1 FROM audit_events WHERE action='contact.viewed' AND target_id IS NULL")).length >= 1);
    // Bob and his conversation stay; only Ada's message and address left it.
    const after = await counts();
    assert.equal(after.contacts, before.contacts - 1);
    assert.deepEqual((await q<{ body: string }>("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='customer_message' ORDER BY seq", [bc])).map((p) => p.body), ["Bob's own question"]);
    assert.deepEqual(await q("a", "SELECT cc_addresses FROM email_messages WHERE conversation_id=$1", [bc]), [{ cc_addresses: [] }]);
    assert.equal((await q("a", "SELECT 1 FROM contacts WHERE id=$1", [bobContact])).length, 1);
    // Workspace b's own record of the same person is untouched.
    assert.equal((await q("b", "SELECT 1 FROM conversation_parts WHERE body LIKE $1", [`%${MARK}%`])).length, 1);
    // The audit log has the requests by their ids only.
    const audit = await q<{ action: string; target_id: string }>("a", "SELECT action,target_id FROM audit_events WHERE action LIKE 'data.%' ORDER BY seq");
    assert.deepEqual(
      audit.map((a) => a.action),
      ["data.subject_export_requested", "data.subject_exported", "data.subject_export_downloaded", "data.erasure_requested", "data.erased"],
    );

    // Append-only stays append-only outside a recorded deletion.
    await assert.rejects(q("a", "DELETE FROM conversation_parts WHERE conversation_id=$1", [bc]), /append-only/);
    await assert.rejects(q("a", "UPDATE ai_resolutions SET conversation_id=NULL"), /append-only/);
    await assert.rejects(q("a", "UPDATE audit_events SET details='{}'"), /append-only/);

    // Her earlier export went with her: its zip deleted, its request forgetting her.
    assert.equal((await storage.readClean!(key)).status, 404);
    assert.deepEqual(await q("a", "SELECT label,subject,export_key FROM data_requests WHERE id=$1", [exported.id]), [{ label: null, subject: null, export_key: null }]);
    await assert.rejects(dr({ action: "download", id: exported.id }), /expired/);
    // Exports expire: after seven days the sweep deletes the file, and the request forgets who it was for.
    const bobExport = ((await dr({ action: "export", contactId: bobContact })) as { requestId: string }).requestId;
    await dataExportJob(db.connect, env, await job("a", "dsr.export"));
    const bobKey = (await q<{ export_key: string }>("a", "SELECT export_key FROM data_requests WHERE id=$1", [bobExport]))[0].export_key;
    assert.equal(await expireDataExports(db.connect, "a", storage), 0, "not before its time");
    await q("a", "UPDATE data_requests SET export_expires_at=now()-interval '1 minute' WHERE id=$1", [bobExport]);
    assert.equal(await expireDataExports(db.connect, "a", storage), 1);
    assert.equal((await storage.readClean!(bobKey)).status, 404);
    assert.deepEqual(await q("a", "SELECT label,subject,export_key FROM data_requests WHERE id=$1", [bobExport]), [{ label: null, subject: null, export_key: null }]);

    // The rollback: the append-only triggers refuse every change again.
    const rollback = await readFile("db/rollback/0087_data_requests.sql", "utf8");
    await db.pg.exec(rollback);
    await assert.rejects(
      tenant(db.connect, "a", async (x: Sql) => {
        await x.query("SELECT set_config('relay.erasure','on',true)");
        await x.query("DELETE FROM conversation_parts WHERE conversation_id=$1", [bc]);
      }),
      /append-only/,
    );
  } finally {
    await db.close();
  }
});
