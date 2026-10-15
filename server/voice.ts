import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import { authorize } from "./policy";
import { receiveInbound, registerChannel, type ChannelAdapter } from "./channels";
import { credentials, smsChannel, twilioSignature } from "./sms";
import { SmsRejected, type SmsApi } from "./sms-api";
import type { AttachmentStorage } from "./attachments";
import type { TranscriptionPort } from "./voice-transcribe";
import { callingCode } from "../lib/sms";
import { speakable, SPEECH_LANGUAGE } from "../lib/voice";

/**
 * Voice (phase 12, step E9; docs/OMNICHANNEL_STEP9.md), behind `channels_v1` and
 * `channel_voice_v1`, through SMS's Twilio account (E6): its numbers take calls too.
 *
 * A call is a conversation on `voice`, steered by Twilio's signed webhook
 * (`/v1/hooks/voice/<workspace>/<step>`), each step answered with TwiML:
 *
 * 1. **incoming:** the conversation (threaded by number within a day); recording by the caller's
 *    calling code: none, announced, or asked (press 1).
 * 2. **consent → route:** with recording allowed and Zoe on, she answers (else to the team).
 * 3. **heard ↔ answer:** what the caller says is their message (speech recognised by Twilio); Zoe's
 *    reply comes from her own pipeline (the `ai.reply` job), which the call waits for and says.
 *    The caller can talk over her (barge-in). Two silences in a row, eight turns, her handover, or
 *    no answer in ten seconds: to the team.
 * 4. **transfer → whisper → accept → dialed:** a warm transfer: teammates who take calls are rung
 *    one at a time; each hears who's calling and why before pressing 1 to take it; the context is
 *    also a note in the conversation. Nobody, or office hours closed: voicemail.
 * 5. **voicemail, status, recording:** a voicemail is recorded; the call's end is noted; recordings
 *    (the call's, with consent, and voicemails) are stored and transcribed into the conversation by
 *    the `voice.recording` job.
 */
export type VoiceEnvironment = { api?: SmsApi; key?: string; storage?: AttachmentStorage; transcriber?: TranscriptionPort };
const STEPS = ["incoming", "consent", "route", "heard", "answer", "transfer", "whisper", "accept", "dialed", "voicemail", "voicemail_done", "status", "recording"] as const;
export type VoiceStep = (typeof STEPS)[number];
export const isVoiceStep = (s: string): s is VoiceStep => (STEPS as readonly string[]).includes(s);
const MAX_TURNS = 8;
const ANSWER_WAIT_SECONDS = 10;

