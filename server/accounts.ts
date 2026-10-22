import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { enqueueJob } from "./jobs";
import { seal } from "./connectors";
import { recordAudit } from "./audit";
import { capsOf, within } from "./people-settings";
import { DUMMY_HASH, hashPassword, needsRehash, passwordProblem, verifyPassword } from "./passwords";
import {
  beginSetup,
  changeTwoFactor,
  checkSecondFactor,
  confirmSetup,
  countWrongCode,
  LOCK_AFTER,
  LOCK_MINUTES,
  lockedMessage,
  lockedUntil,
  assertNotSsoOnly,
  securityOn,
  ssoEnforced,
  twoFactorOf,
  twoFactorRequired,
  WRONG_CODE,
  type TwoFactorEnvironment,
} from "./two-factor";
import { networkAllowed } from "./allowlists";

/**
 * Teammate accounts and sessions (phase 16, step C3a; docs/SECURITY_STEP3.md). Relay's own
 * sign-in, beside the hosting platform's (which stays until it's retired).
 *
 * - **Sign-in:** an email and password per teammate per workspace (a host serves one workspace).
 *   Ten wrong passwords lock the account for 15 minutes; an unknown email costs the same time and
 *   gets the same answer as a wrong password.
 * - **Sessions** are kept on the server (the token only as a hash): signed out after the
 *   workspace's idle limit (4 days unless changed) and absolute limit (30 days), or when revoked
 *   from Settings. The host keeps the token in an HttpOnly cookie; the API resolves it on every
 *   request (`resolveSession`), so a revoked session stops at once.
 * - **Invitations:** for a week, single use, to a role the inviter could hand out; the link is
 *   shown once and emailed (`sendAlert`, sealed until sent). Accepting makes the teammate, their
 *   password and their first session.
 * - **Two-factor** (C3b, docs/SECURITY_STEP4.md): with it on, or required by the workspace, a right
 *   password gives a challenge rather than a session (`challengeOrSession`): ten minutes, five
 *   wrong codes. The host keeps it in its own HttpOnly cookie. `completeTwoFactor` takes the code
 *   (setting two-factor up first, when it's required and not yet on) and starts the session.
 * - **Break-glass:** an owner's password (and second factor) always signs in from an allowed
 *   address (C4's enforced SSO keeps it); every sign-in, failure, sign-out and revocation is in the
 *   audit log.
 */
export type ClientInfo = { ip?: string | null; userAgent?: string | null; origin?: string | null };
export type AccountsEnvironment = TwoFactorEnvironment;
const INVITE_DAYS = 7;
const CHALLENGE_MINUTES = 10;
const CHALLENGE_TRIES = 5;
const TOUCH_SECONDS = 60;
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
/** `<prefix>_<workspace>_<secret>`: the workspace it belongs to, or null. */
const workspaceOf = (prefix: string, token: unknown) => {
  const m = typeof token === "string" ? new RegExp(`^${prefix}_([A-Za-z0-9_-]{2,140})_([A-Za-z0-9]{40})$`).exec(token) : null;
  return m ? unb64(m[1]) : null;
};
const normalEmail = (v: unknown) => {
  const e = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 320) throw new DomainError("INVALID_FIELD", "Enter an email address.", 400, { field: "email" });
  return e;
};
const clip = (v: string | null | undefined, n: number) => (v ? v.slice(0, n) : null);
/** The audit log's actor for this transaction (sign-in happens before `authorize` could set it). */
export const actAs = (db: Sql, t: { id: string; name: string }) => db.query("SELECT set_config('relay.actor_id',$1,true),set_config('relay.actor_name',$2,true)", [t.id, t.name]);

async function limits(db: Sql, w: string) {
  return (
    (await db.query<{ idle_minutes: number; absolute_hours: number }>("SELECT idle_minutes,absolute_hours FROM security_settings WHERE workspace_id=$1", [w])).rows[0] ?? {
      idle_minutes: 5760,
      absolute_hours: 720,
    }
  );
}

/** A new session for a teammate; its token is returned this once. */
export async function startSession(db: Sql, w: string, teammateId: string, method: "password" | "invitation" | "sso", client: ClientInfo, twoFactor: "totp" | "recovery" | null = null) {
  const token = `relay_ses_${b64(w)}_${random(40)}`;
  const { absolute_hours } = await limits(db, w);
  const id = crypto.randomUUID();
  const r = (
    await db.query<{ expires_at: Date }>(
      `INSERT INTO teammate_sessions(workspace_id,id,teammate_id,token_hash,method,ip,user_agent,expires_at,two_factor) VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8::int*interval '1 hour'),$9) RETURNING expires_at`,
      [w, id, teammateId, await sha256(token), method, clip(client.ip, 64), clip(client.userAgent, 300), absolute_hours, twoFactor],
    )
  ).rows[0];
  await recordAudit(db, w, "session.signed_in", { type: "teammate", id: teammateId }, { method, twoFactor, ip: client.ip ?? null, userAgent: clip(client.userAgent, 120) });
  return { token, sessionId: id, expiresAt: new Date(r.expires_at).toISOString() };
}

