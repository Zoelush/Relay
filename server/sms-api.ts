/**
 * SMS's provider (phase 12, step E6; docs/OMNICHANNEL_STEP6.md): Twilio's REST API, behind a
 * port, with the workspace's own account (basic auth with its SID and auth token). Tests and the
 * local relay use the stand-in in `scripts/local-sms.ts`.
 */
export class SmsRejected extends Error {
  constructor(
    message: string,
    /** Twilio's error code (21211: not a valid number; 21610: the recipient replied STOP; …). */
    public code: number,
  ) {
    super(message);
  }
}
export type SmsCredentials = { sid: string; token: string };
export interface SmsApi {
  /** The account, which also proves its credentials. */
  account(c: SmsCredentials): Promise<{ friendlyName: string; status: string }>;
  /** One of the account's numbers, by its E.164 form, or null when it isn't the account's. */
  number(c: SmsCredentials, phone: string): Promise<{ sid: string; sms: boolean } | null>;
  /** Points the number's incoming texts (and nothing else) at Relay. */
  configure(c: SmsCredentials, numberSid: string, smsUrl: string): Promise<void>;
  /** Sends; Twilio's message SID. Throws `SmsRejected` when retrying can't help. */
  send(c: SmsCredentials, m: { from: string; to: string; body: string; statusCallback: string }): Promise<{ sid: string }>;
  /** An MMS's media (or E9: a recording), fetched with the account's credentials. */
  download(c: SmsCredentials, url: string): Promise<{ bytes: Uint8Array; mime: string }>;
  /** E9: points the number's calls (and their status) at Relay. */
  configureVoice(c: SmsCredentials, numberSid: string, voiceUrl: string, statusUrl: string): Promise<void>;
  /** E9: numbers that can be bought in a country (ISO code), local by default. */
  searchNumbers(c: SmsCredentials, country: string): Promise<{ phone: string; locality: string; voice: boolean; sms: boolean }[]>;
  /** E9: buys a number into the account, its texts and calls pointed at Relay; its SID. */
  buyNumber(c: SmsCredentials, phone: string, urls: { smsUrl: string; voiceUrl: string; statusUrl: string }): Promise<{ sid: string }>;
  /** E9: records a call in progress (both sides, on two channels), reporting to `callback`. */
  startRecording(c: SmsCredentials, callSid: string, callback: string): Promise<{ sid: string }>;
  /** Phase 16 C5b: a recording deleted at Twilio (one already gone counts as deleted). */
  deleteRecording(c: SmsCredentials, sid: string): Promise<void>;
  /** Phase 16 C5b: a text's record deleted at Twilio (one already gone counts as deleted). */
  deleteMessage(c: SmsCredentials, sid: string): Promise<void>;
}

const auth = (c: SmsCredentials) => "Basic " + btoa(`${c.sid}:${c.token}`);
export function twilioApi(options: { fetch?: typeof fetch; base?: string } = {}): SmsApi {
  const f = options.fetch ?? fetch;
  const base = options.base ?? "https://api.twilio.com/2010-04-01";
  const call = async (c: SmsCredentials, path: string, form?: Record<string, string>, method?: "DELETE") => {
    const r = await f(`${base}/Accounts/${encodeURIComponent(c.sid)}${path}`, {
      method: method ?? (form ? "POST" : "GET"),
      headers: { authorization: auth(c), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.ok) return json;
    // Deleting something already gone is what was asked.
    if (method === "DELETE" && r.status === 404) return {};
    const message = String(json.message ?? `Twilio answered ${r.status}.`);
    if (r.status >= 400 && r.status < 500 && r.status !== 429) throw new SmsRejected(message, Number(json.code ?? 0));
    throw new Error(message);
  };
  return {
    async account(c) {
      const j = await call(c, ".json");
      return { friendlyName: String(j.friendly_name ?? ""), status: String(j.status ?? "") };
    },
    async number(c, phone) {
      const j = await call(c, `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phone)}`);
      const n = (j.incoming_phone_numbers as { sid: string; capabilities?: { sms?: boolean } }[] | undefined)?.[0];
      return n ? { sid: n.sid, sms: n.capabilities?.sms !== false } : null;
    },
    async configure(c, numberSid, smsUrl) {
      await call(c, `/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`, { SmsUrl: smsUrl, SmsMethod: "POST" });
    },
    async send(c, m) {
      const j = await call(c, "/Messages.json", { From: m.from, To: m.to, Body: m.body, StatusCallback: m.statusCallback });
      return { sid: String(j.sid) };
    },
    async configureVoice(c, numberSid, voiceUrl, statusUrl) {
      await call(c, `/IncomingPhoneNumbers/${encodeURIComponent(numberSid)}.json`, { VoiceUrl: voiceUrl, VoiceMethod: "POST", StatusCallback: statusUrl, StatusCallbackMethod: "POST" });
    },
    async searchNumbers(c, country) {
      const j = await call(c, `/AvailablePhoneNumbers/${encodeURIComponent(country)}/Local.json?PageSize=10`);
      return ((j.available_phone_numbers as { phone_number: string; locality?: string; capabilities?: { voice?: boolean; SMS?: boolean } }[] | undefined) ?? []).map((n) => ({
        phone: n.phone_number,
        locality: n.locality ?? "",
        voice: n.capabilities?.voice !== false,
        sms: n.capabilities?.SMS !== false,
      }));
    },
    async buyNumber(c, phone, urls) {
      const j = await call(c, "/IncomingPhoneNumbers.json", {
        PhoneNumber: phone,
        SmsUrl: urls.smsUrl,
        SmsMethod: "POST",
        VoiceUrl: urls.voiceUrl,
        VoiceMethod: "POST",
        StatusCallback: urls.statusUrl,
        StatusCallbackMethod: "POST",
      });
      return { sid: String(j.sid) };
    },
    async deleteRecording(c, sid) {
      await call(c, `/Recordings/${encodeURIComponent(sid)}.json`, undefined, "DELETE");
    },
    async deleteMessage(c, sid) {
      await call(c, `/Messages/${encodeURIComponent(sid)}.json`, undefined, "DELETE");
    },
    async startRecording(c, callSid, callback) {
      const j = await call(c, `/Calls/${encodeURIComponent(callSid)}/Recordings.json`, {
        RecordingChannels: "dual",
        RecordingStatusCallback: callback,
        RecordingStatusCallbackMethod: "POST",
      });
      return { sid: String(j.sid) };
    },
    async download(c, url) {
      if (!/^https:\/\/api\.twilio\.com\//.test(url)) throw new SmsRejected("Not Twilio's media.", 0);
      const r = await f(url, { headers: { authorization: auth(c) } });
      if (!r.ok) throw new Error(`The media couldn't be downloaded (${r.status}).`);
      return { bytes: new Uint8Array(await r.arrayBuffer()), mime: r.headers.get("content-type") ?? "application/octet-stream" };
    },
  };
}