async function voiceOn(db: Sql, w: string) {
  return (
    (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_features WHERE workspace_id=$1 AND enabled AND name IN ('channels_v1','channel_voice_v1')", [w])).rows[0].n ===
    2
  );
}
type Settings = { zoe: boolean; recording_default: string; recording_overrides: Record<string, string>; transcription: boolean; voicemail_greeting: string; ring_seconds: number };
async function settingsOf(db: Sql, w: string): Promise<Settings> {
  await db.query("INSERT INTO voice_settings(workspace_id) VALUES($1) ON CONFLICT DO NOTHING", [w]);
  return (await db.query<Settings>("SELECT zoe,recording_default,recording_overrides,transcription,voicemail_greeting,ring_seconds FROM voice_settings WHERE workspace_id=$1", [w])).rows[0];
}
type Call = {
  id: string;
  call_sid: string;
  conversation_id: string;
  number_id: string;
  from_phone: string;
  to_phone: string;
  status: string;
  recording: string;
  consent: string;
  zoe_turns: number;
  silences: number;
  ringing_teammate: string | null;
  ringing_index: number;
  accepted_by: string | null;
};
async function callOf(db: Sql, w: string, sid: string) {
  return (await db.query<Call>("SELECT * FROM voice_calls WHERE workspace_id=$1 AND call_sid=$2", [w, sid])).rows[0];
}
/** Recording (and so transcription and Zoe, who hears by it) is allowed: announced, or agreed to. */
const recordingAllowed = (c: Call) => c.recording === "announce" || (c.recording === "consent" && c.consent === "granted");

/* ------------------------------------------------------------------------------------------ */
/* The adapter                                                                                 */

export const voiceChannel: ChannelAdapter = {
  id: "voice",
  flag: "channel_voice_v1",
  // Spoken: Zoe's replies are said on the live call; nothing is written back to a caller.
  capabilities: { richText: false, attachments: false, buttons: false, maxLength: 1000, windowHours: null, ai: true, receipts: "none", address: "phone" },
  address: smsChannel.address,
  /** Zoe answers only what a caller said on a live call, when she's on for calls. */
  async aiAnswers(db, w, conversationId, partId) {
    const p = (await db.query<{ data: { voice?: { utterance?: boolean; callSid?: string } } }>("SELECT data FROM conversation_parts WHERE workspace_id=$1 AND id=$2", [w, partId])).rows[0];
    if (!p?.data.voice?.utterance || !p.data.voice.callSid) return false;
    const c = await callOf(db, w, p.data.voice.callSid);
    return !!c && c.conversation_id === conversationId && c.status === "in_progress" && (await settingsOf(db, w)).zoe;
  },
  async refuses(db, w, conversationId, part) {
    if (part?.author === "ai") {
      const live = (await db.query("SELECT 1 FROM voice_calls WHERE workspace_id=$1 AND conversation_id=$2 AND status='in_progress'", [w, conversationId])).rows.length;
      return live ? null : "The call had ended before this could be said.";
    }
    return "A call can't be answered in writing: call them back, or text them.";
  },
  // Zoe's reply is said on the call (by the `answer` step): the delivery records it as delivered.
  async prepare() {
    return { data: {} };
  },
  async send() {
    return { status: "delivered" };
  },
  async replyDetails(db, w, conversationId) {
    const c = (await db.query<{ from_phone: string; status: string }>("SELECT from_phone,status FROM voice_calls WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY started_at DESC LIMIT 1", [w, conversationId])).rows[0];
    return {
      window: { open: false, closesAt: null },
      windowNote: c
        ? c.status === "in_progress"
          ? `On a call with ${c.from_phone} now: written replies can't reach a caller.`
          : `A call can't be answered in writing: call ${c.from_phone} back, or text them.`
        : "A call can't be answered in writing.",
    };
  },
};
registerChannel(voiceChannel);

/* ------------------------------------------------------------------------------------------ */
/* TwiML                                                                                       */

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const twiml = (...verbs: string[]) => `<?xml version="1.0" encoding="UTF-8"?><Response>${verbs.join("")}</Response>`;
const say = (text: string, lang = "en-US") => `<Say language="${lang}">${xml(text)}</Say>`;
const hangup = "<Hangup/>";
const redirect = (url: string) => `<Redirect method="POST">${xml(url)}</Redirect>`;

const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
/** What a step answers: TwiML (or nothing, for status callbacks), and the HTTP status. */
export type VoiceAnswer = { status: number; twiml: string | null };
const ok = (...verbs: string[]): VoiceAnswer => ({ status: 200, twiml: twiml(...verbs) });

/**
 * `POST /v1/hooks/voice/<workspace>/<step>`: checked against Twilio's signature (the account's
 * token, over the exact URL and form), then the step.
 */
export async function voiceHook(
  connect: Connect,
  env: VoiceEnvironment & { dispatch?: (w: string) => Promise<void> },
  w: string,
  step: string,
  url: string,
  params: URLSearchParams,
  signature: string,
): Promise<VoiceAnswer> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(w) || !isVoiceStep(step) || !env.key) return { status: 404, twiml: null };
  const base = `${new URL(url).origin}/v1/hooks/voice/${w}`;
  const q = new URL(url).searchParams;
  let dispatch = false;
  let result: VoiceAnswer;
  try {
    result = await tenant(connect, w, async (db) => {
      const c = await credentials(db, w, env.key!);
      if (!c || params.get("AccountSid") !== c.sid || !same(await twilioSignature(c.token, url, params), signature)) return { status: 403, twiml: null };
      if (!(await voiceOn(db, w)))
        return step === "status" || step === "recording" ? { status: 204, twiml: null } : ok(say("Sorry, calls to this number aren't being taken right now."), hangup);
      const r = await run(db, w, step, base, q, params);
      dispatch = r.dispatch;
      return r.answer;
    });
  } catch (e) {
    if (e instanceof DomainError) throw e;
    return { status: 404, twiml: null };
  }
  // Zoe's reply (and a recording's start) are jobs: started now, so the call doesn't wait for a sweep.
  if (dispatch) await env.dispatch?.(w);
  return result;
}

