import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import { authorize } from "./policy";
import { deliveryReport, receiveInbound, registerChannel, suppress, type ChannelAdapter, type ChannelEnvironment, type SendResult } from "./channels";
import { seal, unseal } from "./connectors";
import { MAX_ATTACHMENT_BYTES, type AttachmentStorage } from "./attachments";
import { SmsRejected, type SmsApi, type SmsCredentials } from "./sms-api";
import { callingCode, DEFAULT_PRICES, MAX_SEGMENTS, segmentsOf } from "../lib/sms";
import { scrubPayload } from "./redaction";

/**
 * SMS (phase 12, step E6; docs/OMNICHANNEL_STEP6.md), behind `channels_v1` and `channel_sms_v1`,
 * through Twilio with the workspace's own account.
 *
 * - **The account and numbers:** its SID and auth token (sealed with RELAY_CONNECTOR_KEY); a
 *   brand's numbers, one per country (calling code), each pointed at
 *   `/v1/hooks/sms/<workspace>/message`. A reply goes from the number in the customer's country,
 *   else the brand's default.
 * - **In:** Twilio's calls are kept only when their signature (the auth token's) checks out, and
 *   read by the `sms.receive` job: a text becomes the customer's (threaded by number within 7 days;
 *   the number unverified: anyone can claim one); an MMS's images and documents are scanned; a
 *   sent text's status moves its delivery forward.
 * - **Keywords:** STOP and the local equivalents opt out (a suppression record, kept for good, its
 *   lifting recorded); START opts back in; HELP is answered with the brand's help reply.
 * - **Consent:** a number is texted only when it texted first, or a teammate recorded consent.
 * - **Length:** at most 10 segments (`lib/sms.ts` counts them); files aren't texted.
 */
export type SmsEnvironment = { api?: SmsApi; key?: string; storage?: AttachmentStorage; hookOrigin?: string };
const envOf = (env: ChannelEnvironment) => env.providers?.sms as SmsEnvironment | undefined;
const THREAD_DAYS = 7;
const SEAL_ID = "sms:account";
/** Opt-out words carriers and countries require (US CTIA, Canada, France, Germany, Nordics, Spain, Italy, Netherlands, Portugal). */
const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|optout|opt out|revoke|arr[eê]t|arret|stopp|basta|alto|parar|baja|afmelden|uitschrijven|cancelar|sair)\s*[.!]?\s*$/i;
const START = /^\s*(start|unstop|yes|subscribe)\s*[.!]?\s*$/i;
const HELP = /^\s*(help|info|aide|hilfe|ayuda|aiuto)\s*[.!?]?\s*$/i;
const KEPT = new Set(["image/png", "image/jpeg", "application/pdf", "text/plain"]);

async function smsOn(db: Sql, w: string) {
  return (
    (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_features WHERE workspace_id=$1 AND enabled AND name IN ('channels_v1','channel_sms_v1')", [w])).rows[0]
      .n === 2
  );
}
/** The workspace's Twilio account, unsealed (E9's calls use it too). */
export async function credentials(db: Sql, w: string, key: string): Promise<(SmsCredentials & { status: string; helpReply: string }) | null> {
  const a = (await db.query<{ account_sid: string; token_sealed: string; status: string; help_reply: string }>("SELECT account_sid,token_sealed,status,help_reply FROM sms_accounts WHERE workspace_id=$1", [w])).rows[0];
  return a ? { sid: a.account_sid, token: await unseal(key, w, SEAL_ID, "token", a.token_sealed), status: a.status, helpReply: a.help_reply } : null;
}
/** The customer's number on a conversation (the address they last texted from). */
async function customerPhone(db: Sql, w: string, conversationId: string) {
  return (
    (
      await db.query<{ address: string }>(
        `SELECT x.address FROM conversation_parts p JOIN identity_addresses x ON x.workspace_id=p.workspace_id AND x.identity_id=p.author_id AND x.channel='sms'
         WHERE p.workspace_id=$1 AND p.conversation_id=$2 AND p.kind='customer_message' AND p.channel='sms' ORDER BY p.seq DESC LIMIT 1`,
        [w, conversationId],
      )
    ).rows[0]?.address ?? null
  );
}
/** The number a reply goes from: the brand's in the customer's country, else its default, else any of its numbers. */
async function fromNumber(db: Sql, w: string, conversationId: string, to: string) {
  return (
    await db.query<{ id: string; phone: string }>(
      `SELECT n.id,n.phone FROM sms_numbers n WHERE n.workspace_id=$1 AND n.status='connected'
         AND n.brand_id=(SELECT brand_id FROM conversations WHERE workspace_id=$1 AND id=$2)
       ORDER BY (n.calling_code=$3) DESC,n.is_default DESC,n.created_at LIMIT 1`,
      [w, conversationId, callingCode(to)],
    )
  ).rows[0];
}
async function priceOf(db: Sql, w: string, code: string) {
  const own = (await db.query<{ per_segment: string; currency: string }>("SELECT per_segment,currency FROM sms_prices WHERE workspace_id=$1 AND calling_code=$2", [w, code])).rows[0];
  if (own) return { perSegment: Number(own.per_segment), currency: own.currency, estimated: false };
  return DEFAULT_PRICES[code] !== undefined ? { perSegment: DEFAULT_PRICES[code], currency: "USD", estimated: true } : null;
}
/** Options a channel without buttons writes out. */
const withOptions = (text: string, options?: string[]) => (options?.length ? `${text}\n${options.map((o, i) => `${i + 1}) ${o}`).join("\n")}` : text);

