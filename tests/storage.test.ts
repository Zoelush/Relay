import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant, once } from "../server/db";
import {
  importSnapshot,
  exportSnapshot,
  type LegacySnapshot,
} from "../server/migration";

test("D1 copy round-trips IDs, tokens, timestamps and private notes; replay is safe; wrong tenant cannot read", async () => {
  const db = await testDatabase();
  try {
    const source: LegacySnapshot = {
      workspace: [
        {
          id: "a",
          owner_id: "owner-a",
          brand: "A",
          greeting: "Hi",
          color: "#087a57",
          availability: "Open",
        },
      ],
      conversations: [
        {
          id: "chat-legacy",
          token_hash: "opaque",
          name: "Visitor",
          email: "a@example.com",
          title: "Help",
          status: "open",
          assigned: "",
          priority: 1,
          unread: 1,
          sample: 0,
          tag: "New",
          created_at: 1700000000123,
          updated_at: 1700000000456,
        },
      ],
      messages: [
        {
          id: "m",
          conversation_id: "chat-legacy",
          kind: "note",
          body: "Private",
          sender: "Owner",
          created_at: 1700000000321,
        },
      ],
    };
    await tenant(db.connect, "a", (sql) => importSnapshot(sql, "a", source));
    await tenant(db.connect, "a", (sql) => importSnapshot(sql, "a", source));
    assert.deepEqual(
      await tenant(db.connect, "a", (sql) => exportSnapshot(sql, "a")),
      source,
    );
    await tenant(db.connect, "b", async (sql) => {
      assert.equal((await sql.query("SELECT * FROM messages")).rows.length, 0);
      assert.equal(
        (await sql.query("SELECT * FROM messages WHERE workspace_id=$1", ["a"]))
          .rows.length,
        0,
      );
    });
    await assert.rejects(
      tenant(db.connect, "b", (sql) =>
        sql.query(
          "INSERT INTO messages(workspace_id,id,conversation_id,kind,body,sender,created_at) VALUES($1,$2,$3,$4,$5,$6,now())",
          ["a", "bad", "chat-legacy", "note", "x", "x"],
        ),
      ),
      /row-level security/,
    );
    const altered = structuredClone(source);
    altered.messages[0].body = "Wrong data";
    await assert.rejects(
      tenant(db.connect, "a", (sql) => importSnapshot(sql, "a", altered)),
      /Target differs/,
    );
  } finally {
    await db.close();
  }
});

test("whole-operation receipt survives lost acknowledgement; changed payload is refused", async () => {
  const db = await testDatabase();
  try {
    await tenant(db.connect, "a", (sql) =>
      sql.query(
        "INSERT INTO workspace(id,workspace_id,owner_id,brand,greeting,color,availability) VALUES('a','a','o','A','Hi','#000000','Open')",
      ),
    );
    let writes = 0;
    const submit = (payload: unknown) =>
      tenant(db.connect, "a", (sql) =>
        once(sql, "a", "reply", "retry-key-123", payload, async () => {
          writes++;
          return { id: "committed" };
        }),
      );
    assert.deepEqual(await submit({ text: "hello" }), { id: "committed" });
    assert.deepEqual(await submit({ text: "hello" }), { id: "committed" });
    assert.equal(writes, 1);
    await assert.rejects(submit({ text: "different" }), /different data/);
  } finally {
    await db.close();
  }
});
