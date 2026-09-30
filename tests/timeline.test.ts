import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describePart, type TimelinePart } from "../agent/timeline";

const dir = {
  teammates: [
    { id: "t1", name: "Ada" },
    { id: "t2", name: "Grace" },
  ],
  teams: [{ id: "billing", name: "Billing" }],
  tags: [{ id: "vip", name: "VIP" }],
};
const part = (
  kind: string,
  data: Record<string, unknown> = {},
  author: Partial<TimelinePart> = {},
): TimelinePart => ({
  id: kind,
  kind,
  audience: "public",
  body: "",
  author_type: "teammate",
  author_id: "t1",
  created_at: "2026-09-30T10:00:00.000Z",
  data,
  ...author,
});

test("every system part kind the database allows has its own description", async () => {
  const schema = await readFile("db/postgres/0003_conversations.sql", "utf8");
  const kinds = [
    ...schema.match(/kind IN \(([^)]*)\)/)![1].matchAll(/'([a-z_]+)'/g),
  ].map((m) => m[1]);
  const messages = [
    "customer_message",
    "teammate_reply",
    "internal_note",
    "ai_reply",
    "attachment",
  ];
  assert.equal(kinds.length, 15);
  const samples: Record<string, [Record<string, unknown>, string]> = {
    state_change: [{ from: "open", to: "closed" }, "Ada closed this conversation"],
    assignment_change: [
      { after: { teammate: "t2", team: "billing" } },
      "Ada assigned this to Grace and team Billing",
    ],
    priority_change: [{ before: false, after: true }, "Ada marked this as priority"],
    tag_change: [{ action: "tag_add", tagId: "vip" }, "Ada added the tag VIP"],
    participant_change: [{ action: "participant_add" }, "Ada added a participant"],
    attribute_change: [
      { attribute: "title", after: "Refund" },
      "Ada renamed this to “Refund”",
    ],
    rating: [{ value: 4 }, "Customer rated this conversation 4 out of 5"],
    system_event: [
      { event: "human_joined", teammateId: "t2" },
      "Grace joined the conversation",
    ],
    channel_handover: [{ channel: "email" }, "Conversation moved to email"],
    merge_marker: [
      { into: "other" },
      "This conversation was merged into another conversation",
    ],
  };
  for (const kind of kinds.filter((k) => !messages.includes(k))) {
    assert(samples[kind], "a sample exists for " + kind);
    assert.equal(describePart(part(kind, samples[kind][0]), dir), samples[kind][1]);
  }
});

test("state and assignment descriptions cover snooze, wake, reopen and unassign", () => {
  assert.match(
    describePart(
      part("state_change", {
        to: "snoozed",
        until: "2026-10-01T08:00:00.000Z",
        timezone: "Europe/London",
        unassignOnWake: true,
      }),
      dir,
    ),
    /^Ada snoozed this until .*09:00.*, unassigning when it wakes$/,
  );
  assert.equal(
    describePart(part("state_change", { to: "open", woke: true }, { author_type: "system" }), dir),
    "Snooze ended; the conversation is open again",
  );
  assert.equal(
    describePart(part("state_change", { from: "closed", to: "open" }), dir),
    "Ada reopened this conversation",
  );
  assert.equal(
    describePart(part("assignment_change", { after: { teammate: "", team: null } }), dir),
    "Ada unassigned this conversation",
  );
  assert.equal(
    describePart(
      part("assignment_change", { reason: "snooze_wake", after: { teammate: "" } }, { author_type: "system" }),
      dir,
    ),
    "Unassigned when the snooze ended",
  );
  assert.equal(
    describePart(part("tag_change", { action: "tag_remove", tagId: "gone" }), dir),
    "Ada removed the tag gone",
    "an unknown id is shown rather than hidden",
  );
});
