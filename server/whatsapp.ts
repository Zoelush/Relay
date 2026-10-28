import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import { authorize } from "./policy";
import { deliveryReport, receiveInbound, registerChannel, suppress, type ChannelAdapter, type ChannelEnvironment, type SendResult } from "./channels";
import { seal, unseal } from "./connectors";
import { MAX_ATTACHMENT_BYTES, type AttachmentStorage } from "./attachments";
import { WhatsAppRejected, type WhatsAppApi } from "./whatsapp-api";
import { scrubPayload } from "./redaction";

/**
 * WhatsApp Business (phase 12, step E5; docs/OMNICHANNEL_STEP5.md), behind `channels_v1` and
 * `channel_whatsapp_v1`, through Meta's Cloud API with the workspace's own app.
 *
 * - **Numbers:** a brand's number is connected with its ids, access token and app secret (sealed
 *   with RELAY_CONNECTOR_KEY). Meta's webhook calls `/v1/hooks/whatsapp/<workspace>`: set up with
 *   the number's verify token, and every call checked against its app secret's signature.
 * - **In:** the `whatsapp.receive` job reads each call: messages (text, buttons, media, which is
 *   downloaded and scanned) become the customer's, threaded by number within 7 days; statuses move
 *   deliveries forward; template reviews update templates. STOP opts out (the suppression list),
 *   START opts back in; a customer writing records an opt-in.
 * - **The 24-hour window:** after the customer's last message, anything may be sent for 24 hours;
 *   after it, only an approved template, to a number that opted in (`refuses`).
 * - **Out:** text, reply buttons (three, or a list of ten), files (uploaded to Meta), and templates.
 */
export type WhatsAppEnvironment = { api?: WhatsAppApi; key?: string; storage?: AttachmentStorage };
const envOf = (env: ChannelEnvironment) => env.providers?.whatsapp as WhatsAppEnvironment | undefined;
export const WINDOW_HOURS = 24;
const THREAD_DAYS = 7;
const sealId = (numberId: string) => `whatsapp:${numberId}`;
const STOP = /^\s*(stop|unsubscribe|opt[\s-]?out|cancel|quit|end|arrêt|arret|stopp|basta|parar|baja)\s*[.!]?\s*$/i;
const START = /^\s*(start|unstop|subscribe|opt[\s-]?in)\s*[.!]?\s*$/i;

