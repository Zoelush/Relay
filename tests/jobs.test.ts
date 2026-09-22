import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation, getIdentity } from "../server/people";
import {
  enqueueJob,
  dispatchJobs,
  runJob,
  readJob,
  type WorkMessage,
} from "../server/jobs";
import { drainConversationOutbox } from "../server/outbox";

test("durable job retries, checkpoint resume, dead-letter state, and workspace isolation", async () => {
  const db = await testDatabase();
  try {
    await tenant(db.connect, "a", (sql) =>
      seedFoundation(sql, "a", "owner", {
        origins: [],
        master: "a".repeat(32),
        identitySecret: new TextEncoder().encode("b".repeat(32)),
      }),
    );
    const { id, identity } = await tenant(db.connect, "a", async (sql) => {
      const identity = await getIdentity(sql, "a", "anonymous", "device");
      return {
        identity: identity.identityId,
        id: await enqueueJob(
          sql,
          "a",
          "test",
          {},
          { identityId: identity.identityId },
        ),
      };
    });
    const messages: WorkMessage[] = [];
    await dispatchJobs(db.connect, "a", async (m) => {
      messages.push(m);
    });
    assert(messages.some((m) => "jobId" in m && m.jobId === id));
    let calls = 0;
    const handlers = {
      test: async () => {
        calls++;
        if (calls === 1) throw new Error("Transient");
        return { done: calls === 3, result: { page: calls - 1 } };
      },
    };
    assert.equal((await runJob(db.connect, "a", id, handlers)).state, "queued");
    assert.equal((await runJob(db.connect, "a", id, handlers)).state, "queued");
    assert.equal(
      (await runJob(db.connect, "a", id, handlers)).state,
      "succeeded",
    );
    await runJob(db.connect, "a", id, handlers);
    assert.equal(calls, 3);
    const result = await tenant(db.connect, "a", (sql) =>
      readJob(sql, "a", id, { identityId: identity }),
    );
    assert.deepEqual(result.result, { page: 2 });
    await assert.rejects(
      tenant(db.connect, "b", (sql) =>
        readJob(sql, "b", id, { identityId: identity }),
      ),
      { code: "JOB_NOT_FOUND" },
    );
    const failure = await tenant(db.connect, "a", (sql) =>
      enqueueJob(sql, "a", "missing", {}, { identityId: identity }),
    );
    for (let i = 0; i < 5; i++) await runJob(db.connect, "a", failure, {});
    assert.equal(
      (
        await tenant(db.connect, "a", (sql) =>
          readJob(sql, "a", failure, { identityId: identity }),
        )
      ).state,
      "dead_letter",
    );
  } finally {
    await db.close();
  }
});

test("outbox survives a failed publish and marks only successfully dispatched parts", async () => {
  const db = await testDatabase();
  try {
    await tenant(db.connect, "a", async (sql) => {
      await seedFoundation(sql, "a", "owner", {
        origins: [],
        master: "a".repeat(32),
        identitySecret: new TextEncoder().encode("b".repeat(32)),
      });
      await sql.query(
        "INSERT INTO outbox(workspace_id,id,kind,resource_id,payload) VALUES('a','part','conversation','conversation','{}')",
      );
    });
    await assert.rejects(
      drainConversationOutbox(db.connect, "a", async () => {
        throw new Error("Process stopped");
      }),
    );
    let delivered = 0;
    assert.equal(
      await drainConversationOutbox(db.connect, "b", async () => {
        delivered++;
      }),
      0,
    );
    assert.equal(
      await drainConversationOutbox(db.connect, "a", async (ids) => {
        delivered++;
        assert.deepEqual(ids, ["conversation"]);
        // This commit happens after the dispatch snapshot; it must retain its own intent.
        await tenant(db.connect, "a", (sql) =>
          sql.query(
            "INSERT INTO outbox(workspace_id,id,kind,resource_id,payload) VALUES('a','later-part','conversation','later-conversation','{}')",
          ),
        );
      }),
      1,
    );
    assert.equal(
      await drainConversationOutbox(db.connect, "a", async (ids) => {
        delivered++;
        assert.deepEqual(ids, ["later-conversation"]);
      }),
      1,
    );
    assert.equal(
      await drainConversationOutbox(db.connect, "a", async () => {
        delivered++;
      }),
      0,
    );
    assert.equal(delivered, 2);
    assert.equal(
      await drainConversationOutbox(
        db.connect,
        "a",
        async (ids) => {
          assert.deepEqual(ids, ["counter-only"]);
        },
        ["counter-only"],
      ),
      0,
    );
  } finally {
    await db.close();
  }
});
