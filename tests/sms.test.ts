import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { append, command, conversation } from "../server/conversations";
import { runJob, type Job } from "../server/jobs";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { attachmentScan } from "../server/attachments";
import { runDelivery } from "../server/channels";
import { checkSmsAccountJob, connectSmsNumberJob, receiveSmsJob, type SmsEnvironment } from "../server/sms";
import { callingCode, segmentsOf } from "../lib/sms";
import { localAttachmentStorage } from "../scripts/local-storage";
import { LOCAL_TWILIO, localSms } from "../scripts/local-sms";

/**
 * SMS (phase 12, E6; docs/OMNICHANNEL_STEP6.md): segments and calling codes; the Twilio account and
 * numbers per country; Twilio's signed webhook; texts both ways with status; consent, STOP, START
 * and HELP; the segment limit and files refused.
 */
test("segments: GSM-7 at 160 (153 each when several), its extension characters twice, anything else UCS-2 at 70 (67)", () => {
  assert.deepEqual(segmentsOf(""), { encoding: "GSM-7", units: 0, segments: 0, perSegment: 160 });
  assert.deepEqual(segmentsOf("Hello"), { encoding: "GSM-7", units: 5, segments: 1, perSegment: 160 });
  assert.equal(segmentsOf("a".repeat(160)).segments, 1);
  assert.deepEqual(segmentsOf("a".repeat(161)), { encoding: "GSM-7", units: 161, segments: 2, perSegment: 153 });
  assert.equal(segmentsOf("a".repeat(306)).segments, 2);
  assert.equal(segmentsOf("a".repeat(307)).segments, 3);
  assert.equal(segmentsOf("€".repeat(80)).units, 160, "extension characters count twice");
  assert.equal(segmentsOf("Café ñ Ü").encoding, "GSM-7");
  assert.deepEqual(segmentsOf("Thanks 👍"), { encoding: "UCS-2", units: 9, segments: 1, perSegment: 70 });
  assert.equal(segmentsOf("ж".repeat(70)).segments, 1);
  assert.equal(segmentsOf("ж".repeat(71)).segments, 2);
  assert.deepEqual(["+447700900456", "+15005550006", "+2348031234567", "+79161234567", "+353861234567", "+4915112345678"].map(callingCode), ["44", "1", "234", "7", "353", "49"]);
});