/**
 * After a right password: a session, or, with two-factor on (or required and not yet set up), a
 * challenge for the code. Its token is returned this once; the host keeps it in an HttpOnly cookie.
 */
async function challengeOrSession(db: Sql, w: string, teammateId: string, method: "password" | "invitation", client: ClientInfo) {
  const purpose: "verify" | "setup" | null = (await twoFactorOf(db, w, teammateId)).enabled ? "verify" : (await twoFactorRequired(db, w)) ? "setup" : null;
  if (!purpose) return startSession(db, w, teammateId, method, client);
  const challenge = `relay_chl_${b64(w)}_${random(40)}`;
  await db.query(
    "INSERT INTO teammate_challenges(workspace_id,id,teammate_id,token_hash,purpose,method,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+($7::int*interval '1 minute'))",
    [w, crypto.randomUUID(), teammateId, await sha256(challenge), purpose, method, CHALLENGE_MINUTES],
  );
  return { twoFactor: purpose, challenge };
}

/* ------------------------------------------------------------------------------------------ */
/* Signing in and out (called by the host, never with a principal)                             */
/* ------------------------------------------------------------------------------------------ */
const WRONG = "That email and password don't match an account here.";
export async function signIn(connect: Connect, w: string, p: Record<string, unknown>, client: ClientInfo) {
  const email = normalEmail(p.email);
  const password = typeof p.password === "string" ? p.password : "";
  // Decided inside the transaction, refused after it commits (so failures and locks are kept).
  const outcome = await tenant(connect, w, async (db) => {
    const c = (
      await db.query<{ teammate_id: string; name: string; role_id: string; password_hash: string; failed_count: number; locked_until: Date | null }>(
        `SELECT c.teammate_id,t.name,t.role_id,c.password_hash,c.failed_count,c.locked_until FROM teammate_credentials c
         JOIN teammates t ON t.workspace_id=c.workspace_id AND t.id=c.teammate_id WHERE c.workspace_id=$1 AND c.email=$2 FOR UPDATE OF c`,
        [w, email],
      )
    ).rows[0];
    if (!c) {
      verifyPassword(password, DUMMY_HASH);
      return { refused: WRONG, status: 401 } as const;
    }
    if (c.locked_until && new Date(c.locked_until) > new Date())
      return { refused: `Too many attempts. Try again after ${new Date(c.locked_until).toISOString().slice(11, 16)} UTC.`, status: 429 } as const;
    if (!verifyPassword(password, c.password_hash)) {
      const locks = c.failed_count + 1 >= LOCK_AFTER;
      await db.query(
        `UPDATE teammate_credentials SET failed_count=CASE WHEN $3 THEN 0 ELSE failed_count+1 END,locked_until=CASE WHEN $3 THEN now()+($4::int*interval '1 minute') ELSE locked_until END WHERE workspace_id=$1 AND teammate_id=$2`,
        [w, c.teammate_id, locks, LOCK_MINUTES],
      );
      await recordAudit(db, w, "session.sign_in_failed", { type: "teammate", id: c.teammate_id, name: c.name }, { ip: client.ip ?? null, locked: locks });
      return { refused: WRONG, status: 401 } as const;
    }
    await actAs(db, { id: c.teammate_id, name: c.name });
    // Phase 16 C4a: with single sign-on enforced, a password is for owners only (break-glass, recorded).
    if (await ssoEnforced(db, w)) {
      if (c.role_id !== "owner") {
        await recordAudit(db, w, "session.sign_in_failed", { type: "teammate", id: c.teammate_id, name: c.name }, { ip: client.ip ?? null, reason: "sso_enforced" });
        return { refused: "Your workspace signs in with single sign-on. Use “Sign in with single sign-on” instead.", status: 403, code: "SSO_REQUIRED" } as const;
      }
      await recordAudit(db, w, "session.break_glass", { type: "teammate", id: c.teammate_id, name: c.name }, { ip: client.ip ?? null });
    }
    if (needsRehash(c.password_hash)) await db.query("UPDATE teammate_credentials SET password_hash=$3 WHERE workspace_id=$1 AND teammate_id=$2", [w, c.teammate_id, hashPassword(password)]);
    const next = await challengeOrSession(db, w, c.teammate_id, "password", client);
    // Wrong attempts clear only when signing in is done: with two-factor, a right password alone
    // mustn't reset the count, or each new challenge would bring five more guesses at the code.
    if ("token" in next) await db.query("UPDATE teammate_credentials SET failed_count=0,locked_until=NULL WHERE workspace_id=$1 AND teammate_id=$2", [w, c.teammate_id]);
    return next;
  });
  if ("refused" in outcome) {
    const r = outcome as { refused: string; status: number; code?: string };
    throw new DomainError(r.code ?? (r.status === 429 ? "LOCKED" : "SIGN_IN_FAILED"), r.refused, r.status);
  }
  return outcome;
}

