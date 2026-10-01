import test from "node:test";
import assert from "node:assert/strict";
import { errorFingerprint } from "../server/api";
import { tenant } from "../server/db";

test("unexpected errors are logged by class, SQLSTATE and source location, never by message", async () => {
  // A database error whose message carries customer data.
  const pgError = Object.assign(
    new Error('duplicate key value: email "jo@example.test"'),
    { code: "23505" },
  );
  const logged = JSON.stringify(errorFingerprint(pgError));
  assert(
    !logged.includes("jo@example.test") && !logged.includes("duplicate"),
    logged,
  );
  assert.equal(errorFingerprint(pgError).code, "23505");
  assert.equal(
    errorFingerprint(Object.assign(new Error("x"), { code: "ECONNRESET" }))
      .code,
    undefined,
    "only SQLSTATE codes",
  );
  // The source location is relative to the repository, from the first application frame.
  const thrown = await tenant(
    async () => {
      throw new Error("connect failed for jo@example.test");
    },
    "a",
    async () => null,
  ).catch((e) => e);
  const at = errorFingerprint(thrown);
  assert.equal(at.type, "Error");
  assert.match(
    String(at.at),
    /^(server|tests)\/[\w./-]+\.ts:\d+$|^server\/db\.ts:\d+$/,
  );
  assert(!JSON.stringify(at).includes("/Users/"), "no absolute paths");
  assert.deepEqual(errorFingerprint("boom"), { type: "string" });
});
