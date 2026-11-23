import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize, can, capabilities, type Capability } from "./policy";
import { developerOn } from "./developer";
import { mintToken, sha256 } from "./rest";
import { LATEST_VERSION } from "../lib/api-spec";
import { CANVAS_COLUMNS, canvasOut, rotateCanvasSecret, setCanvas, type CanvasColumns, type CanvasEnvironment } from "./canvas";
import { installable, readVersions, resolveRunning, sandboxOf, type AppVersion } from "./app-versions";
import { recordAudit } from "./audit";
import { cardOf, DIRECTORY, inDirectory, listingOf, readListings, suspensionOf, suspensionsOf, widensReach, type Card, type Suspension } from "./directory";
import { enqueueJob } from "./jobs";

/**
 * OAuth apps (phase 15, step D4; docs/DEVELOPER_PLATFORM_STEP4.md), behind `developer_api_v1`.
 *
 * - **Registering:** a developer registers an app in their workspace: its name, redirect addresses
 *   (https, or http on loopback for local tools) and the scopes it may ask for (capabilities). Its
 *   client id carries that workspace (`relay_app_<workspace>_<id>`); its secret is shown once.
 * - **Installing:** `/oauth/authorize` (the authorization code flow, PKCE S256 required) shows a
 *   consent screen in Relay listing exactly what's asked. Only who manages the workspace may
 *   approve; the app gets what it asked for that the approver also has, and acts as them.
 * - **Tokens:** `POST /oauth/token` exchanges a code (once, within 10 minutes, with its verifier
 *   and the same redirect) for an access token (an API token, for an hour) and a refresh token (60
 *   days). Refresh tokens rotate; one used twice revokes the installation (it was stolen). A code
 *   used twice does the same. `POST /oauth/revoke` and Settings › Developers › Apps revoke.
 * - **Versions and the sandbox** (T3a, docs/TEST_WORKSPACE_STEP5.md): the app row is the draft;
 *   what anyone installs and runs is a published version, decided by `server/app-versions.ts`.
 *   Until a version is released, only the app's own workspace and its test pair can install it.
 */
const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => {
  try {
    return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
};
const random = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");
/** `<prefix>_<workspace>_<secret>`: the workspace to look it up in, or null. */
const workspaceOf = (prefix: string, token: unknown) => {
  const m = typeof token === "string" ? new RegExp(`^${prefix}_([A-Za-z0-9_-]{2,140})_([A-Za-z0-9]{20,60})$`).exec(token) : null;
  return m ? { w: unb64(m[1]), id: m[2] } : null;
};
const CODE_MS = 10 * 60_000;
const ACCESS_SECONDS = 3600;
const REFRESH_MS = 60 * 86_400_000;
const field = (f: string, message: string) => new DomainError("INVALID_FIELD", message, 400, { field: f });

/** Where an app may send people back: https, or http on this machine (RFC 8252's loopback). */
export function checkRedirect(raw: unknown) {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw field("redirect_uris", "Each redirect is a full address.");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.hash || u.username || u.password || !(u.protocol === "https:" || (u.protocol === "http:" && loopback)))
    throw field("redirect_uris", "Redirects use https (or http on 127.0.0.1 or localhost), without a #fragment.");
  return u.toString();
}
/** An app's install page (T3b): where the directory sends people who press Install. */
function checkInstallUrl(raw: unknown) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  try {
    return checkRedirect(s);
  } catch {
    throw field("install_url", "The install address is a full https address (or http on 127.0.0.1 or localhost), without a #fragment.");
  }
}
function checkScopes(raw: unknown, f = "scopes") {
  const s = Array.isArray(raw) ? [...new Set(raw.map(String))] : [];
  if (!s.length) throw field(f, "Choose at least one scope.");
  const bad = s.find((x) => !capabilities.includes(x as Capability));
  if (bad) throw field(f, `There's no scope ${bad}.`);
  return s;
}

/* ------------------------------------------------------------------------------------------ */
/* Apps, in their developer's workspace                                                        */
/* ------------------------------------------------------------------------------------------ */
type AppRow = {
  id: string;
  name: string;
  description: string;
  redirect_uris: string[];
  scopes: string[];
  secret_last_four: string;
  created_at: Date;
  archived_at: Date | null;
  install_url: string | null;
  listed_card: Card | null;
} & CanvasColumns;
/**
 * Built when first used, never while this module loads: canvas.ts sits on an import cycle through
 * api.ts, and whichever of the two loads first must not read the other's exports at the top.
 */
