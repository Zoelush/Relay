import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import { authorize } from "./policy";
import { deliveryReport, receiveInbound, registerChannel, type ChannelAdapter, type ChannelEnvironment, type SendResult } from "./channels";
import { seal, unseal } from "./connectors";
import { MAX_ATTACHMENT_BYTES, type AttachmentStorage } from "./attachments";
import { MetaRejected, type MetaApi, type Platform } from "./meta-api";
import { scrubPayload } from "./redaction";

/**
 * Instagram and Facebook Messenger (phase 12, step E7; docs/OMNICHANNEL_STEP7.md), behind
 * `channels_v1` and `channel_facebook_v1` / `channel_instagram_v1`: two channels, one connection
 * (a brand's Facebook Page and the Instagram business account linked to it, with the workspace's
 * own Meta app).
 *
 * - **The webhook:** `/v1/hooks/meta/<workspace>`, set up with the Page's verify token; every call
 *   kept only when signed with the app secret, and read by the `meta.receive` job.
 * - **In:** messages (text, quick replies, attachments from Meta's CDN, scanned), Instagram story
 *   replies and mentions (with the story's link); threaded by person within 7 days; the person's
 *   id is the platform's own (scoped to the Page), verified by Meta. The Page's own messages
 *   (echoes) are ignored; deliveries and reads move replies forward.
 * - **The windows:** 24 hours after the person's last message, anything may be sent; up to 7 days,
 *   only a teammate's reply, tagged HUMAN_AGENT (as Meta allows for human support); after that,
 *   nothing until they write again.
 * - **Out:** text, options as quick replies (13 at most), files by a short-lived signed link
 *   (Instagram takes pictures, video and audio; Messenger files too).
 */
export type MetaEnvironment = { api?: MetaApi; key?: string; storage?: AttachmentStorage };
const envOf = (env: ChannelEnvironment) => env.providers?.meta as MetaEnvironment | undefined;
const STANDARD_HOURS = 24;
const HUMAN_AGENT_DAYS = 7;
const THREAD_DAYS = 7;
const sealId = (pageId: string) => `meta:${pageId}`;
/** The time windows are judged at: now, unless a test moves it on (parts are append-only). */
export const metaClock = { now: () => Date.now() };

async function enabled(db: Sql, w: string, platform?: Platform) {
  const names = platform ? ["channels_v1", `channel_${platform}_v1`] : ["channels_v1"];
  const on = (await db.query<{ name: string }>("SELECT name FROM workspace_features WHERE workspace_id=$1 AND enabled AND name LIKE 'channel%'", [w])).rows.map((r) => r.name);
  if (!names.every((n) => on.includes(n))) return false;
  return platform ? true : on.includes("channel_facebook_v1") || on.includes("channel_instagram_v1");
}
/** The person's last message on the platform in a conversation: the windows run from it. */
async function windowOf(db: Sql, w: string, platform: Platform, conversationId: string) {
  const last = (
    await db.query<{ at: string | null }>(
      "SELECT max(created_at) AS at FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND kind='customer_message' AND channel=$3",
      [w, conversationId, platform],
    )
  ).rows[0].at;
  if (!last) return { open: false, closesAt: null as string | null, humanUntil: null as string | null, human: false };
  const t = new Date(last).getTime();
  const now = metaClock.now();
  const closes = t + STANDARD_HOURS * 3_600_000;
  const human = t + HUMAN_AGENT_DAYS * 86_400_000;
  return { open: closes > now, closesAt: new Date(closes).toISOString(), humanUntil: new Date(human).toISOString(), human: human > now };
}
/** The Page a conversation is on: the one the person last wrote to, else its brand's. */
async function pageFor(db: Sql, w: string, platform: Platform, conversationId: string) {
  const fromPart = (
    await db.query<{ page: string | null }>(
      "SELECT data->'meta'->>'pageId' AS page FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND kind='customer_message' AND channel=$3 ORDER BY seq DESC LIMIT 1",
      [w, conversationId, platform],
    )
  ).rows[0]?.page;
  return (
    await db.query<{ id: string; page_id: string; status: string; token_sealed: string; ig_account_id: string | null }>(
      `SELECT id,page_id,status,token_sealed,ig_account_id FROM meta_pages WHERE workspace_id=$1 AND status<>'disconnected'
         AND (id=$2 OR ($2 IS NULL AND brand_id=(SELECT brand_id FROM conversations WHERE workspace_id=$1 AND id=$3)))
       ORDER BY created_at LIMIT 1`,
      [w, fromPart ?? null, conversationId],
    )
  ).rows[0];
}
const FILE_KIND = (platform: Platform, mime: string): "image" | "video" | "audio" | "file" | null =>
  mime === "image/png" || mime === "image/jpeg"
    ? "image"
    : mime.startsWith("video/")
      ? "video"
      : mime.startsWith("audio/")
        ? "audio"
        : platform === "facebook"
          ? "file"
          : null;