async function run(db: Sql, w: string, step: VoiceStep, base: string, q: URLSearchParams, p: URLSearchParams): Promise<{ answer: VoiceAnswer; dispatch: boolean }> {
  const done = (answer: VoiceAnswer, dispatch = false) => ({ answer, dispatch });
  const sid = p.get("CallSid") ?? "";
  const settings = await settingsOf(db, w);
  const agentLang = (await db.query<{ languages: string[] }>("SELECT languages FROM ai_agents WHERE workspace_id=$1 AND id='default'", [w])).rows[0]?.languages?.[0] ?? "en";
  const lang = SPEECH_LANGUAGE[agentLang] ?? "en-US";

  if (step === "incoming") {
    const to = smsChannel.address(p.get("To") ?? "");
    const from = smsChannel.address(p.get("From") ?? "") ?? "+0";
    const number = (await db.query<{ id: string; brand_id: string; brand: string }>(
      "SELECT n.id,n.brand_id,b.name AS brand FROM sms_numbers n JOIN brands b ON b.workspace_id=n.workspace_id AND b.id=n.brand_id WHERE n.workspace_id=$1 AND n.phone=$2 AND n.voice AND n.status='connected'",
      [w, to ?? ""],
    )).rows[0];
    if (!number) return done(ok(say("Sorry, this number isn't taking calls."), hangup));
    const existing = await callOf(db, w, sid);
    if (!existing) {
      const r = await receiveInbound(db, w, voiceChannel, {
        externalId: `call:${sid}`,
        address: from,
        // Caller ID can be faked: unverified.
        verified: false,
        text: "Incoming call",
        threadKeys: [],
        fallback: { key: `voice:${number.id}:${from}`, days: 1 },
        brandId: number.brand_id,
        data: { voice: { callSid: sid, event: "call" } },
      });
      const mode = settings.recording_overrides[callingCode(from)] ?? settings.recording_default;
      await db.query(
        "INSERT INTO voice_calls(workspace_id,id,call_sid,conversation_id,number_id,from_phone,to_phone,recording,consent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [w, crypto.randomUUID(), sid, r.conversationId, number.id, from, to, mode, mode === "announce" ? "granted" : "not_asked"],
      );
      if (mode === "announce") await enqueueJob(db, w, "voice.record", { callSid: sid, callback: `${base}/recording?kind=call` }, {});
    }
    const call = (await callOf(db, w, sid))!;
    const hello = say(`Thanks for calling ${number.brand}.`, lang);
    if (call.recording === "consent")
      return done(
        ok(
          hello,
          `<Gather input="dtmf" numDigits="1" timeout="6" action="${xml(`${base}/consent`)}" method="POST">${say("This call may be recorded and transcribed to help us help you. Press 1 to agree, or 2 to continue without recording.", lang)}</Gather>`,
          redirect(`${base}/consent`),
        ),
      );
    if (call.recording === "announce") return done(ok(hello, say("This call is recorded and transcribed.", lang), redirect(`${base}/route`)), true);
    return done(ok(hello, redirect(`${base}/route`)));
  }

  const call = await callOf(db, w, sid);
  // A call Relay doesn't know (its incoming step never ran): nothing to steer.
  if (!call && step !== "whisper" && step !== "accept") return done(step === "status" || step === "recording" ? { status: 204, twiml: null } : ok(hangup));

  switch (step) {
    case "consent": {
      const agreed = p.get("Digits") === "1";
      await db.query("UPDATE voice_calls SET consent=$3 WHERE workspace_id=$1 AND call_sid=$2 AND consent='not_asked'", [w, sid, agreed ? "granted" : "declined"]);
      if (agreed) await enqueueJob(db, w, "voice.record", { callSid: sid, callback: `${base}/recording?kind=call` }, {});
      return done(ok(say(agreed ? "Thank you." : "This call won't be recorded.", lang), redirect(`${base}/route`)), agreed);
    }
    case "route": {
      const zoe = settings.zoe && recordingAllowed(call!) ? await zoeOn(db, w) : null;
      if (!zoe) return done(ok(redirect(`${base}/transfer?i=0`)));
      return done(ok(listen(base, lang, `Hi, I'm ${zoe.name}, the AI agent. How can I help?`), redirect(`${base}/heard`)));
    }
    case "heard": {
      const said = (p.get("SpeechResult") ?? "").trim();
      if (!said) {
        // The silence policy: once, asked again; twice, to the team.
        const silences = call!.silences + 1;
        await db.query("UPDATE voice_calls SET silences=$3 WHERE workspace_id=$1 AND call_sid=$2", [w, sid, silences]);
        if (silences >= 2) return done(ok(say("I'll pass you to someone on the team.", lang), redirect(`${base}/transfer?i=0`)));
        return done(ok(listen(base, lang, "Sorry, I didn't catch that. How can I help?"), redirect(`${base}/heard`)));
      }
      const turns = call!.zoe_turns + 1;
      await db.query("UPDATE voice_calls SET silences=0,zoe_turns=$3 WHERE workspace_id=$1 AND call_sid=$2", [w, sid, turns]);
      if (turns > MAX_TURNS) return done(ok(say("Let me pass you to someone on the team.", lang), redirect(`${base}/transfer?i=0`)));
      // What they said is their message: Zoe answers it through her own pipeline (a job).
      const { command } = await import("./conversations");
      const c = (await db.query<{ primary_identity_id: string; brand_id: string }>("SELECT primary_identity_id,brand_id FROM conversations WHERE workspace_id=$1 AND id=$2", [w, call!.conversation_id])).rows[0];
      const r = (await command(db, w, { type: "contact", identityId: c.primary_identity_id, brandId: c.brand_id, verified: false, channel: "voice" }, `utt:${sid}:${turns}`, {
        action: "reply",
        conversationId: call!.conversation_id,
        text: said.slice(0, 1000),
        channelData: { voice: { callSid: sid, utterance: true } },
      })) as { partId: string };
      const seq = (await db.query<{ seq: string }>("SELECT seq FROM conversation_parts WHERE workspace_id=$1 AND id=$2", [w, r.partId])).rows[0].seq;
      return done(ok(`<Pause length="1"/>`, redirect(`${base}/answer?after=${seq}&n=1`)), true);
    }
    case "answer": {
      const after = Number(q.get("after") ?? 0);
      const n = Number(q.get("n") ?? 1);
      const reply = (
        await db.query<{ body: string; data: { handover?: boolean } }>(
          "SELECT body,data FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND kind='ai_reply' AND seq>$3 ORDER BY seq LIMIT 1",
          [w, call!.conversation_id, after],
        )
      ).rows[0];
      const state = (await db.query<{ ai_state: string | null }>("SELECT ai_state FROM conversations WHERE workspace_id=$1 AND id=$2", [w, call!.conversation_id])).rows[0].ai_state;
      if (reply && (reply.data.handover || state === "escalated" || state === "needs_input")) return done(ok(say(speakable(reply.body), lang), redirect(`${base}/transfer?i=0`)));
      if (reply) return done(ok(listen(base, lang, speakable(reply.body)), redirect(`${base}/heard`)));
      if (n >= ANSWER_WAIT_SECONDS) return done(ok(say("Sorry, I couldn't find that. Let me pass you to someone on the team.", lang), redirect(`${base}/transfer?i=0`)));
      return done(ok(`<Pause length="1"/>`, redirect(`${base}/answer?after=${after}&n=${n + 1}`)));
    }
    case "transfer": {
      const i = Number(q.get("i") ?? 0);
      const c = (await db.query<{ brand_id: string; team_id: string | null }>("SELECT brand_id,team_id FROM conversations WHERE workspace_id=$1 AND id=$2", [w, call!.conversation_id])).rows[0];
      const { availabilityFor } = await import("./office-hours");
      const hours = await availabilityFor(db, w, { brandId: c.brand_id, teamId: c.team_id, channel: "voice" }, "en");
      const agents = (
        await db.query<{ teammate_id: string; phone: string; name: string }>(
          `SELECT a.teammate_id,a.phone,t.name FROM voice_agents a JOIN teammates t ON t.workspace_id=a.workspace_id AND t.id=a.teammate_id
           WHERE a.workspace_id=$1 AND a.takes_calls AND t.presence='active' ORDER BY t.name,t.id`,
          [w],
        )
      ).rows;
      const next = hours && !hours.open ? undefined : agents[i];
      if (!next) return done(ok(redirect(`${base}/voicemail`)));
      if (i === 0) await note(db, w, call!, `Call from ${call!.from_phone} being transferred. ${await contextOf(db, w, call!)}`);
      await db.query("UPDATE voice_calls SET ringing_teammate=$3,ringing_index=$4 WHERE workspace_id=$1 AND call_sid=$2", [w, sid, next.teammate_id, i]);
      return done(
        ok(
          ...(i === 0 ? [say("Connecting you to the team. One moment.", lang)] : []),
          `<Dial timeout="${settings.ring_seconds}" answerOnBridge="true" callerId="${xml(call!.to_phone)}" action="${xml(`${base}/dialed?i=${i}`)}" method="POST">` +
            `<Number url="${xml(`${base}/whisper?call=${call!.id}`)}" method="POST">${xml(next.phone)}</Number></Dial>`,
        ),
      );
    }
    case "whisper": {
      // The teammate's leg: who's calling and why, before they take it.
      const c = (await db.query<Call>("SELECT * FROM voice_calls WHERE workspace_id=$1 AND id=$2", [w, q.get("call") ?? ""])).rows[0];
      if (!c) return done(ok(hangup));
      return done(
        ok(
          `<Gather input="dtmf" numDigits="1" timeout="8" action="${xml(`${base}/accept?call=${c.id}`)}" method="POST">${say(`Relay call from ${spokenNumber(c.from_phone)}. ${await contextOf(db, w, c)} Press 1 to take it.`)}</Gather>`,
          hangup,
        ),
      );
    }
    case "accept": {
      const c = (await db.query<Call>("SELECT * FROM voice_calls WHERE workspace_id=$1 AND id=$2", [w, q.get("call") ?? ""])).rows[0];
      if (!c || p.get("Digits") !== "1") return done(ok(hangup));
      await db.query("UPDATE voice_calls SET accepted_by=ringing_teammate WHERE workspace_id=$1 AND id=$2 AND accepted_by IS NULL", [w, c.id]);
      const name = (await db.query<{ name: string }>("SELECT name FROM teammates WHERE workspace_id=$1 AND id=$2", [w, c.ringing_teammate])).rows[0]?.name ?? "A teammate";
      await event(db, w, c, { event: "call_transferred", teammate: c.ringing_teammate, name });
      return done(ok(say("Connecting.")));
    }
    case "dialed": {
      const fresh = (await callOf(db, w, sid))!;
      if (fresh.accepted_by) return done(ok(hangup));
      return done(ok(redirect(`${base}/transfer?i=${Number(q.get("i") ?? 0) + 1}`)));
    }
    case "voicemail": {
      await db.query("UPDATE voice_calls SET voicemail=true WHERE workspace_id=$1 AND call_sid=$2", [w, sid]);
      const greeting = settings.voicemail_greeting || "No one can take your call right now. Please leave a message after the tone, and we'll get back to you.";
      return done(
        ok(
          say(greeting, lang),
          `<Record maxLength="120" timeout="5" playBeep="true" finishOnKey="#" action="${xml(`${base}/voicemail_done`)}" method="POST" recordingStatusCallback="${xml(`${base}/recording?kind=voicemail`)}" recordingStatusCallbackMethod="POST"/>`,
        ),
      );
    }
    case "voicemail_done":
      return done(ok(say("Thank you. Goodbye.", lang), hangup));
    case "status": {
      const status = { completed: "completed", busy: "busy", "no-answer": "no_answer", failed: "failed", canceled: "canceled" }[p.get("CallStatus") ?? ""];
      if (status && call!.status === "in_progress") {
        const duration = Number(p.get("CallDuration") ?? 0) || null;
        await db.query("UPDATE voice_calls SET status=$3,duration_seconds=$4,ended_at=now() WHERE workspace_id=$1 AND call_sid=$2", [w, sid, status, duration]);
        await event(db, w, call!, { event: "call_ended", status, duration });
      }
      return done({ status: 204, twiml: null });
    }
    case "recording": {
      const kind = q.get("kind") === "voicemail" ? "voicemail" : "call";
      if (p.get("RecordingStatus") === "completed" && p.get("RecordingUrl")) {
        const added = await db.query(
          "INSERT INTO voice_inbound(workspace_id,id,call_sid,kind,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
          [w, crypto.randomUUID(), sid, kind, JSON.stringify(Object.fromEntries(p))],
        );
        if (added.rows.length) await enqueueJob(db, w, "voice.recording", { inboundId: added.rows[0].id }, {});
        return done({ status: 204, twiml: null }, added.rows.length > 0);
      }
      return done({ status: 204, twiml: null });
    }
  }
  return done(ok(hangup));
}

