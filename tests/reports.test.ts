import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyticsDatabase, testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { append, command, conversation } from "../server/conversations";
import { projectJob, reportFlow, reportMetric, type AnalyticsStore } from "../server/analytics";
import { conversationDerived, type FactPart } from "../server/analytics";
import { runMetric, QUERYABLE, type Value, datasetCounts } from "../server/reports";
import { METRICS } from "../lib/metrics";
import { PREBUILT } from "../lib/reports";

/**
 * The datasets and query layer (phase 14, R2; docs/REPORTING_STEP2.md): a week built by hand with
 * known answers (four conversations, their replies, closes, a reassignment, ratings, SLA targets, a
 * ticket, Zoe, outbound, calls, searches, deliveries and presence), projected into the store, then
 * each metric checked against the answer, with breakdowns, filters, the previous period and a
 * timezone; every metric and every pre-built report runs; another workspace sees none of it.
 */
const t = (s: string) => new Date(`2026-10-${s}Z`);

test("derived periods: states, response runs, and handling with idle gaps", () => {
  const p = (seq: number, kind: string, at: string, extra: Partial<FactPart> = {}): FactPart => ({
    seq,
    kind,
    author_type: kind === "customer_message" ? "contact" : kind === "state_change" || kind === "assignment_change" ? "system" : "teammate",
    author_id: "ada",
    audience: "public",
    at: t(at),
    data: {},
    ...extra,
  });
  const d = conversationDerived(
    [
      p(1, "state_change", "05T09:00:00", { data: { from: null, to: "open" } }),
      p(2, "customer_message", "05T09:00:00"),
      p(3, "customer_message", "05T09:02:00"),
      p(4, "assignment_change", "05T09:05:00", { data: { after: { teammate: "ada" } } }),
      p(5, "teammate_reply", "05T09:10:00"),
      p(6, "customer_message", "05T09:20:00"),
      p(7, "internal_note", "05T09:30:00", { audience: "internal" }),
      p(8, "teammate_reply", "05T10:30:00"),
      p(9, "state_change", "05T10:40:00", { data: { from: "open", to: "closed" } }),
    ],
    t("05T09:00:00"),
    null,
    "closed",
  );
  assert.deepEqual(
    d.states.map((s) => [s.state, s.from.toISOString(), s.to?.toISOString() ?? null]),
    [
      ["open", "2026-10-05T09:00:00.000Z", "2026-10-05T10:40:00.000Z"],
      ["closed", "2026-10-05T10:40:00.000Z", null],
    ],
  );
  // Two runs: 09:00 (two messages, counted once) answered at 09:10; 09:20 answered at 10:30.
  assert.deepEqual(
    d.responses.map((r) => [r.first, r.ms / 60_000]),
    [
      [true, 10],
      [false, 70],
    ],
  );
  // Handling 09:05 to 10:40 (95 minutes): marks 09:05, 09:10, 09:30, 10:30, 10:40; the hour between
  // 09:30 and 10:30 is idle.
  assert.deepEqual(d.handling.map((h) => [h.teammateId, h.ms / 60_000, h.activeMs / 60_000]), [["ada", 95, 35]]);
});

