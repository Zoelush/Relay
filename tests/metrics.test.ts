import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { METRICS, metricsDocument } from "../lib/metrics";
import { conversationFacts, type FactPart } from "../server/analytics";

/**
 * The metric dictionary and conversation facts (phase 14, R1; docs/REPORTING_STEP1.md): the
 * document is the code's; every metric the brief and the gap audit name is defined in full; and the
 * brief's acceptance test that office-hours durations are right across daylight saving changes.
 */
test("docs/METRICS.md is generated from lib/metrics.ts, and defines every metric the brief asks for in full", () => {
  assert.equal(readFileSync("docs/METRICS.md", "utf8"), metricsDocument(), "run npm run metrics:doc");
  const ids = METRICS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
  for (const id of [
    "new_conversations",
    "conversations_replied_to",
    "replies_sent",
    "closed_conversations",
    "reopened_conversations",
    "open_at_end",
    "snoozed_at_end",
    "first_response_time",
    "next_response_time",
    "time_to_close",
    "time_to_resolve",
    "handling_time",
    "handling_time_excluding_idle",
    "sla_hit_rate",
    "sla_miss_rate",
    "sla_misses",
    "csat",
    "csat_response_rate",
    "ai_resolution_rate",
    "ai_escalation_rate",
    "ai_answer_rate",
    "ai_involvement",
    "deflection",
    "conversations_per_teammate_hour",
    "busiest_period",
    // The gap audit's.
    "first_contact_resolution",
    "repeat_contact",
    "adjusted_handling_time",
    "reassignments",
  ])
    assert.ok(ids.includes(id), id);
  for (const m of METRICS) for (const k of ["formula", "anchor", "includes", "excludes", "automation"] as const) assert.ok(m[k].trim().length > 10, `${m.id}.${k}`);
});

const at = (iso: string) => new Date(iso);
const part = (seq: number, kind: string, iso: string, extra: Partial<FactPart> = {}): FactPart => ({
  seq,
  kind,
  author_type: kind === "customer_message" ? "contact" : kind === "teammate_reply" ? "teammate" : kind === "ai_reply" ? "ai" : "system",
  audience: "public",
  at: at(iso),
  data: {},
  ...extra,
});
// Open every day 09:00 to 17:00 in London.
const london = { timezone: "Europe/London", schedule: { weekly: Object.fromEntries(["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, [["09:00", "17:00"]] as [string, string][]])) } };

test("office-hours durations are right across daylight saving changes (the brief's acceptance test)", () => {
  // Autumn: Saturday 24 October 2026 16:00 BST (15:00Z) to Sunday 25 October 10:00 GMT (10:00Z);
  // the clocks went back at 02:00 BST on the Sunday. Wall-clock: 19 hours (not the 18 the local
  // clock suggests). Office hours: 16:00–17:00 Saturday and 09:00–10:00 Sunday, 2 hours.
  let f = conversationFacts([part(1, "customer_message", "2026-10-24T15:00:00Z"), part(2, "teammate_reply", "2026-10-25T10:00:00Z")], at("2026-10-24T15:00:00Z"), london);
  assert.equal(f.firstResponseMs, 19 * 3_600_000);
  assert.equal(f.firstResponseBusinessMs, 2 * 3_600_000);
  // Spring: Saturday 28 March 2026 16:00 GMT (16:00Z) to Sunday 29 March 10:00 BST (09:00Z); the
  // clocks went forward at 01:00 GMT. Wall-clock: 17 hours; office hours: 2 hours.
  f = conversationFacts([part(1, "customer_message", "2026-03-28T16:00:00Z"), part(2, "teammate_reply", "2026-03-29T09:00:00Z")], at("2026-03-28T16:00:00Z"), london);
  assert.equal(f.firstResponseMs, 17 * 3_600_000);
  assert.equal(f.firstResponseBusinessMs, 2 * 3_600_000);
  // A reply on the change night itself, outside hours: no office time passes overnight.
  f = conversationFacts([part(1, "customer_message", "2026-10-24T16:30:00Z"), part(2, "teammate_reply", "2026-10-25T08:59:00Z")], at("2026-10-24T16:30:00Z"), london);
  assert.equal(f.firstResponseBusinessMs, 0, "17:30 BST to 08:59 GMT: all outside hours");
  // No calendar: always open, so office hours equal wall-clock.
  f = conversationFacts([part(1, "customer_message", "2026-10-24T15:00:00Z"), part(2, "teammate_reply", "2026-10-25T10:00:00Z")], at("2026-10-24T15:00:00Z"), null);
  assert.equal(f.firstResponseBusinessMs, f.firstResponseMs);
});

test("conversation facts: only teammates' replies are responses; closes, reopens, assignments, Zoe and the latest rating", () => {
  const f = conversationFacts(
    [
      part(1, "state_change", "2026-10-01T09:00:00Z", { data: { from: null, to: "open" } }),
      part(2, "customer_message", "2026-10-01T09:00:00Z"),
      part(3, "ai_reply", "2026-10-01T09:00:05Z"),
      part(4, "workflow_message", "2026-10-01T09:00:06Z"),
      part(5, "ai_reply", "2026-10-01T09:01:00Z", { data: { handover: true } }),
      part(6, "teammate_reply", "2026-10-01T09:05:00Z", { audience: "internal" }),
      part(7, "teammate_reply", "2026-10-01T09:06:00Z", { data: { deleted: true } }),
      part(8, "assignment_change", "2026-10-01T09:07:00Z", { data: { after: { teammate: "ada" } } }),
      part(9, "teammate_reply", "2026-10-01T09:10:00Z"),
      part(10, "state_change", "2026-10-01T10:00:00Z", { data: { from: "open", to: "closed" } }),
      part(11, "rating", "2026-10-01T10:01:00Z", { data: { value: 2 } }),
      part(12, "customer_message", "2026-10-02T09:00:00Z"),
      part(13, "state_change", "2026-10-02T09:00:00Z", { data: { from: "closed", to: "open" } }),
      part(14, "state_change", "2026-10-02T09:30:00Z", { data: { from: "open", to: "closed" } }),
      part(15, "rating", "2026-10-02T09:31:00Z", { data: { value: 5 } }),
    ],
    at("2026-10-01T09:00:00Z"),
    null,
  );
  assert.deepEqual(
    { ...f, firstCustomerAt: f.firstCustomerAt?.toISOString(), firstResponseAt: f.firstResponseAt?.toISOString(), firstClosedAt: f.firstClosedAt?.toISOString(), lastClosedAt: f.lastClosedAt?.toISOString(), firstAiAt: f.firstAiAt?.toISOString(), ratedAt: f.ratedAt?.toISOString() },
    {
      firstCustomerAt: "2026-10-01T09:00:00.000Z",
      firstResponseAt: "2026-10-01T09:10:00.000Z",
      firstResponseMs: 600_000,
      firstResponseBusinessMs: 600_000,
      firstClosedAt: "2026-10-01T10:00:00.000Z",
      timeToCloseMs: 3_600_000,
      timeToCloseBusinessMs: 3_600_000,
      customerMessages: 2,
      teammateReplies: 1,
      aiReplies: 2,
      workflowMessages: 1,
      closes: 2,
      reopens: 1,
      assignments: 1,
      aiInvolved: true,
      aiHandedOver: true,
      rating: 5,
      lastClosedAt: "2026-10-02T09:30:00.000Z",
      repliesBeforeFirstClose: 1,
      reopenedWithin7d: true,
      firstAiAt: "2026-10-01T09:00:05.000Z",
      ratedAt: "2026-10-02T09:31:00.000Z",
    },
  );
});
