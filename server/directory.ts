import { tenant, type Connect, type Sql } from "./db";
import type { AppVersion } from "./app-versions";

/**
 * The app directory (docs/TEST_WORKSPACE_STEP6.md, T3b): what every workspace may browse, what
 * Relay's operators are asked to judge, and which apps are stopped everywhere.
 *
 * It lives in a tenant of its own, `__directory__`, the way schema migrations live in
 * `__schema__`: row-level security like every table, and no `workspace` row, so nothing that walks
 * workspaces finds it. A request reads or writes it in its own transaction, one tenant at a time,
 * never nested inside another workspace's.
 */
export const DIRECTORY = "__directory__";
export const inDirectory = <T>(connect: Connect, work: (db: Sql) => Promise<T>) => tenant(connect, DIRECTORY, work);

/** What the directory shows of an app, and what an operator judges: taken from one version. */
export type Card = {
  name: string;
  description: string;
  developer: string;
  clientId: string;
  version: number;
  scopes: string[];
  placements: string[];
  installUrl: string | null;
  /** Where it sends people or data: the hosts of its redirects, canvas and install addresses. */
  hosts: string[];
};
const hostOf = (u: string | null | undefined) => {
  try {
    return u ? new URL(u).host : null;
  } catch {
    return null;
  }
};
export function cardOf(v: AppVersion & { installUrl?: string | null }, developer: string, clientId: string): Card {
  const hosts = [...v.redirectUris.map(hostOf), hostOf(v.canvasUrl), hostOf(v.installUrl)].filter((h): h is string => !!h);
  return {
    name: v.name,
    description: v.description,
    developer,
    clientId,
    version: v.version,
    scopes: v.scopes,
    placements: v.canvasPlacements,
    installUrl: v.installUrl ?? null,
    hosts: [...new Set(hosts)].sort(),
  };
}

/**
 * Why a version needs review again, compared with the listed one, in words; empty when it doesn't.
 * It widens an app's reach when it asks for a permission, shows in a place, or sends people or data
 * to a host the listed version didn't, or when the listing's own words change.
 */
export function widensReach(listed: Card, next: Card): string[] {
  const out: string[] = [];
  const more = (a: string[], b: string[]) => b.filter((x) => !a.includes(x));
  for (const s of more(listed.scopes, next.scopes)) out.push(`It asks for a new permission: ${s}.`);
  for (const p of more(listed.placements, next.placements)) out.push(`It shows somewhere new: ${p}.`);
  for (const h of more(listed.hosts, next.hosts)) out.push(`It sends people or data to a new address: ${h}.`);
  if (listed.name !== next.name) out.push("Its name changes.");
  if (listed.description !== next.description) out.push("Its description changes.");
  return out;
}

export type Suspension = { reason: string; suspendedAt: string };
/** Whether Relay has stopped an app everywhere, and why. Read in the directory's own transaction. */
export async function suspensionOf(connect: Connect, appW: string, appId: string): Promise<Suspension | null> {
  return (await suspensionsOf(connect, [{ appW, appId }])).get(appW + "/" + appId) ?? null;
}
/** The same, for several apps at once (keyed `<workspace>/<app>`). */
export async function suspensionsOf(connect: Connect, apps: { appW: string; appId: string }[]) {
  const out = new Map<string, Suspension>();
  if (!apps.length) return out;
  const rows = await inDirectory(connect, async (db) =>
    (
      await db.query<{ app_workspace_id: string; app_id: string; reason: string; suspended_at: Date }>(
        `SELECT app_workspace_id,app_id,reason,suspended_at FROM app_suspensions
         WHERE workspace_id=$1 AND lifted_at IS NULL AND (app_workspace_id||'/'||app_id)=ANY($2::text[])`,
        [DIRECTORY, apps.map((a) => a.appW + "/" + a.appId)],
      )
    ).rows,
  );
  for (const r of rows) out.set(r.app_workspace_id + "/" + r.app_id, { reason: r.reason, suspendedAt: new Date(r.suspended_at).toISOString() });
  return out;
}

