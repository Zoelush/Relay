import test from "node:test";
import assert from "node:assert/strict";
import { businessMilliseconds } from "../server/business-time";
test("business time excludes weekends/holidays and counts actual open time across DST and partial minutes", () => {
  const weekly = {
    "1": [["09:00", "17:00"]],
    "2": [["09:00", "17:00"]],
    "3": [["09:00", "17:00"]],
    "4": [["09:00", "17:00"]],
    "5": [["09:00", "17:00"]],
  } as Record<string, [string, string][]>;
  assert.equal(
    businessMilliseconds(
      new Date("2026-03-27T16:59:30Z"),
      new Date("2026-03-30T08:00:30Z"),
      "Europe/London",
      { weekly },
    ),
    60000,
  );
  assert.equal(
    businessMilliseconds(
      new Date("2026-03-27T16:59:30Z"),
      new Date("2026-03-30T08:00:30Z"),
      "Europe/London",
      { weekly, holidays: ["2026-03-30"] },
    ),
    30000,
  );
  assert.equal(
    businessMilliseconds(
      new Date("2026-10-25T00:00:00Z"),
      new Date("2026-10-25T02:00:00Z"),
      "Europe/London",
      { weekly: { "0": [["01:00", "02:00"]] } },
    ),
    7200000,
  );
});
