import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { meterTotal, meterUnits, readUsage, readUsageUnits } from "../server/meters";
import { METER_IDS } from "../lib/meters";
import { UNIT_PRICES } from "../lib/plans";
import { segmentsOf } from "../lib/sms";

/** The meters (phase 16, C9a; docs/SECURITY_STEP16.md). */
test("meters never count: the meters module only reads, and every meter has a price slot", async () => {
  const source = await readFile("server/meters.ts", "utf8");
  assert.doesNotMatch(source, /\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/, "meters read their sources; they never write");
  assert.deepEqual(Object.keys(UNIT_PRICES).sort(), [...METER_IDS].sort());
});

test("meters: each unit read from its source for a period, traced to its conversation; free units left out; the Usage page; per workspace; rollback", async () => {
  const db = await testDatabase();
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
      await q(w, "DELETE FROM calendar_assignments");
    }
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");
    // The billing period: from an anchor a while ago, so "now" is inside the second period.
    const anchor = new Date(Date.now() - 40 * 86_400_000);
    await q("a", "UPDATE workspace_plans SET period_anchor=$1", [anchor]);
    const usage = (which = "current") => tenant(db.connect, "a", (x) => readUsage(x, "a", "owner-a", which));
    const current = (await usage()).period;
    const inPeriod = new Date(Date.parse(current.start) + 3_600_000);
    const lastPeriod = new Date(Date.parse(current.start) - 3_600_000);

    const start = async (text: string) =>
      tenant(db.connect, "a", async (x) => {
        const who = await getIdentity(x, "a", "user", "u-" + crypto.randomUUID(), { name: "Ada", email: `${crypto.randomUUID()}@customer.example` });
        const r = (await command(x, "a", { type: "contact", identityId: who.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text } as unknown as Parameters<typeof command>[4])) as {
          conversationId: string;
        };
        const part = (await x.query<{ id: string }>("SELECT id FROM conversation_parts WHERE conversation_id=$1 AND body<>'' ORDER BY seq LIMIT 1", [r.conversationId])).rows[0].id;
        return { id: r.conversationId, part, identityId: who.identityId, contactId: who.contactId };
      });
    const c1 = await start("A question");
    const c2 = await start("Another");
    // A long SMS (two segments) and a short one, as the parts they deliver.
    const longText = "x".repeat(200);
    const smsPart = (await q<{ id: string }>("a", "INSERT INTO conversation_parts(workspace_id,id,conversation_id,seq,kind,author_type,author_id,audience,channel,body,data) VALUES('a',$1,$2,100,'teammate_reply','teammate','owner','public','sms',$3,'{}') RETURNING id", [crypto.randomUUID(), c1.id, longText]))[0].id;

    // AI resolutions: two in the period, one reversed later in it; one last period, reversed this period.
    await q("a", "INSERT INTO ai_agents(workspace_id,id,name) VALUES('a','default','Zoe') ON CONFLICT DO NOTHING");
    const resolution = (id: string, conv: string, at: Date) =>
      q("a", "INSERT INTO ai_resolutions(workspace_id,id,kind,conversation_id,agent_id,rule,window_hours,recorded_at) VALUES('a',$1,'resolution',$2,'default','confirmed',24,$3)", [id, conv, at]);
    const reversal = (id: string, of: string, conv: string, at: Date) =>
      q("a", "INSERT INTO ai_resolutions(workspace_id,id,kind,resolution_id,conversation_id,agent_id,rule,window_hours,recorded_at) VALUES('a',$1,'reversal',$2,$3,'default','handed_over',24,$4)", [id, of, conv, at]);
    await resolution("r1", c1.id, inPeriod);
    await resolution("r2", c2.id, inPeriod);
    await reversal("r2x", "r2", c2.id, new Date(inPeriod.getTime() + 1000));
    await resolution("r0", c1.id, lastPeriod);
    await reversal("r0x", "r0", c1.id, inPeriod);
    // Phase 16 C9d: one answered on the workspace's own AI key: its own meter, not Relay's.
    await q("a", "INSERT INTO ai_resolutions(workspace_id,id,kind,conversation_id,agent_id,rule,window_hours,recorded_at,key_source) VALUES('a','r3','resolution',$1,'default','confirmed',24,$2,'workspace')", [c2.id, inPeriod]);

    // Deliveries: sent ones count (failed and suppressed are free).
    const delivery = (channel: string, conv: { id: string; part: string; identityId: string }, status: string, part = conv.part) =>
      q("a", "INSERT INTO channel_deliveries(workspace_id,id,part_id,conversation_id,channel,identity_id,address,status,created_at) VALUES('a',$1,$2,$3,$4,$5,'x',$6,$7)", [
        crypto.randomUUID(),
        part,
        conv.id,
        channel,
        crypto.randomUUID(),
        status,
        inPeriod,
      ]);
    await delivery("email", c1, "sent");
    await delivery("email", c2, "delivered");
    await delivery("email", c2, "failed");
    await delivery("whatsapp", c1, "read");
    await delivery("whatsapp", c1, "suppressed");
    await delivery("sms", c1, "sent", smsPart);
    await delivery("sms", c2, "sent");

    // Calls: 61 seconds is 2 minutes; an unanswered call is free.
    await q("a", "INSERT INTO voice_numbers(workspace_id,id,phone,label) VALUES('a','n1','+15550000000','Main') ON CONFLICT DO NOTHING").catch(() => undefined);
    const call = (status: string, seconds: number | null) =>
      q("a", "INSERT INTO voice_calls(workspace_id,id,call_sid,conversation_id,number_id,from_phone,to_phone,status,duration_seconds,started_at) VALUES('a',$1,$2,$3,'n1','+1','+2',$4,$5,$6)", [
        crypto.randomUUID(),
        crypto.randomUUID(),
        c1.id,
        status,
        seconds,
        inPeriod,
      ]);
    await call("completed", 61);
    await call("completed", 30);
    await call("no_answer", null);

    // Outbound: a chat sent, a banner shown, a held-out entry (free).
    await q("a", "INSERT INTO outbound_messages(workspace_id,id,type,title,state,draft,created_by,updated_by) VALUES('a','m1','chat','Welcome','live','{}','owner','owner'),('a','m2','banner','Sale','live','{}','owner','owner')");
    await q("a", "INSERT INTO outbound_entries(workspace_id,id,message_id,version,contact_id,entry_key,status,entered_at,conversation_id) VALUES('a','e1','m1',1,$1,'k1','sent',$3,$4),('a','e2','m2',1,$2,'k2','sent',$3,NULL),('a','e3','m1',1,$2,'k3','held_out',$3,NULL)", [
      c1.contactId,
      c2.contactId,
      inPeriod,
      c1.id,
    ]);

    // Connector calls: Zoe's and a workflow's that succeeded; a test call and a failed one are free.
    await q("a", "INSERT INTO ai_connectors(workspace_id,id,name,draft,created_by) VALUES('a','k','Orders','{}','owner')");
    const ccall = (source: string, result: string) =>
      q("a", "INSERT INTO ai_connector_calls(workspace_id,id,connector_id,draft,source,invoked_by,conversation_id,method,url,duration_ms,result,created_at) VALUES('a',$1,'k',true,$2,'zoe',$3,'GET','https://x',10,$4,$5)", [
        crypto.randomUUID(),
        source,
        c1.id,
        result,
        inPeriod,
      ]);
    await ccall("agent", "ok");
    await ccall("workflow", "ok");
    await ccall("test", "ok");
    await ccall("agent", "timeout");

    // The Usage page: each meter's total this period.
    const now = await usage();
    const totals = Object.fromEntries(now.meters.map((m) => [m.id, m.quantity]));
    assert.deepEqual(totals, {
      ai_resolutions: 0, // r1 and r2 (+2), r2's and r0's reversals (−2)
      ai_resolutions_own_key: 1, // r3
      emails: 2,
      whatsapp: 1,
      sms_segments: segmentsOf(longText).segments + segmentsOf("Another").segments,
      phone_minutes: 3,
      outbound_chats: 1,
      outbound_banners: 1,
      connector_calls: 2,
    });
    assert.equal(segmentsOf(longText).segments, 2);
    assert.deepEqual([now.pricesSet, now.totalCents, now.meters[0].amountCents], [false, null, null]);
    // Last period: only r0.
    assert.equal((await usage("previous")).meters.find((m) => m.id === "ai_resolutions")!.quantity, 1);

    // Every unit is traced: its time, quantity and conversation; the units add up to the total.
    const period = { start: new Date(now.period.start), end: new Date(now.period.end) };
    for (const meter of METER_IDS) {
      const units = (await tenant(db.connect, "a", (x) => meterUnits(x, "a", meter, period, null, 500))).units;
      assert.equal(units.reduce((s, u) => s + u.quantity, 0), await tenant(db.connect, "a", (x) => meterTotal(x, "a", meter, period)), meter);
      for (const u of units) assert.ok(u.conversationId || u.contactId, `${meter} ${u.id} leads somewhere`);
    }
    const resolutions = (await tenant(db.connect, "a", (x) => readUsageUnits(x, "a", "owner-a", new URLSearchParams("meter=ai_resolutions")))).units;
    assert.deepEqual(resolutions.map((u) => [u.id, u.quantity, u.conversationId]).sort(), [
      ["r0x", -1, c1.id],
      ["r1", 1, c1.id],
      ["r2", 1, c2.id],
      ["r2x", -1, c2.id],
    ].sort());
    // 50 at a time, after a cursor.
    for (let i = 0; i < 55; i++) await delivery("email", c1, "sent");
    const page1 = await tenant(db.connect, "a", (x) => readUsageUnits(x, "a", "owner-a", new URLSearchParams("meter=emails")));
    assert.equal(page1.units.length, 50);
    const page2 = await tenant(db.connect, "a", (x) => readUsageUnits(x, "a", "owner-a", new URLSearchParams(`meter=emails&cursor=${encodeURIComponent(page1.next!)}`)));
    assert.equal(page2.units.length, 7);
    assert.equal(new Set([...page1.units, ...page2.units].map((u) => u.id)).size, 57);
    await assert.rejects(tenant(db.connect, "a", (x) => readUsageUnits(x, "a", "owner-a", new URLSearchParams("meter=nothing"))), /Choose a meter/);

    // billing.manage only; another workspace's usage is its own.
    await assert.rejects(tenant(db.connect, "a", (x) => readUsage(x, "a", "agent-1-a")), /permission/);
    await assert.rejects(tenant(db.connect, "b", (x) => readUsage(x, "b", "owner-a")), /permission/);
    assert.ok((await tenant(db.connect, "b", (x) => readUsage(x, "b", "owner-b"))).meters.every((m) => m.quantity === 0));

    // The rollback drops the indexes only; meters read the same.
    await db.pg.exec(await readFile("db/rollback/0094_meters.sql", "utf8"));
    assert.equal((await usage()).meters.find((m) => m.id === "emails")!.quantity, 57);
  } finally {
    await db.close();
  }
});
