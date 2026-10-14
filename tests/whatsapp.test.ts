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
import { checkWhatsAppNumberJob, receiveWhatsAppJob, submitTemplateJob, syncTemplatesJob, whatsappChannel, whatsappClock, type WhatsAppEnvironment } from "../server/whatsapp";
import { localAttachmentStorage } from "../scripts/local-storage";
import { LOCAL_WHATSAPP, localWhatsApp } from "../scripts/local-whatsapp";

/**
 * WhatsApp Business (phase 12, E5; docs/OMNICHANNEL_STEP5.md): a number connected and checked,
 * Meta's webhook set up and signed, messages in (text, buttons, media) and out (text, buttons,
 * files, templates), receipts, the 24-hour window, templates and their review, opt-ins and STOP.
 */
test("WhatsApp: a number connected, the webhook signed, messages both ways, receipts, the window, templates and opt-ins", async () => {
  const db = await testDatabase();
  const storage = localAttachmentStorage().storage;
  const meta = localWhatsApp();
  const key = "k".repeat(40);
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    attachments: storage,
    connectors: { key },
    whatsapp: { api: meta.api },
  };
  const wa: WhatsAppEnvironment = { api: meta.api, key, storage };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "whatsapp.receive": (j: Job) => receiveWhatsAppJob(db.connect, wa, j),
    "whatsapp.check": (j: Job) => checkWhatsAppNumberJob(db.connect, wa, j),
    "whatsapp.template": (j: Job) => submitTemplateJob(db.connect, wa, j),
    "whatsapp.sync": (j: Job) => syncTemplatesJob(db.connect, wa, j),
    "attachment.scan": (j: Job) => attachmentScan(db.connect, storage, j),
    "channel.deliver": (j: Job) => runDelivery(db.connect, { providers: { whatsapp: wa } }, j),
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
        RELAY_API_ORIGIN: "https://relay.test",
        RELAY_WORKSPACE_ID: workspace,
        RELAY_BRIDGE_SECRET: env.bridgeSecret,
      },
      (r) => handleApi(r, env),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const hook = async (payload: unknown, w = "a", secret = LOCAL_WHATSAPP.appSecret) => {
    const call = await meta.signed(payload, secret);
    const r = await handleApi(new Request(`https://relay.test/v1/hooks/whatsapp/${w}`, { method: "POST", headers: { "x-hub-signature-256": call.signature }, body: call.body }), env);
    await drain(w);
    return r;
  };
  const say = (from: string, message: Record<string, unknown>, name = "Ada") => hook(meta.message({ from, name, message }));
  const text = (body: string) => ({ type: "text", text: { body } });
  const reply = (conversationId: string, data: Record<string, unknown>) => agent("command", { action: "reply", conversationId, ...data });
  const latest = async () => (await sql<{ id: string }>("a", "SELECT id FROM conversations ORDER BY created_at DESC LIMIT 1"))[0].id;
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
      );
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE name IN ('channels_v1','channel_whatsapp_v1','workflows_v1')");
    }
    whatsappClock.now = () => Date.now();

    // Connecting: bad details refused; the credentials sealed (only the token's last four shown);
    // Meta's check connects it, or says why not.
    assert.equal((await agent("whatsapp-settings", { action: "connect", brandId: "default", phoneNumberId: "abc", wabaId: "1", token: "x", appSecret: "y" })).body.error.code, "INVALID_WHATSAPP");
    const connected = await agent("whatsapp-settings", {
      action: "connect",
      brandId: "default",
      phoneNumberId: LOCAL_WHATSAPP.phoneNumberId,
      wabaId: LOCAL_WHATSAPP.wabaId,
      token: LOCAL_WHATSAPP.token,
      appSecret: LOCAL_WHATSAPP.appSecret,
    });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    assert.doesNotMatch(JSON.stringify(connected.body), new RegExp(LOCAL_WHATSAPP.token + "|" + LOCAL_WHATSAPP.appSecret));
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM whatsapp_numbers WHERE token_sealed LIKE $1", ["%" + LOCAL_WHATSAPP.token + "%"]))[0].n, 0);
    await drain();
    let settings = (await agent("whatsapp-settings")).body;
    const number = settings.numbers[0];
    assert.deepEqual([number.status, number.displayNumber, number.verifiedName, number.tokenHint], ["connected", "+44 7700 900123", "Relay Demo", LOCAL_WHATSAPP.token.slice(-4)]);
    assert.equal(number.webhook.url, "https://relay.test/v1/hooks/whatsapp/a");
    assert.equal((await agent("whatsapp-settings", undefined, "owner-b", "b")).body.numbers.length, 0, "another workspace's numbers are its own");
    await agent("whatsapp-settings", { action: "connect", brandId: "default", phoneNumberId: "100000000000009", wabaId: "200000000009", token: "a-wrong-token-for-the-stand-in", appSecret: "f".repeat(32) }, "owner-b", "b");
    await drain("b");
    const refused = (await agent("whatsapp-settings", undefined, "owner-b", "b")).body.numbers[0];
    assert.deepEqual([refused.status, refused.error], ["failed", "Meta refused: Invalid OAuth access token."]);

    // The webhook: Meta's set-up check answered for the verify token; calls without the app
    // secret's signature refused; another workspace's secret doesn't sign for this one.
    const verify = (token: string, w = "a") => handleApi(new Request(`https://relay.test/v1/hooks/whatsapp/${w}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=12345`), env);
    let r = await verify(number.webhook.verifyToken);
    assert.deepEqual([r.status, await r.text()], [200, "12345"]);
    assert.equal((await verify("wrong")).status, 403);
    assert.equal((await verify(number.webhook.verifyToken, "b")).status, 403);
    r = await hook(meta.message({ from: "447700900456", message: text("Forged") }), "a", "f".repeat(32));
    assert.equal(r.status, 403);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM whatsapp_inbound"))[0].n, 0);

    // A message in: a conversation on WhatsApp, the number verified (Meta vouches), an opt-in
    // recorded; the next message joins it.
    r = await say("447700900456", text("Hi, where is my order?"));
    assert.equal(r.status, 200);
    const c1 = await latest();
    assert.deepEqual(
      await sql("a", "SELECT p.body,p.channel,c.current_channel FROM conversation_parts p JOIN conversations c ON c.workspace_id=p.workspace_id AND c.id=p.conversation_id WHERE p.conversation_id=$1 AND p.kind='customer_message'", [c1]),
      [{ body: "Hi, where is my order?", channel: "whatsapp", current_channel: "whatsapp" }],
    );
    assert.deepEqual(await sql("a", "SELECT address,verified FROM identity_addresses WHERE channel='whatsapp'"), [{ address: "+447700900456", verified: true }]);
    assert.deepEqual((await agent("whatsapp-settings")).body.optIns.map((o: { phone: string; source: string }) => [o.phone, o.source]), [["+447700900456", "customer_message"]]);
    await say("447700900456", { type: "interactive", interactive: { type: "button_reply", button_reply: { id: "option-0", title: "Track it" } } });
    assert.equal(await latest(), c1, "threaded by number");
    assert.equal((await sql("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='customer_message' ORDER BY seq DESC LIMIT 1", [c1]))[0].body, "Track it");

    // Replies in the window: text to the number's digits; receipts move it forward; a failure says why.
    const target = (await agent(`reply-target?conversation=${c1}`)).body.target;
    assert.deepEqual([target.channel, target.address, target.window.open, target.templates], ["whatsapp", "+447700900456", true, []]);
    assert.equal((await reply(c1, { text: "It ships today." })).status, 200);
    await drain();
    assert.deepEqual(meta.sent.at(-1)!.message, { messaging_product: "whatsapp", recipient_type: "individual", to: "447700900456", type: "text", text: { body: "It ships today.", preview_url: true } });
    const wamid = meta.sent.at(-1)!.messageId;
    await hook(meta.status(wamid, "delivered"));
    await hook(meta.status(wamid, "read"));
    await hook(meta.status(wamid, "delivered"));
    const deliveries = async (c: string) => (await agent(`deliveries?conversation=${c}`)).body.deliveries as { status: string; error: string }[];
    assert.equal((await deliveries(c1)).at(-1)!.status, "read", "a late delivered never undoes read");
    meta.reject.set("447700900456", { code: 131026, message: "Message undeliverable." });
    await reply(c1, { text: "Are you there?" });
    await drain();
    assert.deepEqual((await deliveries(c1)).at(-1), { ...(await deliveries(c1)).at(-1), status: "failed", error: "Message undeliverable." });
    meta.reject.clear();

    // Buttons: three as reply buttons, a workflow's message through the adapter.
    await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", c1), { type: "system", id: "workflow:x" }, "workflow_message", "How can we help?", { options: ["Track", "Return", "Other"] }));
    await drain();
    assert.deepEqual((meta.sent.at(-1)!.message.interactive as { action: { buttons: { reply: { title: string } }[] } }).action.buttons.map((b) => b.reply.title), ["Track", "Return", "Other"]);

    // Media in: an image downloaded with the number's token, scanned and published.
    const image = meta.addMedia(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]), "image/png");
    await say("447700900456", { type: "image", image: { id: image, mime_type: "image/png", caption: "The box" } });
    const files = await sql("a", "SELECT kind,data->>'name' AS name FROM conversation_parts WHERE conversation_id=$1 AND kind='attachment'", [c1]);
    assert.equal(files.length, 1);
    assert.equal((await sql("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='customer_message' ORDER BY seq DESC LIMIT 1", [c1]))[0].body, "The box");

    // Templates: submitted for review (refused when malformed), approved by Meta's webhook, synced.
    assert.equal((await agent("whatsapp-settings", { action: "template", numberId: number.id, name: "Order Update", language: "en", category: "utility", body: "x", examples: [] })).body.error.code, "INVALID_WHATSAPP");
    assert.match(
      (await agent("whatsapp-settings", { action: "template", numberId: number.id, name: "order_update", language: "en", category: "utility", body: "Hi {{1}}, order {{3}}", examples: ["Ada", "#1"] })).body.error.message,
      /\{\{1\}\}, \{\{2\}\}/,
    );
    const made = await agent("whatsapp-settings", {
      action: "template",
      numberId: number.id,
      name: "order_update",
      language: "en",
      category: "utility",
      body: "Hi {{1}}, your order {{2}} has shipped.",
      examples: ["Ada", "#4411"],
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    await drain();
    settings = (await agent("whatsapp-settings")).body;
    assert.deepEqual(settings.templates.map((t: { name: string; status: string; params: number }) => [t.name, t.status, t.params]), [["order_update", "pending", 2]]);
    assert.deepEqual(meta.templates[0].draft, { name: "order_update", language: "en", category: "utility", body: "Hi {{1}}, your order {{2}} has shipped.", examples: ["Ada", "#4411"] });
    await hook(meta.review(meta.templates[0].id, "APPROVED"));
    assert.equal((await agent("whatsapp-settings")).body.templates[0].status, "approved");
    await agent("whatsapp-settings", { action: "template", numberId: number.id, name: "promo", language: "en", category: "marketing", body: "Sale!", examples: [] });
    await drain();
    meta.templates[1].status = "REJECTED";
    await agent("whatsapp-settings", { action: "sync", numberId: number.id });
    await drain();
    assert.deepEqual(
      (await agent("whatsapp-settings")).body.templates.map((t: { name: string; status: string }) => [t.name, t.status]),
      [
        ["order_update", "approved"],
        ["promo", "rejected"],
      ],
    );

    // The window: 25 hours on, a free reply is refused at once; Zoe's reply isn't sent; an approved
    // template goes (its values filled in), to a number that opted in.
    whatsappClock.now = () => Date.now() + 25 * 3_600_000;
    const closed = (await agent(`reply-target?conversation=${c1}`)).body.target;
    assert.equal(closed.window.open, false);
    assert.deepEqual(closed.templates.map((t: { name: string }) => t.name), ["order_update"]);
    const late = await reply(c1, { text: "Still there?" });
    assert.deepEqual([late.status, late.body.error.message], [409, "The 24-hour window has closed: send an approved template instead."]);
    await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", c1), { type: "ai", id: "default" }, "ai_reply", "Zoe, late", {}));
    await drain();
    assert.equal((await deliveries(c1)).at(-1)!.error, "The 24-hour window has closed: send an approved template instead.");
    const tplId = closed.templates[0].id;
    assert.equal((await reply(c1, { template: { id: tplId, params: ["Ada"] } })).body.error.code, "INVALID_TEMPLATE");
    assert.equal((await reply(c1, { template: { id: tplId, params: ["Ada", "#4411\nmore"] } })).body.error.code, "INVALID_TEMPLATE");
    const sentTpl = await reply(c1, { template: { id: tplId, params: ["Ada", "#4411"] } });
    assert.equal(sentTpl.status, 200, JSON.stringify(sentTpl.body));
    await drain();
    assert.equal((await sql("a", "SELECT body FROM conversation_parts WHERE id=$1", [sentTpl.body.partId]))[0].body, "Hi Ada, your order #4411 has shipped.");
    assert.deepEqual(meta.sent.at(-1)!.message.template, {
      name: "order_update",
      language: { code: "en" },
      components: [{ type: "body", parameters: [{ type: "text", text: "Ada" }, { type: "text", text: "#4411" }] }],
    });
    whatsappClock.now = () => Date.now();

    // STOP: the number is suppressed (an opt-out), nothing is sent, not even a template; a teammate
    // can't record consent over it; START opts back in.
    await say("447700900456", text("STOP"));
    const before = meta.sent.length;
    await reply(c1, { text: "Sorry to see you go." });
    await drain();
    assert.equal((await deliveries(c1)).at(-1)!.status, "suppressed");
    assert.equal(meta.sent.length, before);
    assert.equal((await agent("whatsapp-settings", { action: "opt_in", phone: "+447700900456", note: "Phone call" })).body.error.message, "That number opted out: only the customer can opt back in, by sending START.");
    await say("447700900456", text("START"));
    assert.deepEqual(await sql("a", "SELECT reason FROM suppressions WHERE address='+447700900456' AND lifted_at IS NULL"), []);
    await reply(c1, { text: "Welcome back." });
    await drain();
    assert.equal((await deliveries(c1)).at(-1)!.status, "sent");

    // A recorded opt-in lets a template go to a number that never wrote (once there's a conversation).
    assert.equal((await agent("whatsapp-settings", { action: "opt_in", phone: "not a phone", note: "x" })).body.error.code, "INVALID_WHATSAPP");
    assert.equal((await agent("whatsapp-settings", { action: "opt_in", phone: "+44 7700 900999", note: "Checkout form" })).status, 200);
    assert.deepEqual(whatsappChannel.address("+44 (7700) 900-999"), "+447700900999");

    // The rollback: the flag off, the webhook refuses, unsent deliveries fail.
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "reply", conversationId: c1, text: "Queued at rollback" }));
    const rollback = readFileSync("db/rollback/0066_whatsapp.sql", "utf8");
    for (const statement of rollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await sql("a", statement);
    assert.equal((await deliveries(c1)).at(-1)!.error, "Stopped by rollback.");
    assert.equal((await hook(meta.message({ from: "447700900456", message: text("After") }))).status, 404);
  } finally {
    whatsappClock.now = () => Date.now();
    await db.close();
  }
});