type Prepared = { credentials: SmsCredentials; from: string; body: string; statusCallback: string };

export const smsChannel: ChannelAdapter = {
  id: "sms",
  flag: "channel_sms_v1",
  // Plain text, no files or buttons, 10 segments at most (the composer counts them), delivery
  // receipts. Zoe doesn't text: anyone can claim a number, and every segment costs.
  capabilities: { richText: false, attachments: false, buttons: false, maxLength: 1600, windowHours: null, ai: false, receipts: "delivered", address: "phone" },
  address: (raw) => {
    const m = /^\+?(\d{8,15})$/.exec(raw.replace(/[\s().-]/g, ""));
    return m ? "+" + m[1] : null;
  },
  async refuses(db, w, conversationId, part) {
    if (part?.kind === "attachment") return "Files can't be texted: send a link instead.";
    const phone = await customerPhone(db, w, conversationId);
    if (!phone) return "There's no number to text.";
    // Said plainly before consent (an opt-out withdraws it); the gate holds the suppression anyway.
    if ((await db.query("SELECT 1 FROM suppressions WHERE workspace_id=$1 AND channel='sms' AND address=$2 AND reason='opt_out' AND lifted_at IS NULL", [w, phone])).rows.length)
      return "This number opted out (STOP): nothing can be texted to it until it texts START.";
    const consented = (await db.query("SELECT 1 FROM sms_consents WHERE workspace_id=$1 AND phone=$2 AND revoked_at IS NULL", [w, phone])).rows.length;
    return consented ? null : "This number hasn't agreed to texts: record their consent first.";
  },
  async prepare(db, w, out, env) {
    const e = envOf(env);
    if (!e?.api || !e.key || !e.hookOrigin) return { refuse: "SMS isn't set up for Relay yet." };
    const c = await credentials(db, w, e.key);
    if (!c || c.status !== "connected") return { refuse: "The Twilio account isn't connected." };
    const from = await fromNumber(db, w, out.conversationId, out.address);
    if (!from) return { refuse: "The brand has no number to text from." };
    const body = withOptions(out.text, out.options);
    const s = segmentsOf(body);
    if (s.segments > MAX_SEGMENTS) return { refuse: `Too long for a text: ${s.segments} segments (${MAX_SEGMENTS} at most).` };
    return {
      data: {
        credentials: { sid: c.sid, token: c.token },
        from: from.phone,
        body,
        statusCallback: `${e.hookOrigin}/v1/hooks/sms/${w}/status`,
      } satisfies Prepared,
    };
  },
  async send(out, env): Promise<SendResult> {
    const e = envOf(env);
    const p = out.prepared as Prepared | undefined;
    if (!e?.api || !p) return { status: "failed", error: "SMS isn't set up for Relay yet.", permanent: true };
    try {
      const sent = await e.api.send(p.credentials, { from: p.from, to: out.address, body: p.body, statusCallback: p.statusCallback });
      return { status: "sent", providerId: sent.sid };
    } catch (err) {
      if (err instanceof SmsRejected)
        // 21610: the number replied STOP to Twilio itself (its own opt-out list).
        return { status: "failed", error: err.message.slice(0, 300), permanent: true, ...(err.code === 21610 ? { suppress: "opt_out" as const } : {}) };
      throw err;
    }
  },
  async replyDetails(db, w, conversationId) {
    const to = await customerPhone(db, w, conversationId);
    const from = to ? await fromNumber(db, w, conversationId, to) : undefined;
    return { from: from?.phone ?? null, price: to ? await priceOf(db, w, callingCode(to)) : null, maxSegments: MAX_SEGMENTS };
  },
};
registerChannel(smsChannel);

