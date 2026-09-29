import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { runJob, type Job } from "../server/jobs";
import {
  compileFilter,
  projectInboxChanges,
  rebuildViews,
  validateFilter,
  viewCounts,
} from "../server/inbox-views";

test("filters: only fixed columns reach SQL, values are bound, unavailable fields fail closed", () => {
  const hostile = "x') OR 1=1; DROP TABLE conversations; --";
  const values: unknown[] = [];
  const filter = {
    or: [
      { field: "assignee", op: "eq", value: hostile },
      { field: "tag", op: "in", value: [hostile] },
    ],
  };
  validateFilter(filter);
  const sql = compileFilter(filter as never, values);
  assert(!sql.includes(hostile) && !sql.includes("DROP"));
  assert.deepEqual(values, [hostile, [hostile]]);
  for (const [input, code] of [
    [
      { field: "sla_status", op: "eq", value: "breached" },
      "FILTER_UNAVAILABLE",
    ],
    [{ field: "contact.plan", op: "eq", value: "pro" }, "FILTER_UNAVAILABLE"],
    [{ field: "c.status; --", op: "eq", value: "open" }, "FILTER_UNAVAILABLE"],
    [{ field: "state", op: "like", value: "open" }, "INVALID_FILTER"],
    [{ field: "state", op: "gte", value: "open" }, "INVALID_FILTER"],
    [{ field: "created_at", op: "gte", value: "2026-01-01" }, "INVALID_FILTER"],
    [{ field: "priority", op: "eq", value: "true" }, "INVALID_FILTER"],
    [{ and: [] }, "INVALID_FILTER"],
  ] as const)
    assert.throws(() => validateFilter(input), { code });
  let deep: unknown = { field: "state", op: "eq", value: "open" };
  for (let i = 0; i < 6; i++) deep = { and: [deep] };
  assert.throws(() => validateFilter(deep), { code: "INVALID_FILTER" });
  validateFilter({
    field: "created_at",
    op: "gte",
    value: "2026-01-01T00:00:00+01:00",
  });
});

