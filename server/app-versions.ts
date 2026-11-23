import type { Sql } from "./db";

/**
 * An app's versions, and which one an installation runs (docs/TEST_WORKSPACE_STEP5.md, T3a).
 *
 * Consent, tokens and Canvas all ask this module, so there is one answer to "what does this
 * installation run?":
 *
 * - **The sandbox** is the app's own workspace and that workspace's test pair. There, any
 *   published version may be installed and run; elsewhere, only released ones.
 * - **An installation** is pinned to the version a manager consented to. It runs the newest
 *   version it may see that asks for no scope its consented version didn't; a newer one that asks
 *   for more is *waiting* for a manager's approval.
 *
 * Every read here happens in the app's own workspace (its versions and its pair live there); the
 * caller decides which workspace is installing. Nothing is written: an installation that moves by
 * itself is worked out again on every read.
 */
export type AppVersion = {
  version: number;
  name: string;
  description: string;
  redirectUris: string[];
  scopes: string[];
  canvasUrl: string | null;
  canvasPlacements: string[];
  notes: string;
  publishedAt: string;
  releasedAt: string | null;
  /** T3b: the app's own page that starts the consent flow, where the directory sends people. */
  installUrl: string | null;
};
type Row = {
  version: number;
  name: string;
  description: string;
  redirect_uris: string[];
  scopes: string[];
  canvas_url: string | null;
  canvas_placements: string[];
  notes: string;
  published_at: Date;
  released_at: Date | null;
  install_url: string | null;
};

/** Every published version of an app, oldest first. Read in the app's workspace. */
export async function readVersions(db: Sql, appW: string, appId: string): Promise<AppVersion[]> {
  return (
    await db.query<Row>(
      `SELECT version,name,description,redirect_uris,scopes,canvas_url,canvas_placements,notes,published_at,released_at,install_url
       FROM oauth_app_versions WHERE workspace_id=$1 AND app_id=$2 ORDER BY version`,
      [appW, appId],
    )
  ).rows.map((r) => ({
    version: r.version,
    name: r.name,
    description: r.description,
    redirectUris: r.redirect_uris,
    scopes: r.scopes,
    canvasUrl: r.canvas_url,
    canvasPlacements: r.canvas_placements,
    notes: r.notes,
    publishedAt: new Date(r.published_at).toISOString(),
    releasedAt: r.released_at ? new Date(r.released_at).toISOString() : null,
    installUrl: r.install_url,
  }));
}

/** The workspaces an app is at home in: its own, and its test pair (either side). */
export async function sandboxOf(db: Sql, appW: string): Promise<string[]> {
  const r = (await db.query<{ test_of: string | null; test_workspace_id: string | null }>("SELECT test_of,test_workspace_id FROM workspace WHERE id=$1", [appW])).rows[0];
  return [appW, r?.test_of, r?.test_workspace_id].filter((x): x is string => !!x);
}

/** What a workspace may see of an app: every published version in the sandbox, released ones elsewhere. */
const visible = (versions: AppVersion[], home: boolean) => versions.filter((v) => home || v.releasedAt);
const newest = (vs: AppVersion[]) => (vs.length ? vs[vs.length - 1] : null);

/** The version a new installation gets: the newest it may see, or null (with why). */
export function installable(versions: AppVersion[], home: boolean): { version: AppVersion } | { refused: string } {
  if (!versions.length) return { refused: "This app has no published version yet. Its developer publishes one before anyone can install it." };
  const v = newest(visible(versions, home));
  if (!v)
    return {
      refused:
        "This app is still in development: only its developer's workspace and its test workspace can install it. Once a version is released, any workspace can.",
    };
  return { version: v };
}

export type Running = {
  /** What the installation runs now. */
  running: AppVersion;
  /** A newer version it may see that asks for more, waiting for a manager's approval. */
  waiting: AppVersion | null;
  /** The scopes the waiting version asks for beyond what runs now. */
  newScopes: string[];
};

/**
 * What an installation pinned to `pinned` runs. Null only when the app has no version this
 * installation could run (its versions were never published) — the caller treats that as no app.
 */
export function resolveRunning(versions: AppVersion[], home: boolean, pinned: number | null): Running | null {
  const consented = versions.find((v) => v.version === (pinned ?? 1));
  if (!consented) return null;
  const seen = visible(versions, home);
  const covered = seen.filter((v) => v.version >= consented.version && v.scopes.every((s) => consented.scopes.includes(s)));
  const running = newest(covered) ?? consented;
  const latest = newest(seen);
  const waiting = latest && latest.version > running.version ? latest : null;
  return { running, waiting, newScopes: waiting ? waiting.scopes.filter((s) => !running.scopes.includes(s)) : [] };
}