type Prepared = { pageId: string; token: string; body: Record<string, unknown>; file: { key: string; kind: string } | null };

function adapter(platform: Platform): ChannelAdapter {
  const name = platform === "facebook" ? "Messenger" : "Instagram";
  return {
    id: platform,
    flag: `channel_${platform}_v1`,
    // Text, files, quick replies, 2,000 characters (Messenger; Instagram's is 1,000), the 24-hour
    // window; Zoe may answer within it (Meta verifies the account); read receipts.
    capabilities: {
      richText: false,
      attachments: true,
      buttons: true,
      maxLength: platform === "facebook" ? 2000 : 1000,
      windowHours: STANDARD_HOURS,
      ai: true,
      receipts: "read",
      address: "account",
    },
    /** The person's id, scoped to the Page (digits). */
    address: (raw) => (/^\d{5,30}$/.test(raw.trim()) ? raw.trim() : null),
    async refuses(db, w, conversationId, part) {
      const win = await windowOf(db, w, platform, conversationId);
      if (win.open) return null;
      if (win.human && part?.author === "teammate") return null;
      if (win.human) return `${name}'s 24-hour window has closed: only a teammate can reply now (until ${HUMAN_AGENT_DAYS} days after their last message).`;
      return `${name}'s 7-day window has closed: they need to message you first.`;
    },
    async prepare(db, w, out, env) {
      const e = envOf(env);
      if (!e?.api || !e.key) return { refuse: `${name} isn't set up for Relay yet.` };
      const page = await pageFor(db, w, platform, out.conversationId);
      if (!page || page.status !== "connected") return { refuse: "The brand's Facebook Page isn't connected." };
      if (platform === "instagram" && !page.ig_account_id) return { refuse: "No Instagram account is linked to the brand's Page." };
      const win = await windowOf(db, w, platform, out.conversationId);
      const part = (await db.query<{ kind: string; author_type: string }>("SELECT kind,author_type FROM conversation_parts WHERE workspace_id=$1 AND id=$2", [w, out.partId])).rows[0];
      // Within 24 hours a response; after, a teammate's reply tagged HUMAN_AGENT (refuses() said who may).
      const tag = win.open ? { messaging_type: "RESPONSE" } : { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" };
      let message: Record<string, unknown>;
      let file: Prepared["file"] = null;
      if (part.kind === "attachment" && typeof out.data.attachmentId === "string") {
        const f = (
          await db.query<{ mime: string; size: string; status: string; clean_key: string | null }>("SELECT mime,size,status,clean_key FROM attachments WHERE workspace_id=$1 AND id=$2", [
            w,
            out.data.attachmentId,
          ])
        ).rows[0];
        if (!f || f.status !== "clean" || !f.clean_key) return { refuse: "The file isn't ready to send (it hasn't passed its scan)." };
        const kind = FILE_KIND(platform, f.mime);
        if (!kind) return { refuse: `${name} takes pictures, video and audio, not documents: send a link instead.` };
        if (Number(f.size) > 25 * 1024 * 1024) return { refuse: "The file is larger than 25 MB, too large for Meta." };
        file = { key: f.clean_key, kind };
        message = {};
      } else
        message = {
          text: out.text,
          ...(out.options?.length ? { quick_replies: out.options.slice(0, 13).map((o, i) => ({ content_type: "text", title: o.slice(0, 20), payload: `option-${i}` })) } : {}),
        };
      return {
        data: {
          pageId: page.page_id,
          token: await unseal(e.key, w, sealId(page.id), "token", page.token_sealed),
          body: { recipient: { id: out.address }, ...tag, message },
          file,
        } satisfies Prepared,
      };
    },
    async send(out, env): Promise<SendResult> {
      const e = envOf(env);
      const p = out.prepared as Prepared | undefined;
      if (!e?.api || !p) return { status: "failed", error: `${name} isn't set up for Relay yet.`, permanent: true };
      let body = p.body;
      if (p.file) {
        // A short-lived signed link Meta fetches at once (the file is never public otherwise).
        if (!e.storage) return { status: "failed", error: "Files can't be sent from here.", permanent: true };
        const link = await e.storage.signDownload(p.file.key, false);
        body = { ...body, message: { attachment: { type: p.file.kind, payload: { url: link.url, is_reusable: false } } } };
      }
      try {
        const sent = await e.api.send(p.token, p.pageId, body);
        return { status: "sent", providerId: sent.messageId };
      } catch (err) {
        if (err instanceof MetaRejected) return { status: "failed", error: err.message.slice(0, 300), permanent: true };
        throw err;
      }
    },
    async replyDetails(db, w, conversationId) {
      const win = await windowOf(db, w, platform, conversationId);
      return {
        window: { open: win.open, closesAt: win.closesAt },
        windowNote: win.open
          ? null
          : win.human
            ? `${name}'s 24-hour window has closed: you can still reply until ${new Date(win.humanUntil!).toUTCString().slice(0, 22)} UTC (as a person, not automation).`
            : `${name}'s 7-day window has closed: they need to message you first.`,
      };
    },
  };
}
export const facebookChannel = adapter("facebook");
export const instagramChannel = adapter("instagram");
registerChannel(facebookChannel);
registerChannel(instagramChannel);
const adapterOfPlatform = (p: Platform) => (p === "facebook" ? facebookChannel : instagramChannel);

/* ------------------------------------------------------------------------------------------ */
/* The webhook                                                                                 */

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(secret: string, body: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)));
}
const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
const validWorkspace = (w: string) => /^[A-Za-z0-9_-]{1,100}$/.test(w);

