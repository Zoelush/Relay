import test from "node:test";
import assert from "node:assert/strict";
import { tenant } from "../../server/db";
import { server } from "./server";
import { getIdentity, seedFoundation } from "../../server/people";
import { dueInApp } from "../../server/outbound";
import { setSubscription } from "../../server/subscriptions";
import { blankDefinition, type OutboundDefinition } from "../../lib/outbound";

/**
 * Phase 13's acceptance (docs/OUTBOUND_STEP2.md), under real concurrency: ten live messages match
 * a person at once and ten page views ask for them at once; the workspace's cap (3) holds, nobody
 * gets a message twice, and an opted-out person gets nothing. Each request is its own connection.
 *
 * Run: npm run test:postgres
 */
const PEOPLE = 20;

test("real PostgreSQL: a burst of ten simultaneously matching messages never exceeds the cap; an opted-out person gets nothing", async () => {
  const { pg, connect } = await server();
  const sql = (text: string, values: unknown[] = []) => tenant(connect, "a", async (db) => (await db.query(text, values)).rows);
  try {
    await tenant(connect, "a", (db) =>
      seedFoundation(db, "a", "owner-a", { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
    );
    await sql("UPDATE workspace_features SET enabled=true WHERE name IN ('segments_v1','outbound_v1')");
    await sql("INSERT INTO subscription_types(workspace_id,id,name,consent,channel,created_by) VALUES('a','tips','Tips','opt_out','in_app','owner')");
    await sql("INSERT INTO outbound_settings(workspace_id,cap_count,cap_days,quiet_start,quiet_end) VALUES('a',3,7,'00:00','00:00')");
    const def: OutboundDefinition = {
      ...blankDefinition("chat", "owner"),
      content: { text: "Hello", senderId: "owner" },
      subscriptionTypeId: "tips",
      audience: { segmentId: null, rules: { match: "all", rules: [] }, sendTime: [] },
      delivery: { mode: "ongoing" },
      quietHours: false,
    };
    for (let i = 0; i < 10; i++) {
      await sql("INSERT INTO outbound_messages(workspace_id,id,type,title,state,draft,live_version,created_by,updated_by) VALUES('a',$1,'chat',$1,'live',$2,1,'owner','owner')", [`m${i}`, JSON.stringify(def)]);
      await sql("INSERT INTO outbound_versions(workspace_id,message_id,version,definition,published_by) VALUES('a',$1,1,$2,'owner')", [`m${i}`, JSON.stringify(def)]);
    }
    const people: { identityId: string; contactId: string }[] = [];
    for (let p = 0; p < PEOPLE; p++) people.push(await tenant(connect, "a", (db) => getIdentity(db, "a", "anonymous", `device-${p}`)));
    // The last one said no to Tips.
    await tenant(connect, "a", (db) => setSubscription(db, "a", people.at(-1)!.contactId, "tips", "opted_out", "preference_page", null));

    const ctx = { pageUrl: "https://shop.test/", device: "desktop" as const, locale: "en" };
    for (const person of people) {
      // Ten page views at once, each its own transaction.
      const results = await Promise.all(Array.from({ length: 10 }, () => tenant(connect, "a", (db) => dueInApp(db, "a", { identityId: person.identityId, brandId: "default" }, ctx))));
      const sent = (await sql("SELECT message_id FROM outbound_entries WHERE contact_id=$1 AND status='sent'", [person.contactId])) as { message_id: string }[];
      const conversations = (await sql("SELECT count(*)::int AS n FROM conversations WHERE primary_identity_id=$1", [person.identityId]))[0].n;
      if (person === people.at(-1)) {
        assert.equal(sent.length, 0, "opted out: nothing");
        assert.equal(conversations, 0);
        continue;
      }
      assert.equal(sent.length, 3, `the cap holds for ${person.contactId}`);
      assert.equal(new Set(sent.map((s) => s.message_id)).size, 3, "no message twice");
      assert.equal(conversations, 3);
      assert.equal(results.flat().length, 3);
    }
  } finally {
    await pg.stop();
  }
});
