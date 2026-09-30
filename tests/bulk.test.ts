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

test("bulk actions: server-counted selection, stepped job, per-item failures, conflict-aware undo within the window", async () => {
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
  const bulk = (
    data: Record<string, unknown>,
    principal = "owner-a",
    workspace = "a",
    key?: string,
  ) => agent("bulk", data, principal, workspace, key);
  const status = (id: string, principal = "owner-a", workspace = "a") =>
    agent(
      "bulk?" + new URLSearchParams({ id }),
      undefined,
      principal,
      workspace,
    );
  const handlers = {
    "bulk.apply": (job: any) => runBulkApply(db.connect, job),
    "bulk.undo": (job: any) => runBulkUndo(db.connect, job),
  };
  /** Runs one job step; returns whether the job has finished. */
  const step = async (jobId: string) =>
    (await runJob(db.connect, "a", jobId, handlers)).state === "succeeded";
  const finish = async (jobId: string) => {
    for (let i = 0; i < 20 && !(await step(jobId)); i++);
  };
  const tags = async (id: string) =>
    (
      await sql<{ tag_id: string }>(
        "SELECT tag_id FROM conversation_tags WHERE conversation_id=$1 ORDER BY tag_id",
        [id],
      )
    ).map((r) => r.tag_id);
  const state = async (id: string) =>
    (
      await sql<{ status: string }>(
        "SELECT status FROM conversations WHERE id=$1",
        [id],
      )
    )[0].status;
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
    await sql("INSERT INTO tags(workspace_id,id,name) VALUES('a','vip','VIP')");
    await sql(
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','ada','ada-a','Ada','agent')",
    );
    // A role that may manage conversations but not assign them.
    await sql(
      "INSERT INTO roles(workspace_id,id,name) VALUES('a','limited','limited')",
    );
    await sql(
      "INSERT INTO role_capabilities(workspace_id,role_id,capability) SELECT 'a','limited',c FROM unnest(ARRAY['conversations.read','conversations.reply','conversations.manage']) c",
    );
    await sql(
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','lin','lin-a','Lin','limited')",
    );
    const start = (w: string, n: number) =>
      tenant(db.connect, w, async (q) => {
        const identity = await getIdentity(
          q,
          w,
          "anonymous",
          "bulk-customer-" + w,
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
                `bulk-${w}-${i}`,
                { action: "start", text: `Question ${i}` },
              )) as { conversationId: string }
            ).conversationId,
          );
        return ids;
      });
    const ids = await start("a", 30);
    const [foreign] = await start("b", 1);

    // Validation: the action is checked before anything is stored.
    for (const [action, code] of [
      [{ type: "attribute_set", attributeId: "x", value: 1 }, "INVALID_BULK"],
      [{ type: "ticket_state", state: "resolved" }, "TICKETS_UNAVAILABLE"],
    ] as const) {
      const r = await bulk({ op: "prepare", action, conversationIds: ids });
      assert.equal(r.body.error?.code, code, JSON.stringify(r.body));
    }
    assert.equal(
      (
        await bulk({
          op: "prepare",
          action: { type: "close" },
          conversationIds: Array.from({ length: 5001 }, (_, i) => "c" + i),
        })
      ).body.error.code,
      "BULK_TOO_LARGE",
    );
    // Another workspace's conversations are never counted.
    assert.equal(
      (
        await bulk({
          op: "prepare",
          action: { type: "close" },
          conversationIds: [foreign],
        })
      ).body.error.code,
      "BULK_EMPTY",
    );

    // Tag three conversations, one of which already has the tag. The count is the server's.
    const three = ids.slice(0, 3);
    await sql(
      "INSERT INTO conversation_tags(workspace_id,conversation_id,tag_id) VALUES('a',$1,'vip')",
      [three[0]],
    );
    const prepared = await bulk({
      op: "prepare",
      action: { type: "tag_add", tagId: "vip" },
      conversationIds: [...three, three[1], foreign, "unknown"],
    });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.equal(prepared.body.total, 3);
    const operationId = prepared.body.operationId;
    // Other workspaces and other teammates cannot see or commit it.
    assert.equal((await status(operationId, "owner-b", "b")).status, 404);
    assert.equal((await status(operationId, "ada-a")).status, 404);
    assert.equal(
      (await bulk({ op: "commit", operationId }, "ada-a")).status,
      404,
    );

    const key = crypto.randomUUID();
    const committed = await bulk(
      { op: "commit", operationId },
      "owner-a",
      "a",
      key,
    );
    assert.equal(committed.status, 202, JSON.stringify(committed.body));
    // Retrying with the same key returns the same job; a new commit is refused.
    assert.equal(
      (await bulk({ op: "commit", operationId }, "owner-a", "a", key)).body
        .jobId,
      committed.body.jobId,
    );
    assert.equal(
      (await bulk({ op: "commit", operationId })).body.error.code,
      "BULK_STARTED",
    );
    const undoUntil = Date.parse(committed.body.undoUntil);
    assert(
      undoUntil - Date.now() > 8_000 && undoUntil - Date.now() <= 10_000,
      "ten seconds from commit",
    );
    await finish(committed.body.jobId);
    for (const id of three) assert.deepEqual(await tags(id), ["vip"]);
    let read = (await status(operationId)).body;
    assert.equal(read.status, "done");
    assert.deepEqual(read.counts, { applied: 3 });
    // The ordinary command ran: the timeline records it.
    assert.equal(
      (
        await sql(
          "SELECT 1 FROM conversation_parts WHERE conversation_id=$1 AND kind='tag_change'",
          [three[1]],
        )
      ).length,
      1,
    );

    // Someone removes the tag from one conversation; undo leaves that one alone as a conflict,
    // leaves the tag that was there before, and removes the rest.
    await sql("DELETE FROM conversation_tags WHERE conversation_id=$1", [
      three[2],
    ]);
    await sql(
      "INSERT INTO conversation_tags(workspace_id,conversation_id,tag_id) VALUES('a',$1,'vip')",
      [three[2]],
    );
    await sql("DELETE FROM conversation_tags WHERE conversation_id=$1", [
      three[1],
    ]);
    const undo = await bulk({ op: "undo", operationId });
    assert.equal(undo.status, 202, JSON.stringify(undo.body));
    await finish(undo.body.jobId);
    read = (await status(operationId)).body;
    assert.equal(read.status, "undone");
    assert.deepEqual(read.counts, { undone: 2, conflict: 1 });
    assert.deepEqual(
      read.conflicts.map((c: any) => c.id),
      [three[1]],
    );
    assert.deepEqual(await tags(three[0]), ["vip"], "it had the tag before");
    assert.deepEqual(await tags(three[1]), [], "changed since: left alone");
    assert.deepEqual(await tags(three[2]), [], "reversed");
    assert.equal(
      (await bulk({ op: "undo", operationId })).body.error.code,
      "BULK_UNDONE",
    );

    // Undo while running: conversations not reached are cancelled; a conversation reopened
    // by someone else in the meantime is a conflict.
    const close = await bulk({
      op: "prepare",
      action: { type: "close" },
      conversationIds: ids,
    });
    assert.equal(close.body.total, 30);
    const closeJob = (
      await bulk({ op: "commit", operationId: close.body.operationId })
    ).body.jobId;
    assert.equal(await step(closeJob), false, "25 per step");
    assert.equal(await state(ids[0]), "closed");
    assert.equal(await state(ids[29]), "open");
    await tenant(db.connect, "a", (q) =>
      command(
        q,
        "a",
        { type: "teammate", principal: "ada-a" },
        "reopen-" + ids[4],
        { action: "reopen", conversationId: ids[4] },
      ),
    );
    const undoClose = await bulk({
      op: "undo",
      operationId: close.body.operationId,
    });
    assert.equal(undoClose.status, 202, JSON.stringify(undoClose.body));
    await finish(closeJob);
    await finish(undoClose.body.jobId);
    read = (await status(close.body.operationId)).body;
    assert.equal(read.status, "undone");
    assert.deepEqual(read.counts, { undone: 24, conflict: 1, cancelled: 5 });
    for (const id of ids) assert.equal(await state(id), "open");

    // After the window, undo is refused.
    const late = await bulk({
      op: "prepare",
      action: { type: "priority", value: true },
      conversationIds: ids.slice(0, 2),
    });
    const lateJob = (
      await bulk({ op: "commit", operationId: late.body.operationId })
    ).body.jobId;
    await finish(lateJob);
    await sql(
      "UPDATE bulk_operations SET undo_until=now()-interval '1 second' WHERE id=$1",
      [late.body.operationId],
    );
    const expired = await bulk({
      op: "undo",
      operationId: late.body.operationId,
    });
    assert.equal(expired.status, 409);
    assert.equal(expired.body.error.code, "UNDO_EXPIRED");
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversations WHERE priority AND id=ANY($1::text[])",
          [ids.slice(0, 2)],
        )
      )[0].n,
      2,
    );

    // Per-item failures are recorded, not fatal: this role cannot assign.
    const assign = await bulk(
      {
        op: "prepare",
        action: { type: "assign", teammateId: "ada" },
        conversationIds: ids.slice(0, 2),
      },
      "lin-a",
    );
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    const assignJob = (
      await bulk(
        { op: "commit", operationId: assign.body.operationId },
        "lin-a",
      )
    ).body.jobId;
    await finish(assignJob);
    read = (await status(assign.body.operationId, "lin-a")).body;
    assert.equal(read.status, "done");
    assert.deepEqual(read.counts, { failed: 2 });
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversations WHERE assigned='ada'",
        )
      )[0].n,
      0,
    );
  } finally {
    await db.close();
  }
});
