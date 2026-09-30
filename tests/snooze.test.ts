import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation, getIdentity } from "../server/people";
import {
  command,
  conversation,
  wakeConversation,
  type Actor,
} from "../server/conversations";
import { resolveWake } from "../server/snooze";

const at = (iso: string) => Date.parse(iso);
const wake = (preset: string, timezone: string, now: string) =>
  resolveWake({ preset, timezone }, at(now)).wakeAt.toISOString();

test("snooze presets resolve to local wall-clock times, across daylight-saving changes", () => {
  // London leaves BST (UTC+1) at 01:00 UTC on Sunday 25 October 2026.
  assert.equal(
    wake("tomorrow", "Europe/London", "2026-10-23T20:00:00Z"),
    "2026-10-24T08:00:00.000Z",
    "09:00 BST",
  );
  assert.equal(
    wake("tomorrow", "Europe/London", "2026-10-24T20:00:00Z"),
    "2026-10-25T09:00:00.000Z",
    "09:00 GMT, on the day the clocks change",
  );
  // New York leaves EDT (UTC-4) on Sunday 1 November 2026.
  assert.equal(
    wake("tomorrow", "America/New_York", "2026-10-31T12:00:00Z"),
    "2026-11-01T14:00:00.000Z",
    "09:00 EST",
  );
  // Kolkata is UTC+5:30 all year; 20:00 UTC is already the next local day.
  assert.equal(
    wake("tomorrow", "Asia/Kolkata", "2026-09-30T20:00:00Z"),
    "2026-10-02T03:30:00.000Z",
  );
  // Next week is the coming Monday at 09:00 local; on a Monday it is a week later.
  assert.equal(
    wake("next_week", "Europe/London", "2026-09-30T10:00:00Z"),
    "2026-10-05T08:00:00.000Z",
  );
  assert.equal(
    wake("next_week", "Europe/London", "2026-10-05T10:00:00Z"),
    "2026-10-12T08:00:00.000Z",
  );
  assert.equal(
    wake("next_week", "Pacific/Auckland", "2026-10-04T12:00:00Z"),
    "2026-10-11T20:00:00.000Z",
    "Auckland's Monday 5 October has begun at 01:00 NZDT, so the next Monday is the 12th",
  );
  assert.equal(
    wake("later_today", "Asia/Tokyo", "2026-09-30T10:00:00Z"),
    "2026-09-30T13:00:00.000Z",
  );
  for (const [input, code] of [
    [{ preset: "someday", timezone: "UTC" }, "INVALID_WAKE_TIME"],
    [{ preset: "tomorrow" }, "TIMEZONE_INVALID"],
    [{ preset: "tomorrow", timezone: "Mars/Olympus" }, "TIMEZONE_INVALID"],
    [{ wakeAt: "2030-01-01T09:00:00" }, "INVALID_WAKE_TIME"],
    [{ wakeAt: "2020-01-01T09:00:00Z" }, "INVALID_WAKE_TIME"],
  ] as const)
    assert.throws(() => resolveWake(input), { code });
  assert.equal(
    resolveWake({ wakeAt: "2030-01-01T09:00:00+01:00" }).wakeAt.toISOString(),
    "2030-01-01T08:00:00.000Z",
  );
});