async function whatsappOn(db: Sql, w: string) {
  return (
    (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_features WHERE workspace_id=$1 AND enabled AND name IN ('channels_v1','channel_whatsapp_v1')", [w]))
      .rows[0].n === 2
  );
}
/** The customer's WhatsApp number on a conversation (the address they last wrote from). */
async function customerPhone(db: Sql, w: string, conversationId: string) {
  return (
    (
      await db.query<{ address: string }>(
        `SELECT x.address FROM conversation_parts p JOIN identity_addresses x ON x.workspace_id=p.workspace_id AND x.identity_id=p.author_id AND x.channel='whatsapp'
         WHERE p.workspace_id=$1 AND p.conversation_id=$2 AND p.kind='customer_message' AND p.channel='whatsapp' ORDER BY p.seq DESC LIMIT 1`,
        [w, conversationId],
      )
    ).rows[0]?.address ?? null
  );
}
/** The time the window is judged at: now, unless a test moves it on (parts are append-only). */
export const whatsappClock = { now: () => Date.now() };
/** When the window closes (24 hours after the customer's last WhatsApp message), or null if it never opened. */
async function windowOf(db: Sql, w: string, conversationId: string) {
  const last = (
    await db.query<{ at: string | null }>(
      "SELECT max(created_at) AS at FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND kind='customer_message' AND channel='whatsapp'",
      [w, conversationId],
    )
  ).rows[0];
  if (!last.at) return { open: false, closesAt: null as string | null };
  const closes = new Date(new Date(last.at).getTime() + WINDOW_HOURS * 3_600_000);
  return { open: closes.getTime() > whatsappClock.now(), closesAt: closes.toISOString() };
}
/** The number a conversation is on: the one the customer last wrote to, else its brand's. */
async function numberFor(db: Sql, w: string, conversationId: string) {
  const fromPart = (
    await db.query<{ number_id: string | null }>(
      "SELECT data->'whatsapp'->>'numberId' AS number_id FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND kind='customer_message' AND channel='whatsapp' ORDER BY seq DESC LIMIT 1",
      [w, conversationId],
    )
  ).rows[0]?.number_id;
  return (
    await db.query<{ id: string; phone_number_id: string; waba_id: string; status: string; token_sealed: string; brand_id: string }>(
      `SELECT n.id,n.phone_number_id,n.waba_id,n.status,n.token_sealed,n.brand_id FROM whatsapp_numbers n
       WHERE n.workspace_id=$1 AND (n.id=$2 OR ($2 IS NULL AND n.brand_id=(SELECT brand_id FROM conversations WHERE workspace_id=$1 AND id=$3))) AND n.status<>'disconnected'
       ORDER BY (n.id=$2) DESC NULLS LAST,n.created_at LIMIT 1`,
      [w, fromPart ?? null, conversationId],
    )
  ).rows[0];
}

/* ------------------------------------------------------------------------------------------ */
/* The adapter                                                                                 */

type Template = { id: string; name: string; language: string; params: string[] };
type Prepared = {
  phoneNumberId: string;
  token: string;
  message: Record<string, unknown>;
  attachment: { key: string; name: string; mime: string; kind: "image" | "video" | "audio" | "document" } | null;
};
/** What a file is sent as, and Meta's limit for it. */
function mediaKind(mime: string): { kind: "image" | "video" | "audio" | "document"; max: number } {
  if (mime === "image/jpeg" || mime === "image/png") return { kind: "image", max: 5 * 1024 * 1024 };
  if (mime === "video/mp4" || mime === "video/3gpp") return { kind: "video", max: 16 * 1024 * 1024 };
  if (/^audio\/(aac|mp4|mpeg|amr|ogg)$/.test(mime)) return { kind: "audio", max: 16 * 1024 * 1024 };
  return { kind: "document", max: 100 * 1024 * 1024 };
}

export const whatsappChannel: ChannelAdapter = {
  id: "whatsapp",
  flag: "channel_whatsapp_v1",
  // Plain text (bold and the like are WhatsApp's own markup), files, three reply buttons, 4,096
  // characters, the 24-hour window; Zoe may answer (Meta verifies the number); read receipts.
  capabilities: { richText: false, attachments: true, buttons: true, maxLength: 4096, windowHours: WINDOW_HOURS, ai: true, receipts: "read", address: "phone" },
  /** E.164: a plus and 8 to 15 digits (WhatsApp's ids are the digits alone). */
  address: (raw) => {
    const m = /^\+?(\d{8,15})$/.exec(raw.replace(/[\s().-]/g, ""));
    return m ? "+" + m[1] : null;
  },
  async refuses(db, w, conversationId, part) {
    const template = (part?.data?.whatsapp as { template?: Template } | undefined)?.template;
    if (template) {
      // A template may go outside the window, to a number that opted in.
      const phone = await customerPhone(db, w, conversationId);
      if (!phone) return "There's no WhatsApp number to send to.";
      const opted = (await db.query("SELECT 1 FROM whatsapp_opt_ins WHERE workspace_id=$1 AND phone=$2 AND revoked_at IS NULL", [w, phone])).rows.length;
      return opted ? null : "This number hasn't opted in to WhatsApp messages: record their consent first.";
    }
    return (await windowOf(db, w, conversationId)).open ? null : "The 24-hour window has closed: send an approved template instead.";
  },
  async prepare(db, w, out, env) {
    const e = envOf(env);
    if (!e?.api || !e.key) return { refuse: "WhatsApp sending isn't set up for Relay yet." };
    const n = await numberFor(db, w, out.conversationId);
    if (!n || n.status !== "connected") return { refuse: "The brand's WhatsApp number isn't connected." };
    const token = await unseal(e.key, w, sealId(n.id), "token", n.token_sealed);
    const base = { messaging_product: "whatsapp", recipient_type: "individual", to: out.address.replace(/^\+/, "") };
    const template = (out.data.whatsapp as { template?: Template } | undefined)?.template;
    let message: Record<string, unknown>;
    let attachment: Prepared["attachment"] = null;
    const part = (await db.query<{ kind: string }>("SELECT kind FROM conversation_parts WHERE workspace_id=$1 AND id=$2", [w, out.partId])).rows[0];
    if (template)
      message = {
        ...base,
        type: "template",
        template: {
          name: template.name,
          language: { code: template.language },
          components: template.params.length ? [{ type: "body", parameters: template.params.map((text) => ({ type: "text", text })) }] : [],
        },
      };
    else if (part.kind === "attachment" && typeof out.data.attachmentId === "string") {
      const file = (
        await db.query<{ name: string; mime: string; size: string; status: string; clean_key: string | null }>(
          "SELECT name,mime,size,status,clean_key FROM attachments WHERE workspace_id=$1 AND id=$2",
          [w, out.data.attachmentId],
        )
      ).rows[0];
      if (!file || file.status !== "clean" || !file.clean_key) return { refuse: "The file isn't ready to send (it hasn't passed its scan)." };
      const { kind, max } = mediaKind(file.mime);
      if (Number(file.size) > max) return { refuse: `The file is too large for WhatsApp (${Math.round(max / 1024 / 1024)} MB at most for this kind).` };
      attachment = { key: file.clean_key, name: file.name, mime: file.mime, kind };
      message = { ...base, type: kind };
    } else if (out.options?.length && out.options.length <= 3)
      message = {
        ...base,
        type: "interactive",
        interactive: { type: "button", body: { text: out.text.slice(0, 1024) }, action: { buttons: out.options.map((o, i) => ({ type: "reply", reply: { id: `option-${i}`, title: o.slice(0, 20) } })) } },
      };
    else if (out.options?.length && out.options.length <= 10)
      message = {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: out.text.slice(0, 1024) },
          action: { button: "Choose", sections: [{ title: "Options", rows: out.options.map((o, i) => ({ id: `option-${i}`, title: o.slice(0, 24) })) }] },
        },
      };
    else message = { ...base, type: "text", text: { body: out.text, preview_url: true } };
    return { data: { phoneNumberId: n.phone_number_id, token, message, attachment } satisfies Prepared };
  },
  async send(out, env): Promise<SendResult> {
    const e = envOf(env);
    const p = out.prepared as Prepared | undefined;
    if (!e?.api || !p) return { status: "failed", error: "WhatsApp sending isn't set up for Relay yet.", permanent: true };
    let message = p.message;
    try {
      if (p.attachment) {
        if (!e.storage?.readClean) return { status: "failed", error: "Files can't be read for sending here.", permanent: true };
        const r = await e.storage.readClean(p.attachment.key);
        if (!r.ok) throw new Error("The file couldn't be read.");
        const { mediaId } = await e.api.uploadMedia(p.token, p.phoneNumberId, new Uint8Array(await r.arrayBuffer()), p.attachment.mime, p.attachment.name);
        message = { ...message, [p.attachment.kind]: { id: mediaId, ...(p.attachment.kind === "document" ? { filename: p.attachment.name } : {}) } };
      }
      const sent = await e.api.send(p.token, p.phoneNumberId, message);
      return { status: "sent", providerId: sent.messageId };
    } catch (err) {
      if (err instanceof WhatsAppRejected)
        // 131050: the customer stopped the business's messages on WhatsApp itself.
        return { status: "failed", error: err.message.slice(0, 300), permanent: true, ...(err.code === 131050 ? { suppress: "opt_out" as const } : {}) };
      throw err;
    }
  },
  async replyDetails(db, w, conversationId) {
    const n = await numberFor(db, w, conversationId);
    const templates = n
      ? (
          await db.query<{ id: string; name: string; language: string; body: string; params: number }>(
            "SELECT id,name,language,body,params FROM whatsapp_templates WHERE workspace_id=$1 AND number_id=$2 AND status='approved' ORDER BY name,language",
            [w, n.id],
          )
        ).rows
      : [];
    return { window: await windowOf(db, w, conversationId), templates };
  },
  async templateReply(db, w, conversationId, t) {
    const n = await numberFor(db, w, conversationId);
    const tpl = n
      ? (
          await db.query<{ id: string; name: string; language: string; body: string; params: number }>(
            "SELECT id,name,language,body,params FROM whatsapp_templates WHERE workspace_id=$1 AND id=$2 AND number_id=$3 AND status='approved'",
            [w, String(t.id ?? ""), n.id],
          )
        ).rows[0]
      : undefined;
    assert(tpl, "TEMPLATE_UNAVAILABLE", "Choose one of this number's approved templates.", 400);
    const params = (Array.isArray(t.params) ? t.params : []).map((x) => String(x).trim());
    // Meta refuses parameters with line breaks, tabs or four spaces in a row.
    assert(
      params.length === tpl!.params && params.every((x) => x && x.length <= 1024 && !/[\n\t]| {4}/.test(x)),
      "INVALID_TEMPLATE",
      `Fill in the template's ${tpl!.params} value${tpl!.params === 1 ? "" : "s"}, each on one line.`,
      400,
    );
    return {
      text: tpl!.body.replace(/\{\{(\d+)\}\}/g, (_, i) => params[Number(i) - 1] ?? ""),
      data: { whatsapp: { template: { id: tpl!.id, name: tpl!.name, language: tpl!.language, params } } },
    };
  },
};
registerChannel(whatsappChannel);

