import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { runJob, type Job } from "../server/jobs";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { attachmentScan } from "../server/attachments";
import { runDelivery } from "../server/channels";
import { checkSmsAccountJob, connectSmsNumberJob, receiveSmsJob, type SmsEnvironment } from "../server/sms";
import { buyNumberJob, configureVoiceNumberJob, readRecordingJob, searchNumbersJob, startRecordingJob, type VoiceEnvironment } from "../server/voice";
import type { TranscriptionPort } from "../server/voice-transcribe";
import { memoryVectorStore, runIndex, scheduleIndex, testEmbedder, type IndexEnvironment } from "../server/knowledge-index";
import { standInAnswerModel, standInClassifier, standInReranker } from "../server/ai-model";
import { runAiReply, type AiEnvironment } from "../server/ai-agent";
import { speakable } from "../lib/voice";
import { localAttachmentStorage } from "../scripts/local-storage";
import { LOCAL_TWILIO, localSms } from "../scripts/local-sms";

/**
 * Voice (phase 12, E9; docs/OMNICHANNEL_STEP9.md): text made to be spoken; a call's signed steps
 * (consent by country, Zoe answering through her own pipeline, the silence policy, a warm transfer
 * with a whisper, voicemail); recordings stored for the team and transcribed; Settings › Voice,
 * buying a number; another workspace's calls; the rollback.
 */
test("speakable: links, marks and lists become plain sentences; numbers are said; long answers stop at a sentence", () => {
  assert.equal(speakable("See [our refunds page](https://acme.test/refunds) or https://acme.test/x."), "See our refunds page or the link on our website");
  assert.equal(speakable("**Order #4411** has shipped."), "Order number 4411 has shipped.");
  assert.equal(speakable("Steps:\n- Open Settings\n- Choose *API keys*\n1. Rotate."), "Steps: Open Settings. Choose API keys. Rotate.");
  const long = speakable(Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(" "));
  assert.ok(long.length <= 640);
  assert.match(long, /here\. Would you like me to go on\?$/);
});

