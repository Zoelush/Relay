import { assert, DomainError, type Sql } from "./db";
import { authorize } from "./policy";
import { seal, unseal } from "./connectors";
import { recordAudit } from "./audit";
import { capsOf, within } from "./people-settings";
import { looksLikeRecoveryCode, matchStep, newRecoveryCode, newSecret, normalRecoveryCode, otpauthUri } from "./totp";
import { normalAllowlist, normalIp, readAllowlist } from "./allowlists";

/**
 * Two-factor sign-in and Security › Access (phase 16, step C3b; docs/SECURITY_STEP4.md).
 *
 * - **Two-factor** is TOTP from an authenticator app, for teammates who sign in with a password.
 *   The key is sealed with the connector key; a code works once (never at or before the last step
 *   used). Ten recovery codes, kept only as hashes, each work once.
 * - **Your sign-in** turns it on (scan, then confirm a code; the recovery codes are shown once),
 *   replaces the recovery codes, or turns it off (both with a code). Wrong codes count toward the
 *   account's lock, like wrong passwords.
 * - **Security › Access** (`security.manage`): require two-factor (only once you have it yourself;
 *   it signs out password sessions without it), turn off a teammate's two-factor when they've lost
 *   their authenticator (within your permissions), and the two IP allowlists.
 *
 * Signing in with two-factor (the challenge between password and code) is in `server/accounts.ts`.
 */
export type TwoFactorEnvironment = { key?: string };
export const LOCK_AFTER = 10;
export const LOCK_MINUTES = 15;
const RECOVERY_CODES = 10;
const sealedAs = (teammateId: string) => ["two-factor:" + teammateId, "totp_secret"] as const;
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const keyOf = (env: TwoFactorEnvironment) => {
  assert(env.key, "UNAVAILABLE", "Two-factor isn't available: Relay has no encryption key set.", 503);
  return env.key!;
};
export const WRONG_CODE = "That code isn't right. Use the newest code from your app, or a recovery code.";

/** Relay's own sign-in and its settings are part of Settings › Security (`security_v1`). */
export async function securityOn(db: Sql, w: string) {
  assert(
    (await db.query("SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='security_v1' AND enabled", [w])).rows.length,
    "NOT_FOUND",
    "Relay sign-in isn't turned on for this workspace.",
    404,
  );
}

/**
 * Phase 16 C4a: whether single sign-on is enforced. Password sign-in, resets, invitations and
 * platform sign-in are then for owners only (break-glass); see `server/sso.ts`.
 */
export async function ssoEnforced(db: Sql, w: string) {
  return (await db.query("SELECT 1 FROM sso_connections WHERE workspace_id=$1 AND enforced", [w])).rows.length > 0;
}
const SSO_ONLY = "Your workspace signs in with single sign-on. Use “Sign in with single sign-on” instead.";
/** Refuses what enforced SSO leaves to owners, for a teammate who isn't one. */
export async function assertNotSsoOnly(db: Sql, w: string, roleId: string | null | undefined, message = SSO_ONLY) {
  if (roleId !== "owner" && (await ssoEnforced(db, w))) throw new DomainError("SSO_REQUIRED", message, 403);
}

/**
 * Signed in by the hosting platform (or the local development identity) rather than a Relay
 * session: with single sign-on enforced, only owners. Anyone else is sent to sign in.
 */
export async function assertPlatformAllowed(db: Sql, w: string, principal: string) {
  const r = (
    await db.query<{ owner: boolean }>(
      "SELECT t.role_id='owner' AS owner FROM sso_connections c LEFT JOIN teammates t ON t.workspace_id=c.workspace_id AND t.principal_id=$2 WHERE c.workspace_id=$1 AND c.enforced",
      [w, principal],
    )
  ).rows[0];
  if (r && !r.owner) throw new DomainError("SIGNED_OUT", "Your workspace signs in with single sign-on. Sign in again.", 401);
}

