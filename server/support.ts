import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize, isSupport, SUPPORT_PREFIX } from "./policy";
import { securityOn } from "./two-factor";
import { recordAudit } from "./audit";
import { discover, exchangeCode, oidcLogin } from "./sso";
import type { ClientInfo } from "./accounts";
import type { FetchPolicy } from "./safe-fetch";

/**
 * Vendor support access (phase 16, step C7b; docs/SECURITY_STEP12.md).
 *
 * - **Settings › Security › Support access** (`security.manage`): a grant of read-only access to
 *   Relay's support staff for 1, 7 or 14 days (one open at a time), revoked early with every staff
 *   session under it ended; past grants and their sessions are kept as history.
 * - **Staff sign in** through the workspace's own host (`/auth/support`, `/auth/support/callback`)
 *   with Relay's own identity provider (OIDC, `RELAY_SUPPORT_OIDC_*`): the same checks as single
 *   sign-on (`exchangeCode`), only a verified email on the staff list, only while a grant is open.
 *   `admitSupport` is staff's only way in; it never makes a teammate.
 * - **A support session** (`relay_sup_…`, in the same HttpOnly cookie) is the principal
 *   `relay-support:<session>`: read-only (`server/policy.ts`, the API's `SUPPORT_READ_ONLY`), for
 *   at most 8 hours and never beyond its grant. Each page staff open is audited (`support.viewed`).
 */