const APP_SELECT = () => `SELECT id,name,description,redirect_uris,scopes,secret_last_four,created_at,archived_at,install_url,listed_card,${CANVAS_COLUMNS} FROM oauth_apps`;
const clientId = (w: string, id: string) => `relay_app_${b64(w)}_${id}`;
/** An app's workspace and id from its client id, or null. */
export const parseClientId = (client: unknown) => {
  const r = workspaceOf("relay_app", client);
  return r?.w ? { w: r.w, id: r.id } : null;
};
const appOut = (w: string, a: AppRow, secret?: string, canvasSecret?: string) => ({
  id: a.id,
  clientId: clientId(w, a.id),
  name: a.name,
  description: a.description,
  redirectUris: a.redirect_uris,
  scopes: a.scopes,
  secretLastFour: a.secret_last_four,
  createdAt: a.created_at.toISOString(),
  archived: !!a.archived_at,
  installUrl: a.install_url,
  listed: !!a.listed_card,
  ...canvasOut(a),
  ...(secret ? { clientSecret: secret } : {}),
  ...(canvasSecret ? { canvasSecret } : {}),
});
async function managing(db: Sql, w: string, principal: string) {
  const t = await authorize(db, w, principal, "workspace.manage");
  assert(await developerOn(db, w), "NOT_FOUND", "The API isn't enabled for this workspace.", 404);
  return t;
}

/** Settings › Developers › Apps: your apps, and the apps installed here. */
export async function readApps(db: Sql, w: string, principal: string) {
  await managing(db, w, principal);
  const apps = [];
  for (const a of (await db.query<AppRow>(`${APP_SELECT()} WHERE workspace_id=$1 ORDER BY archived_at IS NOT NULL,created_at,id`, [w])).rows)
    apps.push({ ...appOut(w, a), versions: await readVersions(db, w, a.id) });
  const installed = (
    await db.query<{ id: string; app_name: string; scopes: string[]; teammate: string; created_at: Date; last_used: Date | null }>(
      `SELECT g.id,g.app_name,g.scopes,t.name AS teammate,g.created_at,(SELECT max(k.last_used_at) FROM api_tokens k WHERE k.workspace_id=g.workspace_id AND k.grant_id=g.id) AS last_used
       FROM oauth_grants g JOIN teammates t ON t.workspace_id=g.workspace_id AND t.id=g.teammate_id WHERE g.workspace_id=$1 AND g.revoked_at IS NULL ORDER BY g.created_at`,
      [w],
    )
  ).rows.map((g) => ({ id: g.id, appName: g.app_name, scopes: g.scopes, grantedBy: g.teammate, grantedAt: g.created_at.toISOString(), lastUsedAt: g.last_used ? new Date(g.last_used).toISOString() : null }));
  return { apps, installed, scopes: capabilities };
}