/** `GET /v1/hooks/meta/<workspace>`: Meta's set-up check, answered for a Page's verify token. */
export async function verifyMetaWebhook(connect: Connect, w: string, q: URLSearchParams) {
  if (!validWorkspace(w) || q.get("hub.mode") !== "subscribe") return { status: 403, body: "" };
  try {
    return await tenant(connect, w, async (db) => {
      if (!(await enabled(db, w))) return { status: 404, body: "" };
      const ok = (await db.query("SELECT 1 FROM meta_pages WHERE workspace_id=$1 AND verify_token=$2 AND status<>'disconnected'", [w, q.get("hub.verify_token") ?? ""])).rows.length;
      return ok ? { status: 200, body: q.get("hub.challenge") ?? "" } : { status: 403, body: "" };
    });
  } catch {
    return { status: 404, body: "" };
  }
}

/** `POST /v1/hooks/meta/<workspace>`: kept once its signature (an app secret's) checks out. */
export async function receiveMetaWebhook(connect: Connect, key: string | undefined, w: string, raw: string, signature: string) {
  if (!validWorkspace(w) || !key) return { status: 404, body: {} };
  const given = signature.replace(/^sha256=/, "").toLowerCase();
  try {
    return await tenant(connect, w, async (db) => {
      if (!(await enabled(db, w))) return { status: 404, body: {} };
      const pages = (await db.query<{ id: string; app_secret_sealed: string }>("SELECT id,app_secret_sealed FROM meta_pages WHERE workspace_id=$1 AND status<>'disconnected'", [w])).rows;
      let signed = false;
      for (const p of pages) if (same(await hmac(await unseal(key, w, sealId(p.id), "app_secret", p.app_secret_sealed), raw), given)) signed = true;
      if (!signed) return { status: 403, body: { error: "The signature doesn't check out." } };
      let payload: { object?: string };
      try {
        payload = JSON.parse(raw);
      } catch {
        return { status: 400, body: { error: "Not JSON." } };
      }
      if (payload.object !== "page" && payload.object !== "instagram") return { status: 200, body: { ignored: true } };
      const id = crypto.randomUUID();
      await db.query("INSERT INTO meta_inbound(workspace_id,id,object,payload) VALUES($1,$2,$3,$4)", [w, id, payload.object, JSON.stringify(payload)]);
      await enqueueJob(db, w, "meta.receive", { inboundId: id }, {});
      return { status: 200, body: { received: true } };
    });
  } catch (e) {
    if (e instanceof DomainError) throw e;
    return { status: 404, body: {} };
  }
}

