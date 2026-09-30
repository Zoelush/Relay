import test from "node:test";
import type { Window as HoursWindow } from "../server/business-time";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { handleApi, type ApiEnvironment } from "../server/api";
import {
  availabilityFor,
  expectedReply,
  openNow,
} from "../server/office-hours";
import { publishCalendar, assignCalendar } from "../server/calendars";
import { command } from "../server/conversations";
import { queuePosition, routingPort } from "../server/routing";

const weekdays = (from: string, to: string): Record<string, HoursWindow[]> =>
  Object.fromEntries(
    ["1", "2", "3", "4", "5"].map((d) => [d, [[from, to] as HoursWindow]]),
  );
const at = (iso: string) => Date.parse(iso);

test("one office-hours source: availability from calendars (holidays, special days, teams), reply time, none without a calendar", async () => {
  // The helper everything downstream calls.
  const office = {
    timezone: "Europe/London",
    weekly: weekdays("09:00", "17:00"),
    holidays: ["2026-01-12"],
  };
  assert.deepEqual(openNow(office, at("2026-01-09T10:00:00Z")), {
    open: true,
    nextOpenAt: null,
  });
  assert.deepEqual(
    openNow(office, at("2026-01-12T10:00:00Z")),
    { open: false, nextOpenAt: at("2026-01-13T09:00:00Z") },
    "holiday",
  );
  assert.equal(
    openNow(
      { ...office, special: { "2026-01-10": [["10:00", "12:00"]] } },
      at("2026-01-10T11:00:00Z"),
    ).open,
    true,
    "special Saturday",
  );

  const db = await testDatabase();
  const sql = async <T = any>(query: string, values: unknown[] = [], w = "a") =>
    tenant(db.connect, w, async (q) => (await q.query<T>(query, values)).rows);
  try {
    for (const w of ["a", "b"])
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, {
          origins: ["https://shop.test"],
          master: "m".repeat(40),
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        }),
      );
    await sql(
      "UPDATE workspace_features SET enabled=true WHERE name IN ('sla_v1','routing_v1')",
    );
    const avail = (
      brandId: string,
      now: string,
      teamId?: string,
      locale = "en-GB",
    ) =>
      tenant(db.connect, "a", (q) =>
        availabilityFor(q, "a", { brandId, teamId }, locale, at(now)),
      );
    // The seeded brand still points at its seeded calendar (UTC, weekdays 09:00–17:00).
    assert.deepEqual(await avail("default", "2026-01-09T10:00:00Z"), {
      open: true,
    });
    // A published calendar with a holiday, assigned to the brand, wins over the old setting.
    await tenant(db.connect, "a", async (q) => {
      await publishCalendar(q, "a", "owner-a", { name: "London", ...office });
      await assignCalendar(q, "a", "owner-a", {
        scope: "brand",
        scopeId: "default",
        calendarId: "london",
      });
    });
    const holiday = await avail("default", "2026-01-12T10:00:00Z");
    assert.equal(holiday?.open, false);
    assert.equal(holiday?.nextOpenAt, "2026-01-13T09:00:00.000Z");
    assert.match(holiday!.nextOpenLabel!, /Tuesday.*09:00.*GMT/);
    // A team's own calendar applies inside its conversations.
    await sql(
      "INSERT INTO teams(workspace_id,id,name,method) VALUES('a','night','Night','balanced')",
    );
    await tenant(db.connect, "a", async (q) => {
      await publishCalendar(q, "a", "owner-a", {
        name: "Nights",
        timezone: "UTC",
        weekly: weekdays("22:00", "06:00"),
      });
      await assignCalendar(q, "a", "owner-a", {
        scope: "team",
        scopeId: "night",
        calendarId: "nights",
      });
    });
    assert.equal(
      (await avail("default", "2026-01-09T10:00:00Z", "night"))?.open,
      false,
    );
    assert.equal(
      (await avail("default", "2026-01-09T23:00:00Z", "night"))?.open,
      true,
    );
    // Arabic labels come from the same instant.
    assert.match(
      (await avail("default", "2026-01-12T10:00:00Z", undefined, "ar"))!
        .nextOpenLabel!,
      /الثلاثاء/,
    );
    // No calendar at all: no hours line (null), rather than claiming the team is always online.
    await sql("DELETE FROM calendar_assignments");
    await sql(
      "UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'",
    );
    assert.equal(await avail("default", "2026-01-09T10:00:00Z"), null);

    // Expected reply time: the brand's phrase until 20 recent measurements exist, then a band.
    const reply = (brand = "default", now = "2026-01-20T12:00:00Z") =>
      tenant(db.connect, "a", (q) => expectedReply(q, "a", brand, at(now)));
    assert.equal(await reply(), null);
    await sql(
      "UPDATE brands SET settings=settings||'{\"replyTime\":\"Usually within a day\"}' WHERE id='default'",
    );
    assert.deepEqual(await reply(), { text: "Usually within a day" });
    const insert = async (count: number, ms: number, created: string) => {
      for (let i = 0; i < count; i++)
        await sql(
          "INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,created_at,updated_at,first_response_business_ms) VALUES('a',$1,'default','','C','','t',$2,$2,$3)",
          [crypto.randomUUID(), created, ms],
        );
    };
    await insert(19, 30 * 60_000, "2026-01-15T10:00:00Z");
    assert.deepEqual(
      await reply(),
      { text: "Usually within a day" },
      "19 is not enough",
    );
    await insert(40, 2 * 60_000, "2025-12-01T10:00:00Z");
    assert.deepEqual(
      await reply(),
      { text: "Usually within a day" },
      "older than 14 days does not count",
    );
    await insert(1, 30 * 60_000, "2026-01-16T10:00:00Z");
    assert.deepEqual(
      await reply(),
      { band: "under_an_hour" },
      "median of 20 recent: 30 minutes",
    );
    await insert(25, 5 * 60_000, "2026-01-17T10:00:00Z");
    assert.deepEqual(await reply(), { band: "few_minutes" });

    // The messenger boot carries both, and the queue capability.
    const boot = (await (
      await handleApi(
        new Request("https://relay.test/v1/messenger/boot", {
          method: "POST",
          headers: {
            origin: "https://shop.test",
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            workspaceId: "a",
            brandId: "default",
            deviceToken: "office-device-".repeat(4),
            pageUrl: "https://shop.test",
          }),
        }),
        {
          connect: db.connect,
          sessionSecret: "s".repeat(40),
          identityMaster: "m".repeat(40),
          bridgeSecret: "b".repeat(40),
          storageTransport: "local-pglite",
        },
      )
    ).json()) as any;
    assert.equal(boot.availability, null, "no calendar applies");
    // The boot reads the real clock: January's measurements are older than 14 days, so the
    // brand's phrase is used.
    assert.deepEqual(boot.replyTime, { text: "Usually within a day" });
    assert.equal(boot.capabilities.queue, true);
  } finally {
    await db.close();
  }
});

