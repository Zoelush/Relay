import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { assertRuntimeRole, hyperdriveConnection } from "../server/postgres";

test("the runtime refuses absent Hyperdrive and privileged connections that bypass tenant policies", async () => {
  await assert.rejects(
    hyperdriveConnection(undefined)(),
    /Hyperdrive binding is required/,
  );
  const db = await testDatabase();
  try {
    await assert.rejects(assertRuntimeRole(db), /non-owner/);
    await tenant(db.connect, "tenant", assertRuntimeRole);
  } finally {
    await db.close();
  }
});