/** Zoe's turn on a call: said, and listened for (the caller can interrupt: barge-in). */
const listen = (base: string, lang: string, text: string) =>
  `<Gather input="speech" language="${lang}" speechTimeout="auto" timeout="5" bargeIn="true" action="${xml(`${base}/heard`)}" method="POST">${say(text, lang)}</Gather>`;
const spokenNumber = (phone: string) => phone.replace(/^\+/, "").split("").join(" ");
/** Zoe, when she's on for the workspace (her agent made with its defaults the first time, as for any channel). */
async function zoeOn(db: Sql, w: string) {
  const { aiEnabled, agentRow } = await import("./ai-agent");
  if (!(await aiEnabled(db, w))) return null;
  const agent = await agentRow(db, w);
  return agent.enabled ? agent : null;
}
/** What a teammate taking the call should know: what the caller said, and Zoe's last answer. */
async function contextOf(db: Sql, w: string, c: Call) {
  const parts = (
    await db.query<{ kind: string; body: string }>(
      "SELECT kind,body FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND kind IN ('customer_message','ai_reply') AND data->'voice'->>'event' IS DISTINCT FROM 'call' ORDER BY seq DESC LIMIT 4",
      [w, c.conversation_id],
    )
  ).rows.reverse();
  const asked = parts.filter((p) => p.kind === "customer_message").map((p) => p.body);
  return asked.length ? `They said: ${asked.join(" … ").slice(0, 300)}.` : "They haven't said what it's about yet.";
}
async function note(db: Sql, w: string, c: Call, text: string) {
  const { append, conversation } = await import("./conversations");
  await append(db, w, await conversation(db, w, c.conversation_id), { type: "system", id: "voice" }, "internal_note", text, { voice: { callSid: c.call_sid } }, "internal");
}
async function event(db: Sql, w: string, c: Call, data: Record<string, unknown>) {
  const { append, conversation } = await import("./conversations");
  await append(db, w, await conversation(db, w, c.conversation_id), { type: "system", id: "voice" }, "system_event", "", { ...data, callSid: c.call_sid }, "internal");
}

