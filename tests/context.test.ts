import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import {
  createAppHost,
  AppRequestRefused,
  APP_SLOT_VERSION,
  type AppRequest,
} from "../lib/app-slots";

test("context sidebar: customer through merges, personal data by permission, same-customer recent conversations, typed attributes", async () => {
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
  ) => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
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
  const context = (id: string, principal = "owner-a", workspace = "a") =>
    agent(
      "context?" + new URLSearchParams({ conversation: id }),
      undefined,
      principal,
      workspace,
    );
  const customerSession = async (device: string) => {
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
          deviceToken: device.repeat(4),
          pageUrl: "https://shop.test",
        }),
      }),
      env,
    ).then((r) => r.json())) as any;
    const start = async (text: string) =>
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
            body: JSON.stringify({ action: "start", text }),
          }),
          env,
        ).then((r) => r.json())) as any
      ).conversationId as string;
    return { start };
  };
  const contactOf = async (conversationId: string) =>
    (
      await sql<{ contact_id: string }>(
        "SELECT m.contact_id FROM conversations c JOIN identity_contact_mappings m ON m.workspace_id=c.workspace_id AND m.identity_id=c.primary_identity_id WHERE c.id=$1",
        [conversationId],
      )
    )[0].contact_id;
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
      "INSERT INTO roles(workspace_id,id,name) VALUES('a','limited','limited')",
    );
    await sql(
      "INSERT INTO role_capabilities(workspace_id,role_id,capability) SELECT 'a','limited',c FROM unnest(ARRAY['conversations.read','conversations.reply']) c",
    );
    await sql(
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','lin','lin-a','Lin','limited')",
    );

    // Jo: three conversations; Sam: one conversation, later merged into Jo.
    const jo = await customerSession("jo-device-");
    const first = await jo.start("First question"),
      second = await jo.start("Second question"),
      current = await jo.start("Current question");
    const joContact = await contactOf(current);
    await sql(
      "UPDATE contacts SET name='Jo Bloggs',role='lead',external_id='cus_42',origin_timezone='Europe/London' WHERE id=$1",
      [joContact],
    );
    await sql(
      "INSERT INTO contact_emails(workspace_id,contact_id,email,verified) VALUES('a',$1,'jo@example.test',true)",
      [joContact],
    );
    const sam = await customerSession("sam-device-");
    const samConversation = await sam.start("From Sam");
    const samContact = await contactOf(samConversation);
    await sql(
      "INSERT INTO contact_emails(workspace_id,contact_id,email,verified) VALUES('a',$1,'sam@old.test',false)",
      [samContact],
    );
    await sql("UPDATE contacts SET merged_into_contact_id=$2 WHERE id=$1", [
      samContact,
      joContact,
    ]);
    const stranger = await (
      await customerSession("other-device-")
    ).start("Someone else");

    const full = await context(current);
    assert.equal(full.status, 200, JSON.stringify(full.body));
    assert.equal(full.body.personalData, true);
    assert.equal(full.body.customer.id, joContact);
    assert.equal(full.body.customer.name, "Jo Bloggs");
    assert.equal(full.body.customer.role, "lead");
    assert.equal(full.body.customer.externalId, "cus_42");
    assert.equal(full.body.customer.timezone, "Europe/London");
    // Emails from the whole merged family, verified first.
    assert.deepEqual(
      full.body.customer.emails.map((e: any) => [e.value, e.verified]),
      [
        ["jo@example.test", true],
        ["sam@old.test", false],
      ],
    );
    // Recent: the same customer's other conversations (including the merged contact's), not
    // the open one or anyone else's.
    assert.deepEqual(
      full.body.recent.map((r: any) => r.id).sort(),
      [first, second, samConversation].sort(),
    );
    assert(
      !full.body.recent.some((r: any) => r.id === stranger || r.id === current),
    );
    // Sam's conversation resolves to Jo, the surviving contact.
    assert.equal((await context(samConversation)).body.customer.id, joContact);
    assert.deepEqual(full.body.apps, [], "no app cards until phase 15");

    // Without personal-data access: no names, emails, phones or external ids.
    const limited = (await context(current, "lin-a")).body;
    assert.equal(limited.personalData, false);
    assert.equal(limited.customer.role, "lead");
    assert.equal(limited.customer.timezone, "Europe/London");
    for (const field of ["name", "emails", "phones", "externalId"])
      assert(!(field in limited.customer), field);
    assert(!JSON.stringify(limited).includes("jo@example.test"));
    assert.equal(limited.canEditAttributes, false);

    // Attributes: active definitions with current values; archived ones hidden; edits typed.
    await sql(
      `INSERT INTO attribute_definitions(workspace_id,id,name,owner_type,value_type,options,archived_at) VALUES
      ('a','order','Order number','conversation','string',NULL,NULL),
      ('a','items','Items','conversation','integer',NULL,NULL),
      ('a','plan','Plan','conversation','options','["Free","Pro"]',NULL),
      ('a','old','Old field','conversation','string',NULL,now()),
      ('a','company_size','Company size','company','integer',NULL,NULL)`,
    );
    assert.equal(
      (
        await agent("command", {
          action: "attribute_set",
          conversationId: current,
          attributeId: "order",
          value: "A-100",
        })
      ).status,
      200,
    );
    const bad = await agent("command", {
      action: "attribute_set",
      conversationId: current,
      attributeId: "items",
      value: "abc",
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "ATTRIBUTE_TYPE");
    const attributes = (await context(current)).body.attributes;
    assert.deepEqual(
      attributes.map((a: any) => [a.id, a.valueType, a.value]),
      [
        ["items", "integer", null],
        ["order", "string", "A-100"],
        ["plan", "options", null],
      ],
    );
    assert.deepEqual(attributes.find((a: any) => a.id === "plan").options, [
      "Free",
      "Pro",
    ]);
    assert.equal(
      (
        await agent(
          "command",
          {
            action: "attribute_set",
            conversationId: current,
            attributeId: "order",
            value: "x",
          },
          "lin-a",
        )
      ).status,
      403,
      "editing needs conversations.manage",
    );

    // Other workspaces cannot read it.
    assert.equal((await context(current, "owner-b", "b")).status, 404);
  } finally {
    await db.close();
  }
});

