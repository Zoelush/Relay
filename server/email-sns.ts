import { tenant, type Connect } from "./db";
import { deliveryReport, suppress } from "./channels";

/**
 * Email's provider reports (phase 12, step E3; docs/OMNICHANNEL_STEP3.md): SES publishes
 * deliveries, bounces and complaints to SNS, which posts them to `/v1/hooks/ses`. Nothing in a
 * report is believed until its SNS signature checks out against a certificate from an
 * `sns.<region>.amazonaws.com` address, for the configured topic. The workspace and delivery
 * come from the message's tags, which Relay set when sending; the SNS message id makes each
 * report count once.
 */
export type SnsEnvironment = {
  /** The SNS topic SES publishes to; reports from any other are refused. */
  topicArn: string;
  /** The public key in a signing certificate (cached). Tests pass their own. */
  certificate?: (url: string) => Promise<CryptoKey>;
  fetch?: typeof fetch;
};
type SnsMessage = {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  SubscribeURL?: string;
  Token?: string;
};
const CERT_URL = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\/[A-Za-z0-9_./-]+\.pem$/;
const SUBSCRIBE_URL = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\/\?/;

/* -- The certificate's key: the SubjectPublicKeyInfo inside an X.509 certificate (DER). -- */
function element(b: Uint8Array, at: number) {
  const tag = b[at];
  let len = b[at + 1];
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4) throw new Error("Unreadable certificate.");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[at + 2 + i];
    start += n;
  }
  if (start + len > b.length) throw new Error("Unreadable certificate.");
  return { tag, start, end: start + len };
}
/** The SubjectPublicKeyInfo of a DER certificate: tbsCertificate's seventh field (after the optional version). */
export function publicKeyInfo(cert: Uint8Array) {
  const outer = element(cert, 0);
  const tbs = element(cert, outer.start);
  let at = tbs.start;
  if (element(cert, at).tag === 0xa0) at = element(cert, at).end;
  // serialNumber, signature, issuer, validity, subject
  for (let i = 0; i < 5; i++) at = element(cert, at).end;
  const spki = element(cert, at);
  if (spki.tag !== 0x30) throw new Error("Unreadable certificate.");
  return cert.slice(at, spki.end);
}
const keys = new Map<string, Promise<CryptoKey>>();
function certificateKey(url: string, hash: "SHA-1" | "SHA-256", f: typeof fetch) {
  const k = url + hash;
  if (!keys.has(k))
    keys.set(
      k,
      (async () => {
        const r = await f(url);
        if (!r.ok) throw new Error("The signing certificate couldn't be fetched.");
        const pem = await r.text();
        const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
        const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return crypto.subtle.importKey("spki", publicKeyInfo(der), { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
      })().catch((e) => {
        keys.delete(k);
        throw e;
      }),
    );
  return keys.get(k)!;
}

/** What SNS signed: the fields, by name, in order (Subject only when present). */
export function stringToSign(m: SnsMessage) {
  const fields =
    m.Type === "Notification"
      ? ["Message", "MessageId", ...(m.Subject !== undefined ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return fields.map((f) => `${f}\n${String(m[f as keyof SnsMessage] ?? "")}\n`).join("");
}

export async function verifySns(m: SnsMessage, env: SnsEnvironment) {
  if (!env.topicArn || m.TopicArn !== env.topicArn) return false;
  if (!CERT_URL.test(m.SigningCertURL ?? "")) return false;
  const hash = m.SignatureVersion === "2" ? "SHA-256" : m.SignatureVersion === "1" ? "SHA-1" : null;
  if (!hash) return false;
  const key = env.certificate ? await env.certificate(m.SigningCertURL) : await certificateKey(m.SigningCertURL, hash, env.fetch ?? fetch);
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = Uint8Array.from(atob(m.Signature), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(stringToSign(m)));
}

/** SES's event (event publishing through a configuration set; the older notification shape too). */
type SesEvent = {
  eventType?: string;
  notificationType?: string;
  mail?: { messageId?: string; tags?: Record<string, string[]> };
  bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress?: string; diagnosticCode?: string }[] };
  complaint?: { complainedRecipients?: { emailAddress?: string }[]; complaintFeedbackType?: string };
};

/** One SES event, after its signature was checked: for its workspace's delivery, once. */
export async function applySesEvent(connect: Connect, eventId: string, e: SesEvent) {
  const kind = e.eventType ?? e.notificationType;
  const w = e.mail?.tags?.relay_workspace?.[0];
  const providerId = e.mail?.messageId;
  if (!w || !providerId || !/^[A-Za-z0-9_-]{1,100}$/.test(w)) return { applied: false, reason: "Not a Relay message." };
  if (!["Delivery", "Bounce", "Complaint"].includes(kind ?? "")) return { applied: false, reason: "Not a report Relay uses." };
  return tenant(connect, w, async (db) => {
    const d = (
      await db.query<{ id: string; address: string; domain: string | null }>(
        "SELECT id,address,domain FROM channel_deliveries WHERE workspace_id=$1 AND channel='email' AND provider_id=$2",
        [w, providerId],
      )
    ).rows[0];
    if (!d) return { applied: false, reason: "No such delivery." };
    const permanent = kind === "Bounce" && e.bounce?.bounceType === "Permanent";
    const eventKind = kind === "Delivery" ? "delivery" : kind === "Complaint" ? "complaint" : permanent ? "bounce" : "soft_bounce";
    const diagnostic = (e.bounce?.bouncedRecipients ?? []).find((r) => r.emailAddress?.toLowerCase() === d.address)?.diagnosticCode ?? "";
    const fresh = await db.query(
      "INSERT INTO email_events(workspace_id,id,delivery_id,domain,kind,detail) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id",
      [w, eventId, d.id, d.domain ?? "", eventKind, diagnostic.slice(0, 500)],
    );
    if (!fresh.rows.length) return { applied: false, reason: "Already applied." };
    if (eventKind === "delivery") await deliveryReport(db, w, "email", providerId, { status: "delivered" });
    else if (eventKind === "complaint")
      // Delivered, then marked as spam: nothing more is sent to the address.
      await suppress(db, w, "email", d.address, "complaint", `delivery:${d.id}`);
    else
      await deliveryReport(db, w, "email", providerId, {
        status: "failed",
        error: (permanent ? "It couldn't be delivered" : "It couldn't be delivered for now") + (diagnostic ? `: ${diagnostic}` : "."),
        ...(permanent ? { suppress: "hard_bounce" as const } : {}),
      });
    return { applied: true, workspace: w };
  });
}

/** `POST /v1/hooks/ses`: SNS's subscription confirmation, or a report. */
export async function receiveSesNotification(connect: Connect, env: SnsEnvironment, body: unknown) {
  const m = body as SnsMessage;
  if (!m || typeof m !== "object" || typeof m.Type !== "string" || typeof m.MessageId !== "string" || typeof m.Signature !== "string")
    return { status: 400, body: { error: "Not an SNS message." } };
  if (!(await verifySns(m, env))) return { status: 403, body: { error: "The signature doesn't check out." } };
  if (m.Type === "SubscriptionConfirmation") {
    if (!SUBSCRIBE_URL.test(m.SubscribeURL ?? "")) return { status: 400, body: { error: "Not an SNS address." } };
    const r = await (env.fetch ?? fetch)(m.SubscribeURL!);
    return { status: r.ok ? 200 : 502, body: { confirmed: r.ok } };
  }
  if (m.Type !== "Notification") return { status: 200, body: { ignored: true } };
  let event: SesEvent;
  try {
    event = JSON.parse(m.Message) as SesEvent;
  } catch {
    return { status: 200, body: { ignored: true } };
  }
  return { status: 200, body: await applySesEvent(connect, m.MessageId, event) };
}
