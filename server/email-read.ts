import PostalMime, { type Address, type Email } from "postal-mime";
import { baseSubject, stripReply } from "./email-quotes";
import { htmlText, sanitizeEmailHtml } from "./email-html";

/**
 * One inbound email read (phase 12, step E2; docs/OMNICHANNEL_STEP2.md), with no database: MIME
 * parsed (multipart, character sets, encoded words, attachments) by postal-mime, then:
 *
 * - **What it is:** a customer's message, an automatic reply (out of office, auto-responders), or
 *   a bounce (a delivery status notification, or a mailer's plain-text failure). Only messages are
 *   customers' replies.
 * - **Who sent it:** the From address, believed (`verified`) only when a trusted receiver's
 *   Authentication-Results says DMARC passed for its domain. Results added by anyone else are
 *   ignored, since a sender could write their own.
 * - **Threading:** its Message-ID, In-Reply-To and References, and a subject-and-sender fallback.
 * - **Its text:** the new part (quotes and signature stripped, `email-quotes.ts`) and the whole.
 *   Its HTML is made safe (`email-html.ts`), with inline images as data and remote ones blocked.
 * - **Attachments:** each with its type and size. Inline images used in the HTML are not
 *   attachments.
 */
export const MAX_EMAIL_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 100;
const INLINE_IMAGE_BYTES = 512 * 1024;
const INLINE_TOTAL_BYTES = 4 * 1024 * 1024;

export type ReadAttachment = { filename: string; mimeType: string; size: number; content: Uint8Array };
export type Bounce = { recipients: { address: string; status: string; action: string }[]; hard: boolean };
export type ReadEmail = {
  messageId: string | null;
  inReplyTo: string[];
  references: string[];
  from: { address: string; name: string } | null;
  to: string[];
  cc: string[];
  /** Where it was delivered or forwarded to (Delivered-To, X-Forwarded-To, X-Original-To). */
  deliveredTo: string[];
  subject: string;
  date: string | null;
  kind: "message" | "auto_reply" | "bounce";
  /** Why it's automatic, in words (for teammates). */
  reason: string;
  bounce: Bounce | null;
  verified: boolean;
  text: string;
  fullText: string;
  stripped: boolean;
  forwarded: boolean;
  html: string | null;
  remoteImages: number;
  attachments: ReadAttachment[];
  headers: Record<string, string>;
};

const ids = (v: string | undefined) => [...(v ?? "").matchAll(/<([^<>\s]+)>/g)].map((m) => m[1].toLowerCase());
const mailboxes = (list: Address[] | undefined) =>
  (list ?? []).flatMap((a) => (a.group ? a.group : [a])).map((m) => (m.address ?? "").trim().toLowerCase()).filter(Boolean);
const header = (e: Email, key: string) => e.headers.find((h) => h.key === key)?.value ?? "";
const headers = (e: Email, key: string) => e.headers.filter((h) => h.key === key).map((h) => h.value);
const bytes = (c: ArrayBuffer | Uint8Array | string) => (typeof c === "string" ? new TextEncoder().encode(c) : c instanceof Uint8Array ? c : new Uint8Array(c));
const base64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

const AUTO_SUBJECT =
  /^\s*(auto(matic)?(-|\s)?(reply|response|antwort|réponse|respuesta|risposta)|out of (the )?office|abwesenheit(snotiz)?|absence|réponse automatique|respuesta automática|risposta automatica|automatisch antwoord|afwezig|autosvar|frånvaro|automatisk svar|poza biurem|автоответ|自動応答|自动回复|자동 응답|ooo\b)/i;
const BOUNCE_SUBJECT =
  /^\s*(undeliver(able|ed)|undelivered mail|delivery status notification \((failure|delay)\)|mail delivery (failed|failure|subsystem)|returned mail|failure notice|delivery (has )?failed|non-?delivery|nicht zustellbar|unzustellbar|non remis|no se puede entregar)/i;

