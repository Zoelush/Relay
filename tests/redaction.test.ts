import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { runJob, type Job } from "../server/jobs";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { saveDraft } from "../server/drafts";
import { runDelivery } from "../server/channels";
import { attachmentScan } from "../server/attachments";
import { acceptEmail, receiveEmailJob, type EmailEnvironment } from "../server/email-in";
import { memoryVectorStore, runIndex, scheduleIndex, testEmbedder, type IndexEnvironment } from "../server/knowledge-index";
import { standInAnswerModel, standInClassifier, type AnswerModel, type AnswerRequest, type RerankPort } from "../server/ai-model";
import { runAiReply, type AiEnvironment } from "../server/ai-agent";
import { readDataProtection, scrubPayload } from "../server/redaction";
import { checkPattern, redactor } from "../lib/redaction";
import { localAttachmentStorage } from "../scripts/local-storage";

/**
 * Content redaction and model-provider controls (phase 16, C6b; docs/SECURITY_STEP10.md).
 */
test("redaction: the built-in detectors find valid numbers only, and keep the length", () => {
  const all = redactor([
    { kind: "builtin", builtin: "card" },
    { kind: "builtin", builtin: "iban" },
    { kind: "builtin", builtin: "us_ssn" },
    { kind: "builtin", builtin: "uk_ni" },
  ]);
  assert.equal(all.text("Card 4111 1111 1111 1111, thanks"), "Card *******************, thanks");
  assert.equal(all.text("Card 4111-1111-1111-1111"), "Card *******************");
  assert.equal(all.text("Order 4111 1111 1111 1112 (not a card: Luhn fails)"), "Order 4111 1111 1111 1112 (not a card: Luhn fails)");
  assert.equal(all.text("IBAN GB82 WEST 1234 5698 7654 32."), "IBAN ***************************.");
  assert.equal(all.text("IBAN GB83 WEST 1234 5698 7654 32."), "IBAN GB83 WEST 1234 5698 7654 32.", "mod 97 fails");
  assert.equal(all.text("SSN 123-45-6789; not 000-12-3456 or 123-00-4567"), "SSN ***********; not 000-12-3456 or 123-00-4567");
  assert.equal(all.text("NI AB 12 34 56 C and ab123456c"), "NI ************* and *********");
  assert.equal(all.text("NI DQ 12 34 56 C"), "NI DQ 12 34 56 C", "D can't start one");
  assert.equal(all.text("NI QQ 12 34 56 C"), "NI QQ 12 34 56 C", "QQ is only ever an example");
  assert.equal(all.text("Order 1042, phone 020 7946 0958"), "Order 1042, phone 020 7946 0958");
  assert.ok(all.hits() >= 6);

  // HTML: only text between tags; JSON: every string; a rich doc: only its text nodes.
  const card = redactor([{ kind: "builtin", builtin: "card" }]);
  assert.equal(card.html('<p title="4111111111111111">Card 4111111111111111</p>'), '<p title="4111111111111111">Card ****************</p>');
  assert.deepEqual(card.json({ Body: "4111111111111111", n: 4111111111111111, list: ["x 4111111111111111"] }), { Body: "****************", n: 4111111111111111, list: ["x ****************"] });
  assert.deepEqual(
    card.doc({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "4111111111111111" }, { type: "mention", attrs: { id: "4111111111111111" } }] }] }),
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "****************" }, { type: "mention", attrs: { id: "4111111111111111" } }] }] },
  );
  // No rules: nothing changes, and it's off.
  const none = redactor([]);
  assert.equal(none.on, false);
  assert.equal(none.text("4111111111111111"), "4111111111111111");
});