/* ------------------------------------------------------------------------------------------ */
/* Jobs: recording, recordings read                                                            */

/** `voice.record`: the call recorded from now (both sides), once the caller agreed or was told. */
export async function startRecordingJob(connect: Connect, env: VoiceEnvironment, job: Job) {
  const w = job.workspace_id;
  const { callSid, callback } = job.payload as { callSid: string; callback: string };
  const ready = await tenant(connect, w, async (db) => {
    const c = await callOf(db, w, callSid);
    return c && c.status === "in_progress" && recordingAllowed(c) && env.key ? await credentials(db, w, env.key) : null;
  });
  if (!ready || !env.api) return { done: true, result: { recording: false } };
  try {
    const r = await env.api.startRecording(ready, callSid, callback);
    await tenant(connect, w, (db) => db.query("UPDATE voice_calls SET recording_sid=$3 WHERE workspace_id=$1 AND call_sid=$2", [w, callSid, r.sid]));
    return { done: true, result: { recording: true } };
  } catch (e) {
    // A call that ended before recording started isn't worth retrying.
    if (e instanceof SmsRejected) return { done: true, result: { recording: false, reason: e.message } };
    throw e;
  }
}

/**
 * `voice.recording`: a recording (the call's, or a voicemail) stored for the team only, and, when
 * transcription is on, transcribed: a voicemail is the caller's message; a call's transcript is
 * written into the conversation as its lines, with their times.
 */
