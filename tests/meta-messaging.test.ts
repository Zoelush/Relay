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
import { checkMetaPageJob, metaClock, receiveMetaJob, type MetaEnvironment } from "../server/meta-messaging";
import { localAttachmentStorage } from "../scripts/local-storage";
import { LOCAL_META, localMeta } from "../scripts/local-meta";

/**
 * Instagram and Facebook Messenger (phase 12, E7; docs/OMNICHANNEL_STEP7.md): a Page connected
 * with its Instagram account, Meta's signed webhook, messages both ways on both platforms (story
 * replies and mentions, quick replies, files from Meta's CDN), receipts, echoes, and the windows:
 * 24 hours for anything, 7 days for a teammate (HUMAN_AGENT), then nothing.
 */
test("Instagram and Facebook: a Page connected, the webhook signed, messages both ways, stories, receipts and the windows", async () => {
  const db = await testDatabase();
  const storage = localAttachmentStorage().storage;
  const meta = localMeta();
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
  };
  const metaEnv: MetaEnvironment = { api: meta.api, key, storage };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "meta.receive": (j: Job) => receiveMetaJob(db.connect, metaEnv, j),
    "meta.check": (j: Job) => checkMetaPageJob(db.connect, metaEnv, j),
    "attachment.scan": (j: Job) => attachmentScan(db.connect, storage, j),
    "channel.deliver": (j: Job) => runDelivery(db.connect, { providers: { meta: metaEnv } }, j),
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
  const hook = async (payload: unknown, w = "a", secret = LOCAL_META.appSecret) => {
    const call = await meta.signed(payload, secret);
    const r = await handleApi(new Request(`https://relay.test/v1/hooks/meta/${w}`, { method: "POST", headers: { "x-hub-signature-256": call.signature }, body: call.body }), env);
    await drain(w);
    return r;
  };
  const say = (platform: "facebook" | "instagram", from: string, message: Record<string, unknown>, mid?: string) => hook(meta.message(platform, from, message, mid));
  const conversationOf = async (from: string, channel: string) =>
    (
      await sql<{ conversation_id: string }>(
        "a",
        "SELECT p.conversation_id FROM conversation_parts p JOIN identity_addresses x ON x.workspace_id=p.workspace_id AND x.identity_id=p.author_id WHERE x.address=$1 AND x.channel=$2 ORDER BY p.created_at DESC LIMIT 1",
        [from, channel],
      )
    )[0]?.conversation_id;
  const reply = (c: string, text: string) => agent("command", { action: "reply", conversationId: c, text });
  const deliveries = async (c: string) => (await agent(`deliveries?conversation=${c}`)).body.deliveries as { status: string; error: string }[];
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
      );
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE name IN ('channels_v1','channel_facebook_v1','channel_instagram_v1')");
    }
    metaClock.now = () => Date.now();

    // Connecting: bad details refused; sealed; Meta's check finds the Page and its Instagram account.
    assert.equal((await agent("meta-settings", { action: "connect", brandId: "default", pageId: "x", token: "t", appSecret: "s" })).body.error.code, "INVALID_META");
    const connected = await agent("meta-settings", { action: "connect", brandId: "default", pageId: LOCAL_META.pageId, token: LOCAL_META.token, appSecret: LOCAL_META.appSecret });
    assert.equal(connected.status, 200, JSON.stringify(connected.body));
    assert.doesNotMatch(JSON.stringify(connected.body), new RegExp(LOCAL_META.token + "|" + LOCAL_META.appSecret));
    await drain();
    const page = (await agent("meta-settings")).body.pages[0];
    assert.deepEqual([page.status, page.pageName, page.instagram], ["connected", "Relay Demo", { id: LOCAL_META.igAccountId, username: "relay.demo" }]);
    await agent("meta-settings", { action: "connect", brandId: "default", pageId: "300000000000009", token: "a-token-meta-refuses-0000000", appSecret: "a".repeat(32) }, "owner-b", "b");
    await drain("b");
    const refused = (await agent("meta-settings", undefined, "owner-b", "b")).body.pages[0];
    assert.deepEqual([refused.status, refused.error], ["failed", "Meta refused: Invalid OAuth access token."]);

    // The webhook: the verify token answered; a forged signature refused with nothing kept.
    let r = await handleApi(new Request(`https://relay.test/v1/hooks/meta/a?hub.mode=subscribe&hub.verify_token=${page.webhook.verifyToken}&hub.challenge=777`), env);
    assert.deepEqual([r.status, await r.text()], [200, "777"]);
    assert.equal((await handleApi(new Request("https://relay.test/v1/hooks/meta/a?hub.mode=subscribe&hub.verify_token=no&hub.challenge=1"), env)).status, 403);
    assert.equal((await hook(meta.message("facebook", "7000001", { text: "Forged" }), "a", "0".repeat(32))).status, 403);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM meta_inbound"))[0].n, 0);

    // Messenger in: a conversation on Facebook Messenger, the person named, their id verified; the
    // next message joins it; the Page's own echo is ignored.
    meta.people.set("7000001", "Ada Lovelace");
    r = await say("facebook", "7000001", { text: "Hi, where's my order?" });
    assert.equal(r.status, 200);
    const fb = (await conversationOf("7000001", "facebook"))!;
    assert.deepEqual(await sql("a", "SELECT address,verified FROM identity_addresses WHERE channel='facebook'"), [{ address: "7000001", verified: true }]);
    assert.equal((await sql("a", "SELECT c.name FROM conversations v JOIN identity_contact_mappings m ON m.workspace_id=v.workspace_id AND m.identity_id=v.primary_identity_id JOIN contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id WHERE v.id=$1", [fb]))[0].name, "Ada Lovelace");
    await say("facebook", "7000001", { text: "Order 4411", quick_reply: { payload: "x" } });
    assert.equal(await conversationOf("7000001", "facebook"), fb);
    await say("facebook", "7000001", { text: "Sent from the Page", is_echo: true });
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM conversation_parts WHERE conversation_id=$1 AND kind='customer_message'", [fb]))[0].n, 2);

    // Instagram in: its own conversation; a story reply and a story mention carry the story's link.
    await say("instagram", "17841400000000002", { text: "Love it!", reply_to: { story: { url: "https://lookaside.fbsbx.com/story/1", id: "s1" } } });
    const ig = (await conversationOf("17841400000000002", "instagram"))!;
    assert.notEqual(ig, fb);
    await say("instagram", "17841400000000002", { attachments: [{ type: "story_mention", payload: { url: "https://lookaside.fbsbx.com/story/2" } }] });
    assert.deepEqual(
      await sql("a", "SELECT body,data->'story' AS story FROM conversation_parts WHERE conversation_id=$1 AND kind='customer_message' ORDER BY seq", [ig]),
      [
        { body: "Replied to your story: Love it!", story: { url: "https://lookaside.fbsbx.com/story/1", kind: "reply" } },
        { body: "Mentioned you in their story", story: { url: "https://lookaside.fbsbx.com/story/2", kind: "mention" } },
      ],
    );

    // Files in: from Meta's CDN, scanned and published; anywhere else, not fetched.
    const png = meta.addFile(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]), "image/png");
    await say("facebook", "7000001", { attachments: [{ type: "image", payload: { url: png } }, { type: "image", payload: { url: "https://evil.example/x.png" } }] });
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM conversation_parts WHERE conversation_id=$1 AND kind='attachment'", [fb]))[0].n, 1);
    assert.equal((await sql("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='customer_message' ORDER BY seq DESC LIMIT 1", [fb]))[0].body, "[2 attachments]");

    // Replies in the window: a response; options as quick replies; delivered and read come back.
    assert.equal((await reply(fb, "It ships today.")).status, 200);
    await drain();
    assert.deepEqual(meta.sent.at(-1)!.body, { recipient: { id: "7000001" }, messaging_type: "RESPONSE", message: { text: "It ships today." } });
    assert.equal(meta.sent.at(-1)!.pageId, LOCAL_META.pageId);
    const first = meta.sent.at(-1)!.messageId;
    await hook(meta.receipt("facebook", "7000001", { delivery: { mids: [first] } }));
    assert.equal((await deliveries(fb)).at(-1)!.status, "delivered");
    await hook(meta.receipt("facebook", "7000001", { read: { watermark: Date.now() + 1000 } }));
    assert.equal((await deliveries(fb)).at(-1)!.status, "read", "everything before the watermark is read");
    await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", ig), { type: "system", id: "workflow:x" }, "workflow_message", "How can we help?", { options: ["Track", "Return"] }));
    await drain();
    assert.deepEqual(meta.sent.at(-1)!.body.message, {
      text: "How can we help?",
      quick_replies: [
        { content_type: "text", title: "Track", payload: "option-0" },
        { content_type: "text", title: "Return", payload: "option-1" },
      ],
    });
    await hook(meta.receipt("instagram", "17841400000000002", { read: { mid: meta.sent.at(-1)!.messageId } }));
    assert.equal((await deliveries(ig)).at(-1)!.status, "read");

    // Files out: a picture by a short-lived signed link; a document refused on Instagram.
    const fileId = crypto.randomUUID();
    await storage.putClean(`a/${fileId}/clean`, Uint8Array.from([137, 80, 78, 71]), "image/png", "box.png");
    await sql("a", "INSERT INTO attachments(workspace_id,id,conversation_id,object_key,name,size,mime,status,clean_key,audience,purpose) VALUES('a',$1,$2,$3,'box.png',4,'image/png','clean',$4,'customer_visible','part')", [
      fileId,
      fb,
      `a/${fileId}/q`,
      `a/${fileId}/clean`,
    ]);
    await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", fb), { type: "teammate", id: "owner" }, "attachment", "", { attachmentId: fileId, name: "box.png" }));
    await drain();
    const att = meta.sent.at(-1)!.body.message as { attachment: { type: string; payload: { url: string; is_reusable: boolean } } };
    assert.equal(att.attachment.type, "image");
    assert.ok(att.attachment.payload.url.length > 0);
    const pdfId = crypto.randomUUID();
    await storage.putClean(`a/${pdfId}/clean`, new TextEncoder().encode("%PDF-1.4"), "application/pdf", "label.pdf");
    await sql("a", "INSERT INTO attachments(workspace_id,id,conversation_id,object_key,name,size,mime,status,clean_key,audience,purpose) VALUES('a',$1,$2,$3,'label.pdf',8,'application/pdf','clean',$4,'customer_visible','part')", [
      pdfId,
      ig,
      `a/${pdfId}/q`,
      `a/${pdfId}/clean`,
    ]);
    await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", ig), { type: "teammate", id: "owner" }, "attachment", "", { attachmentId: pdfId, name: "label.pdf" }));
    await drain();
    assert.equal((await deliveries(ig)).at(-1)!.error, "Instagram takes pictures, video and audio, not documents: send a link instead.");

    // Meta refusing a send says why, without retrying.
    meta.reject.set("7000001", { code: 551, message: "This person isn't available right now." });
    await reply(fb, "Hello?");
    await drain();
    assert.equal((await deliveries(fb)).at(-1)!.error, "This person isn't available right now.");
    meta.reject.clear();

    // The windows. 25 hours on: a teammate's reply goes, tagged HUMAN_AGENT; Zoe's and a workflow's
    // don't. 8 days on: nothing, and the composer says so.
    metaClock.now = () => Date.now() + 25 * 3_600_000;
    let target = (await agent(`reply-target?conversation=${fb}`)).body.target;
    assert.equal(target.window.open, false);
    assert.match(target.windowNote, /^Messenger's 24-hour window has closed: you can still reply until .+ UTC \(as a person, not automation\)\.$/);
    assert.equal((await reply(fb, "Following up as a person.")).status, 200);
    await drain();
    assert.deepEqual(meta.sent.at(-1)!.body, { recipient: { id: "7000001" }, messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT", message: { text: "Following up as a person." } });
    await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", fb), { type: "ai", id: "default" }, "ai_reply", "Zoe, late", {}));
    await drain();
    assert.equal((await deliveries(fb)).at(-1)!.error, "Messenger's 24-hour window has closed: only a teammate can reply now (until 7 days after their last message).");
    metaClock.now = () => Date.now() + 8 * 86_400_000;
    const late = await reply(fb, "Too late?");
    assert.deepEqual([late.status, late.body.error.message], [409, "Messenger's 7-day window has closed: they need to message you first."]);
    target = (await agent(`reply-target?conversation=${ig}`)).body.target;
    assert.equal(target.windowNote, "Instagram's 7-day window has closed: they need to message you first.");
    metaClock.now = () => Date.now();

    // The rollback: the flags off, the webhook refuses, unsent replies fail.
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "reply", conversationId: fb, text: "Queued at rollback" }));
    const rollback = readFileSync("db/rollback/0068_meta_messaging.sql", "utf8");
    for (const statement of rollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await sql("a", statement);
    assert.equal((await deliveries(fb)).at(-1)!.error, "Stopped by rollback.");
    assert.equal((await say("facebook", "7000001", { text: "After" })).status, 404);
  } finally {
    metaClock.now = () => Date.now();
    await db.close();
  }
});