/** Whether a teammate has two-factor on, and how many recovery codes they have left. */
export async function twoFactorOf(db: Sql, w: string, teammateId: string) {
  const r = (
    await db.query<{ on: boolean; left: number }>(
      `SELECT f.enabled_at IS NOT NULL AS on,(SELECT count(*)::int FROM teammate_recovery_codes c WHERE c.workspace_id=f.workspace_id AND c.teammate_id=f.teammate_id AND c.used_at IS NULL) AS left
       FROM teammate_two_factor f WHERE f.workspace_id=$1 AND f.teammate_id=$2`,
      [w, teammateId],
    )
  ).rows[0];
  return { enabled: !!r?.on, recoveryCodesLeft: r?.on ? r.left : 0 };
}
export async function twoFactorRequired(db: Sql, w: string) {
  return !!(await db.query<{ r: boolean }>("SELECT require_two_factor AS r FROM security_settings WHERE workspace_id=$1", [w])).rows[0]?.r;
}

/** A new key, pending until a code confirms it: what to scan, and the key to type instead. */
export async function beginSetup(db: Sql, w: string, env: TwoFactorEnvironment, t: { id: string; email: string }) {
  const key = keyOf(env);
  assert(!(await twoFactorOf(db, w, t.id)).enabled, "TWO_FACTOR_ON", "Two-factor is already on.", 409);
  const secret = newSecret();
  await db.query(
    `INSERT INTO teammate_two_factor(workspace_id,teammate_id,secret_sealed) VALUES($1,$2,$3)
     ON CONFLICT(workspace_id,teammate_id) DO UPDATE SET secret_sealed=EXCLUDED.secret_sealed,last_step=NULL,created_at=now() WHERE teammate_two_factor.enabled_at IS NULL`,
    [w, t.id, await seal(key, w, ...sealedAs(t.id), secret)],
  );
  const workspace = (await db.query<{ name: string }>("SELECT brand AS name FROM workspace WHERE id=$1", [w])).rows[0]?.name ?? w;
  return { secret, uri: otpauthUri(secret, `${t.email} (${workspace})`, "Relay") };
}

async function newRecoveryCodes(db: Sql, w: string, teammateId: string) {
  await db.query("DELETE FROM teammate_recovery_codes WHERE workspace_id=$1 AND teammate_id=$2", [w, teammateId]);
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  for (const c of codes) await db.query("INSERT INTO teammate_recovery_codes(workspace_id,teammate_id,code_hash) VALUES($1,$2,$3)", [w, teammateId, await sha256(normalRecoveryCode(c))]);
  return codes;
}

/** The first code confirms the pending key: two-factor is on, and the recovery codes are returned once. Null if the code is wrong. */
export async function confirmSetup(db: Sql, w: string, env: TwoFactorEnvironment, t: { id: string; name: string }, code: unknown) {
  const key = keyOf(env);
  const f = (await db.query<{ secret_sealed: string; enabled_at: Date | null }>("SELECT secret_sealed,enabled_at FROM teammate_two_factor WHERE workspace_id=$1 AND teammate_id=$2 FOR UPDATE", [w, t.id])).rows[0];
  assert(f && !f.enabled_at, "NOT_FOUND", f ? "Two-factor is already on." : "Start setting up two-factor first.", f ? 409 : 404);
  const step = await matchStep(await unseal(key, w, ...sealedAs(t.id), f!.secret_sealed), String(code ?? ""), null);
  if (step === null) return null;
  await db.query("UPDATE teammate_two_factor SET enabled_at=now(),last_step=$3 WHERE workspace_id=$1 AND teammate_id=$2", [w, t.id, step]);
  const codes = await newRecoveryCodes(db, w, t.id);
  await recordAudit(db, w, "two_factor.enabled", { type: "teammate", id: t.id, name: t.name });
  return codes;
}

