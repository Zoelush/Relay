import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { liveDashboard, liveQueries } from "../server/live";

/**
 * The live dashboard (phase 14, R4; docs/REPORTING_STEP4.md): what's happening now, with known
 * answers (open, unassigned, waiting, snoozed, SLA breached and at risk, by team and teammate, who
 * has waited longest); who may see it; another workspace sees none of it. And the brief's cost bound:
 * with thousands of closed conversations, its queries read only the live ones (plan decision 6).
 */
test("the live dashboard: now, by team and teammate, waiting longest; who may see it; per workspace; and it never reads the history", async () => {
  const db = await testDatabase();
  const sql = <T = any>(text: string, values: unknown[] = [], w = "a") => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const owner = async (text: string, values: unknown[] = []) => db.pg.query(text, values);
  const live = (principal = "owner-a", team: string | null = null, w = "a") => tenant(db.connect, w, (q) => liveDashboard(q, w, principal, { team }));
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) => seedFoundation(q, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await tenant(db.connect, w, (q) => q.query("UPDATE workspace_features SET enabled=true WHERE name='reports_v1'"));
    }
    await sql("INSERT INTO teams(workspace_id,id,name,method) VALUES('a','billing','Billing','manual')");
    await sql("INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','grace','grace-a','Grace','agent')");
    await sql("INSERT INTO teammate_teams(workspace_id,teammate_id,team_id) VALUES('a','owner','billing')");
    await sql("UPDATE teammates SET presence='away',conversation_limit=5 WHERE id='grace'");
    const start = async (n: number) => {
      const who = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "anonymous", "device-" + n));
      return ((await tenant(db.connect, "a", (q) => command(q, "a", { type: "contact", identityId: who.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text: "Help " + n }))) as { conversationId: string }).conversationId;
    };
    const ids = [] as string[];
    for (let i = 1; i <= 6; i++) ids.push(await start(i));
    const [l1, l2, l3, l4, l5, l6] = ids;
    const set = (id: string, cols: string) => owner(`UPDATE conversations SET ${cols} WHERE workspace_id='a' AND id='${id}'`);
    // L1: Billing, unassigned, waiting two hours, its SLA target already missed.
    await set(l1, "team_id='billing',assigned='',last_contact_reply_at=now()-interval '2 hours',last_teammate_reply_at=NULL,sla_next_due_at=now()-interval '10 minutes'");
    // L2: Billing, the owner's, waiting 30 minutes, due in 20 (at risk).
    await set(l2, "team_id='billing',assigned='owner',last_contact_reply_at=now()-interval '30 minutes',last_teammate_reply_at=now()-interval '1 hour',sla_next_due_at=now()+interval '20 minutes'");
    // L3: no team, the owner's, answered after the customer (not waiting).
    await set(l3, "team_id=NULL,assigned='owner',last_contact_reply_at=now()-interval '3 hours',last_teammate_reply_at=now()-interval '1 hour',sla_next_due_at=NULL");
    // L4: snoozed, Grace's. L5: closed (history). L6: an outbound chat nobody has answered (not support's yet).
    await set(l4, "status='snoozed',team_id=NULL,assigned='grace',snooze_until=now()+interval '1 day'");
    await set(l5, "status='closed',team_id='billing',assigned=''");
    await sql("INSERT INTO outbound_messages(workspace_id,id,type,title,state,draft,created_by,updated_by) VALUES('a','m1','chat','Hi','live','{}','owner','owner')");
    await set(l6, "outbound_message_id='m1',last_contact_reply_at=NULL,team_id=NULL,assigned=''");

    const d = await live();
    const near = (ms: number | null, hours: number) => assert.ok(ms !== null && Math.abs(ms - hours * 3_600_000) < 60_000, `${ms} ≈ ${hours}h`);
    const { longestWaitMs, ...totals } = d.totals;
    assert.deepEqual(totals, { open: 3, unassigned: 1, snoozed: 1, waiting: 2, breached: 1, atRisk: 1 });
    near(longestWaitMs, 2);
    assert.deepEqual(
      d.teams.map((t) => [t.name, t.open, t.unassigned, t.snoozed, t.waiting, t.breached, t.atRisk]),
      [
        ["Billing", 2, 1, 0, 2, 1, 1],
        ["No team", 1, 0, 1, 0, 0, 0],
      ],
    );
    const people = Object.fromEntries(d.teammates.map((p) => [p.id, [p.presence, p.open, p.waiting, p.limit]]));
    assert.deepEqual(people.owner, ["active", 2, 1, null]);
    assert.deepEqual(people.grace, ["away", 0, 0, 5], "snoozed isn't open; her presence and limit");
    assert.deepEqual(
      d.waitingLongest.map((c) => [c.id, c.sla]),
      [
        [l1, "breached"],
        [l2, "at_risk"],
      ],
    );
    near(d.waitingLongest[0].waitingMs, 2);
    // One team: its own numbers, and only its members.
    const billing = await live("owner-a", "billing");
    assert.equal(billing.totals.open, 2);
    assert.deepEqual(billing.teams.map((t) => t.name), ["Billing"]);
    assert.deepEqual(billing.teammates.map((p) => p.id), ["owner"]);

    // Who may see it: who may view reports, while reporting is on; another workspace sees none of a's.
    await sql("INSERT INTO roles(workspace_id,id,name) VALUES('a','limited','Limited')");
    await sql("INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','lim','lim-a','Lim','limited')");
    await assert.rejects(live("lim-a"), /permission|not allowed|Forbidden/i);
    assert.deepEqual((await live("owner-b", null, "b")).totals, { open: 0, unassigned: 0, snoozed: 0, waiting: 0, breached: 0, atRisk: 0, longestWaitMs: null });
    await sql("UPDATE workspace_features SET enabled=false WHERE name='reports_v1'", [], "b");
    await assert.rejects(live("owner-b", null, "b"), /not enabled/);

    // The cost bound: 4,000 closed conversations later, each query reads only the live set.
    await owner(
      `INSERT INTO conversations SELECT (jsonb_populate_record(c, jsonb_build_object('id','old-'||g,'status','closed','created_at',now()-g*interval '1 hour'))).*
       FROM conversations c, generate_series(1,4000) g WHERE c.workspace_id='a' AND c.id=$1`,
      [l5],
    );
    await owner("ANALYZE conversations");
    const liveRows = 4; // L1 to L4 (L6 is in the live set too, filtered after the index)
    for (const [name, text] of Object.entries(liveQueries)) {
      const plan = (await sql<{ "QUERY PLAN": unknown }>("EXPLAIN (ANALYZE, FORMAT JSON) " + text, ["a", null]))[0]["QUERY PLAN"] as { Plan: Node }[];
      type Node = { "Node Type": string; "Relation Name"?: string; "Actual Rows": number; "Actual Loops": number; Plans?: Node[] };
      const scans: Node[] = [];
      const walk = (n: Node) => {
        if (n["Relation Name"] === "conversations") scans.push(n);
        n.Plans?.forEach(walk);
      };
      walk(plan[0].Plan);
      assert.ok(scans.length, name);
      for (const s of scans) {
        assert.notEqual(s["Node Type"], "Seq Scan", `${name} reads the whole table`);
        assert.ok(s["Actual Rows"] * s["Actual Loops"] <= liveRows + 1, `${name} read ${s["Actual Rows"]} rows from conversations`);
      }
    }
    assert.deepEqual((await live()).totals.open, 3, "the history doesn't change now");
  } finally {
    await db.close();
  }
});
