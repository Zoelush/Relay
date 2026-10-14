import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import { authorize } from "./policy";
import { channelsEnabled, enabledChannels, receiveInbound, registerChannel, suppress, type ChannelAdapter } from "./channels";
import { MAX_ATTACHMENT_BYTES, type AttachmentStorage } from "./attachments";
import { MAX_EMAIL_BYTES, readEmail, threadKeys } from "./email-read";
import { emailReplyDetails, ensureDomain, prepareEmail, queueDomainCheck, readReputation, readSending, sendEmail } from "./email-out";

/**
 * Email in (phase 12, step E2; docs/OMNICHANNEL_STEP2.md), behind `channels_v1` and
 * `channel_email_v1`. The email channel's adapter, and the way mail reaches it:
 *
 * 1. **Accepted** (`acceptEmail`) at a brand's inbound address, `<workspace>+<token>@<domain>`:
 *    from Cloudflare Email Routing's Email Worker when deployed, or the dev relay locally. Its raw
 *    bytes go to quarantine storage, and the `email.receive` job is queued. Mail to an unknown
 *    address, or over 25 MB, is refused there (the sender's server tells them).
 * 2. **Read** (`receiveEmailJob`, `email-read.ts`): a customer's message becomes a part on its
 *    conversation (threaded by Message-ID, In-Reply-To and References, else subject and sender within
 *    30 days), with the full email kept beside it (`email_messages`) and its attachments scanned.
 *    Auto-replies go only to teammates; a bounce's hard failures go on the suppression list; a Gmail
 *    forwarding confirmation is kept for the manager setting forwarding up.
 *
 * Replies are sent by E3 (`server/email-out.ts`: `prepare` and `send`, only through the delivery
 * job). Zoe doesn't answer email yet (E4).
 */
const NORMAL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
export const emailChannel: ChannelAdapter = {
  id: "email",
  flag: "channel_email_v1",
  // TODO(phase 12 E4): Zoe on email.
  capabilities: { richText: true, attachments: true, buttons: false, maxLength: 100_000, windowHours: null, ai: false, receipts: "delivered", address: "email" },
  address: (raw) => {
    const a = raw.trim().toLowerCase().replace(/^mailto:/, "");
    return NORMAL.test(a) && a.length <= 254 ? a : null;
  },
  prepare: prepareEmail,
  send: sendEmail,
  replyDetails: emailReplyDetails,
};
registerChannel(emailChannel);

export type EmailEnvironment = {
  storage?: AttachmentStorage;
  /** The domain inbound addresses are on (Email Routing's, deployed). */
  domain: string;
  /** Receivers whose Authentication-Results are believed (Cloudflare's, deployed). */
  trustedAuthServ: string[];
};
/** Files kept from an email (what the inbox takes as attachments), after scanning. */
const KEPT = new Set(["image/png", "image/jpeg", "application/pdf", "text/plain"]);
const FALLBACK_DAYS = 30;
const GMAIL_CONFIRMATION = "forwarding-noreply@google.com";

export const inboundAddress = (w: string, token: string, domain: string) => `${w}+${token}@${domain}`;
const newToken = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

async function emailEnabled(db: Sql, w: string) {
  return (await channelsEnabled(db, w)) && (await enabledChannels(db, w)).includes(emailChannel);
}