/** Who a trusted receiver says sent it: DMARC passed for the From domain. */
function dmarcPassed(e: Email, fromDomain: string, trusted: string[]) {
  for (const value of headers(e, "authentication-results")) {
    const authserv = value.split(";")[0].trim().toLowerCase().split(/\s+/)[0];
    if (!trusted.includes(authserv)) continue;
    const dmarc = /\bdmarc\s*=\s*(\w+)[^;]*?(header\.from\s*=\s*([^\s;]+))?/i.exec(value);
    if (!dmarc) return false;
    const domain = (dmarc[3] ?? "").toLowerCase();
    return dmarc[1].toLowerCase() === "pass" && (!domain || domain === fromDomain);
  }
  return false;
}

function readDsn(e: Email): Bounce | null {
  const report = e.attachments.find((a) => a.mimeType === "message/delivery-status");
  const text = report ? new TextDecoder().decode(bytes(report.content)) : "";
  const recipients: Bounce["recipients"] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const final = /^(Final|Original)-Recipient:\s*(?:rfc822;)?\s*<?([^\s>]+)>?/im.exec(block);
    if (!final) continue;
    recipients.push({
      address: final[2].toLowerCase(),
      action: (/^Action:\s*(\S+)/im.exec(block)?.[1] ?? "").toLowerCase(),
      status: /^Status:\s*([0-9.]+)/im.exec(block)?.[1] ?? "",
    });
  }
  if (recipients.length) return { recipients, hard: recipients.some((r) => r.action === "failed" && r.status.startsWith("5")) };
  return null;
}
/** A mailer's plain-text failure: "550 5.1.1 <someone@example.com>: Recipient address rejected". */
function readPlainBounce(text: string): Bounce | null {
  const m = /\b([45])\d{2}[ -]([45]\.\d{1,3}\.\d{1,3})\b[^\n]*?<?([^\s<>@]+@[^\s<>]+?)>?[:\s]/.exec(text) ?? /<([^\s<>@]+@[^\s<>]+)>[^\n]*\n?[^\n]*\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(text);
  if (!m) return null;
  const [address, status] = m.length === 4 && m[2].includes(".") ? [m[3], m[2]] : [m[1], m[2]];
  return { recipients: [{ address: address.toLowerCase().replace(/[.,;]+$/, ""), status, action: status.startsWith("5") ? "failed" : "delayed" }], hard: status.startsWith("5") };
}

