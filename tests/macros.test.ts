import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";

const text = (t: string) => ({ type: "text", text: t });
const variable = (name: string, fallback = "") => ({
  type: "variable",
  attrs: { name, fallback },
});
const doc = (...content: unknown[]) => ({
  type: "doc",
  content: [{ type: "paragraph", content }],
});
const flatten = (d: any): string =>
  d.content
    .flatMap((b: any) => b.content ?? [])
    .map((n: any) => n.text ?? "")
    .join("");

test("macros: permissions per operation, variables filled as text, whole-bundle validation, atomic idempotent apply", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
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
      (r) => handleApi(r, env),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const sql = async <T = any>(query: string, values: unknown[] = []) =>
    tenant(
      db.connect,
      "a",
      async (q) => (await q.query<T>(query, values)).rows,
    );
  const save = (data: Record<string, unknown>, principal = "owner-a") =>
    agent("macros", { action: "save", ...data }, principal);
  const apply = (
    macroId: string,
    conversationId: string,
    principal = "owner-a",
    key?: string,
    workspace = "a",
  ) =>
    agent(
      "macros",
      { action: "apply", macroId, conversationId, timezone: "Europe/London" },
      principal,
      workspace,
      key,
    );
  try {
    for (const w of ["a", "b"])
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, {
          origins: ["https://shop.test"],
          master: env.identityMaster,
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        }),
      );
    await sql(
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','ada','ada-a','Ada','agent'),('a','grace','grace-a','Grace','agent'),('a','temp','temp-a','Temp','agent')",
    );
    // A role that may use macros and manage conversations but not see personal data.
    await sql(
      "INSERT INTO roles(workspace_id,id,name) VALUES('a','limited','limited')",
    );
    await sql(
      "INSERT INTO role_capabilities(workspace_id,role_id,capability) SELECT 'a','limited',c FROM unnest(ARRAY['conversations.read','conversations.reply','conversations.manage','macros.use']) c",
    );
    await sql(
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','lin','lin-a','Lin','limited')",
    );
    await sql(
      "INSERT INTO teams(workspace_id,id,name) VALUES('a','billing','Billing')",
    );
    await sql(
      "INSERT INTO tags(workspace_id,id,name) VALUES('a','refund','Refund'),('a','vip','VIP')",
    );
    const boot = (await handleApi(
      new Request("https://relay.test/v1/messenger/boot", {
        method: "POST",
        headers: {
          origin: "https://shop.test",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          workspaceId: "a",
          brandId: "default",
          deviceToken: "macros-device-token-".repeat(3),
          pageUrl: "https://shop.test",
        }),
      }),
      env,
    ).then((r) => r.json())) as any;
    const start = async (t: string) =>
      (
        (await handleApi(
          new Request("https://relay.test/v1/messenger/command", {
            method: "POST",
            headers: {
              origin: "https://shop.test",
              authorization: "Bearer " + boot.token,
              "content-type": "application/json",
              "idempotency-key": crypto.randomUUID(),
            },
            body: JSON.stringify({ action: "start", text: t }),
          }),
          env,
        ).then((r) => r.json())) as any
      ).conversationId as string;
    const id = await start("Refund for order 42");
    await sql(
      "UPDATE conversations SET name='Jo Bloggs',email='jo@example.test' WHERE id=$1",
      [id],
    );

    // Saving: variables and actions are validated whole.
    const body = doc(
      text("Hi "),
      variable("contact.first_name", "there"),
      text(", your refund is approved. — "),
      variable("teammate.name"),
      text(", "),
      variable("brand.name"),
    );
    const actions = [
      { type: "tag_add", tagId: "refund" },
      { type: "assign", teamId: "billing" },
      { type: "close" },
    ];
    for (const [data, code] of [
      [
        { body: doc(variable("company.name")), actions: [] },
        "INVALID_DOCUMENT",
      ],
      [
        { body, actions: [{ type: "ticket_state", state: "resolved" }] },
        "TICKETS_UNAVAILABLE",
      ],
      [
        { body, actions: [{ type: "close" }, { type: "reopen" }] },
        "INVALID_MACRO",
      ],
      [
        { body, actions: [{ type: "tag_add", tagId: "missing" }] },
        "MACRO_TARGET_MISSING",
      ],
      [{ body, actions: [{ type: "launch_rocket" }] }, "INVALID_MACRO"],
      [{ body: null, actions: [] }, "INVALID_MACRO"],
    ] as const) {
      const r = await save({
        name: "Bad",
        mode: "reply",
        shared: true,
        ...data,
      });
      assert.equal(r.body.error?.code, code, JSON.stringify(data));
    }

    // Permissions: agents keep personal macros; shared ones need create/edit/delete.
    assert.equal(
      (
        await save(
          { name: "Team macro", mode: "reply", shared: true, body },
          "ada-a",
        )
      ).status,
      403,
    );
    const shared = await save({
      name: "Refund approved",
      mode: "reply",
      shared: true,
      body,
      actions,
    });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    const personal = await save(
      {
        name: "Ask for order number",
        mode: "reply",
        body: doc(text("Could you share your order number?")),
      },
      "ada-a",
    );
    assert.equal(personal.status, 200);
    const names = async (principal: string) =>
      (await agent("macros", undefined, principal)).body.macros.map(
        (m: any) => m.name,
      );
    assert.deepEqual(await names("ada-a"), [
      "Ask for order number",
      "Refund approved",
    ]);
    assert.deepEqual(
      await names("grace-a"),
      ["Refund approved"],
      "personal macros are private",
    );
    assert.equal((await apply(personal.body.id, id, "grace-a")).status, 404);
    assert.equal(
      (
        await save(
          { id: personal.body.id, version: "1", name: "Mine now" },
          "grace-a",
        )
      ).status,
      404,
    );
    const adaList = (await agent("macros", undefined, "ada-a")).body;
    assert.equal(adaList.canCreateShared, false);
    assert.equal(adaList.macros.find((m: any) => m.shared).canEdit, false);
    assert.equal(
      (
        await save(
          { id: shared.body.id, version: "1", name: "Renamed" },
          "ada-a",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await agent(
          "macros",
          { action: "archive", id: shared.body.id, version: "1" },
          "ada-a",
        )
      ).status,
      403,
    );
    assert.equal(
      (await save({ id: shared.body.id, version: "1", shared: false })).body
        .error.code,
      "MACRO_SHARING",
    );
    // Version check: a stale edit conflicts.
    assert.equal(
      (
        await save({
          id: shared.body.id,
          version: "1",
          name: "Refund approved ✓",
        })
      ).body.version,
      "2",
    );
    assert.equal(
      (await save({ id: shared.body.id, version: "1", name: "Stale" })).body
        .error.code,
      "MACRO_CONFLICT",
    );
    assert.equal(
      (await agent("macros", undefined, "owner-b", "b")).body.macros.length,
      0,
    );
    assert.equal(
      (await apply(shared.body.id, id, "owner-b", undefined, "b")).status,
      404,
    );

    // Applying: every action in one go, variables filled, then retries are no-ops.
    // Agents cannot assign conversations, so this macro is refused for Ada, and nothing changes.
    const forbidden = await apply(shared.body.id, id, "ada-a");
    assert.equal(forbidden.status, 403);
    assert.match(forbidden.body.error.message, /one of this macro's actions/);
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversation_tags WHERE conversation_id=$1",
          [id],
        )
      )[0].n,
      0,
      "the tag added before the refused assignment was rolled back",
    );
    const key = crypto.randomUUID();
    const applied = await apply(shared.body.id, id, "owner-a", key);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.mode, "reply");
    assert.equal(applied.body.applied, 3);
    assert.equal(
      flatten(applied.body.doc),
      "Hi Jo, your refund is approved. — Support teammate, Relay",
    );
    const [after] = await sql(
      "SELECT status,team_id FROM conversations WHERE id=$1",
      [id],
    );
    assert.deepEqual(after, { status: "closed", team_id: "billing" });
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversation_tags WHERE conversation_id=$1",
          [id],
        )
      )[0].n,
      1,
    );
    const partsBefore = (
      await sql(
        "SELECT count(*)::int AS n FROM conversation_parts WHERE conversation_id=$1",
        [id],
      )
    )[0].n;
    await apply(shared.body.id, id, "owner-a", key);
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversation_parts WHERE conversation_id=$1",
          [id],
        )
      )[0].n,
      partsBefore,
      "a retried apply changes nothing",
    );

    // Values are text: formatting characters in a name stay literal.
    const second = await start("Second");
    await sql("UPDATE conversations SET name=$2 WHERE id=$1", [
      second,
      "**Bold** <b>x</b> [link](https://evil.test)",
    ]);
    const literal = (await apply(shared.body.id, second, "owner-a")).body.doc;
    assert.equal(
      literal.content[0].content.filter(
        (n: any) => n.marks || n.type !== "text",
      ).length,
      0,
    );
    assert.match(flatten(literal), /^Hi \*\*Bold\*\*,/);
    // Without personal-data access, contact variables use their fallback.
    const third = await start("Third");
    await sql("UPDATE conversations SET name='Jo Bloggs' WHERE id=$1", [third]);
    const greeting = await save({
      name: "Greeting",
      mode: "reply",
      shared: true,
      body: doc(
        text("Hi "),
        variable("contact.first_name", "there"),
        text("!"),
      ),
    });
    assert.equal(
      flatten((await apply(greeting.body.id, third, "lin-a")).body.doc),
      "Hi there!",
    );
    assert.equal(
      flatten((await apply(greeting.body.id, third, "ada-a")).body.doc),
      "Hi Jo!",
    );

    // Atomicity: a target removed after saving, or a later action failing, changes nothing.
    const risky = await save({
      name: "Tag and hand to Temp",
      mode: "note",
      shared: true,
      body: null,
      actions: [
        { type: "tag_add", tagId: "vip" },
        { type: "assign", teammateId: "temp" },
      ],
    });
    // Remove the teammate the macro assigns to (and their per-teammate counters).
    await sql("DELETE FROM inbox_counters WHERE teammate_id='temp'");
    await sql("DELETE FROM conversation_unread WHERE teammate_id='temp'");
    await sql("DELETE FROM teammates WHERE id='temp'");
    const fourth = await start("Fourth");
    const refused = await apply(risky.body.id, fourth, "ada-a");
    assert.equal(refused.body.error.code, "MACRO_TARGET_MISSING");
    const failing = await save({
      name: "Tag then snooze",
      mode: "note",
      shared: true,
      actions: [
        { type: "tag_add", tagId: "vip" },
        { type: "snooze", preset: "tomorrow" },
      ],
    });
    // No timezone: the snooze (second action) fails after the tag (first) has run in the transaction.
    const midway = await agent(
      "macros",
      { action: "apply", macroId: failing.body.id, conversationId: fourth },
      "ada-a",
    );
    assert.equal(midway.body.error.code, "TIMEZONE_INVALID");
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversation_tags WHERE conversation_id=$1",
          [fourth],
        )
      )[0].n,
      0,
    );
    assert.equal(
      (await sql("SELECT status FROM conversations WHERE id=$1", [fourth]))[0]
        .status,
      "open",
    );

    // Archiving: shared needs macros.delete; archived macros disappear.
    const current = (await agent("macros")).body.macros.find(
      (m: any) => m.id === shared.body.id,
    );
    assert.equal(
      (
        await agent("macros", {
          action: "archive",
          id: shared.body.id,
          version: current.version,
        })
      ).status,
      200,
    );
    assert(!(await names("ada-a")).includes("Refund approved ✓"));
  } finally {
    await db.close();
  }
});
