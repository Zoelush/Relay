import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { runJob, type Job } from "../server/jobs";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { checkEvent, recordEvent } from "../server/events";
import { setSubscription } from "../server/subscriptions";
import { dueBanner, dueInApp, lastSlot, launchJob, outboundAction, outboundSeen, outboundSweep } from "../server/outbound";
import { blankDefinition, bucket, goalReadout, inQuietHours, outboundProblems, sendTimeMatches, type OutboundDefinition } from "../lib/outbound";

/**
 * Outbound's engine and in-app chat messages (phase 13, O2; docs/OUTBOUND_STEP2.md): definitions
 * checked; send-time rules, quiet hours, the control group's bucket, the goal's readout and
 * recurring slots; then the engine: a chat as a conversation that continues into the inbox, each
 * delivery mode, re-entry, subscriptions, both caps, quiet hours, versions (in flight and
 * scheduled), the holdout and goal, pausing, per workspace, and the rollback.
 */
test("outbound definitions and the engine's pure parts: checks, send-time rules, quiet hours, buckets, the honest readout, recurring slots", async () => {
  const d = blankDefinition("chat", "owner");
  assert.deepEqual(outboundProblems(d), ["Write the message (5,000 characters at most).", "Choose its subscription type: every message has one."]);
  const ok: OutboundDefinition = { ...d, content: { text: "Hi", senderId: "owner" }, subscriptionTypeId: "t" };
  assert.deepEqual(outboundProblems(ok), []);
  const one = (x: Partial<OutboundDefinition>) => outboundProblems({ ...ok, ...x });
  assert.deepEqual(one({ reentry: { mode: "every" } }), ["Sent every time they match: give it a cap (how many times, in how many days)."]);
  assert.deepEqual(one({ holdoutPercent: 10 }), ["A control group needs a goal to compare."]);
  assert.deepEqual(one({ holdoutPercent: 10, goal: { event: "paid", days: 7 }, reentry: { mode: "every" }, cap: { count: 1, days: 1 } }), ["A control group needs someone to enter once, or once a period."]);
  assert.deepEqual(one({ holdoutPercent: 60, goal: { event: "paid", days: 7 } }), ["Hold out 0 to 50% as a control group."]);
  assert.deepEqual(one({ delivery: { mode: "event" } }), ["Choose the event that sends it."]);
  assert.deepEqual(one({ delivery: { mode: "recurring", every: { unit: "week", at: "09:00" } } }), ["Choose the day of the week."]);
  assert.deepEqual(one({ startAt: "2026-10-02T00:00:00Z", stopAt: "2026-10-01T00:00:00Z" }), ["Stop after it starts."]);
  assert.deepEqual(one({ audience: { segmentId: null, rules: { match: "all", rules: [{ field: "company.plan", op: "is", value: "x" }] }, sendTime: [] } }), ["Audience: Rule 1: Companies arrive in phase 01."]);
  assert.deepEqual(one({ audience: { segmentId: null, rules: { match: "all", rules: [] }, sendTime: [{ field: "device", op: "is", value: "tv" as "mobile" }] } }), ["Send-time rule 1: desktop or mobile."]);

  // O3: banners: 300 characters, top or bottom, closable or not, an optional https button.
  const banner: OutboundDefinition = { ...blankDefinition("banner", "owner"), content: { text: "Maintenance tonight", position: "top", dismissible: true, action: null }, subscriptionTypeId: "t" };
  assert.deepEqual(outboundProblems(banner), []);
  assert.deepEqual(outboundProblems({ ...banner, content: { ...banner.content, text: "x".repeat(301) } }), ["Write the banner (300 characters at most)."]);
  assert.deepEqual(outboundProblems({ ...banner, content: { ...banner.content, action: { label: "Status", url: "http://status.test" } } }), ["The banner's button opens an https address."]);
  assert.deepEqual(outboundProblems({ ...banner, content: { ...banner.content, action: { label: "", url: "https://status.test" } } }), ["Label the banner's button (40 characters at most)."]);
  assert.deepEqual(outboundProblems({ ...banner, content: { ...banner.content, position: "middle" as "top" } }), ["Put the banner at the top or the bottom."]);

  const page = { pageUrl: "https://shop.test/pricing", device: "mobile" as const, locale: "fr-CA", openConversation: false };
  assert.equal(sendTimeMatches([{ field: "page_url", op: "contains", value: "/pricing" }, { field: "device", op: "is", value: "mobile" }, { field: "locale", op: "starts_with", value: "fr" }], page), true);
  assert.equal(sendTimeMatches([{ field: "page_url", op: "not_contains", value: "pricing" }], page), false);
  assert.equal(sendTimeMatches([{ field: "open_conversation", op: "is", value: true }], page), false);

  const at = (iso: string) => new Date(iso);
  assert.equal(inQuietHours(at("2026-10-15T22:30:00Z"), "UTC", "21:00", "08:00"), true, "crosses midnight");
  assert.equal(inQuietHours(at("2026-10-15T07:59:00Z"), "UTC", "21:00", "08:00"), true);
  assert.equal(inQuietHours(at("2026-10-15T08:00:00Z"), "UTC", "21:00", "08:00"), false);
  assert.equal(inQuietHours(at("2026-10-15T20:30:00Z"), "Europe/London", "21:00", "08:00"), true, "21:30 in London (BST)");
  assert.equal(inQuietHours(at("2026-10-15T12:00:00Z"), "Not/AZone", "11:00", "13:00"), true, "an unknown timezone is UTC");

  const b1 = await bucket("contact-1", "message-1");
  assert.equal(await bucket("contact-1", "message-1"), b1, "stable");
  let low = 0;
  for (let i = 0; i < 2000; i++) if ((await bucket(`c${i}`, "m")) < 20) low++;
  assert.ok(low > 300 && low < 500, `about 20% held out (${low}/2000)`);

  assert.match(goalReadout({ n: 99, converted: 50 }, { n: 300, converted: 10 }).verdict, /Too few to say/);
  assert.equal(goalReadout({ n: 99, converted: 50 }, { n: 300, converted: 10 }).lift, null);
  assert.match(goalReadout({ n: 1000, converted: 300 }, { n: 1000, converted: 200 }).verdict, /^It helps: 10\.0 points more/);
  assert.match(goalReadout({ n: 200, converted: 41 }, { n: 200, converted: 40 }).verdict, /^No clear difference yet/);
  assert.match(goalReadout({ n: 1000, converted: 100 }, { n: 1000, converted: 200 }).verdict, /^It hurts/);

  assert.equal(lastSlot({ unit: "day", at: "09:00" }, "UTC", at("2026-10-15T10:00:00Z"))!.toISOString(), "2026-10-15T09:00:00.000Z");
  assert.equal(lastSlot({ unit: "day", at: "09:00" }, "UTC", at("2026-10-15T08:00:00Z"))!.toISOString(), "2026-10-14T09:00:00.000Z");
  assert.equal(lastSlot({ unit: "day", at: "09:00" }, "Europe/London", at("2026-10-15T10:00:00Z"))!.toISOString(), "2026-10-15T08:00:00.000Z", "09:00 BST");
  assert.equal(lastSlot({ unit: "week", at: "09:00", weekday: 1 }, "UTC", at("2026-10-15T10:00:00Z"))!.toISOString(), "2026-10-12T09:00:00.000Z", "the Monday before");
});

