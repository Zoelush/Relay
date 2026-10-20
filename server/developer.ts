import { assert, DomainError, type Sql } from "./db";
import { authorize, can, capabilities, type Capability } from "./policy";
import { API_VERSIONS, LATEST_VERSION } from "../lib/api-spec";
import { LIMITS } from "./rate-limit";
import { mintToken } from "./rest";

/**
 * Settings › Developers (phase 15, step D1; docs/DEVELOPER_PLATFORM_STEP1.md), behind
 * `developer_api_v1`: personal access tokens and the API's usage. Anyone makes their own tokens,
 * with scopes from their own role's capabilities (never more); a token's text is shown once and only
 * its hash is kept. Who manages the workspace sees everyone's tokens and can revoke any.
 */
export async function developerOn(db: Sql, w: string) {
  return (await db.query("SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='developer_api_v1' AND enabled", [w])).rows.length > 0;
}
async function me(db: Sql, w: string, principal: string) {
  assert(await developerOn(db, w), "NOT_FOUND", "The API isn't enabled for this workspace.", 404);
  const t = (await db.query<{ id: string; role_id: string }>("SELECT id,role_id FROM teammates WHERE workspace_id=$1 AND principal_id=$2", [w, principal])).rows[0];
  assert(t, "FORBIDDEN", "Sign in as a teammate.", 403);
  return t;
}
/** The capabilities this teammate's role has: the scopes they may give a token. */
async function ownScopes(db: Sql, w: string, principal: string) {
  const out: Capability[] = [];
  for (const c of capabilities) if (await can(db, w, principal, c)) out.push(c);
  return out;
}

export async function readDeveloperSettings(db: Sql, w: string, principal: string, apiBase: string) {
  const t = await me(db, w, principal);
  const manager = await can(db, w, principal, "workspace.manage");
  const tokens = (
    await db.query<{ id: string; name: string; teammate_id: string; owner: string; last_four: string; scopes: string[]; version: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }>(
      `SELECT k.id,k.name,k.teammate_id,m.name AS owner,k.last_four,k.scopes,k.version,k.created_at,k.last_used_at,k.revoked_at
       FROM api_tokens k JOIN teammates m ON m.workspace_id=k.workspace_id AND m.id=k.teammate_id
       WHERE k.workspace_id=$1 AND ($2 OR k.teammate_id=$3) ORDER BY k.revoked_at IS NOT NULL,k.created_at DESC`,
      [w, manager, t.id],
    )
  ).rows;
  // The last hour's calls, a minute at a time, per token (refused ones apart).
  const usage = (
    await db.query<{ token_id: string; minute: Date; calls: number; limited: number }>(
      "SELECT token_id,minute,calls,limited FROM api_usage WHERE workspace_id=$1 AND minute>now()-interval '60 minutes' AND token_id=ANY($2) ORDER BY minute",
      [w, tokens.map((k) => k.id)],
    )
  ).rows;
  return {
    apiBase,
    versions: [...API_VERSIONS],
    latest: LATEST_VERSION,
    limits: { perMinute: LIMITS.token.perSecond * 60, burst: LIMITS.token.capacity, workspacePerMinute: LIMITS.workspace.perSecond * 60 },
    scopes: await ownScopes(db, w, principal),
    manager,
    me: t.id,
    tokens: tokens.map((k) => {
      const mine = usage.filter((u) => u.token_id === k.id);
      return {
        id: k.id,
        name: k.name,
        owner: { id: k.teammate_id, name: k.owner },
        lastFour: k.last_four,
        scopes: k.scopes,
        version: k.version,
        createdAt: k.created_at.toISOString(),
        lastUsedAt: k.last_used_at ? new Date(k.last_used_at).toISOString() : null,
        revokedAt: k.revoked_at ? new Date(k.revoked_at).toISOString() : null,
        lastHour: { calls: mine.reduce((s, u) => s + u.calls, 0), limited: mine.reduce((s, u) => s + u.limited, 0), perMinute: mine.map((u) => ({ minute: new Date(u.minute).toISOString(), calls: u.calls, limited: u.limited })) },
      };
    }),
  };
}

export async function changeDeveloperTokens(db: Sql, w: string, principal: string, p: Record<string, unknown>) {
  const t = await me(db, w, principal);
  if (p.action === "create") {
    const name = typeof p.name === "string" ? p.name.trim() : "";
    assert(name.length >= 1 && name.length <= 80, "INVALID_TOKEN", "Name the token (up to 80 characters).");
    const scopes = Array.isArray(p.scopes) ? [...new Set(p.scopes.map(String))] : [];
    assert(scopes.length > 0, "INVALID_TOKEN", "Choose at least one scope.");
    const own = await ownScopes(db, w, principal);
    const beyond = scopes.filter((s) => !own.includes(s as Capability));
    if (beyond.length) throw new DomainError("INVALID_TOKEN", `Your role doesn't have ${beyond.join(", ")}: a token can't have more than you.`, 403);
    const version = p.version === undefined ? LATEST_VERSION : String(p.version);
    assert((API_VERSIONS as readonly string[]).includes(version), "INVALID_TOKEN", "Choose a supported version.");
    const minted = await mintToken(w);
    const id = crypto.randomUUID();
    await db.query(
      "INSERT INTO api_tokens(workspace_id,id,teammate_id,name,token_hash,last_four,scopes,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [w, id, t.id, name, minted.hash, minted.lastFour, scopes, version],
    );
    // The only time the token's text leaves the server.
    return { id, token: minted.text };
  }
  if (p.action === "revoke") {
    const k = (await db.query<{ teammate_id: string; revoked_at: Date | null }>("SELECT teammate_id,revoked_at FROM api_tokens WHERE workspace_id=$1 AND id=$2", [w, String(p.id ?? "")])).rows[0];
    assert(k, "NOT_FOUND", "No such token.", 404);
    if (k.teammate_id !== t.id) await authorize(db, w, principal, "workspace.manage");
    if (!k.revoked_at) await db.query("UPDATE api_tokens SET revoked_at=now(),revoked_by=$3 WHERE workspace_id=$1 AND id=$2", [w, String(p.id), t.id]);
    return { ok: true };
  }
  throw new DomainError("INVALID_TOKEN", "Choose create or revoke.");
}
