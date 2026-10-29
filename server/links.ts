import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { securityOn } from "./two-factor";
import { recordAudit } from "./audit";
import { access, conversation } from "./conversations";
import { linkPolicy } from "./link-policy";
import type { LinkReputation } from "./link-reputation";
import type { Job } from "./jobs";
import { anchorsIn, codeReasons, findLinks, normalize, policyDomain, REASONS, verdictOf } from "../lib/links";

/**
 * Link safety (phase 16, step C7a; docs/SECURITY_STEP11.md).
 *
 * - **Settings › Security › Links** (`security.manage`, behind `security_v1`): trusted and blocked
 *   domains; the workspace's own websites are trusted by default.
 * - **Each click** on a customer's link (in their text, or an email's HTML) asks `linkVerdict`, so a
 *   policy change applies at once. Only an address that's in that part is judged, for a teammate
 *   who can read the conversation; opening a malicious one needs an acknowledgement, and is audited.
 * - **`links.check`** looks a part's links up with the reputation port, between transactions.
 */
const MAX_DOMAINS = 200;

export async function readLinks(db: Sql, w: string, principal: string, lookup: string | null) {
  await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  const policy = await linkPolicy(db, w);
  return { trusted: policy.trusted.sort(), blocked: policy.blocked.sort(), own: policy.own.sort(), lookup };
}

export async function changeLinks(db: Sql, w: string, principal: string, p: Record<string, unknown>, lookup: string | null) {
  const me = await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  const domain = policyDomain(p.domain);
  if (!domain) throw new DomainError("INVALID_FIELD", "Enter a domain, like example.com.", 400, { field: "domain" });
  if (p.action === "add") {
    assert(p.kind === "trusted" || p.kind === "blocked", "INVALID_FIELD", "Choose trusted or blocked.");
    const count = Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM link_policies WHERE workspace_id=$1 AND kind=$2 AND domain<>$3", [w, p.kind, domain])).rows[0].n);
    assert(count < MAX_DOMAINS, "INVALID_FIELD", `Up to ${MAX_DOMAINS} ${p.kind} domains.`);
    // A domain is on one list: adding it to the other moves it.
    await db.query(
      "INSERT INTO link_policies(workspace_id,domain,kind,created_by) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,domain) DO UPDATE SET kind=EXCLUDED.kind WHERE link_policies.kind<>EXCLUDED.kind",
      [w, domain, p.kind, me.id],
    );
  } else if (p.action === "remove") {
    const r = await db.query("DELETE FROM link_policies WHERE workspace_id=$1 AND domain=$2 RETURNING domain", [w, domain]);
    assert(r.rows.length, "NOT_FOUND", "That domain isn't on either list.", 404);
  } else throw new DomainError("INVALID_LINKS", "Choose add or remove.");
  return readLinks(db, w, principal, lookup);
}

/** The links a part holds, with what each one says (an email's anchors name their text). */
async function partLinks(db: Sql, w: string, partId: string, body: string) {
  const links = new Map<string, string | undefined>();
  for (const l of findLinks(body)) links.set(l.url, undefined);
  const html = (await db.query<{ html: string | null }>("SELECT html FROM email_messages WHERE workspace_id=$1 AND part_id=$2", [w, partId])).rows[0]?.html;
  if (html) for (const a of anchorsIn(html)) links.set(a.url, a.text);
  return links;
}

/** A link's verdict for a teammate (GET), or opening it (POST: refused when blocked; acknowledged and audited when malicious). */
export async function linkVerdict(db: Sql, w: string, principal: string, p: { partId?: unknown; url?: unknown; open?: unknown; acknowledged?: unknown }) {
  const part = (
    await db.query<{ conversation_id: string; body: string }>("SELECT conversation_id,body FROM conversation_parts WHERE workspace_id=$1 AND id=$2", [w, String(p.partId ?? "")])
  ).rows[0];
  assert(part, "NOT_FOUND", "That message isn't there.", 404);
  const c = await conversation(db, w, part.conversation_id);
  await access(db, w, c, { type: "teammate", principal });
  const url = normalize(String(p.url ?? ""));
  const links = await partLinks(db, w, String(p.partId), part.body);
  assert(url && links.has(url), "NOT_FOUND", "That link isn't in this message.", 404);
  const threat = (await db.query<{ threat: string | null }>("SELECT threat FROM part_links WHERE workspace_id=$1 AND part_id=$2 AND url=$3", [w, String(p.partId), url])).rows[0]?.threat;
  const v = verdictOf(url!, await linkPolicy(db, w), { reasons: codeReasons(url!, links.get(url!)), threat });
  const result = { url: url!, host: v.host, verdict: v.verdict, reasons: v.reasons.map((id) => ({ id, text: REASONS[id] })) };
  if (p.open !== true) return result;
  if (v.verdict === "blocked") throw new DomainError("LINK_BLOCKED", `Links to ${v.host} are blocked in this workspace.`, 403);
  if (v.verdict === "malicious") {
    assert(p.acknowledged === true, "ACKNOWLEDGE_REQUIRED", "Confirm you understand the risk before opening this link.", 409);
    await recordAudit(db, w, "link.opened_despite_warning", { type: "conversation", id: c.id }, { host: v.host, reasons: v.reasons });
  }
  return result;
}

/** `links.check`: a part's links looked up for known threats (the lookup runs outside any transaction). */
export async function linksJob(connect: Connect, env: { reputation?: LinkReputation }, job: Job) {
  const w = job.workspace_id;
  const partId = String((job.payload as { partId?: string }).partId ?? "");
  const urls = (await tenant(connect, w, (db) => db.query<{ url: string }>("SELECT url FROM part_links WHERE workspace_id=$1 AND part_id=$2 AND checked_at IS NULL", [w, partId]))).rows.map(
    (r) => r.url,
  );
  if (!urls.length) return { done: true, result: { checked: 0 } };
  if (!env.reputation) return { done: true, result: { skipped: "No reputation lookup." } };
  const found = await env.reputation.check(urls);
  await tenant(connect, w, (db) =>
    db.query(
      "UPDATE part_links p SET threat=x.threat,checked_at=now() FROM jsonb_to_recordset($3::jsonb) AS x(url text,threat text) WHERE p.workspace_id=$1 AND p.part_id=$2 AND p.url=x.url",
      [w, partId, JSON.stringify(urls.map((url) => ({ url, threat: found[url] ?? null })))],
    ),
  );
  return { done: true, result: { checked: urls.length, flagged: Object.keys(found).length } };
}