export type Listing = { appW: string; appId: string; card: Card; version: number; listedAt: string; delistedAt: string | null; delistedReason: string | null };
type ListingRow = { app_workspace_id: string; app_id: string; card: Card; version: number; listed_at: Date; delisted_at: Date | null; delisted_reason: string | null };
const listingOut = (r: ListingRow): Listing => ({
  appW: r.app_workspace_id,
  appId: r.app_id,
  card: r.card,
  version: r.version,
  listedAt: new Date(r.listed_at).toISOString(),
  delistedAt: r.delisted_at ? new Date(r.delisted_at).toISOString() : null,
  delistedReason: r.delisted_reason,
});
/** An app's listing, delisted or not, or null if it was never listed. */
export async function listingOf(db: Sql, appW: string, appId: string): Promise<Listing | null> {
  const r = (
    await db.query<ListingRow>(
      "SELECT app_workspace_id,app_id,card,version,listed_at,delisted_at,delisted_reason FROM app_listings WHERE workspace_id=$1 AND app_workspace_id=$2 AND app_id=$3",
      [DIRECTORY, appW, appId],
    )
  ).rows[0];
  return r ? listingOut(r) : null;
}

/** What the directory shows a workspace: listed apps that aren't delisted or suspended, by name. */
export async function readListings(connect: Connect) {
  return inDirectory(connect, async (db) =>
    (
      await db.query<ListingRow>(
        `SELECT l.app_workspace_id,l.app_id,l.card,l.version,l.listed_at,l.delisted_at,l.delisted_reason FROM app_listings l
         WHERE l.workspace_id=$1 AND l.delisted_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM app_suspensions s WHERE s.workspace_id=l.workspace_id AND s.app_workspace_id=l.app_workspace_id AND s.app_id=l.app_id AND s.lifted_at IS NULL)
         ORDER BY lower(l.card->>'name'),l.app_id`,
        [DIRECTORY],
      )
    ).rows.map(listingOut),
  );
}

export type Submission = {
  id: string;
  appW: string;
  appId: string;
  version: number;
  kind: "listing" | "version";
  card: Card;
  widens: string[];
  submittedAt: string;
  submittedBy: string | null;
  state: "pending" | "approved" | "rejected" | "withdrawn";
  decidedAt: string | null;
  decidedBy: string | null;
  reason: string | null;
};
type SubmissionRow = {
  id: string;
  app_workspace_id: string;
  app_id: string;
  version: number;
  kind: "listing" | "version";
  card: Card;
  widens: string[];
  submitted_at: Date;
  submitted_by_name: string | null;
  state: Submission["state"];
  decided_at: Date | null;
  decided_by: string | null;
  reason: string | null;
};
export const SUBMISSION = `SELECT id,app_workspace_id,app_id,version,kind,card,widens,submitted_at,submitted_by_name,state,decided_at,decided_by,reason FROM app_submissions`;
export const submissionOut = (r: SubmissionRow): Submission => ({
  id: r.id,
  appW: r.app_workspace_id,
  appId: r.app_id,
  version: r.version,
  kind: r.kind,
  card: r.card,
  widens: r.widens,
  submittedAt: new Date(r.submitted_at).toISOString(),
  submittedBy: r.submitted_by_name,
  state: r.state,
  decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
  decidedBy: r.decided_by,
  reason: r.reason,
});
export type { SubmissionRow };

/** A developer's apps as the directory knows them: each one's listing, submissions and suspension. */
export async function directoryStateFor(connect: Connect, appW: string) {
  return inDirectory(connect, async (db) => {
    const listings = (
      await db.query<ListingRow>("SELECT app_workspace_id,app_id,card,version,listed_at,delisted_at,delisted_reason FROM app_listings WHERE workspace_id=$1 AND app_workspace_id=$2", [DIRECTORY, appW])
    ).rows.map(listingOut);
    const submissions = (await db.query<SubmissionRow>(`${SUBMISSION} WHERE workspace_id=$1 AND app_workspace_id=$2 ORDER BY submitted_at DESC`, [DIRECTORY, appW])).rows.map(submissionOut);
    const suspended = (
      await db.query<{ app_id: string; reason: string }>("SELECT app_id,reason FROM app_suspensions WHERE workspace_id=$1 AND app_workspace_id=$2 AND lifted_at IS NULL", [DIRECTORY, appW])
    ).rows;
    const out: Record<string, { listing: Listing | null; submissions: Submission[]; suspended: string | null }> = {};
    const of = (id: string) => (out[id] ??= { listing: null, submissions: [], suspended: null });
    for (const l of listings) of(l.appId).listing = l;
    for (const s of submissions) of(s.appId).submissions.push(s);
    for (const s of suspended) of(s.app_id).suspended = s.reason;
    return out;
  });
}
