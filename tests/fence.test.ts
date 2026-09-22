import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";

test("D1 fence rejects writes from old deployments; data-safe rollback reopens the writer", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE workspace(id TEXT PRIMARY KEY);CREATE TABLE conversations(id TEXT PRIMARY KEY);CREATE TABLE messages(id TEXT PRIMARY KEY);",
    );
    db.exec(await readFile("db/d1-cutover/0001_write_fence.sql", "utf8"));
    db.exec(
      "INSERT INTO conversations VALUES('first');UPDATE relay_write_fence SET authority='frozen' WHERE workspace_id='main';",
    );
    for (const sql of [
      "INSERT INTO conversations VALUES('second')",
      "UPDATE conversations SET id='changed' WHERE id='first'",
      "DELETE FROM conversations WHERE id='first'",
      "INSERT INTO messages VALUES('message')",
      "INSERT INTO workspace VALUES('main')",
    ])
      assert.throws(() => db.exec(sql), /RELAY_STORAGE_FROZEN/);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM conversations").get()?.n,
      1,
    );
    db.exec(await readFile("db/d1-cutover/ROLLBACK.sql", "utf8"));
    db.exec("INSERT INTO conversations VALUES('second')");
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM conversations").get()?.n,
      2,
    );
  } finally {
    db.close();
  }
});