/** Mail at an inbound address: kept (raw, in quarantine) and queued to be read; or refused. */
export async function acceptEmail(connect: Connect, env: EmailEnvironment, mail: { raw: Uint8Array; to: string; from: string }) {
  const at = mail.to.trim().toLowerCase().lastIndexOf("@");
  const local = mail.to.trim().toLowerCase().slice(0, at);
  const domain = mail.to.trim().toLowerCase().slice(at + 1);
  const plus = local.lastIndexOf("+");
  if (at < 0 || domain !== env.domain.toLowerCase() || plus < 1) return { accepted: false as const, reason: "No such address." };
  const w = local.slice(0, plus);
  const token = local.slice(plus + 1);
  // A brand's inbound address, or (E3) a conversation's reply address, `r-<token>`.
  const reply = /^r-([a-z0-9]{16,40})$/.exec(token)?.[1];
  if (!/^[a-z0-9_-]{1,100}$/.test(w) || (!reply && !/^[a-z0-9]{4,40}$/.test(token))) return { accepted: false as const, reason: "No such address." };
  if (mail.raw.length > MAX_EMAIL_BYTES) return { accepted: false as const, reason: "The message is larger than 25 MB." };
  if (!env.storage?.putQuarantine) throw new DomainError("STORAGE_UNAVAILABLE", "Email storage isn't configured.", 503);
  const storage = env.storage;
  try {
    return await tenant(connect, w, async (db) => {
      if (!(await emailEnabled(db, w))) return { accepted: false as const, reason: "No such address." };
      const brand = reply
        ? (await db.query<{ brand_id: string }>("SELECT brand_id FROM email_reply_addresses WHERE workspace_id=$1 AND token=$2", [w, reply])).rows[0]
        : (await db.query<{ brand_id: string }>("SELECT brand_id FROM email_settings WHERE workspace_id=$1 AND token=$2", [w, token])).rows[0];
      if (!brand) return { accepted: false as const, reason: "No such address." };
      const id = crypto.randomUUID();
      const key = `${encodeURIComponent(w)}/email/${id}.eml`;
      await storage.putQuarantine!(key, mail.raw, "message/rfc822");
      await db.query(
        "INSERT INTO email_inbound(workspace_id,id,brand_id,envelope_from,envelope_to,raw_key,size) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [w, id, brand.brand_id, mail.from.slice(0, 320), mail.to.slice(0, 320), key, mail.raw.length],
      );
      await enqueueJob(db, w, "email.receive", { inboundId: id }, {});
      return { accepted: true as const, id };
    });
  } catch (e) {
    // An unknown workspace isn't told apart from an unknown address.
    if (e instanceof DomainError) throw e;
    if (String((e as Error).message).includes("Invalid workspace")) return { accepted: false as const, reason: "No such address." };
    throw e;
  }
}

