import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { seal, unseal } from "./connectors";
import { recordAudit } from "./audit";
import { enqueueJob, type Job } from "./jobs";
import { capsOf, within } from "./people-settings";
import { checkAddress, FetchRefused, safeFetch, safeRequest, type FetchPolicy } from "./safe-fetch";
import type { DnsResolver } from "./email-providers";
import { actAs, startSession, type ClientInfo } from "./accounts";
import { securityOn, ssoEnforced } from "./two-factor";
import { readCertificate, SAML_ACS_PATH, SAML_METADATA_PATH, samlAuthorize, samlMetadata, samlProfile, spEntityId, type SamlSettings } from "./saml";

/**
 * Single sign-on (phase 16, steps C4a and C4b; docs/SECURITY_STEP5.md, STEP6.md): one connection
 * per workspace, OIDC or SAML 2.0 (`server/saml.ts`), sharing domains, group mappings, identities
 * and enforcement. Only proving who the person is differs; `admit` decides who they are in Relay.
 *
 * - **Settings › Security › Single sign-on** (`security.manage`): the connection (its endpoints read
 *   from the issuer's discovery document; the client secret sealed with the connector key, never
 *   returned), email domains verified by a DNS TXT record (the `sso.domain.check` job), and an
 *   ordered list of groups to roles (never the owner role, never above the manager's own).
 * - **Signing in** (through the host, `/auth/sso` and `/auth/sso/callback`): the authorization code
 *   flow with PKCE, a nonce and a state bound to the browser that started it (`relay_sso` cookie).
 *   The ID token is checked with `jose` against the issuer's keys. Only an email the provider says is
 *   verified, at a verified domain, signs in. The identity is found by the provider's subject; the
 *   first time, a teammate with that email is linked or one is made just in time. The first mapped
 *   group decides the role at every sign-in (owners are never changed); no match is refused.
 * - **Enforced SSO** (`ssoEnforced`, checked in `server/accounts.ts` and by the API): password
 *   sign-in, resets, invitations and platform sign-in stop for everyone but owners (break-glass).
 */
export type SsoEnvironment = { key?: string; policy?: FetchPolicy; dns?: DnsResolver };
const LOGIN_MINUTES = 10;
const TIMEOUT = 10_000;
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
const keyOf = (env: SsoEnvironment) => {
  assert(env.key, "UNAVAILABLE", "Single sign-on isn't available: Relay has no encryption key set.", 503);
  return env.key!;
};
const sealedAs = (connectionId: string) => [`sso:${connectionId}`, "client_secret"] as const;
export const callbackPath = "/auth/sso/callback";
const normalDomain = (v: unknown) => {
  const d = typeof v === "string" ? v.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "") : "";
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) || d.length > 253)
    throw new DomainError("INVALID_FIELD", "Enter a domain, like example.com.", 400, { field: "domain" });
  return d;
};
export const verificationName = (domain: string) => `_relay-verification.${domain}`;
export const verificationValue = (token: string) => `relay-verification=${token}`;

type Connection = {
  id: string;
  protocol: "oidc" | "saml";
  name: string;
  issuer: string;
  client_id: string | null;
  client_secret_sealed: string | null;
  authorization_endpoint: string | null;
  token_endpoint: string | null;
  jwks_uri: string | null;
  entry_point: string | null;
  idp_cert: string | null;
  groups_claim: string;
  enabled: boolean;
  enforced: boolean;
  last_success_at: Date | null;
  last_error: string | null;
};
const connectionOf = async (db: Sql, w: string) => (await db.query<Connection>("SELECT * FROM sso_connections WHERE workspace_id=$1", [w])).rows[0] ?? null;
/** A SAML connection's settings, for `server/saml.ts`. */
const samlOf = (c: Connection, origin: string): SamlSettings => ({ entryPoint: c.entry_point!, idpIssuer: c.issuer, idpCert: c.idp_cert!, origin });

export { ssoEnforced };