export async function readRecordingJob(connect: Connect, env: VoiceEnvironment, job: Job) {
  const w = job.workspace_id;
  const { inboundId } = job.payload as { inboundId: string };
  const ready = await tenant(connect, w, async (db) => {
    const row = (await db.query<{ status: string; kind: "call" | "voicemail"; call_sid: string; payload: Record<string, string> }>("SELECT status,kind,call_sid,payload FROM voice_inbound WHERE workspace_id=$1 AND id=$2", [w, inboundId])).rows[0];
    if (!row || row.status !== "received" || !env.key) return null;
    return { row, call: await callOf(db, w, row.call_sid), c: await credentials(db, w, env.key), settings: await settingsOf(db, w) };
  });
  if (!ready?.call || !ready.c || !env.api || !env.storage) return { done: true, result: { skipped: true } };
  const { row, call, settings } = ready;
  const audio = await env.api.download(ready.c, `${row.payload.RecordingUrl}.mp3`);
  const fileId = crypto.randomUUID();
  const key = `${encodeURIComponent(w)}/${fileId}/clean`;
  const name = `${row.kind === "voicemail" ? "voicemail" : "call"}-${call.from_phone.replace(/\D/g, "")}.mp3`;
  // Twilio's own recording of the call: stored for the team only.
  await env.storage.putClean(key, audio.bytes, "audio/mpeg", name);
  const transcript = settings.transcription && env.transcriber ? await env.transcriber.transcribe(audio.bytes, "audio/mpeg") : null;
  await tenant(connect, w, async (db) => {
    const { append, command, conversation } = await import("./conversations");
    const c = await conversation(db, w, call.conversation_id);
    await db.query(
      "INSERT INTO attachments(workspace_id,id,conversation_id,object_key,name,size,mime,status,clean_key,audience,purpose) VALUES($1,$2,$3,$4,$5,$6,'audio/mpeg','clean',$4,'internal','part')",
      [w, fileId, c.id, key, name, audio.bytes.length],
    );
    await append(db, w, c, { type: "system", id: "voice" }, "attachment", "", { attachmentId: fileId, name, voice: { recording: row.kind, seconds: Number(row.payload.RecordingDuration ?? 0) } }, "internal");
    if (row.kind === "voicemail") {
      const conv = (await db.query<{ primary_identity_id: string; brand_id: string }>("SELECT primary_identity_id,brand_id FROM conversations WHERE workspace_id=$1 AND id=$2", [w, c.id])).rows[0];
      await command(db, w, { type: "contact", identityId: conv.primary_identity_id, brandId: conv.brand_id, verified: false, channel: "voice" }, `voicemail:${row.call_sid}`, {
        action: "reply",
        conversationId: c.id,
        text: transcript?.text ? `Voicemail: ${transcript.text}`.slice(0, 1000) : "Voicemail (not transcribed)",
        channelData: { voice: { callSid: row.call_sid, voicemail: true } },
      });
    } else if (transcript)
      for (const s of transcript.segments)
        await append(db, w, c, { type: "system", id: "voice" }, "system_event", s.text, { event: "call_transcript", callSid: row.call_sid, start: s.start, end: s.end, text: s.text }, "internal");
    await db.query("UPDATE voice_inbound SET status='read',read_at=now() WHERE workspace_id=$1 AND id=$2", [w, inboundId]);
  });
  return { done: true, result: { stored: true, transcribed: !!transcript } };
}

/* ------------------------------------------------------------------------------------------ */
/* Settings › Voice                                                                            */

export async function readVoice(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "workspace.manage");
  assert(await voiceOn(db, w), "VOICE_DISABLED", "Voice is not enabled for this workspace.", 404);
  const s = await settingsOf(db, w);
  const extra = (await db.query<{ last_search: { country?: string; numbers?: unknown[]; error?: string }; searched_at: string | null }>("SELECT last_search,searched_at FROM voice_settings WHERE workspace_id=$1", [w])).rows[0];
  const account = (await db.query<{ status: string }>("SELECT status FROM sms_accounts WHERE workspace_id=$1", [w])).rows[0];
  return {
    twilio: account?.status ?? null,
    brands: (await db.query<{ id: string; name: string }>("SELECT id,name FROM brands WHERE workspace_id=$1 ORDER BY name,id", [w])).rows,
    settings: {
      zoe: s.zoe,
      recordingDefault: s.recording_default,
      recordingOverrides: s.recording_overrides,
      transcription: s.transcription,
      voicemailGreeting: s.voicemail_greeting,
      ringSeconds: s.ring_seconds,
    },
    numbers: (
      await db.query<{ id: string; phone: string; brand: string; voice: boolean; voice_error: string; status: string }>(
        "SELECT n.id,n.phone,b.name AS brand,n.voice,n.voice_error,n.status FROM sms_numbers n JOIN brands b ON b.workspace_id=n.workspace_id AND b.id=n.brand_id WHERE n.workspace_id=$1 AND n.status<>'removed' ORDER BY n.phone",
        [w],
      )
    ).rows.map((n) => ({ id: n.id, phone: n.phone, brandName: n.brand, voice: n.voice, error: n.voice_error, connected: n.status === "connected" })),
    search: { ...extra.last_search, at: extra.searched_at ? new Date(extra.searched_at).toISOString() : null },
    agents: (
      await db.query<{ id: string; name: string; phone: string | null; takes_calls: boolean | null }>(
        "SELECT t.id,t.name,a.phone,a.takes_calls FROM teammates t LEFT JOIN voice_agents a ON a.workspace_id=t.workspace_id AND a.teammate_id=t.id WHERE t.workspace_id=$1 ORDER BY t.name,t.id",
        [w],
      )
    ).rows.map((a) => ({ teammateId: a.id, name: a.name, phone: a.phone, takesCalls: a.takes_calls === true })),
    calls: (
      await db.query<{ from_phone: string; status: string; consent: string; recording: string; duration_seconds: number | null; started_at: string; accepted_by: string | null; voicemail: boolean }>(
        "SELECT from_phone,status,consent,recording,duration_seconds,started_at,accepted_by,voicemail FROM voice_calls WHERE workspace_id=$1 ORDER BY started_at DESC LIMIT 20",
        [w],
      )
    ).rows.map((c) => ({ from: c.from_phone, status: c.status, consent: c.consent, recording: c.recording, seconds: c.duration_seconds, at: new Date(c.started_at).toISOString(), answered: !!c.accepted_by, voicemail: c.voicemail })),
  };
}