/** An open challenge, by its token (from the host's cookie), locked for this transaction. */
const CHALLENGE_OVER = "That sign-in has expired. Sign in again.";
async function openChallenge(db: Sql, w: string, token: unknown) {
  assert(workspaceOf("relay_chl", token) === w, "CHALLENGE_EXPIRED", CHALLENGE_OVER, 401);
  const c = (
    await db.query<{ id: string; teammate_id: string; name: string; email: string; purpose: "verify" | "setup"; method: "password" | "invitation"; attempts: number; expires_at: Date; used_at: Date | null }>(
      `SELECT c.id,c.teammate_id,t.name,cr.email,c.purpose,c.method,c.attempts,c.expires_at,c.used_at FROM teammate_challenges c
       JOIN teammates t ON t.workspace_id=c.workspace_id AND t.id=c.teammate_id JOIN teammate_credentials cr ON cr.workspace_id=c.workspace_id AND cr.teammate_id=c.teammate_id
       WHERE c.workspace_id=$1 AND c.token_hash=$2 FOR UPDATE OF c`,
      [w, await sha256(String(token))],
    )
  ).rows[0];
  assert(c && !c.used_at && new Date(c.expires_at) > new Date() && c.attempts < CHALLENGE_TRIES, "CHALLENGE_EXPIRED", CHALLENGE_OVER, 401);
  return c!;
}

/** Setting two-factor up while signing in (when it's required): what to scan. */
export async function twoFactorSetup(connect: Connect, w: string, env: AccountsEnvironment, p: Record<string, unknown>) {
  return tenant(connect, w, async (db) => {
    const c = await openChallenge(db, w, p.challenge);
    assert(c.purpose === "setup", "CHALLENGE_EXPIRED", CHALLENGE_OVER, 401);
    return beginSetup(db, w, env, { id: c.teammate_id, email: c.email });
  });
}

/**
 * The code that finishes signing in: from the app or a recovery code, or (when setting up) the
 * first code from the new key, which also returns the recovery codes. Wrong codes are kept (they
 * count toward the challenge's five and the account's lock), so they're refused after the commit.
 */
export async function completeTwoFactor(connect: Connect, w: string, env: AccountsEnvironment, p: Record<string, unknown>, client: ClientInfo) {
  const outcome = await tenant(connect, w, async (db) => {
    const c = await openChallenge(db, w, p.challenge);
    const t = { id: c.teammate_id, name: c.name };
    await actAs(db, t);
    const locked = await lockedUntil(db, w, t.id);
    if (locked) return { refused: lockedMessage(locked), code: "LOCKED", status: 429 } as const;
    let recoveryCodes: string[] | null = null;
    let factor: "totp" | "recovery" | null;
    if (c.purpose === "setup") {
      recoveryCodes = await confirmSetup(db, w, env, t, p.code);
      factor = recoveryCodes ? "totp" : null;
    } else factor = await checkSecondFactor(db, w, env, t, p.code);
    if (!factor) {
      await db.query("UPDATE teammate_challenges SET attempts=attempts+1 WHERE workspace_id=$1 AND id=$2", [w, c.id]);
      const lockedNow = await countWrongCode(db, w, t, { ip: client.ip ?? null });
      return c.attempts + 1 >= CHALLENGE_TRIES || lockedNow
        ? ({ refused: "Too many wrong codes. Sign in again.", code: "CHALLENGE_EXPIRED", status: 401 } as const)
        : ({ refused: WRONG_CODE, code: "WRONG_CODE", status: 401 } as const);
    }
    await db.query("UPDATE teammate_challenges SET used_at=now() WHERE workspace_id=$1 AND id=$2", [w, c.id]);
    await db.query("UPDATE teammate_credentials SET failed_count=0 WHERE workspace_id=$1 AND teammate_id=$2", [w, t.id]);
    const session = await startSession(db, w, t.id, c.method, client, factor);
    return recoveryCodes ? { ...session, recoveryCodes } : session;
  });
  if ("refused" in outcome) {
    const r = outcome as { refused: string; code: string; status: number };
    throw new DomainError(r.code, r.refused, r.status);
  }
  return outcome;
}

/**
 * Whether signing in may happen from this address (the app's allowlist). A refusal is kept in the
 * audit log, so it's decided in its own transaction and refused after it commits.
 */
export async function signInAllowed(connect: Connect, w: string, client: ClientInfo) {
  return tenant(connect, w, async (db) => {
    if (await networkAllowed(db, w, "app", client.ip)) return true;
    await recordAudit(db, w, "session.network_refused", { type: "workspace", id: w }, { ip: client.ip ?? null });
    return false;
  });
}