/* ------------------------------------------------------------------------------------------ */
/* Settings › Security › Single sign-on                                                         */
/* ------------------------------------------------------------------------------------------ */
export async function readSso(db: Sql, w: string, principal: string, client: ClientInfo) {
  await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  const c = await connectionOf(db, w);
  const domains = (
    await db.query<{ domain: string; token: string; verified_at: Date | null; checked_at: Date | null; error: string | null }>(
      "SELECT domain,token,verified_at,checked_at,error FROM sso_domains WHERE workspace_id=$1 ORDER BY domain",
      [w],
    )
  ).rows;
  const mappings = c
    ? (await db.query<{ group_name: string; role_id: string }>("SELECT group_name,role_id FROM sso_role_mappings WHERE workspace_id=$1 AND connection_id=$2 ORDER BY position", [w, c.id])).rows
    : [];
  const roles = (await db.query<{ id: string; name: string }>("SELECT id,name FROM roles WHERE workspace_id=$1 AND id<>'owner' ORDER BY lower(name)", [w])).rows;
  const people = c ? Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM sso_identities WHERE workspace_id=$1 AND connection_id=$2", [w, c.id])).rows[0].n) : 0;
  return {
    redirectUri: client.origin ? client.origin + callbackPath : null,
    // C4b: what a SAML identity provider is given about Relay.
    serviceProvider: client.origin ? { entityId: spEntityId(client.origin), acsUrl: client.origin + SAML_ACS_PATH, metadataUrl: client.origin + SAML_METADATA_PATH } : null,
    connection: c && {
      id: c.id,
      protocol: c.protocol,
      name: c.name,
      issuer: c.issuer,
      clientId: c.client_id,
      entryPoint: c.entry_point,
      idpCert: c.idp_cert,
      hasSecret: !!c.client_secret_sealed,
      groupsClaim: c.groups_claim,
      enabled: c.enabled,
      enforced: c.enforced,
      lastSuccessAt: c.last_success_at ? new Date(c.last_success_at).toISOString() : null,
      lastError: c.last_error,
      people,
    },
    domains: domains.map((d) => ({
      domain: d.domain,
      record: { type: "TXT", name: verificationName(d.domain), value: verificationValue(d.token) },
      verified: !!d.verified_at,
      checkedAt: d.checked_at ? new Date(d.checked_at).toISOString() : null,
      error: d.error,
    })),
    mappings: mappings.map((m) => ({ group: m.group_name, roleId: m.role_id })),
    roles,
  };
}

/** The issuer's discovery document: where to send people, where to swap the code, and its keys. Read before the transaction. */
export async function discover(env: SsoEnvironment, issuer: unknown) {
  const given = typeof issuer === "string" ? issuer.trim().replace(/\/+$/, "") : "";
  const bad = (why: string) => new DomainError("INVALID_FIELD", why, 400, { field: "issuer" });
  if (!given) throw bad("Enter the issuer URL from your identity provider.");
  try {
    checkAddress(given, env.policy);
  } catch {
    throw bad("The issuer must be a public https address.");
  }
  let doc: Record<string, unknown>;
  try {
    const r = await safeFetch(given + "/.well-known/openid-configuration", env.policy, { accept: "application/json" }, { maxBytes: 256_000, timeoutMs: TIMEOUT });
    if (r.status !== 200) throw new Error();
    doc = JSON.parse(r.body) as Record<string, unknown>;
  } catch {
    throw bad("Relay couldn't read that issuer's OpenID configuration. Check the issuer URL.");
  }
  const endpoints = ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const;
  if (typeof doc.issuer !== "string" || doc.issuer.replace(/\/+$/, "") !== given) throw bad("That configuration names a different issuer.");
  for (const e of endpoints) {
    try {
      checkAddress(String(doc[e] ?? ""), env.policy);
    } catch {
      throw bad(`That configuration's ${e.replace(/_/g, " ")} isn't a public https address.`);
    }
  }
  return { issuer: doc.issuer, authorization_endpoint: String(doc.authorization_endpoint), token_endpoint: String(doc.token_endpoint), jwks_uri: String(doc.jwks_uri) };
}
export type Discovered = Awaited<ReturnType<typeof discover>>;

