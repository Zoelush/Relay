import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { runJob } from "../server/jobs";
import { runBulkApply, runBulkUndo } from "../server/bulk";

const bug = {
  name: "Bug report",
  icon: "bug",
  category: "customer",
  states: [
    { key: "new", name: "New", customerLabel: "Received", kind: "submitted" },
    {
      key: "investigating",
      name: "Investigating",
      customerLabel: "In progress",
      kind: "in_progress",
    },
    {
      key: "waiting",
      name: "Waiting on customer",
      customerLabel: "Waiting for you",
      kind: "waiting_on_customer",
    },
    {
      key: "fixed",
      name: "Fixed",
      customerLabel: "Resolved",
      kind: "resolved",
    },
  ],
  transitions: [
    ["new", "investigating"],
    ["investigating", "waiting"],
    ["waiting", "investigating"],
    ["investigating", "fixed"],
    ["fixed", "investigating"],
  ],
  fields: [
    { attributeId: "order", requiredToClose: true },
    { attributeId: "severity", requiredToClose: false },
    { attributeId: "notes", requiredToClose: false },
  ],
};
const refund = {
  name: "Refund request",
  icon: "coins",
  category: "customer",
  states: [
    { key: "open", name: "Open", kind: "submitted" },
    { key: "done", name: "Refunded", kind: "resolved" },
  ],
  transitions: [["open", "done"]],
  fields: [
    { attributeId: "order", requiredToClose: true },
    { attributeId: "reason", requiredToClose: false },
  ],
};

