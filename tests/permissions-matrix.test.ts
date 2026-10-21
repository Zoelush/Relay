import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { AGENT_ROUTES, bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { handleRest } from "../server/rest";
import { capabilities, type Capability } from "../server/policy";
import { changeDeveloperTokens } from "../server/developer";
import { operations, SPEC } from "../lib/api-spec";
import { PERMISSION_INFO, RESTRICTED_ALLOWED } from "../lib/permissions";
import { ROUTE_POLICY } from "./fixtures/route-policy";

/**
 * The permissions matrix (phase 16, C2; docs/SECURITY_STEP2.md). Every agent route is in
 * `tests/fixtures/route-policy.ts` with the one permission it needs; every role is held to it:
 * a role without that permission is refused (403), and a role with it isn't. Built-in roles, a
 * restricted role, a role with no permissions beyond reading, and a role per permission. The
 * public API's operations likewise, by token scope and by the teammate's role at the time.
 */
test("permissions matrix: every agent route and API operation, against every kind of role", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    webhooks: { key: "k".repeat(64) },
  };
  try {
    await tenant(db.connect, "a", (q) => seedFoundation(q, "a", "owner-a", { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
    await tenant(db.connect, "a", (q) => q.query("UPDATE workspace_features SET enabled=true"));

    // Every capability is explained, and every route has a line in the table (and nothing extra).
    assert.deepEqual(Object.keys(PERMISSION_INFO).sort(), [...capabilities].sort(), "lib/permissions.ts explains every capability");
    const routes = [...[...AGENT_ROUTES.GET].map((r) => "GET " + r), ...[...AGENT_ROUTES.POST].map((r) => "POST " + r)].sort();
    assert.deepEqual(routes, Object.keys(ROUTE_POLICY).sort(), "every agent route has its permission in tests/fixtures/route-policy.ts");

    // The roles: built in, restricted, reading only, and one per permission.
    const roles: Record<string, { caps: string[]; scope?: "assigned" }> = {
      none: { caps: ["conversations.read"] },
      outsourced: { caps: RESTRICTED_ALLOWED, scope: "assigned" },
    };
    for (const c of capabilities) if (c !== "conversations.read") roles["only_" + c.replace(/\W/g, "_")] = { caps: ["conversations.read", c] };
    await tenant(db.connect, "a", async (q) => {
      for (const [r, { caps, scope }] of Object.entries(roles)) {
        await q.query("INSERT INTO roles(workspace_id,id,name,scope) VALUES('a',$1,$1,$2)", [r, scope ?? "all"]);
        for (const c of caps) await q.query("INSERT INTO role_capabilities(workspace_id,role_id,capability) VALUES('a',$1,$2)", [r, c]);
        await q.query("INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a',$1,$2,$1,$3)", ["t_" + r, "p_" + r, r]);
      }
      for (const r of ["admin", "agent"]) await q.query("INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a',$1,$2,$1,$3)", ["t_" + r, "p_" + r, r]);
    });
    const held = async (role: string) =>
      (await tenant(db.connect, "a", (q) => q.query<{ capability: string }>("SELECT capability FROM role_capabilities WHERE workspace_id='a' AND role_id=$1", [role]))).rows.map((r) => r.capability);
    const caps: Record<string, string[]> = { owner: await held("owner"), admin: await held("admin"), agent: await held("agent") };
    for (const [r, x] of Object.entries(roles)) caps[r] = x.caps;
    const principal = (role: string) => (role === "owner" ? "owner-a" : "p_" + role);

    const call = async (route: string, role: string) => {
      const [method, path] = route.split(" ");
      const body = ROUTE_POLICY[route].body ?? {};
      const r = await bridgeAgentRequest(
        new Request("https://app.test/api/agent/" + path, {
          method,
          headers: { origin: "https://app.test", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        }),
        principal(role),
        { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: "a", RELAY_BRIDGE_SECRET: env.bridgeSecret },
        (x) => handleApi(x, env),
      );
      return r.status;
    };
    const wrong: string[] = [];
    for (const route of Object.keys(ROUTE_POLICY).sort()) {
      const needs = ROUTE_POLICY[route].needs;
      // The roles that decide it: the built-in ones, the restricted one, reading only, the one
      // with exactly this permission, and one with a different permission.
      const deciding = new Set(["owner", "admin", "agent", "outsourced", "none"]);
      if (needs !== "teammate") deciding.add("only_" + needs.replace(/\W/g, "_"));
      deciding.add(needs === "reports.view" ? "only_tickets_manage" : "only_reports_view");
      for (const role of deciding) {
        const allowed = (needs === "teammate" || caps[role].includes(needs)) && !(role === "outsourced" && ROUTE_POLICY[route].restricted === false);
        const status = await call(route, role);
        if (allowed ? status === 403 : status !== 403) wrong.push(`${route} as ${role}: ${status} (needs ${needs})`);
      }
    }
    assert.deepEqual(wrong, [], "every role is held to each route's permission");

    // The public API: a token needs the operation's scope, and its teammate's role must still have it.
    const token = async (role: string, scopes: string[]) =>
      ((await tenant(db.connect, "a", (q) => changeDeveloperTokens(q, "a", principal(role), { action: "create", name: role, scopes }))) as { token: string }).token;
    const rest = async (t: string, method: string, path: string) =>
      (
        await handleRest(
          new Request("http://api.test/rest" + path, { method, headers: { authorization: "Bearer " + t, "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) }),
          { connect: db.connect },
        )
      ).status;
    const reader = await token("none", ["conversations.read"]);
    const apiWrong: string[] = [];
    for (const { method, path, operation } of operations(SPEC)) {
      const scope = operation["x-relay-scope"] as Capability | null;
      const url = path.replace(/\{[^}]+\}/g, "x");
      if (!scope) continue;
      const own = await token(scope === "conversations.read" ? "none" : "only_" + scope.replace(/\W/g, "_"), [scope]);
      if ((await rest(own, method.toUpperCase(), url)) === 403) apiWrong.push(`${method} ${path}: refused with its scope`);
      if (scope !== "conversations.read" && (await rest(reader, method.toUpperCase(), url)) !== 403) apiWrong.push(`${method} ${path}: allowed without ${scope}`);
    }
    assert.deepEqual(apiWrong, [], "every API operation is held to its scope");
    // A token keeps working only while its teammate's role keeps the permission.
    const exporter = await token("only_data_export", ["data.export"]);
    assert.equal(await rest(exporter, "GET", "/exports/x"), 404);
    await tenant(db.connect, "a", (q) => q.query("DELETE FROM role_capabilities WHERE workspace_id='a' AND role_id='only_data_export' AND capability='data.export'"));
    assert.equal(await rest(exporter, "GET", "/exports/x"), 403);
  } finally {
    await db.close();
  }
});
