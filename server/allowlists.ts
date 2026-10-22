import { DomainError, type Sql } from "./db";

/**
 * IP allowlists (phase 16, step C3b; docs/SECURITY_STEP4.md): one for the app (the inbox, Settings
 * and signing in) and one for the REST API, each up to 100 addresses or CIDR ranges, IPv4 or IPv6,
 * kept as PostgreSQL `cidr[]` and matched there (`<<=`). An empty list means anywhere. A list with
 * no address to check against refuses: an unknown address is never let through.
 */
export type Allowlist = "app" | "api";
const MAX = 100;
const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const V6 = /^[0-9a-f:.]{2,45}$/i;

/** An address as PostgreSQL compares it: IPv4-mapped IPv6 (a Node socket's `::ffff:…`) as IPv4. */
export function normalIp(ip: string | null | undefined) {
  if (!ip) return null;
  const v = ip.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  return V4.test(v) || (v.includes(":") && V6.test(v)) ? v : null;
}

/** Entries as typed (one per line or comma): each an address or a range, or an error naming it. */
export function readAllowlist(value: unknown, field: string) {
  const entries = (Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/[\s,]+/) : []).map((s) => s.trim()).filter(Boolean);
  if (entries.length > MAX) throw new DomainError("INVALID_FIELD", `Each list holds up to ${MAX} addresses or ranges.`, 400, { field });
  for (const e of entries) {
    const [ip, bits, extra] = e.split("/");
    const v4 = V4.test(ip);
    const v6 = !v4 && ip.includes(":") && V6.test(ip);
    const max = v4 ? 32 : 128;
    if (extra !== undefined || (!v4 && !v6) || (bits !== undefined && (!/^\d{1,3}$/.test(bits) || Number(bits) > max)))
      throw new DomainError("INVALID_FIELD", `"${e.slice(0, 60)}" isn't an IP address or a range like 203.0.113.0/24.`, 400, { field });
  }
  return entries;
}

/** The entries as ranges (host bits cleared, duplicates dropped), in PostgreSQL's own words. */
export async function normalAllowlist(db: Sql, entries: string[], field: string) {
  try {
    return (await db.query<{ r: string[] }>("SELECT COALESCE(array_agg(DISTINCT network(e::inet)::text),'{}') AS r FROM unnest($1::text[]) e", [entries])).rows[0].r;
  } catch {
    throw new DomainError("INVALID_FIELD", "One of those isn't an IP address or a range.", 400, { field });
  }
}

/** Whether a request from `ip` may use this workspace's app or API. */
export async function networkAllowed(db: Sql, w: string, which: Allowlist, ip: string | null | undefined) {
  const list = (await db.query<{ n: number }>(`SELECT cardinality(${which}_allowlist) AS n FROM security_settings WHERE workspace_id=$1`, [w])).rows[0];
  if (!list || !list.n) return true;
  const address = normalIp(ip);
  if (!address) return false;
  return (await db.query(`SELECT 1 FROM security_settings WHERE workspace_id=$1 AND $2::inet <<= ANY(${which}_allowlist)`, [w, address])).rows.length > 0;
}

export const notAllowed = (ip: string | null | undefined) =>
  new DomainError(
    "NETWORK_NOT_ALLOWED",
    `Relay isn't available from this network${normalIp(ip) ? ` (${normalIp(ip)})` : ""}. Ask someone who manages security to add it.`,
    403,
  );

/** Refuses a request from outside the list. */
export async function assertNetwork(db: Sql, w: string, which: Allowlist, ip: string | null | undefined) {
  if (!(await networkAllowed(db, w, which, ip))) throw notAllowed(ip);
}
