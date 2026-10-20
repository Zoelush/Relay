import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { changeDeveloperTokens } from "../server/developer";
import { handleRest } from "../server/rest";
import { runWebhooks, signature, type WebhookEnvironment } from "../server/webhooks";
import { sendAlert } from "../server/email-out";
import { TOPIC_IDS } from "../lib/webhook-topics";
import { Relay, RelayError, verifyWebhook } from "../sdk/javascript/relay.mjs";

/**
 * Webhooks (phase 15, D3; docs/DEVELOPER_PLATFORM_STEP3.md): events written by the database only
 * while someone subscribes; each topic delivered once fanned out, signed (checked here with the
 * SDK's own `verifyWebhook`), with the resource in the API's shapes; never an internal note; retried
 * with backoff, abandoned after 24 hours, a webhook failing for 24 hours turned off (its creator told,
 * and its alert email sent); replays exact; a rotated secret signs alongside the old for a day;
 * another workspace sees none of it. And the reference's verification snippets work.
 */
test("the database writes exactly the topics the list names", () => {
  const sql = readFileSync("db/postgres/0078_webhooks.sql", "utf8");
  const written = [...new Set([...sql.matchAll(/'((?:conversation|ticket|contact|event|ai_agent|sla|article)\.[a-z_]+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(written, [...TOPIC_IDS].sort());
});

test("webhooks: subscribed topics delivered, signed, retried, turned off, replayed and rotated; per workspace", async () => {
  const db = await testDatabase();
  const received: { url: string; headers: Record<string, string>; body: string }[] = [];
  let answers: number[] = [];
  const whEnv: WebhookEnvironment = {
    key: "k".repeat(40),
    policy: {
      allowHosts: ["hooks.test", "hooks-b.test"],
      fetch: (async (url: string, init: RequestInit) => {
        received.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) });
        const status = answers.length ? answers.shift()! : 200;
        return new Response(status === 200 ? "ok" : "receiver says no", { status });
      }) as typeof fetch,
    },
  };
  const env = { connect: db.connect, webhooks: whEnv };
  const sql = <T = any>(text: string, values: unknown[] = [], w = "a") => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const run = async (w = "a") => {
    for (let i = 0; i < 10; i++) if ((await runWebhooks(db.connect, whEnv, { workspace_id: w } as never)).done) return;
  };
  try {
    const tokens: Record<string, string> = {};
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) => seedFoundation(q, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await tenant(db.connect, w, (q) => q.query("UPDATE workspace_features SET enabled=true WHERE name=ANY($1)", [["developer_api_v1", "segments_v1", "channels_v1", "channel_email_v1"]]));
      const scopes = ["conversations.read", "conversations.reply", "conversations.note", "conversations.manage", "contacts.personal_data", "workspace.manage"];
      tokens[w] = ((await tenant(db.connect, w, (q) => changeDeveloperTokens(q, w, "owner-" + w, { action: "create", name: "Hooks", scopes }))) as { token: string }).token;
    }
    const client = (token: string) => new Relay({ token, baseUrl: "http://api.test/rest", fetch: ((u: string, i: RequestInit) => handleRest(new Request(u, i), env)) as typeof fetch });
    const relay = client(tokens.a);
    const other = client(tokens.b);

    // With no subscription, nothing is written.
    const early = await relay.createContact({ external_id: "u-early", name: "Early" });
    await relay.createConversation({ contact_id: early.id, body: "Before any webhook" });
    assert.equal((await sql("SELECT 1 FROM webhook_events")).length, 0, "workspaces without webhooks pay nothing");

    // A subscription: its secret this once; bad addresses and topics are named.
    for (const [body, f] of [
      [{ url: "ftp://hooks.test/x", topics: ["contact.created"] }, "url"],
      [{ url: "https://localhost/x", topics: ["contact.created"] }, "url"],
      [{ url: "http://hooks.test/in", topics: ["contact.deleted"] }, "topics[0]"],
    ] as const) {
      const e = await relay.createWebhook(body).then(() => null, (x: unknown) => x);
      assert.ok(e instanceof RelayError && e.field === f, JSON.stringify(body));
    }
    const topics = ["conversation.created", "conversation.customer_replied", "conversation.teammate_replied", "conversation.tagged", "contact.created", "contact.updated", "event.received"];
    const hook = await relay.createWebhook({ url: "http://hooks.test/in", topics, alert_email: "ops@example.com" });
    const secret = hook.secret as string;
    assert.match(secret, /^whsec_[A-Za-z0-9]{32}$/);
    assert.equal((await relay.getWebhook(hook.id)).secret, undefined, "never shown again");
    assert.equal(hook.status, "active");
    // b subscribes too, elsewhere: it must get none of a's.
    await other.createWebhook({ url: "http://hooks-b.test/in", topics });

    // Things happen in a.
    const ada = await relay.createContact({ external_id: "u-ada", name: "Ada" });
    const c = await relay.createConversation({ contact_id: ada.id, body: "Where's my parcel?" });
    await relay.replyToConversation(c.id, { body: "It's on its way" });
    await relay.addConversationNote(c.id, { body: "SECRET internal note" });
    const tag = await relay.createTag({ name: "Shipping" });
    await relay.tagConversation(c.id, { tag_id: tag.id });
    await relay.updateContact(ada.id, { custom_attributes: { plan: "pro" } });
    await sql("UPDATE workspace_features SET enabled=true WHERE name='segments_v1'");
    await relay.createContactEvent(ada.id, { id: "e1", name: "upgraded plan" });
    await run();
    await run("b");

    const fromA = received.filter((r) => r.url === "http://hooks.test/in");
    assert.equal(received.filter((r) => r.url === "http://hooks-b.test/in").length, 0, "b's webhook got none of a's events");
    const events = await Promise.all(fromA.map((r) => verifyWebhook(secret, r.body, r.headers["relay-signature"])));
    assert.deepEqual(
      events.map((e) => e.topic),
      ["contact.created", "conversation.created", "conversation.customer_replied", "conversation.teammate_replied", "conversation.tagged", "contact.updated", "event.received"],
    );
    const by = (t: string) => events.find((e) => e.topic === t)!.data as Record<string, any>;
    assert.equal(by("contact.created").item.id, ada.id);
    assert.deepEqual([by("conversation.teammate_replied").item.id, by("conversation.teammate_replied").part.body], [c.id, "It's on its way"]);
    assert.equal(by("conversation.tagged").tag.name, "Shipping");
    assert.equal(by("contact.updated").item.custom_attributes.plan, "pro");
    assert.equal(by("event.received").item.name, "upgraded plan");
    assert.ok(fromA.every((r) => !r.body.includes("SECRET internal note")), "an internal note is never sent");
    for (const r of fromA) {
      assert.equal(r.headers["relay-event-id"], JSON.parse(r.body).id);
      assert.equal(r.headers["relay-topic"], JSON.parse(r.body).topic);
    }
    // A wrong secret, a tampered body or an old timestamp is refused by the SDK's check.
    await assert.rejects(verifyWebhook("whsec_wrong", fromA[0].body, fromA[0].headers["relay-signature"]), /doesn't match/);
    await assert.rejects(verifyWebhook(secret, fromA[0].body + " ", fromA[0].headers["relay-signature"]), /doesn't match/);
    await assert.rejects(verifyWebhook(secret, fromA[0].body, fromA[0].headers["relay-signature"], 300, Date.now() / 1000 + 600), /too old/);

    // A failure: retried with backoff, its answer logged; then delivered.
    received.length = 0;
    answers = [500];
    await relay.replyToConversation(c.id, { body: "Second reply" });
    await run();
    const [failed] = (await relay.listWebhookDeliveries(hook.id, { query: { per_page: 1 } })).data;
    assert.deepEqual([failed.topic, failed.status, failed.attempts, failed.last_status], ["conversation.teammate_replied", "pending", 1, 500]);
    assert.ok(Date.parse(failed.next_attempt_at) - Date.now() > 50_000, "the next try is about a minute away");
    assert.equal((await relay.getWebhook(hook.id)).status, "failing");
    const detail = await relay.getWebhookDelivery(hook.id, failed.id);
    assert.deepEqual([detail.attempt_log[0].status, detail.attempt_log[0].response], [500, "receiver says no"]);
    await run();
    assert.equal(received.length, 1, "not before it's due");
    await sql("UPDATE webhook_deliveries SET next_attempt_at=now() WHERE id=$1", [failed.id]);
    await run();
    const ok = await relay.getWebhookDelivery(hook.id, failed.id);
    assert.deepEqual([ok.status, ok.attempts], ["delivered", 2]);
    assert.equal(received[0].body, received[1].body, "a retry sends the same body");
    assert.equal((await relay.getWebhook(hook.id)).status, "active", "a success forgives the failures");

    // Replay: a new delivery with the same event and body.
    const replay = await relay.replayWebhookDelivery(hook.id, failed.id);
    await run();
    assert.equal(received.at(-1)!.body, received[1].body);
    assert.equal((await relay.getWebhookDelivery(hook.id, replay.id)).replay_of, failed.id);

    // Rotation: both secrets sign for a day.
    const rotated = await relay.rotateWebhookSecret(hook.id);
    assert.notEqual(rotated.secret, secret);
    assert.ok(rotated.previous_secret_until);
    await relay.testWebhook(hook.id);
    await run();
    const ping = received.at(-1)!;
    assert.equal(JSON.parse(ping.body).topic, "ping");
    assert.equal((ping.headers["relay-signature"].match(/v1=/g) ?? []).length, 2);
    await verifyWebhook(secret, ping.body, ping.headers["relay-signature"]);
    await verifyWebhook(rotated.secret, ping.body, ping.headers["relay-signature"]);

    // Abandoned after 24 hours of trying.
    answers = [500, 500, 500];
    await relay.replyToConversation(c.id, { body: "Third reply" });
    await run();
    const [third] = (await relay.listWebhookDeliveries(hook.id, { query: { per_page: 1 } })).data;
    await sql("UPDATE webhook_deliveries SET next_attempt_at=now(),first_attempt_at=now()-interval '25 hours' WHERE id=$1", [third.id]);
    await sql("UPDATE webhook_subscriptions SET failing_since=now()-interval '25 hours' WHERE id=$1", [hook.id]);
    await run();
    assert.equal((await relay.getWebhookDelivery(hook.id, third.id)).status, "abandoned");
    // ...and, failing for 24 hours, turned off: its creator told, and its alert email sent.
    const off = await relay.getWebhook(hook.id);
    assert.deepEqual([off.status, off.disabled_reason], ["disabled", "Failed for 24 hours without a success."]);
    assert.deepEqual(await sql("SELECT kind,excerpt FROM notifications WHERE teammate_id='owner'"), [{ kind: "webhook_disabled", excerpt: "A webhook to http://hooks.test/in was turned off after failing for 24 hours." }]);
    const job = (await sql<{ id: string; payload: { alertId: string } }>("SELECT id,payload FROM jobs WHERE kind='email.alert'"))[0];
    const mails: { to: string; raw: string }[] = [];
    const sendRaw = async (m: { to: string; raw: Uint8Array | string }) => (mails.push({ to: m.to, raw: typeof m.raw === "string" ? m.raw : new TextDecoder().decode(m.raw) }), { providerId: "p1" });
    await sendAlert(db.connect, { sender: { sendRaw }, inboundDomain: "relay.test", sendingDomain: "relay.test" } as never, { workspace_id: "a", ...job } as never);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, "ops@example.com");
    assert.match(mails[0].raw, /Subject: Relay webhook turned off/);
    // Its text (base64 in the message) names the address and how to recover.
    const text = [...mails[0].raw.matchAll(/Content-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/g)].map((m) => Buffer.from(m[1].replace(/\s/g, ""), "base64").toString("utf8")).join("\n");
    assert.match(text, /hooks\.test\/in/);
    assert.match(text, /replay what it missed/);
    // Off: nothing more is sent; on again, it starts afresh.
    received.length = 0;
    await relay.replyToConversation(c.id, { body: "While off" });
    await run();
    assert.equal(received.length, 0);
    assert.equal((await relay.updateWebhook(hook.id, { active: true })).status, "active");

    // Another workspace can't see or change a's webhook; a deleted webhook's waiting deliveries stop.
    for (const call of [() => other.getWebhook(hook.id), () => other.listWebhookDeliveries(hook.id), () => other.replayWebhookDelivery(hook.id, failed.id)]) {
      const e = await call().then(() => null, (x: unknown) => x);
      assert.ok(e instanceof RelayError && e.status === 404);
    }
    answers = [500];
    await relay.replyToConversation(c.id, { body: "Before deleting" });
    await run();
    await relay.deleteWebhook(hook.id);
    assert.deepEqual((await sql<{ status: string }>("SELECT DISTINCT status FROM webhook_deliveries WHERE subscription_id=$1 AND status='pending'", [hook.id])).length, 0);
    assert.deepEqual((await relay.listWebhooks()).data, []);
  } finally {
    await db.close();
  }
});

test("the reference's verification snippets accept Relay's signature and refuse a wrong one", async () => {
  const doc = readFileSync("docs/API.md", "utf8");
  const js = /```js\n([\s\S]*?)```/.exec(doc)![1];
  const py = /```python\n([\s\S]*?)```/.exec(doc)![1];
  const body = JSON.stringify({ type: "webhook_event", id: "e1", topic: "ping" });
  const header = await signature(["whsec_one", "whsec_two"], body);
  const dir = mkdtempSync(join(tmpdir(), "relay-verify-"));
  writeFileSync(join(dir, "verify.mjs"), js);
  const { verify } = await import(join(dir, "verify.mjs"));
  assert.deepEqual([verify("whsec_one", body, header), verify("whsec_two", body, header), verify("whsec_three", body, header), verify("whsec_one", body + "x", header)], [true, true, false, false]);
  const script = `${py}\nimport sys\nh, b = sys.argv[1], sys.argv[2].encode()\nprint([verify("whsec_one", b, h), verify("whsec_two", b, h), verify("whsec_three", b, h)])`;
  const out = await new Promise<string>((resolve, reject) => execFile("python3", ["-c", script, header, body], (e, stdout, stderr) => (e ? reject(new Error(stderr)) : resolve(stdout))));
  assert.equal(out.trim(), "[True, True, False]");
});