/* ------------------------------------------------------------------------------------------ */
/* The webhook                                                                                 */

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const validWorkspace = (w: string) => /^[A-Za-z0-9_-]{1,100}$/.test(w);

/** `GET /v1/hooks/whatsapp/<workspace>`: Meta's set-up check, answered with its challenge for a number's verify token. */
export async function verifyWhatsAppWebhook(connect: Connect, w: string, q: URLSearchParams) {
  if (!validWorkspace(w) || q.get("hub.mode") !== "subscribe") return { status: 403, body: "" };
  try {
    return await tenant(connect, w, async (db) => {
      if (!(await whatsappOn(db, w))) return { status: 404, body: "" };
      const ok = (await db.query("SELECT 1 FROM whatsapp_numbers WHERE workspace_id=$1 AND verify_token=$2 AND status<>'disconnected'", [w, q.get("hub.verify_token") ?? ""])).rows.length;
      return ok ? { status: 200, body: q.get("hub.challenge") ?? "" } : { status: 403, body: "" };
    });
  } catch {
    return { status: 404, body: "" };
  }
}

/** `POST /v1/hooks/whatsapp/<workspace>`: kept (once its signature checks out) and read by the job. */
export async function receiveWhatsAppWebhook(connect: Connect, key: string | undefined, w: string, raw: string, signature: string) {
  if (!validWorkspace(w) || !key) return { status: 404, body: {} };
  const given = signature.replace(/^sha256=/, "").toLowerCase();
  try {
    return await tenant(connect, w, async (db) => {
      if (!(await whatsappOn(db, w))) return { status: 404, body: {} };
      const numbers = (await db.query<{ id: string; app_secret_sealed: string }>("SELECT id,app_secret_sealed FROM whatsapp_numbers WHERE workspace_id=$1 AND status<>'disconnected'", [w])).rows;
      let signed = false;
      for (const n of numbers) if (same(await hmac(await unseal(key, w, sealId(n.id), "app_secret", n.app_secret_sealed), raw), given)) signed = true;
      if (!signed) return { status: 403, body: { error: "The signature doesn't check out." } };
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return { status: 400, body: { error: "Not JSON." } };
      }
      const id = crypto.randomUUID();
      await db.query("INSERT INTO whatsapp_inbound(workspace_id,id,payload) VALUES($1,$2,$3)", [w, id, JSON.stringify(payload)]);
      await enqueueJob(db, w, "whatsapp.receive", { inboundId: id }, {});
      return { status: 200, body: { received: true } };
    });
  } catch (e) {
    if (e instanceof DomainError) throw e;
    return { status: 404, body: {} };
  }
}