export async function changeSso(db: Sql, w: string, principal: string, env: SsoEnvironment, client: ClientInfo, p: Record<string, unknown>, discovered?: Discovered | null) {
  const me = await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  const c = await connectionOf(db, w);
  const done = () => readSso(db, w, principal, client);
  if (p.action === "connection" && p.protocol === "saml") {
    // C4b: the provider's SSO URL (the browser goes there), its entity ID and its signing certificate.
    const entryPoint = typeof p.entryPoint === "string" ? p.entryPoint.trim() : "";
    try {
      checkAddress(entryPoint, env.policy);
    } catch {
      throw new DomainError("INVALID_FIELD", "The SSO URL must be a public https address.", 400, { field: "entryPoint" });
    }
    const idpIssuer = typeof p.idpIssuer === "string" ? p.idpIssuer.trim() : "";
    assert(idpIssuer && idpIssuer.length <= 500, "INVALID_FIELD", "Enter the identity provider's entity ID (its issuer).");
    const cert = readCertificate(p.idpCert);
    const groupsClaim = typeof p.groupsClaim === "string" && p.groupsClaim.trim() ? p.groupsClaim.trim() : "groups";
    assert(/^[\w.:/-]{1,200}$/.test(groupsClaim), "INVALID_FIELD", "The groups attribute is an attribute name, like groups.");
    const name = typeof p.name === "string" ? p.name.trim().slice(0, 80) : "";
    await db.query(
      `INSERT INTO sso_connections(workspace_id,id,protocol,name,issuer,entry_point,idp_cert,groups_claim) VALUES($1,$2,'saml',$3,$4,$5,$6,$7)
       ON CONFLICT(workspace_id,id) DO UPDATE SET protocol='saml',name=EXCLUDED.name,issuer=EXCLUDED.issuer,entry_point=EXCLUDED.entry_point,idp_cert=EXCLUDED.idp_cert,groups_claim=EXCLUDED.groups_claim,
         client_id=NULL,client_secret_sealed=NULL,authorization_endpoint=NULL,token_endpoint=NULL,jwks_uri=NULL,
         last_success_at=CASE WHEN sso_connections.protocol='saml' AND sso_connections.issuer=EXCLUDED.issuer AND sso_connections.entry_point=EXCLUDED.entry_point AND sso_connections.idp_cert=EXCLUDED.idp_cert THEN sso_connections.last_success_at END,updated_at=now()`,
      [w, c?.id ?? crypto.randomUUID(), name, idpIssuer, entryPoint, cert, groupsClaim],
    );
    // A changed provider or certificate hasn't been shown to work yet: it can't stay enforced.
    await db.query("UPDATE sso_connections SET enforced=false WHERE workspace_id=$1 AND enforced AND last_success_at IS NULL", [w]);
    return done();
  }
  if (p.action === "connection") {
    assert(discovered, "INVALID_FIELD", "Enter the issuer URL from your identity provider.");
    const clientId = typeof p.clientId === "string" ? p.clientId.trim() : "";
    assert(clientId && clientId.length <= 300, "INVALID_FIELD", "Enter the client ID your identity provider gave Relay.");
    const secret = typeof p.clientSecret === "string" ? p.clientSecret.trim() : "";
    assert(secret || c?.client_secret_sealed, "INVALID_FIELD", "Enter the client secret your identity provider gave Relay.");
    assert(secret.length <= 2000, "INVALID_FIELD", "That client secret is too long.");
    const groupsClaim = typeof p.groupsClaim === "string" && p.groupsClaim.trim() ? p.groupsClaim.trim() : "groups";
    assert(/^[\w.:/-]{1,100}$/.test(groupsClaim), "INVALID_FIELD", "The groups claim is a claim name, like groups.");
    const name = typeof p.name === "string" ? p.name.trim().slice(0, 80) : "";
    const id = c?.id ?? crypto.randomUUID();
    assert(secret || c?.protocol === "oidc", "INVALID_FIELD", "Enter the client secret your identity provider gave Relay.");
    const sealed = secret ? await seal(keyOf(env), w, ...sealedAs(id), secret) : c!.client_secret_sealed;
    await db.query(
      `INSERT INTO sso_connections(workspace_id,id,protocol,name,issuer,client_id,client_secret_sealed,authorization_endpoint,token_endpoint,jwks_uri,groups_claim)
       VALUES($1,$2,'oidc',$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(workspace_id,id) DO UPDATE SET protocol='oidc',entry_point=NULL,idp_cert=NULL,name=EXCLUDED.name,issuer=EXCLUDED.issuer,client_id=EXCLUDED.client_id,client_secret_sealed=EXCLUDED.client_secret_sealed,
         authorization_endpoint=EXCLUDED.authorization_endpoint,token_endpoint=EXCLUDED.token_endpoint,jwks_uri=EXCLUDED.jwks_uri,groups_claim=EXCLUDED.groups_claim,
         last_success_at=CASE WHEN sso_connections.protocol='oidc' AND sso_connections.issuer=EXCLUDED.issuer AND sso_connections.client_id=EXCLUDED.client_id THEN sso_connections.last_success_at END,updated_at=now()`,
      [w, id, name, discovered!.issuer, clientId, sealed, discovered!.authorization_endpoint, discovered!.token_endpoint, discovered!.jwks_uri, groupsClaim],
    );
    // A different provider hasn't been shown to work yet: it can't stay enforced.
    await db.query("UPDATE sso_connections SET enforced=false WHERE workspace_id=$1 AND enforced AND last_success_at IS NULL", [w]);
    return done();
  }
  // Domains don't need the connection; turning it on, enforcing it and its mappings do.
  const need = () => {
    assert(c, "NOT_FOUND", "Set up the connection first.", 404);
    return c!;
  };
  if (p.action === "enabled") {
    need();
    const on = p.on === true;
    await db.query("UPDATE sso_connections SET enabled=$2,enforced=enforced AND $2,updated_at=now() WHERE workspace_id=$1", [w, on]);
    return done();
  }
  if (p.action === "enforced") {
    const on = p.on === true;
    const c = need();
    if (on) {
      assert(c.enabled, "SSO_NOT_READY", "Turn single sign-on on first.", 409);
      assert(
        (await db.query("SELECT 1 FROM sso_domains WHERE workspace_id=$1 AND verified_at IS NOT NULL", [w])).rows.length,
        "SSO_NOT_READY",
        "Verify at least one domain first.",
        409,
      );
      assert(c.last_success_at, "SSO_NOT_READY", "Sign in with single sign-on once first, so you know it works.", 409);
    }
    await db.query("UPDATE sso_connections SET enforced=$2,updated_at=now() WHERE workspace_id=$1", [w, on]);
    if (on) {
      // Password sessions end for everyone but owners; they sign in again with SSO.
      const ended = (
        await db.query<{ teammate_id: string; name: string; n: number }>(
          `WITH e AS (UPDATE teammate_sessions s SET revoked_at=now(),revoked_reason='Single sign-on is now required.' FROM teammates t
             WHERE s.workspace_id=$1 AND s.revoked_at IS NULL AND s.method<>'sso' AND t.workspace_id=s.workspace_id AND t.id=s.teammate_id AND t.role_id<>'owner' RETURNING s.teammate_id,t.name)
           SELECT teammate_id,name,count(*)::int AS n FROM e GROUP BY teammate_id,name`,
          [w],
        )
      ).rows;
      for (const t of ended) await recordAudit(db, w, "session.revoked", { type: "teammate", id: t.teammate_id, name: t.name }, { sessions: t.n, reason: "sso_enforced" });
    }
    return done();
  }
  if (p.action === "mappings") {
    const list = Array.isArray(p.mappings) ? (p.mappings as { group?: unknown; roleId?: unknown }[]) : [];
    assert(list.length <= 50, "INVALID_FIELD", "Up to 50 group mappings.");
    const c = need();
    const mine = await capsOf(db, w, me.role_id);
    const rows: { group: string; roleId: string }[] = [];
    for (const m of list) {
      const group = typeof m.group === "string" ? m.group.trim() : "";
      const roleId = String(m.roleId ?? "");
      assert(group && group.length <= 200, "INVALID_FIELD", "Each mapping needs a group name.");
      assert(roleId !== "owner", "INVALID_FIELD", "Owners are chosen in Relay, never by a group.");
      assert((await db.query("SELECT 1 FROM roles WHERE workspace_id=$1 AND id=$2", [w, roleId])).rows.length, "ROLE_NOT_FOUND", "Choose a role for each group.", 404);
      if (!within(await capsOf(db, w, roleId), mine)) throw new DomainError("ROLE_ABOVE_YOURS", "You can only map groups to roles within your own permissions.", 403);
      rows.push({ group, roleId });
    }
    await db.query("DELETE FROM sso_role_mappings WHERE workspace_id=$1 AND connection_id=$2", [w, c.id]);
    for (const [i, m] of rows.entries())
      await db.query("INSERT INTO sso_role_mappings(workspace_id,connection_id,position,group_name,role_id) VALUES($1,$2,$3,$4,$5)", [w, c.id, i, m.group, m.roleId]);
    return done();
  }
  if (p.action === "add-domain") {
    const domain = normalDomain(p.domain);
    const r = await db.query("INSERT INTO sso_domains(workspace_id,domain,token) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING domain", [w, domain, random(32)]);
    assert(r.rows.length, "DOMAIN_TAKEN", "That domain is already listed.", 409);
    return done();
  }
  if (p.action === "verify-domain") {
    const domain = normalDomain(p.domain);
    const r = await db.query("UPDATE sso_domains SET error=NULL,checked_at=NULL WHERE workspace_id=$1 AND domain=$2 RETURNING domain", [w, domain]);
    assert(r.rows.length, "NOT_FOUND", "That domain isn't listed.", 404);
    await enqueueJob(db, w, "sso.domain.check", { domain }, {});
    return done();
  }
  if (p.action === "remove-domain") {
    const domain = normalDomain(p.domain);
    if (c?.enforced) {
      const others = (await db.query("SELECT 1 FROM sso_domains WHERE workspace_id=$1 AND domain<>$2 AND verified_at IS NOT NULL", [w, domain])).rows.length;
      assert(others, "SSO_ENFORCED", "Single sign-on is enforced: turn that off before removing its last verified domain.", 409);
    }
    const r = await db.query("DELETE FROM sso_domains WHERE workspace_id=$1 AND domain=$2 RETURNING domain", [w, domain]);
    assert(r.rows.length, "NOT_FOUND", "That domain isn't listed.", 404);
    return done();
  }
  throw new DomainError("INVALID_SSO", "Choose connection, enabled, enforced, mappings, add-domain, verify-domain or remove-domain.");
}