type Event = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload?: string };
    attachments?: { type?: string; payload?: { url?: string } }[];
    reply_to?: { story?: { url?: string; id?: string } };
  };
  delivery?: { mids?: string[]; watermark?: number };
  read?: { watermark?: number; mid?: string };
};
const KEPT = new Set(["image/png", "image/jpeg", "application/pdf", "text/plain"]);

/** The `meta.receive` job: one call's messages, deliveries and reads, on Messenger or Instagram. */
export async function receiveMetaJob(connect: Connect, env: MetaEnvironment, job: Job) {
  const w = job.workspace_id;
  const { inboundId } = job.payload as { inboundId: string };
  const ready = await tenant(connect, w, async (db) => {
    const row = (await db.query<{ status: string; object: string; payload: { entry?: { id?: string; messaging?: Event[] }[] } }>("SELECT status,object,payload FROM meta_inbound WHERE workspace_id=$1 AND id=$2", [w, inboundId])).rows[0];
    if (!row || row.status !== "received") return null;
    const pages = (await db.query<{ id: string; page_id: string; ig_account_id: string | null; brand_id: string; token_sealed: string }>("SELECT id,page_id,ig_account_id,brand_id,token_sealed FROM meta_pages WHERE workspace_id=$1 AND status<>'disconnected'", [w])).rows;
    return { row, pages };
  });
  if (!ready) return { done: true, result: { skipped: true } };
  const platform: Platform = ready.row.object === "instagram" ? "instagram" : "facebook";
  const events = (ready.row.payload.entry ?? []).flatMap((e) => (e.messaging ?? []).map((m) => ({ entry: e.id ?? "", m })));
  const pageOf = (entry: string) => ready.pages.find((p) => (platform === "instagram" ? p.ig_account_id === entry : p.page_id === entry));
  // Network first, outside any transaction: names (best effort) and attachments from Meta's CDN.
  const names = new Map<string, string>();
  const files = new Map<string, { key: string; name: string; mime: string; size: number }[]>();
  for (const { entry, m } of events) {
    const page = pageOf(entry);
    const from = m.sender?.id;
    if (!page || !from || !m.message || m.message.is_echo || !env.api || !env.key) continue;
    if (!names.has(from)) names.set(from, (await env.api.profile(await unseal(env.key, w, sealId(page.id), "token", page.token_sealed), from, platform)).name);
    for (const [i, a] of (m.message.attachments ?? []).entries()) {
      const url = a.payload?.url;
      if (!url || !["image", "file"].includes(a.type ?? "") || !env.storage?.putQuarantine) continue;
      try {
        const got = await env.api.download(url);
        if (!KEPT.has(got.mime) || !got.bytes.length || got.bytes.length > MAX_ATTACHMENT_BYTES) continue;
        const id = crypto.randomUUID();
        const k = `${encodeURIComponent(w)}/${id}/quarantine`;
        await env.storage.putQuarantine(k, got.bytes, got.mime);
        files.set(m.message.mid ?? "", [...(files.get(m.message.mid ?? "") ?? []), { key: k, name: `${a.type}-${i + 1}.${got.mime.split("/")[1]}`, mime: got.mime, size: got.bytes.length }]);
      } catch {
        // An attachment that can't be fetched (expired, not Meta's) is shown by its kind only.
      }
    }
  }
  await tenant(connect, w, async (db) => {
    for (const { entry, m } of events) {
      const page = pageOf(entry);
      if (!page) continue;
      // Delivered and read: by message id where given, else everything sent before the watermark.
      if (m.delivery) for (const mid of m.delivery.mids ?? []) await deliveryReport(db, w, platform, mid, { status: "delivered" });
      if (m.read) {
        if (m.read.mid) await deliveryReport(db, w, platform, m.read.mid, { status: "read" });
        else if (m.read.watermark && m.sender?.id)
          await db.query(
            "UPDATE channel_deliveries SET status='read',updated_at=now() WHERE workspace_id=$1 AND channel=$2 AND address=$3 AND status IN ('sent','delivered') AND created_at<=to_timestamp($4::double precision/1000)",
            [w, platform, m.sender.id, m.read.watermark],
          );
      }
      const msg = m.message;
      const from = m.sender?.id;
      // The Page's own messages (sent from Relay, or from Meta's inbox) come back as echoes: not the person's.
      if (!msg || msg.is_echo || !msg.mid || !from) continue;
      const story = msg.reply_to?.story;
      const mention = msg.attachments?.find((a) => a.type === "story_mention");
      const kinds = (msg.attachments ?? []).filter((a) => a.type !== "story_mention").map((a) => a.type ?? "attachment");
      const text = (
        story
          ? `Replied to your story: ${msg.text ?? ""}`.trim()
          : mention
            ? "Mentioned you in their story"
            : (msg.text ?? (kinds.length ? `[${kinds.length === 1 ? `A${kinds[0] === "image" || kinds[0] === "audio" ? "n" : ""} ${kinds[0]}` : `${kinds.length} attachments`}]` : "[A message Relay can't show yet]"))
      ).slice(0, 2000);
      const r = await receiveInbound(db, w, adapterOfPlatform(platform), {
        externalId: msg.mid,
        address: from,
        // The id is Meta's own, scoped to the Page: Meta vouches for it.
        verified: true,
        name: names.get(from) ?? "",
        text,
        threadKeys: [],
        fallback: { key: `meta:${page.id}:${platform}:${from}`, days: THREAD_DAYS },
        brandId: page.brand_id,
        data: {
          meta: { pageId: page.id, platform },
          ...(story ? { story: { url: story.url ?? null, kind: "reply" } } : mention ? { story: { url: mention.payload?.url ?? null, kind: "mention" } } : {}),
        },
      });
      if (r.partId && !("duplicate" in r && r.duplicate))
        for (const f of files.get(msg.mid) ?? []) {
          const id = f.key.split("/")[1];
          await db.query(
            "INSERT INTO attachments(workspace_id,id,conversation_id,owner_identity_id,object_key,name,size,mime,audience,purpose,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'customer_visible','part','scanning')",
            [w, id, r.conversationId, r.identityId, f.key, f.name, f.size, f.mime],
          );
          const jobId = await enqueueJob(db, w, "attachment.scan", { attachmentId: id }, { identityId: r.identityId ?? undefined });
          await db.query("UPDATE attachments SET job_id=$3 WHERE workspace_id=$1 AND id=$2", [w, id, jobId]);
        }
    }
    await db.query("UPDATE meta_inbound SET status='read',read_at=now() WHERE workspace_id=$1 AND id=$2", [w, inboundId]);
    // Phase 16 C6b: read, so its text is redacted (the original isn't kept).
    await scrubPayload(db, w, "meta_inbound", inboundId);
  });
  return { done: true, result: { read: true } };
}

