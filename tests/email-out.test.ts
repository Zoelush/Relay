import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PostalMime from "postal-mime";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { append, command, conversation } from "../server/conversations";
import { runJob, type Job } from "../server/jobs";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { attachmentScan } from "../server/attachments";
import { releaseDeferred, runDelivery } from "../server/channels";
import { acceptEmail, receiveEmailJob, type EmailEnvironment } from "../server/email-in";
import { checkAwayEmails, checkDomainJob, domainRecords, type EmailOutEnvironment } from "../server/email-out";
import { buildEmail, encodeWord } from "../server/email-mime";
import { publicKeyInfo, verifySns } from "../server/email-sns";
import { localAttachmentStorage } from "../scripts/local-storage";
import { localEmailProvider, localSns, sesEvent } from "../scripts/local-email";

/**
 * Email out (phase 12, E3; docs/OMNICHANNEL_STEP3.md): replies sent through the gate with their
 * thread, from the brand's proven domain or Relay's address, a reply address per conversation,
 * the rate limit, SES's reports through signed SNS, away emails for messenger customers, and the
 * acceptance: a suppressed address is never sent to, through any path.
 */
const DOMAIN = "inbound.relay.test";

test("building an email: a plain-text alternative for every HTML mail, headers encoded and never broken, files attached", async () => {
  const raw = buildEmail({
    from: { address: "help@acme.example", name: "Grace from Acme" },
    to: { address: "robin@customer.example" },
    replyTo: { address: "a+r-abcdefghijkmnpqrstu@inbound.relay.test", name: "Acme" },
    subject: "Re: Commande endommagée — ご注文",
    messageId: "d-1@acme.example",
    inReplyTo: "<c-1@customer.example>",
    references: ["c-0@customer.example", "c-1@customer.example"],
    text: "Thanks: we're sending another.\n\n> My order arrived damaged",
    html: "<p>Thanks: we&#x27;re sending another.</p>",
    attachments: [{ name: "étiquette.pdf", mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 label") }],
    headers: { "Auto-Submitted": "auto-generated" },
  });
  const m = await PostalMime.parse(raw);
  assert.equal(m.subject, "Re: Commande endommagée — ご注文");
  assert.deepEqual([m.from?.address, m.from?.name, m.replyTo?.[0]?.address], ["help@acme.example", "Grace from Acme", "a+r-abcdefghijkmnpqrstu@inbound.relay.test"]);
  assert.deepEqual([m.messageId, m.inReplyTo, m.references], ["<d-1@acme.example>", "<c-1@customer.example>", "<c-0@customer.example> <c-1@customer.example>"]);
  assert.equal(m.text?.replace(/\r\n/g, "\n").trim(), "Thanks: we're sending another.\n\n> My order arrived damaged");
  assert.match(m.html ?? "", /sending another/);
  assert.deepEqual(m.attachments.map((a) => [a.filename, a.mimeType]), [["étiquette.pdf", "application/pdf"]]);
  const head = new TextDecoder().decode(raw).split("\r\n\r\n")[0];
  assert.match(head, /^Content-Type: multipart\/mixed/m);
  assert.match(new TextDecoder().decode(raw), /Content-Type: multipart\/alternative[\s\S]*text\/plain[\s\S]*text\/html/);
  assert.match(head, /^Auto-Submitted: auto-generated$/m);
  // A name can't add a header; an address with a line break isn't an address.
  const sneaky = new TextDecoder().decode(
    buildEmail({ from: { address: "a@b.example", name: "Eve\r\nBcc: everyone@example.com" }, to: { address: "c@d.example" }, subject: "Hi\r\nBcc: x@y.example", messageId: "x@b.example", text: "", html: "" }),
  );
  assert.doesNotMatch(sneaky, /^Bcc:/m);
  assert.throws(() => buildEmail({ from: { address: "a@b.example\r\nBcc: x@y.example" }, to: { address: "c@d.example" }, subject: "", messageId: "x@b.example", text: "", html: "" }));
  // Long non-ASCII words split on character boundaries.
  assert.ok(encodeWord("é".repeat(80)).split("\r\n ").every((w) => w.length <= 75));
});

test("SNS signatures: only the topic's, signed by a key from an SNS certificate address, check out", async () => {
  const sns = await localSns();
  const good = await sns.notification({ eventType: "Delivery" });
  assert.equal(await verifySns(good as never, sns.environment), true);
  assert.equal(await verifySns({ ...good, Message: '{"eventType":"Bounce"}' } as never, sns.environment), false, "a changed message");
  assert.equal(await verifySns({ ...good, TopicArn: "arn:aws:sns:eu-west-2:1:other" } as never, sns.environment), false, "another topic");
  assert.equal(await verifySns({ ...good, SigningCertURL: "https://evil.example/cert.pem" } as never, sns.environment), false, "a certificate from elsewhere");
  assert.equal(await verifySns({ ...good, SigningCertURL: "https://sns.eu-west-2.amazonaws.com.evil.example/x.pem" } as never, sns.environment), false);
  assert.equal(await verifySns(good as never, { ...sns.environment, topicArn: "" }), false, "no topic configured");
  // The public key inside a real X.509 certificate (made here with openssl, when it's installed).
  let dir = "";
  try {
    dir = mkdtempSync(join(tmpdir(), "relay-sns-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=sns.test"], {
      stdio: "ignore",
    });
  } catch {
    if (dir) rmSync(dir, { recursive: true, force: true });
    return;
  }
  try {
    const pem = readFileSync(join(dir, "c.pem"), "utf8");
    const der = Uint8Array.from(atob(pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, "")), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("spki", publicKeyInfo(der), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const sig = execFileSync("openssl", ["dgst", "-sha256", "-sign", join(dir, "k.pem")], { input: "signed text" });
    assert.equal(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, new TextEncoder().encode("signed text")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only the delivery job sends email: the provider is called in one place, behind the adapter", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));
  const code = ["server", "workers", "scripts", "lib", "agent", "app", "components"].flatMap((d) => files(d)).map((f) => [f, readFileSync(f, "utf8")] as const);
  // The provider's send: called only by the email adapter's `send` and (E4) the incident alert
  // job, which checks the suppression list itself before it.
  assert.deepEqual(code.filter(([, s]) => /\.sendRaw\(/.test(s)).map(([f]) => f), ["server/email-out.ts"]);
  const out = readFileSync("server/email-out.ts", "utf8");
  assert.equal(out.match(/\.sendRaw\(/g)?.length, 2);
  const alert = out.slice(out.indexOf("export async function sendAlert"));
  assert.ok(alert.indexOf('mayDeliver(db, w, "email", a.address') < alert.indexOf(".sendRaw("));
  // The adapter's send: wired into the adapter, never called directly.
  assert.deepEqual(code.filter(([, s]) => /\bsendEmail\b/.test(s)).map(([f]) => f).sort(), ["server/email-in.ts", "server/email-out.ts"]);
  assert.doesNotMatch(readFileSync("server/email-in.ts", "utf8"), /sendEmail\(/);
  // And an adapter's send is called only by the delivery job, after the gate.
  const channels = readFileSync("server/channels.ts", "utf8");
  assert.equal(channels.match(/\.send!?\(/g)?.length, 1);
  assert.ok(channels.indexOf("mayDeliver(db, w, d.channel") < channels.indexOf("a.send!(out, env)"));
});

test("email out: replies threaded from the right address, reply addresses, domains proven, the rate limit, SES reports, away emails, and a suppressed address never sent to", async () => {
  const db = await testDatabase();
  const storage = localAttachmentStorage().storage;
  const provider = localEmailProvider();
  const sns = await localSns();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    attachments: storage,
    emailDomain: DOMAIN,
    emailSending: { sendingDomain: DOMAIN, region: "eu-west-2" },
    sesReports: sns.environment,
  };
  const emailIn: EmailEnvironment = { storage, domain: DOMAIN, trustedAuthServ: ["mx.cloudflare.net"] };
  const emailOut: EmailOutEnvironment = { sender: provider.sender, dns: provider.dns, storage, inboundDomain: DOMAIN, sendingDomain: DOMAIN, region: "eu-west-2" };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "email.receive": (j: Job) => receiveEmailJob(db.connect, emailIn, j),
    "attachment.scan": (j: Job) => attachmentScan(db.connect, storage, j),
    "channel.deliver": (j: Job) => runDelivery(db.connect, { providers: { email: emailOut } }, j),
    "email.domain.check": (j: Job) => checkDomainJob(db.connect, emailOut, j),
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
  const mail = (o: { id: string; from: string; subject: string; text: string; inReplyTo?: string }) =>
    new TextEncoder().encode(
      [
        `From: ${o.from}`,
        "To: help@acme.example",
        `Subject: ${o.subject}`,
        "Date: Tue, 13 Oct 2026 10:00:00 +0000",
        `Message-ID: <${o.id}>`,
        ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`] : []),
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        o.text,
        "",
      ].join("\r\n"),
    );
  const receive = async (raw: Uint8Array, to = `a+hello@${DOMAIN}`) => {
    const r = await acceptEmail(db.connect, emailIn, { raw, to, from: "x@mail.example.net" });
    await drain(to.split("+")[0]);
    return r;
  };
  const latestConversation = async () => (await sql<{ conversation_id: string }>("a", "SELECT conversation_id FROM email_inbound ORDER BY received_at DESC,id LIMIT 1"))[0].conversation_id;
  const reply = async (conversationId: string, text: string) => {
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "reply", conversationId, text }));
    await drain();
  };
  const deliveries = (conversationId: string) =>
    sql<{ status: string; error: string; domain: string | null; purpose: string; address: string }>(
      "a",
      "SELECT status,error,domain,purpose,address FROM channel_deliveries WHERE conversation_id=$1 ORDER BY created_at",
      [conversationId],
    );
  const lastSent = async () => provider.read(provider.outbox.at(-1)!);
  const hook = (body: unknown) => handleApi(new Request("https://relay.test/v1/hooks/ses", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body) }), env);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
      );
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE name IN ('channels_v1','channel_email_v1','workflows_v1')");
      // Each brand's inbound address, made when Settings is first read.
      const first = await agent("email-settings", undefined, "owner-" + w, w);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      await sql(w, "UPDATE email_settings SET token='hello' WHERE brand_id='default'");
    }

    // A customer's email, and the teammate's reply: sent from Relay's address for the brand (no
    // proven domain yet), with the conversation's reply address, in its thread, the customer quoted.
    await receive(mail({ id: "c-1@customer.example", from: "Robin Hale <robin@customer.example>", subject: "Damaged order", text: "My order arrived damaged." }));
    const c1 = await latestConversation();
    await reply(c1, "Sorry about that: we're sending another.");
    assert.deepEqual(
      (await deliveries(c1)).map((d) => [d.status, d.domain]),
      [["sent", DOMAIN]],
    );
    let out = await lastSent();
    assert.deepEqual([out.from, out.fromName, out.to], [`a+hello@${DOMAIN}`, "Support from Relay", "robin@customer.example"]);
    assert.match(out.replyTo, new RegExp(`^a\\+r-[a-z0-9]{20}@${DOMAIN.replace(/\./g, "\\.")}$`));
    assert.equal(out.subject, "Re: Damaged order");
    assert.equal(out.inReplyTo, "<c-1@customer.example>");
    assert.match(out.text, /^Sorry about that: we're sending another\.\n\nOn .+, Robin Hale wrote:\n> My order arrived damaged\./);
    assert.match(out.html, /<p>Sorry about that: we(&#x27;|')re sending another\.<\/p>/);
    assert.deepEqual(out.tags, { relay_workspace: "a", relay_delivery: (await sql("a", "SELECT id FROM channel_deliveries WHERE conversation_id=$1", [c1]))[0].id });
    const ourId = out.messageId.replace(/[<>]/g, "");

    // The customer answers: to the reply address with no thread headers and a new subject, or by
    // In-Reply-To to our message at the brand's address: both join the conversation.
    await receive(mail({ id: "c-2@customer.example", from: "robin@customer.example", subject: "photos", text: "Here are the photos." }), out.replyTo);
    assert.equal(await latestConversation(), c1);
    await receive(mail({ id: "c-3@customer.example", from: "robin@customer.example", subject: "Something else", text: "And the receipt.", inReplyTo: ourId }));
    assert.equal(await latestConversation(), c1);
    assert.equal((await acceptEmail(db.connect, emailIn, { raw: mail({ id: "x@y", from: "z@y.example", subject: "Hi", text: "Hi" }), to: `a+r-nosuchtoken0000000@${DOMAIN}`, from: "" })).accepted, false);

    // The composer says where a reply goes; another workspace can't ask.
    assert.deepEqual((await agent(`reply-target?conversation=${c1}`)).body.target, { channel: "email", address: "robin@customer.example", copies: true, subject: "Re: Damaged order" });
    assert.equal((await agent(`reply-target?conversation=${c1}`, undefined, "owner-b", "b")).status, 404);

    // The brand's own domain: saved, checked (records missing), published, checked again: proven.
    assert.equal((await agent("email-settings", { action: "save", brandId: "default", supportAddress: "help@acme.example" })).status, 200);
    await drain();
    let sending = (await agent("email-settings")).body.brands[0].sending;
    assert.equal(sending.domain.status, "pending");
    assert.deepEqual(
      sending.domain.records.map((r: { purpose: string; status: string; required: boolean }) => [r.purpose, r.status, r.required]),
      [
        ["ownership", "missing", true],
        ["dkim", "missing", true],
        ["dkim", "missing", true],
        ["dkim", "missing", true],
        ["bounce_mx", "missing", false],
        ["spf", "missing", false],
        ["dmarc", "missing", false],
      ],
    );
    assert.equal(sending.from, `a+hello@${DOMAIN}`);
    provider.publishAll(sending.domain.records);
    // Another workspace's ownership token isn't this one's: workspace b can't send as acme.example.
    assert.equal((await agent("email-settings", { action: "save", brandId: "default", supportAddress: "help@acme.example" }, "owner-b", "b")).status, 200);
    await drain("b");
    assert.equal((await agent("email-settings", undefined, "owner-b", "b")).body.brands[0].sending.domain.status, "pending");
    await agent("email-settings", { action: "check_domain", brandId: "default" });
    await drain();
    sending = (await agent("email-settings")).body.brands[0].sending;
    assert.deepEqual([sending.domain.status, sending.from], ["verified", "help@acme.example"]);
    await reply(c1, "The new one ships today.");
    out = await lastSent();
    assert.deepEqual([out.from, out.messageId.endsWith("@acme.example>")], ["help@acme.example", true]);
    assert.ok(out.references.includes(ourId), "earlier messages in References");
    // A free mailbox is never a sending domain.
    await agent("email-settings", { action: "save", brandId: "default", supportAddress: "acme.help@gmail.com" });
    sending = (await agent("email-settings")).body.brands[0].sending;
    assert.deepEqual([sending.domain.freeMail, sending.from], [true, `a+hello@${DOMAIN}`]);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM email_domains WHERE domain='gmail.com'"))[0].n, 0);
    await agent("email-settings", { action: "save", brandId: "default", supportAddress: "help@acme.example" });

    // The rate limit: over it, a delivery waits for the next minute, then goes.
    assert.equal((await agent("email-settings", { action: "rate", brandId: "default", perMinute: 0 })).body.error.code, "INVALID_RATE");
    await agent("email-settings", { action: "rate", brandId: "default", perMinute: 1 });
    await sql("a", "DELETE FROM email_send_counts");
    const sentBefore = provider.outbox.length;
    await reply(c1, "First.");
    await reply(c1, "Second.");
    assert.equal(provider.outbox.length, sentBefore + 1);
    const waiting = await sql<{ not_before: string | null; status: string }>("a", "SELECT not_before,status FROM channel_deliveries WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1", [c1]);
    assert.equal(waiting[0].status, "queued");
    assert.ok(waiting[0].not_before);
    await releaseDeferred(db.connect, "a");
    await drain();
    assert.equal(provider.outbox.length, sentBefore + 1, "not before its minute");
    await sql("a", "UPDATE channel_deliveries SET not_before=now()-interval '1 second' WHERE not_before IS NOT NULL");
    await sql("a", "DELETE FROM email_send_counts");
    await releaseDeferred(db.connect, "a");
    await drain();
    assert.equal(provider.outbox.length, sentBefore + 2);
    assert.equal((await lastSent()).text.startsWith("Second."), true);
    await agent("email-settings", { action: "rate", brandId: "default", perMinute: 600 });

    // A file sent by a teammate goes as an attachment.
    const fileId = crypto.randomUUID();
    await storage.putClean(`a/${fileId}/clean`, new TextEncoder().encode("%PDF-1.4 label"), "application/pdf", "label.pdf");
    await sql(
      "a",
      "INSERT INTO attachments(workspace_id,id,conversation_id,object_key,name,size,mime,status,clean_key,audience,purpose) VALUES('a',$1,$2,$3,'label.pdf',14,'application/pdf','clean',$4,'customer_visible','part')",
      [fileId, c1, `a/${fileId}/quarantine`, `a/${fileId}/clean`],
    );
    await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", c1), { type: "teammate", id: "owner" }, "attachment", "", { attachmentId: fileId, name: "label.pdf" }));
    await drain();
    assert.deepEqual((await lastSent()).attachments, [{ name: "label.pdf", mime: "application/pdf", size: 14 }]);

    // The provider refuses (not retried); the provider is down (retried, then sent).
    provider.refuse.add("robin@customer.example");
    await reply(c1, "Refused one.");
    assert.deepEqual((await deliveries(c1)).at(-1)!.status, "failed");
    assert.equal((await deliveries(c1)).at(-1)!.error, "The provider refused it (MessageRejected).");
    provider.refuse.clear();
    provider.state.fail = true;
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "reply", conversationId: c1, text: "Down then up." }));
    const job = (await sql<{ id: string }>("a", "SELECT id FROM jobs WHERE kind='channel.deliver' AND state='queued' ORDER BY created_at DESC LIMIT 1"))[0];
    await runJob(db.connect, "a", job.id, handlers);
    assert.equal((await deliveries(c1)).at(-1)!.status, "queued");
    provider.state.fail = false;
    await sql("a", "UPDATE jobs SET lease_until=NULL WHERE id=$1", [job.id]);
    await drain();
    assert.equal((await deliveries(c1)).at(-1)!.status, "sent");

    // SES's reports, through SNS: signed, for this topic, each once. Delivered; a hard bounce fails
    // the delivery and suppresses the address; a complaint suppresses it; a bad signature is refused.
    const report = async (kind: "Delivery" | "Bounce" | "Complaint", m = provider.outbox.at(-1)!, permanent = true, id?: string) =>
      hook(await sns.notification(sesEvent(kind, m, permanent), id));
    let r = await report("Delivery", provider.outbox.at(-1)!, true, "sns-1");
    assert.deepEqual([r.status, ((await r.json()) as { applied: boolean }).applied], [200, true]);
    assert.equal((await deliveries(c1)).at(-1)!.status, "delivered");
    r = await report("Delivery", provider.outbox.at(-1)!, true, "sns-1");
    assert.equal(((await r.json()) as { reason: string }).reason, "Already applied.");
    const forged = { ...(await sns.notification(sesEvent("Bounce", provider.outbox.at(-1)!))), Signature: btoa("forged") };
    assert.equal((await hook(forged)).status, 403);
    assert.equal((await hook({ hello: "world" })).status, 400);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM suppressions"))[0].n, 0);
    await report("Bounce", provider.outbox.at(-1)!, false);
    assert.equal((await deliveries(c1)).at(-1)!.status, "failed", "a soft bounce fails it");
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM suppressions"))[0].n, 0, "but suppresses nothing");
    await receive(mail({ id: "k-1@customer.example", from: "kim@customer.example", subject: "Complaint test", text: "Hello" }));
    const ck = await latestConversation();
    await reply(ck, "Hello Kim.");
    await report("Complaint");
    await receive(mail({ id: "j-1@customer.example", from: "jo@customer.example", subject: "Bounce test", text: "Hello" }));
    const cj = await latestConversation();
    await reply(cj, "Hello Jo.");
    await report("Bounce");
    assert.deepEqual((await deliveries(cj)).at(-1)!.error, "It couldn't be delivered: smtp; 550 5.1.1 user unknown");
    assert.deepEqual(
      await sql("a", "SELECT address,reason FROM suppressions ORDER BY address"),
      [
        { address: "jo@customer.example", reason: "hard_bounce" },
        { address: "kim@customer.example", reason: "complaint" },
      ],
    );
    // Without a topic, the route isn't there.
    assert.equal((await handleApi(new Request("https://relay.test/v1/hooks/ses", { method: "POST", body: "{}" }), { ...env, sesReports: undefined })).status, 404);

    // Reputation: each domain's sent, delivered, bounces and complaints.
    const reputation = (await agent("email-settings")).body.reputation as { domain: string; days: number; sent: number; delivered: number; bounces: number; complaints: number; standing: string }[];
    const acme = reputation.find((x) => x.domain === "acme.example" && x.days === 30)!;
    assert.deepEqual([acme.delivered, acme.bounces, acme.complaints, acme.standing], [1, 1, 1, "too_few"]);
    // Sent from acme.example: seven (the one the provider refused was never sent).
    assert.equal(acme.sent, 7);
    assert.deepEqual((await agent("email-settings", undefined, "owner-b", "b")).body.reputation, [], "another workspace's figures are its own");

    // Away emails: a messenger customer who hasn't read a reply gets one email (not the internal
    // note, ever); with the brand's switch on, the replies themselves. Read ones get nothing.
    assert.equal((await agent("email-settings", { action: "away", brandId: "default", enabled: true, content: false, minutes: 0 })).body.error.code, "INVALID_EMAIL_SETTINGS");
    const ada = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "user", "ada-1", { name: "Ada", email: "ada@customer.example" }));
    const started = (await tenant(db.connect, "a", (q) =>
      command(q, "a", { type: "contact", identityId: ada.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text: "Hello from the website" }),
    )) as { conversationId: string };
    const cm = started.conversationId;
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "note", conversationId: cm, text: "SECRET internal note" }));
    await reply(cm, "Your refund is on its way.");
    assert.deepEqual(await deliveries(cm), [], "a messenger reply isn't emailed at once");
    await checkAwayEmails(db.connect, "a");
    assert.deepEqual(await deliveries(cm), [], "not before the brand's minutes");
    // Parts are append-only, so the sweep is asked as of 20 minutes from now.
    const later = () => new Date(Date.now() + 20 * 60_000);
    await checkAwayEmails(db.connect, "a", later());
    await checkAwayEmails(db.connect, "a", later());
    await drain();
    assert.deepEqual(
      (await deliveries(cm)).map((d) => [d.purpose, d.status, d.address]),
      [["away", "sent", "ada@customer.example"]],
    );
    out = await lastSent();
    assert.equal(out.headers["auto-submitted"], "auto-generated");
    assert.match(out.text, /^You have a new reply from Relay\./);
    assert.doesNotMatch(out.text + out.html, /refund is on its way|SECRET/);
    await agent("email-settings", { action: "away", brandId: "default", enabled: true, content: true, minutes: 10 });
    await reply(cm, "Tracking number: 1Z999.");
    await checkAwayEmails(db.connect, "a", later());
    await drain();
    out = await lastSent();
    assert.match(out.text, /You have 2 new replies from Relay\.[\s\S]*Support from Relay:\nYour refund is on its way\.[\s\S]*Tracking number: 1Z999\./);
    assert.doesNotMatch(out.text + out.html, /SECRET/);
    // Read: nothing more.
    await reply(cm, "Anything else?");
    const lastSeq = (await sql("a", "SELECT max(seq) AS s FROM conversation_parts WHERE conversation_id=$1", [cm]))[0].s;
    await sql(
      "a",
      `INSERT INTO customer_reads(workspace_id,identity_id,conversation_id,latest_reply_seq,read_seq) VALUES('a',$1,$2,$3,$3)
       ON CONFLICT (workspace_id,identity_id,conversation_id) DO UPDATE SET read_seq=$3`,
      [ada.identityId, cm, lastSeq],
    );
    await checkAwayEmails(db.connect, "a", later());
    assert.equal((await deliveries(cm)).length, 2);

    // The acceptance: a suppressed address is sent nothing through any path (a teammate's reply, a
    // workflow's message, Zoe's reply, a file, an away email).
    await agent("suppression", { action: "add", channel: "email", address: "Robin@customer.example" });
    await agent("suppression", { action: "add", channel: "email", address: "ada@customer.example" });
    const before = provider.outbox.length;
    await reply(c1, "Teammate's reply");
    const flow = await agent("workflow", {
      action: "create",
      name: "Say thanks",
      definition: { trigger: { type: "note_added" }, paths: [{ id: "A", label: "", steps: [{ id: "s", type: "message", options: { text: "Workflow's message" } }], next: { type: "end" } }] },
    });
    await agent("workflow", { action: "publish", id: flow.body.workflow.id, version: flow.body.workflow.version });
    const flowJobs = { ...handlers };
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "note", conversationId: c1, text: "Thanking them" }));
    const { startWorkflows } = await import("../server/workflow-engine");
    for (const j of await sql<{ id: string }>("a", "SELECT id FROM jobs WHERE kind='workflow.start' AND state='queued'"))
      await runJob(db.connect, "a", j.id, { ...flowJobs, "workflow.start": (x: Job) => startWorkflows(db.connect, x) });
    await tenant(db.connect, "a", async (q) => {
      const c = await conversation(q, "a", c1);
      await append(q, "a", c, { type: "ai", id: "zoe" }, "ai_reply", "Zoe's reply", {});
      await append(q, "a", c, { type: "teammate", id: "owner" }, "attachment", "", { attachmentId: fileId, name: "label.pdf" });
    });
    await reply(cm, "One more for Ada.");
    await sql("a", "UPDATE customer_reads SET read_seq=0 WHERE conversation_id=$1", [cm]);
    await checkAwayEmails(db.connect, "a", later());
    await drain();
    const blocked = await sql<{ status: string; purpose: string; body: string; kind: string }>(
      "a",
      `SELECT d.status,d.purpose,p.body,p.kind FROM channel_deliveries d JOIN conversation_parts p ON p.workspace_id=d.workspace_id AND p.id=d.part_id
       WHERE d.created_at>(SELECT max(created_at) FROM suppressions) ORDER BY d.created_at,p.seq`,
    );
    assert.deepEqual(
      blocked.map((d) => [d.kind, d.purpose, d.status]),
      [
        ["teammate_reply", "reply", "suppressed"],
        ["workflow_message", "reply", "suppressed"],
        ["ai_reply", "reply", "suppressed"],
        ["attachment", "reply", "suppressed"],
        ["teammate_reply", "away", "suppressed"],
      ],
    );
    assert.equal(provider.outbox.length, before, "nothing was sent");

    // The rollback: email deliveries not yet sent fail; nothing is sent after it.
    await agent("suppression", { action: "lift", id: (await sql("a", "SELECT id FROM suppressions WHERE address='robin@customer.example'"))[0].id });
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "reply", conversationId: c1, text: "After the rollback." }));
    const rollback = readFileSync("db/rollback/0064_email_out.sql", "utf8");
    for (const statement of rollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await sql("a", statement);
    await drain();
    assert.deepEqual((await deliveries(c1)).at(-1), { status: "failed", error: "Stopped by rollback.", domain: null, purpose: "reply", address: "robin@customer.example" });
    assert.equal(provider.outbox.length, before);
  } finally {
    await db.close();
  }
});

test("domain records: what a brand adds at its DNS provider", () => {
  const records = domainRecords("acme.example", "tok", ["a1", "b2", "c3"], "eu-west-2");
  assert.deepEqual(
    records.map((r) => [r.type, r.name, r.value]),
    [
      ["TXT", "_relay.acme.example", "relay-domain=tok"],
      ["CNAME", "a1._domainkey.acme.example", "a1.dkim.amazonses.com"],
      ["CNAME", "b2._domainkey.acme.example", "b2.dkim.amazonses.com"],
      ["CNAME", "c3._domainkey.acme.example", "c3.dkim.amazonses.com"],
      ["MX", "bounce.acme.example", "10 feedback-smtp.eu-west-2.amazonses.com"],
      ["TXT", "bounce.acme.example", "v=spf1 include:amazonses.com ~all"],
      ["TXT", "_dmarc.acme.example", "v=DMARC1; p=none;"],
    ],
  );
});
