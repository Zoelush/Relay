import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { saveRole } from "../server/people-settings";
import { acceptInvitation, changeAccount, changeInvitations, resolveSession, signIn } from "../server/accounts";
import { changeSso, checkSsoDomainJob, discover, finishSso, readSso, ssoInfo, startSso, verificationName, verificationValue } from "../server/sso";
import { bridgeAgentRequest, bridgeSsoRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { LOCAL_IDP_CLIENT, startLocalIdp } from "../scripts/local-idp";
import type { Job } from "../server/jobs";

/**
 * Single sign-on (phase 16, C4a; docs/SECURITY_STEP5.md), against a stand-in OIDC provider on
 * loopback: the connection's endpoints come from discovery and its secret is sealed; domains are
 * verified by a TXT record, by one workspace at a time; a sign-in is the code flow with PKCE, a
 * nonce and a state bound to the browser; only verified emails at verified domains get in; the
 * first mapped group decides the role at every sign-in (owners never change); no match is refused
 * and recorded; a password teammate is linked by email the first time; enforced SSO leaves
 * passwords, invitations, resets and platform sign-in to owners; the host keeps the login in its
 * own cookie; nothing crosses workspaces; the rollback turns it off.
 */
test("sso: the connection, domains, group roles, the code flow, enforcement, the bridge, the audit log, rollback", async () => {
  const db = await testDatabase();
  const idp = await startLocalIdp({ port: 9131 });
  const q = <T = Record<string, unknown>>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const KEY = "k".repeat(64);
  const env = { key: KEY, policy: { allowHosts: [idp.host] } };
  const client = { ip: "203.0.113.7", userAgent: "Mozilla/5.0 (Macintosh) Chrome/130", origin: "http://127.0.0.1:9132" };
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
    }
    const sso = (p: Record<string, unknown>, principal = "owner-a", w = "a") =>
      tenant(db.connect, w, async (x) => changeSso(x, w, principal, env, client, p, p.action === "connection" ? await discover(env, p.issuer) : null));
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','grace','grace-a','Grace','agent')");

    // Settings: for who manages security, never across workspaces.
    await assert.rejects(tenant(db.connect, "a", (x) => readSso(x, "a", "grace-a", client)));
    await assert.rejects(tenant(db.connect, "b", (x) => readSso(x, "b", "owner-a", client)));
    assert.equal((await tenant(db.connect, "a", (x) => readSso(x, "a", "owner-a", client))).connection, null);
    assert.equal((await ssoInfo(db.connect, "a")).sso, null);

    // The connection: endpoints from discovery, the secret sealed and never returned.
    await assert.rejects(discover({ policy: {} }, idp.origin), /public https/, "only the test provider is allowed, by the policy");
    await assert.rejects(discover(env, idp.origin + "/nowhere"), /couldn't read/);
    await assert.rejects(sso({ action: "connection", issuer: idp.origin, clientId: LOCAL_IDP_CLIENT.id }), /client secret/);
    const saved = await sso({ action: "connection", name: "Test IdP", issuer: idp.origin, clientId: LOCAL_IDP_CLIENT.id, clientSecret: LOCAL_IDP_CLIENT.secret });
    assert.deepEqual([saved.connection!.issuer, saved.connection!.hasSecret, saved.connection!.enabled, saved.redirectUri], [idp.origin, true, false, client.origin + "/auth/sso/callback"]);
    assert.ok(!JSON.stringify(saved).includes(LOCAL_IDP_CLIENT.secret));
    assert.ok(!JSON.stringify(await q("a", "SELECT * FROM sso_connections")).includes(LOCAL_IDP_CLIENT.secret), "the secret is kept sealed");

    // Group roles: in order, never the owner role, never above the manager's own.
    await assert.rejects(sso({ action: "mappings", mappings: [{ group: "Admins", roleId: "owner" }] }), /never by a group/);
    const lead = (await tenant(db.connect, "a", (x) => saveRole(x, "a", "owner-a", { name: "Security lead", capabilities: ["conversations.read", "security.manage"] }))) as unknown as { id: string };
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','sal','sal-a','Sal',$1)", [lead.id]);
    await assert.rejects(sso({ action: "mappings", mappings: [{ group: "Support", roleId: "admin" }] }, "sal-a"), /within your own permissions/);
    await sso({
      action: "mappings",
      mappings: [
        { group: "Support leads", roleId: "admin" },
        { group: "Support", roleId: "agent" },
      ],
    });

    // Domains: a TXT record, checked by the job; one workspace at a time.
    await assert.rejects(sso({ action: "add-domain", domain: "not a domain" }), /Enter a domain/);
    const added = await sso({ action: "add-domain", domain: "Example.TEST" });
    const record = added.domains[0].record;
    assert.deepEqual([record.type, record.name], ["TXT", "_relay-verification.example.test"]);
    await sso({ action: "verify-domain", domain: "example.test" });
    const job = (await q<Job>("a", "SELECT * FROM jobs WHERE kind='sso.domain.check' ORDER BY created_at DESC LIMIT 1"))[0];
    const txt: Record<string, string[]> = {};
    const dns = { lookup: async (name: string) => txt[name] ?? [] };
    await checkSsoDomainJob(db.connect, { dns }, job);
    assert.match((await tenant(db.connect, "a", (x) => readSso(x, "a", "owner-a", client))).domains[0].error!, /No TXT record/);
    txt[verificationName("example.test")] = [record.value];
    await checkSsoDomainJob(db.connect, { dns }, job);
    assert.equal((await tenant(db.connect, "a", (x) => readSso(x, "a", "owner-a", client))).domains[0].verified, true);
    const other = await sso({ action: "add-domain", domain: "example.test" }, "owner-b", "b");
    txt[verificationName("example.test")].push(other.domains[0].record.value);
    await checkSsoDomainJob(db.connect, { dns }, { ...job, workspace_id: "b" });
    assert.match((await tenant(db.connect, "b", (x) => readSso(x, "b", "owner-b", client))).domains[0].error!, /Another Relay workspace/);
    assert.ok(verificationValue("x").startsWith("relay-verification="));

    // Enforcing waits until it's on, a domain is verified, and one sign-in has worked.
    await assert.rejects(sso({ action: "enforced", on: true }), /Turn single sign-on on first/);
    await sso({ action: "enabled", on: true });
    await assert.rejects(sso({ action: "enforced", on: true }), /Sign in with single sign-on once first/);
    assert.deepEqual((await ssoInfo(db.connect, "a")).sso, { name: "Test IdP", enforced: false });

    // Signing in: the browser goes to the provider with PKCE, a nonce and a state; the code comes back.
    const atProvider = async (url: string, person: string) => {
      const r = await fetch(url + "&person=" + person, { redirect: "manual" });
      return new URL(r.headers.get("location")!);
    };
    const signInAs = async (person: string, w = "a") => {
      const started = await startSso(db.connect, "a", { next: "/agent#settings/sign-in" }, client);
      const back = await atProvider(started.url, person);
      return finishSso(db.connect, w, env, { login: started.login, state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: back.searchParams.get("error") ?? "" }, client);
    };
    const started = await startSso(db.connect, "a", {}, client);
    const to = new URL(started.url);
    assert.equal(to.origin, idp.origin);
    assert.deepEqual(
      ["response_type", "client_id", "redirect_uri", "scope", "code_challenge_method"].map((k) => to.searchParams.get(k)),
      ["code", LOCAL_IDP_CLIENT.id, client.origin + "/auth/sso/callback", "openid email profile", "S256"],
    );
    assert.match(started.login, /^relay_sso_[\w-]+_[A-Za-z0-9]{40}$/);

    // Ada (in Support) is made just in time, as an agent.
    const ada = await signInAs("ada");
    assert.equal(ada.next, "/agent#settings/sign-in");
    const adaTeammate = (await q<{ id: string; name: string; role_id: string }>("a", "SELECT t.id,t.name,t.role_id FROM teammates t JOIN sso_identities i ON i.teammate_id=t.id WHERE i.subject='local-ada'"))[0];
    assert.deepEqual([adaTeammate.name, adaTeammate.role_id], ["Ada Lovelace", "agent"]);
    assert.equal((await resolveSession(db.connect, "a", ada.token)).teammateId, adaTeammate.id);
    assert.deepEqual(await q("a", "SELECT method FROM teammate_sessions WHERE id=$1", [ada.sessionId]), [{ method: "sso" }]);
    await signInAs("ada");
    assert.equal((await q("a", "SELECT 1 FROM teammates WHERE name='Ada Lovelace'")).length, 1, "the same Ada the second time");

    // A state from elsewhere, a login used twice, or a login from another workspace: refused.
    const s2 = await startSso(db.connect, "a", {}, client);
    const back2 = await atProvider(s2.url, "ada");
    await assert.rejects(finishSso(db.connect, "a", env, { login: s2.login, state: "forged", code: back2.searchParams.get("code") }, client), /expired/);
    await assert.rejects(finishSso(db.connect, "a", env, { login: s2.login, state: back2.searchParams.get("state"), code: back2.searchParams.get("code") }, client), /expired/, "a wrong state uses the login up");
    const s2b = await startSso(db.connect, "a", {}, client);
    const back2b = await atProvider(s2b.url, "ada");
    await finishSso(db.connect, "a", env, { login: s2b.login, state: back2b.searchParams.get("state"), code: back2b.searchParams.get("code") }, client);
    await assert.rejects(finishSso(db.connect, "a", env, { login: s2b.login, state: back2b.searchParams.get("state"), code: back2b.searchParams.get("code") }, client), /expired/, "used once");
    await assert.rejects(signInAs("ada", "b"), /expired/, "a login only works in its own workspace");

    // Refusals, each recorded: no mapped group, an unverified email, a domain not verified, the provider says no.
    await assert.rejects(signInAs("sam"), /groups don't give you access/);
    assert.equal((await q("a", "SELECT 1 FROM teammates WHERE name='Sam Okafor'")).length, 0, "no account is made");
    await assert.rejects(signInAs("eve"), /verified email/);
    await assert.rejects(signInAs("max"), /elsewhere\.test isn't a verified domain/);
    const s3 = await startSso(db.connect, "a", {}, client);
    const cancelled = new URL((await fetch(s3.url + "&cancel=1", { redirect: "manual" })).headers.get("location")!);
    await assert.rejects(finishSso(db.connect, "a", env, { login: s3.login, state: cancelled.searchParams.get("state"), error: cancelled.searchParams.get("error") }, client), /didn't let you sign in/);
    const reasons = (await q<{ details: { reason: string } }>("a", "SELECT details FROM audit_events WHERE action='session.sso_refused' ORDER BY seq")).map((r) => r.details.reason);
    assert.deepEqual(reasons, ["no_role", "email_unverified", "domain_unverified", "provider_error"]);

    // Lin already signs in with a password: linked by email the first time; her groups make her an admin.
    const made = (await tenant(db.connect, "a", (x) => changeInvitations(x, "a", "owner-a", env, client, { action: "create", email: "lin@example.test", name: "Lin", roleId: "agent" }))) as unknown as { link: string };
    const linPassword = await acceptInvitation(db.connect, "a", { token: made.link.split("#")[1], name: "Lin", password: "a long, varied passphrase" }, client);
    const linId = (await q<{ id: string }>("a", "SELECT teammate_id AS id FROM teammate_credentials WHERE email='lin@example.test'"))[0].id;
    const lin = await signInAs("lin");
    assert.equal((await resolveSession(db.connect, "a", lin.token)).teammateId, linId);
    assert.deepEqual(await q("a", "SELECT role_id FROM teammates WHERE id=$1", [linId]), [{ role_id: "admin" }]);
    const changed = await q<{ details: Record<string, unknown> }>("a", "SELECT details FROM audit_events WHERE action='teammate.changed' AND target_id=$1", [linId]);
    assert.ok(changed.some((c) => JSON.stringify(c.details).includes("admin")), "the role change is in the audit log");

    // Groups decide at every sign-in: without a mapped group, Ada is refused; an owner never changes.
    await sso({ action: "mappings", mappings: [{ group: "Support leads", roleId: "admin" }] });
    await assert.rejects(signInAs("ada"), /groups don't give you access/);
    await q("a", "UPDATE teammates SET role_id='owner' WHERE id=$1", [adaTeammate.id]);
    await signInAs("ada");
    assert.deepEqual(await q("a", "SELECT role_id FROM teammates WHERE id=$1", [adaTeammate.id]), [{ role_id: "owner" }]);
    await q("a", "UPDATE teammates SET role_id='agent' WHERE id=$1", [adaTeammate.id]);
    await sso({
      action: "mappings",
      mappings: [
        { group: "Support leads", roleId: "admin" },
        { group: "Support", roleId: "agent" },
      ],
    });

    // Enforced: passwords, invitations and resets are for owners (break-glass); platform sign-in too.
    await tenant(db.connect, "a", (x) => changeAccount(x, "a", "owner-a", null, { action: "password", email: "owner@example.test", password: "the keeper's long passphrase" }));
    const enforced = await sso({ action: "enforced", on: true });
    assert.equal(enforced.connection!.enforced, true);
    await assert.rejects(resolveSession(db.connect, "a", "token" in linPassword ? linPassword.token : ""), /signed out/, "password sessions end");
    assert.equal((await resolveSession(db.connect, "a", lin.token)).teammateId, linId, "SSO sessions stay");
    await assert.rejects(signIn(db.connect, "a", { email: "lin@example.test", password: "a long, varied passphrase" }, client), /signs in with single sign-on/);
    const keeper = await signIn(db.connect, "a", { email: "owner@example.test", password: "the keeper's long passphrase" }, client);
    assert.ok("token" in keeper, "an owner's password still works");
    assert.equal((await q("a", "SELECT 1 FROM audit_events WHERE action='session.break_glass'")).length, 1);
    await assert.rejects(tenant(db.connect, "a", (x) => changeInvitations(x, "a", "owner-a", env, client, { action: "create", email: "new@example.test", roleId: "agent" })), /join by signing in/);
    await assert.rejects(tenant(db.connect, "a", (x) => changeInvitations(x, "a", "owner-a", env, client, { action: "reset", teammateId: linId })), /only owners have passwords/);
    await assert.rejects(tenant(db.connect, "a", (x) => changeAccount(x, "a", "relay:" + linId, null, { action: "password", current: "a long, varied passphrase", password: "another long passphrase" })), /only owners keep a password/);
    await assert.rejects(sso({ action: "remove-domain", domain: "example.test" }), /turn that off before/);
    await assert.rejects(sso({ action: "connection", name: "Other", issuer: "https://idp.example.com", clientId: "x" }), /public https|couldn't read/);

    // Through the host: the login in its own cookie; the return sets the session; platform sign-in for owners only.
    const api: ApiEnvironment = {
      connect: db.connect,
      sessionSecret: "s".repeat(40),
      identityMaster: "m".repeat(40),
      bridgeSecret: "b".repeat(40),
      realtimeUrl: "wss://relay.test/realtime",
      storageTransport: "local-pglite",
      connectors: { key: KEY } as ApiEnvironment["connectors"],
      sso: { policy: env.policy },
    };
    const config = { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: "a", RELAY_BRIDGE_SECRET: api.bridgeSecret };
    const host = (path: string, headers: Record<string, string> = {}) => bridgeSsoRequest(new Request(client.origin + path, { headers: { "sec-fetch-site": "same-origin", ...headers } }), config, (r) => handleApi(r, api));
    const go = await host("/auth/sso?next=/agent");
    assert.equal(go.status, 302);
    const cookie = go.headers.get("set-cookie")!;
    assert.match(cookie, /^relay_sso=relay_sso_[^;]+; Path=\/auth; HttpOnly; SameSite=Lax; Max-Age=600$/);
    const returned = await atProvider(go.headers.get("location")!, "ada");
    assert.equal(returned.origin + returned.pathname, client.origin + "/auth/sso/callback");
    const without = await host("/auth/sso/callback" + returned.search, { "sec-fetch-site": "cross-site" });
    assert.equal(without.headers.get("location"), "/signin?sso=SSO_EXPIRED", "only the browser that started it");
    const go2 = await host("/auth/sso?next=/agent");
    const returned2 = await atProvider(go2.headers.get("location")!, "ada");
    const done = await host("/auth/sso/callback" + returned2.search, { cookie: go2.headers.get("set-cookie")!.split(";")[0], "sec-fetch-site": "cross-site" });
    assert.equal(done.status, 302);
    assert.equal(done.headers.get("location"), "/agent");
    const jar = done.headers.getSetCookie().find((c) => c.startsWith("relay_session="))!;
    assert.match(jar, /HttpOnly; SameSite=Lax/);
    assert.ok(done.headers.getSetCookie().some((c) => /^relay_sso=; .*Max-Age=0/.test(c)));
    assert.equal((await host("/auth/sso", { "sec-fetch-site": "cross-site" })).headers.get("location"), "/signin?sso=SSO_EXPIRED", "not started from another site");
    const inbox = (principal: string) => bridgeAgentRequest(new Request(client.origin + "/api/agent/inbox"), principal, config, (r) => handleApi(r, api));
    assert.equal((await inbox("owner-a")).status, 200);
    const refused = await inbox("grace-a");
    assert.equal(refused.status, 401);
    assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "SIGNED_OUT");
    const viaSession = await bridgeAgentRequest(new Request(client.origin + "/api/agent/inbox"), undefined, config, (r) => handleApi(r, api), jar.split(";")[0].split("=")[1]);
    assert.equal(viaSession.status, 200);

    // The audit log: the connection (secret only as replaced), domains, mappings, sign-ins and refusals.
    const actions = (await q<{ action: string }>("a", "SELECT DISTINCT action FROM audit_events")).map((r) => r.action);
    for (const a of ["sso.created", "sso.changed", "sso_domain.created", "sso_domain.changed", "sso_role.created", "sso_role.deleted", "session.sso_refused", "session.break_glass", "teammate.created"])
      assert.ok(actions.includes(a), `audited: ${a}`);
    assert.ok(!JSON.stringify(await q("a", "SELECT * FROM audit_events")).includes(LOCAL_IDP_CLIENT.secret), "never the client secret");

    // The rollback: enforcement and SSO off, SSO sessions ended.
    const rollback = await readFile("db/rollback/0085_sso.sql", "utf8");
    for (const statement of rollback
      .split("\n")
      .filter((l) => !l.startsWith("--"))
      .join("\n")
      .split(";")
      .filter((s) => s.trim()))
      await db.pg.exec(statement);
    assert.deepEqual(await q("a", "SELECT enabled,enforced FROM sso_connections"), [{ enabled: false, enforced: false }]);
    await assert.rejects(resolveSession(db.connect, "a", lin.token), /signed out/);
  } finally {
    await idp.close();
    await db.close();
  }
});