type WaMessage = {
  from: string;
  id: string;
  type: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  location?: { latitude?: number; longitude?: number; name?: string };
  image?: WaMedia;
  video?: WaMedia;
  audio?: WaMedia;
  document?: WaMedia;
  sticker?: WaMedia;
};
type WaMedia = { id: string; mime_type?: string; caption?: string; filename?: string };
type WaValue = {
  metadata?: { phone_number_id?: string };
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: WaMessage[];
  statuses?: { id: string; status: string; errors?: { code?: number; title?: string; message?: string }[] }[];
  event?: string;
  message_template_id?: string | number;
  reason?: string;
};
const KEPT = new Set(["image/png", "image/jpeg", "application/pdf", "text/plain"]);

/** What the inbox shows for a message. */
function textOf(m: WaMessage) {
  const media = m.image ?? m.video ?? m.audio ?? m.document ?? m.sticker;
  return (
    m.text?.body ??
    m.button?.text ??
    m.interactive?.button_reply?.title ??
    m.interactive?.list_reply?.title ??
    (m.location ? `[A location: ${m.location.name ? m.location.name + ", " : ""}${m.location.latitude}, ${m.location.longitude}]` : undefined) ??
    (media ? media.caption || `[${m.type === "document" ? `A file: ${media.filename ?? "document"}` : `A${m.type === "image" || m.type === "audio" ? "n" : ""} ${m.type}`}]` : undefined) ??
    `[A ${m.type} message Relay can't show yet]`
  ).slice(0, 4096);
}