export async function readEmail(raw: Uint8Array | string, opts: { trustedAuthServ?: string[] } = {}): Promise<ReadEmail> {
  const e = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  const fromBox = e.from && !e.from.group ? e.from : e.from?.group?.[0];
  const from = fromBox?.address ? { address: fromBox.address.trim().toLowerCase(), name: (fromBox.name ?? "").trim() } : null;
  const subject = (e.subject ?? "").trim();
  const fromDomain = from?.address.split("@")[1] ?? "";

  // What it is.
  const auto = header(e, "auto-submitted").toLowerCase();
  const precedence = header(e, "precedence").toLowerCase();
  const contentType = header(e, "content-type").toLowerCase();
  const fromSystem = /^(mailer-daemon|postmaster|mail-daemon|bounce)@/i.test(from?.address ?? "") || /^(mailer-daemon|postmaster)$/i.test(fromBox?.name ?? "");
  let kind: ReadEmail["kind"] = "message";
  let reason = "";
  let bounce: Bounce | null = null;
  const isReport = contentType.includes("multipart/report") && contentType.includes("delivery-status");
  if (isReport || (fromSystem && BOUNCE_SUBJECT.test(subject)) || (fromSystem && e.attachments.some((a) => a.mimeType === "message/delivery-status"))) {
    kind = "bounce";
    bounce = readDsn(e) ?? readPlainBounce(e.text ?? htmlText(e.html ?? ""));
    reason = bounce?.hard ? "It couldn't be delivered (a hard bounce)." : "A delivery problem was reported.";
  } else if (
    (auto && auto !== "no") ||
    headers(e, "x-autoreply").length ||
    headers(e, "x-autorespond").length ||
    /^(auto_reply|auto-reply|bulk|junk)$/.test(precedence) ||
    header(e, "x-auto-response-suppress").toLowerCase().includes("all") ||
    AUTO_SUBJECT.test(subject)
  ) {
    kind = "auto_reply";
    reason = AUTO_SUBJECT.test(subject) ? "An automatic reply (out of office)." : "An automatic reply.";
  }

  // Its text and HTML.
  const inline = new Map<string, string>();
  let inlineBytes = 0;
  const html = e.html ?? null;
  const usedCids = new Set([...(html ?? "").matchAll(/cid:([^"'\s>)]+)/gi)].map((m) => m[1]));
  const attachments: ReadAttachment[] = [];
  for (const a of e.attachments) {
    const b = bytes(a.content);
    const cid = a.contentId?.replace(/^<|>$/g, "");
    if (cid && usedCids.has(cid) && /^image\/(png|jpeg|gif)$/.test(a.mimeType) && b.length <= INLINE_IMAGE_BYTES && inlineBytes + b.length <= INLINE_TOTAL_BYTES) {
      inline.set(cid, `data:${a.mimeType};base64,${base64(b)}`);
      inlineBytes += b.length;
      continue;
    }
    if (a.mimeType === "message/delivery-status" || a.mimeType === "message/rfc822-headers") continue;
    if (attachments.length < MAX_ATTACHMENTS) attachments.push({ filename: a.filename ?? (cid ? `${cid}` : "attachment"), mimeType: a.mimeType, size: b.length, content: b });
  }
  const safe = html ? sanitizeEmailHtml(html, inline) : null;
  const fullText = (e.text ?? (html ? htmlText(html) : "")).replace(/\r\n?/g, "\n").trim();
  // The new part: from the text part, else from the HTML without its quote containers.
  const source = e.text ?? (html ? htmlText(html, true) : "");
  const reply = kind === "message" ? stripReply(source, subject) : { text: fullText, stripped: false, forwarded: false };
  // An HTML-only message's quote containers were left out before the text rules ran.
  if (kind === "message" && !e.text && html && !reply.forwarded && htmlText(html, true) !== htmlText(html)) reply.stripped = true;

  const kept: Record<string, string> = {};
  for (const k of ["message-id", "in-reply-to", "references", "auto-submitted", "precedence", "list-id", "list-unsubscribe", "x-mailer", "user-agent", "authentication-results", "delivered-to", "x-forwarded-to", "x-original-to", "return-path"])
    if (header(e, k)) kept[k] = header(e, k).slice(0, 2000);
  return {
    messageId: ids(e.messageId)[0] ?? (e.messageId ? e.messageId.trim().toLowerCase() : null),
    inReplyTo: ids(e.inReplyTo),
    references: ids(e.references),
    from,
    to: mailboxes(e.to),
    cc: mailboxes(e.cc),
    deliveredTo: [...new Set([e.deliveredTo, ...headers(e, "delivered-to"), ...headers(e, "x-forwarded-to"), ...headers(e, "x-original-to")].filter(Boolean).map((x) => x!.trim().toLowerCase()))],
    subject,
    date: e.date ? new Date(e.date).toISOString() : null,
    kind,
    reason,
    bounce,
    verified: !!from && dmarcPassed(e, fromDomain, (opts.trustedAuthServ ?? []).map((x) => x.toLowerCase())),
    text: reply.text,
    fullText,
    stripped: reply.stripped,
    forwarded: reply.forwarded,
    html: safe?.html ?? null,
    remoteImages: safe?.remoteImages ?? 0,
    attachments,
    headers: kept,
  };
}

/** Thread keys: the message ids it refers to; its own id; and the subject-and-sender fallback. */
export async function threadKeys(m: ReadEmail) {
  const subject = baseSubject(m.subject);
  const fallback =
    subject.length >= 3 && m.from
      ? "subject:" + [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${subject}\n${m.from.address}`)))].map((b) => b.toString(16).padStart(2, "0")).join("")
      : null;
  return {
    threadKeys: [...new Set([...m.inReplyTo, ...m.references.slice().reverse()])].map((id) => "mid:" + id),
    ownKeys: m.messageId ? ["mid:" + m.messageId] : [],
    fallback,
  };
}