/** The `sso.domain.check` job: the domain's TXT record, through the DNS port. */
export async function checkSsoDomainJob(connect: Connect, env: SsoEnvironment, job: Job) {
  const w = job.workspace_id;
  const { domain } = job.payload as { domain: string };
  const save = (verified: boolean, error: string | null) =>
    tenant(connect, w, (db) =>
      db.query(
        "UPDATE sso_domains SET checked_at=now(),error=$4,verified_at=CASE WHEN $3 THEN COALESCE(verified_at,now()) ELSE verified_at END WHERE workspace_id=$1 AND domain=$2",
        [w, domain, verified, error],
      ),
    );
  const row = await tenant(connect, w, async (db) => (await db.query<{ token: string }>("SELECT token FROM sso_domains WHERE workspace_id=$1 AND domain=$2", [w, domain])).rows[0]);
  if (!row) return { done: true, result: { skipped: true } };
  if (!env.dns) {
    await save(false, "Relay can't look up DNS records here.");
    return { done: true, result: { checked: false } };
  }
  let values: string[];
  try {
    values = await env.dns.lookup(verificationName(domain), "TXT");
  } catch {
    await save(false, "The DNS lookup failed. Try again in a few minutes.");
    return { done: true, result: { checked: false } };
  }
  const found = values.some((v) => v.trim() === verificationValue(row.token));
  try {
    await save(found, found ? null : `No TXT record ${verificationName(domain)} with the value shown yet. DNS changes can take a while.`);
  } catch {
    // The unique index: another workspace has verified this domain.
    await save(false, "Another Relay workspace has already verified this domain.");
    return { done: true, result: { verified: false, taken: true } };
  }
  return { done: true, result: { verified: found } };
}