/* ------------------------------------------------------------------------------------------ */
/* Twilio's webhook                                                                            */

/** Twilio's signature: HMAC-SHA1 with the auth token over the URL, then each parameter's name and value, sorted by name. */
export async function twilioSignature(token: string, url: string, params: URLSearchParams) {
  const data = url + [...params.keys()].sort().map((k) => k + params.getAll(k).join("")).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))));
}
const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** `POST /v1/hooks/sms/<workspace>/<message|status>`: kept (once Twilio's signature checks out) and read by the job. */
export async function receiveSmsWebhook(connect: Connect, key: string | undefined, w: string, kind: "message" | "status", url: string, params: URLSearchParams, signature: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(w) || !key) return { status: 404 };
  try {
    return await tenant(connect, w, async (db) => {
      if (!(await smsOn(db, w))) return { status: 404 };
      const c = await credentials(db, w, key);
      if (!c || params.get("AccountSid") !== c.sid || !same(await twilioSignature(c.token, url, params), signature)) return { status: 403 };
      const id = crypto.randomUUID();
      await db.query("INSERT INTO sms_inbound(workspace_id,id,kind,payload) VALUES($1,$2,$3,$4)", [w, id, kind, JSON.stringify(Object.fromEntries(params))]);
      await enqueueJob(db, w, "sms.receive", { inboundId: id }, {});
      return { status: 200 };
    });
  } catch (e) {
    if (e instanceof DomainError) throw e;
    return { status: 404 };
  }
}