/** The `whatsapp.receive` job: one webhook call's messages, statuses and template reviews. */
export async function receiveWhatsAppJob(connect: Connect, env: WhatsAppEnvironment, job: Job) {
  const w = job.workspace_id;
  const { inboundId } = job.payload as { inboundId: string };
  const ready = await tenant(connect, w, async (db) => {
    const row = (await db.query<{ status: string; payload: { entry?: { changes?: { field: string; value: WaValue }[] }[] } }>("SELECT status,payload FROM whatsapp_inbound WHERE workspace_id=$1 AND id=$2", [w, inboundId])).rows[0];
    if (!row || row.status !== "received") return null;
    const numbers = (await db.query<{ id: string; phone_number_id: string; brand_id: string; token_sealed: string }>("SELECT id,phone_number_id,brand_id,token_sealed FROM whatsapp_numbers WHERE workspace_id=$1", [w])).rows;
    return { changes: (row.payload.entry ?? []).flatMap((e) => e.changes ?? []), numbers };
  });
  if (!ready) return { done: true, result: { skipped: true } };
  // Media first, outside any transaction: downloaded with the number's token, kept in quarantine.
  const files = new Map<string, { key: string; name: string; mime: string; size: number }>();
  for (const ch of ready.changes) {
    if (ch.field !== "messages") continue;
    const n = ready.numbers.find((x) => x.phone_number_id === ch.value.metadata?.phone_number_id);
    if (!n || !env.api || !env.key || !env.storage?.putQuarantine) continue;
    const token = await unseal(env.key, w, sealId(n.id), "token", n.token_sealed);
    for (const m of ch.value.messages ?? []) {
      const media = m.image ?? m.document;
      if (!media || !KEPT.has(media.mime_type ?? "")) continue;
      const got = await env.api.downloadMedia(token, media.id);
      if (!got.bytes.length || got.bytes.length > MAX_ATTACHMENT_BYTES) continue;
      const id = crypto.randomUUID();
      const key = `${encodeURIComponent(w)}/${id}/quarantine`;
      await env.storage.putQuarantine(key, got.bytes, got.mime);
      files.set(m.id, { key, name: (media.filename ?? `${m.type}-${m.id.slice(-6)}.${got.mime.split("/")[1]}`).slice(0, 200), mime: got.mime, size: got.bytes.length });
    }
  }
  await tenant(connect, w, async (db) => {
    for (const ch of ready.changes) {
      const v = ch.value;
      if (ch.field === "message_template_status_update") {
        const status = { APPROVED: "approved", REJECTED: "rejected", PAUSED: "paused", DISABLED: "disabled", PENDING_DELETION: "disabled" }[String(v.event)] ?? null;
        if (status)
          await db.query("UPDATE whatsapp_templates SET status=$3,reason=$4,updated_at=now() WHERE workspace_id=$1 AND provider_id=$2", [
            w,
            String(v.message_template_id ?? ""),
            status,
            v.reason && v.reason !== "NONE" ? String(v.reason).slice(0, 300) : "",
          ]);
        continue;
      }
      if (ch.field !== "messages") continue;
      const n = ready.numbers.find((x) => x.phone_number_id === v.metadata?.phone_number_id);
      if (!n) continue;
      for (const s of v.statuses ?? []) {
        if (s.status === "delivered" || s.status === "read") await deliveryReport(db, w, "whatsapp", s.id, { status: s.status });
        else if (s.status === "failed") {
          const err = s.errors?.[0];
          await deliveryReport(db, w, "whatsapp", s.id, {
            status: "failed",
            error: (err?.message || err?.title || "WhatsApp couldn't deliver it.").slice(0, 300),
            ...(err?.code === 131050 ? { suppress: "opt_out" as const } : {}),
          });
        }
      }
      for (const m of v.messages ?? []) {
        const phone = whatsappChannel.address(m.from);
        if (!phone) continue;
        const text = textOf(m);
        // STOP opts out (nothing is sent to the number again until it opts back in); START opts back in.
        if (STOP.test(text)) {
          await suppress(db, w, "whatsapp", phone, "opt_out", `keyword:${m.id}`);
          await db.query("UPDATE whatsapp_opt_ins SET revoked_at=now() WHERE workspace_id=$1 AND phone=$2 AND revoked_at IS NULL", [w, phone]);
        } else if (START.test(text)) {
          await db.query(
            "UPDATE suppressions SET lifted_at=now(),note=CASE WHEN note='' THEN 'Opted back in (START).' ELSE note END WHERE workspace_id=$1 AND channel='whatsapp' AND address=$2 AND reason='opt_out' AND lifted_at IS NULL",
            [w, phone],
          );
          await db.query("INSERT INTO whatsapp_opt_ins(workspace_id,id,phone,source) VALUES($1,$2,$3,'keyword') ON CONFLICT DO NOTHING", [w, crypto.randomUUID(), phone]);
        } else {
          // Writing to the business is consent to be answered (unless they opted out).
          const out = (await db.query("SELECT 1 FROM suppressions WHERE workspace_id=$1 AND channel='whatsapp' AND address=$2 AND lifted_at IS NULL", [w, phone])).rows.length;
          if (!out) await db.query("INSERT INTO whatsapp_opt_ins(workspace_id,id,phone,source) VALUES($1,$2,$3,'customer_message') ON CONFLICT DO NOTHING", [w, crypto.randomUUID(), phone]);
        }
        const r = await receiveInbound(db, w, whatsappChannel, {
          externalId: m.id,
          address: phone,
          // Meta vouches for the number: it's verified.
          verified: true,
          name: v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? "",
          text,
          threadKeys: [],
          fallback: { key: `wa:${n.id}:${phone}`, days: THREAD_DAYS },
          brandId: n.brand_id,
          data: { whatsapp: { numberId: n.id, type: m.type } },
        });
        const file = files.get(m.id);
        if (file && r.partId && !("duplicate" in r && r.duplicate)) {
          const id = file.key.split("/")[1];
          await db.query(
            "INSERT INTO attachments(workspace_id,id,conversation_id,owner_identity_id,object_key,name,size,mime,audience,purpose,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'customer_visible','part','scanning')",
            [w, id, r.conversationId, r.identityId, file.key, file.name, file.size, file.mime],
          );
          const jobId = await enqueueJob(db, w, "attachment.scan", { attachmentId: id }, { identityId: r.identityId ?? undefined });
          await db.query("UPDATE attachments SET job_id=$3 WHERE workspace_id=$1 AND id=$2", [w, id, jobId]);
        }
      }
    }
    await db.query("UPDATE whatsapp_inbound SET status='read',read_at=now() WHERE workspace_id=$1 AND id=$2", [w, inboundId]);
    // Phase 16 C6b: read, so its text is redacted (the original isn't kept).
    await scrubPayload(db, w, "whatsapp_inbound", inboundId);
  });
  return { done: true, result: { read: true } };
}

/* ------------------------------------------------------------------------------------------ */
/* Settings › WhatsApp                                                                         */