/* ------------------------------------------------------------------------------------------ */
/* Settings › Instagram & Facebook                                                             */

export async function readMeta(db: Sql, w: string, principal: string, origin: string) {
  await authorize(db, w, principal, "workspace.manage");
  assert(await enabled(db, w), "META_DISABLED", "Instagram and Facebook Messenger are not enabled for this workspace.", 404);
  const pages = (
    await db.query<{
      id: string;
      brand_id: string;
      brand: string;
      page_id: string;
      page_name: string;
      ig_account_id: string | null;
      ig_username: string;
      token_hint: string;
      verify_token: string;
      status: string;
      error: string;
      checked_at: string | null;
    }>(
      `SELECT p.id,p.brand_id,b.name AS brand,p.page_id,p.page_name,p.ig_account_id,p.ig_username,p.token_hint,p.verify_token,p.status,p.error,p.checked_at
       FROM meta_pages p JOIN brands b ON b.workspace_id=p.workspace_id AND b.id=p.brand_id WHERE p.workspace_id=$1 AND p.status<>'disconnected' ORDER BY p.created_at`,
      [w],
    )
  ).rows;
  return {
    platforms: { facebook: await enabled(db, w, "facebook"), instagram: await enabled(db, w, "instagram") },
    brands: (await db.query<{ id: string; name: string }>("SELECT id,name FROM brands WHERE workspace_id=$1 ORDER BY lower(name),id", [w])).rows,
    pages: pages.map((p) => ({
      id: p.id,
      brandId: p.brand_id,
      brandName: p.brand,
      pageId: p.page_id,
      pageName: p.page_name,
      instagram: p.ig_account_id ? { id: p.ig_account_id, username: p.ig_username } : null,
      tokenHint: p.token_hint,
      status: p.status,
      error: p.error,
      checkedAt: p.checked_at ? new Date(p.checked_at).toISOString() : null,
      webhook: { url: `${origin}/v1/hooks/meta/${w}`, verifyToken: p.verify_token },
    })),
  };
}

