import { WhatsAppRejected, type TemplateDraft, type WhatsAppApi } from "../server/whatsapp-api";

/**
 * WhatsApp's stand-in (phase 12, step E5), for tests and the local relay: Meta's Cloud API as far
 * as Relay uses it, kept in memory (messages sent, media, templates), and webhook calls built and
 * signed as Meta signs them, so they go through `/v1/hooks/whatsapp/<workspace>` and its check.
 * `reject` makes a recipient's sends fail as Meta refuses them; `state.fail` makes Meta unreachable.
 */
export const LOCAL_WHATSAPP = {
  phoneNumberId: "100000000000001",
  wabaId: "200000000000001",
  token: "local-stand-in-access-token-0001",
  appSecret: "0123456789abcdef0123456789abcdef",
};
export function localWhatsApp() {
  const sent: { phoneNumberId: string; message: Record<string, unknown>; messageId: string }[] = [];
  const media = new Map<string, { bytes: Uint8Array; mime: string; name?: string }>();
  const templates: { id: string; name: string; language: string; status: string; draft: TemplateDraft }[] = [];
  const reject = new Map<string, { code: number; message: string }>();
  const state = { fail: false };
  const reachable = () => {
    if (state.fail) throw new Error("The stand-in Meta is down.");
  };
  const api: WhatsAppApi = {
    async phoneNumber(token) {
      reachable();
      if (token !== LOCAL_WHATSAPP.token) throw new WhatsAppRejected("Invalid OAuth access token.", 190);
      return { displayNumber: "+44 7700 900123", verifiedName: "Relay Demo", quality: "GREEN" };
    },
    async send(_token, phoneNumberId, message) {
      reachable();
      const r = reject.get(String(message.to));
      if (r) throw new WhatsAppRejected(r.message, r.code);
      const messageId = "wamid.local-" + crypto.randomUUID();
      sent.push({ phoneNumberId, message, messageId });
      return { messageId };
    },
    async uploadMedia(_token, _id, bytes, mime, name) {
      reachable();
      const mediaId = "media-" + crypto.randomUUID();
      media.set(mediaId, { bytes, mime, name });
      return { mediaId };
    },
    async downloadMedia(_token, mediaId) {
      reachable();
      const m = media.get(mediaId);
      if (!m) throw new WhatsAppRejected("Media not found.", 100);
      return { bytes: m.bytes, mime: m.mime };
    },
    async createTemplate(_token, _waba, t) {
      reachable();
      const id = "tpl-" + crypto.randomUUID().slice(0, 8);
      templates.push({ id, name: t.name, language: t.language, status: "PENDING", draft: t });
      return { id, status: "PENDING" };
    },
    async templates() {
      reachable();
      return templates.map((t) => ({ id: t.id, name: t.name, language: t.language, status: t.status }));
    },
  };
  const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  /** A webhook call as Meta posts it: the body and its `X-Hub-Signature-256`. */
  async function signed(payload: unknown, appSecret = LOCAL_WHATSAPP.appSecret) {
    const body = JSON.stringify(payload);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return { body, signature: "sha256=" + hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))) };
  }
  const wrap = (field: string, value: Record<string, unknown>) => ({ object: "whatsapp_business_account", entry: [{ id: LOCAL_WHATSAPP.wabaId, changes: [{ field, value }] }] });
  const metadata = (phoneNumberId: string) => ({ messaging_product: "whatsapp", metadata: { display_phone_number: "447700900123", phone_number_id: phoneNumberId } });
  return {
    api,
    sent,
    media,
    templates,
    reject,
    state,
    signed,
    /** A customer's message (`message` is Meta's, without from and id). */
    message(o: { from: string; name?: string; message: Record<string, unknown>; id?: string; phoneNumberId?: string }) {
      const id = o.id ?? "wamid.in-" + crypto.randomUUID();
      return wrap("messages", {
        ...metadata(o.phoneNumberId ?? LOCAL_WHATSAPP.phoneNumberId),
        contacts: [{ profile: { name: o.name ?? "" }, wa_id: o.from }],
        messages: [{ from: o.from, id, timestamp: String(Math.floor(Date.now() / 1000)), ...o.message }],
      });
    },
    /** A sent message's status (sent, delivered, read, failed with Meta's error). */
    status(messageId: string, status: string, error?: { code: number; title: string; message?: string }, phoneNumberId = LOCAL_WHATSAPP.phoneNumberId) {
      return wrap("messages", { ...metadata(phoneNumberId), statuses: [{ id: messageId, status, timestamp: String(Math.floor(Date.now() / 1000)), ...(error ? { errors: [error] } : {}) }] });
    },
    /** Meta's review of a template. */
    review(templateId: string, event: "APPROVED" | "REJECTED" | "PAUSED", reason = "NONE") {
      const t = templates.find((x) => x.id === templateId);
      if (t) t.status = event;
      return wrap("message_template_status_update", { event, message_template_id: templateId, reason });
    },
    /** A media item a customer sent (its id goes in their message). */
    addMedia(bytes: Uint8Array, mime: string) {
      const id = "media-in-" + crypto.randomUUID();
      media.set(id, { bytes, mime });
      return id;
    },
  };
}
export type LocalWhatsApp = ReturnType<typeof localWhatsApp>;