/** The `sms.receive` job: one call, a customer's text (keywords first) or a sent text's status. */
export async function receiveSmsJob(connect: Connect, env: SmsEnvironment, job: Job) {
  const w = job.workspace_id;
  const { inboundId } = job.payload as { inboundId: string };
  const row = await tenant(connect, w, async (db) => (await db.query<{ kind: string; status: string; payload: Record<string, string> }>("SELECT kind,status,payload FROM sms_inbound WHERE workspace_id=$1 AND id=$2", [w, inboundId])).rows[0]);
  if (!row || row.status !== "received") return { done: true, result: { skipped: true } };
  const p = row.payload;
  // MMS media first, outside any transaction: fetched with the account's credentials, kept in quarantine.
  const files: { key: string; name: string; mime: string; size: number }[] = [];
  if (row.kind === "message" && Number(p.NumMedia ?? 0) > 0 && env.api && env.key && env.storage?.putQuarantine) {
    const c = await tenant(connect, w, (db) => credentials(db, w, env.key!));
    for (let i = 0; c && i < Math.min(Number(p.NumMedia), 10); i++) {
      const mime = p[`MediaContentType${i}`] ?? "";
      if (!KEPT.has(mime) || !p[`MediaUrl${i}`]) continue;
      const got = await env.api.download(c, p[`MediaUrl${i}`]);
      if (!got.bytes.length || got.bytes.length > MAX_ATTACHMENT_BYTES) continue;
      const id = crypto.randomUUID();
      const k = `${encodeURIComponent(w)}/${id}/quarantine`;
      await env.storage.putQuarantine(k, got.bytes, mime);
      files.push({ key: k, name: `mms-${i + 1}.${mime.split("/")[1]}`, mime, size: got.bytes.length });
    }
  }
  await tenant(connect, w, async (db) => {
    if (row.kind === "status") {
      const status = p.MessageStatus;
      if (status === "delivered") await deliveryReport(db, w, "sms", p.MessageSid, { status: "delivered" });
      else if (status === "undelivered" || status === "failed")
        await deliveryReport(db, w, "sms", p.MessageSid, {
          status: "failed",
          error: `Not delivered${p.ErrorCode ? ` (Twilio ${p.ErrorCode})` : ""}.`,
          ...(p.ErrorCode === "21610" ? { suppress: "opt_out" as const } : {}),
        });
    } else {
      const phone = smsChannel.address(p.From ?? "");
      const number = (
        await db.query<{ id: string; brand_id: string }>("SELECT id,brand_id FROM sms_numbers WHERE workspace_id=$1 AND phone=$2 AND status<>'removed'", [w, smsChannel.address(p.To ?? "") ?? ""])
      ).rows[0];
      if (phone && number) {
        const text = (p.Body ?? "").slice(0, 1600) || (files.length ? "[A picture or file]" : "[An empty text]");
        let help = false;
        if (STOP.test(text)) {
          // Opted out: a suppression record, kept for good (lifting it is recorded, not erased).
          await suppress(db, w, "sms", phone, "opt_out", `keyword:${p.MessageSid}`);
          await db.query("UPDATE sms_consents SET revoked_at=now() WHERE workspace_id=$1 AND phone=$2 AND revoked_at IS NULL", [w, phone]);
        } else if (START.test(text)) {
          await db.query(
            "UPDATE suppressions SET lifted_at=now(),note=CASE WHEN note='' THEN 'Opted back in (START).' ELSE note END WHERE workspace_id=$1 AND channel='sms' AND address=$2 AND reason='opt_out' AND lifted_at IS NULL",
            [w, phone],
          );
          await db.query("INSERT INTO sms_consents(workspace_id,id,phone,source) VALUES($1,$2,$3,'keyword') ON CONFLICT DO NOTHING", [w, crypto.randomUUID(), phone]);
        } else {
          help = HELP.test(text);
          // Texting the business is consent to be answered (unless they opted out).
          const out = (await db.query("SELECT 1 FROM suppressions WHERE workspace_id=$1 AND channel='sms' AND address=$2 AND lifted_at IS NULL", [w, phone])).rows.length;
          if (!out) await db.query("INSERT INTO sms_consents(workspace_id,id,phone,source) VALUES($1,$2,$3,'customer_message') ON CONFLICT DO NOTHING", [w, crypto.randomUUID(), phone]);
        }
        const r = await receiveInbound(db, w, smsChannel, {
          externalId: p.MessageSid,
          address: phone,
          // Anyone can claim a number by text: unverified.
          verified: false,
          text,
          threadKeys: [],
          fallback: { key: `sms:${number.id}:${phone}`, days: THREAD_DAYS },
          brandId: number.brand_id,
          data: { sms: { numberId: number.id } },
        });
        if (r.partId && !("duplicate" in r && r.duplicate)) {
          for (const f of files) {
            const id = f.key.split("/")[1];
            await db.query(
              "INSERT INTO attachments(workspace_id,id,conversation_id,owner_identity_id,object_key,name,size,mime,audience,purpose,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'customer_visible','part','scanning')",
              [w, id, r.conversationId, r.identityId, f.key, f.name, f.size, f.mime],
            );
            const jobId = await enqueueJob(db, w, "attachment.scan", { attachmentId: id }, { identityId: r.identityId ?? undefined });
            await db.query("UPDATE attachments SET job_id=$3 WHERE workspace_id=$1 AND id=$2", [w, id, jobId]);
          }
          // HELP: answered with the brand's help reply, delivered (through the gate) like any reply
          // on the conversation, which is on SMS now.
          if (help && r.conversationId) {
            const reply = (await db.query<{ help_reply: string; brand: string }>("SELECT a.help_reply,b.name AS brand FROM sms_accounts a, brands b WHERE a.workspace_id=$1 AND b.workspace_id=$1 AND b.id=$2", [w, number.brand_id])).rows[0];
            const { append, conversation } = await import("./conversations");
            const c = await conversation(db, w, r.conversationId);
            const text = reply?.help_reply || `${reply?.brand ?? "We"}: reply here and our team will answer. Reply STOP to opt out.`;
            await append(db, w, c, { type: "system", id: "workflow:sms-help" }, "workflow_message", text, { workflowName: "SMS help", sms: { auto: "help" } });
          }
        }
      }
    }
    await db.query("UPDATE sms_inbound SET status='read',read_at=now() WHERE workspace_id=$1 AND id=$2", [w, inboundId]);
    // Phase 16 C6b: read, so its text is redacted (the original isn't kept).
    await scrubPayload(db, w, "sms_inbound", inboundId);
  });
  return { done: true, result: { read: true } };
}