test("unassign-on-wake applies only to the current snooze and resets on any transition", async () => {
  const db = await testDatabase();
  const owner: Actor = { type: "teammate", principal: "owner-a" };
  const run = (p: Parameters<typeof command>[4], w = "a", actor = owner) =>
    tenant(db.connect, w, (q) => command(q, w, actor, crypto.randomUUID(), p));
  const row = (id: string) =>
    tenant(db.connect, "a", (q) => conversation(q, "a", id));
  const expire = (id: string) =>
    tenant(db.connect, "a", (q) =>
      q.query(
        "UPDATE conversations SET snooze_until=now()-interval '1 second' WHERE workspace_id='a' AND id=$1",
        [id],
      ),
    );
  const wakeNow = async (id: string, version: string) =>
    tenant(db.connect, "a", (q) => wakeConversation(q, "a", id, version));
  const parts = (id: string, kind: string) =>
    tenant(
      db.connect,
      "a",
      async (q) =>
        (
          await q.query<{ data: Record<string, unknown> }>(
            "SELECT data FROM conversation_parts WHERE workspace_id='a' AND conversation_id=$1 AND kind=$2 ORDER BY seq",
            [id, kind],
          )
        ).rows,
    );
  try {
    for (const w of ["a", "b"])
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, {
          origins: [],
          master: "m".repeat(40),
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        }),
      );
    const start = async (label: string) =>
      tenant(db.connect, "a", async (q) => {
        const identity = await getIdentity(q, "a", "anonymous", label);
        return (
          (await command(
            q,
            "a",
            {
              type: "contact",
              identityId: identity.identityId,
              brandId: "default",
            },
            label,
            { action: "start", text: label },
          )) as { conversationId: string }
        ).conversationId;
      });
    const id = await start("snooze-unassign");
    await run({ action: "assign", conversationId: id, teammateId: "owner" });

    // Preset snooze with unassign-on-wake records its resolution on the state change part.
    await run({
      action: "snooze",
      conversationId: id,
      preset: "tomorrow",
      timezone: "Europe/London",
      unassignOnWake: true,
    });
    let c = await row(id);
    assert.equal(c.status, "snoozed");
    assert.equal(c.snooze_unassign, true);
    assert.equal(c.snooze_timezone, "Europe/London");
    const snoozed = (await parts(id, "state_change")).at(-1)!.data;
    assert.equal(snoozed.preset, "tomorrow");
    assert.equal(snoozed.timezone, "Europe/London");
    assert.equal(snoozed.unassignOnWake, true);
    assert.equal(
      new Date(snoozed.until as string).getTime(),
      new Date(c.snooze_until as string).getTime(),
    );

    // Replacing the snooze without the option: the old timer is stale and cannot unassign.
    const staleVersion = c.snooze_version;
    await run({
      action: "snooze",
      conversationId: id,
      preset: "later_today",
      timezone: "Europe/London",
    });
    await expire(id);
    assert.deepEqual(await wakeNow(id, staleVersion), { woke: false });
    c = await row(id);
    assert.equal(c.snooze_unassign, false);
    assert.deepEqual(await wakeNow(id, c.snooze_version), { woke: true });
    c = await row(id);
    assert.equal(c.status, "open");
    assert.equal(
      c.assigned,
      "owner",
      "the replacement snooze keeps the assignee",
    );

    // The current snooze with the option unassigns on wake, with an explained assignment part.
    await run({
      action: "snooze",
      conversationId: id,
      preset: "later_today",
      timezone: "UTC",
      unassignOnWake: true,
    });
    await expire(id);
    assert.deepEqual(await wakeNow(id, (await row(id)).snooze_version), {
      woke: true,
    });
    c = await row(id);
    assert.equal(c.assigned, "");
    assert.equal(c.snooze_unassign, false);
    const unassigned = (await parts(id, "assignment_change")).at(-1)!.data;
    assert.equal(unassigned.reason, "snooze_wake");
    assert.deepEqual(unassigned.before, { teammate: "owner", team: null });

    // A manual reopen clears the option, so a later wake cannot act on it.
    await run({ action: "assign", conversationId: id, teammateId: "owner" });
    await run({
      action: "snooze",
      conversationId: id,
      preset: "tomorrow",
      timezone: "UTC",
      unassignOnWake: true,
    });
    const reopenedFrom = (await row(id)).snooze_version;
    await run({ action: "reopen", conversationId: id });
    c = await row(id);
    assert.equal(c.snooze_unassign, false);
    assert.equal(c.snooze_timezone, null);
    assert.deepEqual(await wakeNow(id, reopenedFrom), { woke: false });
    assert.equal((await row(id)).assigned, "owner");

    // Invalid input and other workspaces are rejected.
    await assert.rejects(
      run({ action: "snooze", conversationId: id, preset: "tomorrow" }),
      { code: "TIMEZONE_INVALID" },
    );
    await assert.rejects(
      run({
        action: "snooze",
        conversationId: id,
        preset: "tomorrow",
        timezone: "UTC",
        unassignOnWake: "yes" as never,
      }),
      { code: "INVALID_SNOOZE" },
    );
    await assert.rejects(
      run(
        {
          action: "snooze",
          conversationId: id,
          preset: "tomorrow",
          timezone: "UTC",
        },
        "b",
        { type: "teammate", principal: "owner-b" },
      ),
      { code: "CONVERSATION_NOT_FOUND" },
    );
  } finally {
    await db.close();
  }
});