export async function changeApps(db: Sql, w: string, principal: string, p: Record<string, unknown>, canvas?: CanvasEnvironment) {
  const t = await managing(db, w, principal);
  const app = async (id: unknown) => {
    const a = (await db.query<AppRow>(`${APP_SELECT()} WHERE workspace_id=$1 AND id=$2`, [w, String(id ?? "")])).rows[0];
    assert(a, "NOT_FOUND", "No such app.", 404);
    return a;
  };
  const name = (v: unknown) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s || s.length > 60) throw field("name", "Name the app (up to 60 characters).");
    return s;
  };
  const redirects = (v: unknown) => {
    const list = Array.isArray(v) ? v : [];
    if (!list.length || list.length > 10) throw field("redirect_uris", "Give 1 to 10 redirect addresses.");
    return [...new Set(list.map(checkRedirect))];
  };
  switch (p.action) {
    case "create": {
      const id = random(24);
      const secret = "relay_cs_" + random(40);
      await db.query("INSERT INTO oauth_apps(workspace_id,id,name,description,redirect_uris,scopes,secret_hash,secret_last_four,created_by,install_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [
        w,
        id,
        name(p.name),
        String(p.description ?? "").slice(0, 300),
        redirects(p.redirectUris),
        checkScopes(p.scopes),
        await sha256(secret),
        secret.slice(-4),
        t.id,
        checkInstallUrl(p.installUrl),
      ]);
      // D5: its canvas address and placements, if given (the canvas secret is shown once too).
      const canvasSecret = await setCanvas(db, w, id, canvas, p);
      // T3a: version 1 is published at once, so the app can be tried in the sandbox straight away.
      await publishVersion(db, w, id, t.id, "");
      return { ...appOut(w, await app(id), secret, canvasSecret), versions: await readVersions(db, w, id) };
    }
    case "update": {
      const a = await app(p.id);
      await db.query("UPDATE oauth_apps SET name=$3,description=$4,redirect_uris=$5,scopes=$6,install_url=$7,updated_at=now() WHERE workspace_id=$1 AND id=$2", [
        w,
        a.id,
        p.name === undefined ? a.name : name(p.name),
        p.description === undefined ? a.description : String(p.description).slice(0, 300),
        p.redirectUris === undefined ? a.redirect_uris : redirects(p.redirectUris),
        p.scopes === undefined ? a.scopes : checkScopes(p.scopes),
        p.installUrl === undefined ? a.install_url : checkInstallUrl(p.installUrl),
      ]);
      const canvasSecret = await setCanvas(db, w, a.id, canvas, p);
      return appOut(w, await app(a.id), undefined, canvasSecret);
    }
    case "secret": {
      const a = await app(p.id);
      const secret = "relay_cs_" + random(40);
      await db.query("UPDATE oauth_apps SET secret_hash=$3,secret_last_four=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, a.id, await sha256(secret), secret.slice(-4)]);
      return appOut(w, await app(a.id), secret);
    }
    case "canvas-secret": {
      // D5: a new canvas signing secret (the previous one signs too for 24 hours).
      const a = await app(p.id);
      const canvasSecret = await rotateCanvasSecret(db, w, a.id, canvas);
      return appOut(w, await app(a.id), undefined, canvasSecret);
    }
    case "archive": {
      const a = await app(p.id);
      // No new installations or refreshes; tokens already issued expire within the hour.
      await db.query("UPDATE oauth_apps SET archived_at=COALESCE(archived_at,now()) WHERE workspace_id=$1 AND id=$2", [w, a.id]);
      return appOut(w, await app(a.id));
    }
    case "publish": {
      // T3a: the draft as it is now becomes the next version: installable in the sandbox at once.
      const a = await app(p.id);
      assert(!a.archived_at, "APP_ARCHIVED", "This app is archived.", 409);
      const notes = typeof p.notes === "string" ? p.notes.trim() : "";
      if (notes.length > 500) throw field("notes", "Keep what changed to 500 characters.");
      const version = await publishVersion(db, w, a.id, t.id, notes);
      return { ...appOut(w, await app(a.id)), versions: await readVersions(db, w, a.id), published: version };
    }
    case "release": {
      // T3a: a published version, installable beyond the sandbox from now on. Once, and for good.
      const a = await app(p.id);
      assert(!a.archived_at, "APP_ARCHIVED", "This app is archived.", 409);
      const v = (await db.query<{ released_at: Date | null; name: string }>("SELECT released_at,name FROM oauth_app_versions WHERE workspace_id=$1 AND app_id=$2 AND version=$3 FOR UPDATE", [w, a.id, Number(p.version)])).rows[0];
      assert(v, "NOT_FOUND", "No such version.", 404);
      assert(!v.released_at, "ALREADY_RELEASED", "That version is already released.", 409);
      // T3b: a listed app's version that widens its reach isn't released here: it goes to review.
      // Compared with the card an operator approved, kept on this row, so this holds whichever way
      // a release arrives; the route turns the answer into a submission.
      const card = await versionCard(db, w, a.id, Number(p.version));
      const widens = a.listed_card ? widensReach(a.listed_card, card) : [];
      if (widens.length) return { ...appOut(w, a), versions: await readVersions(db, w, a.id), review: { card, widens } };
      await releaseVersion(db, w, a.id, Number(p.version), t.id, v.name);
      return { ...appOut(w, await app(a.id)), versions: await readVersions(db, w, a.id), ...(a.listed_card ? { listedCard: card } : {}) };
    }
    case "submit": {
      // T3b: a version asked to be listed in the directory. Checked here; the route records it there.
      const a = await app(p.id);
      assert(!a.archived_at, "APP_ARCHIVED", "This app is archived.", 409);
      const card = await versionCard(db, w, a.id, Number(p.version));
      assert(card.installUrl, "INVALID_FIELD", "Give this version an install address first: it's where the directory sends people who press Install.", 400);
      return { ...appOut(w, a), versions: await readVersions(db, w, a.id), review: { card, widens: [] as string[] } };
    }
    case "uninstall": {
      // An installation here, revoked: its tokens stop at once.
      const g = (await db.query<{ id: string }>("SELECT id FROM oauth_grants WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL", [w, String(p.id ?? "")])).rows[0];
      assert(g, "NOT_FOUND", "No such installed app.", 404);
      await revokeGrant(db, w, g.id, "Uninstalled by a teammate.");
      // T3b: the app is told, so it can delete what it holds about this workspace. A job, after
      // this commits: a notice that fails is retried a few times and never blocks the uninstall.
      await enqueueJob(db, w, "app.uninstalled", { grantId: g.id }, { teammateId: t.id });
      return { ok: true };
    }
  }
  throw new DomainError("INVALID_APP", "Choose create, update, publish, release, submit, secret, canvas-secret, archive or uninstall.");
}

/** A version's card: what the directory would show of it, and what an operator judges. */
async function versionCard(db: Sql, w: string, appId: string, version: number): Promise<Card> {
  const v = (await readVersions(db, w, appId)).find((x) => x.version === version);
  assert(v, "NOT_FOUND", "No such version.", 404);
  const developer = (await db.query<{ brand: string }>("SELECT brand FROM workspace WHERE id=$1", [w])).rows[0]?.brand ?? w;
  return cardOf(v!, developer, clientId(w, appId));
}

/** A version released: installable beyond the sandbox from now on. Recorded in the audit log. */
export async function releaseVersion(db: Sql, w: string, appId: string, version: number, by: string | null, name: string) {
  await db.query("UPDATE oauth_app_versions SET released_at=now(),released_by=$4 WHERE workspace_id=$1 AND app_id=$2 AND version=$3 AND released_at IS NULL", [w, appId, version, by]);
  await recordAudit(db, w, "app_version.released", { type: "app", id: `${appId}:${version}`, name }, { version });
}