/* ------------------------------------------------------------------------------------------ */
/* Settings › SMS                                                                              */

export async function readSms(db: Sql, w: string, principal: string, origin: string) {
  await authorize(db, w, principal, "workspace.manage");
  assert(await smsOn(db, w), "SMS_DISABLED", "SMS is not enabled for this workspace.", 404);
  const a = (
    await db.query<{ account_sid: string; token_hint: string; friendly_name: string; status: string; error: string; help_reply: string; checked_at: string | null }>(
      "SELECT account_sid,token_hint,friendly_name,status,error,help_reply,checked_at FROM sms_accounts WHERE workspace_id=$1",
      [w],
    )
  ).rows[0];
  const numbers = (
    await db.query<{ id: string; brand_id: string; brand: string; phone: string; calling_code: string; is_default: boolean; status: string; error: string }>(
      `SELECT n.id,n.brand_id,b.name AS brand,n.phone,n.calling_code,n.is_default,n.status,n.error FROM sms_numbers n JOIN brands b ON b.workspace_id=n.workspace_id AND b.id=n.brand_id
       WHERE n.workspace_id=$1 AND n.status<>'removed' ORDER BY b.name,n.calling_code,n.phone`,
      [w],
    )
  ).rows;
  const prices = (await db.query<{ calling_code: string; per_segment: string; currency: string }>("SELECT calling_code,per_segment,currency FROM sms_prices WHERE workspace_id=$1 ORDER BY calling_code", [w])).rows;
  const consents = (
    await db.query<{ phone: string; source: string; note: string; created_at: string }>(
      "SELECT phone,source,note,created_at FROM sms_consents WHERE workspace_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 50",
      [w],
    )
  ).rows;
  return {
    account: a
      ? {
          sid: a.account_sid,
          tokenHint: a.token_hint,
          friendlyName: a.friendly_name,
          status: a.status,
          error: a.error,
          helpReply: a.help_reply,
          checkedAt: a.checked_at ? new Date(a.checked_at).toISOString() : null,
        }
      : null,
    webhook: `${origin}/v1/hooks/sms/${w}/message`,
    brands: (await db.query<{ id: string; name: string }>("SELECT id,name FROM brands WHERE workspace_id=$1 ORDER BY lower(name),id", [w])).rows,
    numbers: numbers.map((n) => ({ id: n.id, brandId: n.brand_id, brandName: n.brand, phone: n.phone, callingCode: n.calling_code, isDefault: n.is_default, status: n.status, error: n.error })),
    prices: prices.map((p) => ({ callingCode: p.calling_code, perSegment: Number(p.per_segment), currency: p.currency })),
    defaultPrices: DEFAULT_PRICES,
    consents: consents.map((c) => ({ phone: c.phone, source: c.source, note: c.note, at: new Date(c.created_at).toISOString() })),
  };
}

