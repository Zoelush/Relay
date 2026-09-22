import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation, getIdentity } from "../server/people";
import { command } from "../server/conversations";
import { searchConversations, reindexSearch } from "../server/search";
import { enqueueJob, runJob } from "../server/jobs";

test("search filters, superseding edits, merged aliases, incremental rebuild and tenant boundary", async () => {
  const db = await testDatabase();
  try {
    await tenant(db.connect, "a", (sql) =>
      seedFoundation(sql, "a", "owner", {
        origins: [],
        master: "a".repeat(32),
        identitySecret: new TextEncoder().encode("b".repeat(32)),
      }),
    );
    await tenant(db.connect, "a", async (sql) => {
      const identity = await getIdentity(sql, "a", "anonymous", "device"),
        actor = {
          type: "contact" as const,
          identityId: identity.identityId,
          brandId: "default",
        };
      const first = await command(sql, "a", actor, "first-search", {
          action: "start",
          text: "invoice shipment",
        }),
        second = await command(sql, "a", actor, "second-search", {
          action: "start",
          text: "old order",
        });
      const agent = { type: "teammate" as const, principal: "owner" };
      const reply = await command(sql, "a", agent, "reply-search", {
        action: "reply",
        conversationId: String(second.conversationId),
        text: "refund outdated",
      });
      assert("partId" in reply);
      await command(sql, "a", agent, "edit-search", {
        action: "edit",
        conversationId: String(second.conversationId),
        partId: String(reply.partId),
        text: "corrected amount",
      });
      await command(sql, "a", agent, "merge-search", {
        action: "merge",
        conversationId: String(second.conversationId),
        targetId: String(first.conversationId),
      });
      return { first: String(first.conversationId) };
    });
    const search = (w: string, q: string) =>
      tenant(db.connect, w, (sql) =>
        searchConversations(sql, w, new URLSearchParams(q)),
      );
    assert.equal(
      (await search("a", "q=invoice&state=open&channel=messenger"))
        .conversations.length,
      1,
    );
    assert.equal(
      (await search("a", "q=invoice&state=closed")).conversations.length,
      0,
    );
    assert.equal((await search("a", "q=outdated")).conversations.length, 0);
    assert.equal((await search("a", "q=corrected")).conversations.length, 1);
    assert.equal((await search("b", "q=invoice")).conversations.length, 0);
    const job = await tenant(db.connect, "a", async (sql) => {
      await sql.query(
        "DELETE FROM conversation_search_documents WHERE workspace_id=$1",
        ["a"],
      );
      return enqueueJob(
        sql,
        "a",
        "search.reindex",
        {},
        { teammateId: "owner" },
      );
    });
    assert.equal((await search("a", "q=invoice")).conversations.length, 0);
    assert.equal(
      (
        await runJob(db.connect, "a", job, {
          "search.reindex": (job) => reindexSearch(db.connect, job),
        })
      ).state,
      "succeeded",
    );
    assert.equal((await search("a", "q=corrected")).conversations.length, 1);
    assert.equal((await search("a", "q=outdated")).conversations.length, 0);
  } finally {
    await db.close();
  }
});
