import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { calendarVersion, resolveCalendar } from "../server/calendars";
import { computeResponseMetrics } from "../server/business-time";

const weekdays = (from: string, to: string) =>
  Object.fromEntries(["1", "2", "3", "4", "5"].map((d) => [d, [[from, to]]]));

test("calendars: versioned publishing, pinned versions across a timezone change, team > brand > workspace > 24/7", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const agent = async (
    path: string,
    data?: unknown,
    principal = "owner-a",
    workspace = "a",
  ) => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      principal,
      {
        RELAY_AGENT_INBOX_V1: "true",
        RELAY_STORAGE_AUTHORITY: "postgres",
        RELAY_API_ORIGIN: "https://relay.test",
        RELAY_WORKSPACE_ID: workspace,
        RELAY_BRIDGE_SECRET: env.bridgeSecret,
      },
      (r) => handleApi(r, env),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const sql = async <T = any>(query: string, values: unknown[] = [], w = "a") =>
    tenant(db.connect, w, async (q) => (await q.query<T>(query, values)).rows);
  const code = (r: { body: any }) => r.body.error?.code;
  const start = (w: string, key: string) =>
    tenant(db.connect, w, async (q) => {
      const identity = await getIdentity(q, w, "anonymous", "calendar-" + key);
      return (
        (await command(
          q,
          w,
          {
            type: "contact",
            identityId: identity.identityId,
            brandId: "default",
          },
          "calendar-" + key,
          { action: "start", text: "Question " + key },
        )) as { conversationId: string }
      ).conversationId;
    });
  const resolve = (teamId: string | null) =>
    tenant(db.connect, "a", async (q) => {
      const r = await resolveCalendar(q, "a", { teamId, brandId: "default" });
      return [r.source, r.calendarId, r.version];
    });
  try {
    for (const w of ["a", "b"])
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, {
          origins: ["https://shop.test"],
          master: env.identityMaster,
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        }),
      );
    await sql(
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','ada','ada-a','Ada','agent')",
    );
    await sql(
      "INSERT INTO teams(workspace_id,id,name) VALUES('a','night','Night shift')",
    );

    // The seeded brand points at its office hours through the older brand setting; this test
    // starts from a brand without one.
    await sql(
      "UPDATE brands SET settings=settings-'calendarId'-'calendarVersion' WHERE id='default'",
    );
    // Off by default.
    assert.equal(code(await agent("calendars")), "SLA_DISABLED");
    for (const w of ["a", "b"])
      await sql(
        "UPDATE workspace_features SET enabled=true WHERE name='sla_v1'",
        [],
        w,
      );

    // Publishing needs workspace.manage and a valid definition; nothing is stored otherwise.
    const office = {
      name: "London office",
      timezone: "Europe/London",
      weekly: weekdays("09:00", "17:00"),
    };
    assert.equal(
      (await agent("calendars", { op: "publish", ...office }, "ada-a")).status,
      403,
    );
    assert.equal(
      code(await agent("calendars", { op: "publish", ...office, weekly: {} })),
      "INVALID_CALENDAR",
    );
    assert.deepEqual(
      (await sql("SELECT id FROM calendars ORDER BY id")).map((r) => r.id),
      ["default"],
      "only the seeded office hours",
    );
    const v1 = await agent("calendars", {
      op: "publish",
      ...office,
      holidays: ["2026-12-25"],
    });
    assert.deepEqual(v1.body, { id: "london-office", version: 1 });
    // Nothing assigned: open 24/7.
    assert.deepEqual(await resolve(null), ["default", null, null]);

    // Workspace default: a conversation started now pins version 1.
    assert.equal(
      (
        await agent("calendars", {
          op: "assign",
          scope: "workspace",
          calendarId: "london-office",
        })
      ).status,
      200,
    );
    const before = await start("a", "before");
    assert.deepEqual(
      await sql(
        "SELECT calendar_id,calendar_version FROM conversations WHERE id=$1",
        [before],
      ),
      [{ calendar_id: "london-office", calendar_version: 1 }],
    );

    // The office moves to New York: version 2. Editing from a stale version is refused.
    const moved = {
      ...office,
      id: "london-office",
      timezone: "America/New_York",
    };
    assert.equal(
      code(await agent("calendars", { op: "publish", ...moved, version: 5 })),
      "CALENDAR_CONFLICT",
    );
    assert.deepEqual(
      (await agent("calendars", { op: "publish", ...moved, version: 1 })).body,
      {
        id: "london-office",
        version: 2,
      },
    );
    const after = await start("a", "after");
    const listed = (await agent("calendars", undefined, "ada-a")).body;
    assert.deepEqual(
      listed.calendars.map((c: any) => [c.id, c.version, c.calendar.timezone]),
      [
        ["london-office", 2, "America/New_York"],
        ["default", 1, "UTC"],
      ],
    );
    assert.equal(listed.canManage, false);
    // The earlier conversation keeps version 1; the new one pins version 2.
    const pins = await sql(
      "SELECT id,calendar_version FROM conversations WHERE id=ANY($1::text[])",
      [[before, after]],
    );
    assert.equal(pins.find((r) => r.id === before).calendar_version, 1);
    assert.equal(pins.find((r) => r.id === after).calendar_version, 2);
    const resolved = (
      await agent(
        "calendar-resolve?" + new URLSearchParams({ conversation: before }),
      )
    ).body;
    assert.deepEqual(
      [resolved.current.version, resolved.pinned],
      [2, { calendarId: "london-office", version: 1 }],
    );
    const [old] = await tenant(db.connect, "a", async (q) => [
      await calendarVersion(q, "a", "london-office", 1),
    ]);
    assert.equal(old?.timezone, "Europe/London");
    assert.deepEqual(old?.holidays, ["2026-12-25"]);

    // Metrics use each conversation's pinned version: the same four wall-clock hours from 13:00Z
    // on a Monday are 4 business hours in London and 0 before New York opens (14:00Z).
    for (const id of [before, after])
      await sql(
        "UPDATE conversations SET created_at='2026-01-12T09:00:00Z',first_response_ms=$2 WHERE id=$1",
        [id, 4 * 3_600_000],
      );
    const metric = async (id: string) =>
      (
        (await computeResponseMetrics(db.connect, {
          workspace_id: "a",
          payload: { conversationId: id },
        } as never)) as { result: { businessMs: number } }
      ).result.businessMs;
    assert.equal(await metric(before), 4 * 3_600_000);
    assert.equal(await metric(after), 0);

    // Resolution order: team, then brand, then workspace, then 24/7.
    await agent("calendars", {
      op: "publish",
      name: "Nights",
      timezone: "UTC",
      weekly: weekdays("22:00", "06:00"),
    });
    await agent("calendars", {
      op: "publish",
      name: "Brand hours",
      timezone: "Europe/Paris",
      weekly: weekdays("08:00", "18:00"),
    });
    assert.equal(
      (
        await agent("calendars", {
          op: "assign",
          scope: "team",
          scopeId: "night",
          calendarId: "nights",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await agent("calendars", {
          op: "assign",
          scope: "brand",
          scopeId: "default",
          calendarId: "brand-hours",
        })
      ).status,
      200,
    );
    assert.deepEqual(await resolve("night"), ["team", "nights", 1]);
    assert.deepEqual(await resolve(null), ["brand", "brand-hours", 1]);
    assert.deepEqual(
      await resolve("other"),
      ["brand", "brand-hours", 1],
      "a team without a calendar falls through",
    );
    await agent("calendars", {
      op: "assign",
      scope: "brand",
      scopeId: "default",
      calendarId: null,
    });
    assert.deepEqual(await resolve(null), ["workspace", "london-office", 2]);
    // The older brand setting still applies when a brand has no assignment.
    await sql(
      'UPDATE brands SET settings=settings||\'{"calendarId":"london-office","calendarVersion":1}\' WHERE id=\'default\'',
    );
    assert.deepEqual(await resolve(null), [
      "brand_settings",
      "london-office",
      1,
    ]);
    await sql(
      "UPDATE brands SET settings=settings-'calendarId'-'calendarVersion' WHERE id='default'",
    );
    await agent("calendars", {
      op: "assign",
      scope: "workspace",
      calendarId: null,
    });
    assert.deepEqual(await resolve(null), ["default", null, null]);

    // Assignments are checked.
    assert.equal(
      code(
        await agent("calendars", {
          op: "assign",
          scope: "team",
          scopeId: "missing",
          calendarId: "nights",
        }),
      ),
      "INVALID_ASSIGNMENT",
    );
    assert.equal(
      code(
        await agent("calendars", {
          op: "assign",
          scope: "team",
          scopeId: "night",
          calendarId: "missing",
        }),
      ),
      "CALENDAR_NOT_FOUND",
    );
    assert.equal(
      code(
        await agent("calendars", {
          op: "assign",
          scope: "galaxy",
          calendarId: "nights",
        }),
      ),
      "INVALID_ASSIGNMENT",
    );

    // Other workspaces see and touch none of it (b has only its own seeded office hours).
    assert.deepEqual(
      (await agent("calendars", undefined, "owner-b", "b")).body.calendars.map(
        (c: any) => c.id,
      ),
      ["default"],
    );
    assert.equal(
      code(
        await agent(
          "calendars",
          { op: "assign", scope: "workspace", calendarId: "london-office" },
          "owner-b",
          "b",
        ),
      ),
      "CALENDAR_NOT_FOUND",
    );
    assert.equal(
      (
        await agent(
          "calendar-resolve?" + new URLSearchParams({ conversation: before }),
          undefined,
          "owner-b",
          "b",
        )
      ).status,
      404,
    );
    assert.equal(
      code(
        await agent(
          "calendars",
          { op: "publish", ...moved, version: 2 },
          "owner-b",
          "b",
        ),
      ),
      "CALENDAR_NOT_FOUND",
    );
  } finally {
    await db.close();
  }
});