export type SupportEnvironment = { issuer: string; clientId: string; clientSecret: string; staff: string[]; policy?: FetchPolicy };
export const SUPPORT_DAYS = [1, 7, 14] as const;
const SESSION_HOURS = 8;
const LOGIN_MINUTES = 10;
const VIEW_EVERY = "10 minutes";
export const supportCallbackPath = "/auth/support/callback";
const b64 = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => {
  try {
    return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
};
const random = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("");
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const clip = (v: string | null | undefined, n: number) => (v ? v.slice(0, n) : null);
const workspaceOf = (prefix: string, token: unknown) => {
  const m = typeof token === "string" ? new RegExp(`^${prefix}_([A-Za-z0-9_-]{2,140})_([A-Za-z0-9]{40})$`).exec(token) : null;
  return m ? unb64(m[1]) : null;
};
export const isSupportToken = (token: string) => token.startsWith("relay_sup_");

/* ------------------------------------------------------------------------------------------ */
/* Settings › Security › Support access                                                         */
/* ------------------------------------------------------------------------------------------ */
type GrantRow = { id: string; granted_by_name: string; granted_at: Date; expires_at: Date; revoked_at: Date | null; revoked_by_name: string | null };
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

export async function readSupport(db: Sql, w: string, principal: string, configured: boolean) {
  await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  const grants = (
    await db.query<GrantRow>("SELECT id,granted_by_name,granted_at,expires_at,revoked_at,revoked_by_name FROM support_grants WHERE workspace_id=$1 ORDER BY granted_at DESC LIMIT 20", [w])
  ).rows;
  const sessions = (
    await db.query<{ grant_id: string; email: string; created_at: Date; expires_at: Date; revoked_at: Date | null }>(
      "SELECT grant_id,email,created_at,expires_at,revoked_at FROM support_sessions WHERE workspace_id=$1 AND grant_id=ANY($2::text[]) ORDER BY created_at DESC",
      [w, grants.map((g) => g.id)],
    )
  ).rows;
  const now = Date.now();
  const out = grants.map((g) => ({
    id: g.id,
    grantedBy: g.granted_by_name,
    grantedAt: iso(g.granted_at)!,
    expiresAt: iso(g.expires_at)!,
    endedAt: iso(g.revoked_at) ?? (new Date(g.expires_at).getTime() <= now ? iso(g.expires_at) : null),
    revokedBy: g.revoked_by_name,
    sessions: sessions
      .filter((s) => s.grant_id === g.id)
      .map((s) => ({ email: s.email, startedAt: iso(s.created_at)!, endedAt: iso(s.revoked_at) ?? (new Date(s.expires_at).getTime() <= now ? iso(s.expires_at) : null) })),
  }));
  return { configured, days: SUPPORT_DAYS, active: out.find((g) => !g.endedAt) ?? null, history: out };
}

export async function changeSupport(db: Sql, w: string, principal: string, p: Record<string, unknown>, configured: boolean) {
  const me = await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  const done = () => readSupport(db, w, principal, configured);
  // Whatever is open ends first: one grant at a time (a lapsed one closes at its own expiry).
  const close = (by: { id: string; name: string } | null) =>
    db.query(
      `UPDATE support_grants SET revoked_at=LEAST(now(),expires_at),revoked_by=$2,revoked_by_name=$3 WHERE workspace_id=$1 AND revoked_at IS NULL RETURNING id`,
      [w, by?.id ?? null, by?.name ?? null],
    );
  const endSessions = (reason: string) =>
    db.query("UPDATE support_sessions SET revoked_at=now(),revoked_reason=$2 WHERE workspace_id=$1 AND revoked_at IS NULL", [w, reason]);
  if (p.action === "grant") {
    const days = Number(p.days);
    assert((SUPPORT_DAYS as readonly number[]).includes(days), "INVALID_FIELD", "Grant access for 1, 7 or 14 days.");
    await close(me);
    await endSessions("Replaced by a new grant.");
    await db.query("INSERT INTO support_grants(workspace_id,id,granted_by,granted_by_name,expires_at) VALUES($1,$2,$3,$4,now()+make_interval(days=>$5))", [
      w,
      crypto.randomUUID(),
      me.id,
      me.name,
      days,
    ]);
    return done();
  }
  if (p.action === "revoke") {
    const open = (await db.query("SELECT 1 FROM support_grants WHERE workspace_id=$1 AND revoked_at IS NULL AND expires_at>now()", [w])).rows.length;
    assert(open, "NOT_FOUND", "Relay support has no access to revoke.", 404);
    await close(me);
    await endSessions("Access was revoked.");
    return done();
  }
  throw new DomainError("INVALID_SUPPORT", "Choose grant or revoke.");
}

/* ------------------------------------------------------------------------------------------ */
/* Staff sign-in (called by the host, never with a principal)                                   */
/* ------------------------------------------------------------------------------------------ */
const configuredEnv = (env: SupportEnvironment | undefined) => {
  assert(env?.issuer && env.clientId && env.clientSecret && env.staff.length, "SUPPORT_UNAVAILABLE", "Support sign-in isn't set up for this deployment.", 503);
  return env!;
};
const openGrant = async (db: Sql, w: string) =>
  (await db.query<{ id: string; expires_at: Date }>("SELECT id,expires_at FROM support_grants WHERE workspace_id=$1 AND revoked_at IS NULL AND expires_at>now()", [w])).rows[0] ?? null;
const NOT_GRANTED = "This workspace hasn't given Relay support access.";

/** Where to send a staff member's browser, and the login token the host keeps in its cookie. */
export async function startSupport(connect: Connect, w: string, env: SupportEnvironment | undefined, client: ClientInfo) {
  const e = configuredEnv(env);
  assert(client.origin, "UNAVAILABLE", "Relay doesn't know its own address.", 503);
  assert(await tenant(connect, w, (db) => openGrant(db, w)), "SUPPORT_NOT_GRANTED", NOT_GRANTED, 403);
  const provider = await discover({ policy: e.policy }, e.issuer);
  const o = await oidcLogin();
  const login = `relay_spl_${b64(w)}_${random(40)}`;
  const hash = await sha256(login);
  await tenant(connect, w, (db) =>
    db.query("INSERT INTO support_logins(workspace_id,id,token_hash,state,nonce,verifier,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+($7::int*interval '1 minute'))", [
      w,
      crypto.randomUUID(),
      hash,
      o.state,
      o.nonce,
      o.verifier,
      LOGIN_MINUTES,
    ]),
  );
  const url = new URL(provider.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: e.clientId,
    redirect_uri: client.origin + supportCallbackPath,
    scope: "openid email profile",
    state: o.state,
    nonce: o.nonce,
    code_challenge: o.challenge,
    code_challenge_method: "S256",
  }))
    url.searchParams.set(k, v);
  return { url: url.toString(), login };
}