/* ------------------------------------------------------------------------------------------ */
/* Signing in (through the host's /auth/sso and /auth/sso/callback; never with a principal)     */
/* ------------------------------------------------------------------------------------------ */
/** For the sign-in page: whether to offer single sign-on, and whether it's the only way in. */
export async function ssoInfo(connect: Connect, w: string) {
  return tenant(connect, w, async (db) => {
    const c = (await db.query<{ name: string; enforced: boolean }>("SELECT name,enforced FROM sso_connections WHERE workspace_id=$1 AND enabled", [w])).rows[0];
    return { sso: c ? { name: c.name || "single sign-on", enforced: c.enforced } : null };
  });
}

/** Where to send the browser, and the login token the host keeps in its cookie. */
export async function startSso(connect: Connect, w: string, p: Record<string, unknown>, client: ClientInfo) {
  assert(client.origin, "UNAVAILABLE", "Relay doesn't know its own address for single sign-on.", 503);
  return tenant(connect, w, async (db) => {
    const c = (await db.query<Connection>("SELECT * FROM sso_connections WHERE workspace_id=$1 AND enabled", [w])).rows[0];
    assert(c, "SSO_OFF", "Single sign-on isn't turned on for this workspace.", 404);
    const login = `relay_sso_${b64(w)}_${random(40)}`;
    const state = random(32);
    const nonce = random(32);
    const verifier = random(64);
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const next = typeof p.next === "string" && /^\/(?!\/)[\w\-./#?=&%]*$/.test(p.next) ? p.next : null;
    // C4b: SAML's request (by HTTP-Redirect), its RelayState the login's state, its ID kept for InResponseTo.
    const saml = c.protocol === "saml" ? await samlAuthorize(samlOf(c, client.origin!), state) : null;
    await db.query(
      "INSERT INTO sso_logins(workspace_id,id,connection_id,token_hash,state,nonce,verifier,next,expires_at,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+($9::int*interval '1 minute'),$10)",
      [w, crypto.randomUUID(), c.id, await sha256(login), state, nonce, verifier, next, LOGIN_MINUTES, saml?.requestId ?? null],
    );
    if (saml) return { url: saml.url, login };
    const url = new URL(c.authorization_endpoint!);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: c.client_id!,
      redirect_uri: client.origin + callbackPath,
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }))
      url.searchParams.set(k, v);
    return { url: url.toString(), login };
  });
}