/** The `email.receive` job: one accepted email, read into its conversation. */
export async function receiveEmailJob(connect: Connect, env: EmailEnvironment, job: Job) {
  const w = job.workspace_id;
  const { inboundId } = job.payload as { inboundId: string };
  const inbound = await tenant(
    connect,
    w,
    async (db) =>
      (
        await db.query<{ id: string; brand_id: string; raw_key: string; status: string; envelope_to: string }>("SELECT id,brand_id,raw_key,status,envelope_to FROM email_inbound WHERE workspace_id=$1 AND id=$2", [
          w,
          inboundId,
        ])
      ).rows[0],
  );
  if (!inbound || inbound.status !== "received") return { done: true, result: { skipped: true } };
  const failed = (error: string) =>
    tenant(connect, w, (db) => db.query("UPDATE email_inbound SET status='failed',error=$3,read_at=now() WHERE workspace_id=$1 AND id=$2", [w, inboundId, error.slice(0, 500)]));
  const raw = await env.storage?.getQuarantine(inbound.raw_key);
  if (!raw) {
    await failed("Its raw message is missing from storage.");
    return { done: true, result: { failed: true } };
  }
  const m = await readEmail(raw.bytes, { trustedAuthServ: env.trustedAuthServ });
  // Attachments kept go to quarantine first (keys by attachment id); scanning publishes them.
  const kept: { id: string; key: string; name: string; mime: string; size: number }[] = [];
  const listed = m.attachments.map((a) => {
    const keep = KEPT.has(a.mimeType) && a.size > 0 && a.size <= MAX_ATTACHMENT_BYTES;
    if (keep) kept.push({ id: crypto.randomUUID(), key: "", name: a.filename.slice(0, 200).replace(/[\x00-\x1f]/g, "") || "attachment", mime: a.mimeType, size: a.size });
    return {
      name: a.filename,
      mime: a.mimeType,
      size: a.size,
      kept: keep,
      reason: keep ? "" : a.size > MAX_ATTACHMENT_BYTES ? "Larger than 10 MB." : "Only PNG, JPEG, PDF and plain text are kept.",
    };
  });
  if (m.kind === "message" && m.from)
    for (const [i, k] of kept.entries()) {
      k.key = `${encodeURIComponent(w)}/${k.id}/quarantine`;
      const source = m.attachments.filter((a) => KEPT.has(a.mimeType) && a.size > 0 && a.size <= MAX_ATTACHMENT_BYTES)[i];
      await env.storage!.putQuarantine!(k.key, source.content, k.mime);
    }
  try {
    await tenant(connect, w, async (db) => {
      const done = (kind: string, conversationId: string | null = null, partId: string | null = null) =>
        db.query("UPDATE email_inbound SET status='read',kind=$3,conversation_id=$4,part_id=$5,read_at=now() WHERE workspace_id=$1 AND id=$2", [
          w,
          inboundId,
          kind,
          conversationId,
          partId,
        ]);
      const settings = (
        await db.query<{ support_address: string | null; forwarding_verified_at: string | null }>(
          "SELECT support_address,forwarding_verified_at FROM email_settings WHERE workspace_id=$1 AND brand_id=$2",
          [w, inbound.brand_id],
        )
      ).rows[0];
      // Gmail asks to confirm forwarding: kept for the manager, not a conversation.
      if (m.from?.address === GMAIL_CONFIRMATION) {
        await db.query("UPDATE email_settings SET confirmation=$3 WHERE workspace_id=$1 AND brand_id=$2", [
          w,
          inbound.brand_id,
          JSON.stringify({ subject: m.subject, text: m.fullText.slice(0, 4000), receivedAt: new Date().toISOString() }),
        ]);
        await done("confirmation");
        return;
      }
      // The brand's own address forwarding here is confirmed by a message it forwarded.
      const support = settings?.support_address?.toLowerCase();
      if (support && !settings.forwarding_verified_at && [...m.to, ...m.cc, ...m.deliveredTo].includes(support))
        await db.query("UPDATE email_settings SET forwarding_verified_at=now() WHERE workspace_id=$1 AND brand_id=$2", [w, inbound.brand_id]);
      if (m.kind === "bounce" && m.bounce?.hard)
        for (const r of m.bounce.recipients.filter((x) => x.action === "failed" && x.status.startsWith("5")))
          await suppress(db, w, "email", r.address, "hard_bounce", `bounce:${inboundId}`);
      if (!m.from) {
        await db.query("UPDATE email_inbound SET status='failed',kind=$3,error='It has no sender.',read_at=now() WHERE workspace_id=$1 AND id=$2", [w, inboundId, m.kind]);
        return;
      }
      const keys = await threadKeys(m);
      // Mail to a conversation's reply address joins it first, whatever its headers say.
      const reply = /^[^+@]+\+r-([a-z0-9]{16,40})@/i.exec(inbound.envelope_to)?.[1]?.toLowerCase();
      if (reply) keys.threadKeys.unshift(`reply:${reply}`);
      const r = await receiveInbound(db, w, emailChannel, {
        externalId: m.messageId ? `mid:${m.messageId}` : `inbound:${inboundId}`,
        address: m.from.address,
        verified: m.verified,
        name: m.from.name,
        text: m.text || m.subject || "(no text)",
        threadKeys: keys.threadKeys,
        ownKeys: keys.ownKeys,
        fallback: keys.fallback && m.kind === "message" ? { key: keys.fallback, days: FALLBACK_DAYS } : null,
        brandId: inbound.brand_id,
        data: { email: { subject: m.subject }, ...(m.kind !== "message" ? { kind: m.kind, reason: m.reason, subject: m.subject } : {}) },
        automatic: m.kind !== "message",
      });
      if (r.partId && !("duplicate" in r && r.duplicate)) {
        await db.query(
          `INSERT INTO email_messages(workspace_id,part_id,conversation_id,inbound_id,message_id,subject,from_address,from_name,to_addresses,cc_addresses,sent_at,
             text_full,html,stripped,forwarded,verified,kind,reason,remote_images,attachments,headers)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT DO NOTHING`,
          [
            w,
            r.partId,
            r.conversationId,
            inboundId,
            m.messageId,
            m.subject.slice(0, 1000),
            m.from.address,
            m.from.name.slice(0, 200),
            m.to,
            m.cc,
            m.date,
            m.fullText.slice(0, 1_000_000),
            m.html ? m.html.slice(0, 5_000_000) : null,
            m.stripped,
            m.forwarded,
            m.verified,
            m.kind,
            m.reason,
            m.remoteImages,
            JSON.stringify(listed),
            JSON.stringify(m.headers),
          ],
        );
        // Each kept attachment: scanned, then published as the customer's attachment part.
        if (m.kind === "message")
          for (const k of kept) {
            await db.query(
              "INSERT INTO attachments(workspace_id,id,conversation_id,owner_identity_id,object_key,name,size,mime,audience,purpose,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'customer_visible','part','scanning')",
              [w, k.id, r.conversationId, r.identityId, k.key, k.name, k.size, k.mime],
            );
            const jobId = await enqueueJob(db, w, "attachment.scan", { attachmentId: k.id }, { identityId: r.identityId ?? undefined });
            await db.query("UPDATE attachments SET job_id=$3 WHERE workspace_id=$1 AND id=$2", [w, k.id, jobId]);
          }
      }
      await done(m.kind, r.conversationId, r.partId);
    });
  } catch (e) {
    if (e instanceof DomainError) {
      await failed(e.message);
      return { done: true, result: { failed: true } };
    }
    throw e;
  }
  await env.storage!.deleteQuarantine(inbound.raw_key);
  return { done: true, result: { read: true } };
}