const FAILED = "Relay's identity provider didn't confirm the sign-in.";
/** The provider's return: the code checked, then `admitSupport`. Refusals are kept in the audit log. */
export async function finishSupport(connect: Connect, w: string, env: SupportEnvironment | undefined, p: Record<string, unknown>, client: ClientInfo) {
  const e = configuredEnv(env);
  assert(workspaceOf("relay_spl", p.login) === w, "SUPPORT_EXPIRED", "That sign-in has expired. Start again.", 401);
  // 1. The login, used once and only by the browser that started it.
  const login = await tenant(connect, w, async (db) => {
    const l = (
      await db.query<{ id: string; state: string; nonce: string; verifier: string; expires_at: Date; used_at: Date | null }>(
        "SELECT id,state,nonce,verifier,expires_at,used_at FROM support_logins WHERE workspace_id=$1 AND token_hash=$2 FOR UPDATE",
        [w, await sha256(String(p.login))],
      )
    ).rows[0];
    if (!l || l.used_at) return null;
    await db.query("UPDATE support_logins SET used_at=now() WHERE workspace_id=$1 AND id=$2", [w, l.id]);
    return new Date(l.expires_at) > new Date() && l.state === p.state ? l : null;
  });
  assert(login, "SUPPORT_EXPIRED", "That sign-in has expired. Start again.", 401);
  const refuse = async (code: string, message: string, status: number, details: Record<string, unknown>) => {
    await tenant(connect, w, (db) => recordAudit(db, w, "support.sign_in_refused", { type: "support_grant" }, { ...details, ip: client.ip ?? null }));
    return new DomainError(code, message, status);
  };
  if (typeof p.error === "string" && p.error) throw await refuse("SUPPORT_DENIED", "Relay's identity provider didn't let you sign in.", 403, { reason: "provider_error" });
  assert(typeof p.code === "string" && p.code.length <= 2000, "SUPPORT_EXPIRED", "That sign-in has expired. Start again.", 401);
  // 2. Who Relay's identity provider says it is.
  let staff: { email: string; subject: string };
  try {
    const provider = await discover({ policy: e.policy }, e.issuer);
    const payload = await exchangeCode(
      { issuer: provider.issuer, tokenEndpoint: provider.token_endpoint, jwksUri: provider.jwks_uri, clientId: e.clientId, secret: e.clientSecret, redirectUri: client.origin + supportCallbackPath },
      { code: String(p.code), verifier: login!.verifier, nonce: login!.nonce },
      e.policy,
    );
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    const verified = payload.email_verified === true || payload.email_verified === "true";
    if (!payload.sub || !email || !verified) throw await refuse("SUPPORT_DENIED", "Relay's identity provider didn't share a verified email address.", 403, { reason: "email_unverified" });
    staff = { email, subject: String(payload.sub).slice(0, 255) };
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw await refuse("SUPPORT_FAILED", FAILED, 502, { reason: "token" });
  }
  return admitSupport(connect, w, e, staff, client);
}