test("redaction: custom patterns are checked before they're used", () => {
  assert.equal(checkPattern("ACC-\\d{8}"), null);
  assert.equal(checkPattern("[A-Z]{3}-\\d+"), null);
  const refused: [unknown, RegExp][] = [
    ["", /Enter a pattern/],
    [7, /Enter a pattern/],
    ["a".repeat(201), /at most 200/],
    ["(a)\\1", /Back-references/],
    ["(?<x>a)\\k<x>", /Back-references/],
    ["a(?=b)", /Look-aheads/],
    ["(?<!a)b", /Look-aheads/],
    ["(a+)+$", /repeated group/],
    ["(\\d*)*x", /repeated group/],
    ["(a|ab)+c", /repeated group/],
    ["(\\w{2,})*!", /repeated group/],
    ["[a-", /valid regular expression/],
    ["a*", /matches empty text/],
    ["x?", /matches empty text/],
  ];
  for (const [pattern, reason] of refused) assert.match(checkPattern(pattern) ?? "accepted", reason, String(pattern));
  const acc = redactor([{ kind: "custom", pattern: "ACC-\\d{8}" }]);
  assert.equal(acc.text("Account ACC-12345678 and ACC-1234"), "Account ************ and ACC-1234");
});

test("redaction: what's stored is redacted (messages, search, email, drafts, payloads), failed raw email goes, Zoe's history and controls, permissions, per workspace, rollback", async () => {
  const db = await testDatabase();
  const files = localAttachmentStorage();
  const storage = files.storage;
  const index: IndexEnvironment = { embedders: [testEmbedder()], vectors: memoryVectorStore() };
  const seen: AnswerRequest[] = [];
  const base = standInAnswerModel();
  const spy: AnswerModel = {
    model: "spy",
    async answer(r) {
      seen.push(r);
      return base.answer(r);
    },
  };
  const rerank: RerankPort = { model: "fixed", score: async (_q, texts) => texts.map(() => 0.9) };
  const ai: AiEnvironment = { model: spy, rerank, index, classify: standInClassifier() };
  const DOMAIN = "inbound.relay.test";
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    attachments: storage,
    emailDomain: DOMAIN,
    knowledgeIndex: index,
    ai,
  };
  const emailEnv: EmailEnvironment = { storage, domain: DOMAIN, trustedAuthServ: ["mx.cloudflare.net"] };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "knowledge.index": (j: Job) => runIndex(db.connect, index, j),
    "ai.reply": (j: Job) => runAiReply(db.connect, ai, j),
    "email.receive": (j: Job) => receiveEmailJob(db.connect, emailEnv, j),
    "attachment.scan": (j: Job) => attachmentScan(db.connect, storage, j),
    "channel.deliver": (j: Job) => runDelivery(db.connect, {}, j),
  };
  const drain = async (w = "a") => {
    for (let i = 0; i < 100; i++) {
      const job = (await sql<{ id: string }>(w, "SELECT id FROM jobs WHERE kind IN ('knowledge.index','ai.reply','email.receive','attachment.scan','channel.deliver') AND state IN ('queued','running') ORDER BY created_at LIMIT 1"))[0];
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
      { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: workspace, RELAY_BRIDGE_SECRET: env.bridgeSecret },
      (r) => handleApi(r, env),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  let n = 0;
  const start = async (text: string, w = "a") =>
    tenant(db.connect, w, async (q) => {
      const who = await getIdentity(q, w, "user", "ada-" + ++n, { name: "Ada", email: `ada${n}@customer.example` });
      const r = (await command(q, w, { type: "contact", identityId: who.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text } as unknown as Parameters<typeof command>[4])) as {
        conversationId: string;
      };
      return { id: r.conversationId, identityId: who.identityId };
    });
  const say = (c: { id: string; identityId: string }, text: string) =>
    tenant(db.connect, "a", (q) => command(q, "a", { type: "contact", identityId: c.identityId, brandId: "default" }, crypto.randomUUID(), { action: "reply", conversationId: c.id, text } as unknown as Parameters<typeof command>[4]));
  const CARD = "4111 1111 1111 1111";
  const STARS = "*".repeat(CARD.length);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) => seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await sql(w, "UPDATE workspace_features SET enabled=true");
      await sql(w, "DELETE FROM calendar_assignments");
    }
    await sql("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");

    // Off by default: the page lists the built-ins, all off, and Zoe's defaults.
    const initial = (await agent("data-protection")).body;
    assert.deepEqual(initial.builtIns.map((b: { id: string; enabled: boolean }) => [b.id, b.enabled]), [["card", false], ["iban", false], ["us_ssn", false], ["uk_ni", false]]);
    assert.deepEqual(initial.custom, []);
    assert.deepEqual(initial.model, { redactPersonalData: false, memory: false, historyMessages: 10 });
    const before = await start(`My card is ${CARD}`);
    assert.equal((await sql("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND body<>'' ORDER BY seq LIMIT 1", [before.id]))[0].body, `My card is ${CARD}`);

    // A preview saves nothing; an unsafe pattern is refused with its reason.
    assert.deepEqual((await agent("data-protection", { action: "try", builtin: "card", sample: `Card ${CARD}` })).body, { result: `Card ${STARS}` });
    assert.deepEqual((await agent("data-protection", { action: "try", pattern: "ACC-\\d{8}", sample: "ACC-12345678" })).body, { result: "************" });
    const unsafe = await agent("data-protection", { action: "custom-add", name: "Bad", pattern: "(a+)+$" });
    assert.equal(unsafe.status, 400);
    assert.match(unsafe.body.error.message, /repeated group/);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM redaction_rules"))[0].n, 0);

    // Turned on: cards and a custom pattern.
    const on = await agent("data-protection", { action: "builtin", builtin: "card", on: true });
    assert.equal(on.status, 200, JSON.stringify(on.body));
    const added = await agent("data-protection", { action: "custom-add", name: "Account numbers", pattern: "ACC-\\d{8}" });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.deepEqual(added.body.custom.map((c: { name: string; enabled: boolean }) => [c.name, c.enabled]), [["Account numbers", true]]);
    assert.ok((await sql("a", "SELECT action FROM audit_events WHERE target_type='redaction_rule'")).length >= 2, "changes are audited");

    // A message: its body and its search document are redacted; the earlier one isn't rewritten.
    const after = await start(`My card is ${CARD}, account ACC-12345678`);
    const [part] = await sql<{ id: string; body: string }>("a", "SELECT id,body FROM conversation_parts WHERE conversation_id=$1 AND body<>'' ORDER BY seq LIMIT 1", [after.id]);
    assert.equal(part.body, `My card is ${STARS}, account ************`);
    const words = (await sql<{ d: string }>("a", "SELECT document::text AS d FROM conversation_search_documents WHERE part_id=$1", [part.id]))[0].d;
    assert.ok(!/4111|12345678/.test(words), words);
    await say(after, `And again ${CARD}`);
    assert.equal((await sql("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND body LIKE 'And again%'", [after.id]))[0].body, `And again ${STARS}`);
    assert.equal((await sql("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND body<>'' ORDER BY seq LIMIT 1", [before.id]))[0].body, `My card is ${CARD}`, "rules apply from now on");

    // Another workspace's rules are its own.
    const elsewhere = await start(`My card is ${CARD}`, "b");
    assert.equal((await sql("b", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND body<>'' ORDER BY seq LIMIT 1", [elsewhere.id]))[0].body, `My card is ${CARD}`);

    // A teammate's draft: its doc's text is redacted, mentions and marks untouched.
    const draft = await tenant(db.connect, "a", (q) =>
      saveDraft(q, "a", "owner-a", {
        mode: "reply",
        conversationId: after.id,
        baseVersion: null,
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Card ${CARD} noted` }] }] },
      }),
    );
    assert.equal(draft.conflict, false);
    const stored = (await sql<{ doc: unknown }>("a", "SELECT doc FROM conversation_drafts WHERE conversation_id=$1", [after.id]))[0];
    assert.ok(!JSON.stringify(stored.doc).includes("4111"), JSON.stringify(stored.doc));
    assert.match(JSON.stringify(stored.doc), new RegExp(`Card \\*{${CARD.length}} noted`));

    // Email in: subject, the part, the full text and the headers kept are redacted; the raw file goes.
    await sql("a", "INSERT INTO email_settings(workspace_id,brand_id,token) VALUES('a','default','hello')");
    const raw = new TextEncoder().encode(
      [
        "From: Ada <ada@customer.example>",
        "To: help@acme.example",
        `Subject: Card ${CARD}`,
        "Date: Tue, 13 Oct 2026 10:00:00 +0000",
        "Message-ID: <redact-1@customer.example>",
        `X-Account: ACC-12345678`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        `Please refund ${CARD}.`,
        "",
      ].join("\r\n"),
    );
    assert.equal((await acceptEmail(db.connect, emailEnv, { raw, to: `a+hello@${DOMAIN}`, from: "ada@customer.example" })).accepted, true);
    await drain();
    const [inbound] = await sql<{ status: string; part_id: string; raw_key: string }>("a", "SELECT status,part_id,raw_key FROM email_inbound ORDER BY received_at DESC LIMIT 1");
    assert.equal(inbound.status, "read");
    const [mail] = await sql<{ subject: string; text_full: string; headers: unknown }>("a", "SELECT subject,text_full,headers FROM email_messages WHERE part_id=$1", [inbound.part_id]);
    assert.equal(mail.subject, `Card ${STARS}`);
    assert.match(mail.text_full, new RegExp(`Please refund \\*{${CARD.length}}`));
    assert.ok(!JSON.stringify(mail.headers).includes("4111") && !JSON.stringify(mail.headers).includes("12345678"), JSON.stringify(mail.headers));
    const [emailPart] = await sql<{ body: string; data: { email: { subject: string } } }>("a", "SELECT body,data FROM conversation_parts WHERE id=$1", [inbound.part_id]);
    assert.ok(!emailPart.body.includes("4111"));
    assert.equal(emailPart.data.email.subject, `Card ${STARS}`);
    assert.equal(await storage.getQuarantine(inbound.raw_key), null);

    // A failed email's raw file isn't kept while a rule is on .
    const failedRaw = new TextEncoder().encode(
      ["From: Ada <ada@customer.example>", "To: help@acme.example", "Subject: Another", "Message-ID: <redact-2@customer.example>", "Content-Type: text/plain", "", `Card ${CARD}`, ""].join("\r\n"),
    );
    assert.equal((await acceptEmail(db.connect, emailEnv, { raw: failedRaw, to: `a+hello@${DOMAIN}`, from: "ada@customer.example" })).accepted, true);
    const [pending] = await sql<{ raw_key: string }>("a", "SELECT raw_key FROM email_inbound WHERE status='received'");
    assert.ok(await storage.getQuarantine(pending.raw_key), "kept until it's read");
    // Channels switched off between arrival and reading: the read fails.
    await sql("a", "UPDATE workspace_features SET enabled=false WHERE name='channels_v1'");
    await drain();
    assert.deepEqual((await sql("a", "SELECT status FROM email_inbound WHERE raw_key=$1", [pending.raw_key]))[0], { status: "failed" });
    assert.equal(await storage.getQuarantine(pending.raw_key), null, "a failed email's raw file goes too");
    await sql("a", "UPDATE workspace_features SET enabled=true WHERE name='channels_v1'");

    // A raw inbound payload, once read: every string redacted.
    await sql("a", "INSERT INTO sms_inbound(workspace_id,id,kind,payload,status) VALUES('a','sms-1','message',$1,'read')", [JSON.stringify({ Body: `Card ${CARD}`, From: "+447700900123" })]);
    await tenant(db.connect, "a", (q) => scrubPayload(q, "a", "sms_inbound", "sms-1"));
    assert.deepEqual((await sql("a", "SELECT payload FROM sms_inbound WHERE id='sms-1'"))[0].payload, { Body: `Card ${STARS}`, From: "+447700900123" });
    // ...and each channel calls it right after marking its payload read.
    for (const [file, table] of [
      ["server/sms.ts", "sms_inbound"],
      ["server/whatsapp.ts", "whatsapp_inbound"],
      ["server/meta-messaging.ts", "meta_inbound"],
      ["server/community.ts", "community_inbound"],
      ["server/voice.ts", "voice_inbound"],
    ]) {
      const source = await readFile(file, "utf8");
      const reads = source.split(`UPDATE ${table} SET status='read'`).length - 1;
      assert.ok(reads > 0, file);
      assert.equal(source.split(`scrubPayload(db, w, "${table}", inboundId)`).length - 1, reads, `${file}: every read is scrubbed`);
    }

    // Zoe: how many earlier messages she's sent, and the controls recorded with each call.
    await sql("a", "INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_help_center) VALUES('a','refunds','article','owner','public',true,false)");
    await sql(
      "a",
      `INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,published_title,published_text,published_revision,published_at) VALUES
       ('a','refunds','en','published','Refunds','Refunds','Refunds take five working days to reach the card you paid with.',1,now())`,
    );
    await scheduleIndex(db.connect, "a");
    await drain();
    const bad = await agent("data-protection", { action: "model", redactPersonalData: true, memory: false, historyMessages: 3 });
    assert.equal(bad.status, 400);
    const model = await agent("data-protection", { action: "model", redactPersonalData: true, memory: false, historyMessages: 0 });
    assert.deepEqual(model.body.model, { redactPersonalData: true, memory: false, historyMessages: 0 });
    const chat = await start("Hello there");
    await drain();
    seen.length = 0;
    await say(chat, "How long do refunds take?");
    await drain();
    assert.ok(seen.length > 0, "Zoe answered");
    assert.deepEqual(seen.at(-1)!.history, [], "no earlier messages sent");
    const [call] = await sql<{ controls: unknown }>("a", "SELECT controls FROM ai_model_calls WHERE conversation_id=$1 AND kind='answer' ORDER BY created_at DESC LIMIT 1", [chat.id]);
    assert.deepEqual(call.controls, { redactPersonalData: true, memory: false, historyMessages: 0, redactionRules: 2 });
    await agent("data-protection", { action: "model", redactPersonalData: true, memory: false, historyMessages: 5 });
    seen.length = 0;
    await say(chat, "And how long do refunds take to the card?");
    await drain();
    assert.ok(seen.at(-1)!.history.length > 0 && seen.at(-1)!.history.length <= 5);

    // Toggle and remove a custom pattern; another workspace's can't be reached.
    const custom = (await agent("data-protection")).body.custom[0].id as string;
    assert.equal((await agent("data-protection", { action: "custom-toggle", id: custom, on: false }, "owner-b", "b")).status, 404);
    assert.equal((await agent("data-protection", { action: "custom-toggle", id: custom, on: false })).body.custom[0].enabled, false);
    assert.equal((await agent("data-protection", { action: "custom-remove", id: custom })).body.custom.length, 0);

    // Permissions: an agent can't read or change it; another workspace's owner sees only theirs.
    assert.equal((await agent("data-protection", undefined, "agent-1-a")).status, 403);
    assert.equal((await agent("data-protection", { action: "builtin", builtin: "card", on: false }, "agent-1-a")).status, 403);
    assert.deepEqual((await agent("data-protection", undefined, "owner-b", "b")).body.builtIns.map((b: { enabled: boolean }) => b.enabled), [false, false, false, false]);
    await assert.rejects(tenant(db.connect, "b", (x) => readDataProtection(x, "b", "owner-a")));

    // The rollback: every rule off (new text stored as written; redacted text stays), history back to 10.
    await db.pg.exec(await readFile("db/rollback/0089_redaction.sql", "utf8"));
    const rolled = await tenant(db.connect, "a", (x) => readDataProtection(x, "a", "owner-a"));
    assert.ok(rolled.builtIns.every((b) => !b.enabled));
    assert.equal(rolled.model.historyMessages, 10);
    const later = await start(`Card ${CARD}`);
    assert.equal((await sql("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND body<>'' ORDER BY seq LIMIT 1", [later.id]))[0].body, `Card ${CARD}`);
    assert.equal((await sql("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND body<>'' ORDER BY seq LIMIT 1", [after.id]))[0].body, `My card is ${STARS}, account ************`);
  } finally {
    await db.close();
  }
});

test("logs: no console call is given a raw error or a request's body", async () => {
  const offenders: string[] = [];
  for (const dir of ["server", "workers", "app", "lib", "scripts"]) {
    let entries: string[] = [];
    try {
      entries = (await readdir(dir, { recursive: true })) as string[];
    } catch {
      continue;
    }
    for (const file of entries.filter((f) => /\.(ts|tsx)$/.test(f))) {
      const source = await readFile(`${dir}/${file}`, "utf8");
      for (const [i, line] of source.split("\n").entries()) {
        const call = line.match(/console\.(?:log|info|warn|error|debug)\((.*)/)?.[1]?.replace(/errorFingerprint\([^)]*\)/g, "");
        if (!call) continue;
        // A caught error (e, err, error) passed as itself, or a request body.
        if (/(?:^|[,(\s])(?:e|err|error|cause)\s*[,)]/.test(call) || /\b(?:body|payload|req(?:uest)?\.json)\b/.test(call)) offenders.push(`${dir}/${file}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "log errorFingerprint(e) instead");
});