/** The draft as it is now, kept as the app's next version. Returns its number. */
async function publishVersion(db: Sql, w: string, appId: string, by: string, notes: string) {
  const next = ((await db.query<{ n: number | null }>("SELECT max(version) AS n FROM oauth_app_versions WHERE workspace_id=$1 AND app_id=$2", [w, appId])).rows[0].n ?? 0) + 1;
  await db.query(
    `INSERT INTO oauth_app_versions(workspace_id,app_id,version,name,description,redirect_uris,scopes,canvas_url,canvas_placements,notes,published_by,install_url)
     SELECT workspace_id,id,$3,name,description,redirect_uris,scopes,canvas_url,canvas_placements,$4,$5,install_url FROM oauth_apps WHERE workspace_id=$1 AND id=$2`,
    [w, appId, next, notes, by],
  );
  return next;
}

/** An installation and everything it issued, revoked; its open cards and saved settings gone (T3b). */
async function revokeGrant(db: Sql, w: string, grantId: string, reason: string) {
  await db.query(
    "UPDATE oauth_grants SET revoked_at=COALESCE(revoked_at,now()),revoked_reason=COALESCE(revoked_reason,$3),canvas_settings=NULL,configured_at=NULL WHERE workspace_id=$1 AND id=$2",
    [w, grantId, reason],
  );
  await db.query("DELETE FROM canvas_sessions WHERE workspace_id=$1 AND grant_id=$2", [w, grantId]);
  await db.query("UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE workspace_id=$1 AND grant_id=$2", [w, grantId]);
  await db.query("UPDATE oauth_refresh_tokens SET used_at=COALESCE(used_at,now()) WHERE workspace_id=$1 AND grant_id=$2", [w, grantId]);
}

/** An app by its client id, read in its own workspace; with its secret checked when one is given. */
async function appByClient(connect: Connect, client: unknown, secret?: unknown) {
  const parsed = workspaceOf("relay_app", client);
  if (!parsed?.w) return null;
  return tenant(connect, parsed.w, async (db) => {
    const a = (await db.query<AppRow & { secret_hash: string }>(`SELECT id,name,description,redirect_uris,scopes,secret_last_four,created_at,archived_at,secret_hash FROM oauth_apps WHERE workspace_id=$1 AND id=$2`, [parsed.w, parsed.id])).rows[0];
    if (!a || a.archived_at) return null;
    if (secret !== undefined && (typeof secret !== "string" || (await sha256(secret)) !== a.secret_hash)) return null;
    const developer = (await db.query<{ name: string }>("SELECT brand AS name FROM workspace WHERE id=$1", [parsed.w])).rows[0]?.name ?? parsed.w;
    // T3a: its versions, and the workspaces it's at home in (its own and its test pair).
    return { w: parsed.w!, app: a, developer, versions: await readVersions(db, parsed.w!, a.id), sandbox: await sandboxOf(db, parsed.w!) };
  })
    .then(async (found) => (found ? { ...found, suspended: (await suspensionOf(connect, found.w, found.app.id)) as Suspension | null } : null))
    .catch(() => null);
}

/* ------------------------------------------------------------------------------------------ */
/* Consent, in the installing workspace                                                         */
/* ------------------------------------------------------------------------------------------ */
export type AuthorizeQuery = { client_id?: string; redirect_uri?: string; scope?: string; state?: string; code_challenge?: string; code_challenge_method?: string; response_type?: string };
/** What the consent screen shows; refusals here are shown on the page, never sent to the redirect. */
export async function readConsent(connect: Connect, w: string, principal: string, q: AuthorizeQuery) {
  const found = await appByClient(connect, q.client_id);
  assert(found, "INVALID_CLIENT", "This app isn't registered with Relay (or was archived).", 400);
  const { developer } = found!;
  // T3b: an app Relay has suspended installs nowhere.
  if (found!.suspended) throw new DomainError("APP_SUSPENDED", `Relay has suspended this app: ${found!.suspended.reason}`, 403);
  // T3a: what is installed is a published version — the newest this workspace may see.
  const choice = installable(found!.versions, found!.sandbox.includes(w));
  if ("refused" in choice) throw new DomainError("APP_NOT_INSTALLABLE", choice.refused, 403);
  const app = choice.version;
  assert(q.redirect_uri && app.redirectUris.includes(q.redirect_uri), "INVALID_REDIRECT", "This app didn't register that redirect address, so Relay won't send you there.", 400);
  assert(q.response_type === "code", "INVALID_REQUEST", "Only the authorization code flow is supported (response_type=code).", 400);
  assert(q.code_challenge && /^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge) && q.code_challenge_method === "S256", "INVALID_REQUEST", "The app must use PKCE (code_challenge with S256).", 400);
  const asked = q.scope ? [...new Set(q.scope.split(/[\s,]+/).filter(Boolean))] : app.scopes;
  const beyond = asked.filter((s) => !app.scopes.includes(s));
  assert(!beyond.length, "INVALID_SCOPE", `This app didn't register the scope ${beyond[0]}.`, 400);
  return tenant(connect, w, async (db) => {
    await authorize(db, w, principal, "workspace.manage").catch(() => {
      throw new DomainError("FORBIDDEN", "Only someone who manages this workspace can install apps.", 403);
    });
    assert(await developerOn(db, w), "NOT_FOUND", "The API isn't enabled for this workspace.", 404);
    const workspace = (await db.query<{ name: string }>("SELECT brand AS name FROM workspace WHERE id=$1", [w])).rows[0]?.name ?? w;
    const scopes = [];
    for (const s of asked) scopes.push({ id: s, granted: await can(db, w, principal, s as Capability) });
    return { app: { name: app.name, description: app.description, developer, version: app.version }, workspace, scopes, redirectUri: q.redirect_uri };
  });
}

