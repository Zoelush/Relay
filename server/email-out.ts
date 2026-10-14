import { tenant, type Connect, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import { resolveContact } from "./people";
import type { AttachmentStorage } from "./attachments";
import type { ChannelEnvironment, Outbound, SendResult } from "./channels";
import { buildEmail, type Mailbox } from "./email-mime";
import { EmailRejected, type DnsResolver, type EmailSender } from "./email-providers";
import { composeAway, composeReply, type Said } from "./email-compose";

/**
 * Email out (phase 12, step E3; docs/OMNICHANNEL_STEP3.md). The email adapter's `prepare` and
 * `send`, which run only inside `runDelivery`, after `mayDeliver` (the single gate):
 *
 * - **From:** the brand's support address once its domain is proven (Relay's ownership record,
 *   the provider's DKIM, the provider's own check); until then, Relay's address for the brand.
 * - **Reply-To:** the conversation's own address (`<workspace>+r-<token>@<inbound domain>`), so
 *   a reply finds its conversation whatever the customer's client does with the headers.
 * - **Threading:** Message-ID, In-Reply-To and References, recorded as thread keys.
 * - **Rate:** sends per sending domain per minute; over it, the delivery waits for the next minute.
 * - **Away emails:** messenger customers who haven't read a reply get one email of what they
 *   missed (or only that there's something, when the brand's switch is off).
 *
 * The domain check (`email.domain.check`) and the reputation figures are here too.
 */
export type EmailOutEnvironment = {
  sender?: EmailSender;
  dns?: DnsResolver;
  /** Reads attachments' clean bytes for sending. */
  storage?: AttachmentStorage;
  /** Where replies come back (reply addresses). */
  inboundDomain: string;
  /** Relay's own sending domain: brands without a proven domain send from it. */
  sendingDomain: string;
  /** The provider's region (its bounce MX). */
  region: string;
};
export const SHARED_RATE_PER_MINUTE = 30;
const OUTBOUND = ["teammate_reply", "ai_reply", "workflow_message", "attachment"];
const MAX_FILE = 10 * 1024 * 1024;
/** Mailboxes anyone can sign up for: never a brand's sending domain. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "gmx.de", "web.de", "yandex.com", "yandex.ru", "mail.ru", "zoho.com",
  "qq.com", "163.com", "126.com", "naver.com", "fastmail.com", "hey.com",
]);
export const isFreeMail = (domain: string) => FREE_MAIL.has(domain.toLowerCase());
const randomToken = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
const envOf = (env: ChannelEnvironment) => env.providers?.email as EmailOutEnvironment | undefined;

/* ------------------------------------------------------------------------------------------ */
/* Sending domains                                                                             */

export type DomainRecord = {
  purpose: "ownership" | "dkim" | "bounce_mx" | "spf" | "dmarc";
  type: "TXT" | "CNAME" | "MX";
  name: string;
  value: string;
  /** Required to send from the domain; SPF and DMARC are checked and advised. */
  required: boolean;
  status: "ok" | "missing" | "wrong" | "unknown";
  found?: string;
};
/** The records a brand's domain needs, before they're checked. */
export function domainRecords(domain: string, ownershipToken: string, dkimTokens: string[], region: string): DomainRecord[] {
  return [
    { purpose: "ownership", type: "TXT", name: `_relay.${domain}`, value: `relay-domain=${ownershipToken}`, required: true, status: "unknown" },
    ...dkimTokens.map((t) => ({ purpose: "dkim" as const, type: "CNAME" as const, name: `${t}._domainkey.${domain}`, value: `${t}.dkim.amazonses.com`, required: true, status: "unknown" as const })),
    { purpose: "bounce_mx", type: "MX", name: `bounce.${domain}`, value: `10 feedback-smtp.${region}.amazonses.com`, required: false, status: "unknown" },
    { purpose: "spf", type: "TXT", name: `bounce.${domain}`, value: "v=spf1 include:amazonses.com ~all", required: false, status: "unknown" },
    { purpose: "dmarc", type: "TXT", name: `_dmarc.${domain}`, value: `v=DMARC1; p=none;`, required: false, status: "unknown" },
  ];
}
function judge(r: DomainRecord, values: string[]): DomainRecord["status"] {
  const v = values.map((x) => x.trim());
  const ok =
    r.purpose === "ownership"
      ? v.includes(r.value)
      : r.purpose === "dkim"
        ? v.includes(r.value)
        : r.purpose === "bounce_mx"
          ? v.some((x) => x.toLowerCase().endsWith(r.value.split(" ")[1]))
          : r.purpose === "spf"
            ? v.some((x) => /^v=spf1\b/i.test(x) && /\binclude:amazonses\.com\b/i.test(x))
            : v.some((x) => /^v=DMARC1\b/i.test(x));
  return ok ? "ok" : v.length ? "wrong" : "missing";
}

/** A brand's support address domain gets a row (and a check) when it's one Relay can send as. */
export async function ensureDomain(db: Sql, w: string, supportAddress: string | null) {
  const domain = supportAddress?.split("@")[1]?.toLowerCase();
  if (!domain || isFreeMail(domain)) return null;
  await db.query("INSERT INTO email_domains(workspace_id,domain,ownership_token) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [w, domain, randomToken(24)]);
  return domain;
}
export async function queueDomainCheck(db: Sql, w: string, domain: string) {
  await db.query("UPDATE email_domains SET checked_at=now() WHERE workspace_id=$1 AND domain=$2", [w, domain]);
  await enqueueJob(db, w, "email.domain.check", { domain }, {});
}
/** The sweep: pending domains every 10 minutes for three days, proven ones daily (records can be removed). */
export async function scheduleDomainChecks(connect: Connect, w: string) {
  await tenant(connect, w, async (db) => {
    const due = (
      await db.query<{ domain: string }>(
        `SELECT domain FROM email_domains WHERE workspace_id=$1 AND (
           (status='pending' AND created_at>now()-interval '3 days' AND (checked_at IS NULL OR checked_at<now()-interval '10 minutes'))
           OR (status='verified' AND checked_at<now()-interval '1 day')) LIMIT 20`,
        [w],
      )
    ).rows;
    for (const d of due) await queueDomainCheck(db, w, d.domain);
  });
}
/** The `email.domain.check` job: the provider's identity (created when missing), then each record in DNS. */
export async function checkDomainJob(connect: Connect, env: EmailOutEnvironment, job: Job) {
  const w = job.workspace_id;
  const { domain } = job.payload as { domain: string };
  const row = await tenant(connect, w, async (db) =>
    (await db.query<{ ownership_token: string; created_at: string; status: string }>("SELECT ownership_token,created_at,status FROM email_domains WHERE workspace_id=$1 AND domain=$2", [w, domain])).rows[0],
  );
  if (!row) return { done: true, result: { skipped: true } };
  const save = (fields: { status?: string; records?: DomainRecord[]; error: string; providerVerified?: boolean; dkim?: string[] }) =>
    tenant(connect, w, (db) =>
      db.query(
        `UPDATE email_domains SET status=COALESCE($3,status),records=COALESCE($4,records),error=$5,provider_verified=COALESCE($6,provider_verified),
           dkim_tokens=COALESCE($7,dkim_tokens),checked_at=now(),verified_at=CASE WHEN $3='verified' AND status<>'verified' THEN now() ELSE verified_at END
         WHERE workspace_id=$1 AND domain=$2`,
        [w, domain, fields.status ?? null, fields.records ? JSON.stringify(fields.records) : null, fields.error, fields.providerVerified ?? null, fields.dkim ?? null],
      ),
    );
  if (!env.sender || !env.dns) {
    await save({ error: "Email sending isn't set up for Relay yet." });
    return { done: true, result: { checked: false } };
  }
  let identity: { dkimTokens: string[]; verified: boolean };
  try {
    identity = await env.sender.identity(domain);
  } catch (e) {
    await save({ error: (e as Error).message.slice(0, 300) });
    return { done: true, result: { checked: false } };
  }
  const records = domainRecords(domain, row.ownership_token, identity.dkimTokens, env.region);
  for (const r of records) {
    try {
      const values = await env.dns.lookup(r.name, r.type);
      r.status = judge(r, values);
      if (r.status === "wrong") r.found = values.join(", ").slice(0, 300);
    } catch {
      r.status = "unknown";
    }
  }
  const proven = identity.verified && identity.dkimTokens.length > 0 && records.filter((r) => r.required).every((r) => r.status === "ok");
  const expired = Date.now() - new Date(row.created_at).getTime() > 3 * 86_400_000;
  await save({
    status: proven ? "verified" : expired && row.status !== "verified" ? "failed" : "pending",
    records,
    error: proven || identity.verified ? "" : "The provider hasn't confirmed the DKIM records yet: this can take a few hours after they're added.",
    providerVerified: identity.verified,
    dkim: identity.dkimTokens,
  });
  return { done: true, result: { proven } };
}

/* ------------------------------------------------------------------------------------------ */
/* Sending                                                                                     */

type Prepared = {
  from: Mailbox;
  replyTo: Mailbox;
  subject: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  html: string;
  text: string;
  attachment: { key: string; name: string; mime: string } | null;
  auto: boolean;
};
const reSubject = (s: string) => (/^(re|aw|sv|antw|r)\s*:/i.test(s.trim()) ? s.trim() : `Re: ${s.trim()}`);
async function authorName(db: Sql, w: string, type: string, id: string, brand: string) {
  if (type === "teammate") {
    const name = (await db.query<{ name: string }>("SELECT name FROM teammates WHERE workspace_id=$1 AND id=$2", [w, id])).rows[0]?.name ?? "";
    return name ? `${name.split(/\s+/)[0]} from ${brand}` : brand;
  }
  if (type === "ai") {
    const name = (await db.query<{ name: string }>("SELECT name FROM ai_agents WHERE workspace_id=$1 AND id=$2", [w, id])).rows[0]?.name ?? "";
    return name ? `${name} from ${brand}` : brand;
  }
  return brand;
}
/** The conversation's reply address token, made the first time. */
async function replyToken(db: Sql, w: string, conversationId: string, brandId: string) {
  await db.query("INSERT INTO email_reply_addresses(workspace_id,token,conversation_id,brand_id) VALUES($1,$2,$3,$4) ON CONFLICT (workspace_id,conversation_id) DO NOTHING", [
    w,
    randomToken(20),
    conversationId,
    brandId,
  ]);
  return (await db.query<{ token: string }>("SELECT token FROM email_reply_addresses WHERE workspace_id=$1 AND conversation_id=$2", [w, conversationId])).rows[0].token;
}

/**
 * Inside the gate's transaction: who it's from, where replies go, its thread and its words; or a
 * later minute (the rate limit), or why it can't go.
 */
export async function prepareEmail(db: Sql, w: string, out: Outbound, env: ChannelEnvironment): Promise<{ data: Prepared } | { defer: Date } | { refuse: string }> {
  const e = envOf(env);
  if (!e?.sender) return { refuse: "Email sending isn't set up for Relay yet." };
  const c = (
    await db.query<{ brand_id: string; title: string | null; brand: string; token: string | null; support_address: string | null; away_content: boolean | null }>(
      `SELECT c.brand_id,c.title,b.name AS brand,s.token,s.support_address,s.away_content FROM conversations c JOIN brands b ON b.workspace_id=c.workspace_id AND b.id=c.brand_id
       LEFT JOIN email_settings s ON s.workspace_id=c.workspace_id AND s.brand_id=c.brand_id WHERE c.workspace_id=$1 AND c.id=$2`,
      [w, out.conversationId],
    )
  ).rows[0];
  if (!c?.token) return { refuse: "The brand has no email address yet: open Settings › Email." };
  // From: the brand's own address once its domain is proven, else Relay's address for the brand.
  const ownDomain = c.support_address?.split("@")[1]?.toLowerCase() ?? null;
  const proven = ownDomain
    ? (await db.query<{ rate_per_minute: number }>("SELECT rate_per_minute FROM email_domains WHERE workspace_id=$1 AND domain=$2 AND status='verified'", [w, ownDomain])).rows[0]
    : undefined;
  const domain = proven ? ownDomain! : e.sendingDomain.toLowerCase();
  const fromAddress = proven ? c.support_address!.toLowerCase() : `${w}+${c.token}@${e.sendingDomain}`;
  // The rate limit: counted per sending domain per minute; over it, the next minute.
  const counted = await db.query(
    `INSERT INTO email_send_counts(workspace_id,domain,minute,sent) VALUES($1,$2,date_trunc('minute',now()),1)
     ON CONFLICT (workspace_id,domain,minute) DO UPDATE SET sent=email_send_counts.sent+1 WHERE email_send_counts.sent<$3 RETURNING sent`,
    [w, domain, proven ? proven.rate_per_minute : SHARED_RATE_PER_MINUTE],
  );
  if (!counted.rows.length) {
    const next = (await db.query<{ at: string }>("SELECT date_trunc('minute',now())+interval '1 minute' AS at")).rows[0].at;
    return { defer: new Date(next) };
  }
  await db.query("UPDATE channel_deliveries SET domain=$3 WHERE workspace_id=$1 AND id=$2", [w, out.deliveryId, domain]);

  const token = await replyToken(db, w, out.conversationId, c.brand_id);
  const messageId = `${out.deliveryId}@${domain}`;
  const firstSubject = (
    await db.query<{ subject: string }>("SELECT subject FROM email_messages WHERE workspace_id=$1 AND conversation_id=$2 AND kind='message' ORDER BY created_at LIMIT 1", [
      w,
      out.conversationId,
    ])
  ).rows[0]?.subject;
  const last = (
    await db.query<{ message_id: string | null; from_name: string; from_address: string; sent_at: string | null; created_at: string; text: string }>(
      `SELECT m.message_id,m.from_name,m.from_address,m.sent_at,m.created_at,p.body AS text FROM email_messages m
       JOIN conversation_parts p ON p.workspace_id=m.workspace_id AND p.id=m.part_id
       WHERE m.workspace_id=$1 AND m.conversation_id=$2 AND m.kind='message' ORDER BY m.created_at DESC LIMIT 1`,
      [w, out.conversationId],
    )
  ).rows[0];
  const references = (
    await db.query<{ thread_key: string }>(
      "SELECT thread_key FROM channel_threads WHERE workspace_id=$1 AND channel='email' AND conversation_id=$2 AND thread_key LIKE 'mid:%' ORDER BY created_at DESC LIMIT 10",
      [w, out.conversationId],
    )
  ).rows
    .map((r) => r.thread_key.slice(4))
    .reverse();
  // Later mail that refers to this one, or comes to the reply address, finds the conversation.
  for (const key of [`mid:${messageId}`, `reply:${token}`])
    await db.query("INSERT INTO channel_threads(workspace_id,channel,thread_key,conversation_id) VALUES($1,'email',$2,$3) ON CONFLICT DO NOTHING", [w, key, out.conversationId]);

  const part = (
    await db.query<{ seq: string; kind: string; author_type: string; author_id: string; body: string; data: Record<string, unknown> }>(
      "SELECT seq,kind,author_type,author_id,body,data FROM conversation_parts WHERE workspace_id=$1 AND id=$2",
      [w, out.partId],
    )
  ).rows[0];
  const name = await authorName(db, w, part.author_type, part.author_id, c.brand);
  let words: { html: string; text: string };
  let subject: string;
  let attachment: Prepared["attachment"] = null;
  if (out.purpose === "away") {
    // What the customer hasn't read: public replies only (never a note), the last ten.
    const read = (
      await db.query<{ read_seq: string }>(
        "SELECT r.read_seq FROM customer_reads r JOIN conversations c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id AND c.primary_identity_id=r.identity_id WHERE r.workspace_id=$1 AND r.conversation_id=$2",
        [w, out.conversationId],
      )
    ).rows[0]?.read_seq;
    const unread = (
      await db.query<{ kind: string; author_type: string; author_id: string; body: string; data: Record<string, unknown> }>(
        `SELECT kind,author_type,author_id,body,data FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND seq>$3 AND seq<=$4
           AND audience='public' AND author_type<>'contact' AND kind=ANY($5::text[]) ORDER BY seq DESC LIMIT 10`,
        [w, out.conversationId, read ?? 0, part.seq, OUTBOUND],
      )
    ).rows.reverse();
    const replies: Said[] = [];
    for (const p of unread)
      replies.push({
        author: await authorName(db, w, p.author_type, p.author_id, c.brand),
        doc: p.data.doc,
        body: p.kind === "attachment" ? `[A file: ${String(p.data.name ?? "attachment")}]` : p.body,
      });
    words = composeAway({ brand: c.brand, replies: replies.length ? replies : [{ author: name, body: part.body }], content: c.away_content === true });
    subject = c.title ? reSubject(c.title) : `A new reply from ${c.brand}`;
  } else {
    if (part.kind === "attachment" && typeof part.data.attachmentId === "string") {
      const file = (
        await db.query<{ name: string; mime: string; size: string; status: string; clean_key: string | null }>(
          "SELECT name,mime,size,status,clean_key FROM attachments WHERE workspace_id=$1 AND id=$2",
          [w, part.data.attachmentId],
        )
      ).rows[0];
      if (!file || file.status !== "clean" || !file.clean_key) return { refuse: "The file isn't ready to send (it hasn't passed its scan)." };
      if (Number(file.size) > MAX_FILE) return { refuse: "The file is larger than 10 MB, too large to email." };
      attachment = { key: file.clean_key, name: file.name, mime: file.mime };
    }
    const quote = last
      ? { name: last.from_name || last.from_address, at: new Date(last.sent_at ?? last.created_at).toUTCString().replace(" GMT", " UTC"), text: last.text }
      : null;
    words = composeReply({ brand: c.brand, said: { author: name, doc: part.data.doc, body: attachment ? `[A file: ${attachment.name}]` : out.text }, quote });
    subject = firstSubject ? reSubject(firstSubject) : c.title ? reSubject(c.title) : `Your conversation with ${c.brand}`;
  }
  return {
    data: {
      from: { address: fromAddress, name },
      replyTo: { address: `${w}+r-${token}@${e.inboundDomain}`, name: c.brand },
      subject,
      messageId,
      inReplyTo: last?.message_id ?? null,
      references: [...new Set([...references, ...(last?.message_id ? [last.message_id] : [])])].slice(-10),
      html: words.html,
      text: words.text,
      attachment,
      auto: out.purpose === "away",
    },
  };
}

/** Outside any transaction: built and handed to the provider. */
export async function sendEmail(out: Outbound, env: ChannelEnvironment): Promise<SendResult> {
  const e = envOf(env);
  const p = out.prepared as Prepared | undefined;
  if (!e?.sender || !p) return { status: "failed", error: "Email sending isn't set up for Relay yet.", permanent: true };
  const files = [];
  if (p.attachment) {
    if (!e.storage?.readClean) return { status: "failed", error: "Files can't be read for sending here.", permanent: true };
    const r = await e.storage.readClean(p.attachment.key);
    if (!r.ok) throw new Error("The file couldn't be read.");
    files.push({ name: p.attachment.name, mime: p.attachment.mime, bytes: new Uint8Array(await r.arrayBuffer()) });
  }
  const raw = buildEmail({
    from: p.from,
    to: { address: out.address },
    replyTo: p.replyTo,
    subject: p.subject,
    messageId: p.messageId,
    inReplyTo: p.inReplyTo,
    references: p.references,
    text: p.text,
    html: p.html,
    attachments: files,
    // An away email is automatic: out-of-office replies to it are suppressed, and loops can't start.
    headers: p.auto ? { "Auto-Submitted": "auto-generated", "X-Auto-Response-Suppress": "All" } : {},
  });
  try {
    const sent = await e.sender.sendRaw({ from: p.from.address, to: out.address, raw, tags: { relay_workspace: out.workspaceId, relay_delivery: out.deliveryId } });
    return { status: "sent", providerId: sent.providerId };
  } catch (err) {
    if (err instanceof EmailRejected) return { status: "failed", error: err.message, permanent: true };
    throw err;
  }
}

/** What the composer shows on an email conversation: the subject replies go out with. */
export async function emailReplyDetails(db: Sql, w: string, conversationId: string): Promise<Record<string, string>> {
  const first = (
    await db.query<{ subject: string }>("SELECT subject FROM email_messages WHERE workspace_id=$1 AND conversation_id=$2 AND kind='message' ORDER BY created_at LIMIT 1", [
      w,
      conversationId,
    ])
  ).rows[0]?.subject;
  return first ? { subject: reSubject(first) } : {};
}

/* ------------------------------------------------------------------------------------------ */
/* Away emails                                                                                 */

async function emailOn(db: Sql, w: string) {
  return (
    (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_features WHERE workspace_id=$1 AND enabled AND name IN ('channels_v1','channel_email_v1')", [w]))
      .rows[0].n === 2
  );
}
/**
 * The sweep: messenger conversations with a public reply the customer hasn't read for the brand's
 * minutes, and an email address for them, get an away email (a delivery through the gate).
 */
export async function checkAwayEmails(connect: Connect, w: string, at = new Date()) {
  await tenant(connect, w, async (db) => {
    if (!(await emailOn(db, w))) return;
    const due = (
      await db.query<{ id: string; primary_identity_id: string; email: string | null; part_id: string; seq: string }>(
        `SELECT c.id,c.primary_identity_id,c.email,last.id AS part_id,last.seq FROM conversations c
         JOIN email_settings s ON s.workspace_id=c.workspace_id AND s.brand_id=c.brand_id AND s.away_enabled
         JOIN LATERAL (SELECT p.id,p.seq,p.created_at FROM conversation_parts p WHERE p.workspace_id=c.workspace_id AND p.conversation_id=c.id
           AND p.audience='public' AND p.author_type<>'contact' AND p.kind=ANY($2::text[]) ORDER BY p.seq DESC LIMIT 1) last ON true
         LEFT JOIN customer_reads r ON r.workspace_id=c.workspace_id AND r.conversation_id=c.id AND r.identity_id=c.primary_identity_id
         LEFT JOIN email_away a ON a.workspace_id=c.workspace_id AND a.conversation_id=c.id
         WHERE c.workspace_id=$1 AND COALESCE(c.current_channel,'messenger')='messenger' AND c.visibility<>'internal' AND c.merged_into_id IS NULL
           AND c.updated_at>$3::timestamptz-interval '7 days' AND last.created_at<$3::timestamptz-make_interval(mins=>s.away_minutes)
           AND last.created_at>$3::timestamptz-interval '7 days' AND last.seq>COALESCE(r.read_seq,0) AND last.seq>COALESCE(a.through_seq,0)
         ORDER BY last.created_at LIMIT 50`,
        [w, OUTBOUND, at.toISOString()],
      )
    ).rows;
    for (const c of due) {
      await db.query(
        "INSERT INTO email_away(workspace_id,conversation_id,through_seq) VALUES($1,$2,$3) ON CONFLICT (workspace_id,conversation_id) DO UPDATE SET through_seq=$3,sent_at=now()",
        [w, c.id, c.seq],
      );
      const address = await customerEmail(db, w, c.primary_identity_id, c.email);
      if (!address) continue;
      const id = crypto.randomUUID();
      const added = await db.query(
        `INSERT INTO channel_deliveries(workspace_id,id,part_id,conversation_id,channel,identity_id,address,purpose) VALUES($1,$2,$3,$4,'email',$5,$6,'away')
         ON CONFLICT DO NOTHING RETURNING id`,
        [w, id, c.part_id, c.id, c.primary_identity_id, address],
      );
      if (added.rows.length) await enqueueJob(db, w, "channel.deliver", { deliveryId: id }, {});
    }
  });
}
/** The customer's email: their contact's (a verified one first), else the one given in the conversation. */
async function customerEmail(db: Sql, w: string, identityId: string, given: string | null) {
  const mapped = (await db.query<{ contact_id: string }>("SELECT contact_id FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2", [w, identityId])).rows[0];
  const contactId = mapped ? await resolveContact(db, w, mapped.contact_id) : null;
  const known = contactId
    ? (await db.query<{ email: string }>("SELECT email FROM contact_emails WHERE workspace_id=$1 AND contact_id=$2 ORDER BY verified DESC,email LIMIT 1", [w, contactId])).rows[0]?.email
    : undefined;
  const address = (known ?? given ?? "").trim().toLowerCase();
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(address) && address.length <= 254 ? address : null;
}

/* ------------------------------------------------------------------------------------------ */
/* Settings: domains, away emails, rates and reputation                                        */

export type Reputation = {
  domain: string;
  shared: boolean;
  days: 7 | 30;
  sent: number;
  delivered: number;
  bounces: number;
  complaints: number;
  bounceRate: number;
  complaintRate: number;
  standing: "healthy" | "at_risk" | "poor" | "too_few";
  daily: { day: string; sent: number; bounced: number }[];
};
/**
 * Each sending domain's last 7 and 30 days. Standing follows the provider's review levels: a bounce
 * rate of 5% or complaints of 0.1% put it at risk, 10% or 0.5% poor; under 20 emails, too few to say.
 */
export async function readReputation(db: Sql, w: string, sendingDomain: string): Promise<Reputation[]> {
  const rows = (
    await db.query<{ domain: string; days: number; sent: number; delivered: number; bounces: number; complaints: number }>(
      `SELECT d.domain,x.days,
         count(*) FILTER (WHERE d.provider_id IS NOT NULL AND d.created_at>now()-make_interval(days=>x.days))::int AS sent,
         (SELECT count(*)::int FROM email_events e WHERE e.workspace_id=$1 AND e.domain=d.domain AND e.kind='delivery' AND e.created_at>now()-make_interval(days=>x.days)) AS delivered,
         (SELECT count(*)::int FROM email_events e WHERE e.workspace_id=$1 AND e.domain=d.domain AND e.kind='bounce' AND e.created_at>now()-make_interval(days=>x.days)) AS bounces,
         (SELECT count(*)::int FROM email_events e WHERE e.workspace_id=$1 AND e.domain=d.domain AND e.kind='complaint' AND e.created_at>now()-make_interval(days=>x.days)) AS complaints
       FROM channel_deliveries d CROSS JOIN (VALUES (7),(30)) x(days)
       WHERE d.workspace_id=$1 AND d.channel='email' AND d.domain IS NOT NULL AND d.created_at>now()-interval '30 days'
       GROUP BY d.domain,x.days ORDER BY d.domain,x.days`,
      [w],
    )
  ).rows;
  const daily = (
    await db.query<{ domain: string; day: string; sent: number; bounced: number }>(
      `SELECT d.domain,to_char(date_trunc('day',d.created_at),'YYYY-MM-DD') AS day,count(*) FILTER (WHERE d.provider_id IS NOT NULL)::int AS sent,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM email_events e WHERE e.workspace_id=d.workspace_id AND e.delivery_id=d.id AND e.kind='bounce'))::int AS bounced
       FROM channel_deliveries d WHERE d.workspace_id=$1 AND d.channel='email' AND d.domain IS NOT NULL AND d.created_at>now()-interval '30 days'
       GROUP BY 1,2 ORDER BY 1,2`,
      [w],
    )
  ).rows;
  return rows.map((r) => {
    const bounceRate = r.sent ? r.bounces / r.sent : 0;
    const complaintRate = r.sent ? r.complaints / r.sent : 0;
    return {
      domain: r.domain,
      shared: r.domain === sendingDomain.toLowerCase(),
      days: r.days as 7 | 30,
      sent: r.sent,
      delivered: r.delivered,
      bounces: r.bounces,
      complaints: r.complaints,
      bounceRate,
      complaintRate,
      standing: r.sent < 20 ? "too_few" : bounceRate >= 0.1 || complaintRate >= 0.005 ? "poor" : bounceRate >= 0.05 || complaintRate >= 0.001 ? "at_risk" : "healthy",
      daily: r.days === 30 ? daily.filter((d) => d.domain === r.domain).map(({ day, sent, bounced }) => ({ day, sent, bounced })) : [],
    };
  });
}

/** Each brand's sending: from where, the domain's records, the rate, and away emails. */
export async function readSending(db: Sql, w: string, brandId: string, env: { sendingDomain: string; region: string }) {
  const s = (
    await db.query<{ token: string; support_address: string | null; away_enabled: boolean; away_content: boolean; away_minutes: number }>(
      "SELECT token,support_address,away_enabled,away_content,away_minutes FROM email_settings WHERE workspace_id=$1 AND brand_id=$2",
      [w, brandId],
    )
  ).rows[0];
  const domain = s.support_address?.split("@")[1]?.toLowerCase() ?? null;
  const d = domain
    ? (
        await db.query<{ ownership_token: string; status: string; records: DomainRecord[]; error: string; rate_per_minute: number; checked_at: string | null; dkim_tokens: string[] }>(
          "SELECT ownership_token,status,records,error,rate_per_minute,checked_at,dkim_tokens FROM email_domains WHERE workspace_id=$1 AND domain=$2",
          [w, domain],
        )
      ).rows[0]
    : undefined;
  return {
    from: d?.status === "verified" ? s.support_address! : `${w}+${s.token}@${env.sendingDomain}`,
    domain: domain
      ? {
          name: domain,
          freeMail: isFreeMail(domain),
          status: d?.status ?? null,
          error: d?.error ?? "",
          // Before the first check, the records Relay knows: the ownership record (DKIM's come from the provider).
          records: d ? (d.records.length ? d.records : domainRecords(domain, d.ownership_token, d.dkim_tokens, env.region)) : [],
          ratePerMinute: d?.rate_per_minute ?? SHARED_RATE_PER_MINUTE,
          checkedAt: d?.checked_at ? new Date(d.checked_at).toISOString() : null,
        }
      : null,
    away: { enabled: s.away_enabled, content: s.away_content, minutes: s.away_minutes },
  };
}
