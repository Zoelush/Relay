import { AwsClient } from "aws4fetch";

/**
 * Email's providers (phase 12, step E3; docs/OMNICHANNEL_STEP3.md), behind ports: the sender
 * (Amazon SES's v2 API, signed with `aws4fetch`) and DNS (DNS over HTTPS). Tests and the local
 * relay use stand-ins (`scripts/local-email.ts`); nothing here is called but through the email
 * adapter (`server/email-out.ts`) and the domain check.
 */
/** E4: `cc` and `bcc` are delivered to as well; only `cc` is written in the message's headers. */
export type RawEmail = { from: string; to: string; cc?: string[]; bcc?: string[]; raw: Uint8Array; tags: Record<string, string> };
export interface EmailSender {
  /** Sends a built message. Throws `EmailRejected` when retrying can't help; any other error is retried. */
  sendRaw(m: RawEmail): Promise<{ providerId: string }>;
  /** The provider's identity for a domain, created when missing: its DKIM tokens, and whether the provider has verified it. */
  identity(domain: string): Promise<{ dkimTokens: string[]; verified: boolean }>;
}
export class EmailRejected extends Error {}
export interface DnsResolver {
  /** The record's values (TXT strings joined; CNAME and MX targets without the final dot), or [] when there are none. */
  lookup(name: string, type: "TXT" | "CNAME" | "MX"): Promise<string[]>;
}

/** Amazon SES (v2), in one region, with a configuration set whose events go to SNS. */
export function sesSender(options: { region: string; accessKeyId: string; secretAccessKey: string; configurationSet?: string; fetch?: typeof fetch }): EmailSender {
  const aws = new AwsClient({ accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey, region: options.region, service: "ses" });
  const base = `https://email.${options.region}.amazonaws.com/v2/email`;
  const call = async (method: string, path: string, body?: unknown) => {
    const signed = await aws.sign(base + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const r = await (options.fetch ?? fetch)(signed);
    const text = await r.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    return { status: r.status, json, type: String(r.headers.get("x-amzn-errortype") ?? json.__type ?? "").split(":")[0] };
  };
  return {
    async sendRaw(m) {
      let s = "";
      for (let i = 0; i < m.raw.length; i += 0x8000) s += String.fromCharCode(...m.raw.subarray(i, i + 0x8000));
      const r = await call("POST", "/outbound-emails", {
        FromEmailAddress: m.from,
        Destination: { ToAddresses: [m.to], ...(m.cc?.length ? { CcAddresses: m.cc } : {}), ...(m.bcc?.length ? { BccAddresses: m.bcc } : {}) },
        Content: { Raw: { Data: btoa(s) } },
        EmailTags: Object.entries(m.tags).map(([Name, Value]) => ({ Name, Value })),
        ...(options.configurationSet ? { ConfigurationSetName: options.configurationSet } : {}),
      });
      if (r.status === 200) return { providerId: String(r.json.MessageId) };
      // A message SES won't take (rejected, an unverified sender, a suspended account) isn't retried.
      if (r.status >= 400 && r.status < 500 && r.status !== 429) throw new EmailRejected(`The provider refused it (${r.type || r.status}).`);
      throw new Error(`The provider didn't answer (${r.type || r.status}).`);
    },
    async identity(domain) {
      let r = await call("GET", `/identities/${encodeURIComponent(domain)}`);
      if (r.status === 404) {
        r = await call("POST", "/identities", { EmailIdentity: domain });
        if (r.status !== 200) throw new Error(`The provider didn't create the domain (${r.type || r.status}).`);
        // Bounces come back to the brand's own subdomain, so SPF aligns.
        await call("PUT", `/identities/${encodeURIComponent(domain)}/mail-from`, { MailFromDomain: `bounce.${domain}`, BehaviorOnMxFailure: "USE_DEFAULT_VALUE" });
      } else if (r.status !== 200) throw new Error(`The provider didn't answer (${r.type || r.status}).`);
      const dkim = (r.json.DkimAttributes ?? {}) as { Tokens?: string[] };
      return { dkimTokens: dkim.Tokens ?? [], verified: r.json.VerifiedForSendingStatus === true };
    },
  };
}

/** DNS over HTTPS (Cloudflare's resolver by default). */
export function dohResolver(options: { endpoint?: string; fetch?: typeof fetch } = {}): DnsResolver {
  const endpoint = options.endpoint ?? "https://cloudflare-dns.com/dns-query";
  const TYPES = { TXT: 16, CNAME: 5, MX: 15 };
  return {
    async lookup(name, type) {
      const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}`;
      const r = await (options.fetch ?? fetch)(url, { headers: { accept: "application/dns-json" } });
      if (!r.ok) throw new Error(`DNS didn't answer (${r.status}).`);
      const json = (await r.json()) as { Answer?: { type: number; data: string }[] };
      return (json.Answer ?? [])
        .filter((a) => a.type === TYPES[type])
        .map((a) =>
          type === "TXT"
            ? // "v=spf1 " "include:…" → one string.
              [...a.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1")).join("") || a.data
            : a.data.replace(/\.$/, "").toLowerCase(),
        );
    },
  };
}
