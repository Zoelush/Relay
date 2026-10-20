import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { changeApps, decideConsent, oauthRevoke, oauthToken, readApps, readConsent } from "../server/oauth";
import { handleRest } from "../server/rest";
import { readDeveloperSettings } from "../server/developer";

/**
 * OAuth apps (phase 15, D4; docs/DEVELOPER_PLATFORM_STEP4.md): an app registered in one workspace
 * is installed into another through the consent flow (PKCE required), gets only what it asked for
 * that its approver has, and acts as them; codes and refresh tokens are single-use (a second use
 * revokes the installation); expiry, uninstalling and the revoke endpoint each stop it at once;
 * an archived app is refused; nothing crosses to a workspace that didn't install it.
 */
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

test("OAuth: register, consent with PKCE, tokens that act within their grant, rotation, revocation, isolation", async () => {
  const db = await testDatabase();
  const json = async (r: Response) => (await r.json()) as any;
  const rest = (token: string, path: string, init: RequestInit = {}) =>
    handleRest(new Request("http://api.test/rest" + path, { ...init, headers: { authorization: "Bearer " + token, ...(init.body ? { "content-type": "application/json" } : {}) } }), { connect: db.connect });
  const token = (form: Record<string, string>, basic?: string) =>
    oauthToken(
      new Request("http://api.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...(basic ? { authorization: "Basic " + basic } : {}) },
        body: new URLSearchParams(form),
      }),
      db.connect,
    );
  try {
    for (const w of ["dev", "a", "b"]) {
      await tenant(db.connect, w, (q) => seedFoundation(q, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await tenant(db.connect, w, (q) => q.query("UPDATE workspace_features SET enabled=true WHERE name='developer_api_v1'"));
    }
    // Registering, in the developer's workspace: redirects are https (or http on loopback), without fragments.
    const register = (p: Record<string, unknown>) => tenant(db.connect, "dev", (q) => changeApps(q, "dev", "owner-dev", { action: "create", ...p }));
    for (const bad of ["http://example.com/cb", "https://example.com/cb#x", "javascript:alert(1)"])
      await assert.rejects(register({ name: "Bad", redirectUris: [bad], scopes: ["conversations.read"] }), /Redirects use https/);
    await assert.rejects(register({ name: "Bad", redirectUris: ["https://example.com/cb"], scopes: ["root"] }), /no scope root/);
    const app = (await register({
      name: "Order Sync",
      description: "Shows orders beside conversations.",
      redirectUris: ["https://orders.example/cb", "http://127.0.0.1:7777/cb"],
      scopes: ["conversations.read", "conversations.reply", "contacts.personal_data"],
    })) as { id: string; clientId: string; clientSecret: string };
    assert.match(app.clientId, /^relay_app_/);
    assert.match(app.clientSecret, /^relay_cs_/);
    assert.equal(((await tenant(db.connect, "dev", (q) => readApps(q, "dev", "owner-dev"))).apps[0] as { clientSecret?: string }).clientSecret, undefined, "the secret isn't shown again");

    // The consent screen's checks: shown, never redirected.
    const { verifier, challenge } = await pkcePair();
    const q = { client_id: app.clientId, redirect_uri: "https://orders.example/cb", response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "xyz" };
    const consent = (w: string, principal: string, extra: Record<string, string> = {}) => readConsent(db.connect, w, principal, { ...q, ...extra });
    await assert.rejects(consent("a", "owner-a", { client_id: "relay_app_YQ_nope000000000000000000000" }), /isn't registered/);
    await assert.rejects(consent("a", "owner-a", { redirect_uri: "https://evil.example/cb" }), /didn't register that redirect/);
    await assert.rejects(consent("a", "owner-a", { code_challenge_method: "plain" }), /PKCE/);
    await assert.rejects(consent("a", "owner-a", { scope: "workspace.manage" }), /didn't register the scope workspace.manage/);
    await tenant(db.connect, "a", (x) => x.query("INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent1','agent-a','Agent','agent')"));
    await assert.rejects(consent("a", "agent-a"), /Only someone who manages this workspace/);
    const shown = await consent("a", "owner-a");
    assert.deepEqual([shown.app.name, shown.app.developer, shown.scopes.map((s) => s.id)], ["Order Sync", "Relay", ["conversations.read", "conversations.reply", "contacts.personal_data"]]);

    // Denied: back with access_denied and the state.
    const denied = new URL((await decideConsent(db.connect, "a", "owner-a", { ...q, decision: "deny" })).redirect);
    assert.deepEqual([denied.origin + denied.pathname, denied.searchParams.get("error"), denied.searchParams.get("state")], ["https://orders.example/cb", "access_denied", "xyz"]);

    // Approved, but only part of what's asked: the scope narrowed by the request.
    const approve = async (scope?: string) => {
      const r = new URL((await decideConsent(db.connect, "a", "owner-a", { ...q, ...(scope ? { scope } : {}), decision: "approve" })).redirect);
      assert.equal(r.searchParams.get("state"), "xyz");
      return r.searchParams.get("code")!;
    };
    const exchange = (code: string, extra: Record<string, string> = {}) =>
      token({ grant_type: "authorization_code", code, redirect_uri: q.redirect_uri, code_verifier: verifier, client_id: app.clientId, client_secret: app.clientSecret, ...extra });

    // A wrong secret isn't the app; a wrong verifier burns the code; a burnt code used again revokes.
    let code = await approve("conversations.read conversations.reply");
    assert.equal((await exchange(code, { client_secret: "relay_cs_wrong" })).status, 401);
    const wrongVerifier = await exchange(code, { code_verifier: "x".repeat(43) });
    assert.deepEqual([wrongVerifier.status, (await json(wrongVerifier)).error], [400, "invalid_grant"]);
    const again = await exchange(code);
    assert.match((await json(again)).error_description, /already used; its installation has been revoked/);
    assert.equal((await tenant(db.connect, "a", (x) => readApps(x, "a", "owner-a"))).installed.length, 0);

    // The real thing, with the secret in HTTP Basic.
    code = await approve("conversations.read conversations.reply");
    const basic = btoa(`${app.clientId}:${app.clientSecret}`);
    const issued = await token({ grant_type: "authorization_code", code, redirect_uri: q.redirect_uri, code_verifier: verifier }, basic);
    assert.equal(issued.status, 200);
    const t1 = (await issued.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string };
    assert.deepEqual([t1.token_type, t1.expires_in, t1.scope], ["Bearer", 3600, "conversations.read conversations.reply"]);
    const me = await json(await rest(t1.access_token, "/me"));
    assert.deepEqual([me.workspace_id, me.teammate.id, me.scopes], ["a", "owner", ["conversations.read", "conversations.reply"]]);
    assert.equal((await rest(t1.access_token, "/contacts")).status, 403, "contacts weren't granted");
    assert.equal((await rest(t1.access_token, "/conversations")).status, 200);
    // App tokens aren't personal tokens: the Developers page doesn't list them.
    assert.deepEqual((await tenant(db.connect, "a", (x) => readDeveloperSettings(x, "a", "owner-a", ""))).tokens, []);
    const installed = (await tenant(db.connect, "a", (x) => readApps(x, "a", "owner-a"))).installed;
    assert.deepEqual(installed.map((g) => [g.appName, g.scopes]), [["Order Sync", ["conversations.read", "conversations.reply"]]]);

    // Refresh rotates; the old refresh token used again revokes everything.
    const refreshed = await token({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: app.clientId, client_secret: app.clientSecret });
    const t2 = (await refreshed.json()) as { access_token: string; refresh_token: string };
    assert.notEqual(t2.refresh_token, t1.refresh_token);
    assert.equal((await rest(t2.access_token, "/me")).status, 200);
    const replayed = await token({ grant_type: "refresh_token", refresh_token: t1.refresh_token, client_id: app.clientId, client_secret: app.clientSecret });
    assert.equal((await json(replayed)).error, "invalid_grant");
    assert.equal((await rest(t2.access_token, "/me")).status, 401, "a reused refresh token revokes the installation");
    assert.equal((await token({ grant_type: "refresh_token", refresh_token: t2.refresh_token, client_id: app.clientId, client_secret: app.clientSecret })).status, 400);

    // Expiry; the revoke endpoint; uninstalling.
    const fresh = async () => (await (await exchange(await approve())).json()) as { access_token: string; refresh_token: string };
    let t = await fresh();
    await tenant(db.connect, "a", (x) => x.query("UPDATE api_tokens SET expires_at=now()-interval '1 second' WHERE grant_id IS NOT NULL AND revoked_at IS NULL"));
    assert.equal((await rest(t.access_token, "/me")).status, 401, "an hour later");
    t = await fresh();
    const revoke = (tok: string) =>
      oauthRevoke(new Request("http://api.test/oauth/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tok, client_id: app.clientId, client_secret: app.clientSecret }) }), db.connect);
    assert.equal((await revoke(t.access_token)).status, 200);
    assert.equal((await rest(t.access_token, "/me")).status, 401);
    assert.equal((await revoke(t.refresh_token)).status, 200);
    assert.equal((await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: app.clientId, client_secret: app.clientSecret })).status, 400);
    t = await fresh();
    const grant = (await tenant(db.connect, "a", (x) => readApps(x, "a", "owner-a"))).installed[0];
    await tenant(db.connect, "a", (x) => changeApps(x, "a", "owner-a", { action: "uninstall", id: grant.id }));
    assert.equal((await rest(t.access_token, "/me")).status, 401, "uninstalled");

    // Another app can't use this app's code; another workspace sees none of a's data.
    const other = (await register({ name: "Other", redirectUris: ["https://orders.example/cb"], scopes: ["conversations.read"] })) as { clientId: string; clientSecret: string };
    code = await approve();
    const stolen = await token({ grant_type: "authorization_code", code, redirect_uri: q.redirect_uri, code_verifier: verifier, client_id: other.clientId, client_secret: other.clientSecret });
    assert.equal((await json(stolen)).error, "invalid_grant");
    t = (await (await exchange(await approve())).json()) as { access_token: string; refresh_token: string };
    const conversationOfB = await tenant(db.connect, "b", async (x) => (await x.query<{ id: string }>("SELECT id FROM conversations LIMIT 1")).rows[0]?.id ?? "none");
    assert.equal((await rest(t.access_token, "/conversations/" + conversationOfB)).status, 404);
    assert.equal((await tenant(db.connect, "b", (x) => readApps(x, "b", "owner-b"))).installed.length, 0);

    // Archived: no new installs or refreshes.
    await tenant(db.connect, "dev", (x) => changeApps(x, "dev", "owner-dev", { action: "archive", id: app.id }));
    await assert.rejects(consent("a", "owner-a"), /isn't registered with Relay \(or was archived\)/);
    assert.equal((await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: app.clientId, client_secret: app.clientSecret })).status, 401);
  } finally {
    await db.close();
  }
});