/** Settings, a number taking calls (or not), searching for and buying a number, a teammate's phone. */
export async function changeVoice(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>, origin: string) {
  const t = await authorize(db, w, principal, "workspace.manage");
  assert(await voiceOn(db, w), "VOICE_DISABLED", "Voice is not enabled for this workspace.", 404);
  return once(db, w, "voice:" + principal, key, p, async () => {
    const invalid = (m: string): never => {
      throw new DomainError("INVALID_VOICE", m, 400);
    };
    const MODES = ["none", "announce", "consent"];
    if (p.action === "settings") {
      const overrides = (p.recordingOverrides ?? {}) as Record<string, unknown>;
      if (typeof overrides !== "object" || Array.isArray(overrides) || Object.entries(overrides).some(([k, v]) => !/^\d{1,3}$/.test(k) || !MODES.includes(String(v))))
        invalid("Each country's recording is a calling code (44) and none, announce or consent.");
      if (!MODES.includes(String(p.recordingDefault))) invalid("Choose none, announce or consent for recording.");
      const ring = Number(p.ringSeconds);
      if (!Number.isInteger(ring) || ring < 10 || ring > 60) invalid("Ring each teammate for 10 to 60 seconds.");
      const greeting = String(p.voicemailGreeting ?? "").trim();
      if (greeting.length > 500) invalid("Keep the voicemail greeting to 500 characters.");
      if (typeof p.zoe !== "boolean" || typeof p.transcription !== "boolean") invalid("Switch Zoe and transcription on or off.");
      await settingsOf(db, w);
      await db.query(
        "UPDATE voice_settings SET zoe=$2,recording_default=$3,recording_overrides=$4,transcription=$5,voicemail_greeting=$6,ring_seconds=$7,updated_by=$8,updated_at=now() WHERE workspace_id=$1",
        [w, p.zoe, p.recordingDefault, JSON.stringify(overrides), p.transcription, greeting, ring, t.id],
      );
    } else if (p.action === "number") {
      const n = (await db.query<{ id: string }>("SELECT id FROM sms_numbers WHERE workspace_id=$1 AND id=$2 AND status='connected'", [w, String(p.numberId ?? "")])).rows[0];
      if (!n) invalid("Choose one of your connected numbers (Settings › SMS).");
      await db.query("UPDATE sms_numbers SET voice=$3,voice_error='' WHERE workspace_id=$1 AND id=$2", [w, n!.id, p.voice === true]);
      if (p.voice === true) await enqueueJob(db, w, "voice.number", { numberId: n!.id, voiceUrl: `${origin}/v1/hooks/voice/${w}/incoming`, statusUrl: `${origin}/v1/hooks/voice/${w}/status` }, {});
    } else if (p.action === "search") {
      const country = String(p.country ?? "").toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) invalid("A two-letter country code (GB, US).");
      await settingsOf(db, w);
      await db.query("UPDATE voice_settings SET last_search=$2,searched_at=NULL WHERE workspace_id=$1", [w, JSON.stringify({ country, searching: true })]);
      await enqueueJob(db, w, "voice.search", { country }, {});
    } else if (p.action === "buy") {
      // Buying costs money on the Twilio account: only a number the last search offered, confirmed.
      const phone = String(p.phone ?? "");
      const offered = (await db.query<{ last_search: { numbers?: { phone: string }[] } }>("SELECT last_search FROM voice_settings WHERE workspace_id=$1", [w])).rows[0]?.last_search?.numbers ?? [];
      if (!offered.some((n) => n.phone === phone)) invalid("Search for numbers first, then choose one of them.");
      if (p.confirm !== true) invalid("Confirm the purchase: it's charged to your Twilio account.");
      const brandId = String(p.brandId ?? "");
      if (!(await db.query("SELECT 1 FROM brands WHERE workspace_id=$1 AND id=$2", [w, brandId])).rows.length) invalid("Choose a brand.");
      await enqueueJob(db, w, "voice.buy", { phone, brandId, by: t.id, origin }, {});
    } else if (p.action === "agent") {
      const teammate = String(p.teammateId ?? "");
      if (!(await db.query("SELECT 1 FROM teammates WHERE workspace_id=$1 AND id=$2", [w, teammate])).rows.length) invalid("Choose a teammate.");
      const phone = smsChannel.address(String(p.phone ?? ""));
      if (!phone) invalid("That isn't a phone number (with its country code).");
      await db.query(
        "INSERT INTO voice_agents(workspace_id,teammate_id,phone,takes_calls) VALUES($1,$2,$3,$4) ON CONFLICT (workspace_id,teammate_id) DO UPDATE SET phone=EXCLUDED.phone,takes_calls=EXCLUDED.takes_calls,updated_at=now()",
        [w, teammate, phone, p.takesCalls !== false],
      );
    } else invalid("Unknown change.");
    return readVoice(db, w, principal);
  });
}