/**
 * C4b: the provider's POST to the ACS. It can't carry the browser's Lax cookie, so the response is
 * only parked on the login its RelayState names (unread until then), and the host sends the browser
 * on to `/auth/sso/callback`, which does carry it: only that browser finishes.
 */
export async function samlAcs(connect: Connect, w: string, p: Record<string, unknown>) {
  const response = typeof p.samlResponse === "string" ? p.samlResponse : "";
  assert(response && response.length <= 300_000 && typeof p.relayState === "string", "SSO_EXPIRED", "That sign-in has expired. Start again.", 401);
  const parked = await tenant(connect, w, (db) =>
    db.query(
      `UPDATE sso_logins l SET saml_response=$3 FROM sso_connections c WHERE l.workspace_id=$1 AND l.state=$2 AND l.used_at IS NULL AND l.saml_response IS NULL AND l.expires_at>now()
         AND l.request_id IS NOT NULL AND c.workspace_id=l.workspace_id AND c.id=l.connection_id AND c.protocol='saml' RETURNING l.id`,
      [w, p.relayState, response],
    ),
  );
  assert(parked.rows.length, "SSO_EXPIRED", "That sign-in has expired. Start again.", 401);
  return { state: p.relayState };
}

/** C4b: Relay's service provider metadata, for the identity provider to import (a SAML connection only). */
export async function ssoMetadata(connect: Connect, w: string, client: ClientInfo) {
  assert(client.origin, "UNAVAILABLE", "Relay doesn't know its own address for single sign-on.", 503);
  return tenant(connect, w, async (db) => {
    const c = await connectionOf(db, w);
    assert(c?.protocol === "saml", "NOT_FOUND", "This workspace has no SAML connection.", 404);
    return { xml: samlMetadata(samlOf(c!, client.origin!)) };
  });
}

type Claims = { sub: string; email: string; name: string; groups: string[] };
const FAILED = "Your identity provider didn't confirm the sign-in. Try again, or ask someone who manages security to check single sign-on.";

