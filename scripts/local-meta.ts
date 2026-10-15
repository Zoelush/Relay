import { MetaRejected, type MetaApi, type Platform } from "../server/meta-api";

/**
 * Instagram and Facebook Messenger's stand-in (phase 12, step E7), for tests and the local relay:
 * Meta's Graph API as far as Relay uses it, in memory (the Page, messages sent, profiles, CDN
 * files), and webhook calls built and signed as Meta signs them. `reject` makes a person's
 * messages fail as Meta refuses them; `state.fail` makes Meta unreachable.
 */
export const LOCAL_META = {
  pageId: "300000000000001",
  igAccountId: "17840000000000001",
  token: "local-stand-in-page-token-000000001",
  appSecret: "fedcba9876543210fedcba9876543210",
};
export function localMeta() {
  const sent: { pageId: string; body: Record<string, unknown>; messageId: string }[] = [];
  const cdn = new Map<string, { bytes: Uint8Array; mime: string }>();
  const people = new Map<string, string>();
  const reject = new Map<string, { code: number; message: string }>();
  const state = { fail: false, instagram: true };
  const reachable = () => {
    if (state.fail) throw new Error("The stand-in Meta is down.");
  };
  const api: MetaApi = {
    async page(token, pageId) {
      reachable();
      if (token !== LOCAL_META.token || pageId !== LOCAL_META.pageId) throw new MetaRejected("Invalid OAuth access token.", 190);
      return { name: "Relay Demo", instagram: state.instagram ? { id: LOCAL_META.igAccountId, username: "relay.demo" } : null };
    },
    async send(_token, pageId, body) {
      reachable();
      const r = reject.get(String((body.recipient as { id?: string }).id));
      if (r) throw new MetaRejected(r.message, r.code);
      const messageId = "m_local-" + crypto.randomUUID();
      sent.push({ pageId, body, messageId });
      return { messageId };
    },
    async profile(_token, userId) {
      return { name: people.get(userId) ?? "" };
    },
    async download(url) {
      reachable();
      const f = cdn.get(url);
      if (!f) throw new MetaRejected("Not found.", 100);
      return f;
    },
  };
  const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return {
    api,
    sent,
    cdn,
    people,
    reject,
    state,
    /** A webhook call as Meta posts it: the body and its `X-Hub-Signature-256`. */
    async signed(payload: unknown, appSecret = LOCAL_META.appSecret) {
      const body = JSON.stringify(payload);
      const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return { body, signature: "sha256=" + hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body))) };
    },
    /** A person's message (`message` is Meta's, without mid), on Messenger or Instagram. */
    message(platform: Platform, from: string, message: Record<string, unknown>, mid = "m_in-" + crypto.randomUUID()) {
      const entry = platform === "instagram" ? LOCAL_META.igAccountId : LOCAL_META.pageId;
      return {
        object: platform === "instagram" ? "instagram" : "page",
        entry: [{ id: entry, time: Date.now(), messaging: [{ sender: { id: from }, recipient: { id: entry }, timestamp: Date.now(), message: { mid, ...message } }] }],
      };
    },
    /** Delivered (by message ids) or read (by watermark, or by message id on Instagram). */
    receipt(platform: Platform, from: string, receipt: { delivery?: { mids: string[] }; read?: { watermark?: number; mid?: string } }) {
      const entry = platform === "instagram" ? LOCAL_META.igAccountId : LOCAL_META.pageId;
      return { object: platform === "instagram" ? "instagram" : "page", entry: [{ id: entry, time: Date.now(), messaging: [{ sender: { id: from }, recipient: { id: entry }, timestamp: Date.now(), ...receipt }] }] };
    },
    /** A file on Meta's CDN a person sent. */
    addFile(bytes: Uint8Array, mime: string) {
      const url = `https://scontent.xx.fbcdn.net/v/t1/${crypto.randomUUID()}`;
      cdn.set(url, { bytes, mime });
      return url;
    },
  };
}
export type LocalMeta = ReturnType<typeof localMeta>;
