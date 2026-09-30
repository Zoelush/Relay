import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import {
  assigneeFor,
  claim,
  decide,
  drainAll,
  drainForTeammate,
  drainTeam,
  type Member,
  type TeamState,
} from "../server/routing";

const member = (id: string, over: Partial<Member> = {}): Member => ({
  id,
  presence: "active",
  conversations: 0,
  tickets: 0,
  conversationLimit: null,
  ticketLimit: null,
  ...over,
});
const team = (over: Partial<TeamState> = {}): TeamState => ({
  id: "t",
  method: "balanced",
  conversationLimit: null,
  ticketLimit: null,
  ticketsCount: true,
  includeAway: false,
  cursor: null,
  conversations: 0,
  tickets: 0,
  members: [member("a"), member("b"), member("c")],
  ...over,
});
const conversation = { ticket: false };

test("decisions are pure: manual, round robin (rotation, away, ignores limits) and balanced (fewest, ties rotate, both limits, tickets)", () => {
  assert.deepEqual(decide(team({ method: "manual" }), conversation), {
    assignee: null,
    reason: "manual",
  });
  // Round robin: in order after the cursor, wrapping; skips away unless the team includes them.
  const rr = (
    cursor: string | null,
    members = team().members,
    includeAway = false,
  ) =>
    decide(
      team({ method: "round_robin", cursor, members, includeAway }),
      conversation,
    ).assignee;
  assert.deepEqual([rr(null), rr("a"), rr("b"), rr("c")], ["a", "b", "c", "a"]);
  const away = [member("a"), member("b", { presence: "away" }), member("c")];
  assert.equal(rr("a", away), "c");
  assert.equal(
    rr("a", away, true),
    "b",
    "the per-team toggle includes away teammates",
  );
  // Round robin does not respect limits.
  assert.equal(
    rr(null, [
      member("a", { conversations: 5, conversationLimit: 5 }),
      member("b"),
    ]),
    "a",
  );
  assert.equal(
    decide(
      team({
        method: "round_robin",
        members: [member("a", { presence: "away" })],
      }),
      conversation,
    ).reason,
    "no_one_available",
  );

  // Balanced: fewest active; ties go to the next in rotation.
  const loads = [
    member("a", { conversations: 3 }),
    member("b", { conversations: 1 }),
    member("c", { conversations: 1 }),
  ];
  assert.equal(decide(team({ members: loads }), conversation).assignee, "b");
  assert.equal(
    decide(team({ members: loads, cursor: "b" }), conversation).assignee,
    "c",
  );
  // Teammate limits; away teammates never get balanced work.
  assert.equal(
    decide(
      team({
        members: [
          member("a", { conversations: 2, conversationLimit: 2 }),
          member("b", { conversations: 5, presence: "away" }),
          member("c", { conversations: 4 }),
        ],
      }),
      conversation,
    ).assignee,
    "c",
  );
  assert.deepEqual(
    decide(
      team({
        members: [member("a", { conversations: 1, conversationLimit: 1 })],
      }),
      conversation,
    ),
    { assignee: null, reason: "at_capacity" },
  );
  // The inbox's own limit.
  assert.equal(
    decide(team({ conversationLimit: 4, conversations: 4 }), conversation)
      .reason,
    "inbox_limit",
  );
  // Tickets: a separate limit, and whether they count toward conversation capacity.
  const ticket = { ticket: true };
  assert.equal(
    decide(team({ ticketLimit: 2, tickets: 2 }), ticket).reason,
    "inbox_ticket_limit",
  );
  assert.equal(
    decide(
      team({
        members: [member("a", { tickets: 1, ticketLimit: 1 }), member("b")],
      }),
      ticket,
    ).assignee,
    "b",
  );
  const heavyTickets = [
    member("a", { conversations: 1, tickets: 4 }),
    member("b", { conversations: 2 }),
  ];
  assert.equal(
    decide(team({ members: heavyTickets }), conversation).assignee,
    "b",
    "tickets count by default",
  );
  assert.equal(
    decide(team({ members: heavyTickets, ticketsCount: false }), conversation)
      .assignee,
    "a",
  );
  assert.equal(
    decide(
      team({ ticketsCount: false, conversationLimit: 1, conversations: 1 }),
      ticket,
    ).assignee,
    "a",
    "when tickets do not count, the conversation limit does not stop a ticket",
  );
});

