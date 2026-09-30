import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { drainTeam, RAMP } from "../server/routing";

test("away mode, reply hand-off, paced return, next conversation and workload", async () => {
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
  const identities: Record<string, string> = {};
  let n = 0;
  /** A customer starts a conversation; it is put in the team inbox (and routed). */
  const arrive = async (teamId: string, priority = false) => {
    const key = `away-test-${++n}`;
    const id = await tenant(db.connect, "a", async (q) => {
      const identity = await getIdentity(q, "a", "anonymous", key);
      const { conversationId } = (await command(
        q,
        "a",
        {
          type: "contact",
          identityId: identity.identityId,
          brandId: "default",
        },
        key,
        { action: "start", text: "Help " + key },
      )) as { conversationId: string };
      identities[conversationId] = identity.identityId;
      if (priority)
        await command(
          q,
          "a",
          { type: "teammate", principal: "owner-a" },
          key + "-p",
          { action: "priority", conversationId, value: true },
        );
      await command(
        q,
        "a",
        { type: "teammate", principal: "owner-a" },
        key + "-t",
        { action: "assign", conversationId, teamId },
      );
      return conversationId;
    });
    return id;
  };
  const holder = async (id: string) =>
    (await sql("SELECT assigned FROM conversations WHERE id=$1", [id]))[0]
      .assigned;
  const holders = async (ids: string[]) => Promise.all(ids.map(holder));
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
    for (const w of ["a", "b"])
      await sql(
        "UPDATE workspace_features SET enabled=true WHERE name IN ('routing_v1','agent_inbox_views_v1')",
        [],
        w,
      );
    await sql(
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id,conversation_limit) VALUES('a','ada','ada-a','Ada','agent',2),('a','bo','bo-a','Bo','agent',2),('a','cy','cy-a','Cy','agent',2)",
    );
    const team = await agent("teams", {
      name: "Support",
      method: "balanced",
      members: ["ada", "bo", "cy"],
      unassignOnAway: true,
    });
    assert.equal(team.status, 200, JSON.stringify(team.body));
    const support = team.body.id;
    // The team's inbox is a shared view, renamed with the team.
    let listed = (await agent("teams")).body.teams[0];
    assert.equal(listed.unassignOnAway, true);
    const views = async () =>
      (
        await sql("SELECT name,shared FROM inbox_views WHERE id=$1", [
          listed.viewId,
        ])
      )[0];
    assert.deepEqual(await views(), {
      name: "Team inbox: Support",
      shared: true,
    });
    await agent("teams", {
      id: support,
      version: listed.version,
      name: "Customer support",
      method: "balanced",
    });
    assert.equal((await views()).name, "Team inbox: Customer support");

    // Six arrivals: two each.
    const first = [];
    for (let i = 0; i < 6; i++) first.push(await arrive(support));
    assert.deepEqual((await holders(first)).sort(), [
      "ada",
      "ada",
      "bo",
      "bo",
      "cy",
      "cy",
    ]);

    // Presence: your own, or anyone's with teammates.manage.
    assert.equal(
      (await agent("presence", { presence: "away", teammateId: "bo" }, "ada-a"))
        .status,
      403,
    );
    assert.equal(
      code(await agent("presence", { presence: "napping" }, "ada-a")),
      "INVALID_PRESENCE",
    );
    // Ada goes away: the team returns her open conversations to its inbox. Everyone else is full,
    // so they wait there.
    const adas = first.filter((_, i) => i < 6);
    const away = await agent("presence", { presence: "away" }, "ada-a");
    assert.equal(away.status, 200, JSON.stringify(away.body));
    assert.equal(away.body.returned, 2);
    const released: string[] = [];
    for (const id of adas) if ((await holder(id)) === "") released.push(id);
    assert.equal(released.length, 2);
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversation_parts WHERE kind='assignment_change' AND data->>'reason'='away'",
        )
      )[0].n,
      2,
    );

    // Away and reassign replies: a customer's reply hands Bo's conversation on; his own notes do not.
    // (This team returns conversations on away; turn that off to see replies handed on one by one.)
    await sql("UPDATE teams SET unassign_on_away=false WHERE id=$1", [support]);
    await agent("presence", { presence: "away_reassigning", teammateId: "bo" });
    const bos: string[] = [];
    for (const id of first) if ((await holder(id)) === "bo") bos.push(id);
    await tenant(db.connect, "a", (q) =>
      command(
        q,
        "a",
        { type: "teammate", principal: "bo-a" },
        "bo-note-checking",
        {
          action: "note",
          conversationId: bos[0],
          text: "Checking",
        },
      ),
    );
    assert.equal(await holder(bos[0]), "bo");
    await tenant(db.connect, "a", (q) =>
      command(
        q,
        "a",
        { type: "contact", identityId: identities[bos[0]], brandId: "default" },
        "customer-follow-up",
        {
          action: "reply",
          conversationId: bos[0],
          text: "Hello? Anyone there?",
        },
      ),
    );
    assert.equal(
      await holder(bos[0]),
      "",
      "handed back to the inbox (Cy is full, Ada and Bo are away)",
    );
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversation_parts WHERE conversation_id=$1 AND data->>'reason'='away_reassign'",
          [bos[0]],
        )
      )[0].n,
      1,
    );

    // Paced return: Ada comes back with room for 10, but takes at most 3 per 5 minutes for 30 minutes.
    await agent("teammate-limits", {
      teammateId: "ada",
      conversationLimit: 10,
    });
    for (let i = 0; i < 4; i++) await arrive(support);
    const back = await agent("presence", { presence: "active" }, "ada-a");
    assert.equal(back.body.assigned, RAMP.perWindow, "three on return");
    const queued = async () =>
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversations WHERE team_id=$1 AND assigned='' AND status='open'",
          [support],
        )
      )[0].n;
    const waiting = await queued();
    assert(waiting >= 4, "the rest wait rather than landing on Ada");
    const now = Date.now();
    assert.equal(
      (
        await tenant(db.connect, "a", (q) =>
          drainTeam(q, "a", support, 50, now),
        )
      ).length,
      0,
      "still paced",
    );
    const later = await tenant(db.connect, "a", (q) =>
      drainTeam(q, "a", support, 50, now + RAMP.windowMs + 60_000),
    );
    assert.equal(later.length, RAMP.perWindow, "three more in the next window");
    const after = await tenant(db.connect, "a", (q) =>
      drainTeam(q, "a", support, 50, now + RAMP.durationMs + 60_000),
    );
    assert.equal(
      after.length,
      waiting - RAMP.perWindow,
      "no pacing after 30 minutes",
    );
    assert.equal(await queued(), 0);

    // Next conversation: within your limit, priority first, balanced inboxes only.
    await agent("presence", { presence: "active", teammateId: "bo" });
    await sql("UPDATE teams SET method='manual' WHERE id=$1", [support]);
    const normal = await arrive(support),
      urgent = await arrive(support, true);
    const sales = (
      await agent("teams", { name: "Sales", method: "manual", members: ["cy"] })
    ).body.id;
    await arrive(sales);
    assert.equal(code(await agent("next", {}, "cy-a")), "NEXT_AT_LIMIT");
    assert.equal(
      (await agent("next", {}, "cy-a")).body.error.message,
      "You're at your limit (2 of 2). Close or snooze something first.",
    );
    assert.equal(
      code(await agent("next", {}, "ada-a")),
      "NEXT_NONE",
      "manual inboxes are not pulled from",
    );
    await sql("UPDATE teams SET method='balanced' WHERE id=$1", [support]);
    // Balanced: arrivals would be routed; these two are waiting because they arrived while manual.
    assert.deepEqual(await holders([normal, urgent]), ["", ""]);
    const pulled = await agent("next", {}, "ada-a");
    assert.equal(pulled.body.conversationId, urgent, "priority first");
    assert.equal(
      (await agent("next", {}, "ada-a")).body.conversationId,
      normal,
    );
    assert.equal(code(await agent("next", {}, "ada-a")), "NEXT_NONE");
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversation_parts WHERE conversation_id=$1 AND data->>'reason'='next'",
          [urgent],
        )
      )[0].n,
      1,
    );

    // Workload: your own used against limit, your teams, their members.
    const workload = (await agent("workload", undefined, "ada-a")).body;
    assert.equal(workload.presence, "active");
    assert.equal(workload.conversationLimit, 10);
    assert(workload.used.conversations >= 2);
    assert.deepEqual(
      workload.teams.map((t: any) => t.name),
      ["Customer support"],
      "only Ada's teams",
    );
    assert.deepEqual(
      workload.teams[0].members.map((m: any) => [m.name, m.conversationLimit]),
      [
        ["Ada", 10],
        ["Bo", 2],
        ["Cy", 2],
      ],
    );

    // Other workspaces: no teams, no reach into ours.
    assert.deepEqual(
      (await agent("workload", undefined, "owner-b", "b")).body.teams,
      [],
    );
    assert.equal(
      (
        await agent(
          "presence",
          { presence: "away", teammateId: "ada" },
          "owner-b",
          "b",
        )
      ).status,
      404,
    );
  } finally {
    await db.close();
  }
});
