import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";

/** Settings › Helpdesk (S2a; docs/SETTINGS_STEP2.md): who sees the pages, idempotent saves. */
test("helpdesk settings: pages follow permission and features; team, limit, calendar and SLA saves are idempotent; edits made elsewhere are refused; lists carry what the pages need", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const send = (r: Request) => handleApi(r, env);
  const agent = async (
    path: string,
    data?: unknown,
    principal = "owner-a",
    workspace = "a",
    key: string = crypto.randomUUID(),
  ) => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
          "idempotency-key": key,
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
      send,
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, {
          origins: ["https://shop.test"],
          master: env.identityMaster,
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        }),
      );
      await sql(
        w,
        "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES($1,'agent-1','agent-1-'||$1,'Agent one','agent')",
        [w],
      );
      await sql(
        w,
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name='settings_v1'",
        [w],
      );
    }
    const pages = async (principal = "owner-a") =>
      (await agent("settings?section=overview", undefined, principal)).body
        .pages as string[];
    const helpdesk = (ps: string[]) =>
      ps.filter((p) => ["teams", "office-hours", "slas"].includes(p));
    // Each page needs its feature, and workspace management.
    assert.deepEqual(helpdesk(await pages()), []);
    await sql(
      "a",
      "UPDATE workspace_features SET enabled=true WHERE workspace_id='a' AND name IN ('routing_v1','sla_v1')",
    );
    assert.deepEqual(helpdesk(await pages()), [
      "teams",
      "office-hours",
      "slas",
    ]);
    assert.deepEqual(helpdesk(await pages("agent-1-a")), []);

    // A team saved twice with the same key is created once, and answers the same.
    const key = crypto.randomUUID();
    const team = {
      name: "Escalations",
      method: "balanced",
      members: ["agent-1"],
      conversationLimit: 5,
    };
    const first = await agent("teams", team, "owner-a", "a", key);
    assert.equal(first.status, 200);
    assert.deepEqual(
      (await agent("teams", team, "owner-a", "a", key)).body,
      first.body,
    );
    assert.equal(
      (
        await sql(
          "a",
          "SELECT count(*)::int AS n FROM teams WHERE name='Escalations'",
        )
      )[0].n,
      1,
    );
    // Managers get every teammate's own limits with the list; agents don't.
    const listed = (await agent("teams")).body;
    assert.deepEqual(
      listed.teammates.map((t: any) => t.name),
      ["Agent one", "Support teammate"],
    );
    assert.equal(
      (await agent("teams", undefined, "agent-1-a")).body.teammates,
      undefined,
    );
    // Teammate limits, idempotent too.
    const limitKey = crypto.randomUUID();
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await agent(
            "teammate-limits",
            { teammateId: "agent-1", conversationLimit: 4, ticketLimit: null },
            "owner-a",
            "a",
            limitKey,
          )
        ).status,
        200,
      );
    assert.equal(
      (
        await sql(
          "a",
          "SELECT conversation_limit FROM teammates WHERE id='agent-1'",
        )
      )[0].conversation_limit,
      4,
    );
    // An edit from a stale version is refused, not applied.
    const saved = listed.teams.find((t: any) => t.name === "Escalations");
    await sql("a", "UPDATE teams SET version=version+1 WHERE id=$1", [
      saved.id,
    ]);
    const stale = await agent("teams", {
      ...team,
      id: saved.id,
      version: saved.version,
      name: "Renamed",
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "TEAM_CONFLICT");

    // Calendars: published once per key; the list names what they can be assigned to.
    const calendar = {
      name: "Weekend cover",
      timezone: "Europe/London",
      weekly: { "0": [["10:00", "14:00"]], "6": [["10:00", "14:00"]] },
      holidays: ["2026-12-25"],
    };
    const calKey = crypto.randomUUID();
    const published = await agent(
      "calendars",
      calendar,
      "owner-a",
      "a",
      calKey,
    );
    assert.equal(published.status, 200);
    assert.deepEqual(
      (await agent("calendars", calendar, "owner-a", "a", calKey)).body,
      published.body,
    );
    const calendars = (await agent("calendars")).body;
    assert.equal(
      calendars.calendars.filter((c: any) => c.name === "Weekend cover").length,
      1,
    );
    assert.deepEqual(
      calendars.teams.map((t: any) => t.name),
      ["Escalations"],
    );
    assert.deepEqual(
      calendars.brands.map((b: any) => b.id),
      ["default"],
    );
    assert.equal(
      (
        await agent("calendars", {
          op: "assign",
          scope: "team",
          scopeId: saved.id,
          calendarId: published.body.id,
        })
      ).status,
      200,
    );
    // A calendar with no open hours is refused.
    assert.equal(
      (await agent("calendars", { ...calendar, name: "Never", weekly: {} }))
        .status,
      400,
    );

    // SLA policies: created once per key.
    const policy = {
      name: "Priority",
      position: 0,
      conditions: { field: "priority", op: "eq", value: true },
      targets: { first_response: 15 * 60_000 },
      hours: "always",
      pause: { snoozed: true, waiting_on_customer: true },
      enabled: true,
    };
    const slaKey = crypto.randomUUID();
    const created = await agent("sla-policies", policy, "owner-a", "a", slaKey);
    assert.equal(created.status, 200);
    assert.equal(
      (await agent("sla-policies", policy, "owner-a", "a", slaKey)).body.id,
      created.body.id,
    );
    assert.equal(
      (
        await sql(
          "a",
          "SELECT count(*)::int AS n FROM sla_policies WHERE name='Priority'",
        )
      )[0].n,
      1,
    );
    // Agents can't change any of it.
    for (const [path, body] of [
      ["teams", team],
      ["calendars", calendar],
      ["sla-policies", policy],
    ] as const)
      assert.equal((await agent(path, body, "agent-1-a")).status, 403);

    // Kept to the workspace: B has none of A's teams, calendars or policies.
    assert.equal(
      (await sql("b", "SELECT count(*)::int AS n FROM teams"))[0].n,
      0,
    );
    assert.equal(
      (
        await sql(
          "b",
          "SELECT count(*)::int AS n FROM sla_policies WHERE name='Priority'",
        )
      )[0].n,
      0,
    );
    assert.equal((await agent("teams", undefined, "owner-a", "b")).status, 403);
  } finally {
    await db.close();
  }
});