/* ------------------------------------------------------------------------------------------ */
/* The inbox and Settings                                                                      */

/** The whole of an email behind a part ("Show the full email"), for anyone who can read it. */
export async function readEmailMessage(db: Sql, w: string, principal: string, partId: string) {
  await authorize(db, w, principal, "conversations.read");
  const m = (
    await db.query<{
      subject: string;
      from_address: string;
      from_name: string;
      to_addresses: string[];
      cc_addresses: string[];
      sent_at: string | null;
      text_full: string;
      html: string | null;
      stripped: boolean;
      forwarded: boolean;
      verified: boolean;
      kind: string;
      reason: string;
      remote_images: number;
      attachments: { name: string; mime: string; size: number; kept: boolean; reason: string }[];
    }>(
      `SELECT subject,from_address,from_name,to_addresses,cc_addresses,sent_at,text_full,html,stripped,forwarded,verified,kind,reason,remote_images,attachments
       FROM email_messages WHERE workspace_id=$1 AND part_id=$2`,
      [w, partId],
    )
  ).rows[0];
  assert(m, "EMAIL_NOT_FOUND", "That email isn't available.", 404);
  return {
    subject: m.subject,
    from: { address: m.from_address, name: m.from_name },
    to: m.to_addresses,
    cc: m.cc_addresses,
    sentAt: m.sent_at ? new Date(m.sent_at).toISOString() : null,
    text: m.text_full,
    html: m.html,
    stripped: m.stripped,
    forwarded: m.forwarded,
    verified: m.verified,
    kind: m.kind,
    reason: m.reason,
    remoteImages: m.remote_images,
    attachments: m.attachments,
  };
}

/** Settings › Email: each brand's inbound address, its support address and forwarding. */
export async function readEmailSettings(db: Sql, w: string, principal: string, domain: string, sending: EmailSending = { sendingDomain: domain, region: "eu-west-2" }) {
  await authorize(db, w, principal, "workspace.manage");
  assert(await emailEnabled(db, w), "EMAIL_DISABLED", "Email is not enabled for this workspace.", 404);
  // Every brand has an address from the start.
  await db.query(
    "INSERT INTO email_settings(workspace_id,brand_id,token) SELECT $1,b.id,$2||substr(md5(random()::text||b.id),1,8) FROM brands b WHERE b.workspace_id=$1 ON CONFLICT DO NOTHING",
    [w, newToken().slice(0, 4)],
  );
  const rows = (
    await db.query<{ brand_id: string; name: string; token: string; support_address: string | null; forwarding_verified_at: string | null; confirmation: unknown }>(
      `SELECT s.brand_id,b.name,s.token,s.support_address,s.forwarding_verified_at,s.confirmation FROM email_settings s
       JOIN brands b ON b.workspace_id=s.workspace_id AND b.id=s.brand_id WHERE s.workspace_id=$1 ORDER BY lower(b.name),b.id`,
      [w],
    )
  ).rows;
  const recent = (
    await db.query<{ brand_id: string; status: string; kind: string | null; error: string; received_at: string; envelope_from: string }>(
      "SELECT brand_id,status,kind,error,received_at,envelope_from FROM email_inbound WHERE workspace_id=$1 ORDER BY received_at DESC LIMIT 20",
      [w],
    )
  ).rows;
  const brands = [];
  for (const r of rows)
    brands.push({
      brandId: r.brand_id,
      name: r.name,
      address: inboundAddress(w, r.token, domain),
      supportAddress: r.support_address,
      forwardingVerifiedAt: r.forwarding_verified_at ? new Date(r.forwarding_verified_at).toISOString() : null,
      confirmation: r.confirmation,
      // E3: where its replies go from, its domain's records, and its away emails.
      sending: await readSending(db, w, r.brand_id, sending),
    });
  return {
    brands,
    reputation: await readReputation(db, w, sending.sendingDomain),
    recent: recent.map((r) => ({
      brandId: r.brand_id,
      status: r.status,
      kind: r.kind,
      error: r.error,
      from: r.envelope_from,
      receivedAt: new Date(r.received_at).toISOString(),
    })),
  };
}

/** Where Relay's own mail is (E3): the domain brands send from until theirs is proven, and the provider's region. */
export type EmailSending = { sendingDomain: string; region: string };