/** A code from the app (used once) or an unused recovery code: which it was, or null. */
export async function checkSecondFactor(db: Sql, w: string, env: TwoFactorEnvironment, t: { id: string; name: string }, code: unknown) {
  const given = typeof code === "string" ? code.trim() : "";
  const f = (
    await db.query<{ secret_sealed: string; last_step: string | null }>(
      "SELECT secret_sealed,last_step FROM teammate_two_factor WHERE workspace_id=$1 AND teammate_id=$2 AND enabled_at IS NOT NULL FOR UPDATE",
      [w, t.id],
    )
  ).rows[0];
  if (!f) return null;
  if (/^\d[\d\s]{5,8}$/.test(given)) {
    const step = await matchStep(await unseal(keyOf(env), w, ...sealedAs(t.id), f.secret_sealed), given, f.last_step === null ? null : Number(f.last_step));
    if (step === null) return null;
    await db.query("UPDATE teammate_two_factor SET last_step=$3 WHERE workspace_id=$1 AND teammate_id=$2", [w, t.id, step]);
    return "totp" as const;
  }
  if (!looksLikeRecoveryCode(given)) return null;
  const used = await db.query(
    "UPDATE teammate_recovery_codes SET used_at=now() WHERE workspace_id=$1 AND teammate_id=$2 AND code_hash=$3 AND used_at IS NULL RETURNING code_hash",
    [w, t.id, await sha256(normalRecoveryCode(given))],
  );
  if (!used.rows.length) return null;
  const left = (await twoFactorOf(db, w, t.id)).recoveryCodesLeft;
  await recordAudit(db, w, "two_factor.recovery_code_used", { type: "teammate", id: t.id, name: t.name }, { left });
  return "recovery" as const;
}

/** A wrong code counts toward the account's lock, as a wrong password does; true if it locked. */
export async function countWrongCode(db: Sql, w: string, t: { id: string; name: string }, details: Record<string, unknown> = {}) {
  const r = (
    await db.query<{ locked: boolean }>(
      `UPDATE teammate_credentials SET failed_count=CASE WHEN failed_count+1>=$3 THEN 0 ELSE failed_count+1 END,
         locked_until=CASE WHEN failed_count+1>=$3 THEN now()+($4::int*interval '1 minute') ELSE locked_until END
       WHERE workspace_id=$1 AND teammate_id=$2 RETURNING locked_until>now() AS locked`,
      [w, t.id, LOCK_AFTER, LOCK_MINUTES],
    )
  ).rows[0];
  await recordAudit(db, w, "session.two_factor_failed", { type: "teammate", id: t.id, name: t.name }, { ...details, locked: !!r?.locked });
  return !!r?.locked;
}
export async function lockedUntil(db: Sql, w: string, teammateId: string) {
  const r = (await db.query<{ locked_until: Date | null }>("SELECT locked_until FROM teammate_credentials WHERE workspace_id=$1 AND teammate_id=$2", [w, teammateId])).rows[0];
  return r?.locked_until && new Date(r.locked_until) > new Date() ? new Date(r.locked_until) : null;
}
export const lockedMessage = (until: Date) => `Too many attempts. Try again after ${until.toISOString().slice(11, 16)} UTC.`;

async function removeTwoFactor(db: Sql, w: string, teammateId: string) {
  await db.query("DELETE FROM teammate_recovery_codes WHERE workspace_id=$1 AND teammate_id=$2", [w, teammateId]);
  await db.query("DELETE FROM teammate_two_factor WHERE workspace_id=$1 AND teammate_id=$2", [w, teammateId]);
}

/* ------------------------------------------------------------------------------------------ */
/* Your sign-in: turning two-factor on and off, and recovery codes                             */
/* ------------------------------------------------------------------------------------------ */
/**
 * `two-factor-start`, `two-factor-confirm`, `two-factor-off` and `recovery-codes`. A refusal that
 * must outlive the transaction (a wrong code, counted toward the lock) is returned as `refused`
 * for the caller to throw after it commits.
 */