test("views: tenant and teammate isolation, sharing permissions, shared filter sets, live counts, paging, move and rollback", async () => {
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
  const handlers = {
    "inbox.views.rebuild": (job: Job) => rebuildViews(db.connect, job),
  };
  const drain = async (jobId: string | undefined, w = "a") => {
    while (jobId) {
      const r = await runJob(db.connect, w, jobId, handlers);
      if (r.state !== "queued") {
        assert.equal(r.state, "succeeded");
        return;
      }
    }
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const project = async (w = "a") => {
    while (await projectInboxChanges(db.connect, w));
  };
  const views = async (principal = "owner-a", w = "a") =>
    (await agent("views", undefined, principal, w)).body.views as any[];
  const byBuiltin = async (builtin: string, principal = "owner-a") =>
    (await views(principal)).find((v) => v.builtin === builtin);
  const page = async (
    query: Record<string, string>,
    principal = "owner-a",
    w = "a",
  ) =>
    agent(
      "view-page?" + new URLSearchParams(query).toString(),
      undefined,
      principal,
      w,
    );
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
        "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES($1,'agent-1','agent-1-'||$1,'Agent one','agent'),($1,'agent-2','agent-2-'||$1,'Agent two','agent')",
        [w],
      );
      // 400 conversations (133 open, so lists span pages): open/snoozed/closed in rotation, every third unassigned.
      await sql(
        w,
        "INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,status,assigned,created_at,updated_at) SELECT $1,$1||'-c-'||lpad(i::text,4,'0'),'default','','Customer','','T'||i,(ARRAY['open','snoozed','closed'])[1+i%3],CASE WHEN i%3=0 THEN '' ELSE 'agent-1' END,timestamptz '2026-09-01T00:00:00Z'+(i||' minutes')::interval,now() FROM generate_series(1,400) i",
        [w],
      );
      await sql(w, "DELETE FROM inbox_projection_dirty WHERE workspace_id=$1", [
        w,
      ]);
    }
    const openCount = async (w = "a") =>
      Number(
        (
          await sql(
            w,
            "SELECT count(*) FROM conversations WHERE workspace_id=$1 AND status='open' AND merged_into_id IS NULL",
            [w],
          )
        )[0].count,
      );

    // Flag defaults off: views are unavailable, including initialisation.
    assert.equal((await agent("views")).status, 404);
    assert.equal((await agent("views", { action: "initialize" })).status, 404);
    for (const w of ["a", "b"])
      await sql(
        w,
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name='agent_inbox_views_v1'",
        [w],
      );

    // Each teammate initialises five personal default views. Identical filters share one set,
    // so the second and third teammates only rebuild their own "Mine" set.
    for (const principal of ["owner-a", "agent-1-a", "agent-2-a"]) {
      const init = await agent("views", { action: "initialize" }, principal);
      assert.equal(init.status, 202);
      await drain(init.body.jobId);
    }
    const second = await agent("views", { action: "initialize" }, "agent-1-a");
    assert.equal(second.body.jobId, null, "ready sets need no rebuild");
    const [ownerOpen, agentOpen] = [
      await byBuiltin("open"),
      await byBuiltin("open", "agent-1-a"),
    ];
    assert.notEqual(ownerOpen.id, agentOpen.id);
    assert.equal(ownerOpen.set_id, agentOpen.set_id);
    assert.notEqual(
      (await byBuiltin("mine")).set_id,
      (await byBuiltin("mine", "agent-1-a")).set_id,
    );
    assert.equal(
      Number(
        (await sql("a", "SELECT count(*) FROM inbox_filter_sets"))[0].count,
      ),
      7,
      "open, snoozed, closed, unassigned and three Mine sets",
    );
    assert.equal(ownerOpen.ready, true);
    assert.equal(Number(ownerOpen.count), await openCount());
    assert.equal(
      (await views()).length,
      5,
      "Mentions is deferred to step C; five defaults exist",
    );

    // Tenant isolation: workspace B cannot read workspace A's view, even by id.
    assert.equal(
      (await page({ view: ownerOpen.id }, "owner-b", "b")).status,
      404,
    );
    assert.equal(
      (await page({ view: ownerOpen.id }, "owner-b", "a")).status,
      403,
      "a principal from another workspace is not a teammate here",
    );
    assert.equal((await views("owner-b", "b")).length, 0);
    assert.equal((await agent("views", undefined, "outsider")).status, 403);

    // Personal views are invisible to other teammates; sharing needs workspace.manage.
    const personal = await agent(
      "views",
      {
        action: "save",
        name: "Agent one priority",
        filter: { field: "priority", op: "eq", value: true },
      },
      "agent-1-a",
    );
    assert.equal(personal.status, 202);
    await drain(personal.body.jobId);
    assert.equal(
      (await page({ view: personal.body.id }, "agent-2-a")).status,
      404,
    );
    assert(!(await views("agent-2-a")).some((v) => v.id === personal.body.id));
    assert.equal(
      (
        await agent(
          "views",
          {
            action: "save",
            name: "Team queue",
            shared: true,
            filter: { field: "state", op: "eq", value: "open" },
          },
          "agent-1-a",
        )
      ).status,
      403,
    );
    const shared = await agent("views", {
      action: "save",
      name: "Team queue",
      shared: true,
      filter: { field: "state", op: "eq", value: "open" },
    });
    assert.equal(shared.status, 200, "an existing ready filter needs no job");
    assert.equal(shared.body.jobId, undefined);
    const sharedView = (await views("agent-2-a")).find(
      (v) => v.id === shared.body.id,
    );
    assert.equal(sharedView.set_id, ownerOpen.set_id);
    assert.equal(sharedView.ready, true);
    assert.equal(
      (
        await agent(
          "views",
          {
            action: "save",
            id: shared.body.id,
            revision: sharedView.revision,
            name: "Renamed by agent",
          },
          "agent-2-a",
        )
      ).status,
      403,
    );
    // Default views stay personal and keep their filter; stale revisions conflict.
    assert.equal(
      (
        await agent("views", {
          action: "save",
          id: ownerOpen.id,
          revision: ownerOpen.revision,
          shared: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await agent("views", {
          action: "save",
          id: ownerOpen.id,
          revision: ownerOpen.revision,
          filter: { field: "state", op: "eq", value: "closed" },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await agent("views", {
          action: "save",
          id: shared.body.id,
          revision: "999",
          name: "Stale",
        })
      ).status,
      409,
    );

    // Live counts: status changes, a merge and a snooze move conversations between sets.
    const counts = async () =>
      new Map(
        (
          await tenant(db.connect, "a", (q) =>
            viewCounts(q, "a", ["owner", "agent-1", "agent-2"]),
          )
        ).map((c) => [c.id, c]),
      );
    await sql(
      "a",
      "UPDATE conversations SET status='closed' WHERE workspace_id='a' AND id IN ('a-c-0003','a-c-0006')",
    );
    await sql(
      "a",
      "UPDATE conversations SET status='snoozed' WHERE workspace_id='a' AND id='a-c-0009'",
    );
    await sql(
      "a",
      "UPDATE conversations SET merged_into_id='a-c-0012' WHERE workspace_id='a' AND id='a-c-0015'",
    );
    await project();
    const live = await counts();
    const expectedOpen = await openCount();
    for (const v of [ownerOpen, agentOpen, sharedView])
      assert.equal(Number(live.get(v.id)!.count), expectedOpen);
    const members = await sql(
      "a",
      "SELECT count(*) FROM inbox_filter_members WHERE set_id=$1",
      [ownerOpen.set_id],
    );
    assert.equal(Number(members[0].count), expectedOpen, "count matches rows");
    const closed = await byBuiltin("closed");
    const closedExpected = Number(
      (
        await sql(
          "a",
          "SELECT count(*) FROM conversations WHERE status='closed' AND merged_into_id IS NULL",
        )
      )[0].count,
    );
    assert.equal(Number(live.get(closed.id)!.count), closedExpected);
    await sql(
      "a",
      "UPDATE inbox_filter_sets SET match_count=10000 WHERE id=$1",
      [closed.set_id],
    );
    assert.equal((await byBuiltin("closed")).count_label, "9,999+");
    await sql("a", "UPDATE inbox_filter_sets SET match_count=$2 WHERE id=$1", [
      closed.set_id,
      closedExpected,
    ]);

    // Keyset paging: every member exactly once, in order, even when rows change mid-way.
    for (const sort of ["newest", "oldest"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const r = await page({
          view: ownerOpen.id,
          sort,
          ...(cursor ? { cursor } : {}),
        });
        assert.equal(r.status, 200);
        seen.push(...r.body.conversations.map((c: any) => c.id));
        cursor = r.body.nextCursor;
        if (pages++ === 0) {
          // A new conversation arriving after page one must not shift or repeat rows.
          await sql(
            "a",
            "INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,status,assigned,created_at,updated_at) VALUES('a','a-new-'||$1,'default','','Customer','','New','open','',now(),now())",
            [sort],
          );
          await project();
        }
      } while (cursor);
      assert.equal(new Set(seen).size, seen.length, "no duplicates");
      const sorted = [...seen].sort();
      const original = seen.filter((id) => !id.startsWith("a-new-"));
      assert.deepEqual(
        original,
        sort === "oldest"
          ? sorted.filter((id) => !id.startsWith("a-new-"))
          : sorted.filter((id) => !id.startsWith("a-new-")).reverse(),
      );
    }
    const first = await page({ view: ownerOpen.id });
    assert.equal(first.body.conversations.length, 100);
    assert.equal(
      (
        await page({
          view: (await byBuiltin("closed")).id,
          cursor: first.body.nextCursor,
        })
      ).status,
      400,
      "a cursor belongs to one view",
    );
    assert.equal(
      (await page({ view: ownerOpen.id, cursor: "not-base64!" })).status,
      400,
    );
    const renamed = await agent("views", {
      action: "save",
      id: shared.body.id,
      revision: sharedView.revision,
      name: "Team queue (all open)",
    });
    assert.equal(renamed.status, 200);
    const sharedFirst = await page({ view: shared.body.id });
    await agent("views", {
      action: "save",
      id: shared.body.id,
      revision: String(Number(sharedView.revision) + 1),
      name: "Team queue again",
    });
    assert.equal(
      (
        await page({
          view: shared.body.id,
          cursor: sharedFirst.body.nextCursor,
        })
      ).status,
      400,
      "a revision change invalidates cursors",
    );

    // Search within a view uses the conversation search documents.
    assert.equal(
      (
        await agent("command", {
          action: "note",
          conversationId: "a-c-0021",
          text: "Customer asked about a refund invoice",
        })
      ).status,
      200,
    );
    await project();
    const searched = await page({ view: ownerOpen.id, q: "refund" });
    assert.deepEqual(
      searched.body.conversations.map((c: any) => c.id),
      ["a-c-0021"],
    );

    // Move renumbers the teammate's editable views so positions never collide.
    const before = (await views()).filter((v) => v.folder_id === null);
    const target = before[2];
    const moved = await agent("views", {
      action: "move",
      id: target.id,
      direction: "up",
    });
    assert.equal(moved.status, 200);
    const after = (await views()).filter((v) => v.folder_id === null);
    assert.equal(after[1].id, target.id);
    assert.equal(
      new Set(after.map((v) => v.position)).size,
      after.length,
      "distinct positions",
    );
    assert.equal(
      (
        await agent(
          "views",
          { action: "move", id: shared.body.id, direction: "down" },
          "agent-2-a",
        )
      ).status,
      403,
    );

    // A rebuild resumes from its checkpoint after a crash and does not double count.
    const custom = await agent("views", {
      action: "save",
      name: "Unassigned or snoozed",
      filter: {
        or: [
          { field: "assignee", op: "eq", value: "" },
          { field: "state", op: "eq", value: "snoozed" },
        ],
      },
    });
    assert.equal(custom.status, 202);
    const step = await runJob(db.connect, "a", custom.body.jobId, handlers);
    assert.equal(step.state, "queued", "first step checkpoints");
    // Simulate a worker that crashed mid-step: the lease expires and the step runs again.
    await sql(
      "a",
      "UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [custom.body.jobId],
    );
    await drain(custom.body.jobId);
    const customView = (await views()).find((v) => v.id === custom.body.id);
    const customExpected = Number(
      (
        await sql(
          "a",
          "SELECT count(*) FROM conversations WHERE merged_into_id IS NULL AND (assigned='' OR status='snoozed')",
        )
      )[0].count,
    );
    assert.equal(customView.ready, true);
    assert.equal(Number(customView.count), customExpected);

    // Workspace B is untouched by everything above.
    const initB = await agent(
      "views",
      { action: "initialize" },
      "owner-b",
      "b",
    );
    await drain(initB.body.jobId, "b");
    const openB = (await views("owner-b", "b")).find(
      (v) => v.builtin === "open",
    );
    assert.equal(Number(openB.count), await openCount("b"));
    assert.equal(
      (
        await agent(
          "views",
          { action: "save", id: ownerOpen.id, name: "Hijack", revision: "1" },
          "owner-b",
          "b",
        )
      ).status,
      404,
    );

    // Exposure rollback for one workspace hides views and keeps every definition and member.
    const membersBefore = await sql(
      "a",
      "SELECT count(*) FROM inbox_filter_members",
    );
    await tenant(db.connect, "a", async (q) =>
      q.query(await readFile("db/rollback/0015_inbox_filter_sets.sql", "utf8")),
    );
    assert.equal((await agent("views")).status, 404);
    assert.equal((await agent("views", undefined, "owner-b", "b")).status, 200);
    assert.deepEqual(
      await sql("a", "SELECT count(*) FROM inbox_filter_members"),
      membersBefore,
    );
  } finally {
    await db.close();
  }
});