/** Connect the account, add or remove a number, set a country's price or the HELP reply, or record consent. */
export async function changeSms(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>, origin: string, master: string | undefined) {
  const t = await authorize(db, w, principal, "workspace.manage");
  assert(await smsOn(db, w), "SMS_DISABLED", "SMS is not enabled for this workspace.", 404);
  return once(db, w, "sms:" + principal, key, p, async () => {
    const invalid = (m: string): never => {
      throw new DomainError("INVALID_SMS", m, 400);
    };
    if (p.action === "connect") {
      assert(master, "SMS_UNAVAILABLE", "SMS credentials can't be stored here: RELAY_CONNECTOR_KEY isn't configured.", 503);
      const sid = String(p.sid ?? "").trim();
      const token = String(p.token ?? "").trim();
      if (!/^AC[0-9a-f]{32}$/.test(sid)) invalid("The Account SID starts AC, then 32 letters and digits (Twilio Console › Account info).");
      if (!/^[0-9a-f]{32}$/.test(token)) invalid("Paste the account's auth token (32 characters).");
      await db.query(
        `INSERT INTO sms_accounts(workspace_id,account_sid,token_sealed,token_hint,created_by) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (workspace_id) DO UPDATE SET account_sid=EXCLUDED.account_sid,token_sealed=EXCLUDED.token_sealed,token_hint=EXCLUDED.token_hint,status='pending',error=''`,
        [w, sid, await seal(master!, w, SEAL_ID, "token", token), token.slice(-4), t.id],
      );
      await enqueueJob(db, w, "sms.check", {}, {});
    } else if (p.action === "number") {
      if (!(await db.query("SELECT 1 FROM sms_accounts WHERE workspace_id=$1", [w])).rows.length) invalid("Connect the Twilio account first.");
      const phone = smsChannel.address(String(p.phone ?? ""));
      if (!phone) invalid("That isn't a phone number (with its country code).");
      const brandId = String(p.brandId ?? "");
      if (!(await db.query("SELECT 1 FROM brands WHERE workspace_id=$1 AND id=$2", [w, brandId])).rows.length) invalid("Choose a brand.");
      if ((await db.query("SELECT 1 FROM sms_numbers WHERE workspace_id=$1 AND phone=$2 AND status<>'removed'", [w, phone])).rows.length) invalid("That number is already added.");
      const first = !(await db.query("SELECT 1 FROM sms_numbers WHERE workspace_id=$1 AND brand_id=$2 AND status<>'removed'", [w, brandId])).rows.length;
      const id = crypto.randomUUID();
      await db.query("INSERT INTO sms_numbers(workspace_id,id,brand_id,phone,calling_code,is_default,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)", [
        w,
        id,
        brandId,
        phone,
        callingCode(phone!),
        first || p.isDefault === true,
        t.id,
      ]);
      if (p.isDefault === true && !first) await db.query("UPDATE sms_numbers SET is_default=(id=$3) WHERE workspace_id=$1 AND brand_id=$2", [w, brandId, id]);
      // Pointing the number at Relay is Twilio's work: a job.
      await enqueueJob(db, w, "sms.number", { numberId: id, smsUrl: `${origin}/v1/hooks/sms/${w}/message` }, {});
    } else if (p.action === "remove") {
      const done = await db.query("UPDATE sms_numbers SET status='removed',is_default=false WHERE workspace_id=$1 AND id=$2 AND status<>'removed' RETURNING id", [w, String(p.numberId ?? "")]);
      assert(done.rows.length, "SMS_NUMBER_NOT_FOUND", "That number isn't added.", 404);
    } else if (p.action === "price") {
      const code = String(p.callingCode ?? "").replace(/^\+/, "");
      const per = Number(p.perSegment);
      if (!/^\d{1,3}$/.test(code)) invalid("A calling code is one to three digits (1, 44, 234).");
      if (!Number.isFinite(per) || per < 0 || per > 10) invalid("A price per segment between 0 and 10.");
      const currency = String(p.currency ?? "USD").toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) invalid("A three-letter currency (USD, GBP, EUR).");
      await db.query(
        "INSERT INTO sms_prices(workspace_id,calling_code,per_segment,currency) VALUES($1,$2,$3,$4) ON CONFLICT (workspace_id,calling_code) DO UPDATE SET per_segment=EXCLUDED.per_segment,currency=EXCLUDED.currency",
        [w, code, per, currency],
      );
    } else if (p.action === "help") {
      const reply = String(p.helpReply ?? "").trim();
      if (reply.length > 320) invalid("Keep the HELP reply to 320 characters (two segments).");
      if (reply && !/\bSTOP\b/.test(reply)) invalid("Say how to opt out in it (“Reply STOP to opt out”): carriers require it.");
      const done = await db.query("UPDATE sms_accounts SET help_reply=$2 WHERE workspace_id=$1 RETURNING 1", [w, reply]);
      if (!done.rows.length) invalid("Connect the Twilio account first.");
    } else if (p.action === "consent") {
      const phone = smsChannel.address(String(p.phone ?? ""));
      if (!phone) invalid("That isn't a phone number (with its country code).");
      const note = String(p.note ?? "").trim();
      if (!note || note.length > 500) invalid("Say where they agreed to texts (up to 500 characters).");
      if ((await db.query("SELECT 1 FROM suppressions WHERE workspace_id=$1 AND channel='sms' AND address=$2 AND reason='opt_out' AND lifted_at IS NULL", [w, phone])).rows.length)
        invalid("That number opted out: only the customer can opt back in, by texting START.");
      await db.query("INSERT INTO sms_consents(workspace_id,id,phone,source,note,created_by) VALUES($1,$2,$3,'recorded',$4,$5) ON CONFLICT DO NOTHING", [w, crypto.randomUUID(), phone, note, t.id]);
    } else invalid("Unknown change.");
    return readSms(db, w, principal, origin);
  });
}