test("app slot host: scoped context, declared capabilities only, own conversation only", async () => {
  const performed: AppRequest[] = [];
  const host = createAppHost(
    {
      appId: "orders-app",
      capabilities: ["conversation.read", "conversation.note"],
    },
    {
      version: APP_SLOT_VERSION,
      slot: "conversation.sidebar",
      workspaceId: "a",
      conversationId: "c1",
      contactId: "k1",
    },
    async (request) => {
      performed.push(request);
      return { ok: true };
    },
  );
  assert(Object.isFrozen(host.context));
  assert.deepEqual(
    await host.request({ type: "conversation.read", conversationId: "c1" }),
    { ok: true },
  );
  await host.request({
    type: "conversation.note",
    conversationId: "c1",
    text: "Order shipped",
  });
  await assert.rejects(
    host.request({
      type: "conversation.attributes.write",
      conversationId: "c1",
      attributeId: "order",
      value: "x",
    }),
    (e: unknown) =>
      e instanceof AppRequestRefused && e.code === "CAPABILITY_NOT_DECLARED",
  );
  await assert.rejects(
    host.request({ type: "conversation.read", conversationId: "c2" }),
    (e: unknown) =>
      e instanceof AppRequestRefused && e.code === "OUT_OF_CONTEXT",
  );
  assert.throws(
    () =>
      createAppHost(
        { appId: "x", capabilities: [] },
        {
          version: 2 as never,
          slot: "conversation.sidebar",
          workspaceId: "a",
          conversationId: "c1",
        },
        async () => null,
      ),
    (e: unknown) =>
      e instanceof AppRequestRefused && e.code === "UNSUPPORTED_VERSION",
  );
  assert.equal(performed.length, 2, "refused requests never reach the host");
});