/** Connect a Page (its token and app secret sealed, then checked by a job), check it again, or disconnect it. */
export async function changeMeta(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>, origin: string, master: string | undefined) {
  const t = await authorize(db, w, principal, "workspace.manage");
  assert(await enabled(db, w), "META_DISABLED", "Instagram and Facebook Messenger are not enabled for this workspace.", 404);
  return once(db, w, "meta:" + principal, key, p, async () => {
    const invalid = (m: string): never => {
      throw new DomainError("INVALID_META", m, 400);
    };
    const page = async (id: unknown) => {
      const r = (await db.query<{ id: string }>("SELECT id FROM meta_pages WHERE workspace_id=$1 AND id=$2 AND status<>'disconnected'", [w, String(id ?? "")])).rows[0];
      assert(r, "META_PAGE_NOT_FOUND", "That Page isn't connected.", 404);
      return r.id;
    };
    if (p.action === "connect") {
      assert(master, "META_UNAVAILABLE", "Credentials can't be stored here: RELAY_CONNECTOR_KEY isn't configured.", 503);
      const brandId = String(p.brandId ?? "");
      if (!(await db.query("SELECT 1 FROM brands WHERE workspace_id=$1 AND id=$2", [w, brandId])).rows.length) invalid("Choose a brand.");
      const pageId = String(p.pageId ?? "").trim();
      const token = String(p.token ?? "").trim();
      const appSecret = String(p.appSecret ?? "").trim();
      if (!/^\d{5,30}$/.test(pageId)) invalid("The Page ID is the number Meta shows for the Page.");
      if (token.length < 20 || token.length > 1000 || /\s/.test(token)) invalid("Paste the Page's access token (from a system user, with pages_messaging and instagram_manage_messages).");
      if (!/^[0-9a-f]{32}$/i.test(appSecret)) invalid("Paste the app secret from the Meta app's basic settings (32 characters).");
      if ((await db.query("SELECT 1 FROM meta_pages WHERE workspace_id=$1 AND page_id=$2 AND status<>'disconnected'", [w, pageId])).rows.length) invalid("That Page is already connected.");
      // A Page connected before keeps its id, so its credentials are sealed again under it.
      const id = (await db.query<{ id: string }>("SELECT id FROM meta_pages WHERE workspace_id=$1 AND page_id=$2", [w, pageId])).rows[0]?.id ?? crypto.randomUUID();
      await db.query(
        `INSERT INTO meta_pages(workspace_id,id,brand_id,page_id,token_sealed,token_hint,app_secret_sealed,verify_token,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (workspace_id,id) DO UPDATE SET brand_id=EXCLUDED.brand_id,token_sealed=EXCLUDED.token_sealed,token_hint=EXCLUDED.token_hint,
           app_secret_sealed=EXCLUDED.app_secret_sealed,verify_token=EXCLUDED.verify_token,status='pending',error=''`,
        [w, id, brandId, pageId, await seal(master!, w, sealId(id), "token", token), token.slice(-4), await seal(master!, w, sealId(id), "app_secret", appSecret), crypto.randomUUID().replace(/-/g, ""), t.id],
      );
      await enqueueJob(db, w, "meta.check", { pageId: id }, {});
    } else if (p.action === "check") await enqueueJob(db, w, "meta.check", { pageId: await page(p.pageId) }, {});
    else if (p.action === "disconnect") await db.query("UPDATE meta_pages SET status='disconnected' WHERE workspace_id=$1 AND id=$2", [w, await page(p.pageId)]);
    else invalid("Unknown change.");
    return readMeta(db, w, principal, origin);
  });
}