/** Approve or deny: where to send the person back (with a code, or `error=access_denied`). */
export async function decideConsent(connect: Connect, w: string, principal: string, q: AuthorizeQuery & { decision?: string }) {
  const shown = await readConsent(connect, w, principal, q);
  const back = new URL(q.redirect_uri!);
  if (q.state) back.searchParams.set("state", q.state);
  if (q.decision !== "approve") {
    back.searchParams.set("error", "access_denied");
    return { redirect: back.toString() };
  }
  const found = (await appByClient(connect, q.client_id))!;
  const granted = shown.scopes.filter((s) => s.granted).map((s) => s.id);
  assert(granted.length > 0, "INVALID_SCOPE", "You don't have any of the permissions this app asks for.", 403);
  const code = `relay_code_${b64(w)}_${random(40)}`;
  await tenant(connect, w, async (db) => {
    const t = (await db.query<{ id: string }>("SELECT id FROM teammates WHERE workspace_id=$1 AND principal_id=$2", [w, principal])).rows[0];
    // Installing again replaces the installation (and its tokens).
    const live = (await db.query<{ id: string }>("SELECT id FROM oauth_grants WHERE workspace_id=$1 AND app_workspace_id=$2 AND app_id=$3 AND revoked_at IS NULL", [w, found.w, found.app.id])).rows[0];
    if (live) await revokeGrant(db, w, live.id, "Installed again.");
    const grant = crypto.randomUUID();
    // Pinned to the version consented to (T3a); later ones reach it by app-versions' rule.
    await db.query("INSERT INTO oauth_grants(workspace_id,id,app_workspace_id,app_id,app_name,teammate_id,scopes,app_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [
      w,
      grant,
      found.w,
      found.app.id,
      shown.app.name,
      t.id,
      granted,
      shown.app.version,
    ]);
    await db.query("INSERT INTO oauth_codes(workspace_id,code_hash,grant_id,redirect_uri,code_challenge,expires_at) VALUES($1,$2,$3,$4,$5,now()+($6::int*interval '1 millisecond'))", [
      w,
      await sha256(code),
      grant,
      q.redirect_uri,
      q.code_challenge,
      CODE_MS,
    ]);
  });
  back.searchParams.set("code", code);
  return { redirect: back.toString() };
}