test("outbound: a chat reaches the messenger and continues into the inbox; delivery modes, re-entry, subscriptions, caps, quiet hours, versions and the holdout; per workspace; the rollback", async () => {
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
  const drain = async (w = "a") => {
    for (let i = 0; i < 50; i++) {
      const job = (await sql<{ id: string }>(w, "SELECT id FROM jobs WHERE kind='outbound.launch' AND state IN ('queued','running') ORDER BY created_at LIMIT 1"))[0];
      if (!job) return;
      await runJob(db.connect, w, job.id, { "outbound.launch": (j: Job) => launchJob(db.connect, j) });
    }
  };
  const page = { pageUrl: "https://shop.test/home", device: "desktop" as const, locale: "en" };
  const due = (identityId: string, ctx = page, now?: Date) => tenant(db.connect, "a", (q) => dueInApp(q, "a", { identityId, brandId: "default" }, ctx, now));
  /** A message made and published through the API (the definition's changes over a valid base). */
  const publish = async (title: string, change: Partial<OutboundDefinition>, extra: Record<string, unknown> = {}) => {
    const made = (await agent("outbound-message", { action: "create", type: "chat", title })).body;
    const def = { ...made.draft, content: { text: `${title}!`, senderId: "owner" }, subscriptionTypeId: TIPS, audience: { segmentId: null, rules: { match: "all", rules: [] }, sendTime: [] }, ...change };
    await agent("outbound-message", { action: "save", id: made.message.id, definition: def });
    const r = await agent("outbound-message", { action: "publish", id: made.message.id, ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return made.message.id as string;
  };
  const pause = (id: string) => agent("outbound-message", { action: "pause", id });
  let TIPS = "";
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) => seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE name IN ('settings_v1','segments_v1')");
    }
    await sql("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','grace','grace-a','Grace','agent')");

    // Off by default.
    assert.equal((await agent("outbound")).status, 404);
    await sql("a", "UPDATE workspace_features SET enabled=true WHERE name='outbound_v1'");
    assert.equal((await agent("outbound", undefined, "grace-a")).status, 403, "managers only");
    await agent("subscription-settings", { action: "create", name: "Tips", consent: "opt_out", channel: "in_app" });
    await agent("subscription-settings", { action: "create", name: "News", consent: "opt_out", channel: "email" });
    const types = (await agent("subscription-settings")).body.types as { id: string; name: string }[];
    TIPS = types.find((t) => t.name === "Tips")!.id;
    const NEWS = types.find((t) => t.name === "News")!.id;
    // The workspace's limits: checked; generous to start, quiet hours off by default in messages below.
    assert.equal((await agent("outbound-settings", { capCount: 0, capDays: 7, quietStart: "21:00", quietEnd: "08:00", timezone: "UTC" })).status, 400);
    assert.match((await agent("outbound-settings", { capCount: 3, capDays: 7, quietStart: "21:00", quietEnd: "08:00", timezone: "Mars/Base" })).body.error.message, /timezone/);
    await agent("outbound-settings", { capCount: 50, capDays: 7, quietStart: "21:00", quietEnd: "08:00", timezone: "UTC" });

    // People: Ada (a pro user), Grace (a free user), a visitor.
    const ada = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "user", "u-ada", { name: "Ada", email: "ada@example.com" }));
    const grace = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "user", "u-grace", { name: "Grace", email: "grace@example.com" }));
    const visitor = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "anonymous", "device-1"));
    await sql("a", "UPDATE contacts SET profile='{\"plan\":\"pro\"}' WHERE id=$1", [ada.contactId]);

    // A draft: what stops it is said; an email subscription can't send an in-app chat.
    const made = (await agent("outbound-message", { action: "create", type: "chat", title: "Welcome to Pro" })).body;
    assert.deepEqual(made.problems, ["Write the message (5,000 characters at most).", "Choose its subscription type: every message has one."]);
    assert.equal((await agent("outbound-message", { action: "publish", id: made.message.id })).body.error.message, "Write the message (5,000 characters at most).");
    const pro: OutboundDefinition = {
      ...made.draft,
      content: { text: "Thanks for upgrading! Want a tour?", senderId: "owner" },
      subscriptionTypeId: NEWS,
      audience: { segmentId: "all-users", rules: { match: "all", rules: [{ field: "attribute", key: "plan", op: "is", value: "pro" }] }, sendTime: [] },
      delivery: { mode: "ongoing" },
      quietHours: false,
    };
    await agent("outbound-message", { action: "save", id: made.message.id, definition: pro });
    assert.equal((await agent("outbound-message", { action: "publish", id: made.message.id })).body.error.message, "An in-app message needs an in-app subscription type.");
    await agent("outbound-message", { action: "save", id: made.message.id, definition: { ...pro, subscriptionTypeId: TIPS } });
    assert.deepEqual((await agent("outbound-message", { action: "audience", definition: pro })).body, { count: 1, sendTimeRules: 0 }, "the live size");
    assert.equal((await agent("outbound-message", { action: "publish", id: made.message.id })).status, 200);
    const WELCOME = made.message.id as string;

    // Ongoing: Grace doesn't match; Ada does, once. Her chat is a conversation from its sender,
    // closed until she replies, unread for her.
    assert.deepEqual(await due(grace.identityId), []);
    const [chat] = await due(ada.identityId);
    assert.ok(chat?.conversationId);
    assert.deepEqual(await due(ada.identityId), [], "once ever");
    const conv = (await sql("a", "SELECT status,outbound_message_id,primary_identity_id FROM conversations WHERE id=$1", [chat.conversationId]))[0];
    assert.deepEqual(conv, { status: "closed", outbound_message_id: WELCOME, primary_identity_id: ada.identityId });
    const parts = await sql("a", "SELECT kind,author_type,author_id,body,data FROM conversation_parts WHERE conversation_id=$1 AND kind='teammate_reply'", [chat.conversationId]);
    assert.deepEqual(parts.map((p: any) => [p.kind, p.author_type, p.author_id, p.body, p.data.outbound.messageId]), [["teammate_reply", "teammate", "owner", "Thanks for upgrading! Want a tour?", WELCOME]]);
    assert.deepEqual(await sql("a", "SELECT unread_count FROM customer_counters WHERE identity_id=$1", [ada.identityId]), [{ unread_count: 1 }]);
    // Seen, then her reply: the conversation opens for the team; the ledger says so.
    await tenant(db.connect, "a", (q) => outboundSeen(q, "a", chat.conversationId));
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "contact", identityId: ada.identityId, brandId: "default", verified: true }, crypto.randomUUID(), { action: "reply", conversationId: chat.conversationId, text: "Yes please!" }));
    assert.equal((await sql("a", "SELECT status FROM conversations WHERE id=$1", [chat.conversationId]))[0].status, "open");
    let detail = (await agent(`outbound-message?id=${WELCOME}`)).body;
    assert.deepEqual([detail.stats.sent, detail.stats.seen, detail.stats.replied], [1, 1, 1]);
    assert.deepEqual(detail.entries.map((e: any) => [e.name, e.status, !!e.seenAt, !!e.repliedAt]), [["Ada", "sent", true, true]]);
    await pause(WELCOME);

    // Send-time rules: only on the pricing page, on desktop, without an open conversation.
    const PRICING = await publish("Pricing help", {
      delivery: { mode: "ongoing" },
      quietHours: false,
      audience: { segmentId: null, rules: { match: "all", rules: [] }, sendTime: [{ field: "page_url", op: "contains", value: "/pricing" }, { field: "open_conversation", op: "is", value: false }] },
    });
    assert.deepEqual(await due(grace.identityId), [], "not on that page");
    assert.equal((await due(grace.identityId, { ...page, pageUrl: "https://shop.test/pricing" })).length, 1);
    assert.deepEqual(await due(ada.identityId, { ...page, pageUrl: "https://shop.test/pricing" }), [], "Ada has an open conversation");
    assert.equal((await due(visitor.identityId, { ...page, pageUrl: "https://shop.test/pricing" })).length, 1, "visitors too");
    await pause(PRICING);

    // Subscriptions: nobody gets a message of a type they said no to (no bypass).
    await tenant(db.connect, "a", (q) => setSubscription(q, "a", grace.contactId, TIPS, "opted_out", "preference_page", null));
    const TIPS_MSG = await publish("A tip", { delivery: { mode: "ongoing" }, quietHours: false });
    assert.deepEqual(await due(grace.identityId), []);
    detail = (await agent(`outbound-message?id=${TIPS_MSG}`)).body;
    assert.deepEqual(
      detail.entries.filter((e: any) => e.name === "Grace").map((e: any) => [e.status, e.reason]),
      [["suppressed", "Not subscribed to Tips."]],
    );
    await pause(TIPS_MSG);
    await tenant(db.connect, "a", (q) => setSubscription(q, "a", grace.contactId, TIPS, "opted_in", "preference_page", null));

    // Caps: the workspace's (2 in 7 days, across all outbound) and a message's own.
    await agent("outbound-settings", { capCount: 2, capDays: 7, quietStart: "21:00", quietEnd: "08:00", timezone: "UTC" });
    const burst = [];
    for (let i = 0; i < 4; i++) burst.push(await publish(`Burst ${i}`, { delivery: { mode: "ongoing" }, quietHours: false }));
    const v2 = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "anonymous", "device-2"));
    let got = 0;
    for (let i = 0; i < 6; i++) got += (await due(v2.identityId)).length;
    assert.equal(got, 2, "the workspace's cap holds across messages");
    for (const id of burst) await pause(id);
    await agent("outbound-settings", { capCount: 50, capDays: 7, quietStart: "21:00", quietEnd: "08:00", timezone: "UTC" });
    const EVERY = await publish("Every visit", { delivery: { mode: "ongoing" }, quietHours: false, reentry: { mode: "every" }, cap: { count: 2, days: 1 } });
    const v3 = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "anonymous", "device-3"));
    got = 0;
    for (let i = 0; i < 5; i++) got += (await due(v3.identityId)).length;
    assert.equal(got, 2, "the message's own cap");
    await pause(EVERY);

    // Quiet hours: a message that respects them waits (in the contact's timezone).
    // Quiet from an hour ago to two hours from now, in UTC: now is quiet here, and not in Kiritimati (UTC+14).
    const h = new Date().getUTCHours();
    const hh = (x: number) => String((x + 24) % 24).padStart(2, "0") + ":00";
    await agent("outbound-settings", { capCount: 50, capDays: 7, quietStart: hh(h - 1), quietEnd: hh(h + 2), timezone: "UTC" });
    const QUIET = await publish("Quiet", { delivery: { mode: "once" }, quietHours: true });
    await outboundSweep(db.connect, "a");
    await drain();
    assert.deepEqual(await due(grace.identityId), []);
    detail = (await agent(`outbound-message?id=${QUIET}`)).body;
    assert.deepEqual(detail.entries.find((e: any) => e.name === "Grace").reason, "Quiet hours where they are.");
    await sql("a", "UPDATE contacts SET origin_timezone='Pacific/Kiritimati' WHERE id=$1", [grace.contactId]);
    assert.equal((await due(grace.identityId)).length, 1, "outside quiet hours where she is, the waiting entry goes");
    await pause(QUIET);
    await agent("outbound-settings", { capCount: 50, capDays: 7, quietStart: "21:00", quietEnd: "21:00", timezone: "UTC" });

    // One-off: the audience when it goes live, fixed; a version published later doesn't change it.
    const ONCE = await publish("Launch news", { delivery: { mode: "once" }, quietHours: false, content: { text: "Version one", senderId: "owner" } });
    await outboundSweep(db.connect, "a");
    await drain();
    assert.equal(await outboundSweep(db.connect, "a"), 0, "launched once");
    const entered = (await sql<{ n: number }>("a", "SELECT count(*)::int AS n FROM outbound_entries WHERE message_id=$1", [ONCE]))[0].n;
    const late = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "anonymous", "device-late"));
    const draft = (await agent(`outbound-message?id=${ONCE}`)).body.draft;
    await agent("outbound-message", { action: "save", id: ONCE, definition: { ...draft, content: { text: "Version two", senderId: "owner" } } });
    await agent("outbound-message", { action: "publish", id: ONCE });
    assert.deepEqual(await due(late.identityId), [], "not in the fixed audience");
    const [v1chat] = await due(visitor.identityId);
    assert.deepEqual((await sql("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='teammate_reply'", [v1chat.conversationId])).map((p: any) => p.body), ["Version one"], "in flight on its version");
    assert.equal((await sql<{ n: number }>("a", "SELECT count(*)::int AS n FROM outbound_entries WHERE message_id=$1", [ONCE]))[0].n, entered);
    await pause(ONCE);

    // A scheduled edit: the live version takes over only at its time.
    const SCHEDULED = await publish("Scheduled", { delivery: { mode: "ongoing" }, quietHours: false, reentry: { mode: "every" }, cap: { count: 10, days: 1 }, content: { text: "Now", senderId: "owner" } });
    const sd = (await agent(`outbound-message?id=${SCHEDULED}`)).body.draft;
    await agent("outbound-message", { action: "save", id: SCHEDULED, definition: { ...sd, content: { text: "Later", senderId: "owner" } } });
    const inAnHour = new Date(Date.now() + 3_600_000);
    await agent("outbound-message", { action: "publish", id: SCHEDULED, at: inAnHour.toISOString() });
    const v4 = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "anonymous", "device-4"));
    const [now1] = await due(v4.identityId);
    const [later1] = await due(v4.identityId, page, new Date(inAnHour.getTime() + 60_000));
    const bodies = async (id: string) => (await sql("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='teammate_reply'", [id])).map((p: any) => p.body);
    assert.deepEqual([await bodies(now1.conversationId), await bodies(later1.conversationId)], [["Now"], ["Later"]]);
    assert.equal((await agent("outbound-message", { action: "publish", id: SCHEDULED, at: "2020-01-01T00:00:00Z" })).status, 400, "not in the past");
    await pause(SCHEDULED);

    // Event-triggered, after a delay; recurring, once per slot.
    const EVENT = await publish("After upgrading", { delivery: { mode: "event", event: { name: "upgraded plan", delayMinutes: 30 } }, quietHours: false });
    const kept = await tenant(db.connect, "a", (q) => recordEvent(q, "a", grace.contactId, checkEvent({ name: "upgraded plan" }), "api", "e-1"));
    assert.equal(kept, "kept");
    assert.deepEqual(await due(grace.identityId), [], "not before its delay");
    assert.equal((await due(grace.identityId, page, new Date(Date.now() + 31 * 60_000))).length, 1);
    await pause(EVENT);
    const DAILY = await publish("Daily digest", { delivery: { mode: "recurring", every: { unit: "day", at: "00:00" } }, quietHours: false, reentry: { mode: "every" }, cap: { count: 5, days: 1 } });
    const effective = (await sql("a", "SELECT effective_at FROM outbound_versions WHERE message_id=$1", [DAILY]))[0].effective_at;
    assert.equal(await outboundSweep(db.connect, "a", new Date(new Date(effective).getTime() + 86_400_000)), 1, "the next day's slot");
    assert.equal(await outboundSweep(db.connect, "a", new Date(new Date(effective).getTime() + 86_400_000)), 0, "once");
    await pause(DAILY);

    // The holdout: a stable control group, entered but never sent, against the goal.
    for (let i = 0; i < 30; i++) await tenant(db.connect, "a", (q) => getIdentity(q, "a", "user", `u-${i}`, { name: `User ${i}` }));
    const HOLD = await publish("With control", { delivery: { mode: "once" }, quietHours: false, goal: { event: "paid", days: 14 }, holdoutPercent: 50, audience: { segmentId: "all-users", rules: { match: "all", rules: [] }, sendTime: [] } });
    await outboundSweep(db.connect, "a");
    await drain();
    const groups = await sql<{ variant: string; status: string; n: number }>("a", "SELECT variant,status,count(*)::int AS n FROM outbound_entries WHERE message_id=$1 GROUP BY 1,2 ORDER BY 1,2", [HOLD]);
    assert.ok(groups.some((g) => g.variant === "control" && g.status === "held_out" && g.n > 5), JSON.stringify(groups));
    const control = (await sql<{ contact_id: string }>("a", "SELECT contact_id FROM outbound_entries WHERE message_id=$1 AND variant='control' LIMIT 1", [HOLD]))[0].contact_id;
    await tenant(db.connect, "a", (q) => recordEvent(q, "a", control, checkEvent({ name: "paid" }), "api", "pay-1"));
    detail = (await agent(`outbound-message?id=${HOLD}`)).body;
    assert.equal(detail.stats.goal.control.converted, 1);
    assert.match(detail.stats.goal.verdict, /^Too few to say: each group needs 100 people\./);
    await pause(HOLD);

    // The list, and pausing and resuming.
    const list = (await agent("outbound")).body;
    assert.ok(list.messages.length >= 10);
    assert.equal(list.messages.find((m: any) => m.id === WELCOME).stats.sent, 1);
    assert.equal((await agent("outbound-message", { action: "pause", id: WELCOME })).body.error.message, "Only a live message can be paused.");
    assert.equal((await agent("outbound-message", { action: "resume", id: WELCOME })).status, 200);

    // O3: a banner: shown once (counted once), on every page its rules allow until it's closed;
    // clicks and closes are the person's own; one that can't be closed stays.
    const made2 = (await agent("outbound-message", { action: "create", type: "banner", title: "Maintenance" })).body;
    assert.deepEqual(made2.problems, ["Write the banner (300 characters at most).", "Choose its subscription type: every message has one."]);
    const bdef = { ...made2.draft, content: { text: "Maintenance tonight", position: "bottom", dismissible: true, action: { label: "Status", url: "https://status.test" } }, subscriptionTypeId: TIPS, audience: { segmentId: null, rules: { match: "all", rules: [] }, sendTime: [{ field: "page_url", op: "contains", value: "/app" }] }, delivery: { mode: "ongoing" }, quietHours: false };
    assert.equal((await agent("outbound-message", { action: "save", id: made2.message.id, definition: { ...bdef, type: "chat" } })).body.error.message, "A message's type stays as it was made.");
    await agent("outbound-message", { action: "save", id: made2.message.id, definition: bdef });
    assert.equal((await agent("outbound-message", { action: "publish", id: made2.message.id })).status, 200);
    const BANNER = made2.message.id as string;
    const v6 = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "anonymous", "device-6"));
    const showBanner = (url: string, identityId = v6.identityId) => tenant(db.connect, "a", (q) => dueBanner(q, "a", { identityId }, { ...page, pageUrl: url }));
    assert.deepEqual(await showBanner("https://shop.test/home"), [], "not on that page");
    const [b1] = await showBanner("https://shop.test/app");
    assert.deepEqual({ ...b1, entryId: "" }, { entryId: "", text: "Maintenance tonight", position: "bottom", dismissible: true, action: { label: "Status", url: "https://status.test" } });
    assert.equal((await showBanner("https://shop.test/app/settings"))[0].entryId, b1.entryId, "the same banner on the next page");
    assert.equal((await sql<{ n: number }>("a", "SELECT count(*)::int AS n FROM outbound_entries WHERE message_id=$1", [BANNER]))[0].n, 1, "counted once");
    await assert.rejects(tenant(db.connect, "a", (q) => outboundAction(q, "a", grace.identityId, b1.entryId, "clicked")), /isn't yours/);
    await tenant(db.connect, "a", (q) => outboundAction(q, "a", v6.identityId, b1.entryId, "clicked"));
    await tenant(db.connect, "a", (q) => outboundAction(q, "a", v6.identityId, b1.entryId, "dismissed"));
    assert.deepEqual(await showBanner("https://shop.test/app"), [], "closed: gone for good");
    detail = (await agent(`outbound-message?id=${BANNER}`)).body;
    assert.deepEqual([detail.stats.sent, detail.stats.seen, detail.stats.clicked, detail.stats.dismissed], [1, 1, 1, 1]);
    assert.ok(detail.entries[0].clickedAt && detail.entries[0].dismissedAt);
    await agent("outbound-message", { action: "save", id: BANNER, definition: { ...bdef, content: { ...bdef.content, dismissible: false } } });
    await agent("outbound-message", { action: "publish", id: BANNER });
    const v7 = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "anonymous", "device-7"));
    const [b2] = await showBanner("https://shop.test/app", v7.identityId);
    await assert.rejects(tenant(db.connect, "a", (q) => outboundAction(q, "a", v7.identityId, b2.entryId, "dismissed")), /can't be closed/);
    assert.equal((await showBanner("https://shop.test/app", v7.identityId)).length, 1);
    await pause(BANNER);
    assert.deepEqual(await showBanner("https://shop.test/app", v7.identityId), [], "paused: not shown");
    // The editor's choices: senders, in-app subscriptions only, segments, events.
    const choices = (await agent("outbound")).body.choices;
    assert.deepEqual(choices.subscriptions.map((x: any) => x.name), ["Tips"]);
    assert.ok(choices.segments.some((x: any) => x.id === "all-users") && choices.events.includes("paid"));

    // Another workspace: its own messages; a's aren't its.
    await sql("b", "UPDATE workspace_features SET enabled=true WHERE name='outbound_v1'");
    assert.deepEqual((await agent("outbound", undefined, "owner-b", "b")).body.messages, []);
    assert.equal((await agent(`outbound-message?id=${WELCOME}`, undefined, "owner-b", "b")).status, 404);
    assert.equal((await agent("outbound-message", { action: "pause", id: WELCOME }, "owner-b", "b")).status, 404);
    const vb = await tenant(db.connect, "b", (q) => getIdentity(q, "b", "anonymous", "device-b"));
    await assert.rejects(tenant(db.connect, "b", (q) => outboundAction(q, "b", vb.identityId, b1.entryId, "clicked")), /isn't yours/);

    // The rollback: the flag off, live messages paused; the messenger is given nothing.
    const rollback = readFileSync("db/rollback/0072_outbound.sql", "utf8");
    for (const statement of rollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await sql("a", statement);
    assert.deepEqual(await sql("a", "SELECT DISTINCT state FROM outbound_messages WHERE state='live'"), []);
    const v5 = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "anonymous", "device-5"));
    assert.deepEqual(await due(v5.identityId), []);
    assert.equal((await agent("outbound")).status, 404);
  } finally {
    await db.close();
  }
});
