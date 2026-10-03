import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";

/** Settings › Helpdesk data (S2b; docs/SETTINGS_STEP3.md): tags, attributes and ticket types. */
test("helpdesk data settings: tags archive instead of delete, attribute types are fixed and options only grow, ticket types save once, and all of it stays in its workspace", async () => {
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
        "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES($1,'agent-1','agent-1-'||$1,'Agent one','agent')",
        [w],
      );
      await sql(
        w,
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name='settings_v1'",
        [w],
      );
    }
    // A lead who manages tickets but not the workspace.
    await sql(
      "a",
      "INSERT INTO roles(workspace_id,id,name) VALUES('a','lead','lead')",
    );
    await sql(
      "a",
      "INSERT INTO role_capabilities(workspace_id,role_id,capability) VALUES('a','lead','conversations.read'),('a','lead','tickets.manage')",
    );
    await sql(
      "a",
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','lead-1','lead-1-a','Lead one','lead')",
    );

    // Pages: tags and attributes need workspace management; ticket types need tickets.
    const pages = async (principal = "owner-a") =>
      (
        (await agent("settings?section=overview", undefined, principal)).body
          .pages as string[]
      ).filter((p) => ["tags", "attributes", "ticket-types"].includes(p));
    assert.deepEqual(await pages(), ["tags", "attributes"]);
    assert.deepEqual(await pages("agent-1-a"), []);
    await sql(
      "a",
      "UPDATE workspace_features SET enabled=true WHERE workspace_id='a' AND name='tickets_v1'",
    );
    assert.deepEqual(await pages(), ["tags", "attributes", "ticket-types"]);
    assert.deepEqual(await pages("lead-1-a"), ["ticket-types"]);
    assert.equal((await agent("tags", undefined, "agent-1-a")).status, 403);
    assert.equal(
      (await agent("attributes", undefined, "lead-1-a")).status,
      403,
    );

    // Tags: created once for a retried key; names are unique whatever their case.
    const key = crypto.randomUUID();
    const first = await agent(
      "tags",
      { name: " Billing  question " },
      "owner-a",
      "a",
      key,
    );
    assert.equal(first.status, 200);
    assert.deepEqual(
      (
        await agent(
          "tags",
          { name: " Billing  question " },
          "owner-a",
          "a",
          key,
        )
      ).body,
      first.body,
    );
    const tagId = first.body.id;
    assert.equal(tagId, "billing_question");
    assert.equal(
      code(await agent("tags", { name: "BILLING QUESTION" })),
      "TAG_EXISTS",
    );
    assert.equal(
      code(await agent("tags", { name: "  " })),
      "INVALID_WORKSPACE_DATA",
    );
    assert.equal(
      (await agent("tags", { id: tagId, name: "Billing" })).status,
      200,
    );
    assert.equal((await agent("tags", { name: "x" }, "agent-1-a")).status, 403);

    // A tagged conversation, then the tag archived.
    const conversationId = await tenant(db.connect, "a", async (q) => {
      const identity = await getIdentity(q, "a", "anonymous", "data-1");
      return (
        (await command(
          q,
          "a",
          {
            type: "contact",
            identityId: identity.identityId,
            brandId: "default",
          },
          "data-start",
          { action: "start", text: "Where is my invoice?" },
        )) as { conversationId: string }
      ).conversationId;
    });
    const tag = (action: string) =>
      agent("command", { action, conversationId, tagId });
    assert.equal((await tag("tag_add")).status, 200);
    assert.equal(
      (await agent("tags", { id: tagId, action: "archive" })).status,
      200,
    );
    const listed = (await agent("tags")).body.tags;
    assert.deepEqual(listed, [
      { id: tagId, name: "Billing", archived: true, conversations: 1 },
    ]);
    // It stays on the conversation; it can be removed but not added again.
    assert.equal(
      (await sql("a", "SELECT count(*)::int AS n FROM conversation_tags"))[0].n,
      1,
    );
    assert.equal((await tag("tag_remove")).status, 200);
    const refused = await tag("tag_add");
    assert.equal(refused.status, 409);
    assert.equal(code(refused), "TAG_ARCHIVED");
    // The inbox keeps its name for history, marked archived.
    assert.deepEqual((await agent("inbox")).body.tags, [
      { id: tagId, name: "Billing", archived: true },
    ]);
    // A macro can't add an archived tag, though it can still remove one.
    assert.equal(
      code(
        await agent("macros", {
          action: "save",
          name: "Tag billing",
          mode: "reply",
          shared: false,
          actions: [{ type: "tag_add", tagId }],
        }),
      ),
      "MACRO_TARGET_MISSING",
    );
    assert.equal(
      (
        await agent("macros", {
          action: "save",
          name: "Untag billing",
          mode: "reply",
          shared: false,
          actions: [{ type: "tag_remove", tagId }],
        })
      ).status,
      200,
    );
    // Tags are never deleted, even by hand.
    await assert.rejects(sql("a", "DELETE FROM tags WHERE id=$1", [tagId]));
    // Restored, it can be added again.
    assert.equal(
      (await agent("tags", { id: tagId, action: "restore" })).status,
      200,
    );
    assert.equal((await tag("tag_add")).status, 200);

    // Attributes: a list with options, created once for a retried key.
    const attrKey = crypto.randomUUID();
    const plan = {
      name: "Plan tier",
      valueType: "options",
      options: ["Free", "Pro"],
    };
    const created = await agent("attributes", plan, "owner-a", "a", attrKey);
    assert.equal(created.status, 200);
    assert.deepEqual(
      (await agent("attributes", plan, "owner-a", "a", attrKey)).body,
      created.body,
    );
    const attrId = created.body.id;
    assert.equal(
      (
        await sql("a", "SELECT count(*)::int AS n FROM attribute_definitions")
      )[0].n,
      1,
    );
    assert.equal(
      code(await agent("attributes", { name: "Plan", valueType: "colour" })),
      "INVALID_WORKSPACE_DATA",
    );
    assert.equal(
      code(
        await agent("attributes", {
          name: "Plan",
          valueType: "options",
          options: ["A", "a"],
        }),
      ),
      "INVALID_WORKSPACE_DATA",
    );
    assert.equal(
      code(
        await agent("attributes", { name: "plan tier", valueType: "string" }),
      ),
      "ATTRIBUTE_EXISTS",
    );
    // Options are added; existing ones keep their order and can't be removed or renamed.
    assert.equal(
      (
        await agent("attributes", {
          id: attrId,
          name: "Plan",
          options: ["Enterprise", "Free", "Pro"],
        })
      ).status,
      200,
    );
    const removed = await agent("attributes", {
      id: attrId,
      name: "Plan",
      options: ["Free", "Business"],
    });
    assert.equal(removed.status, 409);
    assert.equal(code(removed), "ATTRIBUTE_OPTION_REMOVED");
    // The type is fixed.
    assert.equal(
      code(
        await agent("attributes", {
          id: attrId,
          name: "Plan",
          valueType: "string",
        }),
      ),
      "INVALID_WORKSPACE_DATA",
    );
    const set = (value: unknown) =>
      agent("command", {
        action: "attribute_set",
        conversationId,
        attributeId: attrId,
        value,
      });
    assert.equal((await set(["Enterprise"])).status, 200);
    assert.equal((await set(["Gold"])).status, 400);

    // Ticket types: saved once for a retried key; the attribute list names its fields.
    const typeKey = crypto.randomUUID();
    const bug = {
      name: "Plan change",
      category: "back_office",
      states: [
        { key: "new", name: "New", kind: "submitted" },
        { key: "done", name: "Done", kind: "resolved" },
      ],
      transitions: [["new", "done"]],
      fields: [{ attributeId: attrId, requiredToClose: true }],
    };
    const savedType = await agent(
      "ticket-types",
      bug,
      "lead-1-a",
      "a",
      typeKey,
    );
    assert.equal(savedType.status, 200);
    assert.deepEqual(
      (await agent("ticket-types", bug, "lead-1-a", "a", typeKey)).body,
      savedType.body,
    );
    assert.equal(
      (await sql("a", "SELECT count(*)::int AS n FROM ticket_types"))[0].n,
      1,
    );
    assert.deepEqual(
      (await agent("attributes")).body.attributes.map((a: any) => [
        a.name,
        a.options,
        a.ticketTypes,
      ]),
      [["Plan", ["Free", "Pro", "Enterprise"], ["Plan change"]]],
    );
    // A stale edit is refused rather than overwriting.
    const stale = await agent(
      "ticket-types",
      { ...bug, id: savedType.body.id, version: "0" },
      "lead-1-a",
    );
    assert.equal(stale.status, 409);
    assert.equal(code(stale), "TICKET_TYPE_CONFLICT");

    // Archived, an attribute can't be filled in, and leaves the type's fields.
    assert.equal(
      (await agent("attributes", { id: attrId, action: "archive" })).status,
      200,
    );
    assert.equal((await set(["Free"])).status, 404);
    assert.deepEqual(
      (await agent("ticket-types", undefined, "lead-1-a")).body.types[0].fields,
      [],
    );
    await assert.rejects(
      sql("a", "DELETE FROM attribute_definitions WHERE id=$1", [attrId]),
    );

    // Kept to the workspace: B sees none of A's tags or attributes and can't change them.
    assert.deepEqual(
      (await agent("tags", undefined, "owner-b", "b")).body.tags,
      [],
    );
    assert.deepEqual(
      (await agent("attributes", undefined, "owner-b", "b")).body.attributes,
      [],
    );
    assert.equal(
      code(
        await agent("tags", { id: tagId, action: "archive" }, "owner-b", "b"),
      ),
      "TAG_NOT_FOUND",
    );
    assert.equal(
      code(
        await agent("attributes", { id: attrId, name: "Mine" }, "owner-b", "b"),
      ),
      "ATTRIBUTE_NOT_FOUND",
    );
    assert.equal((await agent("tags", undefined, "owner-a", "b")).status, 403);
    // Without Settings, the endpoints are closed.
    await sql(
      "b",
      "UPDATE workspace_features SET enabled=false WHERE workspace_id='b' AND name='settings_v1'",
    );
    assert.equal(
      code(await agent("tags", undefined, "owner-b", "b")),
      "SETTINGS_DISABLED",
    );
  } finally {
    await db.close();
  }
});