const PLACEHOLDERS = /\{\{(\d+)\}\}/g;
/** Its numbers (with the webhook to set up at Meta), their templates, and opt-ins. */
export async function readWhatsApp(db: Sql, w: string, principal: string, origin: string) {
  await authorize(db, w, principal, "workspace.manage");
  assert(await whatsappOn(db, w), "WHATSAPP_DISABLED", "WhatsApp is not enabled for this workspace.", 404);
  const numbers = (
    await db.query<{
      id: string;
      brand_id: string;
      brand: string;
      phone_number_id: string;
      waba_id: string;
      display_number: string;
      verified_name: string;
      quality: string;
      status: string;
      error: string;
      token_hint: string;
      verify_token: string;
      checked_at: string | null;
    }>(
      `SELECT n.id,n.brand_id,b.name AS brand,n.phone_number_id,n.waba_id,n.display_number,n.verified_name,n.quality,n.status,n.error,n.token_hint,n.verify_token,n.checked_at
       FROM whatsapp_numbers n JOIN brands b ON b.workspace_id=n.workspace_id AND b.id=n.brand_id WHERE n.workspace_id=$1 AND n.status<>'disconnected' ORDER BY n.created_at`,
      [w],
    )
  ).rows;
  const templates = (
    await db.query<{ id: string; number_id: string; name: string; language: string; category: string; body: string; params: number; status: string; reason: string }>(
      "SELECT id,number_id,name,language,category,body,params,status,reason FROM whatsapp_templates WHERE workspace_id=$1 ORDER BY name,language",
      [w],
    )
  ).rows;
  const optIns = (
    await db.query<{ phone: string; source: string; created_at: string }>(
      "SELECT phone,source,created_at FROM whatsapp_opt_ins WHERE workspace_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 50",
      [w],
    )
  ).rows;
  const brands = (await db.query<{ id: string; name: string }>("SELECT id,name FROM brands WHERE workspace_id=$1 ORDER BY lower(name),id", [w])).rows;
  return {
    brands,
    numbers: numbers.map((n) => ({
      id: n.id,
      brandId: n.brand_id,
      brandName: n.brand,
      phoneNumberId: n.phone_number_id,
      wabaId: n.waba_id,
      displayNumber: n.display_number,
      verifiedName: n.verified_name,
      quality: n.quality,
      status: n.status,
      error: n.error,
      tokenHint: n.token_hint,
      webhook: { url: `${origin}/v1/hooks/whatsapp/${w}`, verifyToken: n.verify_token },
      checkedAt: n.checked_at ? new Date(n.checked_at).toISOString() : null,
    })),
    templates: templates.map((t) => ({ id: t.id, numberId: t.number_id, name: t.name, language: t.language, category: t.category, body: t.body, params: t.params, status: t.status, reason: t.reason })),
    optIns: optIns.map((o) => ({ phone: o.phone, source: o.source, at: new Date(o.created_at).toISOString() })),
  };
}

/**
 * Connect a number (its credentials sealed, then checked by a job), check or disconnect it, submit
 * a template for review, sync templates from Meta, or record a number's opt-in given elsewhere.
 */