/** `meta.check`: the Page and its linked Instagram account, from Meta, which proves the token. */
export async function checkMetaPageJob(connect: Connect, env: MetaEnvironment, job: Job) {
  const w = job.workspace_id;
  const { pageId } = job.payload as { pageId: string };
  const row = await tenant(connect, w, async (db) => (await db.query<{ page_id: string; token_sealed: string }>("SELECT page_id,token_sealed FROM meta_pages WHERE workspace_id=$1 AND id=$2", [w, pageId])).rows[0]);
  if (!row) return { done: true, result: { skipped: true } };
  const save = (status: string, error: string, d?: { name: string; ig: { id: string; username: string } | null }) =>
    tenant(connect, w, (db) =>
      db.query(
        `UPDATE meta_pages SET status=$3,error=$4,page_name=COALESCE($5,page_name),ig_account_id=CASE WHEN $5 IS NULL THEN ig_account_id ELSE $6 END,ig_username=COALESCE($7,ig_username),checked_at=now()
         WHERE workspace_id=$1 AND id=$2 AND status<>'disconnected'`,
        [w, pageId, status, error, d?.name ?? null, d?.ig?.id ?? null, d ? (d.ig?.username ?? "") : null],
      ),
    );
  if (!env.api || !env.key) {
    await save("failed", "Meta messaging isn't set up for Relay yet.");
    return { done: true, result: { checked: false } };
  }
  try {
    const d = await env.api.page(await unseal(env.key, w, sealId(pageId), "token", row.token_sealed), row.page_id);
    await save("connected", "", { name: d.name, ig: d.instagram });
    return { done: true, result: { checked: true } };
  } catch (e) {
    if (e instanceof MetaRejected) {
      await save("failed", `Meta refused: ${e.message}`.slice(0, 300));
      return { done: true, result: { checked: false } };
    }
    throw e;
  }
}
