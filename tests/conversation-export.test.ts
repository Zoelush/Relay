import test from "node:test";
import assert from "node:assert/strict";
import { transcript } from "../agent/export";

const part = (
  id: string,
  seq: number,
  kind: string,
  body: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  seq: String(seq),
  kind,
  audience: "customer_visible",
  body,
  author_type: "teammate",
  created_at: `2026-10-02T09:0${seq}:00Z`,
  data: {},
  ...extra,
});

test("export as text: the conversation as the customer saw it, oldest first; no notes or events", () => {
  const text = transcript(
    "Where is my order?",
    [
      part("p3", 3, "teammate_reply", "It ships today.", {
        data: { authorName: "Ada" },
      }),
      part("p1", 1, "customer_message", "Where is my order?", {
        author_type: "contact",
      }),
      part("p2", 2, "internal_note", "Check the carrier first.", {
        audience: "internal",
      }),
      part("p4", 4, "assignment_change", ""),
      part("p5", 5, "teammate_reply", "Old wording"),
      part("p6", 6, "teammate_reply", "New wording", {
        supersedes_id: "p5",
      }),
      part("p7", 7, "teammate_reply", "Removed", { data: { deleted: true } }),
    ] as never,
    "en-GB",
  );
  assert.match(
    text,
    /^Where is my order\?\nExported from Relay\. Internal notes are not included\./,
  );
  assert(text.indexOf("Customer ·") < text.indexOf("Ada ·"), "oldest first");
  assert.match(text, /It ships today\./);
  assert.match(text, /New wording/);
  for (const hidden of ["Check the carrier", "Old wording", "Removed"])
    assert(!text.includes(hidden), hidden);
});
