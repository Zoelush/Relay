import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { readHealthCheck } from "../server/health-check";
import { hashPassword } from "../server/passwords";
import { seal } from "../server/connectors";
import { startSession } from "../server/accounts";
import { CHECKS, type CheckId, type Severity } from "../lib/health-check";
import { KEYS, PROTECTIONS, trustDocument } from "../lib/encryption";
import { PROCESSORS } from "../lib/processors";

/** The security health check, and the subprocessors and encryption page (phase 16, C7c; docs/SECURITY_STEP13.md). */
test("health check: every check decided from the settings, most severe first; managers only; per workspace", async () => {
  const db = await testDatabase();
  const api: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const agent = async (path: string, principal = "owner-a", w = "a", env = api) => {
    const r = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, { headers: { origin: "https://app.test" } }),
      principal,
      { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: w, RELAY_BRIDGE_SECRET: api.bridgeSecret },
      (x) => handleApi(x, env),
    );
    return { status: r.status, body: (await r.json()) as any };
  };
  // Read directly: the IP allowlist set below would refuse the test's own requests.
  const check = (lookup = false) => tenant(db.connect, "a", (x) => readHealthCheck(x, "a", "owner-a", { lookup }));
  const severities = async (lookup = false) => {
    const r = await check(lookup);
    return Object.fromEntries(r.checks.map((c) => [c.id, c.severity])) as Record<CheckId, Severity>;
  };
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: api.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
    }
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");
    await q("a", "INSERT INTO teammate_credentials(workspace_id,teammate_id,email,password_hash) SELECT 'a',id,'agent@example.test',$1 FROM teammates WHERE principal_id='agent-1-a'", [hashPassword("a long, varied passphrase")]);

    // A new workspace: every check, each once, in the registry's groups.
    const first = (await agent("health-check")).body;
    assert.deepEqual(first.checks.map((c: { id: string }) => c.id), Object.keys(CHECKS), "every check is decided");
    assert.deepEqual(await severities(), {
      two_factor: "critical",
      without_two_factor: "recommended",
      sso: "optional",
      sessions: "ok",
      ip_allowlist: "optional",
      support_access: "ok",
      identity_verification: "ok",
      legacy_hmac: "ok",
      allowed_websites: "recommended",
      redaction: "recommended",
      retention: "optional",
      link_lookup: "optional",
      risky_merges: "ok",
    });
    assert.deepEqual(first.summary, { critical: 1, recommended: 3, optional: 4, ok: 5 });
    assert.deepEqual(
      first.attention.map((c: { id: string }) => c.id),
      ["two_factor", "without_two_factor", "allowed_websites", "redaction", "sso", "ip_allowlist", "retention", "link_lookup"],
      "most severe first, then in the registry's order",
    );
    assert.match(first.checks.find((c: { id: string }) => c.id === "without_two_factor").state, /^1 teammate with a password has no two-factor\.$/);
    assert.equal(first.checks.find((c: { id: string }) => c.id === "two_factor").link, "#settings/access");

    // Each setting changes its check.
    await q("a", "INSERT INTO security_settings(workspace_id,require_two_factor,app_allowlist,idle_minutes) VALUES('a',true,'{203.0.113.0/24}',10000)");
    await q("a", "INSERT INTO teammate_two_factor(workspace_id,teammate_id,secret_sealed,enabled_at) VALUES('a','agent-1','x',now())");
    await q("a", `UPDATE brands SET settings=jsonb_set(settings,'{allowedOrigins}','["https://shop.example"]'),identity_enforced=false,legacy_hmac_enabled=true`);
    await q("a", "INSERT INTO redaction_rules(workspace_id,id,kind,builtin,name) VALUES('a','r1','builtin','card','Card numbers')");
    await q("a", "INSERT INTO retention_settings(workspace_id,conversations_days) VALUES('a',365)");
    await q("a", "UPDATE security_settings SET merge_leads_by_email=true");
    await q("a", "INSERT INTO support_grants(workspace_id,id,granted_by,expires_at) VALUES('a','g1','owner',now()+interval '1 day')");
    await q(
      "a",
      "INSERT INTO sso_connections(workspace_id,id,name,issuer,client_id,authorization_endpoint,token_endpoint,jwks_uri,enabled) VALUES('a','c1','Okta','https://idp.example','x','https://idp.example/a','https://idp.example/t','https://idp.example/k',true)",
    );
    const changed = await severities(true);
    assert.deepEqual(changed, {
      two_factor: "ok",
      without_two_factor: "ok",
      sso: "recommended",
      sessions: "recommended",
      ip_allowlist: "ok",
      support_access: "recommended",
      identity_verification: "recommended",
      legacy_hmac: "recommended",
      allowed_websites: "ok",
      redaction: "ok",
      retention: "ok",
      link_lookup: "ok",
      risky_merges: "recommended",
    });
    const states = Object.fromEntries((await check()).checks.map((c) => [c.id, c.state]));
    assert.equal(states.risky_merges, "Leads into users by email can be merged.");
    assert.match(states.support_access, /until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    assert.match(states.identity_verification, /Not enforced for /);
    // SSO enforced counts as two-factor's alternative.
    await q("a", "UPDATE security_settings SET require_two_factor=false");
    await q("a", "UPDATE sso_connections SET enforced=true");
    assert.deepEqual([(await severities()).two_factor, (await severities()).sso], ["ok", "ok"]);

    // Managers only; another workspace's check is its own.
    // (With SSO enforced, an agent's platform sign-in is refused before permissions; lift both to test them.)
    await q("a", "UPDATE security_settings SET app_allowlist='{}'");
    await q("a", "UPDATE sso_connections SET enforced=false");
    assert.equal((await agent("health-check", "agent-1-a")).status, 403);
    assert.equal((await severities()).redaction, "ok");
    const other = (await agent("health-check", "owner-b", "b")).body;
    assert.equal(other.checks.find((c: { id: string }) => c.id === "redaction").severity, "recommended");
    await assert.rejects(tenant(db.connect, "b", (x) => readHealthCheck(x, "b", "owner-a", { lookup: false })));
  } finally {
    await db.close();
  }
});

