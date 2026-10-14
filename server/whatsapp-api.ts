/**
 * WhatsApp's provider (phase 12, step E5; docs/OMNICHANNEL_STEP5.md): Meta's Cloud API (the
 * Graph API), directly, behind a port. Tests and the local relay use the stand-in in
 * `scripts/local-whatsapp.ts`. Nothing calls it but the WhatsApp adapter, its receive job and
 * Settings › WhatsApp.
 */
export class WhatsAppRejected extends Error {
  constructor(
    message: string,
    /** Meta's error code (131026: undeliverable; 131047: outside the 24-hour window; …). */
    public code: number,
  ) {
    super(message);
  }
}
export type TemplateDraft = { name: string; language: string; category: "utility" | "marketing" | "authentication"; body: string; examples: string[] };
export interface WhatsAppApi {
  /** The number's details, which also proves the token and ids work. */
  phoneNumber(token: string, phoneNumberId: string): Promise<{ displayNumber: string; verifiedName: string; quality: string }>;
  /** A message (Meta's JSON); its WhatsApp message id. Throws `WhatsAppRejected` when retrying can't help. */
  send(token: string, phoneNumberId: string, message: Record<string, unknown>): Promise<{ messageId: string }>;
  uploadMedia(token: string, phoneNumberId: string, bytes: Uint8Array, mime: string, name: string): Promise<{ mediaId: string }>;
  /** An inbound media item's bytes. */
  downloadMedia(token: string, mediaId: string): Promise<{ bytes: Uint8Array; mime: string }>;
  createTemplate(token: string, wabaId: string, t: TemplateDraft): Promise<{ id: string; status: string }>;
  templates(token: string, wabaId: string): Promise<{ id: string; name: string; language: string; status: string; reason?: string }[]>;
}

const GRAPH = "https://graph.facebook.com/v21.0";
/** The Graph API, with the workspace's token on each call. */
export function graphApi(options: { fetch?: typeof fetch; base?: string } = {}): WhatsAppApi {
  const f = options.fetch ?? fetch;
  const base = options.base ?? GRAPH;
  const call = async (token: string, path: string, init: RequestInit = {}) => {
    const r = await f(base + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string; code?: number } };
    if (r.ok) return json;
    const code = Number(json.error?.code ?? 0);
    const message = json.error?.message ?? `Meta answered ${r.status}.`;
    // Bad requests and permission errors won't change by retrying; throttling and outages might.
    if (r.status >= 400 && r.status < 500 && r.status !== 429 && code !== 4 && code !== 80007) throw new WhatsAppRejected(message, code);
    throw new Error(message);
  };
  return {
    async phoneNumber(token, id) {
      const j = await call(token, `/${encodeURIComponent(id)}?fields=display_phone_number,verified_name,quality_rating`);
      return { displayNumber: String(j.display_phone_number ?? ""), verifiedName: String(j.verified_name ?? ""), quality: String(j.quality_rating ?? "") };
    },
    async send(token, id, message) {
      const j = await call(token, `/${encodeURIComponent(id)}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });
      const m = (j.messages as { id: string }[] | undefined)?.[0];
      if (!m) throw new Error("Meta didn't return a message id.");
      return { messageId: m.id };
    },
    async uploadMedia(token, id, bytes, mime, name) {
      const form = new FormData();
      form.set("messaging_product", "whatsapp");
      form.set("type", mime);
      form.set("file", new Blob([new Uint8Array(bytes)], { type: mime }), name);
      const j = await call(token, `/${encodeURIComponent(id)}/media`, { method: "POST", body: form });
      return { mediaId: String(j.id) };
    },
    async downloadMedia(token, mediaId) {
      const meta = await call(token, `/${encodeURIComponent(mediaId)}`);
      const r = await f(String(meta.url), { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`The media couldn't be downloaded (${r.status}).`);
      return { bytes: new Uint8Array(await r.arrayBuffer()), mime: String(meta.mime_type ?? "application/octet-stream") };
    },
    async createTemplate(token, wabaId, t) {
      const j = await call(token, `/${encodeURIComponent(wabaId)}/message_templates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: t.name,
          language: t.language,
          category: t.category.toUpperCase(),
          components: [{ type: "BODY", text: t.body, ...(t.examples.length ? { example: { body_text: [t.examples] } } : {}) }],
        }),
      });
      return { id: String(j.id), status: String(j.status ?? "PENDING") };
    },
    async templates(token, wabaId) {
      const j = await call(token, `/${encodeURIComponent(wabaId)}/message_templates?fields=id,name,language,status,rejected_reason&limit=200`);
      return ((j.data as Record<string, unknown>[] | undefined) ?? []).map((t) => ({
        id: String(t.id),
        name: String(t.name),
        language: String(t.language),
        status: String(t.status),
        reason: t.rejected_reason && t.rejected_reason !== "NONE" ? String(t.rejected_reason) : undefined,
      }));
    },
  };
}
