import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { saveRole } from "../server/people-settings";
import { changeDeveloperTokens } from "../server/developer";
import { handleRest } from "../server/rest";
import { acceptInvitation, changeAccount, changeInvitations, completeTwoFactor, readAccount, resolveSession, signIn, signInAllowed, twoFactorSetup } from "../server/accounts";
import { changeAccess, readAccess, twoFactorOf } from "../server/two-factor";
import { base32, hotp, matchStep, newRecoveryCode, otpauthUri, stepAt, totp, unbase32 } from "../server/totp";
import { networkAllowed, normalIp, readAllowlist } from "../server/allowlists";
import { bridgeAgentRequest, bridgeAuthRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";

/**
 * Two-factor sign-in and IP allowlists (phase 16, C3b; docs/SECURITY_STEP4.md): TOTP codes as RFC
 * 6238 defines them, each used once; recovery codes once each; a right password with two-factor on
 * gives a challenge (five wrong codes, counted toward the lock), never a session; a workspace can
 * require two-factor (only once you have it), which signs out sessions without it and makes new and
 * returning teammates set it up first; a reset doesn't skip it; a manager can turn a teammate's off
 * within their permissions. The app's allowlist covers every agent request and sign-in step, the
 * API's the REST API; neither can shut out whoever saves it, and neither crosses workspaces.
 */
test("totp: RFC 6238's vectors, base32, one step either side, a code used once; recovery codes' shape", async () => {
  const secret = base32(new TextEncoder().encode("12345678901234567890"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual(unbase32(secret), new TextEncoder().encode("12345678901234567890"));
  // RFC 6238 appendix B (SHA-1), the last six digits.
  for (const [seconds, code] of [
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ] as const)
    assert.equal(await totp(secret, seconds * 1000), code);
  const now = 1_800_000_000_000;
  const step = stepAt(now);
  assert.equal(await matchStep(secret, await hotp(secret, step), null, now), step);
  assert.equal(await matchStep(secret, await hotp(secret, step - 1), null, now), step - 1, "a step behind still works");
  assert.equal(await matchStep(secret, await hotp(secret, step + 2), null, now), null, "two steps ahead doesn't");
  assert.equal(await matchStep(secret, await hotp(secret, step), step, now), null, "a code is used once");
  assert.equal(await matchStep(secret, "12 34 5", null, now), null);
  const spaced = await hotp(secret, step);
  assert.equal(await matchStep(secret, spaced.slice(0, 3) + " " + spaced.slice(3), null, now), step);
  assert.match(otpauthUri(secret, "grace@example.test (Support)", "Relay"), /^otpauth:\/\/totp\/Relay%3Agrace%40example\.test%20\(Support\)\?secret=GEZ[A-Z2-7]+&issuer=Relay&algorithm=SHA1&digits=6&period=30$/);
  assert.match(newRecoveryCode(), /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  // Allowlists: what counts as an address.
  assert.equal(normalIp("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(normalIp("2001:db8::1"), "2001:db8::1");
  assert.equal(normalIp("not-an-ip"), null);
  assert.deepEqual(readAllowlist("203.0.113.0/24, 2001:db8::/32\n198.51.100.7", "app"), ["203.0.113.0/24", "2001:db8::/32", "198.51.100.7"]);
  assert.throws(() => readAllowlist(["203.0.113.0/33"], "app"), /isn't an IP address/);
  assert.throws(() => readAllowlist(["example.com"], "app"), /isn't an IP address/);
  assert.throws(() => readAllowlist(Array.from({ length: 101 }, (_, i) => `10.0.0.${i % 250}`), "app"), /up to 100/);
});

test("two-factor: setup, challenges, recovery codes, the lock, requiring it, resets, allowlists, the bridge, the API, the audit log", async () => {
  const db = await testDatabase();
  const q = <T = Record<string, unknown>>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const KEY = "k".repeat(64);
  const env = { key: KEY };
  const client = { ip: "203.0.113.7", userAgent: "Mozilla/5.0 (Macintosh) Chrome/130", origin: "https://relay.example" };
  const PASSWORD = "a long, varied passphrase";
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
    }
    // Teammates who sign in with a password, through invitations.
    const join = async (email: string, name: string) => {
      const made = (await tenant(db.connect, "a", (x) => changeInvitations(x, "a", "owner-a", env, client, { action: "create", email, name, roleId: "agent" }))) as unknown as { link: string };
      const r = await acceptInvitation(db.connect, "a", { token: made.link.split("#")[1], name, password: PASSWORD }, client);
      const t = (await q<{ id: string; principal_id: string }>("a", "SELECT t.id,t.principal_id FROM teammates t JOIN teammate_credentials c ON c.workspace_id=t.workspace_id AND c.teammate_id=t.id WHERE c.email=$1", [email]))[0];
      return { ...t, name, email, first: r };
    };
    const grace = await join("grace@example.test", "Grace");
    assert.ok("token" in grace.first, "without two-factor, accepting starts a session");
    const account = (p: Record<string, unknown>, who: { principal_id: string } = grace, sessionId: string | null = null) => tenant(db.connect, "a", (x) => changeAccount(x, "a", who.principal_id, sessionId, p, env));
    // "A minute later": the next code from the app is a new step (codes are used once).
    const later = (t: { id: string }) => q("a", "UPDATE teammate_two_factor SET last_step=last_step-2 WHERE teammate_id=$1", [t.id]);

    // Your sign-in: two-factor needs a password; it's set up by scanning, then confirming a code.
    const before = await tenant(db.connect, "a", (x) => readAccount(x, "a", grace.principal_id, null));
    assert.deepEqual(before.twoFactor, { enabled: false, recoveryCodesLeft: 0, available: true, required: false });
    await assert.rejects(tenant(db.connect, "a", (x) => changeAccount(x, "a", "owner-a", null, { action: "two-factor-start" }, env)), /Set a password first/);
    const started = (await account({ action: "two-factor-start" })) as unknown as { setup: { secret: string; uri: string } };
    const secret = started.setup.secret;
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.ok(started.setup.uri.startsWith("otpauth://totp/Relay%3Agrace%40example.test%20(") && started.setup.uri.includes("secret=" + secret));
    assert.ok(!JSON.stringify(await q("a", "SELECT * FROM teammate_two_factor")).includes(secret), "the key is kept sealed");
    await assert.rejects(account({ action: "two-factor-confirm", code: "000000" }), /isn't right/);
    const confirmed = (await account({ action: "two-factor-confirm", code: await totp(secret) })) as unknown as { recoveryCodes: string[]; twoFactor: { enabled: boolean; recoveryCodesLeft: number } };
    assert.equal(confirmed.recoveryCodes.length, 10);
    assert.deepEqual([confirmed.twoFactor.enabled, confirmed.twoFactor.recoveryCodesLeft], [true, 10]);
    const stored = JSON.stringify(await q("a", "SELECT * FROM teammate_recovery_codes"));
    assert.ok(confirmed.recoveryCodes.every((c) => !stored.includes(c) && !stored.includes(c.replace("-", ""))), "recovery codes are kept only as hashes");
    await assert.rejects(account({ action: "two-factor-start" }), /already on/);

    // Signing in: a right password gives a challenge, not a session.
    const sessionsOf = async (t: { id: string }) => (await q("a", "SELECT 1 FROM teammate_sessions WHERE teammate_id=$1 AND revoked_at IS NULL", [t.id])).length;
    const open = await sessionsOf(grace);
    const challenged = await signIn(db.connect, "a", { email: "grace@example.test", password: PASSWORD }, client);
    assert.ok("challenge" in challenged && challenged.twoFactor === "verify");
    assert.match(challenged.challenge, /^relay_chl_[\w-]+_[A-Za-z0-9]{40}$/);
    assert.equal(await sessionsOf(grace), open, "no session yet");
    await assert.rejects(completeTwoFactor(db.connect, "a", env, { challenge: challenged.challenge, code: "123456" }, client), /isn't right/);
    await assert.rejects(completeTwoFactor(db.connect, "a", env, { challenge: challenged.challenge, code: await totp(secret) }, client), /isn't right/, "the setup code can't be used again");
    await assert.rejects(completeTwoFactor(db.connect, "b", env, { challenge: challenged.challenge, code: await totp(secret, Date.now() + 30_000) }, client), /expired/, "a challenge only works in its own workspace");
    const signed = await completeTwoFactor(db.connect, "a", env, { challenge: challenged.challenge, code: await totp(secret, Date.now() + 30_000) }, client);
    assert.equal((await resolveSession(db.connect, "a", signed.token)).teammateId, grace.id);
    assert.deepEqual(await q("a", "SELECT method,two_factor FROM teammate_sessions WHERE id=$1", [signed.sessionId]), [{ method: "password", two_factor: "totp" }]);
    await assert.rejects(completeTwoFactor(db.connect, "a", env, { challenge: challenged.challenge, code: "000000" }, client), /expired/, "a challenge is used once");

    // A recovery code instead, once.
    const recovery = confirmed.recoveryCodes[0];
    const second = (await signIn(db.connect, "a", { email: "grace@example.test", password: PASSWORD }, client)) as { challenge: string };
    const byRecovery = await completeTwoFactor(db.connect, "a", env, { challenge: second.challenge, code: recovery.toUpperCase() }, client);
    assert.deepEqual(await q("a", "SELECT two_factor FROM teammate_sessions WHERE id=$1", [byRecovery.sessionId]), [{ two_factor: "recovery" }]);
    const third = (await signIn(db.connect, "a", { email: "grace@example.test", password: PASSWORD }, client)) as { challenge: string };
    await assert.rejects(completeTwoFactor(db.connect, "a", env, { challenge: third.challenge, code: recovery }, client), /isn't right/, "a recovery code works once");
    assert.equal((await tenant(db.connect, "a", (x) => twoFactorOf(x, "a", grace.id))).recoveryCodesLeft, 9);

    // Five wrong codes end the challenge; wrong codes count toward the account's lock.
    for (let i = 0; i < 3; i++) await assert.rejects(completeTwoFactor(db.connect, "a", env, { challenge: third.challenge, code: "000000" }, client), /isn't right/);
    await assert.rejects(completeTwoFactor(db.connect, "a", env, { challenge: third.challenge, code: "000000" }, client), /Too many wrong codes/);
    await assert.rejects(completeTwoFactor(db.connect, "a", env, { challenge: third.challenge, code: confirmed.recoveryCodes[1] }, client), /expired/);
    const fourth = (await signIn(db.connect, "a", { email: "grace@example.test", password: PASSWORD }, client)) as { challenge: string };
    assert.deepEqual(await q("a", "SELECT failed_count FROM teammate_credentials WHERE teammate_id=$1", [grace.id]), [{ failed_count: 5 }], "a right password alone doesn't clear wrong codes");
    await q("a", "UPDATE teammate_credentials SET failed_count=9 WHERE teammate_id=$1", [grace.id]);
    await assert.rejects(completeTwoFactor(db.connect, "a", env, { challenge: fourth.challenge, code: "000000" }, client), /Too many wrong codes/);
    await assert.rejects(signIn(db.connect, "a", { email: "grace@example.test", password: PASSWORD }, client), /Too many attempts/);
    await q("a", "UPDATE teammate_credentials SET failed_count=0,locked_until=NULL WHERE teammate_id=$1", [grace.id]);

    // Your sign-in: new recovery codes and turning it off each take a code; a wrong one is kept and refused.
    const wrong = await account({ action: "recovery-codes", code: "000000" });
    assert.ok("refused" in wrong && /isn't right/.test(String((wrong as { refused: Error }).refused.message)));
    await later(grace);
    const replaced = (await account({ action: "recovery-codes", code: await totp(secret) })) as unknown as { recoveryCodes: string[] };
    assert.equal(replaced.recoveryCodes.length, 10);
    assert.ok(!replaced.recoveryCodes.includes(confirmed.recoveryCodes[2]));
    const off = await account({ action: "two-factor-off", code: replaced.recoveryCodes[0] });
    assert.ok(!("refused" in off));
    assert.equal((await tenant(db.connect, "a", (x) => twoFactorOf(x, "a", grace.id))).enabled, false);
    // On again, for what follows.
    const again = (await account({ action: "two-factor-start" })) as unknown as { setup: { secret: string } };
    const graceSecret = again.setup.secret;
    const graceCodes = ((await account({ action: "two-factor-confirm", code: await totp(graceSecret) })) as unknown as { recoveryCodes: string[] }).recoveryCodes;

    // Security › Access: for who manages security; requiring two-factor needs your own first.
    const access = (p: Record<string, unknown>, principal = "owner-a", from: { ip: string | null } = client) => tenant(db.connect, "a", (x) => changeAccess(x, "a", principal, from, p));
    await assert.rejects(tenant(db.connect, "a", (x) => readAccess(x, "a", grace.principal_id, client)));
    await assert.rejects(tenant(db.connect, "b", (x) => readAccess(x, "b", "owner-a", client)), "not across workspaces");
    await assert.rejects(access({ action: "require-two-factor", on: true }), /for yourself first/);
    const owner = { id: (await q<{ id: string }>("a", "SELECT id FROM teammates WHERE principal_id='owner-a'"))[0].id, principal_id: "owner-a", name: "Owner", email: "owner@example.test" };
    await account({ action: "password", email: "owner@example.test", password: "a manager's long passphrase" }, owner);
    const ownerSecret = ((await account({ action: "two-factor-start" }, owner)) as unknown as { setup: { secret: string } }).setup.secret;
    await account({ action: "two-factor-confirm", code: await totp(ownerSecret) }, owner);
    // Ada has a password and a session, without two-factor; requiring it signs her out.
    const ada = await join("ada@example.test", "Ada");
    assert.ok("token" in ada.first);
    await later(grace);
    const graceSigned = await completeTwoFactor(
      db.connect,
      "a",
      env,
      { challenge: ((await signIn(db.connect, "a", { email: "grace@example.test", password: PASSWORD }, client)) as { challenge: string }).challenge, code: await totp(graceSecret) },
      client,
    );
    const required = await access({ action: "require-two-factor", on: true });
    assert.equal(required.requireTwoFactor, true);
    assert.deepEqual(
      required.teammates.filter((t) => !t.you).map((t) => [t.name, t.twoFactor]),
      [
        ["Ada", false],
        ["Grace", true],
      ],
    );
    assert.equal(required.teammates.find((t) => t.you)!.twoFactor, true);
    await assert.rejects(resolveSession(db.connect, "a", ada.first.token), /signed out/);
    assert.equal((await resolveSession(db.connect, "a", graceSigned.token)).teammateId, grace.id, "sessions with two-factor stay");
    assert.deepEqual(await q("a", "SELECT revoked_reason FROM teammate_sessions WHERE teammate_id=$1", [ada.id]), [{ revoked_reason: "Two-factor is now required." }]);
    // Ada sets it up when she next signs in, before she gets a session.
    const adaChallenge = await signIn(db.connect, "a", { email: "ada@example.test", password: PASSWORD }, client);
    assert.ok("challenge" in adaChallenge && adaChallenge.twoFactor === "setup");
    const adaSetup = await twoFactorSetup(db.connect, "a", env, { challenge: adaChallenge.challenge });
    await assert.rejects(twoFactorSetup(db.connect, "a", env, { challenge: (challenged as { challenge: string }).challenge }), /expired/);
    const adaIn = (await completeTwoFactor(db.connect, "a", env, { challenge: adaChallenge.challenge, code: await totp(adaSetup.secret) }, client)) as { token: string; recoveryCodes: string[] };
    assert.equal(adaIn.recoveryCodes.length, 10);
    assert.equal((await resolveSession(db.connect, "a", adaIn.token)).teammateId, ada.id);
    // So does someone accepting an invitation now.
    const made = (await tenant(db.connect, "a", (x) => changeInvitations(x, "a", "owner-a", env, client, { action: "create", email: "lin@example.test", name: "Lin", roleId: "agent" }))) as unknown as { link: string };
    const lin = await acceptInvitation(db.connect, "a", { token: made.link.split("#")[1], name: "Lin", password: PASSWORD }, client);
    assert.ok("challenge" in lin && lin.twoFactor === "setup");
    // While it's required, nobody turns their own off.
    await later(grace);
    await assert.rejects(account({ action: "two-factor-off", code: await totp(graceSecret) }), /requires two-factor/);

    // A password reset doesn't skip it: the code comes after the new password.
    const reset = (await tenant(db.connect, "a", (x) => changeInvitations(x, "a", "owner-a", env, client, { action: "reset", teammateId: grace.id }))) as unknown as { link: string };
    const afterReset = await acceptInvitation(db.connect, "a", { token: reset.link.split("#")[1], password: "a renewed long passphrase" }, client);
    assert.ok("challenge" in afterReset && afterReset.twoFactor === "verify");
    const resetIn = await completeTwoFactor(db.connect, "a", env, { challenge: afterReset.challenge, code: graceCodes[0] }, client);
    assert.deepEqual(await q("a", "SELECT method,two_factor FROM teammate_sessions WHERE id=$1", [resetIn.sessionId]), [{ method: "invitation", two_factor: "recovery" }]);

    // A lost authenticator: a manager turns it off, within their permissions; their sessions end.
    const desk = (await tenant(db.connect, "a", (x) => saveRole(x, "a", "owner-a", { name: "Security desk", capabilities: ["conversations.read", "security.manage"] }))) as unknown as { id: string };
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','sec','sec-a','Sam',$1)", [desk.id]);
    await assert.rejects(access({ action: "reset-two-factor", teammateId: owner.id }, "sec-a"), /permissions you don't/);
    await assert.rejects(access({ action: "reset-two-factor", teammateId: owner.id }), /your own two-factor/);
    const cleared = await access({ action: "reset-two-factor", teammateId: grace.id });
    assert.equal(cleared.teammates.find((t) => t.id === grace.id)!.twoFactor, false);
    await assert.rejects(resolveSession(db.connect, "a", resetIn.token), /signed out/);

    // IP allowlists: checked, tidied, and never shutting out whoever saves them.
    await assert.rejects(access({ action: "allowlists", app: "198.51.100.0/24", api: "" }), /leaves out your own address \(203\.0\.113\.7\)/);
    await assert.rejects(access({ action: "allowlists", app: "", api: "not-an-address" }), /isn't an IP address/);
    await assert.rejects(access({ action: "allowlists", app: "203.0.113.0/24", api: "" }, "owner-a", { ip: null }), /can't see your address/);
    const saved = await access({ action: "allowlists", app: "203.0.113.9/24\n203.0.113.7", api: "2001:db8::/32, 198.51.100.4" });
    assert.deepEqual(saved.appAllowlist.sort(), ["203.0.113.0/24", "203.0.113.7/32"]);
    assert.deepEqual(saved.apiAllowlist.sort(), ["198.51.100.4/32", "2001:db8::/32"]);
    assert.equal(saved.yourAddress, "203.0.113.7");
    const allowed = (w: string, which: "app" | "api", ip: string | null) => tenant(db.connect, w, (x) => networkAllowed(x, w, which, ip));
    assert.deepEqual(
      await Promise.all([
        allowed("a", "app", "203.0.113.200"),
        allowed("a", "app", "::ffff:203.0.113.9"),
        allowed("a", "app", "198.51.100.4"),
        allowed("a", "app", null),
        allowed("a", "api", "2001:db8:1::5"),
        allowed("a", "api", "203.0.113.7"),
        allowed("b", "app", "192.0.2.1"),
      ]),
      [true, true, false, false, true, false, true],
    );
    // Signing in from outside the app's list is refused, and kept in the audit log.
    assert.equal(await signInAllowed(db.connect, "a", { ip: "192.0.2.50" }), false);

    // Through the host's bridge and the API.
    const api: ApiEnvironment = {
      connect: db.connect,
      sessionSecret: "s".repeat(40),
      identityMaster: "m".repeat(40),
      bridgeSecret: "b".repeat(40),
      realtimeUrl: "wss://relay.test/realtime",
      storageTransport: "local-pglite",
      connectors: { key: KEY } as ApiEnvironment["connectors"],
    };
    const config = { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: "a", RELAY_BRIDGE_SECRET: api.bridgeSecret };
    const auth = (action: string, body: unknown, cookie = "", ip = "203.0.113.7") =>
      bridgeAuthRequest(
        new Request("https://app.test/auth/" + action, { method: "POST", headers: { origin: "https://app.test", "content-type": "application/json", cookie, "cf-connecting-ip": ip }, body: JSON.stringify(body) }),
        config,
        (r) => handleApi(r, api),
      );
    const r = await auth("signin", { email: "ada@example.test", password: PASSWORD });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.deepEqual(JSON.parse(body), { twoFactor: "verify" });
    const challengeCookie = r.headers.get("set-cookie")!;
    assert.match(challengeCookie, /^relay_2fa=relay_chl_[^;]+; Path=\/auth; HttpOnly; SameSite=Strict; Max-Age=600; Secure$/);
    assert.ok(!body.includes("relay_chl_"), "the challenge never reaches the page");
    const jar2fa = challengeCookie.split(";")[0];
    const wrongThrough = await auth("two-factor", { code: "000000" }, jar2fa);
    assert.equal(wrongThrough.status, 401);
    assert.equal(((await wrongThrough.json()) as { error: { code: string } }).error.code, "WRONG_CODE");
    await later(ada);
    const done = await auth("two-factor", { code: await totp(adaSetup.secret) }, jar2fa);
    assert.equal(done.status, 200);
    const cookies = done.headers.getSetCookie();
    assert.ok(cookies.some((c) => /^relay_session=relay_ses_[^;]+; Path=\/; HttpOnly/.test(c)));
    assert.ok(cookies.some((c) => /^relay_2fa=; Path=\/auth; .*Max-Age=0/.test(c)), "the challenge cookie is cleared");
    const jar = cookies.find((c) => c.startsWith("relay_session="))!.split(";")[0];
    const inbox = (ip: string) =>
      bridgeAgentRequest(new Request("https://app.test/api/agent/inbox", { headers: { cookie: jar, "cf-connecting-ip": ip } }), undefined, config, (x) => handleApi(x, api), jar.split("relay_session=")[1]);
    assert.equal((await inbox("203.0.113.40")).status, 200);
    const outside = await inbox("192.0.2.50");
    assert.equal(outside.status, 403);
    assert.equal(((await outside.json()) as { error: { code: string } }).error.code, "NETWORK_NOT_ALLOWED");
    // The platform's sign-in is held to the same list.
    const platform = (ip: string) => bridgeAgentRequest(new Request("https://app.test/api/agent/inbox", { headers: { "cf-connecting-ip": ip } }), "owner-a", config, (x) => handleApi(x, api));
    assert.deepEqual([(await platform("203.0.113.40")).status, (await platform("192.0.2.50")).status], [200, 403]);
    assert.equal((await auth("signin", { email: "ada@example.test", password: PASSWORD }, "", "192.0.2.50")).status, 403);
    // Security › Access through the bridge reads the caller's address.
    const page = await bridgeAgentRequest(new Request("https://app.test/api/agent/security-access", { headers: { "cf-connecting-ip": "203.0.113.7" } }), "owner-a", config, (x) => handleApi(x, api));
    assert.equal(((await page.json()) as { yourAddress: string }).yourAddress, "203.0.113.7");

    // The REST API's own list, against the address Cloudflare sets.
    const token = (await tenant(db.connect, "a", (x) => changeDeveloperTokens(x, "a", "owner-a", { action: "create", name: "Sync", scopes: ["conversations.read"] }))) as unknown as { token: string };
    const rest = (ip?: string) =>
      handleRest(new Request("http://api.test/rest/me", { headers: { authorization: "Bearer " + token.token, ...(ip ? { "cf-connecting-ip": ip } : {}) } }), { connect: db.connect });
    assert.equal((await rest("198.51.100.4")).status, 200);
    assert.equal((await rest("2001:db8::7")).status, 200);
    const blocked = await rest("203.0.113.7");
    assert.equal(blocked.status, 403);
    assert.equal(((await blocked.json()) as { errors: { code: string }[] }).errors[0].code, "network_not_allowed");
    assert.equal((await rest()).status, 403, "no address, no entry");

    // The audit log: every step, and no key, code or hash in it.
    const actions = (await q<{ action: string }>("a", "SELECT DISTINCT action FROM audit_events")).map((x) => x.action);
    for (const a of [
      "two_factor.enabled",
      "two_factor.disabled",
      "two_factor.reset",
      "two_factor.recovery_codes_replaced",
      "two_factor.recovery_code_used",
      "session.two_factor_failed",
      "session.network_refused",
      "session.revoked",
      "session_settings.created",
      "session_settings.changed",
    ])
      assert.ok(actions.includes(a), `audited: ${a}`);
    const log = JSON.stringify(await q("a", "SELECT * FROM audit_events"));
    for (const s of [secret, graceSecret, ownerSecret, ...confirmed.recoveryCodes, ...replaced.recoveryCodes]) assert.ok(!log.includes(s), "no key or recovery code in the log");
    assert.ok(log.includes("203.0.113.0/24"), "the allowlists are recorded");

    // The rollback: two-factor no longer required, both lists emptied, open challenges ended.
    const pending = (await signIn(db.connect, "a", { email: "ada@example.test", password: PASSWORD }, client)) as { challenge: string };
    const rollback = await readFile("db/rollback/0084_two_factor.sql", "utf8");
    for (const statement of rollback
      .split("\n")
      .filter((l) => !l.startsWith("--"))
      .join("\n")
      .split(";")
      .filter((s) => s.trim()))
      await db.pg.exec(statement);
    assert.deepEqual(await q("a", "SELECT require_two_factor,cardinality(app_allowlist) AS app,cardinality(api_allowlist) AS api FROM security_settings"), [{ require_two_factor: false, app: 0, api: 0 }]);
    await assert.rejects(completeTwoFactor(db.connect, "a", env, { challenge: pending.challenge, code: "000000" }, client), /expired/);
  } finally {
    await db.close();
  }
});