/** `sms.check`: the account, from Twilio, which proves its credentials. */
export async function checkSmsAccountJob(connect: Connect, env: SmsEnvironment, job: Job) {
  const w = job.workspace_id;
  const c = env.key ? await tenant(connect, w, (db) => credentials(db, w, env.key!)) : null;
  const save = (status: string, error: string, name?: string) =>
    tenant(connect, w, (db) =>
      db.query("UPDATE sms_accounts SET status=$2,error=$3,friendly_name=COALESCE($4,friendly_name),checked_at=now() WHERE workspace_id=$1", [w, status, error, name ?? null]),
    );
  if (!c) return { done: true, result: { skipped: true } };
  if (!env.api) {
    await save("failed", "SMS isn't set up for Relay yet.");
    return { done: true, result: { checked: false } };
  }
  try {
    const a = await env.api.account(c);
    if (a.status && a.status !== "active") {
      await save("failed", `The Twilio account is ${a.status}.`, a.friendlyName);
      return { done: true, result: { checked: false } };
    }
    await save("connected", "", a.friendlyName);
    return { done: true, result: { checked: true } };
  } catch (e) {
    if (e instanceof SmsRejected) {
      await save("failed", `Twilio refused: ${e.message}`.slice(0, 300));
      return { done: true, result: { checked: false } };
    }
    throw e;
  }
}

/** `sms.number`: the number found in the account and pointed at Relay. */
export async function connectSmsNumberJob(connect: Connect, env: SmsEnvironment, job: Job) {
  const w = job.workspace_id;
  const { numberId, smsUrl } = job.payload as { numberId: string; smsUrl: string };
  const ready = await tenant(connect, w, async (db) => {
    const n = (await db.query<{ phone: string }>("SELECT phone FROM sms_numbers WHERE workspace_id=$1 AND id=$2 AND status='pending'", [w, numberId])).rows[0];
    return n && env.key ? { phone: n.phone, c: await credentials(db, w, env.key) } : null;
  });
  if (!ready?.c) return { done: true, result: { skipped: true } };
  const save = (status: string, error: string, sid: string | null = null) =>
    tenant(connect, w, (db) => db.query("UPDATE sms_numbers SET status=$3,error=$4,number_sid=COALESCE($5,number_sid) WHERE workspace_id=$1 AND id=$2", [w, numberId, status, error, sid]));
  if (!env.api) {
    await save("failed", "SMS isn't set up for Relay yet.");
    return { done: true, result: { connected: false } };
  }
  try {
    const n = await env.api.number(ready.c, ready.phone);
    if (!n || !n.sms) {
      await save("failed", n ? "That number can't send or receive texts." : "That number isn't in the Twilio account.");
      return { done: true, result: { connected: false } };
    }
    await env.api.configure(ready.c, n.sid, smsUrl);
    await save("connected", "", n.sid);
    return { done: true, result: { connected: true } };
  } catch (e) {
    if (e instanceof SmsRejected) {
      await save("failed", `Twilio refused: ${e.message}`.slice(0, 300));
      return { done: true, result: { connected: false } };
    }
    throw e;
  }
}