test("queue position: routing's own order, live when the line moves, only for the waiting customer", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    storageTransport: "local-pglite",
  };
  const sql = async <T = any>(query: string, values: unknown[] = [], w = "a") =>
    tenant(db.connect, w, async (q) => (await q.query<T>(query, values)).rows);
  /** A messenger customer who starts a conversation, which is put in the Support inbox. */
  const customer = async (name: string, priority = false) => {
    const boot = (await (
      await handleApi(
        new Request("https://relay.test/v1/messenger/boot", {
          method: "POST",
          headers: {
            origin: "https://shop.test",
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            workspaceId: "a",
            brandId: "default",
            deviceToken: (name + "-device-").repeat(4),
            pageUrl: "https://shop.test",
          }),
        }),
        env,
      )
    ).json()) as any;
    const call = (path: string, body?: unknown) =>
      handleApi(
        new Request("https://relay.test/v1/messenger/" + path, {
          method: body ? "POST" : "GET",
          headers: {
            origin: "https://shop.test",
            authorization: "Bearer " + boot.token,
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        env,
      ).then(async (r) => ({
        status: r.status,
        body: (await r.json()) as any,
      }));
    const id = (
      await call("command", { action: "start", text: "Help from " + name })
    ).body.conversationId;
    await tenant(db.connect, "a", async (q) => {
      if (priority)
        await command(
          q,
          "a",
          { type: "teammate", principal: "owner-a" },
          "prio-" + name,
          { action: "priority", conversationId: id, value: true },
        );
      await command(
        q,
        "a",
        { type: "teammate", principal: "owner-a" },
        "team-" + name + "-x",
        { action: "assign", conversationId: id, teamId: "support" },
      );
    });
    const position = async () =>
      (await call("history?" + new URLSearchParams({ conversation: id }))).body
        .waiting?.queue?.position ?? null;
    return { id, call, position };
  };
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
      "UPDATE workspace_features SET enabled=true WHERE name='routing_v1'",
    );
    // Support is balanced, and its only member is away: everyone waits.
    await sql(
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id,presence) VALUES('a','ada','ada-a','Ada','agent','away')",
    );
    await sql(
      "INSERT INTO teams(workspace_id,id,name,method) VALUES('a','support','Support','balanced')",
    );
    await sql(
      "INSERT INTO teammate_teams(workspace_id,teammate_id,team_id) VALUES('a','ada','support')",
    );
    const jo = await customer("jo"),
      sam = await customer("sam"),
      kim = await customer("kim", true);
    // Routing's order: priority first, then longest waiting.
    assert.deepEqual(
      [await kim.position(), await jo.position(), await sam.position()],
      [1, 2, 3],
    );
    const viaPort = await routingPort(db.connect).queuePosition({
      workspaceId: "a",
      brandId: "default",
      conversationId: jo.id,
    });
    assert.equal(viaPort?.position, 2, "the phase 03 routing port");
    // Other customers cannot read someone else's place; other workspaces cannot either.
    assert.equal(
      (
        await jo.call(
          "history?" + new URLSearchParams({ conversation: sam.id }),
        )
      ).status,
      404,
    );
    assert.equal(
      await tenant(db.connect, "b", (q) => queuePosition(q, "b", jo.id)),
      null,
    );

    // The line moves: Ada returns with room for one and takes Kim. Those still waiting are
    // announced (so their messengers re-read) and move up.
    await sql("UPDATE teammates SET conversation_limit=1 WHERE id='ada'");
    await sql("DELETE FROM outbox WHERE payload ? 'queue'");
    const { setPresence } = await import("../server/routing");
    await tenant(db.connect, "a", (q) =>
      setPresence(q, "a", "ada-a", { presence: "active" }),
    );
    assert.equal(
      (await sql("SELECT assigned FROM conversations WHERE id=$1", [kim.id]))[0]
        .assigned,
      "ada",
    );
    assert.equal(await kim.position(), null, "assigned: no longer in line");
    assert.deepEqual([await jo.position(), await sam.position()], [1, 2]);
    assert.deepEqual(
      (
        await sql(
          "SELECT resource_id FROM outbox WHERE payload ? 'queue' ORDER BY resource_id",
        )
      )
        .map((r) => r.resource_id)
        .sort(),
      [jo.id, sam.id].sort(),
      "those still waiting were announced",
    );
    // A teammate taking one by hand moves the line too.
    await sql("DELETE FROM outbox WHERE payload ? 'queue'");
    await tenant(db.connect, "a", (q) =>
      command(
        q,
        "a",
        { type: "teammate", principal: "owner-a" },
        "take-jo-by-hand",
        {
          action: "assign",
          conversationId: jo.id,
          teamId: "support",
          teammateId: "owner",
        },
      ),
    );
    assert.equal(await sam.position(), 1);
    assert.deepEqual(
      (await sql("SELECT resource_id FROM outbox WHERE payload ? 'queue'")).map(
        (r) => r.resource_id,
      ),
      [sam.id],
    );

    // A brand can hide positions; manual inboxes have no line.
    await sql(
      "UPDATE brands SET settings=settings||'{\"showQueuePosition\":false}' WHERE id='default'",
    );
    assert.equal(await sam.position(), null);
    await sql(
      "UPDATE brands SET settings=settings-'showQueuePosition' WHERE id='default'",
    );
    await sql("UPDATE teams SET method='manual' WHERE id='support'");
    assert.equal(await sam.position(), null);
  } finally {
    await db.close();
  }
});