/** `voice.number`: a number's calls (and their status) pointed at Relay. */
export async function configureVoiceNumberJob(connect: Connect, env: VoiceEnvironment, job: Job) {
  const w = job.workspace_id;
  const { numberId, voiceUrl, statusUrl } = job.payload as { numberId: string; voiceUrl: string; statusUrl: string };
  const ready = await tenant(connect, w, async (db) => {
    const n = (await db.query<{ number_sid: string | null }>("SELECT number_sid FROM sms_numbers WHERE workspace_id=$1 AND id=$2 AND voice", [w, numberId])).rows[0];
    return n?.number_sid && env.key ? { sid: n.number_sid, c: await credentials(db, w, env.key) } : null;
  });
  if (!ready?.c || !env.api) return { done: true, result: { skipped: true } };
  try {
    await env.api.configureVoice(ready.c, ready.sid, voiceUrl, statusUrl);
    return { done: true, result: { configured: true } };
  } catch (e) {
    if (e instanceof SmsRejected) {
      await tenant(connect, w, (db) => db.query("UPDATE sms_numbers SET voice=false,voice_error=$3 WHERE workspace_id=$1 AND id=$2", [w, numberId, `Twilio refused: ${e.message}`.slice(0, 300)]));
      return { done: true, result: { configured: false } };
    }
    throw e;
  }
}

/** `voice.search`: numbers Twilio offers in a country, kept for Settings to show. */
export async function searchNumbersJob(connect: Connect, env: VoiceEnvironment, job: Job) {
  const w = job.workspace_id;
  const { country } = job.payload as { country: string };
  const c = env.key ? await tenant(connect, w, (db) => credentials(db, w, env.key!)) : null;
  const save = (v: Record<string, unknown>) => tenant(connect, w, (db) => db.query("UPDATE voice_settings SET last_search=$2,searched_at=now() WHERE workspace_id=$1", [w, JSON.stringify({ country, ...v })]));
  if (!c || !env.api) {
    await save({ numbers: [], error: "Connect the Twilio account first (Settings › SMS)." });
    return { done: true, result: { found: 0 } };
  }
  try {
    const numbers = await env.api.searchNumbers(c, country);
    await save({ numbers: numbers.filter((n) => n.voice) });
    return { done: true, result: { found: numbers.length } };
  } catch (e) {
    if (e instanceof SmsRejected) {
      await save({ numbers: [], error: `Twilio refused: ${e.message}` });
      return { done: true, result: { found: 0 } };
    }
    throw e;
  }
}

/** `voice.buy`: the number bought into the account, its texts and calls pointed at Relay, added for the brand. */
export async function buyNumberJob(connect: Connect, env: VoiceEnvironment, job: Job) {
  const w = job.workspace_id;
  const { phone, brandId, by, origin } = job.payload as { phone: string; brandId: string; by: string; origin: string };
  const c = env.key ? await tenant(connect, w, (db) => credentials(db, w, env.key!)) : null;
  if (!c || !env.api) return { done: true, result: { bought: false } };
  // Bought once: the job's retry finds the number already there.
  const already = await tenant(connect, w, async (db) => (await db.query("SELECT 1 FROM sms_numbers WHERE workspace_id=$1 AND phone=$2 AND status<>'removed'", [w, phone])).rows.length > 0);
  if (already) return { done: true, result: { bought: false, reason: "Already added." } };
  try {
    const r = await env.api.buyNumber(c, phone, {
      smsUrl: `${origin}/v1/hooks/sms/${w}/message`,
      voiceUrl: `${origin}/v1/hooks/voice/${w}/incoming`,
      statusUrl: `${origin}/v1/hooks/voice/${w}/status`,
    });
    await tenant(connect, w, (db) =>
      db.query(
        "INSERT INTO sms_numbers(workspace_id,id,brand_id,phone,calling_code,number_sid,is_default,status,voice,created_by) VALUES($1,$2,$3,$4,$5,$6,NOT EXISTS (SELECT 1 FROM sms_numbers WHERE workspace_id=$1 AND brand_id=$3 AND status<>'removed'),'connected',true,$7)",
        [w, crypto.randomUUID(), brandId, phone, callingCode(phone), r.sid, by],
      ),
    );
    return { done: true, result: { bought: true } };
  } catch (e) {
    if (e instanceof SmsRejected) {
      await tenant(connect, w, (db) => db.query("UPDATE voice_settings SET last_search=last_search||$2 WHERE workspace_id=$1", [w, JSON.stringify({ error: `Couldn't buy ${phone}: ${e.message}` })]));
      return { done: true, result: { bought: false } };
    }
    throw e;
  }
}