export async function changeWhatsApp(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>, origin: string, master: string | undefined) {
  const t = await authorize(db, w, principal, "workspace.manage");
  assert(await whatsappOn(db, w), "WHATSAPP_DISABLED", "WhatsApp is not enabled for this workspace.", 404);
  return once(db, w, "whatsapp:" + principal, key, p, async () => {
    const invalid = (m: string): never => {
      throw new DomainError("INVALID_WHATSAPP", m, 400);
    };
    const number = async (id: unknown) => {
      const n = (await db.query<{ id: string }>("SELECT id FROM whatsapp_numbers WHERE workspace_id=$1 AND id=$2 AND status<>'disconnected'", [w, String(id ?? "")])).rows[0];
      assert(n, "WHATSAPP_NUMBER_NOT_FOUND", "That number isn't connected.", 404);
      return n.id;
    };
    if (p.action === "connect") {
      assert(master, "WHATSAPP_UNAVAILABLE", "WhatsApp credentials can't be stored here: RELAY_CONNECTOR_KEY isn't configured.", 503);
      const brandId = String(p.brandId ?? "");
      if (!(await db.query("SELECT 1 FROM brands WHERE workspace_id=$1 AND id=$2", [w, brandId])).rows.length) invalid("Choose a brand.");
      const phoneNumberId = String(p.phoneNumberId ?? "").trim();
      const wabaId = String(p.wabaId ?? "").trim();
      const token = String(p.token ?? "").trim();
      const appSecret = String(p.appSecret ?? "").trim();
      if (!/^\d{5,30}$/.test(phoneNumberId) || !/^\d{5,30}$/.test(wabaId)) invalid("The phone number ID and WhatsApp Business account ID are the numbers Meta shows for them.");
      if (token.length < 20 || token.length > 1000 || /\s/.test(token)) invalid("Paste the access token from Meta (a system user's permanent token).");
      if (!/^[0-9a-f]{32}$/i.test(appSecret)) invalid("Paste the app secret from the Meta app's basic settings (32 characters).");
      if ((await db.query("SELECT 1 FROM whatsapp_numbers WHERE workspace_id=$1 AND phone_number_id=$2 AND status<>'disconnected'", [w, phoneNumberId])).rows.length)
        invalid("That number is already connected.");
      // A number connected before (and disconnected) keeps its id, so its templates stay with it;
      // its credentials are sealed again under that id.
      const before = (await db.query<{ id: string }>("SELECT id FROM whatsapp_numbers WHERE workspace_id=$1 AND phone_number_id=$2", [w, phoneNumberId])).rows[0];
      const id = before?.id ?? crypto.randomUUID();
      await db.query(
        `INSERT INTO whatsapp_numbers(workspace_id,id,brand_id,phone_number_id,waba_id,token_sealed,token_hint,app_secret_sealed,verify_token,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (workspace_id,id) DO UPDATE SET brand_id=EXCLUDED.brand_id,waba_id=EXCLUDED.waba_id,
           token_sealed=EXCLUDED.token_sealed,token_hint=EXCLUDED.token_hint,app_secret_sealed=EXCLUDED.app_secret_sealed,verify_token=EXCLUDED.verify_token,status='pending',error=''`,
        [w, id, brandId, phoneNumberId, wabaId, await seal(master!, w, sealId(id), "token", token), token.slice(-4), await seal(master!, w, sealId(id), "app_secret", appSecret), crypto.randomUUID().replace(/-/g, ""), t.id],
      );
      await enqueueJob(db, w, "whatsapp.check", { numberId: id }, {});
    } else if (p.action === "check") await enqueueJob(db, w, "whatsapp.check", { numberId: await number(p.numberId) }, {});
    else if (p.action === "disconnect") {
      await db.query("UPDATE whatsapp_numbers SET status='disconnected' WHERE workspace_id=$1 AND id=$2", [w, await number(p.numberId)]);
    } else if (p.action === "template") {
      const numberId = await number(p.numberId);
      const name = String(p.name ?? "").trim();
      const language = String(p.language ?? "").trim();
      const category = String(p.category ?? "");
      const body = String(p.body ?? "").trim();
      if (!/^[a-z0-9_]{1,512}$/.test(name)) invalid("Name it in lower case, with digits and underscores only (order_update).");
      if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) invalid("Choose a language code Meta knows (en, en_GB, fr…).");
      if (!["utility", "marketing", "authentication"].includes(category)) invalid("Choose its category: utility, marketing or authentication.");
      if (!body || body.length > 1024) invalid("Write its text, in up to 1,024 characters.");
      const used = [...body.matchAll(PLACEHOLDERS)].map((m) => Number(m[1]));
      const count = used.length ? Math.max(...used) : 0;
      if (used.some((n, i) => used.indexOf(n) !== i) || [...Array(count)].some((_, i) => !used.includes(i + 1)))
        invalid("Number its values {{1}}, {{2}} and so on, each once and in order.");
      const examples = (Array.isArray(p.examples) ? p.examples : []).map((x) => String(x).trim());
      if (examples.length !== count || examples.some((x) => !x || x.length > 200)) invalid(`Give an example for each of its ${count} value${count === 1 ? "" : "s"} (Meta reviews them).`);
      if ((await db.query("SELECT 1 FROM whatsapp_templates WHERE workspace_id=$1 AND number_id=$2 AND name=$3 AND language=$4", [w, numberId, name, language])).rows.length)
        invalid("There's already a template with that name and language.");
      const id = crypto.randomUUID();
      await db.query(
        "INSERT INTO whatsapp_templates(workspace_id,id,number_id,name,language,category,body,examples,params,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [w, id, numberId, name, language, category, body, JSON.stringify(examples), count, t.id],
      );
      await enqueueJob(db, w, "whatsapp.template", { templateId: id }, {});
    } else if (p.action === "sync") await enqueueJob(db, w, "whatsapp.sync", { numberId: await number(p.numberId) }, {});
    else if (p.action === "opt_in") {
      const phone = whatsappChannel.address(String(p.phone ?? ""));
      if (!phone) invalid("That isn't a phone number (with its country code).");
      const note = String(p.note ?? "").trim();
      if (!note || note.length > 500) invalid("Say where they gave consent (up to 500 characters).");
      // An opt-out stands: only the customer can opt back in (START).
      if ((await db.query("SELECT 1 FROM suppressions WHERE workspace_id=$1 AND channel='whatsapp' AND address=$2 AND reason='opt_out' AND lifted_at IS NULL", [w, phone])).rows.length)
        invalid("That number opted out: only the customer can opt back in, by sending START.");
      await db.query("INSERT INTO whatsapp_opt_ins(workspace_id,id,phone,source,note,created_by) VALUES($1,$2,$3,'recorded',$4,$5) ON CONFLICT DO NOTHING", [
        w,
        crypto.randomUUID(),
        phone,
        note,
        t.id,
      ]);
    } else invalid("Unknown change.");
    return readWhatsApp(db, w, principal, origin);
  });
}