/**
 * Save a brand's support address (forwarding is confirmed again, and its domain is checked to
 * send from), give it a new inbound address, check its domain again, set its sending rate, or
 * change its away emails.
 */
export async function changeEmailSettings(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>, domain: string, sending?: EmailSending) {
  const t = await authorize(db, w, principal, "workspace.manage");
  assert(await emailEnabled(db, w), "EMAIL_DISABLED", "Email is not enabled for this workspace.", 404);
  return once(db, w, "email-settings:" + principal, key, p, async () => {
    const brandId = String(p.brandId ?? "");
    const exists = (await db.query("SELECT 1 FROM email_settings WHERE workspace_id=$1 AND brand_id=$2", [w, brandId])).rows.length;
    assert(exists, "BRAND_NOT_FOUND", "Brand unavailable.", 404);
    if (p.action === "save") {
      const raw = typeof p.supportAddress === "string" ? p.supportAddress.trim() : "";
      const address = raw ? emailChannel.address(raw) : null;
      assert(!raw || address, "INVALID_ADDRESS", "That isn't an email address.", 400);
      assert(
        !address?.endsWith("@" + domain.toLowerCase()) && !(sending && address?.endsWith("@" + sending.sendingDomain.toLowerCase())),
        "INVALID_ADDRESS",
        "Use your own support address, not Relay's.",
        400,
      );
      await db.query(
        `UPDATE email_settings SET support_address=$3,forwarding_verified_at=CASE WHEN support_address IS DISTINCT FROM $3 THEN NULL ELSE forwarding_verified_at END,
           confirmation=CASE WHEN support_address IS DISTINCT FROM $3 THEN NULL ELSE confirmation END,updated_by=$4,updated_at=now() WHERE workspace_id=$1 AND brand_id=$2`,
        [w, brandId, address, t.id],
      );
      // E3: its domain, when Relay can send as it, is checked to send from.
      const own = await ensureDomain(db, w, address);
      if (own) await queueDomainCheck(db, w, own);
    } else if (p.action === "check_domain") {
      const support = (await db.query<{ support_address: string | null }>("SELECT support_address FROM email_settings WHERE workspace_id=$1 AND brand_id=$2", [w, brandId])).rows[0]
        ?.support_address;
      const own = await ensureDomain(db, w, support ?? null);
      assert(own, "NO_DOMAIN", "Save a support address on your own domain first.", 400);
      await queueDomainCheck(db, w, own);
    } else if (p.action === "rate") {
      const support = (await db.query<{ support_address: string | null }>("SELECT support_address FROM email_settings WHERE workspace_id=$1 AND brand_id=$2", [w, brandId])).rows[0]
        ?.support_address;
      const perMinute = Number(p.perMinute);
      assert(Number.isInteger(perMinute) && perMinute >= 1 && perMinute <= 10000, "INVALID_RATE", "The rate is a whole number from 1 to 10,000 a minute.", 400);
      const own = support?.split("@")[1]?.toLowerCase() ?? "";
      const changed = await db.query("UPDATE email_domains SET rate_per_minute=$3 WHERE workspace_id=$1 AND domain=$2 RETURNING domain", [w, own, perMinute]);
      assert(changed.rows.length, "NO_DOMAIN", "Only your own domain's rate can change; Relay's address has its own.", 400);
    } else if (p.action === "away") {
      const minutes = Number(p.minutes);
      assert(typeof p.enabled === "boolean" && typeof p.content === "boolean", "INVALID_EMAIL_SETTINGS", "Say whether away emails are on, and whether they include the replies.", 400);
      assert(Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440, "INVALID_EMAIL_SETTINGS", "Wait between 1 minute and 24 hours.", 400);
      await db.query("UPDATE email_settings SET away_enabled=$3,away_content=$4,away_minutes=$5,updated_by=$6,updated_at=now() WHERE workspace_id=$1 AND brand_id=$2", [
        w,
        brandId,
        p.enabled,
        p.content,
        minutes,
        t.id,
      ]);
    } else if (p.action === "new_address") {
      // The old address stops working at once (mail to it is refused).
      await db.query("UPDATE email_settings SET token=$3,forwarding_verified_at=NULL,updated_by=$4,updated_at=now() WHERE workspace_id=$1 AND brand_id=$2", [
        w,
        brandId,
        newToken(),
        t.id,
      ]);
    } else throw new DomainError("INVALID_EMAIL_SETTINGS", "Unknown change.", 400);
    return readEmailSettings(db, w, principal, domain, sending);
  });
}
