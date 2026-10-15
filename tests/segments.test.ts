import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, mergeVisitorIdentity, seedFoundation } from "../server/people";
import { runJob, type Job } from "../server/jobs";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { mayDeliver, queueDeliveryTo, receiveInbound, registerChannel, runDelivery, type ChannelAdapter, type Outbound } from "../server/channels";
import { identityIssuer } from "../server/identity";
import { contactFacts, matching } from "../server/segments";
import { messengerEvent } from "../server/events";
import { preferenceToken } from "../server/subscriptions";
import { append, conversation } from "../server/conversations";
import { matches, PREDEFINED, segmentProblems, type Rule, type SegmentDefinition } from "../lib/segments";

/**
 * Events, subscriptions and segments (phase 13, O1; docs/OUTBOUND_STEP1.md): rules checked; the
 * rules' SQL agreeing with their code on a generated corpus; events from the messenger (signed-in
 * users only) and the customer's server (signed with the identity key), kept once, archived and
 * limited; subscription types, the preference page, merges, and the delivery gate refusing a
 * contact who said no; the People area and Settings; another workspace's data; the rollback.
 */
test("segment rules: checked with reasons; later phases' data refused by name", () => {
  assert.deepEqual(segmentProblems({ match: "all", rules: [] }), []);
  assert.deepEqual(segmentProblems({ match: "some", rules: [] }), ["A segment matches all or any of a list of rules."]);
  const one = (r: Partial<Rule>) => segmentProblems({ match: "all", rules: [r as Rule] })[0];
  assert.equal(one({ field: "company.plan", op: "is", value: "x" }), "Rule 1: Companies arrive in phase 01.");
  assert.equal(one({ field: "tag", op: "is", value: "vip" }), "Rule 1: Tags on people arrive in phase 01.");
  assert.equal(one({ field: "role", op: "contains", value: "u" }), "Rule 1: type can't be filtered that way.");
  assert.equal(one({ field: "role", op: "is", value: "admin" }), "Rule 1: choose one of user, lead, visitor.");
  assert.equal(one({ field: "attribute", op: "is", key: "bad key!", value: "x" }), "Rule 1: name the attribute (letters, digits, . _ : -).");
  assert.equal(one({ field: "attribute", op: "greater_than", key: "seats", value: "ten" }), "Rule 1: compare with a number.");
  assert.equal(one({ field: "last_seen", op: "less_than_days_ago", value: -1 }), "Rule 1: a number of days (0 to 3650).");
  assert.equal(one({ field: "event", op: "performed", key: "", days: 7 }), "Rule 1: choose the event.");
  assert.equal(one({ field: "event", op: "not_performed", key: "x", count: 2 }), "Rule 1: at least 1 to 10000 times.");
  assert.equal(one({ field: "name", op: "is", value: "" }), "Rule 1: give a value (200 characters at most).");
  assert.match(segmentProblems({ match: "any", rules: Array.from({ length: 21 }, () => ({ field: "phone", op: "is_set" })) })[0], /20 rules at most/);
  for (const s of PREDEFINED) assert.deepEqual(segmentProblems(s.definition), [], s.id);
});

const sendTo: Outbound[] = [];
const box: ChannelAdapter = {
  id: "box",
  capabilities: { richText: false, attachments: false, buttons: false, maxLength: 1000, windowHours: null, ai: false, receipts: "none", address: "email" },
  address: (raw) => raw.trim().toLowerCase(),
  async send(out) {
    sendTo.push(out);
    return { status: "sent", providerId: "x" };
  },
};