/** 3. Staff's only way in: on the staff list, under an open grant; never a teammate. */
async function admitSupport(connect: Connect, w: string, env: SupportEnvironment, staff: { email: string; subject: string }, client: ClientInfo) {
  const outcome = await tenant(connect, w, async (db) => {
    const no = async (code: string, message: string, reason: string) => {
      await recordAudit(db, w, "support.sign_in_refused", { type: "support_grant" }, { reason, email: staff.email, ip: client.ip ?? null });
      return { refused: message, code } as const;
    };
    if (!env.staff.map((s) => s.trim().toLowerCase()).includes(staff.email)) return no("SUPPORT_NOT_STAFF", "That account isn't on Relay's support staff list.", "not_staff");
    const grant = await openGrant(db, w);
    if (!grant) return no("SUPPORT_NOT_GRANTED", NOT_GRANTED, "not_granted");
    const token = `relay_sup_${b64(w)}_${random(40)}`;
    const id = crypto.randomUUID();
    const r = (
      await db.query<{ expires_at: Date }>(
        `INSERT INTO support_sessions(workspace_id,id,grant_id,token_hash,email,subject,ip,user_agent,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,LEAST($9::timestamptz,now()+make_interval(hours=>$10))) RETURNING expires_at`,
        [w, id, grant.id, await sha256(token), staff.email, staff.subject, clip(client.ip, 64), clip(client.userAgent, 300), grant.expires_at, SESSION_HOURS],
      )
    ).rows[0];
    await db.query("SELECT set_config('relay.actor_id','relay-support',true),set_config('relay.actor_name',$1,true),set_config('relay.actor_via','support',true)", [`Relay support (${staff.email})`]);
    await recordAudit(db, w, "support.signed_in", { type: "support_grant", id: grant.id }, { email: staff.email, ip: client.ip ?? null, until: iso(r.expires_at) });
    return { token, sessionId: id, expiresAt: iso(r.expires_at)!, next: "/agent" };
  });
  if ("refused" in outcome) throw new DomainError(outcome.code, outcome.refused, 403);
  return outcome;
}

/** A support session's principal, while it and its grant are open. */
export async function resolveSupportSession(connect: Connect, w: string, token: string) {
  assert(workspaceOf("relay_sup", token) === w, "SIGNED_OUT", "You're signed out. Sign in again.", 401);
  const hash = await sha256(token);
  const s = await tenant(connect, w, async (db) => {
    const row = (
      await db.query<{ id: string; live: boolean }>(
        `SELECT s.id,(s.revoked_at IS NULL AND s.expires_at>now() AND g.revoked_at IS NULL AND g.expires_at>now()) AS live
         FROM support_sessions s JOIN support_grants g ON g.workspace_id=s.workspace_id AND g.id=s.grant_id WHERE s.workspace_id=$1 AND s.token_hash=$2`,
        [w, hash],
      )
    ).rows[0];
    return row?.live ? row : null;
  });
  assert(s, "SIGNED_OUT", "Relay support's access has ended. Sign in again if it's been granted.", 401);
  return { principal: SUPPORT_PREFIX + s!.id, sessionId: s!.id, teammateId: "relay-support" };
}

/** Each page staff open: its path and the names of its query (never the values), at most once per session and path every 10 minutes. */
export async function recordSupportView(connect: Connect, w: string, principal: string, url: URL) {
  if (!isSupport(principal)) return;
  await tenant(connect, w, async (db) => {
    await authorize(db, w, principal, "conversations.read");
    const path = url.pathname.replace(/^\/v1\/agent\//, "");
    const recent = (
      await db.query(
        `SELECT 1 FROM audit_events WHERE workspace_id=$1 AND action='support.viewed' AND target_id=$2 AND details->>'session'=$3 AND at>now()-interval '${VIEW_EVERY}' LIMIT 1`,
        [w, path, principal.slice(SUPPORT_PREFIX.length)],
      )
    ).rows.length;
    if (!recent)
      await recordAudit(db, w, "support.viewed", { type: "page", id: path }, { session: principal.slice(SUPPORT_PREFIX.length), query: [...new Set(url.searchParams.keys())].slice(0, 20) });
  });
}

/** Signing a staff member out (the host clears the cookie). */
export async function signOutSupport(connect: Connect, w: string, token: string) {
  if (workspaceOf("relay_sup", token) !== w) return { ok: true };
  const hash = await sha256(token);
  await tenant(connect, w, (db) => db.query("UPDATE support_sessions SET revoked_at=now(),revoked_reason='Signed out.' WHERE workspace_id=$1 AND token_hash=$2 AND revoked_at IS NULL", [w, hash]));
  return { ok: true };
}
