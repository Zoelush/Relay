import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { saveRole } from "../server/people-settings";
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from "../server/passwords";
import { acceptInvitation, changeAccount, changeInvitations, changeSessions, readAccount, readInvitation, readSessions, resolveSession, signIn, signOut } from "../server/accounts";
import { sendAlert } from "../server/email-out";
import { bridgeAgentRequest, bridgeAuthRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { localEmailProvider } from "../scripts/local-email";
import type { Job } from "../server/jobs";
import PostalMime from "postal-mime";

/**
 * Teammate accounts and sessions (phase 16, C3a; docs/SECURITY_STEP3.md): passwords are scrypt
 * hashes; an invitation (a week, single use, to a role within the inviter's) is emailed with its
 * sealed link and accepted once into a teammate, a password and a session; sign-in answers the same
 * for an unknown email and a wrong password, and locks after ten; sessions end when revoked, idle or
 * over their limit, and a new password signs out every other device; everything is in the audit
 * log; tokens only work in their own workspace; the host's bridge keeps the session in an HttpOnly
 * cookie and the API resolves it on every request.
 */
test("passwords: scrypt hashes, verified in constant time; weak ones refused", () => {
  const h = hashPassword("correct horse battery");
  assert.match(h, /^scrypt\$32768\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
  assert.ok(verifyPassword("correct horse battery", h));
  assert.ok(!verifyPassword("correct horse batterz", h));
  assert.ok(!verifyPassword("anything", "plain-text"));
  assert.notEqual(hashPassword("same password!!"), hashPassword("same password!!"), "salted");
  assert.ok(!needsRehash(h) && needsRehash("scrypt$16384$8$1$AAAA$AAAA"));
  assert.match(passwordProblem("short")!, /at least 12/);
  assert.match(passwordProblem("grace.hopper-is-great", "grace.hopper@example.test")!, /email address/);
  assert.match(passwordProblem("aaaaaaaaaaaaaaa")!, /variety/);
  assert.equal(passwordProblem("a long, varied passphrase"), null);
});

test("accounts: invitations, sign-in and lockout, sessions and their limits, devices, the bridge's cookie, the audit log", async () => {
  const db = await testDatabase();
  const q = <T = Record<string, unknown>>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const client = { ip: "203.0.113.7", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130", origin: "https://relay.example" };
  const KEY = "k".repeat(64);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
    }
    const owner = (await q<{ id: string }>("a", "SELECT id FROM teammates WHERE principal_id='owner-a'"))[0].id;
    const invite = (p: Record<string, unknown>, principal = "owner-a") => tenant(db.connect, "a", (x) => changeInvitations(x, "a", principal, { key: KEY }, client, { action: "create", ...p }));

    // An invitation: to a role within the inviter's own, its link shown once and emailed (sealed).
    await tenant(db.connect, "a", (x) => saveRole(x, "a", "owner-a", { name: "Lead", capabilities: ["conversations.read", "teammates.manage"] }));
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','lee','lee-a','Lee','lead')");
    await assert.rejects(invite({ email: "x@example.test", roleId: "admin" }, "lee-a"), /roles within your own permissions/);
    await assert.rejects(invite({ email: "not an email", roleId: "agent" }), /Enter an email/);
    const made = (await invite({ email: "Grace@Example.test", name: "Grace", roleId: "agent" })) as unknown as { id: string; link: string; emailed: boolean };
    assert.ok(made.emailed);
    assert.match(made.link, /^https:\/\/relay\.example\/invite#relay_inv_[\w-]+_[A-Za-z0-9]{40}$/);
    const token = made.link.split("#")[1];
    const stored = JSON.stringify(await q("a", "SELECT * FROM teammate_invitations"));
    assert.ok(!stored.includes(token.split("_").at(-1)!), "the invitation's secret is kept only as a hash");
    const alert = (await q<{ id: string; link_sealed: string }>("a", "SELECT id,link_sealed FROM email_alerts WHERE kind='invitation'"))[0];
    assert.ok(alert.link_sealed && !alert.link_sealed.includes(token));
    // Sent through the alert path: the link in the email, and the sealed copy cleared.
    const provider = localEmailProvider();
    const job = (await q<Job>("a", "SELECT * FROM jobs WHERE kind='email.alert' ORDER BY created_at DESC LIMIT 1"))[0];
    await sendAlert(db.connect, { sender: provider.sender, inboundDomain: "in.test", sendingDomain: "relay.test", region: "eu-west-2", key: KEY }, job);
    const email = provider.outbox.at(-1)!;
    assert.equal(email.to, "grace@example.test");
    const parsed = await PostalMime.parse(email.raw);
    assert.ok(parsed.text?.includes(made.link), "the email carries the link");
    assert.equal(parsed.subject, "Support teammate invited you to Relay");
    assert.deepEqual(await q("a", "SELECT status,link_sealed FROM email_alerts WHERE id=$1", [alert.id]), [{ status: "sent", link_sealed: null }]);

    // The invite page reads it; accepting makes Grace, her password and her first session.
    assert.deepEqual(await readInvitation(db.connect, "a", token), {
      email: "grace@example.test",
      name: "Grace",
      role: "agent",
      invitedBy: "Support teammate",
      workspace: "Relay",
      expiresAt: (await readInvitation(db.connect, "a", token)).expiresAt,
      reset: false,
    });
    await assert.rejects(readInvitation(db.connect, "b", token), /isn't valid/);
    await assert.rejects(acceptInvitation(db.connect, "a", { token, name: "Grace", password: "short" }, client), /at least 12/);
    const first = await acceptInvitation(db.connect, "a", { token, name: "Grace Hopper", password: "a long, varied passphrase" }, client);
    assert.match(first.token, /^relay_ses_[\w-]+_[A-Za-z0-9]{40}$/);
    const grace = (await q<{ id: string; principal_id: string; role_id: string }>("a", "SELECT id,principal_id,role_id FROM teammates WHERE name='Grace Hopper'"))[0];
    assert.deepEqual([grace.principal_id.startsWith("relay:"), grace.role_id], [true, "agent"]);
    await assert.rejects(acceptInvitation(db.connect, "a", { token, name: "Again", password: "a long, varied passphrase" }, client), /already been used/);
    // Withdrawn and expired invitations can't be used.
    const withdrawn = (await invite({ email: "w@example.test", roleId: "agent" })) as unknown as { id: string; link: string };
    await tenant(db.connect, "a", (x) => changeInvitations(x, "a", "owner-a", { key: KEY }, client, { action: "revoke", id: withdrawn.id }));
    await assert.rejects(readInvitation(db.connect, "a", withdrawn.link.split("#")[1]), /withdrawn/);
    const old = (await invite({ email: "e@example.test", roleId: "agent" })) as unknown as { id: string; link: string };
    await q("a", "UPDATE teammate_invitations SET expires_at=now()-interval '1 minute' WHERE id=$1", [old.id]);
    await assert.rejects(readInvitation(db.connect, "a", old.link.split("#")[1]), /expired/);

    // Sign-in: the same answer for an unknown email and a wrong password; ten wrong ones lock it.
    await assert.rejects(signIn(db.connect, "a", { email: "nobody@example.test", password: "whatever it is" }, client), /don't match an account here/);
    await assert.rejects(signIn(db.connect, "a", { email: "grace@example.test", password: "wrong password!!" }, client), /don't match an account here/);
    const signed = await signIn(db.connect, "a", { email: "GRACE@example.test", password: "a long, varied passphrase" }, client);
    const me = await resolveSession(db.connect, "a", signed.token, client);
    assert.deepEqual([me.principal, me.teammateId], [grace.principal_id, grace.id]);
    for (let i = 0; i < 10; i++) await assert.rejects(signIn(db.connect, "a", { email: "grace@example.test", password: "wrong password!!" }, client));
    await assert.rejects(signIn(db.connect, "a", { email: "grace@example.test", password: "a long, varied passphrase" }, client), /Too many attempts/);
    await q("a", "UPDATE teammate_credentials SET locked_until=now()-interval '1 second'");
    const third = await signIn(db.connect, "a", { email: "grace@example.test", password: "a long, varied passphrase" }, client);

    // Tokens only work in their own workspace.
    await assert.rejects(resolveSession(db.connect, "b", signed.token), /signed out/);

    // Devices: Grace sees hers; changing her password signs out every other one.
    const devices = await tenant(db.connect, "a", (x) => readAccount(x, "a", grace.principal_id, me.sessionId));
    assert.equal(devices.email, "grace@example.test");
    assert.equal(devices.sessions.length, 3);
    assert.equal(devices.sessions.filter((s) => s.current).length, 1);
    await assert.rejects(
      tenant(db.connect, "a", (x) => changeAccount(x, "a", grace.principal_id, me.sessionId, { action: "password", current: "nope", password: "another long passphrase" })),
      /current password isn't right/,
    );
    await tenant(db.connect, "a", (x) => changeAccount(x, "a", grace.principal_id, me.sessionId, { action: "password", current: "a long, varied passphrase", password: "another long passphrase" }));
    assert.equal((await resolveSession(db.connect, "a", signed.token)).sessionId, me.sessionId, "this device stays signed in");
    await assert.rejects(resolveSession(db.connect, "a", first.token), /signed out/);
    await assert.rejects(resolveSession(db.connect, "a", third.token), /signed out/);
    // A teammate from the hosting platform sets up a password (an email no one else uses).
    await assert.rejects(
      tenant(db.connect, "a", (x) => changeAccount(x, "a", "owner-a", null, { action: "password", email: "grace@example.test", password: "a strong admin phrase" })),
      /Another teammate signs in/,
    );
    await tenant(db.connect, "a", (x) => changeAccount(x, "a", "owner-a", null, { action: "password", email: "owner@example.test", password: "a strong admin phrase" }));
    const ownerSession = await signIn(db.connect, "a", { email: "owner@example.test", password: "a strong admin phrase" }, client);

    // Session limits: for who manages security; a shorter absolute limit applies to open sessions.
    await assert.rejects(
      tenant(db.connect, "a", (x) => readSessions(x, "a", grace.principal_id, null)),
      /permission/,
    );
    await assert.rejects(
      tenant(db.connect, "a", (x) => changeSessions(x, "a", "owner-a", null, { action: "settings", idleMinutes: 5, absoluteHours: 24 })),
      /15 minutes to 30 days/,
    );
    await tenant(db.connect, "a", (x) => changeSessions(x, "a", "owner-a", null, { action: "settings", idleMinutes: 60, absoluteHours: 1 }));
    assert.ok((await q<{ ok: boolean }>("a", "SELECT bool_and(expires_at<=created_at+interval '1 hour') AS ok FROM teammate_sessions WHERE revoked_at IS NULL"))[0].ok);
    // Idle too long, or over the limit: signed out, with the reason kept.
    await q("a", "UPDATE teammate_sessions SET last_seen_at=now()-interval '2 hours' WHERE id=$1", [me.sessionId]);
    await assert.rejects(resolveSession(db.connect, "a", signed.token), /signed out/);
    assert.equal((await q<{ revoked_reason: string }>("a", "SELECT revoked_reason FROM teammate_sessions WHERE id=$1", [me.sessionId]))[0].revoked_reason, "Not used for too long.");
    await q("a", "UPDATE teammate_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [ownerSession.sessionId]);
    await assert.rejects(resolveSession(db.connect, "a", ownerSession.token), /signed out/);
    // Ended by who manages security.
    await tenant(db.connect, "a", (x) => changeSessions(x, "a", "owner-a", null, { action: "settings", idleMinutes: 5760, absoluteHours: 720 }));
    const fourth = await signIn(db.connect, "a", { email: "grace@example.test", password: "another long passphrase" }, client);
    const all = await tenant(db.connect, "a", (x) => readSessions(x, "a", "owner-a", null));
    assert.ok(all.sessions.some((s) => s.id === fourth.sessionId && s.teammate?.name === "Grace Hopper"));
    await tenant(db.connect, "a", (x) => changeSessions(x, "a", "owner-a", null, { action: "revoke", sessionId: fourth.sessionId }));
    await assert.rejects(resolveSession(db.connect, "a", fourth.token), /signed out/);
    // A password reset, sent by a manager: Grace chooses a new password; her old sessions end; no new teammate.
    const before = await signIn(db.connect, "a", { email: "grace@example.test", password: "another long passphrase" }, client);
    const reset = (await tenant(db.connect, "a", (x) => changeInvitations(x, "a", "owner-a", { key: KEY }, client, { action: "reset", teammateId: grace.id }))) as unknown as { link: string };
    const resetToken = reset.link.split("#")[1];
    assert.equal((await readInvitation(db.connect, "a", resetToken)).reset, true);
    await assert.rejects(
      tenant(db.connect, "a", (x) => changeInvitations(x, "a", "lee-a", { key: KEY }, client, { action: "reset", teammateId: owner })),
      /doesn't sign in with a password|permissions you don't/,
    );
    const renewed = await acceptInvitation(db.connect, "a", { token: resetToken, password: "a brand new passphrase" }, client);
    await assert.rejects(resolveSession(db.connect, "a", before.token), /signed out/);
    assert.equal((await resolveSession(db.connect, "a", renewed.token)).teammateId, grace.id);
    assert.equal((await q("a", "SELECT 1 FROM teammates WHERE name='Grace Hopper'")).length, 1, "no second Grace");
    await assert.rejects(signIn(db.connect, "a", { email: "grace@example.test", password: "another long passphrase" }, client), /don't match/);
    // (Back to the passphrase the rest of the test uses.)
    await tenant(db.connect, "a", (x) => changeAccount(x, "a", grace.principal_id, renewed.sessionId, { action: "password", current: "a brand new passphrase", password: "another long passphrase" }));
    // Signing out.
    const fifth = await signIn(db.connect, "a", { email: "grace@example.test", password: "another long passphrase" }, client);
    await signOut(db.connect, "a", fifth.token);
    await assert.rejects(resolveSession(db.connect, "a", fifth.token), /signed out/);

    // The audit log: invitations, sign-ins (and failures), the password, sign-outs and ended sessions.
    const actions = (await q<{ action: string }>("a", "SELECT DISTINCT action FROM audit_events")).map((r) => r.action);
    for (const a of [
      "invitation.created",
      "invitation.revoked",
      "invitation.accepted",
      "teammate.created",
      "account.created",
      "account.changed",
      "session.signed_in",
      "session.sign_in_failed",
      "session.signed_out",
      "session.revoked",
      "session_settings.created",
      "session_settings.changed",
    ])
      assert.ok(actions.includes(a), `audited: ${a}`);
    const audit = JSON.stringify(await q("a", "SELECT * FROM audit_events"));
    assert.ok(!audit.includes("scrypt$") && !audit.includes(token), "no hash or token in the log");
    assert.equal((await q<{ actor_id: string }>("a", "SELECT actor_id FROM audit_events WHERE action='session.signed_in' ORDER BY seq LIMIT 1"))[0].actor_id, grace.id);

    // Through the host's bridge: the session goes into an HttpOnly cookie; the API resolves it.
    const env: ApiEnvironment = {
      connect: db.connect,
      sessionSecret: "s".repeat(40),
      identityMaster: "m".repeat(40),
      bridgeSecret: "b".repeat(40),
      realtimeUrl: "wss://relay.test/realtime",
      storageTransport: "local-pglite",
    };
    const config = { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: "a", RELAY_BRIDGE_SECRET: env.bridgeSecret };
    const auth = (action: string, body: unknown, cookie = "") =>
      bridgeAuthRequest(
        new Request("https://app.test/auth/" + action, { method: "POST", headers: { origin: "https://app.test", "content-type": "application/json", cookie }, body: JSON.stringify(body) }),
        config,
        (r) => handleApi(r, env),
      );
    const inbox = (cookie: string) =>
      bridgeAgentRequest(new Request("https://app.test/api/agent/inbox", { headers: { cookie } }), undefined, config, (r) => handleApi(r, env), cookie.split("relay_session=")[1]);
    const r = await auth("signin", { email: "grace@example.test", password: "another long passphrase" });
    assert.equal(r.status, 200);
    const cookie = r.headers.get("set-cookie")!;
    assert.match(cookie, /^relay_session=relay_ses_[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    assert.ok(!(await r.text()).includes("relay_ses_"), "the token never reaches the page");
    const jar = cookie.split(";")[0];
    const opened = await inbox(jar);
    assert.equal(opened.status, 200);
    const body = (await opened.json()) as { teammate: { id: string }; account: { relaySession: boolean } };
    assert.deepEqual([body.teammate.id, body.account.relaySession], [grace.id, true]);
    const out = await auth("signout", {}, jar);
    assert.match(out.headers.get("set-cookie")!, /^relay_session=; .*Max-Age=0/);
    const after = await inbox(jar);
    assert.equal(after.status, 401);
    assert.equal(((await after.json()) as { error: { code: string } }).error.code, "SIGNED_OUT");
    // Wrong answers through the bridge, and a forged call straight to the API.
    assert.equal((await auth("signin", { email: "grace@example.test", password: "nope nope nope" })).status, 401);
    assert.equal((await handleApi(new Request("https://relay.test/v1/auth/signin", { method: "POST", body: "{}" }), env)).status, 401);
    assert.equal(
      (await bridgeAuthRequest(new Request("https://app.test/auth/signin", { method: "POST", headers: { origin: "https://evil.test" }, body: "{}" }), config, (x) => handleApi(x, env))).status,
      403,
    );

    // The rollback: every password session ends; open invitations are withdrawn.
    const live = await signIn(db.connect, "a", { email: "grace@example.test", password: "another long passphrase" }, client);
    const rollback = await readFile("db/rollback/0083_teammate_accounts.sql", "utf8");
    for (const statement of rollback
      .split("\n")
      .filter((l) => !l.startsWith("--"))
      .join("\n")
      .split(";")
      .filter((s) => s.trim()))
      await db.pg.exec(statement);
    await assert.rejects(resolveSession(db.connect, "a", live.token), /signed out/);
    assert.deepEqual(await q("a", "SELECT 1 FROM teammate_invitations WHERE accepted_at IS NULL AND revoked_at IS NULL"), []);
    assert.ok(owner);
  } finally {
    await db.close();
  }
});
