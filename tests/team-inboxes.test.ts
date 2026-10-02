import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { runJob, type Job } from "../server/jobs";
import { projectInboxChanges, rebuildViews } from "../server/inbox-views";

/**
 * Team inboxes in the inbox menu (docs/AGENT_APP_SHELL.md): one built-in view per team the
 * teammate is on, kept in step with membership and the team's name by the idempotent
 * initialize, and never visible from another workspace.
 */
test("team inboxes: one per team you are on, renamed with the team, archived when you leave, back when you rejoin", async () => {
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
      send,
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "inbox.views.rebuild": (job: Job) => rebuildViews(db.connect, job),
  };
  const initialize = async (principal = "owner-a", w = "a") => {
    const init = await agent("views", { action: "initialize" }, principal, w);
    assert.ok(init.status === 200 || init.status === 202, String(init.status));
    let jobId = init.body.jobId;
    while (jobId) {
      const r = await runJob(db.connect, w, jobId, handlers);
      if (r.state !== "queued") {
        assert.equal(r.state, "succeeded");
        jobId = null;
      }
    }
  };
  const snapshot = async (principal = "owner-a", w = "a") =>
    (await agent("views", undefined, principal, w)).body as {
      views: any[];
      teams: { id: string; name: string }[];
    };
  const teamInboxes = async (principal = "owner-a", w = "a") =>
    (await snapshot(principal, w)).views
      .filter((v) => v.builtin?.startsWith("team:"))
      .map((v) => ({ name: v.name, builtin: v.builtin, count: v.count }));
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
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name='agent_inbox_views_v1'",
        [w],
      );
      await sql(
        w,
        "INSERT INTO teams(workspace_id,id,name) VALUES($1,'billing','Billing'),($1,'futures','Futures'),($1,'other','Other') ON CONFLICT DO NOTHING",
        [w],
      );
    }
    const owner = (
      await sql<{ id: string }>(
        "a",
        "SELECT id FROM teammates WHERE workspace_id='a' AND principal_id='owner-a'",
      )
    )[0].id;
    await sql(
      "a",
      "INSERT INTO teammate_teams(workspace_id,teammate_id,team_id) VALUES('a',$1,'billing'),('a',$1,'futures')",
      [owner],
    );
    // Conversations in each team: 3 open in Billing (one closed), 2 open in Futures, 4 in Other.
    await sql(
      "a",
      `INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,status,assigned,team_id,created_at,updated_at)
       SELECT 'a','team-c-'||i,'default','','Customer','','Team '||i,CASE WHEN i=4 THEN 'closed' ELSE 'open' END,'',
         CASE WHEN i<=4 THEN 'billing' WHEN i<=6 THEN 'futures' ELSE 'other' END,now()-(i||' minutes')::interval,now()
       FROM generate_series(1,10) i`,
    );
    while (await projectInboxChanges(db.connect, "a"));

    // The views snapshot names the teams you are on, alphabetically; initialize adds an inbox
    // for each, after the four defaults, counting its open conversations.
    assert.deepEqual(
      (await snapshot()).teams.map((t) => t.name),
      ["Billing", "Futures"],
    );
    await initialize();
    assert.deepEqual(await teamInboxes(), [
      { name: "Billing", builtin: "team:billing", count: "3" },
      { name: "Futures", builtin: "team:futures", count: "2" },
    ]);
    const billing = (await snapshot()).views.find(
      (v) => v.builtin === "team:billing",
    );
    const listed = await agent(
      "view-page?" + new URLSearchParams({ view: billing.id, status: "all" }),
    );
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.conversations.map((c: any) => c.id).sort(), [
      "team-c-1",
      "team-c-2",
      "team-c-3",
      "team-c-4",
    ]);
    // Idempotent: a second initialize changes nothing.
    const revision = billing.revision;
    await initialize();
    assert.equal(
      (await snapshot()).views.find((v) => v.builtin === "team:billing")
        .revision,
      revision,
    );
    // Team inboxes cannot be archived or moved; they follow your teams.
    for (const action of [
      { action: "archive", id: billing.id, revision },
      { action: "move", id: billing.id, direction: "down" },
    ]) {
      const refused = await agent("views", action);
      assert.equal(refused.status, 400);
      assert.equal(refused.body.error.code, "INVALID_VIEW");
    }

    // A renamed team renames its inbox; leaving a team archives its inbox; rejoining restores
    // the same view, re-attached to its list.
    await sql("a", "UPDATE teams SET name='Billing desk' WHERE id='billing'");
    await sql(
      "a",
      "DELETE FROM teammate_teams WHERE teammate_id=$1 AND team_id='futures'",
      [owner],
    );
    await initialize();
    assert.deepEqual(await teamInboxes(), [
      { name: "Billing desk", builtin: "team:billing", count: "3" },
    ]);
    const futures = (
      await sql(
        "a",
        "SELECT id,archived FROM inbox_views WHERE builtin='team:futures'",
      )
    )[0];
    assert.equal(futures.archived, true);
    await sql(
      "a",
      "INSERT INTO teammate_teams(workspace_id,teammate_id,team_id) VALUES('a',$1,'futures')",
      [owner],
    );
    await initialize();
    const back = (await snapshot()).views.find(
      (v) => v.builtin === "team:futures",
    );
    assert.equal(back.id, futures.id, "the same view comes back");
    assert.equal(back.ready, true);
    assert.equal(back.count, "2");

    // Tenant isolation: workspace B's owner is on no team and sees none of A's team inboxes,
    // and cannot read one by id.
    await initialize("owner-b", "b");
    assert.deepEqual((await snapshot("owner-b", "b")).teams, []);
    assert.deepEqual(await teamInboxes("owner-b", "b"), []);
    assert.equal(
      (
        await agent(
          "view-page?" + new URLSearchParams({ view: billing.id }),
          undefined,
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