/** The teammate a session token belongs to, if it's still live; touches it at most once a minute. */
export async function resolveSession(connect: Connect, w: string, token: string, client: ClientInfo = {}) {
  assert(workspaceOf("relay_ses", token) === w, "SIGNED_OUT", "You're signed out. Sign in again.", 401);
  const hash = await sha256(token);
  const outcome = await tenant(connect, w, async (db) => {
    const s = (
      await db.query<{ id: string; teammate_id: string; principal_id: string; last_seen_at: Date; expires_at: Date; revoked_at: Date | null; idle: boolean }>(
        `SELECT s.id,s.teammate_id,t.principal_id,s.last_seen_at,s.expires_at,s.revoked_at,
           s.last_seen_at < now()-make_interval(mins=>COALESCE((SELECT idle_minutes FROM security_settings g WHERE g.workspace_id=s.workspace_id),5760)) AS idle
         FROM teammate_sessions s JOIN teammates t ON t.workspace_id=s.workspace_id AND t.id=s.teammate_id WHERE s.workspace_id=$1 AND s.token_hash=$2`,
        [w, hash],
      )
    ).rows[0];
    if (!s || s.revoked_at) return null;
    const over = new Date(s.expires_at) <= new Date() ? "Reached its time limit." : s.idle ? "Not used for too long." : null;
    if (over) {
      await db.query("UPDATE teammate_sessions SET revoked_at=now(),revoked_reason=$3 WHERE workspace_id=$1 AND id=$2", [w, s.id, over]);
      return null;
    }
    if (Date.now() - new Date(s.last_seen_at).getTime() > TOUCH_SECONDS * 1000)
      await db.query("UPDATE teammate_sessions SET last_seen_at=now(),ip=COALESCE($3,ip),user_agent=COALESCE($4,user_agent) WHERE workspace_id=$1 AND id=$2", [
        w,
        s.id,
        clip(client.ip, 64),
        clip(client.userAgent, 300),
      ]);
    return { principal: s.principal_id, sessionId: s.id, teammateId: s.teammate_id };
  });
  assert(outcome, "SIGNED_OUT", "You're signed out. Sign in again.", 401);
  return outcome!;
}

/** Whether a session is still live (the realtime socket's check). */
export async function sessionLive(db: Sql, w: string, sessionId: string) {
  return (await db.query("SELECT 1 FROM teammate_sessions WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>now()", [w, sessionId])).rows.length > 0;
}

export async function signOut(connect: Connect, w: string, token: string) {
  if (workspaceOf("relay_ses", token) !== w) return { ok: true };
  const hash = await sha256(token);
  await tenant(connect, w, async (db) => {
    const s = (
      await db.query<{ id: string; teammate_id: string; name: string }>(
        "UPDATE teammate_sessions s SET revoked_at=now(),revoked_reason='Signed out.' FROM teammates t WHERE s.workspace_id=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL AND t.workspace_id=s.workspace_id AND t.id=s.teammate_id RETURNING s.id,s.teammate_id,t.name",
        [w, hash],
      )
    ).rows[0];
    if (!s) return;
    await actAs(db, { id: s.teammate_id, name: s.name });
    await recordAudit(db, w, "session.signed_out", { type: "teammate", id: s.teammate_id, name: s.name }, { session: s.id });
  });
  return { ok: true };
}

/* ------------------------------------------------------------------------------------------ */
/* Your sign-in (Settings › Your sign-in): password and devices                                */
/* ------------------------------------------------------------------------------------------ */
type SessionRow = { id: string; teammate_id: string; name?: string; method: string; two_factor?: string | null; ip: string | null; user_agent: string | null; created_at: Date; last_seen_at: Date; expires_at: Date };
const sessionOut = (s: SessionRow, current?: string | null) => ({
  id: s.id,
  current: s.id === current,
  method: s.method,
  twoFactor: s.two_factor ?? null,
  ip: s.ip,
  userAgent: s.user_agent,
  createdAt: new Date(s.created_at).toISOString(),
  lastSeenAt: new Date(s.last_seen_at).toISOString(),
  expiresAt: new Date(s.expires_at).toISOString(),
  ...(s.name ? { teammate: { id: s.teammate_id, name: s.name } } : {}),
});
const LIVE = "revoked_at IS NULL AND expires_at>now()";