test("every metric answers from the store, as defined, with breakdowns, filters, the previous period and a timezone, per workspace", async () => {
  const db = await testDatabase();
  const store = await analyticsDatabase();
  const analytics: AnalyticsStore = { connect: store.connect };
  const sql = <T = any>(text: string, values: unknown[] = []) => tenant(db.connect, "a", async (q) => (await q.query<T>(text, values)).rows);
  const asql = <T = any>(text: string, values: unknown[] = []) => tenant(store.connect, "a", async (q) => (await q.query<T>(text, values)).rows);
  const owner = async (text: string, values: unknown[] = []) => db.pg.query(text, values);
  const project = async (w = "a") => {
    for (let result: unknown = null; ; ) {
      const r = await projectJob(db.connect, analytics, { workspace_id: w, payload: {}, result } as never);
      if (r.done) return;
      result = r.result;
    }
  };
  const period = { from: t("05T00:00:00"), to: t("12T00:00:00") };
  const m = (metric: string, extra: Record<string, unknown> = {}) => runMetric(analytics, "a", { metric, ...period, ...extra });
  const count = (v: Value) => (v.kind === "count" ? v.count : NaN);
  const pct = (v: Value) => (v.kind === "share" ? v.percent : NaN);
  const median = (v: Value) => (v.kind === "duration" ? v.medianMs : NaN);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) => seedFoundation(q, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await tenant(db.connect, w, (q) => q.query("UPDATE workspace_features SET enabled=true WHERE name IN ('reports_v1','settings_v1')"));
    }
    await sql("INSERT INTO teams(workspace_id,id,name,method) VALUES('a','billing','Billing','manual')");
    await sql("INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','grace','grace-a','Grace','agent')");
    const as = (principal: string) => ({ type: "teammate" as const, principal });
    const run = (p: Record<string, unknown>, actor: ReturnType<typeof as> = as("owner-a")) => tenant(db.connect, "a", (q) => command(q, "a", actor, crypto.randomUUID(), p as never));
    const ada = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "user", "u-ada", { name: "Ada" }));
    await sql("UPDATE contacts SET profile='{\"plan\":\"pro\"}' WHERE id=$1", [ada.contactId]);
    const start = async (identityId: string, text: string) =>
      ((await tenant(db.connect, "a", (q) => command(q, "a", { type: "contact", identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text }))) as { conversationId: string }).conversationId;
    const say = (id: string, identityId: string, text: string) => tenant(db.connect, "a", (q) => command(q, "a", { type: "contact", identityId, brandId: "default" }, crypto.randomUUID(), { action: "reply", conversationId: id, text }));
    /**
     * A conversation's parts moved to the given times (as the owner: parts are append-only). The
     * named kinds are timed in order; anything else (a system event) takes the time before it.
     */
    const times = async (id: string, at: [string, string][]) => {
      const parts = (await owner("SELECT id,kind FROM conversation_parts WHERE workspace_id='a' AND conversation_id=$1 ORDER BY seq", [id])).rows as { id: string; kind: string }[];
      let i = 0;
      let last = at[0][1];
      await db.pg.exec("ALTER TABLE conversation_parts DISABLE TRIGGER immutable_parts");
      for (const p of parts) {
        if (i < at.length && p.kind === at[i][0]) last = at[i++][1];
        await owner("UPDATE conversation_parts SET created_at=$2 WHERE workspace_id='a' AND id=$1", [p.id, t(last).toISOString()]);
      }
      await db.pg.exec("ALTER TABLE conversation_parts ENABLE TRIGGER immutable_parts");
      assert.equal(i, at.length, `${id}: every named part found`);
      await owner("UPDATE conversations SET created_at=$2,updated_at=now() WHERE workspace_id='a' AND id=$1", [id, t(at[0][1]).toISOString()]);
    };

    // C1, Ada (pro): first response 10 minutes, next 30; closed by the owner; rated 5.
    const c1 = await start(ada.identityId, "Order question");
    await run({ action: "assign", conversationId: c1, teammateId: "owner", teamId: "billing" });
    await run({ action: "reply", conversationId: c1, text: "Looking" });
    await say(c1, ada.identityId, "Thanks, and the invoice?");
    await run({ action: "reply", conversationId: c1, text: "Sent" });
    await run({ action: "close", conversationId: c1 });
    const ratingPart = await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", c1), { type: "contact", id: ada.identityId }, "rating", "", { value: 5 }));
    assert.ok(ratingPart);
    await times(c1, [
      ["state_change", "05T09:00:00"],
      ["customer_message", "05T09:00:00"],
      ["assignment_change", "05T09:01:00"],
      ["teammate_reply", "05T09:10:00"],
      ["customer_message", "05T09:20:00"],
      ["teammate_reply", "05T09:50:00"],
      ["state_change", "05T10:00:00"],
      ["rating", "05T10:05:00"],
    ]);

    // C2, a visitor: assigned to Grace, reassigned to the owner (one reassignment), answered after 30 minutes, left open.
    const v = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "anonymous", "device-v"));
    const c2 = await start(v.identityId, "Can't log in");
    await run({ action: "assign", conversationId: c2, teammateId: "grace", teamId: null });
    await run({ action: "assign", conversationId: c2, teammateId: "owner", teamId: null });
    await run({ action: "reply", conversationId: c2, text: "Reset sent" });
    await times(c2, [
      ["state_change", "06T12:00:00"],
      ["customer_message", "06T12:00:00"],
      ["assignment_change", "06T12:05:00"],
      ["assignment_change", "06T12:20:00"],
      ["teammate_reply", "06T12:30:00"],
    ]);

    // C3, another visitor: Zoe answered and it closed without a teammate (deflected); rated 2.
    const v3 = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "anonymous", "device-w"));
    const c3 = await start(v3.identityId, "Opening hours?");
    await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", c3), { type: "ai", id: "default" }, "ai_reply", "9 to 5", {}));
    await run({ action: "close", conversationId: c3 });
    await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", c3), { type: "contact", id: v3.identityId }, "rating", "", { value: 2 }));
    await times(c3, [
      ["state_change", "07T08:00:00"],
      ["customer_message", "07T08:00:00"],
      ["ai_reply", "07T08:01:00"],
      ["state_change", "07T08:05:00"],
      ["rating", "07T08:06:00"],
    ]);

    // C4, Ada again, the week before: first response 20 minutes (the previous period).
    const c4 = await start(ada.identityId, "Earlier question");
    await run({ action: "reply", conversationId: c4, text: "Answer" });
    // (1 October at 10:00, less a day: 30 September, in the week before.)
    await times(c4, [
      ["state_change", "01T10:00:00"],
      ["customer_message", "01T10:00:00"],
      ["teammate_reply", "01T10:20:00"],
    ]);
    await owner("UPDATE conversations SET created_at='2026-09-30T10:00:00Z' WHERE id=$1", [c4]);
    await db.pg.exec("ALTER TABLE conversation_parts DISABLE TRIGGER immutable_parts");
    await owner("UPDATE conversation_parts SET created_at=created_at-interval '1 day' WHERE conversation_id=$1", [c4]);
    await db.pg.exec("ALTER TABLE conversation_parts ENABLE TRIGGER immutable_parts");

    // Copied sources: SLA targets (C1 met, C2 missed), a ticket, Zoe's answer and resolution, outbound, calls, presence.
    await sql(
      "INSERT INTO sla_clocks(workspace_id,conversation_id,metric,cycle,target_ms,state,due_at,breached_at,updated_at) VALUES('a',$1,'first_response',0,3600000,'stopped','2026-10-05T10:00:00Z',NULL,'2026-10-05T09:10:00Z'),('a',$2,'first_response',0,900000,'stopped','2026-10-06T12:15:00Z','2026-10-06T12:15:00Z','2026-10-06T12:30:00Z')",
      [c1, c2],
    );
    await sql("INSERT INTO ticket_types(workspace_id,id,name,category) VALUES('a','bug','Bug','back_office')");
    await sql("INSERT INTO ticket_states(workspace_id,id,type_id,name,customer_label,kind,position) VALUES('a','fixed','bug','Fixed','Fixed','resolved',1)");
    await sql("INSERT INTO tickets(workspace_id,conversation_id,number,type_id,state_id,created_by,created_at,updated_at) VALUES('a',$1,1,'bug','fixed','owner','2026-10-06T13:00:00Z','2026-10-08T13:00:00Z')", [c2]);
    await sql("INSERT INTO ai_agents(workspace_id,id,name) VALUES('a','default','Zoe') ON CONFLICT DO NOTHING");
    const c3q = (await sql<{ id: string }>("SELECT id FROM conversation_parts WHERE conversation_id=$1 AND kind='customer_message'", [c3]))[0].id;
    await sql("INSERT INTO ai_answers(workspace_id,id,agent_id,conversation_id,question_part_id,outcome,reason,threshold,prompt_version,created_at) VALUES('a','ans1','default',$1,$2,'answered','ok',0.5,'v1','2026-10-07T08:01:00Z')", [c3, c3q]);
    await sql("INSERT INTO ai_resolutions(workspace_id,id,kind,conversation_id,agent_id,rule,window_hours,recorded_at) VALUES('a','res1','resolution',$1,'default','confirmed',24,'2026-10-07T08:05:00Z')", [c3]);
    await sql("INSERT INTO outbound_messages(workspace_id,id,type,title,state,draft,created_by,updated_by) VALUES('a','m1','chat','Hi','live','{}','owner','owner'),('a','m2','banner','News','live','{}','owner','owner')");
    await sql(
      `INSERT INTO outbound_entries(workspace_id,id,message_id,version,contact_id,entry_key,status,entered_at,seen_at,replied_at,clicked_at,dismissed_at) VALUES
       ('a','e1','m1',1,$1,'k1','sent','2026-10-08T10:00:00Z','2026-10-08T10:01:00Z','2026-10-08T10:02:00Z',NULL,NULL),
       ('a','e2','m2',1,$1,'k2','sent','2026-10-08T11:00:00Z','2026-10-08T11:00:00Z',NULL,'2026-10-08T11:01:00Z',NULL),
       ('a','e3','m2',1,$1,'k3','held_out','2026-10-08T11:00:00Z',NULL,NULL,NULL,NULL)`,
      [ada.contactId],
    );
    await sql("UPDATE outbound_entries SET variant='control' WHERE id='e3'");
    await sql(
      `INSERT INTO voice_calls(workspace_id,id,call_sid,conversation_id,number_id,from_phone,to_phone,status,accepted_by,voicemail,zoe_turns,duration_seconds,started_at,ended_at) VALUES
       ('a','call1','CA1',$1,'n','+1','+2','completed','owner',false,2,60,'2026-10-09T10:00:00Z','2026-10-09T10:01:00Z'),
       ('a','call2','CA2',$1,'n','+1','+2','completed',NULL,true,0,30,'2026-10-09T11:00:00Z','2026-10-09T11:00:30Z')`,
      [c2],
    );
    await sql("UPDATE teammates SET presence='away' WHERE id='owner'");
    await owner("ALTER TABLE teammate_presence_changes DISABLE TRIGGER immutable_presence_changes");
    await owner("UPDATE teammate_presence_changes SET changed_at='2026-10-08T00:00:00Z' WHERE workspace_id='a'");
    await owner("ALTER TABLE teammate_presence_changes ENABLE TRIGGER immutable_presence_changes");
    await project();
    // Search and article feedback go in by the store's own tables (their copies are tested in tests/analytics.test.ts's way).
    await asql("INSERT INTO a_searches(workspace_id,id,surface,results,opened,created_at) VALUES('a','s1','help_center',3,true,'2026-10-09T09:00:00Z'),('a','s2','messenger',0,false,'2026-10-09T09:05:00Z')");
    await asql("INSERT INTO a_feedback(workspace_id,id,record_id,helpful,created_at) VALUES('a','f1','refunds',true,'2026-10-09T09:10:00Z'),('a','f2','refunds',false,'2026-10-09T09:11:00Z')");

    // Conversations.
    assert.equal(count((await m("new_conversations")).total), 3);
    assert.equal(count((await m("new_conversations")).previous), 1, "the week before: C4");
    assert.deepEqual((await m("new_conversations", { breakdown: "attribute:plan" })).rows.map((r) => [r.key, count(r.value)]), [["pro", 1], [null, 2]]);
    assert.deepEqual((await m("new_conversations", { breakdown: "day" })).rows.map((r) => [r.key, count(r.value)]), [["2026-10-05", 1], ["2026-10-06", 1], ["2026-10-07", 1]]);
    assert.equal(count((await m("conversations_replied_to")).total), 2);
    assert.equal(count((await m("replies_sent")).total), 3);
    assert.equal(count((await m("closed_conversations")).total), 2);
    assert.equal(count((await m("open_at_end")).total), 2, "C2, and C4 from the week before (never closed)");
    assert.equal(count((await m("awaiting_first_response")).total), 0);
    assert.equal(count((await m("reassignments")).total), 1);
    const fr = (await m("first_response_time")).total;
    assert.deepEqual(fr.kind === "duration" && [fr.count, fr.medianMs, fr.averageMs], [2, 20 * 60_000, 20 * 60_000], "10 and 30 minutes");
    assert.equal(median((await m("first_response_time")).previous), 20 * 60_000, "C4");
    assert.deepEqual((await m("first_response_time", { breakdown: "teammate" })).rows.map((r) => [r.key, median(r.value)]), [["owner", 20 * 60_000]]);
    assert.equal(median((await m("next_response_time")).total), 30 * 60_000);
    assert.equal(median((await m("time_to_close")).total), (60 + 5) / 2 * 60_000, "C1 an hour, C3 five minutes");
    assert.equal(pct((await m("deflection")).total), 50, "C3 of C1 and C3");
    assert.equal(pct((await m("first_contact_resolution")).total), 50, "C3 (no replies); C1 had two");
    assert.equal(pct((await m("repeat_contact")).total), 33.3, "C1: Ada started C4 five days before");
    const busiest = (await m("busiest_period")).total;
    assert.deepEqual(busiest.kind === "time" && [busiest.label, busiest.count], ["Monday 09:00", 2], "C1's two messages, 09:00 and 09:20 on Monday 5 October");
    // Ratings, SLAs, the AI agent.
    assert.deepEqual((await m("csat")).total, { kind: "share", percent: 50, numerator: 1, denominator: 2 });
    assert.equal(pct((await m("csat_response_rate")).total), 100);
    assert.equal(pct((await m("sla_hit_rate")).total), 50);
    assert.equal(count((await m("sla_misses")).total), 1);
    assert.deepEqual((await m("sla_miss_rate", { breakdown: "team" })).rows.map((r) => [r.key, pct(r.value)]), [["billing", 0], [null, 100]]);
    assert.equal(pct((await m("ai_involvement")).total), Math.round((1 / 3) * 1000) / 10);
    assert.equal(pct((await m("ai_resolution_rate")).total), 100);
    assert.equal(pct((await m("ai_answer_rate")).total), 100);
    // Tickets, outbound, help center, calls, teammates.
    assert.equal(count((await m("new_tickets")).total), 1);
    assert.equal(count((await m("tickets_resolved")).total), 1);
    assert.equal(median((await m("ticket_time_to_resolve")).total), 2 * 86_400_000);
    assert.equal(count((await m("outbound_sent")).total), 2, "the control group isn't sent");
    assert.equal(pct((await m("outbound_reply_rate")).total), 100);
    assert.equal(pct((await m("outbound_click_rate")).total), 100);
    assert.equal(pct((await m("searches_without_results")).total), 50);
    assert.equal(pct((await m("search_click_through")).total), 100);
    assert.equal(pct((await m("article_helpful_rate")).total), 50);
    assert.equal(count((await m("calls")).total), 2);
    assert.equal(count((await m("voicemails")).total), 1);
    assert.equal(pct((await m("calls_answered_rate")).total), 50);
    assert.equal(median((await m("call_duration")).total), 45_000);
    assert.equal(pct((await m("calls_with_zoe")).total), 50);
    const pace = (await m("conversations_per_teammate_hour", { breakdown: "teammate" })).rows.find((r) => r.key === "owner")!.value;
    assert.deepEqual(pace.kind === "rate" && [pace.numerator, pace.denominator], [2, 72], "two conversations in 72 active hours (5 Oct to the 8th)");
    const handling = (await m("handling_time", { breakdown: "teammate" })).rows;
    assert.deepEqual(
      handling.map((r) => [r.key, median(r.value)]),
      [["grace", 15 * 60_000], ["owner", 59 * 60_000]],
      "Grace's C2 period ended by the reassignment; the owner's C1, 09:01 to the close (their C2 period is still open)",
    );
    // Filters and a timezone: a filter narrows; New York's days move C1's 09:00 UTC start no further than the same day.
    assert.equal(count((await m("new_conversations", { filters: { teamId: "billing" } })).total), 1);
    assert.equal(count((await m("new_conversations", { filters: { attribute: { key: "plan", value: "pro" } } })).total), 1);
    assert.deepEqual((await m("closed_conversations", { breakdown: "day", timezone: "Pacific/Kiritimati" })).rows.map((r) => r.key), ["2026-10-06", "2026-10-07"], "+14 hours");

    // Each dataset counts its own rows: ratings are two parts among all of them.
    const sizes = await datasetCounts(analytics, "a");
    assert.deepEqual([sizes.conversation, sizes.rating, sizes.ticket, sizes.call], [4, 2, 1, 2]);

    // Every metric and every pre-built report's chart runs.
    for (const id of QUERYABLE) await m(id);
    assert.deepEqual(METRICS.map((x) => x.id).filter((id) => !QUERYABLE.includes(id)), []);
    for (const r of PREBUILT) for (const c of r.charts) await m(c.metric, { breakdown: c.breakdown });
    // Refused: an unknown metric, a period too long or backwards, a bad timezone or breakdown.
    for (const [q, text] of [
      [{ metric: "nope" }, /Choose a metric/],
      [{ metric: "new_conversations", from: t("12T00:00:00"), to: t("05T00:00:00") }, /period of up to 400 days/],
      [{ metric: "new_conversations", timezone: "Mars/Base" }, /timezone/],
      [{ metric: "new_conversations", breakdown: "colour" }, /Break it down/],
    ] as const)
      await assert.rejects(runMetric(analytics, "a", { ...period, ...q } as never), text);

    // Through the API's function: who may view reports only; another workspace sees nothing of a's.
    await sql("INSERT INTO roles(workspace_id,id,name) VALUES('a','limited','Limited')");
    await sql("INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','lim','lim-a','Lim','limited')");
    await assert.rejects(reportMetric(db.connect, analytics, "a", "lim-a", { metric: "new_conversations", from: period.from.toISOString(), to: period.to.toISOString() }), /permission|not allowed|Forbidden/i);
    const own = await reportMetric(db.connect, analytics, "a", "owner-a", { metric: "new_conversations", from: period.from.toISOString(), to: period.to.toISOString() });
    assert.equal(count(own.total), 3);
    // A breakdown's keys come with their names (R3): teammates from the application, not the store.
    const ownerName = (await sql<{ name: string }>("SELECT name FROM teammates WHERE workspace_id='a' AND id='owner'"))[0].name;
    const named = await reportMetric(db.connect, analytics, "a", "owner-a", { metric: "first_response_time", breakdown: "teammate", from: period.from.toISOString(), to: period.to.toISOString() });
    assert.deepEqual(named.labels, { owner: ownerName });
    // The overview's flow (R3): C1 and C2 answered by the team (C1 closed), C3 resolved by Zoe; the parts add up.
    const flowPeriod = { from: period.from.toISOString(), to: period.to.toISOString() };
    const flow = await reportFlow(db.connect, analytics, "a", "owner-a", { from: period.from.toISOString(), to: period.to.toISOString() });
    assert.deepEqual(flow, { total: 3, zoe: { total: 1, resolved: 1, handedOver: 0, other: 0 }, teammate: { total: 2, closed: 1, open: 1 }, closedWithoutReply: 0, waiting: 0 });
    assert.equal((await reportFlow(db.connect, analytics, "a", "owner-a", { ...flowPeriod, filters: { teamId: "billing" } })).total, 1, "C1 only");
    await assert.rejects(reportFlow(db.connect, analytics, "a", "lim-a", flowPeriod), /permission|not allowed|Forbidden/i);
    await project("b");
    assert.equal(count((await runMetric(analytics, "b", { metric: "new_conversations", ...period })).total), 0);
    assert.equal((await reportFlow(db.connect, analytics, "b", "owner-b", flowPeriod)).total, 0, "another workspace's flow sees none of a's");
    assert.equal(count((await runMetric(analytics, "b", { metric: "calls", ...period })).total), 0);

    // The store's rollback: rebuilt from the beginning, with the same answers.
    const rollback = readFileSync("db/analytics-rollback/0002_datasets.sql", "utf8");
    for (const statement of rollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await asql(statement);
    await project();
    assert.equal(count((await m("new_conversations")).total), 3);
    assert.equal(count((await m("calls")).total), 2);
  } finally {
    await db.close();
    await store.close();
  }
});
