import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { resolveSession } from "../server/accounts";
import { changeSso, finishSso, readSso, samlAcs, ssoMetadata, startSso } from "../server/sso";
import { readCertificate } from "../server/saml";
import { bridgeSsoRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { startLocalIdp } from "../scripts/local-idp";

/**
 * SAML 2.0 single sign-on (phase 16, C4b; docs/SECURITY_STEP6.md), against the stand-in provider's
 * SAML endpoints: the connection (SSO URL, entity ID, certificate) and Relay's metadata; a sign-in
 * goes by HTTP-Redirect and comes back by HTTP-POST, parked on its login and finished only by the
 * browser holding the login's cookie; only a signed assertion from the configured certificate, in
 * response to the login's own request, gets in; tampered, replayed and refused responses are each
 * refused and recorded; C4a's domains, group roles and just-in-time teammates apply unchanged.
 */
test("saml: the connection and metadata, the redirect and post, signatures, InResponseTo, the host, rollback", async () => {
  const db = await testDatabase();
  const idp = await startLocalIdp({ port: 9141 });
  const q = <T = Record<string, unknown>>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const env = { key: "k".repeat(64), policy: { allowHosts: [idp.host] } };
  const client = { ip: "203.0.113.7", userAgent: "Mozilla/5.0 (Macintosh) Chrome/130", origin: "http://127.0.0.1:9142" };
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
    }
    const sso = (p: Record<string, unknown>) => tenant(db.connect, "a", (x) => changeSso(x, "a", "owner-a", env, client, p, null));
    const connection = { action: "connection", protocol: "saml", name: "Test SAML", entryPoint: idp.saml.ssoUrl, idpIssuer: idp.saml.entityId, idpCert: idp.saml.cert };

    // The connection: a certificate is checked; the SSO URL is under the fetch policy.
    assert.throws(() => readCertificate("not a certificate"), /signing certificate/);
    assert.match(readCertificate(idp.saml.cert.replace(/-----[A-Z ]+-----/g, "").replace(/\n/g, " ")), /^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----$/, "pasted without its header");
    await assert.rejects(sso({ ...connection, idpCert: "nope" }), /signing certificate/);
    await assert.rejects(tenant(db.connect, "a", (x) => changeSso(x, "a", "owner-a", { ...env, policy: {} }, client, connection, null)), /public https/);
    const saved = await sso(connection);
    assert.deepEqual(
      [saved.connection!.protocol, saved.connection!.entryPoint, saved.connection!.issuer, saved.connection!.clientId],
      ["saml", idp.saml.ssoUrl, idp.saml.entityId, null],
    );
    assert.deepEqual(saved.serviceProvider, { entityId: client.origin + "/auth/saml/metadata", acsUrl: client.origin + "/auth/saml/acs", metadataUrl: client.origin + "/auth/saml/metadata" });
    // Relay's metadata, for the provider: its entity ID and ACS (HTTP-POST).
    const { xml } = await ssoMetadata(db.connect, "a", client);
    assert.match(xml, /entityID="http:\/\/127\.0\.0\.1:9142\/auth\/saml\/metadata"/);
    assert.match(xml, /AssertionConsumerService[^>]+Binding="urn:oasis:names:tc:SAML:2\.0:bindings:HTTP-POST"[^>]+Location="http:\/\/127\.0\.0\.1:9142\/auth\/saml\/acs"/);
    await assert.rejects(ssoMetadata(db.connect, "b", client), /no SAML connection/);

    // C4a's domain and group roles, unchanged.
    await q("a", "INSERT INTO sso_domains(workspace_id,domain,token,verified_at) VALUES('a','example.test','t',now())");
    await sso({ action: "mappings", mappings: [{ group: "Support", roleId: "agent" }] });
    await sso({ action: "enabled", on: true });

    // The browser: to the provider by HTTP-Redirect, back by the provider's form post.
    const atProvider = async (url: string, choice: string) => {
      const page = await (await fetch(url + "&" + choice)).text();
      return { samlResponse: /name="SAMLResponse" value="([^"]+)"/.exec(page)![1], relayState: /name="RelayState" value="([^"]+)"/.exec(page)![1] };
    };
    const signInAs = async (person: string) => {
      const started = await startSso(db.connect, "a", { next: "/agent" }, client);
      const posted = await atProvider(started.url, "person=" + person);
      const { state } = await samlAcs(db.connect, "a", posted);
      return finishSso(db.connect, "a", env, { login: started.login, state }, client);
    };
    const started = await startSso(db.connect, "a", {}, client);
    const to = new URL(started.url);
    assert.equal(to.origin + to.pathname, idp.saml.ssoUrl);
    assert.ok(to.searchParams.get("SAMLRequest") && to.searchParams.get("RelayState"));

    const ada = await signInAs("ada");
    const adaTeammate = (await q<{ id: string; role_id: string }>("a", "SELECT t.id,t.role_id FROM teammates t JOIN sso_identities i ON i.teammate_id=t.id WHERE i.subject='ada@example.test'"))[0];
    assert.equal(adaTeammate.role_id, "agent");
    assert.equal((await resolveSession(db.connect, "a", ada.token)).teammateId, adaTeammate.id);
    assert.deepEqual(await q("a", "SELECT method FROM teammate_sessions WHERE id=$1", [ada.sessionId]), [{ method: "sso" }]);
    assert.deepEqual(await q("a", "SELECT count(*)::int AS n FROM sso_logins WHERE saml_response IS NOT NULL"), [{ n: 0 }], "a parked response is cleared once used");

    // Refused: a tampered response, one replayed onto another login, one parked twice, one finished without its login.
    const s1 = await startSso(db.connect, "a", {}, client);
    const genuine = await atProvider(s1.url, "person=ada");
    const forged = Buffer.from(Buffer.from(genuine.samlResponse, "base64").toString().replace(/ada@example\.test/g, "max@example.test")).toString("base64");
    await samlAcs(db.connect, "a", { samlResponse: forged, relayState: genuine.relayState });
    await assert.rejects(finishSso(db.connect, "a", env, { login: s1.login, state: genuine.relayState }, client), /didn't confirm/);
    const s2 = await startSso(db.connect, "a", {}, client);
    await samlAcs(db.connect, "a", { samlResponse: genuine.samlResponse, relayState: (await atProvider(s2.url, "person=ada")).relayState });
    await assert.rejects(finishSso(db.connect, "a", env, { login: s2.login, state: new URL(s2.url).searchParams.get("RelayState") }, client), /didn't confirm/, "a response for another request");
    const s3 = await startSso(db.connect, "a", {}, client);
    const once = await atProvider(s3.url, "person=ada");
    await samlAcs(db.connect, "a", once);
    await assert.rejects(samlAcs(db.connect, "a", once), /expired/, "parked once");
    await assert.rejects(finishSso(db.connect, "a", env, { login: "relay_sso_YQ_" + "x".repeat(40), state: once.relayState }, client), /expired/, "only the browser that started it");
    await assert.rejects(samlAcs(db.connect, "b", once), /expired/, "not across workspaces");
    // The provider's refusal, a group that maps to nothing, a domain that isn't verified.
    const s4 = await startSso(db.connect, "a", {}, client);
    const cancelled = await atProvider(s4.url, "cancel=1");
    await samlAcs(db.connect, "a", cancelled);
    await assert.rejects(finishSso(db.connect, "a", env, { login: s4.login, state: cancelled.relayState }, client), /didn't let you sign in/);
    await assert.rejects(signInAs("sam"), /groups don't give you access/);
    await assert.rejects(signInAs("max"), /elsewhere\.test isn't a verified domain/);
    const reasons = (await q<{ details: { reason: string } }>("a", "SELECT details FROM audit_events WHERE action='session.sso_refused' ORDER BY seq")).map((r) => r.details.reason);
    assert.deepEqual(reasons, ["saml", "saml", "provider_error", "no_role", "domain_unverified"]);

    // A new certificate must be shown to work again: it clears "has worked".
    assert.ok((await tenant(db.connect, "a", (x) => readSso(x, "a", "owner-a", client))).connection!.lastSuccessAt);
    const other = (await readFile("tests/fixtures/saml/test-idp.crt", "utf8")).replace("A", "B");
    await assert.rejects(sso({ ...connection, idpCert: other.slice(0, 40) }), /signing certificate/);
    await sso({ ...connection, entryPoint: idp.saml.ssoUrl + "?again=1" });
    assert.equal((await tenant(db.connect, "a", (x) => readSso(x, "a", "owner-a", client))).connection!.lastSuccessAt, null);
    await sso(connection);

    // Through the host: the redirect, the provider's post (no cookie), then the callback (the cookie).
    const api: ApiEnvironment = {
      connect: db.connect,
      sessionSecret: "s".repeat(40),
      identityMaster: "m".repeat(40),
      bridgeSecret: "b".repeat(40),
      realtimeUrl: "wss://relay.test/realtime",
      storageTransport: "local-pglite",
      connectors: { key: env.key } as ApiEnvironment["connectors"],
      sso: { policy: env.policy },
    };
    const config = { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: "a", RELAY_BRIDGE_SECRET: api.bridgeSecret };
    const host = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
      bridgeSsoRequest(new Request(client.origin + path, { ...init, headers: { "sec-fetch-site": "same-origin", ...init.headers } }), config, (r) => handleApi(r, api));
    const metadata = await host("/auth/saml/metadata");
    assert.equal(metadata.headers.get("content-type"), "application/samlmetadata+xml");
    assert.match(await metadata.text(), /EntityDescriptor/);
    const go = await host("/auth/sso");
    assert.equal(go.status, 302);
    const cookie = go.headers.get("set-cookie")!.split(";")[0];
    const posted = await atProvider(go.headers.get("location")!, "person=ada");
    const acs = await host("/auth/saml/acs", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" },
      body: new URLSearchParams({ SAMLResponse: posted.samlResponse, RelayState: posted.relayState }).toString(),
    });
    assert.equal(acs.status, 303);
    assert.equal(acs.headers.get("location"), "/auth/sso/callback?state=" + posted.relayState);
    assert.equal((await host(acs.headers.get("location")!, { headers: { "sec-fetch-site": "cross-site" } })).headers.get("location"), "/signin?sso=SSO_EXPIRED", "not without the cookie");
    // That attempt used the login up: a fresh one, finished by the browser that holds its cookie.
    const go2 = await host("/auth/sso");
    const posted2 = await atProvider(go2.headers.get("location")!, "person=ada");
    const acs2 = await host("/auth/saml/acs", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ SAMLResponse: posted2.samlResponse, RelayState: posted2.relayState }).toString() });
    const done = await host(acs2.headers.get("location")!, { headers: { cookie: go2.headers.get("set-cookie")!.split(";")[0] } });
    assert.equal(done.headers.get("location"), "/agent");
    assert.ok(done.headers.getSetCookie().some((c) => c.startsWith("relay_session=relay_ses_")));
    assert.ok(cookie.startsWith("relay_sso="));

    // The rollback: the SAML connection is turned off.
    const rollback = await readFile("db/rollback/0086_saml.sql", "utf8");
    for (const statement of rollback
      .split("\n")
      .filter((l) => !l.startsWith("--"))
      .join("\n")
      .split(";")
      .filter((s) => s.trim()))
      await db.pg.exec(statement);
    assert.deepEqual(await q("a", "SELECT enabled,enforced FROM sso_connections"), [{ enabled: false, enforced: false }]);
  } finally {
    await idp.close();
    await db.close();
  }
});