/** The code from the provider: swapped for an ID token, checked, then the teammate's session. */
export async function finishSso(connect: Connect, w: string, env: SsoEnvironment, p: Record<string, unknown>, client: ClientInfo) {
  const m = typeof p.login === "string" ? /^relay_sso_([A-Za-z0-9_-]{2,140})_([A-Za-z0-9]{40})$/.exec(p.login) : null;
  assert(m && unb64(m[1]) === w, "SSO_EXPIRED", "That sign-in has expired. Start again.", 401);
  // 1. The login, used once and only by the browser that started it.
  const login = await tenant(connect, w, async (db) => {
    const l = (
      await db.query<{ id: string; state: string; nonce: string; verifier: string; next: string | null; expires_at: Date; used_at: Date | null; request_id: string | null; saml_response: string | null }>(
        "SELECT id,state,nonce,verifier,next,expires_at,used_at,request_id,saml_response FROM sso_logins WHERE workspace_id=$1 AND token_hash=$2 FOR UPDATE",
        [w, await sha256(String(p.login))],
      )
    ).rows[0];
    if (!l || l.used_at) return null;
    // Any return uses the login up, even one with the wrong state.
    await db.query("UPDATE sso_logins SET used_at=now(),saml_response=NULL WHERE workspace_id=$1 AND id=$2", [w, l.id]);
    if (new Date(l.expires_at) <= new Date() || l.state !== p.state) return null;
    const c = (await db.query<Connection>("SELECT * FROM sso_connections WHERE workspace_id=$1 AND enabled", [w])).rows[0];
    return c ? { ...l, c } : null;
  });
  assert(login, "SSO_EXPIRED", "That sign-in has expired. Start again.", 401);
  const c = login!.c;
  const refuse = async (code: string, message: string, status: number, details: Record<string, unknown>, error?: string) => {
    await tenant(connect, w, async (db) => {
      if (error) await db.query("UPDATE sso_connections SET last_error=$2 WHERE workspace_id=$1", [w, error.slice(0, 300)]);
      await recordAudit(db, w, "session.sso_refused", { type: "sso_connection", id: c.id, name: c.name }, { ...details, ip: client.ip ?? null });
    });
    return new DomainError(code, message, status);
  };
  if (typeof p.error === "string" && p.error) throw await refuse("SSO_DENIED", "Your identity provider didn't let you sign in.", 403, { reason: "provider_error", error: p.error.slice(0, 100) });

  // 2. Who the provider says it is. C4b, SAML: the parked response, checked; OIDC: the code below.
  let claims: Claims;
  if (c.protocol === "saml") {
    assert(login!.saml_response, "SSO_EXPIRED", "That sign-in has expired. Start again.", 401);
    let profile: Awaited<ReturnType<typeof samlProfile>>;
    try {
      profile = await samlProfile(samlOf(c, client.origin!), login!.saml_response!, login!.request_id, c.groups_claim);
    } catch (e) {
      if (e instanceof DomainError) throw await refuse(e.code, e.message, e.status, { reason: e.code === "SSO_DENIED" ? "provider_error" : "nameid_transient" });
      throw await refuse("SSO_FAILED", FAILED, 502, { reason: "saml" }, e instanceof Error ? e.message : "The SAML response couldn't be checked.");
    }
    if (!profile.email) throw await refuse("SSO_EMAIL", "Your identity provider didn't share an email address.", 403, { reason: "email_missing", subject: profile.subject });
    claims = { sub: profile.subject, email: profile.email, name: profile.name ?? profile.email.split("@")[0], groups: profile.groups };
    return admit(connect, w, c, claims, login!.next, client);
  }
  assert(typeof p.code === "string" && p.code.length <= 2000, "SSO_EXPIRED", "That sign-in has expired. Start again.", 401);

  // 2. The code swapped for tokens, and the ID token checked against the issuer's keys.
  try {
    const secret = await unseal(keyOf(env), w, ...sealedAs(c.id), c.client_secret_sealed ?? "");
    const r = await safeRequest(
      c.token_endpoint!,
      env.policy ?? {},
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          authorization: "Basic " + btoa(encodeURIComponent(c.client_id!) + ":" + encodeURIComponent(secret)),
        },
        body: new URLSearchParams({ grant_type: "authorization_code", code: String(p.code), redirect_uri: client.origin + callbackPath, code_verifier: login!.verifier }).toString(),
      },
      { maxBytes: 256_000, timeoutMs: TIMEOUT },
    );
    if (r.status !== 200) throw new Error(`The token endpoint answered ${r.status}.`);
    const idToken = (JSON.parse(r.body) as { id_token?: string }).id_token;
    if (!idToken) throw new Error("The token endpoint sent no ID token.");
    const keys = await safeFetch(c.jwks_uri!, env.policy, { accept: "application/json" }, { maxBytes: 256_000, timeoutMs: TIMEOUT });
    if (keys.status !== 200) throw new Error(`The keys address answered ${keys.status}.`);
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(JSON.parse(keys.body) as JSONWebKeySet), {
      issuer: c.issuer,
      audience: c.client_id!,
      algorithms: ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"],
      maxTokenAge: "10 minutes",
    });
    if (payload.nonce !== login!.nonce) throw new Error("The ID token's nonce doesn't match.");
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    const verified = payload.email_verified === true || payload.email_verified === "true";
    if (!payload.sub || !email || !verified) throw await refuse("SSO_EMAIL", "Your identity provider didn't share a verified email address.", 403, { reason: "email_unverified", subject: payload.sub ?? null });
    const raw = payload[c.groups_claim];
    const groups = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).filter((g): g is string => typeof g === "string").slice(0, 500);
    const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim().slice(0, 80) : email.split("@")[0];
    claims = { sub: String(payload.sub).slice(0, 255), email, name, groups };
  } catch (e) {
    if (e instanceof DomainError) throw e;
    const why = e instanceof FetchRefused ? `The identity provider couldn't be reached (${e.code}).` : e instanceof Error ? e.message : "The sign-in couldn't be checked.";
    throw await refuse("SSO_FAILED", FAILED, 502, { reason: "token" }, why);
  }

  return admit(connect, w, c, claims, login!.next, client);
}