test("routing in the database: team arrivals, queueing at capacity, pick-up when capacity appears, atomic claims, manual overrides", async () => {
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
  let n = 0;
  const arrive = async (teamId: string) => {
    const id = `c-${++n}`;
    await sql(
      "INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,created_at,updated_at) VALUES('a',$1,'default','','Customer','',$1,now(),now())",
      [id],
    );
    // Assigning to a team (as a teammate, macro or rule would) routes it.
    await tenant(db.connect, "a", (q) =>
      command(
        q,
        "a",
        { type: "teammate", principal: "owner-a" },
        "arrive-" + id,
        { action: "assign", conversationId: id, teamId },
      ),
    );
    return id;
  };
  const holder = async (id: string) =>
    (await sql("SELECT assigned FROM conversations WHERE id=$1", [id]))[0]
      .assigned;
  const teammate = (principal: string, p: Record<string, unknown>) =>
    tenant(db.connect, "a", (q) =>
      command(
        q,
        "a",
        { type: "teammate", principal },
        crypto.randomUUID(),
        p as never,
      ),
    );
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
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','ada','ada-a','Ada','agent'),('a','bo','bo-a','Bo','agent'),('a','cy','cy-a','Cy','agent')",
    );
    assert.equal(
      code(await agent("teams")),
      "ROUTING_DISABLED",
      "off by default",
    );
    await sql(
      "UPDATE workspace_features SET enabled=true WHERE name='routing_v1'",
    );
    for (const w of ["b"])
      await sql(
        "UPDATE workspace_features SET enabled=true WHERE name='routing_v1'",
        [],
        w,
      );

    // Teams: managed with workspace.manage, validated, versioned.
    assert.equal(
      (await agent("teams", { name: "Support", method: "balanced" }, "ada-a"))
        .status,
      403,
    );
    assert.equal(
      code(await agent("teams", { name: "Support", method: "lottery" })),
      "INVALID_TEAM",
    );
    assert.equal(
      code(
        await agent("teams", {
          name: "Support",
          method: "balanced",
          conversationLimit: 0,
        }),
      ),
      "INVALID_TEAM",
    );
    const support = (
      await agent("teams", {
        name: "Support",
        method: "balanced",
        conversationLimit: 3,
        members: ["ada", "bo"],
      })
    ).body.id;
    await agent("teammate-limits", { teammateId: "ada", conversationLimit: 1 });
    await agent("teammate-limits", { teammateId: "bo", conversationLimit: 1 });
    assert.equal(
      code(
        await agent(
          "teams",
          { name: "Other", members: ["ada"] },
          "owner-b",
          "b",
        ),
      ),
      "INVALID_TEAM",
      "members from another workspace refused",
    );

    // Balanced: one each (limit 1), then the third waits in the inbox.
    const first = await arrive(support),
      second = await arrive(support),
      third = await arrive(support);
    assert.deepEqual([await holder(first), await holder(second)].sort(), [
      "ada",
      "bo",
    ]);
    assert.equal(await holder(third), "", "waits: everyone is at their limit");
    const listed = (await agent("teams")).body.teams[0];
    assert.equal(listed.queued, 1);
    assert.deepEqual(listed.used, { conversations: 2, tickets: 0 });
    assert.deepEqual(
      listed.members.map((m: any) => [
        m.id,
        m.used.conversations,
        m.conversationLimit,
      ]),
      [
        ["ada", 1, 1],
        ["bo", 1, 1],
      ],
    );
    // Capacity appears when Ada closes hers: the waiting conversation is picked up automatically.
    const adas = (await holder(first)) === "ada" ? first : second;
    await teammate("ada-a", { action: "close", conversationId: adas });
    assert.equal(
      await holder(third),
      "ada",
      "picked up when capacity appeared",
    );
    // Snoozing frees capacity too; a fourth arrival goes to whoever has room.
    const fourth = await arrive(support);
    assert.equal(await holder(fourth), "");
    await teammate("bo-a", {
      action: "snooze",
      conversationId: adas === first ? second : first,
      preset: "tomorrow",
      timezone: "UTC",
    });
    assert.equal(await holder(fourth), "bo");

    // Raising a limit drains the queue; the inbox limit (3) still binds.
    const fifth = await arrive(support),
      sixth = await arrive(support);
    assert.deepEqual([await holder(fifth), await holder(sixth)], ["", ""]);
    await agent("teammate-limits", {
      teammateId: "ada",
      conversationLimit: 10,
    });
    assert.equal(await holder(fifth), "ada");
    assert.equal(await holder(sixth), "", "the inbox is at its limit of 3");
    assert.equal((await agent("teams")).body.teams[0].used.conversations, 3);

    // Atomic claims: a second claim on the same conversation changes nothing.
    await sql("UPDATE teams SET method='manual'");
    const contested = await arrive(support);
    const claims = await tenant(db.connect, "a", async (q) => [
      await claim(q, "a", contested, support, "ada", "test"),
      await claim(q, "a", contested, support, "bo", "test"),
    ]);
    assert.deepEqual(claims, [true, false]);
    assert.equal(await holder(contested), "ada");
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversation_parts WHERE conversation_id=$1 AND kind='assignment_change' AND data->>'reason'='test'",
          [contested],
        )
      )[0].n,
      1,
    );
    // Manual: nothing is assigned automatically; teammates claim work.
    const waiting = await arrive(support);
    assert.equal(await holder(waiting), "");
    // By hand beyond a limit: allowed, with a warning.
    await agent("teammate-limits", { teammateId: "bo", conversationLimit: 1 });
    const manual = await teammate("owner-a", {
      action: "assign",
      conversationId: waiting,
      teammateId: "bo",
    });
    assert.deepEqual(manual, { conversationId: waiting, overLimit: true });

    // Round robin: in rotation, ignoring limits.
    const rr = (
      await agent("teams", {
        name: "Sales",
        method: "round_robin",
        members: ["ada", "bo", "cy"],
      })
    ).body.id;
    const order = [];
    for (let i = 0; i < 4; i++) order.push(await holder(await arrive(rr)));
    assert.deepEqual(order, ["ada", "bo", "cy", "ada"]);
    // Everyone away: it waits, and is picked up when someone returns.
    await sql(
      "UPDATE teammates SET presence='away' WHERE id IN ('ada','bo','cy')",
    );
    const nobody = await arrive(rr);
    assert.equal(await holder(nobody), "");
    await sql("UPDATE teammates SET presence='active' WHERE id='cy'");
    await tenant(db.connect, "a", (q) => drainForTeammate(q, "a", "cy"));
    assert.equal(await holder(nobody), "cy");
    await sql("UPDATE teammates SET presence='active'");

    // The sweep routes anything a missed trigger left waiting.
    await sql("UPDATE teams SET method='balanced' WHERE id=$1", [support]);
    await agent("teammate-limits", { teammateId: "bo", conversationLimit: 50 });
    await sql("UPDATE teams SET conversation_limit=NULL WHERE id=$1", [
      support,
    ]);
    const swept = await drainAll(db.connect, "a");
    assert(swept.length >= 1);
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversations WHERE team_id=$1 AND assigned='' AND status='open'",
          [support],
        )
      )[0].n,
      0,
    );
    // The interface for rule-based routing (phase 11): who would get it, without assigning.
    const probe = (
      await sql(
        "INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,created_at,updated_at,team_id) VALUES('a','probe','default','','C','','probe',now(),now(),$1) RETURNING id",
        [support],
      )
    )[0].id;
    const would = await tenant(db.connect, "a", (q) =>
      assigneeFor(q, "a", probe),
    );
    assert.equal(would.teamId, support);
    assert.equal(would.reason, "balanced");
    assert.equal(await holder(probe), "", "reading does not assign");
    await tenant(db.connect, "a", (q) => drainTeam(q, "a", support));
    assert.equal(await holder(probe), would.assignee);

    // Other workspaces see no teams of ours.
    assert.deepEqual(
      (await agent("teams", undefined, "owner-b", "b")).body.teams,
      [],
    );
  } finally {
    await db.close();
  }
});