export async function changeTwoFactor(db: Sql, w: string, me: { id: string; name: string }, env: TwoFactorEnvironment, p: Record<string, unknown>) {
  await securityOn(db, w);
  const c = (await db.query<{ email: string }>("SELECT email FROM teammate_credentials WHERE workspace_id=$1 AND teammate_id=$2", [w, me.id])).rows[0];
  assert(c, "PASSWORD_FIRST", "Set a password first: two-factor protects signing in with it.", 409);
  if (p.action === "two-factor-start") return { setup: await beginSetup(db, w, env, { id: me.id, email: c.email }) };
  if (p.action === "two-factor-confirm") {
    const codes = await confirmSetup(db, w, env, me, p.code);
    if (!codes) throw new DomainError("WRONG_CODE", "That code isn't right. Check your phone's time is set automatically and use the newest code.", 400, { field: "code" });
    return { recoveryCodes: codes };
  }
  if (p.action === "two-factor-off" || p.action === "recovery-codes") {
    assert((await twoFactorOf(db, w, me.id)).enabled, "NOT_FOUND", "Two-factor isn't on.", 404);
    if (p.action === "two-factor-off") assert(!(await twoFactorRequired(db, w)), "TWO_FACTOR_REQUIRED", "Your workspace requires two-factor, so it can't be turned off.", 409);
    const locked = await lockedUntil(db, w, me.id);
    if (locked) return { refused: new DomainError("LOCKED", lockedMessage(locked), 429) };
    if (!(await checkSecondFactor(db, w, env, me, p.code))) {
      await countWrongCode(db, w, me, { where: "settings" });
      return { refused: new DomainError("WRONG_CODE", WRONG_CODE, 403, { field: "code" }) };
    }
    if (p.action === "recovery-codes") {
      const codes = await newRecoveryCodes(db, w, me.id);
      await recordAudit(db, w, "two_factor.recovery_codes_replaced", { type: "teammate", id: me.id, name: me.name });
      return { recoveryCodes: codes };
    }
    await removeTwoFactor(db, w, me.id);
    await recordAudit(db, w, "two_factor.disabled", { type: "teammate", id: me.id, name: me.name });
    return {};
  }
  throw new DomainError("INVALID_ACCOUNT", "Choose two-factor-start, two-factor-confirm, two-factor-off or recovery-codes.");
}

/* ------------------------------------------------------------------------------------------ */
/* Security › Access: require two-factor, teammates' two-factor, and the IP allowlists          */
/* ------------------------------------------------------------------------------------------ */
export async function readAccess(db: Sql, w: string, principal: string, client: { ip?: string | null }) {
  const me = await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  const s = (
    await db.query<{ require_two_factor: boolean; app: string[]; api: string[] }>(
      "SELECT require_two_factor,app_allowlist::text[] AS app,api_allowlist::text[] AS api FROM security_settings WHERE workspace_id=$1",
      [w],
    )
  ).rows[0];
  const teammates = (
    await db.query<{ id: string; name: string; email: string; on: boolean; left: number }>(
      `SELECT t.id,t.name,c.email,f.enabled_at IS NOT NULL AS on,
         (SELECT count(*)::int FROM teammate_recovery_codes r WHERE r.workspace_id=c.workspace_id AND r.teammate_id=c.teammate_id AND r.used_at IS NULL) AS left
       FROM teammate_credentials c JOIN teammates t ON t.workspace_id=c.workspace_id AND t.id=c.teammate_id
       LEFT JOIN teammate_two_factor f ON f.workspace_id=c.workspace_id AND f.teammate_id=c.teammate_id
       WHERE c.workspace_id=$1 ORDER BY lower(t.name),t.id LIMIT 1000`,
      [w],
    )
  ).rows;
  return {
    requireTwoFactor: !!s?.require_two_factor,
    youHaveTwoFactor: (await twoFactorOf(db, w, me.id)).enabled,
    appAllowlist: s?.app ?? [],
    apiAllowlist: s?.api ?? [],
    yourAddress: normalIp(client.ip),
    teammates: teammates.map((t) => ({ id: t.id, name: t.name, email: t.email, twoFactor: t.on, recoveryCodesLeft: t.on ? t.left : 0, you: t.id === me.id })),
  };
}

