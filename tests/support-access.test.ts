import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest, bridgeSsoRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { finishSupport, readSupport, resolveSupportSession, startSupport, type SupportEnvironment } from "../server/support";
import { authorize, can, SUPPORT_PREFIX } from "../server/policy";
import { LOCAL_IDP_CLIENT, LOCAL_SUPPORT_STAFF, startLocalIdp } from "../scripts/local-idp";

/**
 * Vendor support access (phase 16, C7b; docs/SECURITY_STEP12.md). A manager grants read-only access
 * for 1, 7 or 14 days; a staff member on the list signs in with Relay's identity provider (the
 * stand-in) through the workspace's host, and gets a session that reads like an owner but can't
 * write; each page is audited; revoking (or the grant ending) ends it; nothing works without a
 * grant, off the staff list, or in another workspace. The rollback ends every grant and session.
 */
test("support access: granted, signed in through Relay's provider, read-only, audited, revoked, per workspace, rollback", async () => {
  const db = await testDatabase();
  const idp = await startLocalIdp({ port: 9181 });
  const client = { ip: "203.0.113.9", userAgent: "Mozilla/5.0 (Macintosh) Chrome/130", origin: "http://127.0.0.1:9182" };
  const support: SupportEnvironment = { issuer: idp.origin, clientId: LOCAL_IDP_CLIENT.id, clientSecret: LOCAL_IDP_CLIENT.secret, staff: LOCAL_SUPPORT_STAFF, policy: { allowHosts: [idp.host] } };
  const api: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    support,
  };
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const config = (w: string) => ({ RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: w, RELAY_BRIDGE_SECRET: api.bridgeSecret });
  const agent = async (path: string, data?: unknown, principal = "owner-a", w = "a", session?: string) => {
    const r = await bridgeAgentRequest(
      new Request(client.origin + "/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: { origin: client.origin, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      session ? undefined : principal,
      config(w),
      (x) => handleApi(x, api),
      session,
    );
    return { status: r.status, body: (await r.json()) as any };
  };
  const atProvider = async (url: string, person: string) => new URL((await fetch(url + "&person=" + person, { redirect: "manual" })).headers.get("location")!);
  const signInAs = async (person: string, w = "a", env: SupportEnvironment = support) => {
    const started = await startSupport(db.connect, w, env, client);
    const back = await atProvider(started.url, person);
    return finishSupport(db.connect, w, env, { login: started.login, state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: back.searchParams.get("error") ?? "" }, client);
  };
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: api.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
    }
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");
    const owner = (await q<{ name: string }>("a", "SELECT name FROM teammates WHERE principal_id='owner-a'"))[0].name;
    const teammates = async () => (await q<{ name: string }>("a", "SELECT name FROM teammates ORDER BY name")).map((r) => r.name);
    const before = await teammates();

    // Off by default: no grant, so no sign-in starts.
    const initial = (await agent("support-access")).body;
    assert.deepEqual([initial.configured, initial.active, initial.history, initial.days], [true, null, [], [1, 7, 14]]);
    await assert.rejects(startSupport(db.connect, "a", support, client), /hasn't given Relay support access/);
    await assert.rejects(startSupport(db.connect, "a", undefined, client), /isn't set up/);

    // Granting: security.manage only, 1, 7 or 14 days.
    assert.equal((await agent("support-access", { action: "grant", days: 7 }, "agent-1-a")).status, 403);
    assert.equal((await agent("support-access", { action: "grant", days: 30 })).status, 400);
    const granted = (await agent("support-access", { action: "grant", days: 7 })).body;
    assert.equal(granted.active.grantedBy, owner);
    const days = (Date.parse(granted.active.expiresAt) - Date.now()) / 86_400_000;
    assert.ok(days > 6.9 && days <= 7, String(days));

    // Signing in: only a verified email on the staff list.
    await assert.rejects(signInAs("ada"), /isn't on Relay's support staff list/);
    await assert.rejects(signInAs("rae", "a", { ...support, staff: ["someone@relay-staff.test"] }), /isn't on Relay's support staff list/);
    const started = await startSupport(db.connect, "a", support, client);
    const back = await atProvider(started.url, "rae");
    await assert.rejects(finishSupport(db.connect, "a", support, { login: started.login, state: "wrong", code: back.searchParams.get("code") }, client), /expired/);
    await assert.rejects(finishSupport(db.connect, "a", support, { login: started.login, state: back.searchParams.get("state"), code: back.searchParams.get("code") }, client), /expired/, "used once");
    const rae = await signInAs("rae");
    assert.match(rae.token, /^relay_sup_/);
    const hours = (Date.parse(rae.expiresAt) - Date.now()) / 3_600_000;
    assert.ok(hours > 7.9 && hours <= 8, "at most 8 hours");
    const resolved = await resolveSupportSession(db.connect, "a", rae.token);
    assert.equal(resolved.principal, SUPPORT_PREFIX + resolved.sessionId);
    await assert.rejects(resolveSupportSession(db.connect, "b", rae.token), /signed out/, "another workspace's token isn't this one's");
    // No teammate was made: staff never appear among teammates.
    assert.deepEqual(await teammates(), before);

    // A support session reads like an owner, through the host's cookie...
    const inbox = await agent("inbox", undefined, "", "a", rae.token);
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.teammate.name, "Relay support (rae@relay-staff.test)");
    assert.equal(inbox.body.account.readOnly, true);
    assert.deepEqual([inbox.body.capabilities.reply, inbox.body.capabilities.note, inbox.body.capabilities.settings], [false, false, true]);
    assert.equal((await agent("audit", undefined, "", "a", rae.token)).status, 200, "even the audit log");
    // Support is not a teammate here, so it has no workload of its own: that is said, not thrown.
    const workload = await agent("workload", undefined, "", "a", rae.token);
    assert.deepEqual(
      [workload.status, workload.body.error.code, workload.body.error.message],
      [404, "NO_WORKLOAD", "This account has no workload in this workspace."],
    );
    // ...but every write is refused before any route runs.
    for (const [path, body] of [
      ["support-access", { action: "grant", days: 14 }],
      ["links", { action: "add", kind: "trusted", domain: "relay.example" }],
      ["data-protection", { action: "builtin", builtin: "card", on: true }],
    ] as const) {
      const r = await agent(path, body, "", "a", rae.token);
      assert.deepEqual([r.status, r.body.error.code], [403, "SUPPORT_READ_ONLY"], path);
    }
    assert.equal((await q("a", "SELECT count(*)::int AS n FROM link_policies"))[0].n, 0);
    // Each page staff open is audited (path and query names, never values), at most every 10 minutes per page.
    await agent("link-verdict?part=p1&url=https%3A%2F%2Fsecret.example", undefined, "", "a", rae.token);
    await agent("inbox", undefined, "", "a", rae.token);
    const viewed = await q<{ target_id: string; actor_id: string; actor_name: string; via: string; details: { query: string[] } }>(
      "a",
      "SELECT target_id,actor_id,actor_name,via,details FROM audit_events WHERE action='support.viewed' ORDER BY seq",
    );
    assert.deepEqual(
      viewed.map((v) => v.target_id),
      ["inbox", "audit", "workload", "link-verdict"],
    );
    assert.deepEqual([viewed[0].actor_id, viewed[0].actor_name, viewed[0].via], ["relay-support", "Relay support (rae@relay-staff.test)", "support"]);
    assert.deepEqual(viewed[3].details.query, ["part", "url"]);
    assert.ok(!JSON.stringify(viewed).includes("secret.example"), "never the query's values");
    assert.ok((await q("a", "SELECT 1 FROM audit_events WHERE action='support.signed_in'")).length === 1);
    assert.equal((await q("a", "SELECT count(*)::int AS n FROM audit_events WHERE action='support.sign_in_refused'"))[0].n, 2);
    // Policy directly: every capability while live, but `can` hides writing.
    await tenant(db.connect, "a", async (x) => {
      assert.equal((await authorize(x, "a", resolved.principal, "security.manage")).name, "Relay support (rae@relay-staff.test)");
      assert.equal(await can(x, "a", resolved.principal, "workspace.manage"), true);
      assert.equal(await can(x, "a", resolved.principal, "conversations.reply"), false);
    });
    await tenant(db.connect, "b", async (x) => assert.rejects(authorize(x, "b", resolved.principal, "conversations.read"), /permission/));

    // The page: the open grant and its staff session; another workspace sees nothing of it.
    const page = (await agent("support-access")).body;
    assert.deepEqual(page.active.sessions.map((s: { email: string; endedAt: string | null }) => [s.email, s.endedAt]), [["rae@relay-staff.test", null]]);
    assert.deepEqual((await agent("support-access", undefined, "owner-b", "b")).body.history, []);
    await assert.rejects(tenant(db.connect, "b", (x) => readSupport(x, "b", "owner-a", true)));

    // Revoking ends the grant and the session at once.
    const revoked = (await agent("support-access", { action: "revoke" })).body;
    assert.equal(revoked.active, null);
    assert.equal(revoked.history[0].revokedBy, owner);
    assert.ok(revoked.history[0].sessions[0].endedAt);
    assert.equal((await agent("inbox", undefined, "", "a", rae.token)).status, 401);
    assert.equal((await agent("support-access", { action: "revoke" })).status, 404, "nothing left to revoke");
    // A lapsed grant lets no one in either.
    await agent("support-access", { action: "grant", days: 1 });
    const again = await signInAs("rae");
    await q("a", "UPDATE support_grants SET granted_at=now()-interval '2 days',expires_at=now()-interval '1 second' WHERE revoked_at IS NULL");
    assert.equal((await agent("inbox", undefined, "", "a", again.token)).status, 401);
    await assert.rejects(signInAs("rae"), /hasn't given Relay support access/);
    // A new grant closes a lapsed one at its own expiry.
    const renewed = (await agent("support-access", { action: "grant", days: 14 })).body;
    assert.ok(renewed.active);
    assert.equal(renewed.history[1].revokedBy, owner);
    assert.ok(Date.parse(renewed.history[1].endedAt) <= Date.now());

    // Through the host: the login in its own cookie; the return sets the session cookie.
    const host = (path: string, headers: Record<string, string> = {}) =>
      bridgeSsoRequest(new Request(client.origin + path, { headers: { "sec-fetch-site": "same-origin", ...headers } }), config("a"), (r) => handleApi(r, { ...api }));
    const go = await host("/auth/support");
    assert.equal(go.status, 302);
    assert.match(go.headers.get("set-cookie")!, /^relay_support=relay_spl_[^;]+; Path=\/auth; HttpOnly; SameSite=Lax; Max-Age=600$/);
    const returned = await atProvider(go.headers.get("location")!, "rae");
    assert.equal(returned.origin + returned.pathname, client.origin + "/auth/support/callback");
    const done = await host("/auth/support/callback" + returned.search, { cookie: go.headers.get("set-cookie")!.split(";")[0], "sec-fetch-site": "cross-site" });
    assert.equal(done.headers.get("location"), "/agent");
    const jar = done.headers.getSetCookie().find((c) => c.startsWith("relay_session=relay_sup_"))!;
    assert.match(jar, /HttpOnly; SameSite=Lax/);
    const refused = await host("/auth/support/callback?state=x&code=y");
    assert.equal(refused.headers.get("location"), "/signin?sso=SUPPORT_EXPIRED");
    await q("b", "SELECT 1");
    const elsewhere = await bridgeSsoRequest(new Request(client.origin + "/auth/support", { headers: { "sec-fetch-site": "same-origin" } }), config("b"), (r) => handleApi(r, api));
    assert.equal(elsewhere.headers.get("location"), "/signin?sso=SUPPORT_NOT_GRANTED", "workspace b never granted access");

    // The rollback: every grant and session ended.
    await db.pg.exec(await readFile("db/rollback/0091_support_access.sql", "utf8"));
    assert.equal((await agent("support-access")).body.active, null);
    assert.equal((await agent("inbox", undefined, "", "a", jar.split(";")[0].split("=")[1])).status, 401);
  } finally {
    await idp.close();
    await db.close();
  }
});