test("events, subscriptions and segments: one meaning in SQL and code, events kept once from signed sources, subscriptions enforced at the gate, People and Settings, per workspace", async () => {
  const off = registerChannel(box);
  const db = await testDatabase();
  const SECRET = new TextEncoder().encode("i".repeat(32));
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
  /** A token the customer's server would sign for one user. */
  const sign = (w: string, sub: string, o: { aud?: string; secret?: Uint8Array; kid?: string; exp?: string } = {}) =>
    new SignJWT({ workspace_id: w })
      .setProtectedHeader({ alg: "HS256", kid: o.kid ?? "initial" })
      .setSubject(sub)
      .setIssuer(identityIssuer(w))
      .setAudience(o.aud ?? "relay-events")
      .setIssuedAt()
      .setExpirationTime(o.exp ?? "5m")
      .sign(o.secret ?? SECRET);
  const events = async (token: string, body: unknown) => {
    const r = await handleApi(new Request("https://relay.test/v1/events", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) }), env);
    return { status: r.status, body: (await r.json()) as any };
  };
  const page = (token: string, form?: Record<string, string>) =>
    handleApi(
      new Request("https://relay.test/v1/preferences/" + token, {
        method: form ? "POST" : "GET",
        ...(form ? { headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() } : {}),
      }),
      env,
    );
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) => seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: SECRET, enable: true }));
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE name IN ('channels_v1','settings_v1')");
    }
    // A role without people's details (agents have them, as in Intercom).
    await sql("a", "INSERT INTO roles(workspace_id,id,name) VALUES('a','limited','Limited')");
    await sql("a", "INSERT INTO role_capabilities(workspace_id,role_id,capability) VALUES('a','limited','conversations.reply')");
    await sql("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','grace','grace-a','Grace','limited')");

    // Off by default: no People, Settings pages, events or preference page.
    assert.equal((await agent("people")).status, 404);
    assert.equal((await events(await sign("a", "u-1"), { events: [{ id: "e1", name: "signed up" }] })).status, 404);
    await sql("a", "UPDATE workspace_features SET enabled=true WHERE name='segments_v1'");
    assert.equal((await agent("people", undefined, "grace-a")).status, 403, "people's details need contacts.personal_data");
    assert.equal((await agent("events-settings", undefined, "grace-a")).status, 403);
    assert.equal((await agent("subscription-settings", undefined, "grace-a")).status, 403);

    // Subscription types: checked; consent and channel fixed once made; archived, never deleted.
    for (const [body, text] of [
      [{ action: "create", name: "", consent: "opt_in", channel: "email" }, /Name it/],
      [{ action: "create", name: "News", consent: "maybe", channel: "email" }, /opt-in or opt-out/],
      [{ action: "create", name: "News", consent: "opt_in", channel: "fax" }, /its channel/],
    ] as const) {
      const r = await agent("subscription-settings", body);
      assert.equal(r.status, 400);
      assert.match(r.body.error.message, text);
    }
    await agent("subscription-settings", { action: "create", name: "Product updates", description: "Monthly", consent: "opt_out", channel: "email" });
    await agent("subscription-settings", { action: "create", name: "Offers", consent: "opt_in", channel: "sms" });
    await agent("subscription-settings", { action: "create", name: "Old news", consent: "opt_out", channel: "email" });
    assert.match((await agent("subscription-settings", { action: "create", name: "product UPDATES", consent: "opt_in", channel: "email" })).body.error.message, /already exists/);
    let types = (await agent("subscription-settings")).body.types as { id: string; name: string; consent: string }[];
    const UPDATES = types.find((t) => t.name === "Product updates")!.id;
    const OFFERS = types.find((t) => t.name === "Offers")!.id;
    const OLD = types.find((t) => t.name === "Old news")!.id;
    await agent("subscription-settings", { action: "update", id: UPDATES, name: "Product updates", description: "Once a month", consent: "opt_in" });
    await agent("subscription-settings", { action: "archive", id: OLD });
    types = (await agent("subscription-settings")).body.types;
    assert.deepEqual(
      types.map((t: any) => [t.name, t.consent, t.description, t.archived]),
      [
        ["Offers", "opt_in", "", false],
        ["Product updates", "opt_out", "Once a month", false],
        ["Old news", "opt_out", "", true],
      ],
      "consent stays as made; archived last",
    );

    // A generated corpus: every rule's SQL agrees with its code.
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
    const now = Date.now();
    const DAY = 86_400_000;
    const names = ["Ada", "Grace", "", "Linus", "ada lovelace"];
    const domains = ["example.com", "acme.io", "EXAMPLE.com"];
    const ids: string[] = [];
    for (let i = 0; i < 48; i++) {
      const id = `c${i}`;
      ids.push(id);
      const role = pick(["user", "lead", "visitor"] as const);
      await sql(
        "a",
        "INSERT INTO contacts(workspace_id,id,role,name,external_id,profile,first_seen_at,last_seen_at,signed_up_at,global_unsubscribe) VALUES('a',$1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          id,
          role,
          pick(names),
          role === "user" ? `user-${i}` : null,
          JSON.stringify(pick([{}, { plan: "pro", seats: 12 }, { plan: "free", seats: 1 }, { plan: "Pro", seats: "many" }, { seats: 5, beta: true }, { plan: null }])),
          new Date(now - (60 + Math.floor(rand() * 300)) * DAY).toISOString(),
          new Date(now - Math.floor(rand() * 60) * DAY - 3_600_000).toISOString(),
          rand() < 0.5 ? new Date(now - Math.floor(rand() * 40) * DAY - 3_600_000).toISOString() : null,
          rand() < 0.15,
        ],
      );
      for (let e = 0; e < Math.floor(rand() * 3); e++) await sql("a", "INSERT INTO contact_emails(workspace_id,contact_id,email) VALUES('a',$1,$2) ON CONFLICT DO NOTHING", [id, `${pick(["ada", "x", "sales"])}${e}@${pick(domains)}`]);
      if (rand() < 0.3) await sql("a", "INSERT INTO contact_phones(workspace_id,contact_id,phone) VALUES('a',$1,'+447700900' || $2)", [id, String(100 + i)]);
      for (let e = 0; e < Math.floor(rand() * 4); e++)
        await sql("a", "INSERT INTO contact_events(workspace_id,id,contact_id,name,source,dedupe_key,occurred_at) VALUES('a',$1,$2,$3,'api',$1,$4)", [
          crypto.randomUUID(),
          id,
          pick(["upgraded", "exported report"]),
          new Date(now - Math.floor(rand() * 20) * DAY - 3_600_000).toISOString(),
        ]);
      if (rand() < 0.4) await sql("a", "INSERT INTO contact_subscriptions(workspace_id,contact_id,subscription_type_id,state) VALUES('a',$1,$2,$3)", [id, pick([UPDATES, OFFERS, OLD]), pick(["opted_in", "opted_out"])]);
    }
    const rules: Rule[] = [
      ...["user", "lead", "visitor"].flatMap((v) => [{ field: "role", op: "is", value: v } as Rule, { field: "role", op: "is_not", value: v } as Rule]),
      ...(["is", "is_not", "contains", "is_set", "is_not_set"] as const).map((op) => ({ field: "name", op, value: "ada" })),
      ...(["is", "is_not", "contains", "ends_with", "is_set", "is_not_set"] as const).map((op) => ({ field: "email", op, value: op === "ends_with" ? "@example.com" : op === "contains" ? "SALES" : "ada0@example.com" })),
      { field: "phone", op: "is_set" },
      { field: "phone", op: "is_not_set" },
      { field: "external_id", op: "is_set" },
      { field: "external_id", op: "is", value: "USER-3" },
      ...(["first_seen", "last_seen", "signed_up"] as const).flatMap((field) => [
        { field, op: "more_than_days_ago", value: 20 } as Rule,
        { field, op: "less_than_days_ago", value: 20 } as Rule,
      ]),
      { field: "signed_up", op: "is_not_set" },
      { field: "unsubscribed", op: "is", value: "true" },
      { field: "unsubscribed", op: "is", value: "false" },
      ...(["is", "is_not", "contains", "is_set", "is_not_set"] as const).map((op) => ({ field: "attribute", key: "plan", op, value: "pro" })),
      { field: "attribute", key: "seats", op: "greater_than", value: 4 },
      { field: "attribute", key: "seats", op: "less_than", value: 4 },
      { field: "attribute", key: "beta", op: "is", value: "true" },
      { field: "event", key: "upgraded", op: "performed" },
      { field: "event", key: "upgraded", op: "performed", days: 7 },
      { field: "event", key: "exported report", op: "performed", count: 2 },
      { field: "event", key: "exported report", op: "not_performed", days: 10 },
      { field: "event", key: "never happens", op: "not_performed" },
      ...[UPDATES, OFFERS, OLD, "missing"].flatMap((key) => [{ field: "subscription", key, op: "opted_in" } as Rule, { field: "subscription", key, op: "opted_out" } as Rule]),
    ];
    const defs: SegmentDefinition[] = [
      { match: "all", rules: [] },
      ...rules.map((r) => ({ match: "all" as const, rules: [r] })),
      ...Array.from({ length: 40 }, () => ({ match: pick(["all", "any"] as const), rules: [pick(rules), pick(rules), pick(rules)] })),
    ];
    let nonTrivial = 0;
    await tenant(db.connect, "a", async (q) => {
      for (const def of defs) {
        const bySql = new Set<string>();
        for (let p = 0; ; p++) {
          const m = await matching(q, "a", def, p, now);
          m.contacts.forEach((c) => ids.includes(c.id) && bySql.add(c.id));
          if ((p + 1) * 50 >= m.count) break;
        }
        const byCode = new Set<string>();
        for (const id of ids) if (matches(def, await contactFacts(q, "a", id, def), now)) byCode.add(id);
        assert.deepEqual([...bySql].sort(), [...byCode].sort(), JSON.stringify(def));
        if (byCode.size > 0 && byCode.size < ids.length) nonTrivial++;
      }
    });
    assert.ok(nonTrivial > rules.length / 2, "the corpus tells rules apart");
    await sql("a", "DELETE FROM contact_events");
    await sql("a", "DELETE FROM contact_emails WHERE contact_id LIKE 'c%'");
    await sql("a", "DELETE FROM contact_phones WHERE contact_id LIKE 'c%'");
    await sql("a", "DELETE FROM contact_subscriptions WHERE contact_id LIKE 'c%'");
    await sql("a", "DELETE FROM contacts WHERE id LIKE 'c%'");

    // Events from the customer's server: signed with the workspace's identity key for one user, kept once by id.
    let r = await events(await sign("a", "u-1"), { events: [{ id: "e1", name: "upgraded plan", metadata: { plan: "pro", seats: 12 } }, { id: "e2", name: "exported report" }] });
    assert.deepEqual([r.status, r.body], [200, { kept: 2, duplicate: 0, ignored: 0 }]);
    assert.deepEqual((await events(await sign("a", "u-1"), { events: [{ id: "e1", name: "upgraded plan" }] })).body, { kept: 0, duplicate: 1, ignored: 0 }, "a retry counts once");
    const ada = (await sql<{ id: string; role: string }>("a", "SELECT id,role FROM contacts WHERE external_id='u-1'"))[0];
    assert.equal(ada.role, "user", "the user is found, or added, as the messenger would");
    for (const [token, why] of [
      [await sign("a", "u-1", { aud: "relay-messenger" }), "a messenger token"],
      [await sign("a", "u-1", { secret: new TextEncoder().encode("f".repeat(32)) }), "another key"],
      [await sign("a", "u-1", { kid: "nope" }), "an unknown key"],
      [await sign("a", "u-1", { exp: "3h" }), "longer than an hour"],
      [await sign("b", "u-1", { secret: new TextEncoder().encode("f".repeat(32)) }), "workspace b, wrong key"],
      ["not-a-token-at-all-but-long-enough", "garbage"],
    ] as const)
      assert.equal((await events(token, { events: [{ id: "x", name: "upgraded plan" }] })).status, 401, why);
    assert.equal((await events(await sign("b", "u-1"), { events: [{ id: "x", name: "upgraded plan" }] })).status, 404, "b's events are off");
    for (const [body, text] of [
      [{ events: [] }, /1 to 100 events/],
      [{ events: [{ name: "no id" }] }, /has an id/],
      [{ events: [{ id: "x", name: "!bad" }] }, /name is 1 to 100/],
      [{ events: [{ id: "x", name: "ok", metadata: { nested: { a: 1 } } }] }, /Metadata "nested"/],
      [{ events: [{ id: "x", name: "ok", occurredAt: "2001-01-01T00:00:00Z" }] }, /within the last 30 days/],
    ] as const) {
      const x = await events(await sign("a", "u-1"), body);
      assert.equal(x.status, 400);
      assert.match(x.body.error.message, text);
    }
    // From the messenger: only a signed-in user's.
    const visitor = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "anonymous", "device-1"));
    const user = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "user", "u-1"));
    await assert.rejects(
      tenant(db.connect, "a", (q) => messengerEvent(q, "a", { identityId: visitor.identityId, verified: false }, "key-00000001", { name: "upgraded plan" })),
      /only for signed-in users/,
    );
    assert.deepEqual(await tenant(db.connect, "a", (q) => messengerEvent(q, "a", { identityId: user.identityId, verified: true }, "key-00000002", { name: "opened billing" })), { result: "kept" });
    assert.deepEqual(await tenant(db.connect, "a", (q) => messengerEvent(q, "a", { identityId: user.identityId, verified: true }, "key-00000002", { name: "opened billing" })), { result: "duplicate" });
    assert.deepEqual(
      (await sql("a", "SELECT name,source,metadata FROM contact_events WHERE contact_id=$1 ORDER BY name", [ada.id])).map((e: any) => [e.name, e.source, e.metadata]),
      [
        ["exported report", "api", {}],
        ["opened billing", "messenger", {}],
        ["upgraded plan", "api", { plan: "pro", seats: 12 }],
      ],
    );
    // Settings › Events: described; archived (no longer kept); the limit of 120.
    let ev = (await agent("events-settings")).body;
    assert.deepEqual([ev.tracked, ev.limit, ev.events.map((e: any) => [e.name, e.count]).sort()], [3, 120, [["exported report", 1], ["opened billing", 1], ["upgraded plan", 1]]]);
    await agent("events-settings", { action: "describe", name: "upgraded plan", description: "Moved to a paid plan" });
    await agent("events-settings", { action: "archive", name: "exported report" });
    assert.deepEqual((await events(await sign("a", "u-1"), { events: [{ id: "e3", name: "exported report" }] })).body, { kept: 0, duplicate: 0, ignored: 1 });
    ev = (await agent("events-settings")).body;
    assert.deepEqual(ev.events.find((e: any) => e.name === "upgraded plan").description, "Moved to a paid plan");
    await sql("a", "INSERT INTO event_definitions(workspace_id,name) SELECT 'a','filler ' || g FROM generate_series(1,118) g");
    r = await events(await sign("a", "u-1"), { events: [{ id: "e4", name: "brand new" }] });
    assert.deepEqual([r.status, r.body.error.code], [409, "EVENT_LIMIT"]);
    assert.equal((await agent("events-settings", { action: "restore", name: "exported report" })).body.error.code, "EVENT_LIMIT");
    await sql("a", "DELETE FROM event_definitions WHERE name LIKE 'filler %'");
    assert.equal((await agent("events-settings", { action: "restore", name: "exported report" })).status, 200);

    // Subscriptions: what each contact gets, their preference page, history.
    await tenant(db.connect, "a", (q) => getIdentity(q, "a", "anonymous", "lead-1", { email: "lead@example.com" }));
    let details = (await agent("people", { action: "contact", contactId: ada.id })).body;
    assert.deepEqual(
      details.subscriptions.map((s: any) => [s.name, s.state]),
      [
        ["Offers", "opted_out"],
        ["Product updates", "opted_in"],
      ],
      "opt-in types start out, opt-out types in",
    );
    const token = await preferenceToken(env.sessionSecret, "a", ada.id);
    let res = await page(token);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy")!, /default-src 'none'/);
    assert.match(body, /name="type:[^"]+" checked><span><strong>Product updates<\/strong>/);
    assert.doesNotMatch(body, /Old news/, "archived types aren't offered");
    assert.doesNotMatch(body, /<script/);
    res = await page(token, { [`type:${OFFERS}`]: "on" });
    assert.match(await res.text(), /Saved\./);
    details = (await agent("people", { action: "contact", contactId: ada.id })).body;
    assert.deepEqual(details.subscriptions.map((s: any) => s.state), ["opted_in", "opted_out"]);
    assert.deepEqual(
      (await sql("a", "SELECT subscription_type_id,state,source FROM contact_subscription_changes WHERE contact_id=$1 ORDER BY created_at,state", [ada.id])).map((c: any) => [c.subscription_type_id, c.state, c.source]),
      [
        [OFFERS, "opted_in", "preference_page"],
        [UPDATES, "opted_out", "preference_page"],
      ],
      "only changes are recorded",
    );
    await assert.rejects(sql("a", "DELETE FROM contact_subscription_changes"), /append-only/);
    await assert.rejects(sql("a", "UPDATE contact_subscription_changes SET state='opted_in'"), /append-only/);
    await page(token, { [`type:${OFFERS}`]: "on", all: "on" });
    assert.equal((await agent("people", { action: "contact", contactId: ada.id })).body.contact.unsubscribedFromAll, true);
    assert.match(await (await page(token)).text(), /name="all" checked/);
    assert.match(await (await page(token)).text(), new RegExp(`name="type:${OFFERS}" checked`), "their own choices still show");
    assert.equal((await page(token.slice(0, -2) + "xx")).status, 404, "a forged link");
    assert.equal((await page(await preferenceToken("another-secret-entirely-0000000000000", "a", ada.id))).status, 404);
    // The gate: nothing of a type is delivered to a contact who said no (nor of an archived type).
    const c = await tenant(db.connect, "a", (q) => receiveInbound(q, "a", box, { externalId: "m1", address: "lead@example.com", text: "Hi", verified: false, threadKeys: [], brandId: "default" }));
    const boxIdentity = (await sql<{ primary_identity_id: string }>("a", "SELECT primary_identity_id FROM conversations WHERE id=$1", [c.conversationId]))[0].primary_identity_id;
    const boxContact = (await sql<{ contact_id: string }>("a", "SELECT contact_id FROM identity_contact_mappings WHERE identity_id=$1", [boxIdentity]))[0].contact_id;
    const gate = (typeId?: string) => tenant(db.connect, "a", (q) => mayDeliver(q, "a", "box", "lead@example.com", null, undefined, typeId ? { typeId, identityId: boxIdentity } : undefined));
    assert.deepEqual(await gate(), { ok: true }, "a reply in their own conversation has no subscription");
    assert.deepEqual(await gate(UPDATES), { ok: true });
    assert.deepEqual(await gate(OFFERS), { ok: false, status: "suppressed", reason: "Not subscribed to Offers." });
    assert.deepEqual(await gate(OLD), { ok: false, status: "suppressed", reason: "Not subscribed to Old news." });
    await sql("a", "UPDATE contacts SET global_unsubscribe=true WHERE id=$1", [boxContact]);
    assert.deepEqual(await gate(UPDATES), { ok: false, status: "suppressed", reason: "Not subscribed to Product updates." });
    // ... and through the delivery job, as outbound will queue it (the part kept internal here, so
    // only this delivery of it exists).
    const part = await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", c.conversationId!), { type: "system", id: "test" }, "workflow_message", "Our news", {}, "internal"));
    await tenant(db.connect, "a", (q) => queueDeliveryTo(q, "a", c.conversationId!, part.id, "box", boxIdentity, "lead@example.com", "reply", false, UPDATES));
    const job = (await sql<{ id: string }>("a", "SELECT id FROM jobs WHERE kind='channel.deliver' ORDER BY created_at DESC LIMIT 1"))[0];
    await runJob(db.connect, "a", job.id, { "channel.deliver": (j: Job) => runDelivery(db.connect, {}, j) });
    assert.equal(sendTo.length, 0);
    assert.deepEqual(await sql("a", "SELECT status,error FROM channel_deliveries WHERE part_id=$1", [part.id]), [{ status: "suppressed", error: "Not subscribed to Product updates." }]);
    // A merge: the visitor's opt-outs (and unsubscribing from everything) carry; opt-ins don't.
    const v2 = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "anonymous", "device-2"));
    const u2 = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "user", "u-2"));
    await sql("a", "INSERT INTO contact_subscriptions(workspace_id,contact_id,subscription_type_id,state) VALUES('a',$1,$2,'opted_out'),('a',$1,$3,'opted_in')", [v2.contactId, UPDATES, OFFERS]);
    await tenant(db.connect, "a", (q) => mergeVisitorIdentity(q, "a", v2.identityId, u2.contactId));
    assert.deepEqual(
      (await agent("people", { action: "contact", contactId: u2.contactId })).body.subscriptions.map((s: any) => [s.name, s.state]),
      [
        ["Offers", "opted_out"],
        ["Product updates", "opted_out"],
      ],
    );
    assert.deepEqual(await sql("a", "SELECT source,actor FROM contact_subscription_changes WHERE contact_id=$1", [u2.contactId]), [{ source: "merge", actor: v2.contactId }]);

    // People: predefined and saved segments with counts; a draft's live list; one person.
    await sql("a", "UPDATE contacts SET profile='{\"plan\":\"pro\"}',signed_up_at=now() WHERE id=$1", [ada.id]);
    const people = (await agent("people")).body;
    assert.deepEqual(
      people.segments.map((s: any) => [s.id, s.count]),
      [
        ["all-users", 2],
        ["all-leads", 2],
        ["active", 2],
        ["new", 1],
      ],
    );
    assert.deepEqual([people.events.sort(), people.subscriptions.map((s: any) => s.name)], [["exported report", "opened billing", "upgraded plan"], ["Offers", "Product updates"]]);
    assert.ok(people.attributes.includes("plan"));
    const pro: SegmentDefinition = { match: "all", rules: [{ field: "role", op: "is", value: "user" }, { field: "event", key: "upgraded plan", op: "performed", days: 30 }] };
    const list = (await agent("people", { action: "list", definition: pro })).body;
    assert.deepEqual([list.count, list.contacts.map((x: any) => x.id)], [1, [ada.id]]);
    assert.equal((await agent("people", { action: "list", definition: { match: "all", rules: [{ field: "company.plan", op: "is", value: "x" }] } })).body.error.message, "Rule 1: Companies arrive in phase 01.");
    const saved = (await agent("people", { action: "save", name: "Upgraded lately", definition: pro })).body;
    assert.ok(saved.segments.some((s: any) => s.id === saved.id && s.count === 1));
    assert.match((await agent("people", { action: "save", name: "upgraded LATELY", definition: pro })).body.error.message, /already exists/);
    assert.match((await agent("people", { action: "save", name: "Active", definition: pro })).body.error.message, /already exists/);
    assert.equal((await agent("people", { action: "save", id: "active", name: "Mine", definition: pro })).status, 409, "predefined segments are code");
    assert.equal((await agent("people", { action: "list", segmentId: saved.id })).body.count, 1);
    await agent("people", { action: "archive", id: saved.id });
    assert.equal((await agent("people", { action: "list", segmentId: saved.id })).status, 404);
    details = (await agent("people", { action: "contact", contactId: ada.id })).body;
    assert.deepEqual([details.contact.externalId, details.events.length, details.contact.attributes], ["u-1", 3, { plan: "pro" }]);

    // Another workspace: its own (empty) people and settings; a's person, segment and link aren't its.
    await sql("b", "UPDATE workspace_features SET enabled=true WHERE name='segments_v1'");
    const other = (await agent("people", undefined, "owner-b", "b")).body;
    assert.deepEqual([other.segments.map((s: any) => s.count), other.events, other.subscriptions], [[0, 0, 0, 0], [], []]);
    assert.equal((await agent("people", { action: "contact", contactId: ada.id }, "owner-b", "b")).status, 404);
    assert.equal((await agent("people", { action: "list", segmentId: saved.id }, "owner-b", "b")).status, 404);
    assert.equal((await agent("subscription-settings", { action: "archive", id: OFFERS }, "owner-b", "b")).status, 400);
    assert.deepEqual((await agent("events-settings", undefined, "owner-b", "b")).body.events, []);
    assert.equal((await page(await preferenceToken(env.sessionSecret, "b", ada.id))).status, 404, "a's contact isn't b's");

    // The rollback: the flag off; events refused, the pages and the preference link closed; the gate still checks.
    const rollback = readFileSync("db/rollback/0071_people_data.sql", "utf8");
    for (const statement of rollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await sql("a", statement);
    assert.equal((await events(await sign("a", "u-1"), { events: [{ id: "e9", name: "upgraded plan" }] })).status, 404);
    assert.equal((await agent("people")).status, 404);
    assert.equal((await page(token)).status, 404);
    assert.deepEqual(await gate(UPDATES), { ok: false, status: "suppressed", reason: "Not subscribed to Product updates." });
  } finally {
    off();
    await db.close();
  }
});