const settle = (db: Sql, w: string, columns: Record<string, unknown>, by: string) => {
  const names = Object.keys(columns);
  return db.query(
    `INSERT INTO security_settings(workspace_id,${names.join(",")},updated_by) VALUES($1,${names.map((n, i) => `$${i + 2}${n.endsWith("allowlist") ? "::cidr[]" : ""}`).join(",")},$${names.length + 2})
     ON CONFLICT(workspace_id) DO UPDATE SET ${names.map((n) => `${n}=EXCLUDED.${n}`).join(",")},updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [w, ...Object.values(columns), by],
  );
};

export async function changeAccess(db: Sql, w: string, principal: string, client: { ip?: string | null }, p: Record<string, unknown>) {
  const me = await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  if (p.action === "require-two-factor") {
    const on = p.on === true;
    if (on) assert((await twoFactorOf(db, w, me.id)).enabled, "TWO_FACTOR_FIRST", "Turn on two-factor for yourself first, in Your sign-in.", 409);
    await settle(db, w, { require_two_factor: on }, me.id);
    if (on) {
      // Password sessions without two-factor end; those teammates set it up when they next sign in.
      const ended = (
        await db.query<{ teammate_id: string; name: string; n: number }>(
          `WITH e AS (UPDATE teammate_sessions s SET revoked_at=now(),revoked_reason='Two-factor is now required.' WHERE s.workspace_id=$1 AND s.revoked_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM teammate_two_factor f WHERE f.workspace_id=s.workspace_id AND f.teammate_id=s.teammate_id AND f.enabled_at IS NOT NULL) RETURNING s.teammate_id)
           SELECT e.teammate_id,t.name,count(*)::int AS n FROM e JOIN teammates t ON t.workspace_id=$1 AND t.id=e.teammate_id GROUP BY e.teammate_id,t.name`,
          [w],
        )
      ).rows;
      for (const t of ended) await recordAudit(db, w, "session.revoked", { type: "teammate", id: t.teammate_id, name: t.name }, { sessions: t.n, reason: "two_factor_required" });
    }
    return readAccess(db, w, principal, client);
  }
  if (p.action === "allowlists") {
    const app = await normalAllowlist(db, readAllowlist(p.app, "app"), "app");
    const api = await normalAllowlist(db, readAllowlist(p.api, "api"), "api");
    if (app.length) {
      // Never a list that would shut out whoever saves it.
      const ip = normalIp(client.ip);
      if (!ip) throw new DomainError("ADDRESS_UNKNOWN", "Relay can't see your address here, so it can't check the app's list won't shut you out.", 409, { field: "app" });
      const inside = (await db.query("SELECT 1 WHERE $1::inet <<= ANY($2::cidr[])", [ip, app])).rows.length;
      if (!inside) throw new DomainError("WOULD_LOCK_OUT", `The app's list leaves out your own address (${ip}), so it would shut you out. Add it first.`, 409, { field: "app" });
    }
    await settle(db, w, { app_allowlist: app, api_allowlist: api }, me.id);
    return readAccess(db, w, principal, client);
  }
  if (p.action === "reset-two-factor") {
    const t = (await db.query<{ id: string; name: string; role_id: string }>("SELECT id,name,role_id FROM teammates WHERE workspace_id=$1 AND id=$2", [w, String(p.teammateId ?? "")])).rows[0];
    assert(t && (await twoFactorOf(db, w, t.id)).enabled, "NOT_FOUND", "That teammate doesn't have two-factor on.", 404);
    assert(t.id !== me.id, "YOURSELF", "Turn off your own two-factor in Your sign-in.", 409);
    if (!within(await capsOf(db, w, t.role_id), await capsOf(db, w, me.role_id)))
      throw new DomainError("ROLE_ABOVE_YOURS", "That teammate has permissions you don't, so you can't turn off their two-factor.", 403);
    await removeTwoFactor(db, w, t.id);
    await db.query("UPDATE teammate_sessions SET revoked_at=now(),revoked_reason=$3 WHERE workspace_id=$1 AND teammate_id=$2 AND revoked_at IS NULL", [w, t.id, `Two-factor turned off by ${me.name}.`]);
    await recordAudit(db, w, "two_factor.reset", { type: "teammate", id: t.id, name: t.name });
    return readAccess(db, w, principal, client);
  }
  throw new DomainError("INVALID_ACCESS", "Choose require-two-factor, allowlists or reset-two-factor.");
}
