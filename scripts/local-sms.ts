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
      return LOCAL_TWILIO.numbers.includes(phone) ? { sid: "PN" + phone.replace(/\D/g, ""), sms: true } : null;
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
  };
  return {
    api,
    sent,
    configured,
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
    /** A sent text's status (delivered, undelivered or failed, with Twilio's error code). */
    status(sid: string, status: string, errorCode?: string) {
      return { AccountSid: LOCAL_TWILIO.sid, MessageSid: sid, MessageStatus: status, ...(errorCode ? { ErrorCode: errorCode } : {}) };
    },
  };
}
export type LocalSms = ReturnType<typeof localSms>;
