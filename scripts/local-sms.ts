import { SmsRejected, type SmsApi } from "../server/sms-api";
import { twilioSignature } from "../server/sms";

/**
 * SMS's stand-in (phase 12, step E6), for tests and the local relay: Twilio as far as Relay uses
 * it, in memory (the account, its numbers, texts sent, MMS media), and webhook calls signed as
 * Twilio signs them, so they go through `/v1/hooks/sms/<workspace>/…` and its check. `reject` makes
 * a recipient's texts fail as Twilio refuses them; `state.fail` makes Twilio unreachable.
 */
export const LOCAL_TWILIO = {
  sid: "AC" + "0".repeat(31) + "1",
  token: "0123456789abcdef0123456789abcdef",
  numbers: ["+447700900100", "+15005550006"],
};
export function localSms() {
  const sent: { from: string; to: string; body: string; statusCallback: string; sid: string }[] = [];
  const configured = new Map<string, string>();
  const voiceConfigured = new Map<string, { voiceUrl: string; statusUrl: string }>();
  const bought: { phone: string; sid: string; urls: { smsUrl: string; voiceUrl: string; statusUrl: string } }[] = [];
  const recordings: { callSid: string; callback: string; sid: string }[] = [];
  const deleted: { kind: "recording" | "message"; sid: string }[] = [];
  // The account's numbers: this stand-in's own, so a number bought here isn't another's.
  const numbers = [...LOCAL_TWILIO.numbers];
  const media = new Map<string, { bytes: Uint8Array; mime: string }>();
  const reject = new Map<string, { code: number; message: string }>();
  const state = { fail: false };
  const reachable = () => {
    if (state.fail) throw new Error("The stand-in Twilio is down.");
  };
  const authorised = (c: { sid: string; token: string }) => {
    if (c.sid !== LOCAL_TWILIO.sid || c.token !== LOCAL_TWILIO.token) throw new SmsRejected("Authenticate", 20003);
  };
  const api: SmsApi = {
    async account(c) {
      reachable();
      authorised(c);
      return { friendlyName: "Relay Demo", status: "active" };
    },
    async number(c, phone) {
      reachable();
      authorised(c);
      return numbers.includes(phone) ? { sid: "PN" + phone.replace(/\D/g, ""), sms: true } : null;
    },
    async configure(c, numberSid, smsUrl) {
      reachable();
      authorised(c);
      configured.set(numberSid, smsUrl);
    },
    async send(c, m) {
      reachable();
      authorised(c);
      const r = reject.get(m.to);
      if (r) throw new SmsRejected(r.message, r.code);
      const sid = "SM" + crypto.randomUUID().replace(/-/g, "");
      sent.push({ ...m, sid });
      return { sid };
    },
    async download(c, url) {
      reachable();
      authorised(c);
      const m = media.get(url);
      if (!m) throw new SmsRejected("Not found.", 20404);
      return m;
    },
    async configureVoice(c, numberSid, voiceUrl, statusUrl) {
      reachable();
      authorised(c);
      voiceConfigured.set(numberSid, { voiceUrl, statusUrl });
    },
    async searchNumbers(c, country) {
      reachable();
      authorised(c);
      if (country !== "GB" && country !== "US") throw new SmsRejected(`No numbers in ${country}.`, 21452);
      return country === "GB"
        ? [
            { phone: "+447700900200", locality: "London", voice: true, sms: true },
            { phone: "+447700900201", locality: "Leeds", voice: true, sms: true },
          ]
        : [{ phone: "+15005550010", locality: "Austin", voice: true, sms: true }];
    },
    async buyNumber(c, phone, urls) {
      reachable();
      authorised(c);
      const sid = "PN" + phone.replace(/\D/g, "");
      bought.push({ phone, sid, urls });
      if (!numbers.includes(phone)) numbers.push(phone);
      return { sid };
    },
    async startRecording(c, callSid, callback) {
      reachable();
      authorised(c);
      const sid = "RE" + crypto.randomUUID().replace(/-/g, "");
      recordings.push({ callSid, callback, sid });
      return { sid };
    },
    // Phase 16 C5b: what a deletion asked Twilio to delete.
    async deleteRecording(c, sid) {
      reachable();
      authorised(c);
      deleted.push({ kind: "recording", sid });
    },
    async deleteMessage(c, sid) {
      reachable();
      authorised(c);
      deleted.push({ kind: "message", sid });
    },
  };
  return {
    api,
    /** Phase 16 C5b: recordings and messages deleted at the stand-in's Twilio. */
    deleted,
    sent,
    configured,
    voiceConfigured,
    bought,
    recordings,
    media,
    reject,
    state,
    /** A call as Twilio posts it to `url`: the form body and its `X-Twilio-Signature`. */
    async signed(url: string, params: Record<string, string>, token = LOCAL_TWILIO.token) {
      const form = new URLSearchParams(params);
      return { body: form.toString(), signature: await twilioSignature(token, url, form) };
    },
    /** A customer's text (and MMS media, as `[mime, bytes]` pairs). */
    text(o: { from: string; to: string; body: string; media?: [string, Uint8Array][]; sid?: string }) {
      const p: Record<string, string> = { AccountSid: LOCAL_TWILIO.sid, MessageSid: o.sid ?? "SM" + crypto.randomUUID().replace(/-/g, ""), From: o.from, To: o.to, Body: o.body, NumMedia: String(o.media?.length ?? 0) };
      (o.media ?? []).forEach(([mime, bytes], i) => {
        const url = `https://api.twilio.com/2010-04-01/Accounts/${LOCAL_TWILIO.sid}/Messages/${p.MessageSid}/Media/ME${i}`;
        media.set(url, { bytes, mime });
        p[`MediaUrl${i}`] = url;
        p[`MediaContentType${i}`] = mime;
      });
      return p;
    },
    /** A call's step as Twilio posts it (voice, E9): the call, and what the step adds (Digits, SpeechResult). */
    call(o: { sid: string; from: string; to: string }, extra: Record<string, string> = {}) {
      return { AccountSid: LOCAL_TWILIO.sid, CallSid: o.sid, From: o.from, To: o.to, CallStatus: "in-progress", Direction: "inbound", ...extra };
    },
    /** A finished recording of a call (or its voicemail): the audio kept for `download`, and Twilio's callback. */
    recorded(callSid: string, bytes: Uint8Array, seconds: number) {
      const sid = "RE" + crypto.randomUUID().replace(/-/g, "");
      const url = `https://api.twilio.com/2010-04-01/Accounts/${LOCAL_TWILIO.sid}/Recordings/${sid}`;
      media.set(`${url}.mp3`, { bytes, mime: "audio/mpeg" });
      return { AccountSid: LOCAL_TWILIO.sid, CallSid: callSid, RecordingSid: sid, RecordingUrl: url, RecordingStatus: "completed", RecordingDuration: String(seconds) };
    },
    /** A sent text's status (delivered, undelivered or failed, with Twilio's error code). */
    status(sid: string, status: string, errorCode?: string) {
      return { AccountSid: LOCAL_TWILIO.sid, MessageSid: sid, MessageStatus: status, ...(errorCode ? { ErrorCode: errorCode } : {}) };
    },
  };
}
export type LocalSms = ReturnType<typeof localSms>;