test("voice: signed call steps, consent by country, Zoe on the phone, the silence policy, a warm transfer, voicemail, recordings and transcripts, Settings, buying a number", async () => {
  const db = await testDatabase();
  const storage = localAttachmentStorage().storage;
  const twilio = localSms();
  const key = "k".repeat(40);
  const ORIGIN = "https://relay.test";
  const index: IndexEnvironment = { embedders: [testEmbedder()], vectors: memoryVectorStore() };
  const ai: AiEnvironment = { model: standInAnswerModel(), rerank: standInReranker(), index, classify: standInClassifier() };
  const transcribed: number[] = [];
  const transcriber: TranscriptionPort = {
    async transcribe(audio) {
      transcribed.push(audio.length);
      return {
        text: "Hi, it's about order 4411.",
        segments: [
          { start: 0, end: 2.5, text: "Hi, it's about order 4411." },
          { start: 2.5, end: 64, text: "Thanks, I'll look now." },
        ],
      };
    },
  };
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    attachments: storage,
    connectors: { key },
    knowledgeIndex: index,
    ai,
    voice: { api: twilio.api },
  };
  const smsEnv: SmsEnvironment = { api: twilio.api, key, storage, hookOrigin: ORIGIN };
  const voiceEnv: VoiceEnvironment = { api: twilio.api, key, storage, transcriber };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "sms.receive": (j: Job) => receiveSmsJob(db.connect, smsEnv, j),
    "sms.check": (j: Job) => checkSmsAccountJob(db.connect, smsEnv, j),
    "sms.number": (j: Job) => connectSmsNumberJob(db.connect, smsEnv, j),
    "voice.record": (j: Job) => startRecordingJob(db.connect, voiceEnv, j),
    "voice.recording": (j: Job) => readRecordingJob(db.connect, voiceEnv, j),
    "voice.number": (j: Job) => configureVoiceNumberJob(db.connect, voiceEnv, j),
    "voice.search": (j: Job) => searchNumbersJob(db.connect, voiceEnv, j),
    "voice.buy": (j: Job) => buyNumberJob(db.connect, voiceEnv, j),
    "knowledge.index": (j: Job) => runIndex(db.connect, index, j),
    "ai.reply": (j: Job) => runAiReply(db.connect, ai, j),
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
  /** A call's step as Twilio makes it (signed over the exact URL, its query included, and the form); jobs run after. */
  const step = async (path: string, params: Record<string, string>, w = "a", token = LOCAL_TWILIO.token) => {
    const url = `${ORIGIN}/v1/hooks/voice/${w}/${path}`;
    const call = await twilio.signed(url, params, token);
    const r = await handleApi(new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": call.signature }, body: call.body }), env);
    const out = { status: r.status, type: r.headers.get("content-type"), xml: r.status === 204 ? "" : await r.text() };
    await drain(w);
    return out;
  };
  /** Where the TwiML sends the call next (its Redirect, a Gather's action, or a Dial's), relative to the hook. */
  const next = (xml: string) => {
    const m = /<Redirect method="POST">([^<]+)<\/Redirect>/.exec(xml);
    return m ? m[1].replace(/&amp;/g, "&").replace(`${ORIGIN}/v1/hooks/voice/a/`, "") : null;
  };
  const UK = LOCAL_TWILIO.numbers[0];
  const callOf = async (sid: string) => (await sql("a", "SELECT * FROM voice_calls WHERE call_sid=$1", [sid]))[0];
  const parts = (c: string) => sql<{ kind: string; body: string; audience: string; author_type: string; data: any }>("a", "SELECT kind,body,audience,author_type,data FROM conversation_parts WHERE conversation_id=$1 ORDER BY seq", [c]);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
      );
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE name IN ('channels_v1','channel_sms_v1','knowledge_v1','knowledge_index_v1','ai_agent_v1','settings_v1')");
    }
    // Zoe knows about refunds; office hours don't decide today's answers.
    await sql("a", "INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_help_center) VALUES('a','refunds','article','owner','public',true,false)");
    await sql(
      "a",
      "INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,published_title,published_text,published_revision,published_at) VALUES('a','refunds','en','published','Refunds','Refunds','Refunds take five working days to reach the card you paid with.',1,now())",
    );
    await scheduleIndex(db.connect, "a");
    await drain();
    await sql("a", "DELETE FROM calendar_assignments");
    await sql("a", "UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
    await sql("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id,presence) VALUES('a','grace','grace-a','Grace Hopper','agent','active')");
    // The Twilio account and its UK number (E6).
    await agent("sms-settings", { action: "connect", sid: LOCAL_TWILIO.sid, token: LOCAL_TWILIO.token });
    await drain();
    await agent("sms-settings", { action: "number", phone: UK, brandId: "default" });
    await drain();

    // Off by default: no page, and a call is told so (once signed).
    assert.equal((await agent("voice-settings")).status, 404);
    await sql("a", "UPDATE workspace_features SET enabled=true WHERE name='channel_voice_v1'");
    assert.equal((await agent("voice-settings", undefined, "grace-a")).status, 403, "managers only");

    // Settings: checked; the number takes calls (its calls pointed at Relay); teammates' phones.
    let settings = (await agent("voice-settings")).body;
    assert.deepEqual(settings.settings, { zoe: false, recordingDefault: "consent", recordingOverrides: {}, transcription: true, voicemailGreeting: "", ringSeconds: 20 });
    const base = { action: "settings", zoe: true, recordingDefault: "consent", recordingOverrides: { "1": "announce", "49": "none" }, transcription: true, voicemailGreeting: "", ringSeconds: 15 };
    for (const [change, text] of [
      [{ recordingDefault: "always" }, /none, announce or consent/],
      [{ recordingOverrides: { UK: "none" } }, /calling code/],
      [{ ringSeconds: 5 }, /10 to 60/],
      [{ voicemailGreeting: "x".repeat(501) }, /500 characters/],
    ] as const) {
      const r = await agent("voice-settings", { ...base, ...change });
      assert.equal(r.status, 400);
      assert.match(r.body.error.message, text);
    }
    assert.equal((await agent("voice-settings", base)).status, 200);
    const numberId = settings.numbers[0].id;
    assert.equal((await agent("voice-settings", { action: "number", numberId: "nope", voice: true })).status, 400);
    settings = (await agent("voice-settings", { action: "number", numberId, voice: true })).body;
    await drain();
    assert.deepEqual(twilio.voiceConfigured.get("PN447700900100"), { voiceUrl: `${ORIGIN}/v1/hooks/voice/a/incoming`, statusUrl: `${ORIGIN}/v1/hooks/voice/a/status` });
    assert.equal((await agent("voice-settings", { action: "agent", teammateId: "grace", phone: "not a phone" })).status, 400);
    await agent("voice-settings", { action: "agent", teammateId: "owner", phone: "+44 7700 900999" });
    await agent("voice-settings", { action: "agent", teammateId: "grace", phone: "+447700900998" });
    settings = (await agent("voice-settings")).body;
    assert.deepEqual(
      settings.agents.map((a: { teammateId: string; phone: string; takesCalls: boolean }) => [a.teammateId, a.phone, a.takesCalls]),
      [
        ["grace", "+447700900998", true],
        ["owner", "+447700900999", true],
      ],
    );

    // The hook: Twilio's signature over the exact URL and form; another token, account or workspace refused.
    const ada = { sid: "CA" + "1".repeat(32), from: "+447700900456", to: UK };
    assert.equal((await step("incoming", twilio.call(ada), "a", "f".repeat(32))).status, 403);
    assert.equal((await step("incoming", { ...twilio.call(ada), AccountSid: "AC" + "9".repeat(32) })).status, 403);
    assert.equal((await step("incoming", twilio.call(ada), "b")).status, 403);
    assert.equal((await step("nope", twilio.call(ada))).status, 404);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM voice_calls"))[0].n, 0);

    // 1. Ada calls (UK: asked first). Her call is a conversation on voice, unverified (caller ID can be faked).
    let r = await step("incoming", twilio.call(ada));
    assert.deepEqual([r.status, r.type], [200, "text/xml"]);
    assert.match(r.xml, /<Say language="en-US">Thanks for calling [^<]+\.<\/Say><Gather input="dtmf" numDigits="1"[^>]*action="https:\/\/relay\.test\/v1\/hooks\/voice\/a\/consent"/);
    assert.match(r.xml, /Press 1 to agree, or 2 to continue without recording/);
    const c1 = (await callOf(ada.sid)).conversation_id as string;
    assert.deepEqual(await sql("a", "SELECT channel FROM conversations WHERE id=$1", [c1]), [{ channel: "voice" }]);
    assert.deepEqual(await sql("a", "SELECT address,verified FROM identity_addresses WHERE channel='voice'"), [{ address: "+447700900456", verified: false }]);
    assert.equal((await step("incoming", twilio.call(ada))).status, 200, "Twilio's retry");
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM voice_calls"))[0].n, 1, "a retried step is the same call");
    assert.equal(twilio.recordings.length, 0, "nothing recorded before she agrees");
    // She agrees: the call is recorded from now (both sides).
    r = await step("consent", twilio.call(ada, { Digits: "1" }));
    assert.equal(next(r.xml), "route");
    assert.deepEqual(twilio.recordings.map((x) => [x.callSid, x.callback]), [[ada.sid, `${ORIGIN}/v1/hooks/voice/a/recording?kind=call`]]);
    // Zoe answers (recording allowed, Zoe on), listening with barge-in.
    r = await step("route", twilio.call(ada));
    assert.match(r.xml, /<Gather input="speech" language="en-US" speechTimeout="auto" timeout="5" bargeIn="true" action="https:\/\/relay\.test\/v1\/hooks\/voice\/a\/heard" method="POST"><Say language="en-US">Hi, I'm [^<]+, the AI agent\. How can I help\?<\/Say><\/Gather>/);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM conversation_parts WHERE conversation_id=$1 AND kind='ai_reply'", [c1]))[0].n, 0, "the call's start isn't a question for Zoe");
    // What she says is her message; Zoe's reply comes from her own pipeline, and the call says it.
    r = await step("heard", twilio.call(ada, { SpeechResult: "How long do refunds take to reach my card?" }));
    let wait = next(r.xml)!;
    assert.match(wait, /^answer\?after=\d+&n=1$/);
    r = await step(wait, twilio.call(ada));
    assert.match(r.xml, /<Gather input="speech"[^>]*><Say language="en-US">[^<]*five working days[^<]*<\/Say><\/Gather><Redirect method="POST">https:\/\/relay\.test\/v1\/hooks\/voice\/a\/heard<\/Redirect>/);
    assert.deepEqual(
      (await parts(c1)).filter((p) => p.kind === "customer_message" || p.kind === "ai_reply").map((p) => [p.kind, p.audience, p.kind === "ai_reply" ? /five working days/.test(p.body) : p.body]),
      [
        ["customer_message", "public", "Incoming call"],
        ["customer_message", "public", "How long do refunds take to reach my card?"],
        ["ai_reply", "public", true],
      ],
    );
    assert.deepEqual(await sql("a", "SELECT status FROM channel_deliveries WHERE conversation_id=$1", [c1]), [{ status: "delivered" }], "said on the call");
    // A teammate can't answer a call in writing.
    const written = await agent("command", { action: "reply", conversationId: c1, text: "Hello?" });
    assert.deepEqual([written.status, written.body.error.code], [409, "CHANNEL_REFUSES"]);
    assert.equal((await agent(`reply-target?conversation=${c1}`)).body.target.windowNote, "On a call with +447700900456 now: written replies can't reach a caller.");

    // She asks for a person: Zoe hands over, and the call is transferred (warm).
    r = await step("heard", twilio.call(ada, { SpeechResult: "Can I talk to a person please" }));
    wait = next(r.xml)!;
    r = await step(wait, twilio.call(ada));
    assert.equal(next(r.xml), "transfer?i=0");
    r = await step("transfer?i=0", twilio.call(ada));
    const callId = (await callOf(ada.sid)).id as string;
    assert.equal(
      r.xml,
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">Connecting you to the team. One moment.</Say><Dial timeout="15" answerOnBridge="true" callerId="${UK}" action="${ORIGIN}/v1/hooks/voice/a/dialed?i=0" method="POST"><Number url="${ORIGIN}/v1/hooks/voice/a/whisper?call=${callId}" method="POST">+447700900998</Number></Dial></Response>`,
      "Grace first (by name), rung for the workspace's 15 seconds",
    );
    const transferNote = (await parts(c1)).filter((p) => p.kind === "internal_note" && p.data.voice);
    assert.equal(transferNote.length, 1);
    assert.equal(transferNote[0].audience, "internal");
    assert.match(transferNote[0].body, /^Call from \+447700900456 being transferred\. They said: How long do refunds take to reach my card\? … Can I talk to a person please\.$/);
    // Grace's phone: the whisper says who and why; she doesn't press 1 (or doesn't answer): the next teammate.
    const leg = { sid: "CA" + "2".repeat(32), from: UK, to: "+447700900998" };
    r = await step(`whisper?call=${callId}`, twilio.call(leg));
    assert.match(r.xml, /<Gather input="dtmf" numDigits="1" timeout="8" action="https:\/\/relay\.test\/v1\/hooks\/voice\/a\/accept\?call=[^"]+" method="POST"><Say language="en-US">Relay call from 4 4 7 7 0 0 9 0 0 4 5 6\. They said: [^<]+ Press 1 to take it\.<\/Say><\/Gather><Hangup\/>/);
    r = await step(`accept?call=${callId}`, twilio.call(leg, { Digits: "9" }));
    assert.match(r.xml, /<Hangup\/>/);
    r = await step("dialed?i=0", twilio.call(ada, { DialCallStatus: "completed" }));
    assert.equal(next(r.xml), "transfer?i=1");
    r = await step("transfer?i=1", twilio.call(ada));
    assert.match(r.xml, /^<\?xml[^>]+><Response><Dial [^>]+><Number [^>]+>\+447700900999<\/Number><\/Dial><\/Response>$/, "the owner next, with no second greeting");
    // The owner presses 1: the call is theirs.
    await step(`whisper?call=${callId}`, twilio.call({ ...leg, sid: "CA" + "3".repeat(32), to: "+447700900999" }));
    r = await step(`accept?call=${callId}`, twilio.call({ ...leg, sid: "CA" + "3".repeat(32), to: "+447700900999" }, { Digits: "1" }));
    assert.match(r.xml, /<Say language="en-US">Connecting\.<\/Say>/);
    assert.equal((await callOf(ada.sid)).accepted_by, "owner");
    r = await step("dialed?i=1", twilio.call(ada, { DialCallStatus: "completed" }));
    assert.match(r.xml, /<Hangup\/>/, "after the teammate's call, the caller's ends");
    // The call ends; its recording is stored for the team, and its transcript written in, line by line.
    assert.equal((await step("status", twilio.call(ada, { CallStatus: "completed", CallDuration: "95" }))).status, 204);
    assert.equal((await step("status", twilio.call(ada, { CallStatus: "completed", CallDuration: "95" }))).status, 204, "reported once");
    const recording = twilio.recorded(ada.sid, new Uint8Array(4096), 64);
    assert.equal((await step("recording?kind=call", recording)).status, 204);
    assert.equal((await step("recording?kind=call", recording)).status, 204, "Twilio's retry");
    assert.deepEqual(transcribed, [4096], "stored and transcribed once");
    const after = await parts(c1);
    assert.deepEqual(
      after.filter((p) => p.kind === "system_event").map((p) => [p.data.event, p.audience]),
      [
        ["call_transferred", "internal"],
        ["call_ended", "internal"],
        ["call_transcript", "internal"],
        ["call_transcript", "internal"],
      ],
    );
    assert.deepEqual(after.find((p) => p.data.event === "call_ended")!.data, { event: "call_ended", status: "completed", duration: 95, callSid: ada.sid });
    assert.deepEqual(after.find((p) => p.data.event === "call_transferred")!.data, { event: "call_transferred", teammate: "owner", name: "Support teammate", callSid: ada.sid });
    assert.deepEqual(
      after.filter((p) => p.data.event === "call_transcript").map((p) => [p.data.start, p.body]),
      [
        [0, "Hi, it's about order 4411."],
        [2.5, "Thanks, I'll look now."],
      ],
    );
    const audio = after.find((p) => p.kind === "attachment")!;
    assert.deepEqual([audio.audience, audio.data.voice], ["internal", { recording: "call", seconds: 64 }]);
    assert.deepEqual(await sql("a", "SELECT mime,audience,status FROM attachments WHERE id=$1", [audio.data.attachmentId]), [{ mime: "audio/mpeg", audience: "internal", status: "clean" }]);
    // Nothing internal was ever delivered: only Zoe's spoken replies have deliveries.
    assert.deepEqual(
      await sql("a", "SELECT p.kind FROM channel_deliveries d JOIN conversation_parts p ON p.workspace_id=d.workspace_id AND p.id=d.part_id WHERE d.conversation_id=$1 GROUP BY p.kind", [c1]),
      [{ kind: "ai_reply" }],
    );
    assert.equal((await agent(`reply-target?conversation=${c1}`)).body.target.windowNote, "A call can't be answered in writing: call +447700900456 back, or text them.");

    // 2. Grace (not taking calls now) and the owner miss Bo's call; Bo declined recording, so Zoe
    //    doesn't answer and nothing is recorded, but Bo's voicemail is (Bo is told) and transcribed.
    await agent("voice-settings", { action: "agent", teammateId: "grace", phone: "+447700900998", takesCalls: false });
    await agent("voice-settings", { ...base, voicemailGreeting: "Sorry we missed you: leave a message." });
    const bo = { sid: "CA" + "4".repeat(32), from: "+447700900457", to: UK };
    await step("incoming", twilio.call(bo));
    r = await step("consent", twilio.call(bo, { Digits: "2" }));
    assert.match(r.xml, /This call won't be recorded\./);
    r = await step("route", twilio.call(bo));
    assert.equal(next(r.xml), "transfer?i=0", "no recording: no Zoe");
    r = await step("transfer?i=0", twilio.call(bo));
    assert.match(r.xml, />\+447700900999<\/Number>/);
    r = await step("dialed?i=0", twilio.call(bo, { DialCallStatus: "no-answer" }));
    r = await step(next(r.xml)!, twilio.call(bo));
    assert.equal(next(r.xml), "voicemail");
    r = await step("voicemail", twilio.call(bo));
    assert.match(r.xml, /<Say language="en-US">Sorry we missed you: leave a message\.<\/Say><Record maxLength="120" timeout="5" playBeep="true" finishOnKey="#" action="https:\/\/relay\.test\/v1\/hooks\/voice\/a\/voicemail_done" method="POST" recordingStatusCallback="https:\/\/relay\.test\/v1\/hooks\/voice\/a\/recording\?kind=voicemail"/);
    assert.match((await step("voicemail_done", twilio.call(bo))).xml, /Thank you\. Goodbye\.<\/Say><Hangup\/>/);
    await step("recording?kind=voicemail", twilio.recorded(bo.sid, new Uint8Array(900), 12));
    await step("status", twilio.call(bo, { CallStatus: "completed", CallDuration: "40" }));
    const c2 = (await callOf(bo.sid)).conversation_id as string;
    const boParts = await parts(c2);
    assert.equal(twilio.recordings.filter((x) => x.callSid === bo.sid).length, 0, "the call itself wasn't recorded");
    assert.deepEqual(
      boParts.filter((p) => p.kind === "customer_message").map((p) => [p.body, p.author_type]),
      [
        ["Incoming call", "contact"],
        ["Voicemail: Hi, it's about order 4411.", "contact"],
      ],
    );
    assert.equal(boParts.filter((p) => p.kind === "ai_reply").length, 0, "Zoe doesn't answer a voicemail");
    assert.deepEqual(boParts.find((p) => p.kind === "attachment")!.data.voice, { recording: "voicemail", seconds: 12 });
    assert.deepEqual(await sql("a", "SELECT consent,voicemail,status FROM voice_calls WHERE call_sid=$1", [bo.sid]), [{ consent: "declined", voicemail: true, status: "completed" }]);

    // 3. A US caller is told the call is recorded (no question), and Zoe answers; two silences hand over.
    const cy = { sid: "CA" + "5".repeat(32), from: "+15551230000", to: UK };
    r = await step("incoming", twilio.call(cy));
    assert.match(r.xml, /<Say language="en-US">This call is recorded and transcribed\.<\/Say><Redirect method="POST">https:\/\/relay\.test\/v1\/hooks\/voice\/a\/route<\/Redirect>/);
    assert.equal(twilio.recordings.filter((x) => x.callSid === cy.sid).length, 1);
    await step("route", twilio.call(cy));
    r = await step("heard", twilio.call(cy, { SpeechResult: "" }));
    assert.match(r.xml, /Sorry, I didn't catch that\./);
    r = await step("heard", twilio.call(cy));
    assert.match(r.xml, /I'll pass you to someone on the team\.<\/Say><Redirect method="POST">https:\/\/relay\.test\/v1\/hooks\/voice\/a\/transfer\?i=0</);
    // And past eight turns, to the team too.
    await sql("a", "UPDATE voice_calls SET zoe_turns=8 WHERE call_sid=$1", [cy.sid]);
    r = await step("heard", twilio.call(cy, { SpeechResult: "And another thing" }));
    assert.match(r.xml, /Let me pass you to someone on the team\./);
    // 4. Germany isn't recorded at all: straight to the team.
    const de = { sid: "CA" + "6".repeat(32), from: "+4915112345678", to: UK };
    r = await step("incoming", twilio.call(de));
    assert.doesNotMatch(r.xml, /record/i);
    assert.equal(next((await step("route", twilio.call(de))).xml), "transfer?i=0");
    assert.equal(twilio.recordings.filter((x) => x.callSid === de.sid).length, 0);
    // A call Relay doesn't know is hung up; its status is ignored.
    assert.match((await step("heard", twilio.call({ sid: "CA" + "7".repeat(32), from: "+447700900111", to: UK }, { SpeechResult: "hi" }))).xml, /<Response><Hangup\/><\/Response>/);
    assert.equal((await step("status", twilio.call({ sid: "CA" + "7".repeat(32), from: "+447700900111", to: UK }, { CallStatus: "completed" }))).status, 204);
    // Settings lists the calls.
    settings = (await agent("voice-settings")).body;
    assert.deepEqual(
      settings.calls.map((c: { from: string; answered: boolean; voicemail: boolean; consent: string }) => [c.from, c.answered, c.voicemail, c.consent]).sort(),
      [
        ["+15551230000", false, false, "granted"],
        ["+447700900456", true, false, "granted"],
        ["+447700900457", false, true, "declined"],
        ["+4915112345678", false, false, "not_asked"],
      ],
    );

    // Buying a number: searched (a job); only one offered, only when confirmed; added for texts and calls.
    assert.equal((await agent("voice-settings", { action: "buy", phone: "+447700900200", brandId: "default", confirm: true })).body.error.message, "Search for numbers first, then choose one of them.");
    await agent("voice-settings", { action: "search", country: "xx" });
    await drain();
    assert.equal((await agent("voice-settings")).body.search.error, "Twilio refused: No numbers in XX.");
    await agent("voice-settings", { action: "search", country: "gb" });
    await drain();
    settings = (await agent("voice-settings")).body;
    assert.deepEqual(settings.search.numbers.map((n: { phone: string; locality: string }) => [n.phone, n.locality]), [
      ["+447700900200", "London"],
      ["+447700900201", "Leeds"],
    ]);
    assert.equal((await agent("voice-settings", { action: "buy", phone: "+447700900200", brandId: "default" })).body.error.message, "Confirm the purchase: it's charged to your Twilio account.");
    assert.equal(twilio.bought.length, 0);
    assert.equal((await agent("voice-settings", { action: "buy", phone: "+447700900200", brandId: "default", confirm: true })).status, 200);
    await drain();
    assert.deepEqual(twilio.bought.map((b) => [b.phone, b.urls]), [
      ["+447700900200", { smsUrl: `${ORIGIN}/v1/hooks/sms/a/message`, voiceUrl: `${ORIGIN}/v1/hooks/voice/a/incoming`, statusUrl: `${ORIGIN}/v1/hooks/voice/a/status` }],
    ]);
    assert.deepEqual((await agent("voice-settings")).body.numbers.find((n: { phone: string }) => n.phone === "+447700900200"), {
      ...(await agent("voice-settings")).body.numbers.find((n: { phone: string }) => n.phone === "+447700900200"),
      voice: true,
      connected: true,
    });
    // Bought once: the job run again finds it there.
    await sql("a", "UPDATE jobs SET state='queued' WHERE kind='voice.buy'");
    await drain();
    assert.equal(twilio.bought.length, 1);

    // Another workspace: its own (empty) settings and calls, and a's conversations aren't readable.
    await sql("b", "UPDATE workspace_features SET enabled=true WHERE name='channel_voice_v1'");
    const other = (await agent("voice-settings", undefined, "owner-b", "b")).body;
    assert.deepEqual([other.calls, other.numbers, other.twilio], [[], [], null]);
    assert.equal((await agent(`conversation?id=${c1}`, undefined, "owner-b", "b")).status, 404);
    assert.equal((await agent("voice-settings", { action: "agent", teammateId: "grace", phone: "+447700900998" }, "owner-b", "b")).status, 400, "a's teammate isn't b's");

    // The rollback: the flag off (a call is told it isn't taken), the call in progress failed, unread recordings failed.
    const late = { sid: "CA" + "8".repeat(32), from: "+447700900458", to: UK };
    await step("incoming", twilio.call(late));
    await sql("a", "INSERT INTO voice_inbound(workspace_id,id,call_sid,kind,payload) VALUES('a','unread',$1,'call','{}')", [late.sid]);
    const rollback = readFileSync("db/rollback/0070_voice.sql", "utf8");
    for (const statement of rollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await sql("a", statement);
    assert.deepEqual(await sql("a", "SELECT status FROM voice_calls WHERE call_sid=$1", [late.sid]), [{ status: "failed" }]);
    assert.deepEqual(await sql("a", "SELECT status,error FROM voice_inbound WHERE id='unread'"), [{ status: "failed", error: "Stopped by rollback." }]);
    r = await step("incoming", twilio.call({ ...late, sid: "CA" + "9".repeat(32) }));
    assert.match(r.xml, /calls to this number aren't being taken right now\.<\/Say><Hangup\/>/);
    assert.equal((await agent("voice-settings")).status, 404);
  } finally {
    await db.close();
  }
});
