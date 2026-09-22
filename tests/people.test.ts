import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import {
  seedFoundation,
  getIdentity,
  mergeVisitorIdentity,
  reverseContactMerge,
} from "../server/people";
import { command, timeline } from "../server/conversations";

test("non-destructive merge preserves conversation identity; survivor false/zero/empty win; reversal restores mapping", async () => {
  const db = await testDatabase();
  try {
    await tenant(db.connect, "a", (sql) =>
      seedFoundation(sql, "a", "owner", {
        origins: ["https://example.com"],
        master: "a".repeat(32),
        identitySecret: new TextEncoder().encode("b".repeat(32)),
      }),
    );
    await tenant(db.connect, "a", async (sql) => {
      const visitor = await getIdentity(sql, "a", "anonymous", "device"),
        user = await getIdentity(sql, "a", "user", "person");
      await sql.query(
        "UPDATE contacts SET profile=$3 WHERE workspace_id=$1 AND id=$2",
        [
          "a",
          visitor.contactId,
          JSON.stringify({
            tier: "trial",
            active: true,
            count: 4,
            name: "visitor",
          }),
        ],
      );
      await sql.query(
        "UPDATE contacts SET profile=$3 WHERE workspace_id=$1 AND id=$2",
        [
          "a",
          user.contactId,
          JSON.stringify({ active: false, count: 0, name: "" }),
        ],
      );
      const actor = {
          type: "contact" as const,
          identityId: visitor.identityId,
          brandId: "default",
        },
        created = await command(sql, "a", actor, "create-key", {
          action: "start",
          text: "Visitor history",
        });
      const conversationId = String(created.conversationId);
      const before = (
        await sql.query(
          "SELECT * FROM conversation_parts WHERE workspace_id=$1",
          ["a"],
        )
      ).rows;
      const mergeId = await mergeVisitorIdentity(
        sql,
        "a",
        visitor.identityId,
        user.contactId,
      );
      assert(mergeId);
      assert.deepEqual(
        (
          await sql.query<{ profile: unknown }>(
            "SELECT profile FROM contacts WHERE workspace_id=$1 AND id=$2",
            ["a", user.contactId],
          )
        ).rows[0].profile,
        { tier: "trial", active: false, count: 0, name: "" },
      );
      const history = await timeline(sql, "a", conversationId, {
        type: "contact",
        identityId: user.identityId,
        brandId: "default",
        verified: true,
      });
      assert(history.parts.some((p) => p.body === "Visitor history"));
      assert.deepEqual(
        (
          await sql.query(
            "SELECT * FROM conversation_parts WHERE workspace_id=$1",
            ["a"],
          )
        ).rows,
        before,
      );
      assert.equal(
        (
          await sql.query("SELECT id FROM contacts WHERE workspace_id=$1", [
            "a",
          ])
        ).rows.length,
        2,
      );
      await reverseContactMerge(sql, "a", mergeId);
      assert.equal(
        (
          await sql.query<{ contact_id: string }>(
            "SELECT contact_id FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2",
            ["a", visitor.identityId],
          )
        ).rows[0].contact_id,
        visitor.contactId,
      );
      assert.equal(
        (
          await sql.query(
            "SELECT p.id FROM conversation_parts p LEFT JOIN conversations c ON c.workspace_id=p.workspace_id AND c.id=p.conversation_id WHERE p.workspace_id=$1 AND c.id IS NULL",
            ["a"],
          )
        ).rows.length,
        0,
      );
    });
  } finally {
    await db.close();
  }
});

test("contact reversal reports later-edit conflict and cross-workspace lookup fails", async () => {
  const db = await testDatabase();
  try {
    await tenant(db.connect, "a", (sql) =>
      seedFoundation(sql, "a", "owner", {
        origins: [],
        master: "a".repeat(32),
        identitySecret: new TextEncoder().encode("b".repeat(32)),
      }),
    );
    const id = await tenant(db.connect, "a", async (sql) => {
      const a = await getIdentity(sql, "a", "anonymous", "device"),
        b = await getIdentity(sql, "a", "user", "person");
      const id = await mergeVisitorIdentity(
        sql,
        "a",
        a.identityId,
        b.contactId,
      );
      await sql.query(
        "UPDATE contacts SET profile=$3,version=version+1 WHERE workspace_id=$1 AND id=$2",
        ["a", b.contactId, { later: true }],
      );
      return id!;
    });
    await assert.rejects(
      tenant(db.connect, "a", (sql) => reverseContactMerge(sql, "a", id)),
      { code: "MERGE_REVERSAL_CONFLICT" },
    );
    await assert.rejects(
      tenant(db.connect, "b", (sql) => reverseContactMerge(sql, "b", id)),
      { code: "MERGE_NOT_FOUND" },
    );
  } finally {
    await db.close();
  }
});
