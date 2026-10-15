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
import { checkCommunityJob, DISCORD_INTENTS, DiscordGatewaySession, discordConnections, ingestDiscordMessage, receiveCommunityJob, type CommunityEnvironment } from "../server/community";
import { localAttachmentStorage } from "../scripts/local-storage";
import { LOCAL_DISCORD, LOCAL_SLACK, localCommunity } from "../scripts/local-community";

/**
 * Slack and Discord (phase 12, E8; docs/OMNICHANNEL_STEP8.md): Discord's gateway protocol (apart
 * from any socket), Slack's signed Events API, and both platforms' messages into conversations by
 * thread, with replies back into it.
 */
test("Discord's gateway: identify, heartbeat, dispatch, resume after a reconnect, start over after an invalid session", async () => {
  const dispatched: [string, Record<string, unknown>][] = [];
  const s = new DiscordGatewaySession("bot-token", (t, d) => void dispatched.push([t, d]));
  const socket = () => {
    const sock = { sent: [] as Record<string, unknown>[], closed: null as number | null, send: (x: string) => sock.sent.push(JSON.parse(x)), close: (c?: number) => void (sock.closed = c ?? 1000) };
    return sock;
  };
  let sock = socket();
  s.attach(sock);
  assert.equal(s.url(), "wss://gateway.discord.gg/?v=10&encoding=json");
  await s.receive(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));
  assert.equal(s.heartbeatMs, 41250);
  assert.deepEqual(sock.sent[0], { op: 2, d: { token: "bot-token", intents: DISCORD_INTENTS, properties: { os: "linux", browser: "relay", device: "relay" } } });
  assert.equal(DISCORD_INTENTS, 512 + 4096 + 32768, "guild messages, direct messages, message content");
  await s.receive(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "sess-1", resume_gateway_url: "wss://gateway-us-east1-b.discord.gg" } }));
  await s.receive(JSON.stringify({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { id: "m1", content: "hi" } }));
  assert.deepEqual(dispatched.map(([t]) => t), ["READY", "MESSAGE_CREATE"]);
  assert.equal(s.seq, 2);
  // Heartbeats carry the last sequence; a missing ACK closes the zombie connection.
  s.beat();
  assert.deepEqual(sock.sent.at(-1), { op: 1, d: 2 });
  await s.receive(JSON.stringify({ op: 11 }));
  s.beat();
  s.beat();
  assert.equal(sock.closed, 4000);
  // Reconnecting resumes the session where it left off, at Discord's resume address.
  assert.equal(s.url(), "wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json");
  sock = socket();
  s.attach(sock);
  await s.receive(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));
  assert.deepEqual(sock.sent[0], { op: 6, d: { token: "bot-token", session_id: "sess-1", seq: 2 } });
  // Discord asking for a heartbeat gets one; RECONNECT closes for a resume.
  await s.receive(JSON.stringify({ op: 1 }));
  assert.deepEqual(sock.sent.at(-1), { op: 1, d: 2 });
  await s.receive(JSON.stringify({ op: 7 }));
  assert.equal(sock.closed, 4000);
  // An invalid session that can't be resumed starts over: identify, not resume.
  sock = socket();
  s.attach(sock);
  await s.receive(JSON.stringify({ op: 9, d: false }));
  assert.equal(sock.closed, 4000);
  assert.deepEqual([s.sessionId, s.seq, s.url()], [null, null, "wss://gateway.discord.gg/?v=10&encoding=json"]);
  sock = socket();
  s.attach(sock);
  await s.receive(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));
  assert.equal(sock.sent[0].op, 2);
});