test("tickets: types validated whole, conversion, transitions, required-to-close, type change with preview, macros and bulk", async () => {
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
  const sql = async <T = any>(query: string, values: unknown[] = [], w = "a") =>
    tenant(db.connect, w, async (q) => (await q.query<T>(query, values)).rows);
  const cmd = (
    data: Record<string, unknown>,
    principal = "owner-a",
    workspace = "a",
    key?: string,
  ) => agent("command", data, principal, workspace, key);
  const code = (r: { body: any }) => r.body.error?.code;
  const context = async (id: string) =>
    (await agent("context?" + new URLSearchParams({ conversation: id }))).body;
  const events = async (id: string) =>
    (
      await sql<{ data: any; audience: string }>(
        "SELECT data,audience FROM conversation_parts WHERE conversation_id=$1 AND kind='system_event' AND data->>'event' LIKE 'ticket_%' ORDER BY seq",
        [id],
      )
    ).map((r) => ({ ...r.data, audience: r.audience }));
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
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','ada','ada-a','Ada','agent')",
    );
    await sql(
      `INSERT INTO attribute_definitions(workspace_id,id,name,owner_type,value_type,options) VALUES
      ('a','order','Order number','conversation','string',NULL),
      ('a','severity','Severity','conversation','options','["Low","High"]'),
      ('a','notes','Repro notes','conversation','string',NULL),
      ('a','reason','Reason','conversation','string',NULL),
      ('a','plan','Plan','conversation','string',NULL)`,
    );
    const start = (w: string, n: number) =>
      tenant(db.connect, w, async (q) => {
        const identity = await getIdentity(
          q,
          w,
          "anonymous",
          "ticket-customer-" + w,
        );
        const ids: string[] = [];
        for (let i = 0; i < n; i++)
          ids.push(
            (
              (await command(
                q,
                w,
                {
                  type: "contact",
                  identityId: identity.identityId,
                  brandId: "default",
                },
                `ticket-${w}-${i}`,
                { action: "start", text: `Question ${i}` },
              )) as { conversationId: string }
            ).conversationId,
          );
        return ids;
      });
    const [c1, c2, c3, c4] = await start("a", 4);
    const [foreign] = await start("b", 1);

    // Off by default.
    assert.equal(code(await agent("ticket-types")), "TICKETS_DISABLED");
    await sql(
      "UPDATE workspace_features SET enabled=true WHERE name='tickets_v1'",
    );
    await sql(
      "UPDATE workspace_features SET enabled=true WHERE name='tickets_v1'",
      [],
      "b",
    );

    // Types are validated whole; only tickets.manage may define them.
    assert.equal((await agent("ticket-types", bug, "ada-a")).status, 403);
    for (const [broken, message] of [
      [
        { ...bug, states: bug.states.filter((s) => s.kind !== "resolved") },
        /resolved/,
      ],
      [
        { ...bug, transitions: [["new", "investigating"]] },
        /no path to a resolved state/,
      ],
      [
        { ...bug, transitions: [...bug.transitions, ["new", "missing"]] },
        /Transitions/,
      ],
      [{ ...bug, fields: [{ attributeId: "nope" }] }, /unavailable/],
      [{ ...bug, category: "other" }, /customer, back-office or tracker/],
    ] as const) {
      const r = await agent("ticket-types", broken);
      assert.equal(code(r), "INVALID_TICKET_TYPE", JSON.stringify(r.body));
      assert.match(r.body.error.message, message);
    }
    assert.equal(
      (await sql("SELECT count(*)::int AS n FROM ticket_types"))[0].n,
      0,
      "nothing stored",
    );
    const saved = await agent("ticket-types", bug);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.id, "bug-report");
    await agent("ticket-types", refund);
    await agent("ticket-types", {
      ...refund,
      name: "Outage",
      category: "tracker",
      fields: [],
    });
    const list = (await agent("ticket-types", undefined, "ada-a")).body;
    assert.deepEqual(
      list.types.map((t: any) => t.id),
      ["bug-report", "outage", "refund-request"],
    );
    assert.equal(list.canManage, false);
    const type = list.types[0];
    assert.deepEqual(
      type.states.map((s: any) => s.id),
      [
        "bug-report.new",
        "bug-report.investigating",
        "bug-report.waiting",
        "bug-report.fixed",
      ],
    );
    assert.equal(
      code(
        await agent("ticket-types", {
          ...bug,
          id: "bug-report",
          version: "99",
        }),
      ),
      "TICKET_TYPE_CONFLICT",
    );
    assert.equal(
      code(
        await agent("ticket-types", {
          ...bug,
          id: "bug-report",
          version: type.version,
          category: "tracker",
        }),
      ),
      "INVALID_TICKET_TYPE",
    );
    // Other workspaces see none of it.
    assert.deepEqual(
      (await agent("ticket-types", undefined, "owner-b", "b")).body.types,
      [],
    );

    // Ticket fields cannot be set on a conversation that is not that kind of ticket.
    assert.equal(
      code(
        await cmd({
          action: "attribute_set",
          conversationId: c1,
          attributeId: "order",
          value: "A-1",
        }),
      ),
      "TICKET_FIELD",
    );

    // Converting: a customer type, an open starting state, a per-workspace number.
    assert.equal(
      code(
        await cmd({ action: "ticket", conversationId: c1, typeId: "outage" }),
      ),
      "TICKET_CATEGORY",
    );
    assert.equal(
      code(
        await cmd({
          action: "ticket",
          conversationId: c1,
          typeId: "bug-report",
          stateId: "bug-report.fixed",
        }),
      ),
      "TICKET_STATE",
    );
    const key = crypto.randomUUID();
    const converted = await cmd(
      {
        action: "ticket",
        conversationId: c1,
        typeId: "bug-report",
        stateId: "bug-report.new",
      },
      "ada-a",
      "a",
      key,
    );
    assert.equal(converted.status, 200, JSON.stringify(converted.body));
    // A retried request is the same conversion; a new one is refused.
    assert.equal(
      (
        await cmd(
          {
            action: "ticket",
            conversationId: c1,
            typeId: "bug-report",
            stateId: "bug-report.new",
          },
          "ada-a",
          "a",
          key,
        )
      ).status,
      200,
    );
    assert.equal(
      code(
        await cmd({
          action: "ticket",
          conversationId: c1,
          typeId: "bug-report",
        }),
      ),
      "TICKET_EXISTS",
    );
    await cmd({ action: "ticket", conversationId: c2, typeId: "bug-report" });
    assert.deepEqual(
      (
        await sql(
          "SELECT conversation_id,number::int AS n FROM tickets ORDER BY number",
        )
      ).map((r) => [r.conversation_id, r.n]),
      [
        [c1, 1],
        [c2, 2],
      ],
    );
    // Another workspace cannot act on it.
    assert.equal(
      (
        await cmd(
          {
            action: "ticket_state",
            conversationId: c1,
            stateId: "bug-report.investigating",
          },
          "owner-b",
          "b",
        )
      ).status,
      404,
    );
    assert.equal(
      code(
        await cmd(
          { action: "ticket", conversationId: foreign, typeId: "bug-report" },
          "owner-b",
          "b",
        ),
      ),
      "TICKET_TYPE_NOT_FOUND",
    );

    // The sidebar shows the ticket, its next states and its fields (not among general attributes).
    let ctx = await context(c1);
    assert.equal(ctx.tickets.enabled, true);
    assert.equal(ctx.tickets.ticket.number, 1);
    assert.equal(ctx.tickets.ticket.state.id, "bug-report.new");
    assert.deepEqual(
      ctx.tickets.ticket.nextStates.map((s: any) => s.id),
      ["bug-report.investigating"],
    );
    assert.deepEqual(
      ctx.tickets.ticket.fields.map((f: any) => [f.id, f.requiredToClose]),
      [
        ["order", true],
        ["severity", false],
        ["notes", false],
      ],
    );
    assert.deepEqual(
      ctx.attributes.map((a: any) => a.id),
      ["plan"],
    );

    // Only the type's transitions are allowed.
    const moveTo = (id: string, stateId: string) =>
      cmd({ action: "ticket_state", conversationId: id, stateId });
    assert.equal(
      code(await moveTo(c1, "bug-report.fixed")),
      "TICKET_TRANSITION",
    );
    assert.match(
      (await moveTo(c1, "bug-report.fixed")).body.error.message,
      /cannot move from New to Fixed/,
    );
    assert.equal((await moveTo(c1, "bug-report.investigating")).status, 200);
    // Resolving needs the required fields; so does closing the conversation.
    const blocked = await moveTo(c1, "bug-report.fixed");
    assert.equal(blocked.status, 409);
    assert.equal(code(blocked), "TICKET_FIELDS_REQUIRED");
    assert.equal(
      blocked.body.error.message,
      "Fill in Order number before closing this ticket.",
    );
    assert.deepEqual(blocked.body.error.details.fields, [
      { id: "order", name: "Order number" },
    ]);
    assert.equal(
      code(await cmd({ action: "close", conversationId: c1 })),
      "TICKET_FIELDS_REQUIRED",
    );
    await cmd({
      action: "attribute_set",
      conversationId: c1,
      attributeId: "order",
      value: "A-100",
    });
    await cmd({
      action: "attribute_set",
      conversationId: c1,
      attributeId: "severity",
      value: ["High"],
    });
    await cmd({
      action: "attribute_set",
      conversationId: c1,
      attributeId: "notes",
      value: "Crashes on save",
    });
    assert.equal((await moveTo(c1, "bug-report.fixed")).status, 200);
    assert.deepEqual(
      (await events(c1)).map((e) => [
        e.event,
        e.to?.id ?? e.state?.id,
        e.audience,
      ]),
      [
        ["ticket_created", "bug-report.new", "internal"],
        ["ticket_state_change", "bug-report.investigating", "internal"],
        ["ticket_state_change", "bug-report.fixed", "internal"],
      ],
    );
    // A state tickets are in cannot be removed from the type.
    const current = (await agent("ticket-types")).body.types.find(
      (t: any) => t.id === "bug-report",
    );
    assert.equal(
      code(
        await agent("ticket-types", {
          ...bug,
          id: "bug-report",
          version: current.version,
          states: bug.states
            .filter((s) => s.key !== "fixed")
            .concat({
              key: "done",
              name: "Done",
              customerLabel: "Done",
              kind: "resolved",
            }),
          transitions: [
            ["new", "investigating"],
            ["investigating", "waiting"],
            ["waiting", "investigating"],
            ["investigating", "done"],
          ],
        }),
      ),
      "TICKET_STATE_IN_USE",
    );

    // Changing type: preview shows kept, movable and lost fields; apply needs that exact preview.
    await moveTo(c1, "bug-report.investigating");
    const preview = (mapping = {}) =>
      agent(
        "ticket-preview?" +
          new URLSearchParams({
            conversation: c1,
            type: "refund-request",
            mapping: JSON.stringify(mapping),
          }),
      );
    let p = (await preview()).body;
    assert.deepEqual(
      p.kept.map((f: any) => f.id),
      ["order"],
    );
    assert.deepEqual(p.moved, []);
    assert.deepEqual(
      p.lost.map((f: any) => [f.id, f.value]),
      [
        ["severity", ["High"]],
        ["notes", "Crashes on save"],
      ],
    );
    assert.equal(
      code(await preview({ severity: "reason" })),
      "TICKET_MAPPING",
      "options cannot become text",
    );
    p = (await preview({ notes: "reason" })).body;
    assert.deepEqual(p.moved, [
      {
        from: { id: "notes", name: "Repro notes" },
        to: { id: "reason", name: "Reason" },
      },
    ]);
    assert.deepEqual(
      p.lost.map((f: any) => f.id),
      ["severity"],
    );
    assert.equal(p.state.id, "refund-request.open");
    // The ticket changes after the preview: the preview is stale.
    await moveTo(c1, "bug-report.waiting");
    assert.equal(
      code(
        await cmd({
          action: "ticket_type",
          conversationId: c1,
          typeId: "refund-request",
          mapping: { notes: "reason" },
          token: p.token,
        }),
      ),
      "TICKET_PREVIEW_STALE",
    );
    p = (await preview({ notes: "reason" })).body;
    const changed = await cmd({
      action: "ticket_type",
      conversationId: c1,
      typeId: "refund-request",
      mapping: { notes: "reason" },
      token: p.token,
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const [attributes] = await sql(
      "SELECT attributes FROM conversations WHERE id=$1",
      [c1],
    );
    assert.deepEqual(attributes.attributes, {
      order: "A-100",
      reason: "Crashes on save",
    });
    assert.deepEqual(
      (
        await sql(
          "SELECT attribute_id FROM conversation_attribute_values WHERE conversation_id=$1 ORDER BY attribute_id",
          [c1],
        )
      ).map((r) => r.attribute_id),
      ["order", "reason"],
    );
    const last = (await events(c1)).at(-1);
    assert.equal(last.event, "ticket_type_change");
    assert.deepEqual(last.lost, [
      { id: "severity", name: "Severity", value: ["High"] },
    ]);
    ctx = await context(c1);
    assert.equal(ctx.tickets.ticket.type.id, "refund-request");
    assert.equal(ctx.tickets.ticket.state.id, "refund-request.open");

    // Merging a ticket away is refused; merging into it is fine.
    assert.equal(
      code(await cmd({ action: "merge", conversationId: c1, targetId: c3 })),
      "TICKET_MERGE",
    );

    // Macros set ticket state; on a conversation that is not a ticket the whole macro is refused.
    const macro = await agent("macros", {
      action: "save",
      name: "Refunded",
      mode: "note",
      shared: true,
      body: null,
      actions: [{ type: "ticket_state", stateId: "refund-request.done" }],
    });
    assert.equal(macro.status, 200, JSON.stringify(macro.body));
    const apply = (conversationId: string) =>
      agent("macros", {
        action: "apply",
        macroId: macro.body.id,
        conversationId,
        timezone: "UTC",
      });
    assert.equal((await apply(c1)).status, 200);
    assert.equal(
      (
        await sql("SELECT state_id FROM tickets WHERE conversation_id=$1", [c1])
      )[0].state_id,
      "refund-request.done",
    );
    assert.equal(code(await apply(c4)), "NOT_A_TICKET");

    // Bulk: move two bug tickets along; a non-ticket fails; undo goes back where the graph allows.
    await moveTo(c2, "bug-report.investigating");
    const prepared = await agent("bulk", {
      op: "prepare",
      action: { type: "ticket_state", stateId: "bug-report.waiting" },
      conversationIds: [c2, c4],
    });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    const job = (
      await agent("bulk", {
        op: "commit",
        operationId: prepared.body.operationId,
      })
    ).body.jobId;
    const handlers = {
      "bulk.apply": (j: any) => runBulkApply(db.connect, j),
      "bulk.undo": (j: any) => runBulkUndo(db.connect, j),
    };
    await runJob(db.connect, "a", job, handlers);
    let status = (
      await agent(
        "bulk?" + new URLSearchParams({ id: prepared.body.operationId }),
      )
    ).body;
    assert.deepEqual(status.counts, { applied: 1, failed: 1 });
    const undo = (
      await agent("bulk", {
        op: "undo",
        operationId: prepared.body.operationId,
      })
    ).body.jobId;
    await runJob(db.connect, "a", undo, handlers);
    status = (
      await agent(
        "bulk?" + new URLSearchParams({ id: prepared.body.operationId }),
      )
    ).body;
    assert.deepEqual(status.counts, { undone: 1, failed: 1 });
    assert.equal(
      (
        await sql("SELECT state_id FROM tickets WHERE conversation_id=$1", [c2])
      )[0].state_id,
      "bug-report.investigating",
    );
  } finally {
    await db.close();
  }
});