export async function readAccount(db: Sql, w: string, principal: string, sessionId: string | null) {
  const me = await authorize(db, w, principal, "conversations.read");
  const c = (await db.query<{ email: string; password_changed_at: Date }>("SELECT email,password_changed_at FROM teammate_credentials WHERE workspace_id=$1 AND teammate_id=$2", [w, me.id])).rows[0];
  const sessions = (
    await db.query<SessionRow>(
      `SELECT id,teammate_id,method,two_factor,ip,user_agent,created_at,last_seen_at,expires_at FROM teammate_sessions WHERE workspace_id=$1 AND teammate_id=$2 AND ${LIVE} ORDER BY last_seen_at DESC`,
      [w, me.id],
    )
  ).rows;
  return {
    email: c?.email ?? null,
    passwordChangedAt: c ? new Date(c.password_changed_at).toISOString() : null,
    // Signed in by the hosting platform rather than a Relay session: its sign-out is the platform's.
    platform: !sessionId,
    sessions: sessions.map((s) => sessionOut(s, sessionId)),
    // Phase 16 C3b: two-factor protects password sign-in, so it needs a password first.
    twoFactor: { ...(await twoFactorOf(db, w, me.id)), available: !!c, required: await twoFactorRequired(db, w) },
  };
}

export async function changeAccount(db: Sql, w: string, principal: string, sessionId: string | null, p: Record<string, unknown>, env: AccountsEnvironment = {}) {
  const me = await authorize(db, w, principal, "conversations.read");
  // Phase 16 C3b: two-factor (a wrong code comes back as `refused`, thrown after the commit).
  if (typeof p.action === "string" && (p.action.startsWith("two-factor") || p.action === "recovery-codes")) {
    const r = await changeTwoFactor(db, w, me, env, p);
    return "refused" in r ? r : { ...(await readAccount(db, w, principal, sessionId)), ...r };
  }
  const end = (where: string, values: unknown[], reason: string) =>
    db.query(`UPDATE teammate_sessions SET revoked_at=now(),revoked_reason=$${values.length + 1} WHERE ${where} AND revoked_at IS NULL RETURNING id`, [...values, reason]);
  if (p.action === "password") {
    await securityOn(db, w);
    await assertNotSsoOnly(db, w, me.role_id, "Your workspace signs in with single sign-on, so only owners keep a password.");
    const c = (await db.query<{ email: string; password_hash: string }>("SELECT email,password_hash FROM teammate_credentials WHERE workspace_id=$1 AND teammate_id=$2 FOR UPDATE", [w, me.id]))
      .rows[0];
    if (c) assert(typeof p.current === "string" && verifyPassword(p.current, c.password_hash), "WRONG_PASSWORD", "Your current password isn't right.", 403);
    const email = c ? c.email : normalEmail(p.email);
    const problem = passwordProblem(p.password, email);
    if (problem) throw new DomainError("INVALID_FIELD", problem, 400, { field: "password" });
    if (!c) {
      const taken = (await db.query("SELECT 1 FROM teammate_credentials WHERE workspace_id=$1 AND email=$2", [w, email])).rows.length;
      assert(!taken, "EMAIL_TAKEN", "Another teammate signs in with that email.", 409);
      await db.query("INSERT INTO teammate_credentials(workspace_id,teammate_id,email,password_hash) VALUES($1,$2,$3,$4)", [w, me.id, email, hashPassword(String(p.password))]);
    } else
      await db.query("UPDATE teammate_credentials SET password_hash=$3,password_changed_at=now(),failed_count=0,locked_until=NULL WHERE workspace_id=$1 AND teammate_id=$2", [
        w,
        me.id,
        hashPassword(String(p.password)),
      ]);
    // A new password signs out every other device.
    await end("workspace_id=$1 AND teammate_id=$2 AND id IS DISTINCT FROM $3", [w, me.id, sessionId], "Password changed.");
    return readAccount(db, w, principal, sessionId);
  }
  if (p.action === "revoke") {
    const r = await end("workspace_id=$1 AND teammate_id=$2 AND id=$3", [w, me.id, String(p.sessionId ?? "")], "Signed out from another device.");
    assert(r.rows.length, "NOT_FOUND", "That session has already ended.", 404);
    await recordAudit(db, w, "session.revoked", { type: "teammate", id: me.id, name: me.name }, { session: String(p.sessionId) });
    return readAccount(db, w, principal, sessionId);
  }
  if (p.action === "revoke-others") {
    const r = await end("workspace_id=$1 AND teammate_id=$2 AND id IS DISTINCT FROM $3", [w, me.id, sessionId], "Signed out from another device.");
    if (r.rows.length) await recordAudit(db, w, "session.revoked", { type: "teammate", id: me.id, name: me.name }, { sessions: r.rows.length });
    return readAccount(db, w, principal, sessionId);
  }
  throw new DomainError("INVALID_ACCOUNT", "Choose password, revoke or revoke-others.");
}

/* ------------------------------------------------------------------------------------------ */
/* Sessions across the workspace (Settings › Security › Sessions)                              */
/* ------------------------------------------------------------------------------------------ */
export async function readSessions(db: Sql, w: string, principal: string, sessionId: string | null) {
  await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  const l = await limits(db, w);
  const sessions = (
    await db.query<SessionRow>(
      `SELECT s.id,s.teammate_id,t.name,s.method,s.two_factor,s.ip,s.user_agent,s.created_at,s.last_seen_at,s.expires_at FROM teammate_sessions s
       JOIN teammates t ON t.workspace_id=s.workspace_id AND t.id=s.teammate_id WHERE s.workspace_id=$1 AND s.${LIVE.replace(" AND expires_at", " AND s.expires_at")} ORDER BY lower(t.name),s.last_seen_at DESC LIMIT 500`,
      [w],
    )
  ).rows;
  return { idleMinutes: l.idle_minutes, absoluteHours: l.absolute_hours, sessions: sessions.map((s) => sessionOut(s, sessionId)) };
}