test("SMS: the Twilio account and numbers, the signed webhook, texts both ways, consent, STOP, START and HELP", async () => {
  const db = await testDatabase();
  const storage = localAttachmentStorage().storage;
  const twilio = localSms();
  const key = "k".repeat(40);
  const ORIGIN = "https://relay.test";
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    attachments: storage,
    connectors: { key },
  };
  const smsEnv: SmsEnvironment = { api: twilio.api, key, storage, hookOrigin: ORIGIN };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "sms.receive": (j: Job) => receiveSmsJob(db.connect, smsEnv, j),
    "sms.check": (j: Job) => checkSmsAccountJob(db.connect, smsEnv, j),
    "sms.number": (j: Job) => connectSmsNumberJob(db.connect, smsEnv, j),
    "attachment.scan": (j: Job) => attachmentScan(db.connect, storage, j),
    "channel.deliver": (j: Job) => runDelivery(db.connect, { providers: { sms: smsEnv } }, j),
  };
  const drain = async (w = "a") => {
    for (let i = 0; i < 100; i++) {
      const job = (
        await sql<{ id: string }>(w, "SELECT id FROM jobs WHERE kind=ANY($1::text[]) AND state IN ('queued','running') ORDER BY created_at LIMIT 1", [Object.keys(handlers)])
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
        RELAY_API_ORIGIN: ORIGIN,
        RELAY_WORKSPACE_ID: workspace,
        RELAY_BRIDGE_SECRET: env.bridgeSecret,
      },
      (r) => handleApi(r, env),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  /** A call to the hook as Twilio makes it (signed over the exact URL and form). */
  const hook = async (kind: "message" | "status", params: Record<string, string>, w = "a", token = LOCAL_TWILIO.token) => {
    const url = `${ORIGIN}/v1/hooks/sms/${w}/${kind}`;
    const call = await twilio.signed(url, params, token);
    const r = await handleApi(new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": call.signature }, body: call.body }), env);
    await drain(w);
    return r;
  };
  const UK = LOCAL_TWILIO.numbers[0];
  const US = LOCAL_TWILIO.numbers[1];
  const text = (from: string, body: string, to = UK, media?: [string, Uint8Array][]) => hook("message", twilio.text({ from, to, body, media }));
  const reply = (conversationId: string, t: string) => agent("command", { action: "reply", conversationId, text: t });
  const conversationOf = async (phone: string) =>
    (
      await sql<{ conversation_id: string }>(
        "a",
        "SELECT p.conversation_id FROM conversation_parts p JOIN identity_addresses x ON x.workspace_id=p.workspace_id AND x.identity_id=p.author_id WHERE x.address=$1 AND x.channel='sms' ORDER BY p.created_at DESC LIMIT 1",
        [phone],
      )
    )[0]?.conversation_id;
  const deliveries = async (c: string) => (await agent(`deliveries?conversation=${c}`)).body.deliveries as { status: string; error: string }[];
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
      );
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE name IN ('channels_v1','channel_sms_v1')");
    }

    // The account: bad details refused; sealed (only the token's last four shown); Twilio's check
    // connects it, or says why not.
    assert.equal((await agent("sms-settings", { action: "connect", sid: "nope", token: "x" })).body.error.code, "INVALID_SMS");
    assert.equal((await agent("sms-settings", { action: "number", phone: UK, brandId: "default" })).body.error.message, "Connect the Twilio account first.");
    const connected = await agent("sms-settings", { action: "connect", sid: LOCAL_TWILIO.sid, token: LOCAL_TWILIO.token });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    assert.doesNotMatch(JSON.stringify(connected.body), new RegExp(LOCAL_TWILIO.token));
    await drain();
    let settings = (await agent("sms-settings")).body;
    assert.deepEqual([settings.account.status, settings.account.friendlyName, settings.account.tokenHint], ["connected", "Relay Demo", LOCAL_TWILIO.token.slice(-4)]);
    await agent("sms-settings", { action: "connect", sid: LOCAL_TWILIO.sid, token: "f".repeat(32) }, "owner-b", "b");
    await drain("b");
    assert.deepEqual(
      [(await agent("sms-settings", undefined, "owner-b", "b")).body.account.status, (await agent("sms-settings", undefined, "owner-b", "b")).body.account.error],
      ["failed", "Twilio refused: Authenticate"],
    );

    // Numbers: one in the account, pointed at Relay; one that isn't, failed with why; the first a default.
    await agent("sms-settings", { action: "number", phone: "+44 7700 900100", brandId: "default" });
    await agent("sms-settings", { action: "number", phone: US, brandId: "default" });
    await agent("sms-settings", { action: "number", phone: "+447700900999", brandId: "default" });
    await drain();
    settings = (await agent("sms-settings")).body;
    assert.deepEqual(
      settings.numbers.map((n: { phone: string; callingCode: string; isDefault: boolean; status: string; error: string }) => [n.phone, n.callingCode, n.isDefault, n.status, n.error]),
      [
        ["+15005550006", "1", false, "connected", ""],
        ["+447700900100", "44", true, "connected", ""],
        ["+447700900999", "44", false, "failed", "That number isn't in the Twilio account."],
      ],
    );
    assert.equal(twilio.configured.get("PN447700900100"), `${ORIGIN}/v1/hooks/sms/a/message`);
    assert.equal((await agent("sms-settings", { action: "number", phone: UK, brandId: "default" })).body.error.message, "That number is already added.");

    // The webhook: Twilio's signature over the exact URL and form; another token, account or workspace refused.
    let r = await text("+447700900456", "Hi, is my order on its way?");
    assert.deepEqual([r.status, r.headers.get("content-type"), await r.text()], [200, "text/xml", '<?xml version="1.0" encoding="UTF-8"?><Response></Response>']);
    assert.equal((await hook("message", twilio.text({ from: "+447700900456", to: UK, body: "Forged" }), "a", "f".repeat(32))).status, 403);
    assert.equal((await hook("message", { ...twilio.text({ from: "+447700900456", to: UK, body: "Other account" }), AccountSid: "AC" + "9".repeat(32) })).status, 403);
    assert.equal((await hook("message", twilio.text({ from: "+447700900456", to: UK, body: "To b" }), "b")).status, 403);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM conversation_parts WHERE body IN ('Forged','Other account')"))[0].n, 0);

    // A text in: a conversation on SMS; the number unverified (anyone can claim one); consent recorded.
    const c1 = (await conversationOf("+447700900456"))!;
    assert.deepEqual(await sql("a", "SELECT address,verified FROM identity_addresses WHERE channel='sms'"), [{ address: "+447700900456", verified: false }]);
    assert.deepEqual((await agent("sms-settings")).body.consents.map((c: { phone: string; source: string }) => [c.phone, c.source]), [["+447700900456", "customer_message"]]);
    await text("+447700900456", "Order #4411");
    assert.equal(await conversationOf("+447700900456"), c1, "threaded by number");

    // The composer: from the UK number, the price per segment (an estimate until one is set).
    let target = (await agent(`reply-target?conversation=${c1}`)).body.target;
    assert.deepEqual([target.channel, target.from, target.address, target.maxSegments, target.price], ["sms", UK, "+447700900456", 10, { perSegment: 0.0524, currency: "USD", estimated: true }]);
    await agent("sms-settings", { action: "price", callingCode: "+44", perSegment: 0.04, currency: "gbp" });
    target = (await agent(`reply-target?conversation=${c1}`)).body.target;
    assert.deepEqual(target.price, { perSegment: 0.04, currency: "GBP", estimated: false });

    // Replies: from the number in the customer's country; status callbacks move it forward or say why.
    assert.equal((await reply(c1, "Yes: it ships today.")).status, 200);
    await drain();
    assert.deepEqual(
      { from: twilio.sent.at(-1)!.from, to: twilio.sent.at(-1)!.to, body: twilio.sent.at(-1)!.body, cb: twilio.sent.at(-1)!.statusCallback },
      { from: UK, to: "+447700900456", body: "Yes: it ships today.", cb: `${ORIGIN}/v1/hooks/sms/a/status` },
    );
    r = await hook("status", twilio.status(twilio.sent.at(-1)!.sid, "delivered"));
    assert.equal(r.status, 204);
    assert.equal((await deliveries(c1)).at(-1)!.status, "delivered");
    await reply(c1, "Tracking: 1Z999.");
    await drain();
    await hook("status", twilio.status(twilio.sent.at(-1)!.sid, "undelivered", "30003"));
    assert.deepEqual((await deliveries(c1)).at(-1), { ...(await deliveries(c1)).at(-1), status: "failed", error: "Not delivered (Twilio 30003)." });
    await text("+15551230000", "Hello from the US", UK);
    const cus = (await conversationOf("+15551230000"))!;
    await reply(cus, "Hi!");
    await drain();
    assert.equal(twilio.sent.at(-1)!.from, US, "a US customer is texted from the US number");

    // Limits: too long (10 segments at most) and files aren't texted; a workflow's options are written out.
    await reply(c1, "a".repeat(1600));
    await drain();
    assert.equal((await deliveries(c1)).at(-1)!.error, "Too long for a text: 11 segments (10 at most).");
    await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", c1), { type: "teammate", id: "owner" }, "attachment", "", { name: "label.pdf" }));
    await drain();
    assert.equal((await deliveries(c1)).at(-1)!.error, "Files can't be texted: send a link instead.");
    await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", c1), { type: "system", id: "workflow:x" }, "workflow_message", "How can we help?", { options: ["Track", "Return"] }));
    await drain();
    assert.equal(twilio.sent.at(-1)!.body, "How can we help?\n1) Track\n2) Return");

    // MMS: a picture scanned and published as the customer's.
    await text("+447700900456", "", UK, [["image/png", Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])]]);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM conversation_parts WHERE conversation_id=$1 AND kind='attachment' AND author_type='contact'", [c1]))[0].n, 1);

    // HELP: answered with the brand's reply (which must say how to opt out).
    assert.equal((await agent("sms-settings", { action: "help", helpReply: "Acme: we're here." })).body.error.code, "INVALID_SMS");
    await agent("sms-settings", { action: "help", helpReply: "Acme support: reply here and we'll answer. Reply STOP to opt out." });
    await text("+447700900456", "HELP");
    await drain();
    assert.equal(twilio.sent.at(-1)!.body, "Acme support: reply here and we'll answer. Reply STOP to opt out.");

    // STOP (or ARRET, STOPP…): an opt-out kept for good; nothing is texted; consent can't be recorded
    // over it; START lifts it (the record stays, lifted).
    await text("+447700900456", "Arrêt");
    const before = twilio.sent.length;
    const stopped = await reply(c1, "Sorry to see you go.");
    assert.deepEqual([stopped.status, stopped.body.error.message], [409, "This number opted out (STOP): nothing can be texted to it until it texts START."]);
    // A reply that doesn't come through the composer (Zoe's, a workflow's) is held by the gate.
    await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", c1), { type: "system", id: "workflow:x" }, "workflow_message", "Automated", {}));
    await drain();
    assert.equal((await deliveries(c1)).at(-1)!.status, "suppressed");
    assert.equal(twilio.sent.length, before);
    assert.equal((await agent("sms-settings", { action: "consent", phone: "+447700900456", note: "Phone call" })).body.error.message, "That number opted out: only the customer can opt back in, by texting START.");
    await text("+447700900456", "start");
    assert.deepEqual(await sql("a", "SELECT reason,lifted_at IS NOT NULL AS lifted,note FROM suppressions WHERE address='+447700900456'"), [{ reason: "opt_out", lifted: true, note: "Opted back in (START)." }]);
    await reply(c1, "Welcome back.");
    await drain();
    assert.equal((await deliveries(c1)).at(-1)!.status, "sent");
    // Twilio's own opt-out list (21610) suppresses too.
    twilio.reject.set("+15551230000", { code: 21610, message: "Attempt to send to unsubscribed recipient" });
    await reply(cus, "Still there?");
    await drain();
    assert.deepEqual(await sql("a", "SELECT reason FROM suppressions WHERE address='+15551230000' AND lifted_at IS NULL"), [{ reason: "opt_out" }]);

    // Consent: without it (withdrawn), nothing is texted.
    await sql("a", "UPDATE sms_consents SET revoked_at=now() WHERE phone='+447700900456'");
    const unconsented = await reply(c1, "Without consent");
    assert.deepEqual([unconsented.status, unconsented.body.error.message], [409, "This number hasn't agreed to texts: record their consent first."]);
    assert.equal((await agent("sms-settings", { action: "consent", phone: "+44 7700 900456", note: "Signup form" })).status, 200);
    assert.equal((await agent("sms-settings", undefined, "owner-b", "b")).body.consents.length, 0, "another workspace's consents are its own");

    // The rollback: the flag off, the webhook refuses, unsent texts fail.
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "reply", conversationId: c1, text: "Queued at rollback" }));
    const rollback = readFileSync("db/rollback/0067_sms.sql", "utf8");
    for (const statement of rollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await sql("a", statement);
    assert.equal((await deliveries(c1)).at(-1)!.error, "Stopped by rollback.");
    assert.equal((await text("+447700900456", "After")).status, 404);
  } finally {
    await db.close();
  }
});