/* ------------------------------------------------------------------------------------------ */
/* The token and revoke endpoints (RFC 6749 and 7009)                                          */
/* ------------------------------------------------------------------------------------------ */
async function pkce(verifier: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function readForm(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  const text = (await req.text()).slice(0, 8000);
  if (type.includes("application/json")) {
    try {
      const o = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}
/** Client credentials from HTTP Basic or the body. */
function credentials(req: Request, form: Record<string, string>) {
  const basic = /^Basic (.+)$/.exec(req.headers.get("authorization") ?? "");
  if (basic) {
    const [id, secret] = (unb64(basic[1]) ?? "").split(":");
    return { id: decodeURIComponent(id ?? ""), secret: decodeURIComponent(secret ?? "") };
  }
  return { id: form.client_id, secret: form.client_secret };
}
const oauthError = (status: number, error: string, description: string) =>
  Response.json({ error, error_description: description }, { status, headers: { "cache-control": "no-store", pragma: "no-cache" } });

/** A fresh access token and refresh token for an installation. */
async function issue(db: Sql, w: string, grant: { id: string; teammate_id: string; scopes: string[]; app_name: string }, running: AppVersion | null) {
  // T3a: what was granted, and only what the running version asks for — a version that asks for
  // less gets less at once, never what it gave up.
  const scopes = running ? grant.scopes.filter((s) => running.scopes.includes(s)) : grant.scopes;
  grant = { ...grant, scopes };
  const access = await mintToken(w);
  await db.query(
    "INSERT INTO api_tokens(workspace_id,id,teammate_id,name,token_hash,last_four,scopes,version,grant_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+($10::int*interval '1 second'))",
    [w, crypto.randomUUID(), grant.teammate_id, grant.app_name.slice(0, 80), access.hash, access.lastFour, grant.scopes, LATEST_VERSION, grant.id, ACCESS_SECONDS],
  );
  const refresh = `relay_rt_${b64(w)}_${random(40)}`;
  await db.query("INSERT INTO oauth_refresh_tokens(workspace_id,token_hash,grant_id,expires_at) VALUES($1,$2,$3,now()+($4::bigint*interval '1 millisecond'))", [w, await sha256(refresh), grant.id, REFRESH_MS]);
  return { access_token: access.text, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: grant.scopes.join(" ") };
}

export async function oauthToken(req: Request, connect: Connect): Promise<Response> {
  if (req.method !== "POST") return oauthError(405, "invalid_request", "Use POST.");
  const form = await readForm(req);
  const client = credentials(req, form);
  const found = await appByClient(connect, client.id, client.secret ?? "");
  if (!found) return oauthError(401, "invalid_client", "The client id and secret don't match a registered app.");
  // T3b: a suspended app gets no tokens, anywhere, until Relay lifts it.
  if (found.suspended) return oauthError(401, "invalid_client", `Relay has suspended this app: ${found.suspended.reason}`);
  const sameApp = (g: { app_workspace_id: string; app_id: string }) => g.app_workspace_id === found.w && g.app_id === found.app.id;
  type Grant = { id: string; teammate_id: string; scopes: string[]; app_name: string; app_workspace_id: string; app_id: string; revoked_at: Date | null; app_version: number | null };
  const GRANT = "SELECT id,teammate_id,scopes,app_name,app_workspace_id,app_id,revoked_at,app_version FROM oauth_grants WHERE workspace_id=$1 AND id=$2";
  const running = (w: string, g: Grant) => resolveRunning(found.versions, found.sandbox.includes(w), g.app_version)?.running ?? null;
  if (form.grant_type === "authorization_code") {
    const where = workspaceOf("relay_code", form.code);
    if (!where?.w) return oauthError(400, "invalid_grant", "That code isn't valid.");
    return tenant(connect, where.w, async (db) => {
      const code = (await db.query<{ code_hash: string; grant_id: string; redirect_uri: string; code_challenge: string; expires_at: Date; used_at: Date | null }>(
        "SELECT code_hash,grant_id,redirect_uri,code_challenge,expires_at,used_at FROM oauth_codes WHERE workspace_id=$1 AND code_hash=$2 FOR UPDATE",
        [where.w, await sha256(form.code)],
      )).rows[0];
      if (!code) return oauthError(400, "invalid_grant", "That code isn't valid.");
      const grant = (await db.query<Grant>(GRANT, [where.w, code.grant_id])).rows[0];
      if (!grant || !sameApp(grant)) return oauthError(400, "invalid_grant", "That code wasn't issued to this app.");
      if (code.used_at) {
        // A code used twice: whoever has it isn't the app alone. Everything it led to is revoked.
        await revokeGrant(db, where.w!, grant.id, "An authorization code was used twice.");
        return oauthError(400, "invalid_grant", "That code was already used; its installation has been revoked.");
      }
      await db.query("UPDATE oauth_codes SET used_at=now() WHERE workspace_id=$1 AND code_hash=$2", [where.w, code.code_hash]);
      if (new Date(code.expires_at) < new Date()) return oauthError(400, "invalid_grant", "That code has expired (codes last 10 minutes).");
      if (grant.revoked_at) return oauthError(400, "invalid_grant", "That installation was revoked.");
      if (form.redirect_uri !== code.redirect_uri) return oauthError(400, "invalid_grant", "redirect_uri must be the one used to get the code.");
      if (!form.code_verifier || (await pkce(form.code_verifier)) !== code.code_challenge) return oauthError(400, "invalid_grant", "The code_verifier doesn't match the code_challenge.");
      return Response.json(await issue(db, where.w!, grant, running(where.w!, grant)), { headers: { "cache-control": "no-store", pragma: "no-cache" } });
    });
  }
  if (form.grant_type === "refresh_token") {
    const where = workspaceOf("relay_rt", form.refresh_token);
    if (!where?.w) return oauthError(400, "invalid_grant", "That refresh token isn't valid.");
    return tenant(connect, where.w, async (db) => {
      const r = (await db.query<{ token_hash: string; grant_id: string; expires_at: Date; used_at: Date | null }>(
        "SELECT token_hash,grant_id,expires_at,used_at FROM oauth_refresh_tokens WHERE workspace_id=$1 AND token_hash=$2 FOR UPDATE",
        [where.w, await sha256(form.refresh_token)],
      )).rows[0];
      if (!r) return oauthError(400, "invalid_grant", "That refresh token isn't valid.");
      const grant = (await db.query<Grant>(GRANT, [where.w, r.grant_id])).rows[0];
      if (!grant || !sameApp(grant)) return oauthError(400, "invalid_grant", "That refresh token wasn't issued to this app.");
      if (r.used_at) {
        // Reuse of a rotated refresh token means it was copied: the installation is revoked.
        if (!grant.revoked_at) await revokeGrant(db, where.w!, grant.id, "A refresh token was used twice.");
        return oauthError(400, "invalid_grant", "That refresh token was already used.");
      }
      if (grant.revoked_at) return oauthError(400, "invalid_grant", "That installation was revoked.");
      if (new Date(r.expires_at) < new Date()) return oauthError(400, "invalid_grant", "That refresh token has expired.");
      await db.query("UPDATE oauth_refresh_tokens SET used_at=now() WHERE workspace_id=$1 AND token_hash=$2", [where.w, r.token_hash]);
      return Response.json(await issue(db, where.w!, grant, running(where.w!, grant)), { headers: { "cache-control": "no-store", pragma: "no-cache" } });
    });
  }
  return oauthError(400, "unsupported_grant_type", "grant_type is authorization_code or refresh_token.");
}

/** RFC 7009: an access or refresh token revoked (a refresh token revokes its installation). Always 200 for a known client. */
export async function oauthRevoke(req: Request, connect: Connect): Promise<Response> {
  if (req.method !== "POST") return oauthError(405, "invalid_request", "Use POST.");
  const form = await readForm(req);
  const client = credentials(req, form);
  const found = await appByClient(connect, client.id, client.secret ?? "");
  if (!found) return oauthError(401, "invalid_client", "The client id and secret don't match a registered app.");
  const token = form.token ?? "";
  const rt = workspaceOf("relay_rt", token);
  const at = /^relay_pat_([A-Za-z0-9_-]{2,140})_/.exec(token);
  const w = rt?.w ?? (at ? unb64(at[1]) : null);
  if (w)
    await tenant(connect, w, async (db) => {
      const hash = await sha256(token);
      const grantId = rt
        ? (await db.query<{ grant_id: string }>("SELECT grant_id FROM oauth_refresh_tokens WHERE workspace_id=$1 AND token_hash=$2", [w, hash])).rows[0]?.grant_id
        : (await db.query<{ grant_id: string }>("SELECT grant_id FROM api_tokens WHERE workspace_id=$1 AND token_hash=$2 AND grant_id IS NOT NULL", [w, hash])).rows[0]?.grant_id;
      if (!grantId) return;
      const g = (await db.query<{ app_workspace_id: string; app_id: string }>("SELECT app_workspace_id,app_id FROM oauth_grants WHERE workspace_id=$1 AND id=$2", [w, grantId])).rows[0];
      if (!g || g.app_workspace_id !== found.w || g.app_id !== found.app.id) return;
      if (rt) await revokeGrant(db, w, grantId, "Revoked by the app.");
      else await db.query("UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE workspace_id=$1 AND token_hash=$2", [w, hash]);
    }).catch(() => undefined);
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}

/* ------------------------------------------------------------------------------------------ */
/* Installations' versions, in the installing workspace (T3a)                                   */
/* ------------------------------------------------------------------------------------------ */
type InstalledGrant = { id: string; app_workspace_id: string; app_id: string; scopes: string[]; app_version: number | null };
/** Each app's versions and sandbox, read in its own workspace (one at a time, never nested). */
async function versionsOf(connect: Connect, grants: InstalledGrant[]) {
  const out = new Map<string, { versions: AppVersion[]; sandbox: string[] }>();
  for (const g of grants) {
    const key = g.app_workspace_id + "/" + g.app_id;
    if (out.has(key)) continue;
    out.set(
      key,
      await tenant(connect, g.app_workspace_id, async (db) => ({ versions: await readVersions(db, g.app_workspace_id, g.app_id), sandbox: await sandboxOf(db, g.app_workspace_id) })).catch(() => ({
        versions: [],
        sandbox: [],
      })),
    );
  }
  return out;
}

/** Settings › Developers › Apps: what each installation here runs, and what waits for approval. */
export async function readInstallations(connect: Connect, w: string) {
  const grants = await tenant(connect, w, async (db) =>
    (await db.query<InstalledGrant>("SELECT id,app_workspace_id,app_id,scopes,app_version FROM oauth_grants WHERE workspace_id=$1 AND revoked_at IS NULL", [w])).rows,
  );
  const of = await versionsOf(connect, grants);
  // T3b: an app Relay has suspended says so on its row, with the reason.
  const suspended = await suspensionsOf(
    connect,
    grants.map((g) => ({ appW: g.app_workspace_id, appId: g.app_id })),
  );
  const installed: Record<string, { running: number | null; waiting: number | null; newScopes: string[]; notes: string; suspended: string | null }> = {};
  for (const g of grants) {
    const app = of.get(g.app_workspace_id + "/" + g.app_id)!;
    const r = resolveRunning(app.versions, app.sandbox.includes(w), g.app_version);
    installed[g.id] = {
      running: r?.running.version ?? null,
      waiting: r?.waiting?.version ?? null,
      newScopes: r?.newScopes ?? [],
      notes: r?.waiting?.notes ?? "",
      suspended: suspended.get(g.app_workspace_id + "/" + g.app_id)?.reason ?? null,
    };
  }
  return installed;
}

/**
 * A manager approves the version waiting for an installation: it moves there, granted what that
 * version asks for that the manager also has. Refused when nothing is waiting any more.
 */
export async function upgradeInstallation(connect: Connect, w: string, principal: string, p: Record<string, unknown>) {
  const id = String(p.id ?? "");
  const grant = await tenant(connect, w, async (db) => {
    await managing(db, w, principal);
    return (await db.query<InstalledGrant>("SELECT id,app_workspace_id,app_id,scopes,app_version FROM oauth_grants WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL", [w, id])).rows[0];
  });
  assert(grant, "NOT_FOUND", "No such installed app.", 404);
  const app = (await versionsOf(connect, [grant])).get(grant.app_workspace_id + "/" + grant.app_id)!;
  return tenant(connect, w, async (db) => {
    await managing(db, w, principal);
    // Read again in the transaction that writes, so two approvals can't both move it.
    const now = (await db.query<InstalledGrant>("SELECT id,app_workspace_id,app_id,scopes,app_version FROM oauth_grants WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL FOR UPDATE", [w, id])).rows[0];
    assert(now, "NOT_FOUND", "No such installed app.", 404);
    const r = resolveRunning(app.versions, app.sandbox.includes(w), now.app_version);
    assert(r?.waiting, "NOTHING_WAITING", "This app has no new version waiting for approval.", 409);
    const waiting = r!.waiting!;
    const granted: string[] = [];
    for (const s of waiting.scopes) if (await can(db, w, principal, s as Capability)) granted.push(s);
    assert(granted.length > 0, "INVALID_SCOPE", "You don't have any of the permissions this version asks for.", 403);
    await db.query("UPDATE oauth_grants SET scopes=$3,app_version=$4,app_name=$5 WHERE workspace_id=$1 AND id=$2", [w, id, granted, waiting.version, waiting.name]);
    return { id, running: waiting.version, scopes: granted };
  });
}

/* ------------------------------------------------------------------------------------------ */
/* The directory, from a workspace (T3b, docs/TEST_WORKSPACE_STEP6.md)                         */
/* ------------------------------------------------------------------------------------------ */
/** A version's review, recorded in the directory after the developer's own workspace has checked it. */
async function recordSubmission(connect: Connect, w: string, principal: string, appId: string, kind: "listing" | "version", review: { card: Card; widens: string[] }) {
  const who = await tenant(connect, w, async (db) => (await managing(db, w, principal)).name);
  const id = crypto.randomUUID();
  await inDirectory(connect, (db) =>
    db.query(
      "INSERT INTO app_submissions(workspace_id,id,app_workspace_id,app_id,version,kind,card,widens,submitted_by_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [DIRECTORY, id, w, appId, review.card.version, kind, JSON.stringify(review.card), review.widens, who],
    ),
  ).catch((e: unknown) => {
    if (String((e as { code?: string }).code) === "23505") throw new DomainError("REVIEW_PENDING", "This app already has a version waiting for Relay's review.", 409);
    throw e;
  });
  return id;
}

/** "Submit to the directory": a version asked to be listed. One open submission per app. */
export async function submitToDirectory(connect: Connect, w: string, principal: string, p: Record<string, unknown>, canvas?: CanvasEnvironment) {
  const appId = String(p.id ?? "");
  // Who may manage this workspace, before anything about the app or the directory is answered.
  await tenant(connect, w, (db) => managing(db, w, principal));
  const suspended = await suspensionOf(connect, w, appId);
  if (suspended) throw new DomainError("APP_SUSPENDED", `Relay has suspended this app: ${suspended.reason}`, 403);
  const listed = await inDirectory(connect, (db) => listingOf(db, w, appId));
  assert(!listed, "ALREADY_LISTED", listed?.delistedAt ? "Relay took this app out of the directory; only Relay can put it back." : "This app is already listed: release a new version and it follows, or waits for review.", 409);
  const checked = (await tenant(connect, w, (db) => changeApps(db, w, principal, { ...p, action: "submit" }, canvas))) as { review: { card: Card; widens: string[] } };
  const id = await recordSubmission(connect, w, principal, appId, "listing", checked.review);
  return { submitted: id, version: checked.review.card.version };
}

/**
 * Release, from the page: a listed app's version that widens its reach becomes a submission (the
 * release itself refused it, in the developer's workspace); one that doesn't is released and the
 * directory's card follows it.
 */
export async function releaseFromWorkspace(connect: Connect, w: string, principal: string, p: Record<string, unknown>, canvas?: CanvasEnvironment) {
  const appId = String(p.id ?? "");
  await tenant(connect, w, (db) => managing(db, w, principal));
  const suspended = await suspensionOf(connect, w, appId);
  if (suspended) throw new DomainError("APP_SUSPENDED", `Relay has suspended this app: ${suspended.reason}`, 403);
  const r = (await tenant(connect, w, (db) => changeApps(db, w, principal, { ...p, action: "release" }, canvas))) as {
    review?: { card: Card; widens: string[] };
    listedCard?: Card;
  } & Record<string, unknown>;
  if (r.review) return { ...r, submitted: await recordSubmission(connect, w, principal, appId, "version", r.review) };
  if (r.listedCard)
    await inDirectory(connect, (db) =>
      db.query("UPDATE app_listings SET card=$4,version=$5 WHERE workspace_id=$1 AND app_workspace_id=$2 AND app_id=$3", [DIRECTORY, w, appId, JSON.stringify(r.listedCard), r.listedCard!.version]),
    );
  return r;
}

/** Settings › Apps › Directory: what's listed, and which of them this workspace has installed. */
export async function readDirectory(connect: Connect, w: string, principal: string) {
  const installed = await tenant(connect, w, async (db) => {
    await managing(db, w, principal);
    return (await db.query<{ app_workspace_id: string; app_id: string }>("SELECT app_workspace_id,app_id FROM oauth_grants WHERE workspace_id=$1 AND revoked_at IS NULL", [w])).rows.map(
      (g) => g.app_workspace_id + "/" + g.app_id,
    );
  });
  return {
    apps: (await readListings(connect)).map((l) => ({ ...l.card, listedAt: l.listedAt, installed: installed.includes(l.appW + "/" + l.appId) })),
  };
}