test("Slack and Discord: connected, Slack's events signed and once each, messages by thread, replies back into it", async () => {
  const db = await testDatabase();
  const storage = localAttachmentStorage().storage;
  const stand = localCommunity();
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
  const cenv: CommunityEnvironment = { slack: stand.slack, discord: stand.discord, key, storage };
  const gateways: string[] = [];
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "community.receive": (j: Job) => receiveCommunityJob(db.connect, cenv, j),
    "community.check": (j: Job) => checkCommunityJob(db.connect, cenv, j, async (w, id) => void gateways.push(`${w}:${id}`)),
    "attachment.scan": (j: Job) => attachmentScan(db.connect, storage, j),
    "channel.deliver": (j: Job) => runDelivery(db.connect, { providers: { community: cenv } }, j),
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
  const slackHook = async (payload: unknown, o: { secret?: string; at?: number; w?: string } = {}) => {
    const call = await stand.slackSigned(payload, o.secret, o.at);
    const r = await handleApi(
      new Request(`https://relay.test/v1/hooks/slack/${o.w ?? "a"}`, { method: "POST", headers: { "x-slack-request-timestamp": call.timestamp, "x-slack-signature": call.signature }, body: call.body }),
      env,
    );
    await drain(o.w ?? "a");
    return r;
  };
  const conversationOf = async (address: string, channel: string) =>
    (
      await sql<{ conversation_id: string }>(
        "a",
        "SELECT p.conversation_id FROM conversation_parts p JOIN identity_addresses x ON x.workspace_id=p.workspace_id AND x.identity_id=p.author_id WHERE x.address=$1 AND x.channel=$2 ORDER BY p.created_at DESC LIMIT 1",
        [address, channel],
      )
    )[0]?.conversation_id;
  const reply = (c: string, text: string) => agent("command", { action: "reply", conversationId: c, text });
  const deliveries = async (c: string) => (await agent(`deliveries?conversation=${c}`)).body.deliveries as { status: string; error: string }[];
  const count = async (c: string) => (await sql("a", "SELECT count(*)::int AS n FROM conversation_parts WHERE conversation_id=$1 AND kind='customer_message'", [c]))[0].n;
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
      );
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE name IN ('channels_v1','channel_slack_v1','channel_discord_v1')");
    }

    // Connecting: bad tokens refused; Slack's team and Discord's bot found; Discord's gateway started.
    assert.equal((await agent("community-settings", { action: "connect", platform: "slack", brandId: "default", token: "nope", signingSecret: "x" })).body.error.code, "INVALID_COMMUNITY");
    assert.equal((await agent("community-settings", { action: "connect", platform: "slack", brandId: "default", token: LOCAL_SLACK.token, signingSecret: LOCAL_SLACK.signingSecret })).status, 200);
    assert.equal((await agent("community-settings", { action: "connect", platform: "discord", brandId: "default", token: LOCAL_DISCORD.token })).status, 200);
    await drain();
    const settings = (await agent("community-settings")).body;
    assert.deepEqual(
      settings.connections.map((c: { platform: string; status: string; externalId: string; name: string }) => [c.platform, c.status, c.externalId, c.name]),
      [
        ["slack", "connected", LOCAL_SLACK.teamId, LOCAL_SLACK.team],
        ["discord", "connected", LOCAL_DISCORD.botId, LOCAL_DISCORD.username],
      ],
    );
    assert.doesNotMatch(JSON.stringify(settings), new RegExp(LOCAL_SLACK.token + "|" + LOCAL_SLACK.signingSecret + "|" + LOCAL_DISCORD.token.replace(/\./g, "\\.")));
    const discordId = settings.connections[1].id;
    assert.deepEqual(gateways, [`a:${discordId}`]);
    assert.deepEqual(await discordConnections(db.connect, "a"), [discordId]);
    await agent("community-settings", { action: "connect", platform: "slack", brandId: "default", token: LOCAL_SLACK.token, signingSecret: LOCAL_SLACK.signingSecret });
    await drain();
    assert.equal((await agent("community-settings")).body.connections[2].error, "That workspace or server is already connected.");
    assert.equal((await agent("community-settings", undefined, "owner-b", "b")).body.connections.length, 0);

    // Slack's URL check; signatures, a stale timestamp, another team, another workspace refused.
    let r = await slackHook({ type: "url_verification", challenge: "abc123" });
    assert.deepEqual([r.status, await r.json()], [200, { challenge: "abc123" }]);
    assert.equal((await slackHook(stand.slackMessage({ channel: "C0SUPPORT", user: "U0ADA", text: "Forged" }), { secret: "f".repeat(32) })).status, 403);
    assert.equal((await slackHook(stand.slackMessage({ channel: "C0SUPPORT", user: "U0ADA", text: "Replayed" }), { at: Math.floor(Date.now() / 1000) - 600 })).status, 403);
    assert.equal((await slackHook({ ...stand.slackMessage({ channel: "C0SUPPORT", user: "U0ADA", text: "Other team" }), team_id: "T0OTHER" })).status, 403);
    assert.equal((await slackHook(stand.slackMessage({ channel: "C0SUPPORT", user: "U0ADA", text: "To b" }), { w: "b" })).status, 403);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM community_inbound"))[0].n, 0);

    // A Slack message starts a conversation (named, the account verified); its thread joins it; a
    // new top-level message is a new one; bots and edits are ignored; a retried event counts once.
    stand.people.set("U0ADA", "Ada");
    const root = stand.slackMessage({ channel: "C0SUPPORT", user: "U0ADA", text: "Is the API down?" });
    r = await slackHook(root);
    assert.equal(r.status, 200);
    await slackHook(root);
    const s1 = (await conversationOf(`${LOCAL_SLACK.teamId}:U0ADA`, "slack"))!;
    assert.equal(await count(s1), 1, "a retried event counts once");
    assert.deepEqual(await sql("a", "SELECT address,verified FROM identity_addresses WHERE channel='slack'"), [{ address: `${LOCAL_SLACK.teamId}:U0ADA`, verified: true }]);
    await slackHook(stand.slackMessage({ channel: "C0SUPPORT", user: "U0ADA", text: "It's back now", thread_ts: root.event.ts }));
    assert.equal(await conversationOf(`${LOCAL_SLACK.teamId}:U0ADA`, "slack"), s1);
    assert.equal(await count(s1), 2);
    await slackHook(stand.slackMessage({ channel: "C0SUPPORT", user: "U0BOB", text: "Bot says hi", bot_id: "B01" }));
    await slackHook(stand.slackMessage({ channel: "C0SUPPORT", user: "U0ADA", text: "edited", subtype: "message_changed" }));
    await slackHook(stand.slackMessage({ channel: "C0SUPPORT", user: LOCAL_SLACK.botUserId, text: "Our own" }));
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM conversation_parts WHERE body IN ('Bot says hi','edited','Our own')"))[0].n, 0);
    await slackHook(stand.slackMessage({ channel: "C0SUPPORT", user: "U0ADA", text: "Another question" }));
    assert.notEqual(await conversationOf(`${LOCAL_SLACK.teamId}:U0ADA`, "slack"), s1, "a new top-level message is a new conversation");

    // Replies go into the thread; options written out; files refused; Slack's refusal said.
    assert.equal((await reply(s1, "Yes, it's back: sorry!")).status, 200);
    await drain();
    assert.deepEqual(stand.slackSent.at(-1)!, { ...stand.slackSent.at(-1)!, channel: "C0SUPPORT", text: "Yes, it's back: sorry!", threadTs: root.event.ts });
    await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", s1), { type: "system", id: "workflow:x" }, "workflow_message", "Anything else?", { options: ["Yes", "No"] }));
    await drain();
    assert.equal(stand.slackSent.at(-1)!.text, "Anything else?\n1. Yes\n2. No");
    await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", s1), { type: "teammate", id: "owner" }, "attachment", "", { name: "x.pdf" }));
    await drain();
    assert.equal((await deliveries(s1)).at(-1)!.error, "Files can't be posted to Slack from Relay yet: send a link instead.");

    // A shared image is scanned and published.
    stand.slackFiles.set("https://files.slack.com/files-pri/T0LOCAL01/shot.png", { bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]), mime: "image/png" });
    await slackHook(
      stand.slackMessage({ channel: "C0SUPPORT", user: "U0ADA", text: "Screenshot", thread_ts: root.event.ts, subtype: "file_share", files: [{ url_private: "https://files.slack.com/files-pri/T0LOCAL01/shot.png", mimetype: "image/png" }] }),
    );
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM conversation_parts WHERE conversation_id=$1 AND kind='attachment' AND author_type='contact'", [s1]))[0].n, 1);

    // Discord: a message (from the gateway) starts a conversation; bots and our own are ignored; a
    // reply to it, or the same person in the channel within a day, joins it; another channel doesn't.
    const m1 = stand.discordMessage({ channel: "700000000000000001", author: "600000000000000001", username: "Grace", content: "How do I reset my key?" });
    assert.deepEqual(await ingestDiscordMessage(db.connect, "a", discordId, m1), { kept: true });
    assert.deepEqual(await ingestDiscordMessage(db.connect, "a", discordId, m1), { kept: false }, "each message once");
    assert.deepEqual(await ingestDiscordMessage(db.connect, "a", discordId, stand.discordMessage({ channel: "700000000000000001", author: "600000000000000002", content: "beep", bot: true })), { kept: false });
    assert.deepEqual(await ingestDiscordMessage(db.connect, "a", discordId, stand.discordMessage({ channel: "700000000000000001", author: LOCAL_DISCORD.botId, content: "us" })), { kept: false });
    await drain();
    const d1 = (await conversationOf("600000000000000001", "discord"))!;
    await ingestDiscordMessage(db.connect, "a", discordId, stand.discordMessage({ channel: "700000000000000001", author: "600000000000000001", content: "Found it, thanks", replyTo: m1.id }));
    await ingestDiscordMessage(db.connect, "a", discordId, stand.discordMessage({ channel: "700000000000000001", author: "600000000000000001", content: "One more thing" }));
    await drain();
    assert.equal(await count(d1), 3);
    await ingestDiscordMessage(db.connect, "a", discordId, stand.discordMessage({ channel: "700000000000000099", author: "600000000000000001", content: "Different channel" }));
    await drain();
    assert.notEqual(await conversationOf("600000000000000001", "discord"), d1);
    assert.equal((await sql("a", "SELECT c.name FROM conversations v JOIN identity_contact_mappings m ON m.workspace_id=v.workspace_id AND m.identity_id=v.primary_identity_id JOIN contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id WHERE v.id=$1", [d1]))[0].name, "Grace");

    // The reply answers their latest message there, pinging nobody.
    await reply(d1, "Settings › API keys.");
    await drain();
    assert.deepEqual(stand.discordSent.at(-1)!.channel, "700000000000000001");
    assert.deepEqual(stand.discordSent.at(-1)!.body, {
      content: "Settings › API keys.",
      message_reference: { message_id: (await sql("a", "SELECT data->'discord'->>'messageId' AS id FROM conversation_parts WHERE conversation_id=$1 AND kind='customer_message' ORDER BY seq DESC LIMIT 1", [d1]))[0].id, fail_if_not_exists: false },
      allowed_mentions: { parse: [] },
    });

    // Disconnected: Discord's messages aren't kept; the sweep stops asking for its gateway.
    await agent("community-settings", { action: "disconnect", connectionId: discordId });
    assert.deepEqual(await ingestDiscordMessage(db.connect, "a", discordId, stand.discordMessage({ channel: "700000000000000001", author: "600000000000000001", content: "After" })), { kept: false });
    assert.deepEqual(await discordConnections(db.connect, "a"), []);

    // The rollback: the flags off, Slack's webhook refuses, unsent replies fail.
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "reply", conversationId: s1, text: "Queued at rollback" }));
    const rollback = readFileSync("db/rollback/0069_community.sql", "utf8");
    for (const statement of rollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await sql("a", statement);
    assert.equal((await deliveries(s1)).at(-1)!.error, "Stopped by rollback.");
    assert.equal((await slackHook(stand.slackMessage({ channel: "C0SUPPORT", user: "U0ADA", text: "After" }))).status, 404);
  } finally {
    await db.close();
  }
});
