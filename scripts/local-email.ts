import PostalMime from "postal-mime";
import { EmailRejected, type DnsResolver, type EmailSender, type RawEmail } from "../server/email-providers";

/**
 * Email's stand-in providers (phase 12, step E3), for tests and the local relay: a sender that
 * keeps what it's given (the outbox) and a DNS zone records are published to. Nothing leaves the
 * machine. `refuse` makes the sender reject an address (as SES rejects a message), `fail` makes it
 * throw as if the provider were down.
 */
export type SentEmail = RawEmail & { providerId: string; at: string };
export function localEmailProvider() {
  const outbox: SentEmail[] = [];
  const zone = new Map<string, string[]>();
  const refuse = new Set<string>();
  const state = { fail: false, verified: true };
  const key = (name: string, type: string) => `${type} ${name.toLowerCase().replace(/\.$/, "")}`;
  const sender: EmailSender = {
    async sendRaw(m) {
      if (state.fail) throw new Error("The stand-in provider is down.");
      if (refuse.has(m.to)) throw new EmailRejected("The provider refused it (MessageRejected).");
      const providerId = "local-" + crypto.randomUUID();
      outbox.push({ ...m, providerId, at: new Date().toISOString() });
      return { providerId };
    },
    async identity(domain) {
      // Three DKIM tokens of its own per domain, as SES gives.
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(domain.toLowerCase())));
      const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
      return { dkimTokens: [hex.slice(0, 32), hex.slice(16, 48), hex.slice(32, 64)], verified: state.verified };
    },
  };
  const dns: DnsResolver = {
    async lookup(name, type) {
      return zone.get(key(name, type)) ?? [];
    },
  };
  return {
    sender,
    dns,
    outbox,
    refuse,
    state,
    /** A record, as a domain's owner would add it (`value` replaces what was there). */
    publish(name: string, type: "TXT" | "CNAME" | "MX", value: string | string[]) {
      zone.set(key(name, type), Array.isArray(value) ? value : [value]);
    },
    unpublish(name: string, type: "TXT" | "CNAME" | "MX") {
      zone.delete(key(name, type));
    },
    /** Every record a domain's check asked for, published as asked. */
    publishAll(records: { name: string; type: "TXT" | "CNAME" | "MX"; value: string }[]) {
      for (const r of records) this.publish(r.name, r.type, r.type === "MX" ? r.value.split(" ")[1] : r.value);
    },
    /** A sent email, read back. */
    async read(m: SentEmail) {
      const e = await PostalMime.parse(m.raw);
      return {
        from: e.from?.address ?? "",
        fromName: e.from?.name ?? "",
        to: m.to,
        replyTo: e.replyTo?.[0]?.address ?? "",
        subject: e.subject ?? "",
        messageId: e.messageId ?? "",
        inReplyTo: e.inReplyTo ?? "",
        references: e.references ?? "",
        text: (e.text ?? "").replace(/\r\n/g, "\n"),
        html: e.html ?? "",
        attachments: e.attachments.map((a) => ({ name: a.filename ?? "", mime: a.mimeType, size: typeof a.content === "string" ? a.content.length : a.content.byteLength })),
        headers: Object.fromEntries(e.headers.map((h) => [h.key, h.value])),
        tags: m.tags,
        providerId: m.providerId,
      };
    },
  };
}
export type LocalEmailProvider = ReturnType<typeof localEmailProvider>;

/**
 * A stand-in for SNS's signing (tests and the local relay): its own key pair, a certificate
 * lookup that returns its public key, and notifications signed as SNS signs them, so reports go
 * through `/v1/hooks/ses` and its signature check, not around it.
 */
export async function localSns(topicArn = "arn:aws:sns:eu-west-2:000000000000:relay-ses") {
  const { stringToSign } = await import("../server/email-sns");
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const certUrl = "https://sns.eu-west-2.amazonaws.com/SimpleNotificationService-local.pem";
  const sign = async (m: Record<string, string>) => {
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(stringToSign(m as never))));
    return { ...m, Signature: btoa(String.fromCharCode(...signature)) };
  };
  return {
    topicArn,
    /** The environment `/v1/hooks/ses` checks against. */
    environment: { topicArn, certificate: async (url: string) => (url === certUrl ? pair.publicKey : Promise.reject(new Error("Unknown certificate."))) },
    /** SES's event as SNS would post it. */
    notification: (event: unknown, id = crypto.randomUUID()) =>
      sign({
        Type: "Notification",
        MessageId: id,
        TopicArn: topicArn,
        Message: JSON.stringify(event),
        Timestamp: new Date().toISOString(),
        SignatureVersion: "2",
        SigningCertURL: certUrl,
      }),
  };
}
/** SES's event for a sent email (as event publishing writes it). */
export function sesEvent(kind: "Delivery" | "Bounce" | "Complaint", sent: { providerId: string; tags: Record<string, string>; to: string }, permanent = true) {
  return {
    eventType: kind,
    mail: { messageId: sent.providerId, tags: Object.fromEntries(Object.entries(sent.tags).map(([k, v]) => [k, [v]])) },
    ...(kind === "Bounce"
      ? { bounce: { bounceType: permanent ? "Permanent" : "Transient", bouncedRecipients: [{ emailAddress: sent.to, diagnosticCode: "smtp; 550 5.1.1 user unknown" }] } }
      : {}),
    ...(kind === "Complaint" ? { complaint: { complainedRecipients: [{ emailAddress: sent.to }], complaintFeedbackType: "abuse" } } : {}),
  };
}
