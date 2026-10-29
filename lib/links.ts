/**
 * Link safety (phase 16, step C7a; docs/SECURITY_STEP11.md): finding links in customer text, the
 * checks made in code, and the one place a link's verdict is decided. Shared by the server (which
 * answers each click) and the inbox (which turns addresses into links).
 *
 * Verdicts, in order: `blocked` (on the workspace's blocked list: never opened), `malicious` (the
 * reputation lookup flagged it, or a check here did: opened only once a teammate acknowledges the
 * risk), `trusted` (on the trusted list or one of the workspace's own websites: opened at once) and
 * `untrusted` (everything else: shown in full for review first).
 */
export type Verdict = "trusted" | "untrusted" | "malicious" | "blocked";
export type Reason = "ip" | "lookalike" | "credentials" | "mismatch" | "download" | "reputation";
export const REASONS: Record<Reason, string> = {
  ip: "It goes to a bare IP address instead of a named website.",
  lookalike: "Its address uses lookalike (punycode) characters that can imitate another website.",
  credentials: "Its address includes a user name, a trick that hides where it really goes.",
  mismatch: "Its text names a different website from the one it opens.",
  download: "It downloads a program that could run on your computer.",
  reputation: "It's on a list of known phishing or malware addresses.",
};
export const MAX_LINKS = 20;
const EXECUTABLE = /\.(exe|scr|msi|bat|cmd|com|pif|vbs|vbe|js|jse|wsf|ps1|jar|apk|dmg|pkg|app|hta|lnk|iso|reg)$/i;

/** http(s) links in plain text (and `www.` addresses, as https), at most 20, each as written and as a URL. */
export function findLinks(text: string): { start: number; end: number; text: string; url: string }[] {
  const out: { start: number; end: number; text: string; url: string }[] = [];
  const re = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  for (const m of text.matchAll(re)) {
    // Trailing punctuation belongs to the sentence, not the address.
    const raw = m[0].replace(/[.,;:!?)\]}]+$/, "");
    const url = normalize(/^www\./i.test(raw) ? "https://" + raw : raw);
    if (url) out.push({ start: m.index!, end: m.index! + raw.length, text: raw, url });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/** The address as a canonical http(s) URL, or null. */
export function normalize(href: string): string | null {
  if (typeof href !== "string" || href.length > 2000) return null;
  try {
    const u = new URL(href.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** A domain as kept in a policy: lower case, no scheme, path or port; null when it isn't one. */
export function policyDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let v = value.trim().toLowerCase();
  if (!v) return null;
  try {
    if (/^[a-z]+:\/\//.test(v)) v = new URL(v).hostname;
  } catch {
    return null;
  }
  v = v.replace(/^\*\./, "").replace(/\.$/, "");
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v) && v.length <= 253 ? v : null;
}

/** Whether a host is a domain or one of its subdomains. */
export const within = (host: string, domain: string) => host === domain || host.endsWith("." + domain);

/** The checks made in code. `text` is what the link said, when it was an HTML anchor. */
export function codeReasons(url: string, text?: string): Reason[] {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const reasons: Reason[] = [];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) reasons.push("ip");
  if (host.split(".").some((label) => label.startsWith("xn--"))) reasons.push("lookalike");
  if (u.username || u.password) reasons.push("credentials");
  if (text) {
    // Link text that is itself an address (or a bare domain) naming somewhere else.
    const shown = text.trim().match(/^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?$/i)?.[1]?.toLowerCase();
    if (shown && !within(host, shown.replace(/^www\./, "")) && !within(shown, host.replace(/^www\./, ""))) reasons.push("mismatch");
  }
  if (EXECUTABLE.test(u.pathname)) reasons.push("download");
  return reasons;
}

export type Policy = { trusted: string[]; blocked: string[]; own: string[] };
/** The verdict for a link, from its checks, any reputation threat, and the workspace's policy. */
export function verdictOf(url: string, policy: Policy, found: { reasons: Reason[]; threat?: string | null }): { verdict: Verdict; host: string; reasons: Reason[] } {
  const host = new URL(url).hostname.toLowerCase();
  const reasons = [...found.reasons, ...(found.threat ? (["reputation"] as const) : [])];
  if (policy.blocked.some((d) => within(host, d))) return { verdict: "blocked", host, reasons };
  if (reasons.length) return { verdict: "malicious", host, reasons };
  if ([...policy.trusted, ...policy.own].some((d) => within(host, d))) return { verdict: "trusted", host, reasons };
  return { verdict: "untrusted", host, reasons };
}

const decode = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[e]!);
/** The http(s) anchors in cleaned email HTML (`server/email-html.ts`), with what each one says. */
export function anchorsIn(html: string): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = normalize(decode(m[1]));
    if (url) out.push({ url, text: decode(m[2].replace(/<[^>]*>/g, "")).trim() });
    if (out.length >= 200) break;
  }
  return out;
}
