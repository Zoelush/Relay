import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command, timeline } from "../server/conversations";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { runJob } from "../server/jobs";
import { runBroadcast } from "../server/ticket-links";
import { runBulkApply, runBulkUndo } from "../server/bulk";
import { saveTicketType } from "../server/tickets";

test("ticket categories: customer updates carry only the label, internal tickets stay internal, trackers link and broadcast", async () => {
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
  const customers: Record<string, string> = {};
  /** What the customer's messenger receives for a conversation. */
  const customerView = (id: string, w = "a") =>
    tenant(db.connect, w, async (q) =>
      (
        await timeline(q, w, id, {
          type: "contact",
          identityId: customers[id],
          brandId: "default",
        })
      ).parts.map((p) => ({
        kind: p.kind,
        audience: p.audience,
        data: p.data,
        body: p.body,
      })),
    );
  const handlers = {
    "ticket.broadcast": (j: any) => runBroadcast(db.connect, j),
  };
  const finish = async (jobId: string) => {
    for (
      let i = 0;
      i < 10 &&
      (await runJob(db.connect, "a", jobId, handlers)).state !== "succeeded";
      i++
    );
  };
  try {
    for (const w of ["a", "b"])
      await tenant(db.connect, w, async (q) => {
        await seedFoundation(q, w, "owner-" + w, {
          origins: ["https://shop.test"],
          master: env.identityMaster,
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        });
        await q.query(
          "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name='tickets_v1'",
          [w],
        );
      });
    await sql(
      `INSERT INTO attribute_definitions(workspace_id,id,name,owner_type,value_type) VALUES
      ('a','secret_note','Internal diagnosis','conversation','string'),('a','amount','Amount','conversation','float')`,
    );
    await tenant(db.connect, "a", async (q) => {
      await saveTicketType(q, "a", "owner-a", {
        name: "Bug report",
        category: "customer",
        states: [
          {
            key: "new",
            name: "Triage queue",
            customerLabel: "Received",
            kind: "submitted",
          },
          {
            key: "repro",
            name: "Reproducing",
            customerLabel: "In progress",
            kind: "in_progress",
          },
          {
            key: "fixing",
            name: "Engineering fix",
            customerLabel: "In progress",
            kind: "in_progress",
          },
          {
            key: "done",
            name: "Shipped",
            customerLabel: "Resolved",
            kind: "resolved",
          },
        ],
        transitions: [
          ["new", "repro"],
          ["repro", "fixing"],
          ["fixing", "done"],
        ],
        fields: [{ attributeId: "secret_note" }],
      });
      await saveTicketType(q, "a", "owner-a", {
        name: "Refund approval",
        category: "back_office",
        states: [
          { key: "pending", name: "Pending finance", kind: "submitted" },
          { key: "approved", name: "Approved", kind: "resolved" },
        ],
        transitions: [["pending", "approved"]],
        fields: [{ attributeId: "amount", requiredToClose: true }],
      });
      await saveTicketType(q, "a", "owner-a", {
        name: "Outage",
        category: "tracker",
        states: [
          { key: "investigating", name: "Investigating", kind: "in_progress" },
          { key: "fixed", name: "Fixed", kind: "resolved" },
        ],
        transitions: [["investigating", "fixed"]],
      });
    });
    const start = (w: string, n: number, prefix: string) =>
      tenant(db.connect, w, async (q) => {
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
          const identity = await getIdentity(
            q,
            w,
            "anonymous",
            `${prefix}-${w}-${i}`,
          );
          const id = (
            (await command(
              q,
              w,
              {
                type: "contact",
                identityId: identity.identityId,
                brandId: "default",
              },
              `${prefix}-${w}-${i}`,
              { action: "start", text: `${prefix} ${i}` },
            )) as { conversationId: string }
          ).conversationId;
          customers[id] = identity.identityId;
          ids.push(id);
        }
        return ids;
      });
    const [bugConv, refundConv, ...affected] = await start("a", 6, "Customer");
    const [foreign] = await start("b", 1, "Other");

    // Customer ticket: the customer sees the number, type name and customer label only, and
    // only when the label changes.
    await cmd({
      action: "ticket",
      conversationId: bugConv,
      typeId: "bug-report",
    });
    await cmd({
      action: "attribute_set",
      conversationId: bugConv,
      attributeId: "secret_note",
      value: "Null pointer in billing",
    });
    await cmd({
      action: "ticket_state",
      conversationId: bugConv,
      stateId: "bug-report.repro",
    });
    await cmd({
      action: "ticket_state",
      conversationId: bugConv,
      stateId: "bug-report.fixing",
    });
    await cmd({
      action: "ticket_state",
      conversationId: bugConv,
      stateId: "bug-report.done",
    });
    const seen = await customerView(bugConv);
    const statuses = seen.filter((p) => p.kind === "system_event");
    assert.deepEqual(
      statuses.map((p) => p.data),
      [
        {
          authorName: "Support teammate",
          event: "ticket_status",
          number: 1,
          typeName: "Bug report",
          label: "Received",
        },
        {
          authorName: "Support teammate",
          event: "ticket_status",
          number: 1,
          typeName: "Bug report",
          label: "In progress",
        },
        {
          authorName: "Support teammate",
          event: "ticket_status",
          number: 1,
          typeName: "Bug report",
          label: "Resolved",
        },
      ],
      "one update per label change; 'Engineering fix' shares 'In progress'",
    );
    const text = JSON.stringify(seen);
    for (const secret of [
      "Triage queue",
      "Reproducing",
      "Engineering fix",
      "Shipped",
      "Null pointer",
      "ticket_state_change",
      "ticket_created",
    ])
      assert(!text.includes(secret), `customer must not see ${secret}`);

    // Back-office: created from a conversation, internal, no customer, notes only.
    const created = await agent("tickets", {
      op: "create",
      typeId: "refund-approval",
      title: "Approve refund for order 42",
      conversationId: refundConv,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const backOffice = created.body.conversationId;
    assert.equal(created.body.number, 2);
    const [row] = await sql(
      "SELECT visibility,primary_identity_id,channel,name FROM conversations WHERE id=$1",
      [backOffice],
    );
    assert.deepEqual(row, {
      visibility: "internal",
      primary_identity_id: null,
      channel: "internal",
      name: "Back-office",
    });
    assert.equal(
      code(
        await agent("tickets", {
          op: "create",
          typeId: "refund-approval",
          title: "x",
        }),
      ),
      "TICKET_ORIGIN",
    );
    assert.equal(
      code(
        await cmd({
          action: "reply",
          conversationId: backOffice,
          text: "Hello?",
        }),
      ),
      "INTERNAL_TICKET",
    );
    assert.equal(
      (
        await cmd({
          action: "note",
          conversationId: backOffice,
          text: "Finance, please approve.",
        })
      ).status,
      200,
    );
    assert.equal(
      code(
        await cmd({
          action: "ticket",
          conversationId: refundConv,
          typeId: "refund-approval",
        }),
      ),
      "TICKET_CATEGORY",
    );
    assert.equal(
      code(
        await cmd({
          action: "merge",
          conversationId: refundConv,
          targetId: backOffice,
        }),
      ),
      "INTERNAL_TICKET",
    );
    // No customer can open it, even the originating customer.
    await assert.rejects(
      tenant(db.connect, "a", (q) =>
        timeline(q, "a", backOffice, {
          type: "contact",
          identityId: customers[refundConv],
          brandId: "default",
        }),
      ),
      (e: any) => e.code === "CONVERSATION_NOT_FOUND",
    );
    // The originating conversation shows the link; progress is noted there, internally.
    let ctx = (
      await agent(
        "context?" + new URLSearchParams({ conversation: refundConv }),
      )
    ).body.tickets;
    assert.deepEqual(
      ctx.links.tickets.map((t: any) => [t.id, t.category, t.state]),
      [[backOffice, "back_office", "Pending finance"]],
    );
    assert.equal(
      code(
        await cmd({
          action: "ticket_state",
          conversationId: backOffice,
          stateId: "refund-approval.approved",
        }),
      ),
      "TICKET_FIELDS_REQUIRED",
    );
    await cmd({
      action: "attribute_set",
      conversationId: backOffice,
      attributeId: "amount",
      value: 19.99,
    });
    await cmd({
      action: "ticket_state",
      conversationId: backOffice,
      stateId: "refund-approval.approved",
    });
    const originEvents = await sql(
      "SELECT data,audience FROM conversation_parts WHERE conversation_id=$1 AND kind='system_event' ORDER BY seq",
      [refundConv],
    );
    assert.deepEqual(
      originEvents.map((e) => [e.data.event, e.audience]),
      [
        ["ticket_linked", "internal"],
        ["linked_ticket_state", "internal"],
      ],
    );
    assert.equal(originEvents[1].data.state.name, "Approved");
    assert(
      !JSON.stringify(await customerView(refundConv)).includes(
        "Refund approval",
      ),
      "customer sees nothing of it",
    );

    // Tracker: standalone, linked to four conversations (one closed, one in another workspace
    // refused), then a broadcast that closes them.
    const tracker = (
      await agent("tickets", {
        op: "create",
        typeId: "outage",
        title: "Checkout outage",
      })
    ).body.conversationId;
    assert.deepEqual(
      (await agent("tickets")).body.trackers.map((t: any) => t.id),
      [tracker],
    );
    for (const id of affected)
      assert.equal(
        (
          await cmd({
            action: "ticket_link",
            conversationId: id,
            trackerId: tracker,
          })
        ).status,
        200,
      );
    assert.equal(
      (
        await cmd({
          action: "ticket_link",
          conversationId: affected[0],
          trackerId: tracker,
        })
      ).status,
      200,
      "already linked: no-op",
    );
    assert.equal(
      code(
        await cmd({
          action: "ticket_link",
          conversationId: backOffice,
          trackerId: tracker,
        }),
      ),
      "TICKET_LINK",
    );
    assert.equal(
      code(
        await cmd({
          action: "ticket_link",
          conversationId: bugConv,
          trackerId: backOffice,
        }),
      ),
      "TRACKER_NOT_FOUND",
    );
    assert.equal(
      (
        await cmd(
          {
            action: "ticket_link",
            conversationId: foreign,
            trackerId: tracker,
          },
          "owner-b",
          "b",
        )
      ).status,
      404,
    );
    assert.equal(
      (await agent("tickets", undefined, "owner-b", "b")).body.trackers.length,
      0,
    );
    await cmd({ action: "close", conversationId: affected[3] });
    // One linked conversation is a ticket missing a required field: it gets the message but stays open.
    await tenant(db.connect, "a", (q) =>
      saveTicketType(q, "a", "owner-a", {
        name: "Account issue",
        category: "customer",
        states: [
          { key: "open", name: "Open", kind: "submitted" },
          { key: "done", name: "Done", kind: "resolved" },
        ],
        transitions: [["open", "done"]],
        fields: [{ attributeId: "amount", requiredToClose: true }],
      }),
    );
    await cmd({
      action: "ticket",
      conversationId: affected[2],
      typeId: "account-issue",
    });
    ctx = (
      await agent("context?" + new URLSearchParams({ conversation: tracker }))
    ).body.tickets;
    assert.equal(ctx.links.internal, true);
    assert.equal(ctx.links.total, 4);

    const prepared = await agent("tickets", {
      op: "broadcast-prepare",
      trackerId: tracker,
      text: "The checkout issue is fixed. Sorry for the trouble!",
      closeAfter: true,
    });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.deepEqual([prepared.body.sending, prepared.body.skipped], [3, 1]);
    const key = crypto.randomUUID();
    const committed = await agent(
      "tickets",
      { op: "broadcast-commit", broadcastId: prepared.body.broadcastId },
      "owner-a",
      "a",
      key,
    );
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    assert.equal(
      (
        await agent(
          "tickets",
          { op: "broadcast-commit", broadcastId: prepared.body.broadcastId },
          "owner-a",
          "a",
          key,
        )
      ).body.jobId,
      committed.body.jobId,
      "a retried commit is the same job",
    );
    assert.equal(
      code(
        await agent("tickets", {
          op: "broadcast-commit",
          broadcastId: prepared.body.broadcastId,
        }),
      ),
      "BROADCAST_STARTED",
    );
    await finish(committed.body.jobId);
    // A redelivered step (same payload, items back to pending) repeats the same idempotent
    // commands, so nothing is sent twice.
    await sql(
      "UPDATE broadcast_items SET state='pending' WHERE broadcast_id=$1 AND state='sent'",
      [prepared.body.broadcastId],
    );
    await sql("UPDATE ticket_broadcasts SET status='running' WHERE id=$1", [
      prepared.body.broadcastId,
    ]);
    await runBroadcast(db.connect, {
      workspace_id: "a",
      payload: { broadcastId: prepared.body.broadcastId },
    } as never);
    const status = (
      await agent(
        "ticket-broadcast?" +
          new URLSearchParams({ id: prepared.body.broadcastId }),
      )
    ).body;
    assert.equal(status.status, "done");
    assert.deepEqual(status.counts, { sent: 3, skipped: 1, closed: 2 });
    assert.deepEqual(
      status.problems.map((p: any) => [p.id, p.error]),
      [[affected[2], "Fill in Amount before closing this ticket."]],
    );
    for (const [i, id] of affected.entries()) {
      const replies = (await customerView(id)).filter(
        (p) => p.kind === "teammate_reply",
      );
      assert.equal(
        replies.length,
        i === 3 ? 0 : 1,
        `conversation ${i}: exactly one update`,
      );
      if (i < 3)
        assert.equal(
          replies[0].body,
          "The checkout issue is fixed. Sorry for the trouble!",
        );
    }
    assert.deepEqual(
      (
        await sql(
          "SELECT status FROM conversations WHERE id=ANY($1::text[]) ORDER BY array_position($1::text[],id)",
          [affected],
        )
      ).map((r) => r.status),
      ["closed", "closed", "open", "closed"],
    );
    // Each customer sees only their own conversation; the tracker's title never reaches them.
    assert(
      !JSON.stringify(await customerView(affected[0])).includes(
        "Checkout outage",
      ),
    );

    // Bulk link and its undo.
    const [late1, late2] = await start("a", 2, "Late");
    const bulk = await agent("bulk", {
      op: "prepare",
      action: { type: "ticket_link", trackerId: tracker },
      conversationIds: [late1, late2],
    });
    assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
    const bulkHandlers = {
      "bulk.apply": (j: any) => runBulkApply(db.connect, j),
      "bulk.undo": (j: any) => runBulkUndo(db.connect, j),
    };
    await runJob(
      db.connect,
      "a",
      (
        await agent("bulk", {
          op: "commit",
          operationId: bulk.body.operationId,
        })
      ).body.jobId,
      bulkHandlers,
    );
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM ticket_links WHERE ticket_id=$1",
          [tracker],
        )
      )[0].n,
      6,
    );
    await runJob(
      db.connect,
      "a",
      (await agent("bulk", { op: "undo", operationId: bulk.body.operationId }))
        .body.jobId,
      bulkHandlers,
    );
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM ticket_links WHERE ticket_id=$1",
          [tracker],
        )
      )[0].n,
      4,
    );

    // Unlinking is recorded on both sides.
    await cmd({
      action: "ticket_unlink",
      conversationId: affected[0],
      trackerId: tracker,
    });
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM ticket_links WHERE ticket_id=$1",
          [tracker],
        )
      )[0].n,
      3,
    );

    // Internal tickets never appear in a customer's messenger list, even by identity.
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversations WHERE visibility='internal'",
        )
      )[0].n,
      2,
    );
  } finally {
    await db.close();
  }
});
