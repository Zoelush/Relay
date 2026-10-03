import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";

/** Settings › Teammates and Roles (S3a; docs/SETTINGS_STEP4.md). */
test("people settings: roles change within the manager's own permissions, never your own, always an owner; custom roles are created, edited and deleted when unused; saves are idempotent and kept to the workspace", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const send = (r: Request) => handleApi(r, env);
  const agent = async (
    path: string,
    data?: unknown,
    principal = "owner-a",
    workspace = "a",
    key: string = crypto.randomUUID(),
  ) => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
          "idempotency-key": key,
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      principal,
      {
        RELAY_AGENT_INBOX_V1: "true",
        RELAY_STORAGE_AUTHORITY: "postgres",
        RELAY_API_ORIGIN: "https://relay.test",
        RELAY_WORKSPACE_ID: workspace,
        RELAY_BRIDGE_SECRET: env.bridgeSecret,
      },
      send,
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const code = (r: { body: any }) => r.body.error?.code;
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, {
          origins: ["https://shop.test"],
          master: env.identityMaster,
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        }),
      );
      await sql(
        w,
        "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES($1,'agent-1','agent-1-'||$1,'Agent one','agent'),($1,'admin-1','admin-1-'||$1,'Admin one','admin')",
        [w],
      );
      await sql(
        w,
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name='settings_v1'",
        [w],
      );
    }
    const role = async (id: string) =>
      (await sql("a", "SELECT role_id FROM teammates WHERE id=$1", [id]))[0]
        .role_id;
    const move = (teammateId: string, roleId: string, as = "owner-a") =>
      agent("teammates", { teammateId, roleId }, as);

    // Pages: only for those who manage teammates.
    const pages = async (principal: string) =>
      (
        (await agent("settings?section=overview", undefined, principal)).body
          .pages as string[]
      ).filter((p) => ["teammates", "roles"].includes(p));
    assert.deepEqual(await pages("owner-a"), ["teammates", "roles"]);
    assert.deepEqual(await pages("agent-1-a"), []);
    assert.equal(
      (await agent("teammates", undefined, "agent-1-a")).status,
      403,
    );
    assert.equal((await move("admin-1", "agent", "agent-1-a")).status, 403);

    // The list: everyone with their role, and who you are.
    const listed = (await agent("teammates")).body;
    assert.equal(listed.you, "owner");
    assert.deepEqual(
      listed.teammates.map((t: any) => [t.name, t.role, t.seat]),
      [
        ["Admin one", "admin", "full"],
        ["Agent one", "agent", "full"],
        ["Support teammate", "owner", "full"],
      ],
    );
    assert.deepEqual(
      listed.roles.map((r: any) => [r.id, r.builtIn, r.editable]),
      [
        ["owner", true, false],
        ["admin", true, true],
        ["agent", true, true],
      ],
    );

    // A move saved twice with the same key is applied once and answers the same.
    const key = crypto.randomUUID();
    const first = await agent(
      "teammates",
      { teammateId: "agent-1", roleId: "admin" },
      "owner-a",
      "a",
      key,
    );
    assert.equal(first.status, 200);
    assert.deepEqual(
      (
        await agent(
          "teammates",
          { teammateId: "agent-1", roleId: "admin" },
          "owner-a",
          "a",
          key,
        )
      ).body,
      first.body,
    );
    assert.equal(await role("agent-1"), "admin");
    assert.equal((await move("agent-1", "agent")).status, 200);

    // Never your own role; never the last owner.
    assert.equal(code(await move("owner", "admin")), "OWN_ROLE");
    const last = await move("owner", "agent", "admin-1-a");
    assert.equal(last.status, 409);
    assert.equal(code(last), "LAST_OWNER");
    assert.equal(await role("owner"), "owner");

    // A custom role that manages teammates but little else can't hand out more than it has.
    const helper = await agent("roles", {
      name: "Helper",
      capabilities: ["conversations.read", "teammates.manage"],
    });
    assert.equal(helper.status, 200);
    assert.equal(helper.body.id, "helper");
    assert.equal((await move("agent-1", "helper")).status, 200);
    assert.equal(
      code(await move("admin-1", "agent", "agent-1-a")),
      "ROLE_ABOVE_YOURS",
    );
    assert.equal(
      code(await move("owner", "helper", "agent-1-a")),
      "ROLE_ABOVE_YOURS",
    );
    assert.equal(
      code(
        await agent(
          "roles",
          {
            name: "Sneaky",
            capabilities: ["conversations.read", "tickets.manage"],
          },
          "agent-1-a",
        ),
      ),
      "ROLE_ABOVE_YOURS",
    );
    assert.equal(
      code(
        await agent(
          "roles",
          {
            id: "helper",
            name: "Helper",
            capabilities: ["conversations.read"],
          },
          "agent-1-a",
        ),
      ),
      "OWN_ROLE",
    );
    const asHelper = (await agent("roles", undefined, "agent-1-a")).body.roles;
    assert.deepEqual(
      asHelper.map((r: any) => [r.id, r.editable]),
      [
        ["owner", false],
        ["admin", false],
        ["agent", false],
        ["helper", false],
      ],
    );

    // Role rules: every role sees conversations; names are unique; owner is fixed.
    assert.equal(
      code(
        await agent("roles", { name: "Blind", capabilities: ["macros.use"] }),
      ),
      "INVALID_ROLE",
    );
    assert.equal(
      code(
        await agent("roles", {
          name: "Odd",
          capabilities: ["conversations.read", "fly"],
        }),
      ),
      "INVALID_ROLE",
    );
    assert.equal(
      code(
        await agent("roles", {
          name: "HELPER",
          capabilities: ["conversations.read"],
        }),
      ),
      "ROLE_EXISTS",
    );
    assert.equal(
      code(
        await agent("roles", {
          id: "owner",
          capabilities: ["conversations.read"],
        }),
      ),
      "ROLE_FIXED",
    );

    // Editing a role changes what its holders may do at once.
    const agentCaps = (await agent("roles")).body.roles.find(
      (r: any) => r.id === "agent",
    ).capabilities as string[];
    assert.equal(
      (
        await agent("roles", {
          id: "agent",
          name: "ignored for built-in roles",
          capabilities: agentCaps.filter((c) => c !== "macros.use"),
        })
      ).status,
      200,
    );
    assert.equal(
      (await sql("a", "SELECT name FROM roles WHERE id='agent'"))[0].name,
      "agent",
    );
    await sql(
      "a",
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-2','agent-2-a','Agent two','agent')",
    );
    assert.equal((await agent("macros", undefined, "agent-2-a")).status, 403);

    // Deleting: never a built-in role, never one someone holds.
    assert.equal(
      code(await agent("roles", { id: "agent", action: "delete" })),
      "ROLE_FIXED",
    );
    assert.equal(
      code(await agent("roles", { id: "helper", action: "delete" })),
      "ROLE_IN_USE",
    );
    assert.equal((await move("agent-1", "agent")).status, 200);
    assert.equal(
      (await agent("roles", { id: "helper", action: "delete" })).status,
      200,
    );
    assert.equal(
      (
        await sql("a", "SELECT count(*)::int AS n FROM roles WHERE id='helper'")
      )[0].n,
      0,
    );

    // With a second owner, the first can be moved.
    assert.equal((await move("admin-1", "owner")).status, 200);
    assert.equal((await move("owner", "admin", "admin-1-a")).status, 200);
    assert.equal(await role("owner"), "admin");

    // Kept to the workspace: B lists only its own, and A's roles don't exist there.
    assert.deepEqual(
      (await agent("teammates", undefined, "owner-b", "b")).body.teammates.map(
        (t: any) => t.role,
      ),
      ["admin", "agent", "owner"],
    );
    await agent(
      "roles",
      {
        name: "A only",
        capabilities: ["conversations.read"],
      },
      "admin-1-a",
    );
    assert.equal(
      code(
        await agent(
          "teammates",
          { teammateId: "agent-1", roleId: "a_only" },
          "owner-b",
          "b",
        ),
      ),
      "ROLE_NOT_FOUND",
    );
    assert.equal(
      (await agent("teammates", undefined, "owner-a", "b")).status,
      403,
    );
    // Without Settings, closed.
    await sql(
      "b",
      "UPDATE workspace_features SET enabled=false WHERE workspace_id='b' AND name='settings_v1'",
    );
    assert.equal(
      code(await agent("roles", undefined, "owner-b", "b")),
      "SETTINGS_DISABLED",
    );
  } finally {
    await db.close();
  }
});
