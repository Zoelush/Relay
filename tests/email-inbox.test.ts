import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { append, command, conversation } from "../server/conversations";
import { runJob, type Job } from "../server/jobs";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { runDelivery } from "../server/channels";
import { acceptEmail, receiveEmailJob, type EmailEnvironment } from "../server/email-in";
import { sendAlert, type EmailOutEnvironment } from "../server/email-out";
import { notify } from "../server/zoe-monitors";
import { startWorkflows, resumeWorkflow } from "../server/workflow-engine";
import { validate } from "../lib/workflow-definition";
import { localAttachmentStorage } from "../scripts/local-storage";
import { localEmailProvider } from "../scripts/local-email";

/**
 * Email in the inbox (phase 12, E4; docs/OMNICHANNEL_STEP4.md): Cc and Bcc on replies, side
 * conversations with third parties, the workflow trigger and step, Zoe on email (drafts held for
 * approval, answers, and whom she won't answer), and incident alerts by email.
 */
const DOMAIN = "inbound.relay.test";

test("email in the inbox: copies, side conversations, workflows, Zoe on email and incident alerts", async () => {
  const db = await testDatabase();
  const storage = localAttachmentStorage().storage;
  const provider = localEmailProvider();
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
  };
  const emailIn: EmailEnvironment = { storage, domain: DOMAIN, trustedAuthServ: ["mx.cloudflare.net"] };
  const emailOut: EmailOutEnvironment = { sender: provider.sender, dns: provider.dns, storage, inboundDomain: DOMAIN, sendingDomain: DOMAIN, region: "eu-west-2" };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "email.receive": (j: Job) => receiveEmailJob(db.connect, emailIn, j),
    "channel.deliver": (j: Job) => runDelivery(db.connect, { providers: { email: emailOut } }, j),
    "email.alert": (j: Job) => sendAlert(db.connect, emailOut, j),
    "workflow.start": (j: Job) => startWorkflows(db.connect, j),
    "workflow.resume": (j: Job) => resumeWorkflow(db.connect, j),
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
  const mail = (o: { id: string; from: string; subject: string; text: string; cc?: string; inReplyTo?: string; verified?: boolean; headers?: Record<string, string> }) =>
    new TextEncoder().encode(
      [
        `From: ${o.from}`,
        "To: help@acme.example",
        ...(o.cc ? [`Cc: ${o.cc}`] : []),
        `Subject: ${o.subject}`,
        "Date: Wed, 14 Oct 2026 10:00:00 +0000",
        `Message-ID: <${o.id}>`,
        ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`] : []),
        ...(o.verified ? [`Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=${o.from.replace(/.*@([^>]+)>?$/, "$1")}`] : []),
        ...Object.entries(o.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
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
  const latest = async () => (await sql<{ conversation_id: string; part_id: string }>("a", "SELECT conversation_id,part_id FROM email_inbound ORDER BY received_at DESC,id LIMIT 1"))[0];
  const reply = (conversationId: string, text: string, email?: unknown) =>
    agent("command", { action: "reply", conversationId, text, ...(email ? { email } : {}) });
  const lastSent = async () => provider.read(provider.outbox.at(-1)!);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
      );
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE name IN ('channels_v1','channel_email_v1','workflows_v1','ai_agent_v1','zoe_monitors_v1')");
      assert.equal((await agent("email-settings", undefined, "owner-" + w, w)).status, 200);
      await sql(w, "UPDATE email_settings SET token='hello' WHERE brand_id='default'");
    }

    // Copies: the customer's Cc is offered again (never the brand's own address); a teammate's Cc
    // and Bcc go out (Bcc never in the message), a suppressed copy is left out, and bad ones refused.
    await receive(mail({ id: "c-1@customer.example", from: "Robin <robin@customer.example>", cc: "Lee <lee@customer.example>", subject: "Damaged order", text: "It arrived broken." }));
    const c1 = (await latest()).conversation_id;
    const target = (await agent(`reply-target?conversation=${c1}`)).body.target;
    assert.deepEqual([target.copies, target.cc], [true, "lee@customer.example"]);
    await agent("suppression", { action: "add", channel: "email", address: "blocked@customer.example" });
    const sent = await reply(c1, "We're sending another.", { cc: ["lee@customer.example", "blocked@customer.example"], bcc: ["manager@acme.example"] });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    await drain();
    let out = await lastSent();
    assert.deepEqual([provider.outbox.at(-1)!.cc, provider.outbox.at(-1)!.bcc], [["lee@customer.example"], ["manager@acme.example"]]);
    assert.equal(out.headers.cc, "lee@customer.example");
    assert.equal(out.headers.bcc, undefined, "a blind copy is never in the message");
    assert.equal((await reply(c1, "Bad", { cc: ["not an address"] })).body.error.code, "INVALID_COPIES");
    // A messenger conversation can't copy anyone in.
    const ada = await tenant(db.connect, "a", (q) => getIdentity(q, "a", "user", "ada-1", { name: "Ada", email: "ada@customer.example" }));
    const cm = (
      (await tenant(db.connect, "a", (q) =>
        command(q, "a", { type: "contact", identityId: ada.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text: "Hello from the website" }),
      )) as { conversationId: string }
    ).conversationId;
    assert.equal((await reply(cm, "Hi", { cc: ["lee@customer.example"] })).body.error.code, "COPIES_UNSUPPORTED");
    assert.equal((await agent(`reply-target?conversation=${cm}`)).body.target, null);

    // Side conversations: a teammate emails a supplier about the conversation. It's internal (the
    // customer is sent nothing), has its own reply address, and the supplier's answers come back
    // into the conversation's timeline, by that address or by In-Reply-To.
    const customerSends = provider.outbox.filter((m) => m.to === "robin@customer.example").length;
    assert.equal((await agent("side-conversation", { action: "start", conversationId: c1, to: [], subject: "Replacement", text: "Hi" })).body.error.code, "INVALID_SIDE_CONVERSATION");
    const started = await agent("side-conversation", { action: "start", conversationId: c1, to: ["Orders@Supplier.example"], subject: "Replacement for order 4411", text: "Can you ship a replacement today?" });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    await drain();
    out = await lastSent();
    assert.deepEqual([out.to, out.subject, out.inReplyTo], ["orders@supplier.example", "Replacement for order 4411", ""]);
    assert.match(out.replyTo, /^a\+s-[a-z0-9]{20}@/);
    assert.doesNotMatch(out.text + out.html, /arrived broken/, "nothing of the customer's goes to a third party");
    const sidePart = (await sql("a", "SELECT audience,kind,data->>'event' AS event FROM conversation_parts WHERE id=$1", [started.body.partId]))[0];
    assert.deepEqual(sidePart, { audience: "internal", kind: "system_event", event: "side_conversation" });
    const ourSideId = out.messageId.replace(/[<>]/g, "");
    await receive(mail({ id: "s-1@supplier.example", from: "Orders <orders@supplier.example>", subject: "Re: Replacement for order 4411", text: "Shipping today." }), out.replyTo);
    let answer = await latest();
    assert.equal(answer.conversation_id, c1);
    assert.deepEqual(
      (await sql("a", "SELECT kind,audience,author_type,data->>'direction' AS direction FROM conversation_parts WHERE id=$1", [answer.part_id]))[0],
      { kind: "system_event", audience: "internal", author_type: "system", direction: "in" },
    );
    assert.equal((await agent(`email-message?part=${answer.part_id}`)).body.from.address, "orders@supplier.example");
    await receive(mail({ id: "s-2@supplier.example", from: "orders@supplier.example", subject: "Tracking", text: "Tracking 1Z999.", inReplyTo: ourSideId }));
    answer = await latest();
    assert.equal(answer.conversation_id, c1, "a reply to its message, at the brand's address, joins it too");
    assert.equal((await sql("a", "SELECT data->>'direction' AS d FROM conversation_parts WHERE id=$1", [answer.part_id]))[0].d, "in");
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM conversations"))[0].n, 2, "no conversation is opened for the supplier");
    const again = await agent("side-conversation", { action: "reply", sideId: started.body.sideId, text: "Thanks!" });
    await drain();
    out = await lastSent();
    assert.deepEqual([out.subject, out.inReplyTo], ["Re: Replacement for order 4411", "<s-2@supplier.example>"]);
    assert.equal(again.status, 200);
    assert.equal(provider.outbox.filter((m) => m.to === "robin@customer.example").length, customerSends, "the customer was sent nothing");
    const sides = (await agent(`side-conversations?conversation=${c1}`)).body.sideConversations;
    assert.deepEqual(sides.map((s: { subject: string; participants: string[]; messages: number }) => [s.subject, s.participants, s.messages]), [["Replacement for order 4411", ["orders@supplier.example"], 4]]);
    assert.equal((await agent(`side-conversations?conversation=${c1}`, undefined, "owner-b", "b")).status, 404);
    assert.equal((await agent("side-conversation", { action: "reply", sideId: started.body.sideId, text: "x" }, "owner-b", "b")).status, 404);

    // Workflows: "A customer emails" fires for email (not the messenger, not automatic mail); "Send
    // an email" emails the customer's address on a messenger conversation, or is skipped without one.
    assert.throws(() => validate({ trigger: { type: "email_received" }, paths: [{ id: "A", label: "", steps: [{ id: "s", type: "email", options: { subject: "a\nb", text: "x" } }], next: { type: "end" } }] }), /subject/);
    const flow = await agent("workflow", {
      action: "create",
      name: "Tag emails",
      definition: { trigger: { type: "email_received" }, paths: [{ id: "A", label: "", steps: [{ id: "n", type: "note", options: { text: "Emailed in" } }], next: { type: "end" } }] },
    });
    assert.equal(flow.status, 200, JSON.stringify(flow.body));
    await agent("workflow", { action: "publish", id: flow.body.workflow.id, version: flow.body.workflow.version });
    await receive(mail({ id: "w-1@customer.example", from: "kim@customer.example", subject: "Question", text: "Do you ship to Norway?" }));
    const cw = (await latest()).conversation_id;
    await receive(mail({ id: "w-2@customer.example", from: "kim@customer.example", subject: "Automatic reply: Question", text: "Away", inReplyTo: "w-1@customer.example", headers: { "Auto-Submitted": "auto-replied" } }));
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "contact", identityId: ada.identityId, brandId: "default" }, crypto.randomUUID(), { action: "reply", conversationId: cm, text: "Messenger message" }));
    await drain();
    const runs = await sql<{ conversation_id: string }>("a", "SELECT conversation_id FROM workflow_runs WHERE workflow_id=$1", [flow.body.workflow.id]);
    assert.deepEqual(runs.map((r) => r.conversation_id), [cw], "once, for the email only");
    await sql("a", "UPDATE workflows SET state='paused' WHERE id=$1", [flow.body.workflow.id]);
    const emailing = await agent("workflow", {
      action: "create",
      name: "Email the receipt",
      definition: {
        trigger: { type: "manual" },
        paths: [{ id: "A", label: "", steps: [{ id: "e", type: "email", options: { subject: "Your receipt", text: "Here's your receipt." } }], next: { type: "end" } }],
      },
    });
    assert.equal(emailing.status, 200, JSON.stringify(emailing.body));
    await agent("workflow", { action: "publish", id: emailing.body.workflow.id, version: emailing.body.workflow.version });
    const ran = await agent("workflow-run", { workflowId: emailing.body.workflow.id, conversationId: cm });
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    await drain();
    out = await lastSent();
    assert.deepEqual([out.to, out.subject], ["ada@customer.example", "Your receipt"]);
    assert.match(out.text, /^Here's your receipt\./);

    // Zoe on email: off by default (nothing queued); answering, she's queued for a verified sender
    // only, never for list mail; with drafts, her reply waits for a teammate, who sends or discards it.
    const zoeJobs = async () => (await sql("a", "SELECT count(*)::int AS n FROM jobs WHERE kind='ai.reply'"))[0].n;
    let before = await zoeJobs();
    await receive(mail({ id: "z-1@customer.example", from: "sam@customer.example", subject: "Opening hours", text: "When are you open?", verified: true }));
    assert.equal(await zoeJobs(), before, "off: she doesn't answer email");
    const ai = (await agent("ai-settings")).body;
    assert.equal(ai.agent.emailMode, "off");
    assert.equal(ai.email, true);
    assert.equal((await agent("ai-settings", { ...ai.agent, emailMode: "always", version: ai.agent.version })).body.error.code, "INVALID_AI_SETTINGS");
    const saved = await agent("ai-settings", { ...ai.agent, emailMode: "answer", version: ai.agent.version });
    assert.equal(saved.body.agent.emailMode, "answer", JSON.stringify(saved.body));
    before = await zoeJobs();
    await receive(mail({ id: "z-2@customer.example", from: "sam@customer.example", subject: "Returns", text: "How do returns work?", verified: true }));
    assert.equal(await zoeJobs(), before + 1, "a verified sender: queued");
    await receive(mail({ id: "z-3@customer.example", from: "pat@customer.example", subject: "Returns", text: "How do returns work?" }));
    assert.equal(await zoeJobs(), before + 1, "an unverified sender: not");
    await receive(mail({ id: "z-4@customer.example", from: "news@customer.example", subject: "Our news", text: "News", verified: true, headers: { "List-Id": "<news.customer.example>" } }));
    assert.equal(await zoeJobs(), before + 1, "list mail: not");
    await agent("ai-settings", { ...saved.body.agent, emailMode: "approve", version: saved.body.agent.version });
    const zc = (await sql<{ conversation_id: string }>("a", "SELECT conversation_id FROM email_inbound WHERE envelope_to LIKE 'a+hello%' AND kind='message' ORDER BY received_at DESC,id LIMIT 1 OFFSET 2"))[0].conversation_id;
    const draft = await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", zc), { type: "ai", id: "default" }, "ai_reply", "Returns are free within 30 days.", {}));
    await drain();
    const held = (await agent(`deliveries?conversation=${zc}`)).body.deliveries.find((d: { partId: string }) => d.partId === draft.id);
    assert.equal(held.status, "held");
    const heldSends = provider.outbox.length;
    assert.equal((await agent("delivery", { action: "approve", deliveryId: held.id }, "owner-b", "b")).status, 404, "another workspace can't send it");
    assert.equal((await agent("delivery", { action: "approve", deliveryId: held.id })).status, 200);
    assert.equal((await agent("delivery", { action: "discard", deliveryId: held.id })).body.error.code, "DELIVERY_DECIDED");
    await drain();
    assert.equal(provider.outbox.length, heldSends + 1);
    assert.match((await lastSent()).text, /^Returns are free within 30 days\./);
    const second = await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", zc), { type: "ai", id: "default" }, "ai_reply", "Anything else?", {}));
    const held2 = (await agent(`deliveries?conversation=${zc}`)).body.deliveries.find((d: { partId: string }) => d.partId === second.id);
    assert.equal((await agent("delivery", { action: "discard", deliveryId: held2.id })).status, 200);
    await drain();
    assert.equal(provider.outbox.length, heldSends + 1, "discarded: not sent");
    assert.match((await agent(`deliveries?conversation=${zc}`)).body.deliveries.find((d: { id: string }) => d.id === held2.id).error, /^Discarded by .+: not sent\.$/);
    assert.equal((await sql("a", "SELECT ai_state FROM conversations WHERE id=$1", [zc]))[0].ai_state, "escalated", "the team has it");

    // Incident alerts by email: to the addresses set (up to five), past the suppression list.
    assert.equal((await agent("zoe-monitors", { action: "alerts", addresses: ["a@x.example", "b@x.example", "c@x.example", "d@x.example", "e@x.example", "f@x.example"] })).status, 400);
    const alerts = await agent("zoe-monitors", { action: "alerts", addresses: ["Ops@Acme.example", "blocked@customer.example"] });
    assert.deepEqual(alerts.body.alerts, { email: true, addresses: ["ops@acme.example", "blocked@customer.example"] });
    await tenant(db.connect, "a", async (q) => {
      await q.query(
        "INSERT INTO ai_incidents(workspace_id,id,agent_id,metric,baseline,opened_value,latest_value,worst_value,volume) VALUES('a','inc-1','default','handover_rate',0.1,0.4,0.4,0.4,50)",
      );
      await notify(q, "a", "inc-1", "Handovers went from 10% to 40%");
      await notify(q, "a", "inc-1", "again");
    });
    await drain();
    assert.deepEqual(
      await sql("a", "SELECT address,status FROM email_alerts ORDER BY address"),
      [
        { address: "blocked@customer.example", status: "suppressed" },
        { address: "ops@acme.example", status: "sent" },
      ],
    );
    out = await lastSent();
    assert.deepEqual([out.to, out.subject, out.from], ["ops@acme.example", "Zoe incident: Handover rate", `no-reply@${DOMAIN}`]);

    // The rollback: Zoe stops answering email, held drafts and unsent side messages fail, workflows
    // using email are paused.
    const lastHeld = await tenant(db.connect, "a", async (q) => append(q, "a", await conversation(q, "a", zc), { type: "ai", id: "default" }, "ai_reply", "Held at rollback", {}));
    await sql("a", "UPDATE workflows SET state='live' WHERE id=$1", [flow.body.workflow.id]);
    const rollback = readFileSync("db/rollback/0065_email_inbox.sql", "utf8");
    for (const statement of rollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await sql("a", statement);
    assert.equal((await sql("a", "SELECT email_mode FROM ai_agents"))[0].email_mode, "off");
    assert.deepEqual((await sql("a", "SELECT status,error FROM channel_deliveries WHERE part_id=$1", [lastHeld.id]))[0], { status: "failed", error: "Stopped by rollback." });
    assert.deepEqual(
      (await sql("a", "SELECT id,state FROM workflows WHERE id=ANY($1::text[]) ORDER BY name", [[flow.body.workflow.id, emailing.body.workflow.id]])).map((r) => r.state),
      ["paused", "paused"],
    );
  } finally {
    await db.close();
  }
});
