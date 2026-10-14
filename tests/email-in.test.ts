import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { runJob, type Job } from "../server/jobs";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { attachmentScan } from "../server/attachments";
import { runDelivery } from "../server/channels";
import { acceptEmail, receiveEmailJob, type EmailEnvironment } from "../server/email-in";
import { localAttachmentStorage } from "../scripts/local-storage";

/** Email in (phase 12, E2; docs/OMNICHANNEL_STEP2.md): accepted at an address, read into conversations. */
const fixture = (file: string) => readFile(new URL(`./fixtures/email/${file}`, import.meta.url));
const DOMAIN = "inbound.relay.test";
/** A plain email, built here (for threading by references and by subject). */
const email = (o: { id: string; from: string; subject: string; text: string; replyTo?: string; headers?: Record<string, string> }) =>
  new TextEncoder().encode(
    [
      `From: ${o.from}`,
      `To: help@acme.example`,
      `Subject: ${o.subject}`,
      `Date: Tue, 13 Oct 2026 10:00:00 +0000`,
      `Message-ID: <${o.id}>`,
      ...(o.replyTo ? [`In-Reply-To: <${o.replyTo}>`, `References: <${o.replyTo}>`] : []),
      ...Object.entries(o.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      o.text,
      "",
    ].join("\r\n"),
  );

test("email in: accepted only at a brand's address, read into threaded conversations with the full email kept, auto-replies and bounces apart, attachments scanned, forwarding confirmed", async () => {
  const db = await testDatabase();
  const files = localAttachmentStorage();
  const storage = files.storage;
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    attachments: storage,
    emailDomain: DOMAIN,
  };
  const emailEnv: EmailEnvironment = { storage, domain: DOMAIN, trustedAuthServ: ["mx.cloudflare.net"] };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "email.receive": (j: Job) => receiveEmailJob(db.connect, emailEnv, j),
    "attachment.scan": (j: Job) => attachmentScan(db.connect, storage, j),
    "channel.deliver": (j: Job) => runDelivery(db.connect, {}, j),
  };
  const drain = async (w = "a") => {
    for (let i = 0; i < 100; i++) {
      const job = (await sql<{ id: string }>(w, "SELECT id FROM jobs WHERE kind IN ('email.receive','attachment.scan','channel.deliver') AND state IN ('queued','running') ORDER BY created_at LIMIT 1"))[0];
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
  const send = async (raw: Uint8Array, to = `a+hello@${DOMAIN}`) => {
    const r = await acceptEmail(db.connect, emailEnv, { raw, to, from: "bounces@mail.example.net" });
    await drain(to.split("+")[0]);
    return r;
  };
  const inbound = () => sql<{ status: string; kind: string | null; error: string; conversation_id: string | null; part_id: string | null }>(
    "a",
    "SELECT status,kind,error,conversation_id,part_id FROM email_inbound ORDER BY received_at DESC,id LIMIT 1",
  ).then((r) => r[0]);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
      );
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE name='ai_agent_v1'");
    }

    // Off by default, and only at a brand's own address.
    await sql("a", "INSERT INTO email_settings(workspace_id,brand_id,token) VALUES('a','default','hello')");
    assert.deepEqual(await send(await fixture("01-gmail-reply.eml")), { accepted: false, reason: "No such address." });
    for (const w of ["a", "b"]) await sql(w, "UPDATE workspace_features SET enabled=true WHERE name IN ('channels_v1','channel_email_v1')");
    assert.equal((await send(await fixture("01-gmail-reply.eml"), `a+guess@${DOMAIN}`)).accepted, false);
    assert.equal((await send(await fixture("01-gmail-reply.eml"), `a+hello@elsewhere.example`)).accepted, false);
    assert.equal((await send(await fixture("01-gmail-reply.eml"), `b+hello@${DOMAIN}`)).accepted, false, "another workspace's token isn't this one's");
    assert.equal((await acceptEmail(db.connect, emailEnv, { raw: new Uint8Array(25 * 1024 * 1024 + 1), to: `a+hello@${DOMAIN}`, from: "" })).reason, "The message is larger than 25 MB.");

    // A Gmail reply: a new email conversation, the new text on the part, the whole email beside it.
    assert.equal((await send(await fixture("01-gmail-reply.eml"))).accepted, true);
    const first = await inbound();
    assert.deepEqual({ status: first.status, kind: first.kind }, { status: "read", kind: "message" });
    const c1 = first.conversation_id!;
    const [part] = await sql("a", "SELECT body,channel,data FROM conversation_parts WHERE id=$1", [first.part_id]);
    assert.deepEqual(part, { body: "It's order 1042, placed last Tuesday.", channel: "email", data: { email: { subject: "Re: Late order" } } });
    assert.equal((await sql("a", "SELECT channel,current_channel FROM conversations WHERE id=$1", [c1]))[0].current_channel, "email");
    const view = (await agent(`email-message?part=${first.part_id}`)).body;
    assert.equal(view.subject, "Re: Late order");
    assert.equal(view.verified, true, "DMARC passed at the trusted receiver");
    assert.equal(view.stripped, true);
    assert.match(view.text, /On Mon, Oct 12, 2026 at 9:15 AM Acme Support/);
    assert.match(view.html, /<blockquote>Thanks for writing in.<\/blockquote>/, "the full email keeps the quote");
    assert.equal((await agent(`email-message?part=${first.part_id}`, undefined, "owner-b", "b")).status, 404);
    // Its sender's address is kept, verified; Zoe doesn't answer email yet.
    assert.deepEqual(await sql("a", "SELECT address,verified,channel FROM identity_addresses"), [{ address: "jane@customer.example", verified: true, channel: "email" }]);
    assert.deepEqual(await sql("a", "SELECT 1 FROM jobs WHERE kind='ai.reply'"), []);
    // The raw message isn't kept once read.
    assert.equal(await storage.getQuarantine(`a/email/${(await sql("a", "SELECT id FROM email_inbound LIMIT 1"))[0].id}.eml`), null);

    // The same email again adds nothing; a reply by reference, and by subject from the same sender,
    // thread; the same subject from someone else doesn't.
    await send(await fixture("01-gmail-reply.eml"));
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM conversation_parts WHERE conversation_id=$1 AND kind='customer_message'", [c1]))[0].n, 1);
    await send(email({ id: "follow-1@customer.example", from: "Jane Doe <jane@customer.example>", subject: "Re: Late order", text: "Any update?", replyTo: "msg-01@mail.example.net" }));
    assert.equal((await inbound()).conversation_id, c1);
    await send(email({ id: "follow-2@customer.example", from: "jane@customer.example", subject: "RE: Late order", text: "Still waiting." }));
    assert.equal((await inbound()).conversation_id, c1);
    await send(email({ id: "other-1@customer.example", from: "pat@customer.example", subject: "Re: Late order", text: "Mine is late too." }));
    assert.notEqual((await inbound()).conversation_id, c1);

    // Auto-replies: kept for teammates in their thread, or dropped; never a customer's reply.
    // (The corpus's auto-replies answer the same message as the Gmail reply, so they'd thread
    // there; this one answers nothing Relay knows.)
    await send(email({ id: "ooo-0@customer.example", from: "grace@customer.example", subject: "Out of office", text: "Away until Monday.", headers: { "Auto-Submitted": "auto-replied" } }));
    assert.deepEqual({ ...(await inbound()), error: undefined }, { status: "read", kind: "auto_reply", conversation_id: null, part_id: null, error: undefined });
    await send(email({ id: "ooo-1@customer.example", from: "jane@customer.example", subject: "Automatic reply: Late order", text: "I'm away.", replyTo: "msg-01@mail.example.net", headers: { "Auto-Submitted": "auto-replied" } }));
    const ooo = await inbound();
    assert.equal(ooo.conversation_id, c1);
    assert.deepEqual(await sql("a", "SELECT kind,audience,data->>'kind' AS what FROM conversation_parts WHERE id=$1", [ooo.part_id]), [{ kind: "system_event", audience: "internal", what: "auto_reply" }]);

    // Bounces: a hard one suppresses the address; a delay doesn't.
    await send(await fixture("41-dsn-hard.eml"));
    await send(await fixture("42-dsn-delayed.eml"));
    assert.deepEqual(await sql("a", "SELECT address,reason FROM suppressions WHERE lifted_at IS NULL"), [{ address: "gone@customer.example", reason: "hard_bounce" }]);

    // Attachments: PNG, JPEG, PDF and text are scanned and published; others are listed, not kept.
    await send(await fixture("47-attachments.eml"));
    const withFiles = (await inbound()).conversation_id;
    assert.deepEqual(
      (await sql("a", "SELECT data->>'name' AS name FROM conversation_parts WHERE conversation_id=$1 AND kind='attachment' ORDER BY seq", [withFiles])).map((r) => r.name),
      ["invoice-1042.pdf", "screenshot.png"],
    );
    await send(await fixture("48-inline-image.eml"));
    const inline = (await agent(`email-message?part=${(await inbound()).part_id}`)).body;
    assert.match(inline.html, /src="data:image\/png;base64,/);
    assert.deepEqual(inline.attachments.map((x: { name: string; kept: boolean; reason: string }) => [x.name, x.kept, x.reason]), [["steps.docx", false, "Only PNG, JPEG, PDF and plain text are kept."]]);

    // Settings: each brand's address; a support address set; forwarding confirmed by a forwarded
    // message; Gmail's confirmation kept, not a conversation; a new address refuses the old.
    const settings = (await agent("email-settings")).body;
    assert.equal(settings.brands[0].address, `a+hello@${DOMAIN}`);
    assert.equal((await agent("email-settings", { action: "save", brandId: "default", supportAddress: "not an address" })).body.error.code, "INVALID_ADDRESS");
    assert.equal((await agent("email-settings", { action: "save", brandId: "default", supportAddress: `x@${DOMAIN}` })).body.error.message, "Use your own support address, not Relay's.");
    await agent("email-settings", { action: "save", brandId: "default", supportAddress: "Help@Acme.example" });
    await send(email({ id: "gmail-confirm@google.com", from: "Gmail Team <forwarding-noreply@google.com>", subject: "(#123456) Gmail Forwarding Confirmation", text: "Confirmation code: 123456" }));
    assert.equal((await inbound()).kind, "confirmation");
    const confirmed = (await agent("email-settings")).body.brands[0];
    assert.equal(confirmed.supportAddress, "help@acme.example");
    assert.match(confirmed.confirmation.text, /Confirmation code: 123456/);
    assert.equal(confirmed.forwardingVerifiedAt, null);
    await send(email({ id: "fwd-1@customer.example", from: "lee@customer.example", subject: "Hello", text: "Forwarded to you", headers: { "X-Forwarded-To": `a+hello@${DOMAIN}`, "Delivered-To": "help@acme.example" } }));
    assert.ok((await agent("email-settings")).body.brands[0].forwardingVerifiedAt);
    assert.equal((await agent("email-settings", undefined, "owner-b", "b")).body.brands[0].address.startsWith("b+"), true);
    await agent("email-settings", { action: "new_address", brandId: "default" });
    assert.equal((await send(await fixture("02-gmail-wrapped-header.eml"))).accepted, false, "the old address is refused");

    // A teammate's reply on an email conversation is queued; with no sending provider (E3's), it
    // fails at once with the reason, not retried.
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "reply", conversationId: c1, text: "We're on it." }));
    await drain();
    assert.deepEqual(await sql("a", "SELECT status,error FROM channel_deliveries"), [{ status: "failed", error: "Email sending isn't set up for Relay yet." }]);

    // The rollback: the flag goes off (mail refused), unread mail fails; conversations stay.
    await sql("a", "UPDATE email_settings SET token='again' WHERE brand_id='default'");
    await acceptEmail(db.connect, emailEnv, { raw: await fixture("03-gmail-quotes-only.eml"), to: `a+again@${DOMAIN}`, from: "" });
    const rollback = await readFile("db/rollback/0063_email_in.sql", "utf8");
    for (const statement of rollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await sql("a", statement);
    assert.deepEqual({ status: (await inbound()).status, error: (await inbound()).error }, { status: "failed", error: "Stopped by rollback." });
    assert.equal((await send(await fixture("04-gmail-spanish.eml"), `a+again@${DOMAIN}`)).accepted, false);
    assert.ok((await sql("a", "SELECT count(*)::int AS n FROM email_messages"))[0].n > 0);
  } finally {
    await db.close();
  }
});
