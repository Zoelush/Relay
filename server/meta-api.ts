/**
 * Instagram and Facebook Messenger's provider (phase 12, step E7; docs/OMNICHANNEL_STEP7.md):
 * Meta's Graph API (the Messenger Platform, and Instagram messaging through the linked Page),
 * behind a port. Tests and the local relay use the stand-in in `scripts/local-meta.ts`.
 */
export class MetaRejected extends Error {
  constructor(
    message: string,
    /** Meta's error code (10: outside the allowed window; 551: the person isn't available; …). */
    public code: number,
  ) {
    super(message);
  }
}
export type Platform = "facebook" | "instagram";
export interface MetaApi {
  /** The Page, and the Instagram business account linked to it (which also proves the token). */
  page(token: string, pageId: string): Promise<{ name: string; instagram: { id: string; username: string } | null }>;
  /** A message (Meta's JSON, sent as the Page); its message id. Throws `MetaRejected` when retrying can't help. */
  send(token: string, pageId: string, body: Record<string, unknown>): Promise<{ messageId: string }>;
  /** The person's name, as the platform shows it to the Page (best effort). */
  profile(token: string, userId: string, platform: Platform): Promise<{ name: string }>;
  /** An attachment a person sent, from Meta's CDN only. */
  download(url: string): Promise<{ bytes: Uint8Array; mime: string }>;
}
/** Meta's CDN hosts: the only places an inbound attachment is fetched from. */
export const META_CDN = /^https:\/\/([a-z0-9-]+\.)*(fbcdn\.net|fbsbx\.com|cdninstagram\.com)\//i;

export function graphMessaging(options: { fetch?: typeof fetch; base?: string } = {}): MetaApi {
  const f = options.fetch ?? fetch;
  const base = options.base ?? "https://graph.facebook.com/v21.0";
  const call = async (token: string, path: string, body?: Record<string, unknown>) => {
    const r = await f(base + path, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string; code?: number } };
    if (r.ok) return json;
    const code = Number(json.error?.code ?? 0);
    const message = json.error?.message ?? `Meta answered ${r.status}.`;
    if (r.status >= 400 && r.status < 500 && r.status !== 429 && code !== 4 && code !== 613) throw new MetaRejected(message, code);
    throw new Error(message);
  };
  return {
    async page(token, pageId) {
      const j = await call(token, `/${encodeURIComponent(pageId)}?fields=name,instagram_business_account{id,username}`);
      const ig = j.instagram_business_account as { id?: string; username?: string } | undefined;
      return { name: String(j.name ?? ""), instagram: ig?.id ? { id: String(ig.id), username: String(ig.username ?? "") } : null };
    },
    async send(token, pageId, body) {
      const j = await call(token, `/${encodeURIComponent(pageId)}/messages`, body);
      if (!j.message_id) throw new Error("Meta didn't return a message id.");
      return { messageId: String(j.message_id) };
    },
    async profile(token, userId, platform) {
      try {
        const j = await call(token, `/${encodeURIComponent(userId)}?fields=${platform === "instagram" ? "name,username" : "first_name,last_name"}`);
        return { name: String(platform === "instagram" ? (j.name ?? j.username ?? "") : [j.first_name, j.last_name].filter(Boolean).join(" ")) };
      } catch {
        return { name: "" };
      }
    },
    async download(url) {
      if (!META_CDN.test(url)) throw new MetaRejected("Not Meta's CDN.", 0);
      const r = await f(url, { redirect: "error" });
      if (!r.ok) throw new Error(`The attachment couldn't be downloaded (${r.status}).`);
      return { bytes: new Uint8Array(await r.arrayBuffer()), mime: (r.headers.get("content-type") ?? "application/octet-stream").split(";")[0] };
    },
  };
}