/** 3. Who they are in Relay, for either protocol: decided inside the transaction, refused after it commits (refusals are kept). */
async function admit(connect: Connect, w: string, c: Connection, claims: Claims, next: string | null, client: ClientInfo) {
  const outcome = await tenant(connect, w, async (db) => {
    const no = async (code: string, message: string, reason: string) => {
      await recordAudit(db, w, "session.sso_refused", { type: "sso_connection", id: c.id, name: c.name }, { reason, email: claims.email, ip: client.ip ?? null });
      return { refused: message, code, status: 403 } as const;
    };
    const domain = claims.email.split("@")[1];
    if (!(await db.query("SELECT 1 FROM sso_domains WHERE workspace_id=$1 AND domain=$2 AND verified_at IS NOT NULL", [w, domain])).rows.length)
      return no("SSO_DOMAIN", `${domain} isn't a verified domain for this workspace's single sign-on.`, "domain_unverified");
    const mapping = (
      await db.query<{ role_id: string }>(
        "SELECT role_id FROM sso_role_mappings WHERE workspace_id=$1 AND connection_id=$2 AND group_name=ANY($3::text[]) ORDER BY position LIMIT 1",
        [w, c.id, claims.groups],
      )
    ).rows[0];
    let t = (
      await db.query<{ id: string; name: string; role_id: string }>(
        "SELECT t.id,t.name,t.role_id FROM sso_identities i JOIN teammates t ON t.workspace_id=i.workspace_id AND t.id=i.teammate_id WHERE i.workspace_id=$1 AND i.connection_id=$2 AND i.subject=$3",
        [w, c.id, claims.sub],
      )
    ).rows[0];
    if (!t) {
      // First sign-in: a teammate who signs in with this email is linked; otherwise one is made.
      t = (
        await db.query<{ id: string; name: string; role_id: string }>(
          `SELECT t.id,t.name,t.role_id FROM teammate_credentials cr JOIN teammates t ON t.workspace_id=cr.workspace_id AND t.id=cr.teammate_id
           WHERE cr.workspace_id=$1 AND cr.email=$2 AND NOT EXISTS (SELECT 1 FROM sso_identities i WHERE i.workspace_id=t.workspace_id AND i.connection_id=$3 AND i.teammate_id=t.id)`,
          [w, claims.email, c.id],
        )
      ).rows[0];
      if (!t && !mapping) return no("SSO_NO_ROLE", "Your groups don't give you access to this workspace. Ask someone who manages security.", "no_role");
      if (!t) {
        const id = crypto.randomUUID();
        await actAs(db, { id, name: claims.name });
        await db.query("INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES($1,$2,$3,$4,$5)", [w, id, "relay:" + id, claims.name, mapping!.role_id]);
        t = { id, name: claims.name, role_id: mapping!.role_id };
      }
      await db.query("INSERT INTO sso_identities(workspace_id,connection_id,subject,teammate_id,email,groups) VALUES($1,$2,$3,$4,$5,$6)", [w, c.id, claims.sub, t.id, claims.email, claims.groups]);
    } else
      await db.query("UPDATE sso_identities SET email=$4,groups=$5,last_sign_in_at=now() WHERE workspace_id=$1 AND connection_id=$2 AND subject=$3", [w, c.id, claims.sub, claims.email, claims.groups]);
    await actAs(db, t);
    // The provider's groups decide the role at every sign-in; an owner is never changed by them.
    if (t.role_id !== "owner") {
      if (!mapping) return no("SSO_NO_ROLE", "Your groups don't give you access to this workspace. Ask someone who manages security.", "no_role");
      if (mapping.role_id !== t.role_id) await db.query("UPDATE teammates SET role_id=$3 WHERE workspace_id=$1 AND id=$2", [w, t.id, mapping.role_id]);
    }
    await db.query("UPDATE sso_connections SET last_success_at=now(),last_error=NULL WHERE workspace_id=$1", [w]);
    return { ...(await startSession(db, w, t.id, "sso", client)), next: next ?? "/agent" };
  });
  if ("refused" in outcome) {
    const r = outcome as { refused: string; code: string; status: number };
    throw new DomainError(r.code, r.refused, r.status);
  }
  return outcome;
}