export async function changeSessions(db: Sql, w: string, principal: string, sessionId: string | null, p: Record<string, unknown>) {
  const me = await authorize(db, w, principal, "security.manage");
  if (p.action === "settings") {
    const idle = Number(p.idleMinutes);
    const absolute = Number(p.absoluteHours);
    assert(Number.isInteger(idle) && idle >= 15 && idle <= 43200, "INVALID_FIELD", "Sign out after 15 minutes to 30 days without use.");
    assert(Number.isInteger(absolute) && absolute >= 1 && absolute <= 2160, "INVALID_FIELD", "End sessions after 1 hour to 90 days.");
    await db.query(
      `INSERT INTO security_settings(workspace_id,idle_minutes,absolute_hours,updated_by) VALUES($1,$2,$3,$4)
       ON CONFLICT(workspace_id) DO UPDATE SET idle_minutes=EXCLUDED.idle_minutes,absolute_hours=EXCLUDED.absolute_hours,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [w, idle, absolute, me.id],
    );
    // A shorter absolute limit applies to sessions already open.
    await db.query("UPDATE teammate_sessions SET expires_at=LEAST(expires_at,created_at+($2::int*interval '1 hour')) WHERE workspace_id=$1 AND revoked_at IS NULL", [w, absolute]);
    return readSessions(db, w, principal, sessionId);
  }
  if (p.action === "revoke" || p.action === "revoke-teammate") {
    const r = (
      await db.query<{ id: string; teammate_id: string; name: string }>(
        `UPDATE teammate_sessions s SET revoked_at=now(),revoked_reason=$3 FROM teammates t WHERE s.workspace_id=$1 AND ${p.action === "revoke" ? "s.id=$2" : "s.teammate_id=$2"} AND s.revoked_at IS NULL
         AND t.workspace_id=s.workspace_id AND t.id=s.teammate_id RETURNING s.id,s.teammate_id,t.name`,
        [w, String(p.action === "revoke" ? p.sessionId : p.teammateId), `Signed out by ${me.name}.`],
      )
    ).rows;
    assert(r.length, "NOT_FOUND", "No session to end.", 404);
    for (const s of r) await recordAudit(db, w, "session.revoked", { type: "teammate", id: s.teammate_id, name: s.name }, { session: s.id });
    return readSessions(db, w, principal, sessionId);
  }
  throw new DomainError("INVALID_SESSIONS", "Choose settings, revoke or revoke-teammate.");
}

/* ------------------------------------------------------------------------------------------ */
/* Invitations (Settings › Teammates)                                                          */
/* ------------------------------------------------------------------------------------------ */
export async function readInvitations(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "teammates.manage");
  await securityOn(db, w);
  const rows = (
    await db.query<{ id: string; email: string; name: string; role: string; invited_by: string; created_at: Date; expires_at: Date }>(
      `SELECT i.id,i.email,i.name,r.name AS role,t.name AS invited_by,i.created_at,i.expires_at FROM teammate_invitations i
       JOIN roles r ON r.workspace_id=i.workspace_id AND r.id=i.role_id LEFT JOIN teammates t ON t.workspace_id=i.workspace_id AND t.id=i.invited_by
       WHERE i.workspace_id=$1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>now() ORDER BY i.created_at DESC`,
      [w],
    )
  ).rows;
  return {
    invitations: rows.map((i) => ({
      id: i.id,
      email: i.email,
      name: i.name,
      role: i.role,
      invitedBy: i.invited_by,
      createdAt: new Date(i.created_at).toISOString(),
      expiresAt: new Date(i.expires_at).toISOString(),
    })),
  };
}

/** An invitation's link: its token goes after #, so it never reaches a server's logs; emailed, sealed until sent. */
async function sendLink(db: Sql, w: string, env: AccountsEnvironment, client: ClientInfo, row: { email: string; name: string; roleId: string; invitedBy: string; teammateId?: string }) {
  assert(client.origin, "UNAVAILABLE", "Relay doesn't know its own address to send the link.", 503);
  await db.query("UPDATE teammate_invitations SET revoked_at=now() WHERE workspace_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL", [w, row.email]);
  const token = `relay_inv_${b64(w)}_${random(40)}`;
  const id = crypto.randomUUID();
  await db.query("INSERT INTO teammate_invitations(workspace_id,id,email,name,role_id,teammate_id,token_hash,invited_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+($9::int*interval '1 day'))", [
    w,
    id,
    row.email,
    row.name,
    row.roleId,
    row.teammateId ?? null,
    await sha256(token),
    row.invitedBy,
    INVITE_DAYS,
  ]);
  const link = `${client.origin}/invite#${token}`;
  if (env.key) {
    const alert = crypto.randomUUID();
    await db.query("INSERT INTO email_alerts(workspace_id,id,kind,invitation_id,address,link_sealed) VALUES($1,$2,'invitation',$3,$4,$5)", [
      w,
      alert,
      id,
      row.email,
      await seal(env.key, w, alert, "invitation_link", link),
    ]);
    await enqueueJob(db, w, "email.alert", { alertId: alert }, {});
  }
  return { id, link, emailed: !!env.key };
}

export async function changeInvitations(db: Sql, w: string, principal: string, env: AccountsEnvironment, client: ClientInfo, p: Record<string, unknown>) {
  const me = await authorize(db, w, principal, "teammates.manage");
  await securityOn(db, w);
  if (p.action === "reset") {
    // A password reset for a teammate who signs in with a password: a link to choose a new one.
    // Phase 16 C4a: with single sign-on enforced, only an owner's (break-glass).
    const role = (await db.query<{ role_id: string }>("SELECT role_id FROM teammates WHERE workspace_id=$1 AND id=$2", [w, String(p.teammateId ?? "")])).rows[0];
    await assertNotSsoOnly(db, w, role?.role_id, "Your workspace signs in with single sign-on, so only owners have passwords to reset.");
    const t = (
      await db.query<{ id: string; email: string; name: string; role_id: string }>(
        "SELECT t.id,c.email,t.name,t.role_id FROM teammates t JOIN teammate_credentials c ON c.workspace_id=t.workspace_id AND c.teammate_id=t.id WHERE t.workspace_id=$1 AND t.id=$2",
        [w, String(p.teammateId ?? "")],
      )
    ).rows[0];
    assert(t, "NOT_FOUND", "That teammate doesn't sign in with a password.", 404);
    if (!within(await capsOf(db, w, t.role_id), await capsOf(db, w, me.role_id)))
      throw new DomainError("ROLE_ABOVE_YOURS", "That teammate has permissions you don't, so you can't reset their password.", 403);
    return { ...(await sendLink(db, w, env, client, { email: t.email, name: t.name, roleId: t.role_id, invitedBy: me.id, teammateId: t.id })), ...(await readInvitations(db, w, principal)) };
  }
  if (p.action === "create") {
    // Phase 16 C4a: with single sign-on enforced, people join by signing in with it.
    await assertNotSsoOnly(db, w, null, "Your workspace signs in with single sign-on: people join by signing in with it, with a role from their groups.");
    const email = normalEmail(p.email);
    const name = typeof p.name === "string" ? p.name.trim().slice(0, 80) : "";
    const role = (await db.query<{ id: string }>("SELECT id FROM roles WHERE workspace_id=$1 AND id=$2", [w, String(p.roleId ?? "")])).rows[0];
    assert(role, "ROLE_NOT_FOUND", "Choose a role.", 404);
    if (!within(await capsOf(db, w, role.id), await capsOf(db, w, me.role_id))) throw new DomainError("ROLE_ABOVE_YOURS", "You can only invite people to roles within your own permissions.", 403);
    assert(!(await db.query("SELECT 1 FROM teammate_credentials WHERE workspace_id=$1 AND email=$2", [w, email])).rows.length, "EMAIL_TAKEN", "A teammate already signs in with that email.", 409);
    // A new invitation to the same email replaces the open one.
    return { ...(await sendLink(db, w, env, client, { email, name, roleId: role.id, invitedBy: me.id })), ...(await readInvitations(db, w, principal)) };
  }
  if (p.action === "revoke") {
    const r = await db.query("UPDATE teammate_invitations SET revoked_at=now() WHERE workspace_id=$1 AND id=$2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id", [w, String(p.id ?? "")]);
    assert(r.rows.length, "NOT_FOUND", "That invitation isn't open.", 404);
    return readInvitations(db, w, principal);
  }
  throw new DomainError("INVALID_INVITATION", "Choose create or revoke.");
}

/** An open invitation, by its token (the invite page). */
async function openInvitation(db: Sql, w: string, token: unknown) {
  assert(workspaceOf("relay_inv", token) === w, "INVITATION_INVALID", "This invitation link isn't valid. Ask for a new one.", 404);
  const i = (
    await db.query<{
      id: string;
      email: string;
      name: string;
      role_id: string;
      teammate_id: string | null;
      role: string;
      inviter: string | null;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT i.id,i.email,i.name,i.role_id,i.teammate_id,r.name AS role,t.name AS inviter,i.expires_at,i.accepted_at,i.revoked_at FROM teammate_invitations i
       JOIN roles r ON r.workspace_id=i.workspace_id AND r.id=i.role_id LEFT JOIN teammates t ON t.workspace_id=i.workspace_id AND t.id=i.invited_by
       WHERE i.workspace_id=$1 AND i.token_hash=$2 FOR UPDATE OF i`,
      [w, await sha256(String(token))],
    )
  ).rows[0];
  assert(i && !i.revoked_at, "INVITATION_INVALID", "This invitation was withdrawn or isn't valid. Ask for a new one.", 404);
  assert(!i!.accepted_at, "INVITATION_USED", "This invitation has already been used. Sign in instead.", 409);
  assert(new Date(i!.expires_at) > new Date(), "INVITATION_EXPIRED", "This invitation has expired. Ask for a new one.", 410);
  return i!;
}
export async function readInvitation(connect: Connect, w: string, token: unknown) {
  return tenant(connect, w, async (db) => {
    const i = await openInvitation(db, w, token);
    const workspace = (await db.query<{ name: string }>("SELECT brand AS name FROM workspace WHERE id=$1", [w])).rows[0]?.name ?? w;
    return { email: i.email, name: i.name, role: i.role, invitedBy: i.inviter, workspace, expiresAt: new Date(i.expires_at).toISOString(), reset: !!i.teammate_id };
  });
}
/** Accepting: the teammate, their password and their first session, at once. */
export async function acceptInvitation(connect: Connect, w: string, p: Record<string, unknown>, client: ClientInfo) {
  return tenant(connect, w, async (db) => {
    const i = await openInvitation(db, w, p.token);
    // Phase 16 C4a: an invitation or reset made before single sign-on was enforced: owners only.
    const role = i.teammate_id ? (await db.query<{ role_id: string }>("SELECT role_id FROM teammates WHERE workspace_id=$1 AND id=$2", [w, i.teammate_id])).rows[0]?.role_id : null;
    await assertNotSsoOnly(db, w, role);
    if (i.teammate_id) {
      // A password reset: the same teammate, a new password, every old session ended.
      const problem = passwordProblem(p.password, i.email);
      if (problem) throw new DomainError("INVALID_FIELD", problem, 400, { field: "password" });
      const t = (await db.query<{ id: string; name: string }>("SELECT id,name FROM teammates WHERE workspace_id=$1 AND id=$2", [w, i.teammate_id])).rows[0];
      assert(t, "INVITATION_INVALID", "This link isn't valid any more. Ask for a new one.", 404);
      await actAs(db, t);
      await db.query("UPDATE teammate_credentials SET password_hash=$3,password_changed_at=now(),failed_count=0,locked_until=NULL WHERE workspace_id=$1 AND teammate_id=$2", [
        w,
        t.id,
        hashPassword(String(p.password)),
      ]);
      await db.query("UPDATE teammate_sessions SET revoked_at=now(),revoked_reason='Password reset.' WHERE workspace_id=$1 AND teammate_id=$2 AND revoked_at IS NULL", [w, t.id]);
      await db.query("UPDATE teammate_invitations SET accepted_at=now(),accepted_teammate_id=$3 WHERE workspace_id=$1 AND id=$2", [w, i.id, t.id]);
      await recordAudit(db, w, "invitation.accepted", { type: "teammate", id: t.id, name: t.name }, { invitation: i.id, reset: true });
      // Phase 16 C3b: a reset doesn't skip two-factor.
      return challengeOrSession(db, w, t.id, "invitation", client);
    }
    const name = typeof p.name === "string" && p.name.trim() ? p.name.trim().slice(0, 80) : i.name;
    assert(name, "INVALID_FIELD", "Enter your name.");
    const problem = passwordProblem(p.password, i.email);
    if (problem) throw new DomainError("INVALID_FIELD", problem, 400, { field: "password" });
    assert(!(await db.query("SELECT 1 FROM teammate_credentials WHERE workspace_id=$1 AND email=$2", [w, i.email])).rows.length, "EMAIL_TAKEN", "A teammate already signs in with that email.", 409);
    const teammateId = crypto.randomUUID();
    await actAs(db, { id: teammateId, name });
    await db.query("INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES($1,$2,$3,$4,$5)", [w, teammateId, "relay:" + teammateId, name, i.role_id]);
    await db.query("INSERT INTO teammate_credentials(workspace_id,teammate_id,email,password_hash) VALUES($1,$2,$3,$4)", [w, teammateId, i.email, hashPassword(String(p.password))]);
    await db.query("UPDATE teammate_invitations SET accepted_at=now(),accepted_teammate_id=$3 WHERE workspace_id=$1 AND id=$2", [w, i.id, teammateId]);
    await recordAudit(db, w, "invitation.accepted", { type: "teammate", id: teammateId, name }, { invitation: i.id, email: i.email, role: i.role_id });
    // Phase 16 C3b: where two-factor is required, it's set up before the first session.
    return challengeOrSession(db, w, teammateId, "invitation", client);
  });
}