test("subprocessors and encryption: the document matches the registries, and the registries match the code", async () => {
  assert.equal(await readFile("docs/TRUST.md", "utf8"), trustDocument(), "run npm run trust:doc");
  const doc = trustDocument();
  for (const p of PROCESSORS) assert.ok(doc.includes(p.name), p.name);
  // Passwords: scrypt at the stated cost, with a 16-byte salt.
  const stated = PROTECTIONS.find((p) => p.id === "passwords")!.how;
  assert.match(stated, /N=2\^15, r=8, p=1/);
  const [scheme, n, r, p, salt] = hashPassword("a long, varied passphrase").split("$");
  assert.deepEqual([scheme, n, r, p], ["scrypt", String(2 ** 15), "8", "1"]);
  assert.equal(Buffer.from(salt, "base64url").length, 16);
  // Secrets: AES-GCM with a 96-bit nonce, bound to the workspace and purpose.
  const key = "k".repeat(64);
  const sealed = await seal(key, "a", "connector-1", "token", "secret value");
  const [iv, data] = sealed.split(".");
  assert.equal(Buffer.from(iv, "base64").length, 12);
  const aes = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)), "AES-GCM", false, ["decrypt"]);
  const open = (aad: string) =>
    crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv, "base64"), additionalData: new TextEncoder().encode(aad) }, aes, Buffer.from(data, "base64"));
  assert.equal(new TextDecoder().decode(await open(JSON.stringify(["a", "connector-1", "token"]))), "secret value");
  await assert.rejects(open(JSON.stringify(["b", "connector-1", "token"])), "another workspace can't open it");
  // (Opened above with a 32-byte SHA-256 digest as the key: AES-256.)
  // Tokens: sessions are kept only as SHA-256 hashes.
  const db = await testDatabase();
  try {
    await tenant(db.connect, "a", (x) => seedFoundation(x, "a", "owner-a", { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
    const s = await tenant(db.connect, "a", async (x) => {
      const t = (await x.query<{ id: string }>("SELECT id FROM teammates WHERE principal_id='owner-a'")).rows[0];
      return startSession(x, "a", t.id, "password", {});
    });
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.token)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const rows = await tenant(db.connect, "a", async (x) => (await x.query<{ token_hash: string }>("SELECT token_hash FROM teammate_sessions")).rows);
    assert.deepEqual(rows, [{ token_hash: hex }]);
    assert.ok(!JSON.stringify(rows).includes(s.token));
  } finally {
    await db.close();
  }
  // Every key named is one the deployment reads.
  const worker = await readFile("workers/relay.ts", "utf8");
  for (const k of KEYS) assert.ok(worker.includes(k.name) || (k.name === "RELAY_BRIDGE_SECRET" && (await readFile("server/agent-bridge.ts", "utf8")).includes(k.name)), k.name);
});
