import { DomainError, type Sql } from "./db";
import { enqueueJob } from "./jobs";
import { findLinks, normalize, policyDomain, within, type Policy } from "../lib/links";

/**
 * Link safety's parts that `append` and email in need (phase 16, step C7a; docs/SECURITY_STEP11.md),
 * apart from `server/links.ts` so they don't import the conversations module: the workspace's
 * policy, noting a customer part's links for the reputation lookup, and refusing a teammate's
 * link to a blocked domain.
 */
export async function linkPolicy(db: Sql, w: string): Promise<Policy> {
  const rows = (await db.query<{ domain: string; kind: "trusted" | "blocked" }>("SELECT domain,kind FROM link_policies WHERE workspace_id=$1", [w])).rows;
  // The workspace's own websites (each brand's allowed websites) are trusted by default.
  const origins = (await db.query<{ o: string }>("SELECT jsonb_array_elements_text(COALESCE(settings->'allowedOrigins','[]'::jsonb)) AS o FROM brands WHERE workspace_id=$1", [w])).rows;
  const own = [...new Set(origins.map((r) => policyDomain(r.o)).filter((d): d is string => !!d))];
  return { trusted: rows.filter((r) => r.kind === "trusted").map((r) => r.domain), blocked: rows.filter((r) => r.kind === "blocked").map((r) => r.domain), own };
}

/** Links in a customer's part, kept for the reputation lookup (`links.check`, queued once per part). */
export async function noteLinks(db: Sql, w: string, conversationId: string, partId: string, urls: string[]) {
  const unique = [...new Set(urls)].slice(0, 50);
  if (!unique.length) return;
  const added = (
    await db.query(
      "INSERT INTO part_links(workspace_id,part_id,conversation_id,url) SELECT $1,$2,$3,u FROM unnest($4::text[]) AS u ON CONFLICT DO NOTHING RETURNING url",
      [w, partId, conversationId, unique],
    )
  ).rows.length;
  if (added && !(await db.query("SELECT 1 FROM jobs WHERE workspace_id=$1 AND kind='links.check' AND state='queued' AND payload->>'partId'=$2", [w, partId])).rows.length)
    await enqueueJob(db, w, "links.check", { partId }, {});
}

/** The http(s) links in a rich document's link marks. */
export function docLinks(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== "object") return;
    const o = x as { type?: unknown; attrs?: { href?: unknown } };
    if (o.type === "link" && typeof o.attrs?.href === "string") {
      const u = normalize(o.attrs.href);
      if (u) out.push(u);
    }
    Object.values(o).forEach(walk);
  };
  walk(doc);
  return out;
}

/** A teammate's reply or note can't link to a blocked domain. */
export async function assertLinksAllowed(db: Sql, w: string, body: string, doc: unknown) {
  const urls = [...findLinks(body).map((l) => l.url), ...docLinks(doc)];
  if (!urls.length) return;
  const { blocked } = await linkPolicy(db, w);
  for (const url of urls) {
    const host = new URL(url).hostname.toLowerCase();
    if (blocked.some((d) => within(host, d))) throw new DomainError("LINK_BLOCKED", `Links to ${host} are blocked in this workspace. Remove the link to send.`, 400, { host });
  }
}