/** `whatsapp.check`: the number's details from Meta, which proves its credentials. */
export async function checkWhatsAppNumberJob(connect: Connect, env: WhatsAppEnvironment, job: Job) {
  const w = job.workspace_id;
  const { numberId } = job.payload as { numberId: string };
  const n = await tenant(connect, w, async (db) => (await db.query<{ phone_number_id: string; token_sealed: string }>("SELECT phone_number_id,token_sealed FROM whatsapp_numbers WHERE workspace_id=$1 AND id=$2", [w, numberId])).rows[0]);
  if (!n) return { done: true, result: { skipped: true } };
  const save = (status: string, error: string, d?: { displayNumber: string; verifiedName: string; quality: string }) =>
    tenant(connect, w, (db) =>
      db.query(
        `UPDATE whatsapp_numbers SET status=$3,error=$4,display_number=COALESCE($5,display_number),verified_name=COALESCE($6,verified_name),quality=COALESCE($7,quality),checked_at=now()
         WHERE workspace_id=$1 AND id=$2 AND status<>'disconnected'`,
        [w, numberId, status, error, d?.displayNumber ?? null, d?.verifiedName ?? null, d?.quality ?? null],
      ),
    );
  if (!env.api || !env.key) {
    await save("failed", "WhatsApp isn't set up for Relay yet.");
    return { done: true, result: { checked: false } };
  }
  try {
    const d = await env.api.phoneNumber(await unseal(env.key, w, sealId(numberId), "token", n.token_sealed), n.phone_number_id);
    await save("connected", "", d);
    return { done: true, result: { checked: true } };
  } catch (e) {
    if (e instanceof WhatsAppRejected) {
      await save("failed", `Meta refused: ${e.message}`.slice(0, 300));
      return { done: true, result: { checked: false } };
    }
    throw e;
  }
}

/** `whatsapp.template`: a template submitted to Meta for review. */
export async function submitTemplateJob(connect: Connect, env: WhatsAppEnvironment, job: Job) {
  const w = job.workspace_id;
  const { templateId } = job.payload as { templateId: string };
  const t = await tenant(
    connect,
    w,
    async (db) =>
      (
        await db.query<{ name: string; language: string; category: "utility"; body: string; examples: string[]; provider_id: string | null; number_id: string; waba_id: string; token_sealed: string }>(
          `SELECT t.name,t.language,t.category,t.body,t.examples,t.provider_id,t.number_id,n.waba_id,n.token_sealed FROM whatsapp_templates t
           JOIN whatsapp_numbers n ON n.workspace_id=t.workspace_id AND n.id=t.number_id WHERE t.workspace_id=$1 AND t.id=$2`,
          [w, templateId],
        )
      ).rows[0],
  );
  if (!t || t.provider_id) return { done: true, result: { skipped: true } };
  const set = (status: string, reason: string, providerId: string | null) =>
    tenant(connect, w, (db) =>
      db.query("UPDATE whatsapp_templates SET status=$3,reason=$4,provider_id=COALESCE($5,provider_id),updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, templateId, status, reason, providerId]),
    );
  if (!env.api || !env.key) {
    await set("rejected", "WhatsApp isn't set up for Relay yet.", null);
    return { done: true, result: { submitted: false } };
  }
  try {
    // Only the draft goes to Meta (never the row it's read from).
    const draft = { name: t.name, language: t.language, category: t.category, body: t.body, examples: t.examples };
    const r = await env.api.createTemplate(await unseal(env.key, w, sealId(t.number_id), "token", t.token_sealed), t.waba_id, draft);
    await set(r.status.toLowerCase() === "approved" ? "approved" : "pending", "", r.id);
    return { done: true, result: { submitted: true } };
  } catch (e) {
    if (e instanceof WhatsAppRejected) {
      await set("rejected", e.message.slice(0, 300), null);
      return { done: true, result: { submitted: false } };
    }
    throw e;
  }
}

/** `whatsapp.sync`: every template's status from Meta (the webhook's updates, caught up). */
export async function syncTemplatesJob(connect: Connect, env: WhatsAppEnvironment, job: Job) {
  const w = job.workspace_id;
  const { numberId } = job.payload as { numberId: string };
  const n = await tenant(connect, w, async (db) => (await db.query<{ waba_id: string; token_sealed: string }>("SELECT waba_id,token_sealed FROM whatsapp_numbers WHERE workspace_id=$1 AND id=$2", [w, numberId])).rows[0]);
  if (!n || !env.api || !env.key) return { done: true, result: { synced: false } };
  const remote = await env.api.templates(await unseal(env.key, w, sealId(numberId), "token", n.token_sealed), n.waba_id);
  await tenant(connect, w, async (db) => {
    for (const r of remote) {
      const status = { APPROVED: "approved", REJECTED: "rejected", PAUSED: "paused", DISABLED: "disabled", PENDING: "pending", IN_APPEAL: "pending" }[r.status] ?? null;
      if (!status) continue;
      await db.query(
        "UPDATE whatsapp_templates SET status=$5,reason=$6,provider_id=$7,updated_at=now() WHERE workspace_id=$1 AND number_id=$2 AND name=$3 AND language=$4",
        [w, numberId, r.name, r.language, status, r.reason ?? "", r.id],
      );
    }
  });
  return { done: true, result: { synced: true } };
}

