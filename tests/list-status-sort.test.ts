import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { runJob, type Job } from "../server/jobs";
import {
  listSort,
  projectInboxChanges,
  rebuildViews,
} from "../server/inbox-views";

test("list sorts: saved sorts from before the menu keep their order", () => {
  assert.deepEqual(listSort("newest"), { sort: "created", direction: "desc" });
  assert.deepEqual(listSort("oldest"), { sort: "created", direction: "asc" });
  assert.deepEqual(listSort("waiting"), { sort: "waiting", direction: "asc" });
  assert.deepEqual(listSort("activity"), {
    sort: "activity",
    direction: "desc",
  });
  assert.deepEqual(listSort("priority", "asc"), {
    sort: "priority",
    direction: "asc",
  });
  assert.deepEqual(listSort(null), { sort: "activity", direction: "desc" });
  assert.throws(() => listSort("loudest"), { code: "INVALID_SORT" });
});

test("the conversation list: status picker with ticket states, counts, every sort both ways, bulk follows the status", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
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
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const drain = async (jobId: string | null | undefined, w = "a") => {
    while (jobId) {
      const r = await runJob(db.connect, w, jobId, {
        "inbox.views.rebuild": (job: Job) => rebuildViews(db.connect, job),
      });
      if (r.state !== "queued") return;
    }
  };
  const project = async (w = "a") => {
    while (await projectInboxChanges(db.connect, w));
  };
  const ids = (r: { body: any }) =>
    r.body.conversations.map((c: any) => c.id.replace(/^[ab]-/, ""));

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
      // Six conversations: started an hour apart; last activity in a different order.
      //   c1 open, priority          started 01:00, last reply 09:00
      //   c2 open                    started 02:00, last reply 07:00
      //   c3 open                    started 03:00, no replies (activity = started)
      //   c4 snoozed until 12:00     started 04:00, last reply 08:00
      //   c5 closed, ticket waiting  started 05:00, last reply 06:00
      //   c6 snoozed until 11:00     started 06:00, ticket resolved
      await sql(
        w,
        `INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,status,assigned,created_at,updated_at,priority,last_contact_reply_at,last_teammate_reply_at,snooze_until)
        VALUES
        ($1,$1||'-c1','default','','Customer','','One','open','',  '2026-10-01T01:00Z',now(),true, '2026-10-01T09:00Z',NULL,NULL),
        ($1,$1||'-c2','default','','Customer','','Two','open','',  '2026-10-01T02:00Z',now(),false,NULL,'2026-10-01T07:00Z',NULL),
        ($1,$1||'-c3','default','','Customer','','Three','open','','2026-10-01T03:00Z',now(),false,NULL,NULL,NULL),
        ($1,$1||'-c4','default','','Customer','','Four','snoozed','','2026-10-01T04:00Z',now(),false,'2026-10-01T08:00Z',NULL,'2026-10-02T12:00Z'),
        ($1,$1||'-c5','default','','Customer','','Five','closed','','2026-10-01T05:00Z',now(),false,'2026-10-01T06:00Z',NULL,NULL),
        ($1,$1||'-c6','default','','Customer','','Six','snoozed','','2026-10-01T06:00Z',now(),false,NULL,NULL,'2026-10-02T11:00Z')`,
        [w],
      );
      await sql(
        w,
        "INSERT INTO ticket_types(workspace_id,id,name,category) VALUES($1,'bug','Bug','customer')",
        [w],
      );
      await sql(
        w,
        "INSERT INTO ticket_states(workspace_id,id,type_id,name,customer_label,kind,position) VALUES($1,'new','bug','New','Submitted','submitted',0),($1,'waiting','bug','Waiting','Waiting on you','waiting_on_customer',1),($1,'done','bug','Done','Resolved','resolved',2)",
        [w],
      );
      await sql(
        w,
        "INSERT INTO tickets(workspace_id,conversation_id,number,type_id,state_id,created_by) VALUES($1,$1||'-c5',1,'bug','waiting','owner'),($1,$1||'-c6',2,'bug','done','owner')",
        [w],
      );
    }
    const init = await agent("views", { action: "initialize" });
    await drain(init.body.jobId);
    const all = (await agent("views")).body.views.find(
      (v: any) => v.builtin === "all",
    );
    const list = (
      query: Record<string, string>,
      principal = "owner-a",
      w = "a",
    ) =>
      agent(
        "view-page?" + new URLSearchParams({ view: all.id, ...query }),
        undefined,
        principal,
        w,
      );

    // Open by default, most recent activity first; counts for every status.
    let r = await list({});
    assert.deepEqual(ids(r), ["c1", "c2", "c3"]);
    assert.deepEqual(r.body.counts, {
      open: 3,
      snoozed: 2,
      closed: 1,
      submitted: 0,
      in_progress: 0,
      waiting_on_customer: 1,
      resolved: 1,
    });
    assert.equal(
      all.count,
      "3",
      "a view's own count is its open conversations",
    );
    // Each status, including ticket states whatever the conversation's own status.
    assert.deepEqual(ids(await list({ status: "snoozed" })), ["c4", "c6"]);
    assert.deepEqual(ids(await list({ status: "closed" })), ["c5"]);
    assert.deepEqual(ids(await list({ status: "waiting_on_customer" })), [
      "c5",
    ]);
    assert.deepEqual(ids(await list({ status: "resolved" })), ["c6"]);
    assert.deepEqual(ids(await list({ status: "submitted" })), []);

    // Every sort, both ways.
    const order = async (sort: string, dir: string, status = "all") =>
      ids(await list({ sort, dir, status }));
    assert.deepEqual(await order("activity", "desc"), [
      "c1",
      "c4",
      "c2",
      "c6",
      "c5",
      "c3",
    ]);
    assert.deepEqual(await order("activity", "asc"), [
      "c3",
      "c5",
      "c6",
      "c2",
      "c4",
      "c1",
    ]);
    assert.deepEqual(await order("created", "desc"), [
      "c6",
      "c5",
      "c4",
      "c3",
      "c2",
      "c1",
    ]);
    assert.deepEqual(await order("created", "asc"), [
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
      "c6",
    ]);
    assert.deepEqual(await order("priority", "desc", "open"), [
      "c1",
      "c2",
      "c3",
    ]);
    assert.deepEqual(await order("priority", "asc", "open"), [
      "c3",
      "c2",
      "c1",
    ]);
    assert.deepEqual(await order("snoozed", "asc", "snoozed"), ["c6", "c4"]);
    assert.deepEqual(await order("snoozed", "desc", "snoozed"), ["c4", "c6"]);
    // Without a direction, each sort starts in its own (longest waiting, soonest snooze first).
    r = await list({ sort: "snoozed", status: "snoozed" });
    assert.equal(r.body.dir, "asc");

    // Changes move conversations between statuses and sorts.
    await sql("a", "UPDATE conversations SET priority=true WHERE id='a-c3'");
    await sql(
      "a",
      "UPDATE tickets SET state_id='new' WHERE conversation_id='a-c5'",
    );
    await project();
    assert.deepEqual(await order("priority", "desc", "open"), [
      "c1",
      "c3",
      "c2",
    ]);
    r = await list({});
    assert.equal(r.body.counts.waiting_on_customer, 0);
    assert.equal(
      r.body.counts.submitted,
      1,
      "a ticket's state change re-projects it",
    );

    // Cursors belong to one status, sort and direction.
    await sql(
      "a",
      `INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,status,assigned,created_at,updated_at,priority)
      SELECT 'a','a-p'||lpad(i::text,3,'0'),'default','','Customer','','P'||i,'open','',timestamptz '2026-09-01T00:00Z'+(i||' minutes')::interval,now(),i%2=0
      FROM generate_series(1,150) i`,
    );
    await project();
    const walk = async (query: Record<string, string>) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await list({ ...query, ...(cursor ? { cursor } : {}) });
        assert.equal(page.status, 200);
        seen.push(...ids(page));
        cursor = page.body.nextCursor;
      } while (cursor);
      return seen;
    };
    for (const dir of ["desc", "asc"]) {
      const seen = await walk({ sort: "priority", dir });
      assert.equal(seen.length, 153);
      assert.equal(new Set(seen).size, 153, "no duplicates across pages");
      const flags = await sql(
        "a",
        "SELECT replace(id,'a-','') AS id,priority FROM conversations WHERE status='open'",
      );
      const priority = new Map(flags.map((f: any) => [f.id, f.priority]));
      const ranks = seen.map((id) => (priority.get(id) ? 1 : 0));
      const sorted = [...ranks].sort((x, y) =>
        dir === "desc" ? y - x : x - y,
      );
      assert.deepEqual(ranks, sorted, `priority ${dir}`);
    }
    const first = await list({ sort: "priority" });
    assert.equal(
      (
        await list({
          sort: "priority",
          status: "closed",
          cursor: first.body.nextCursor,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await list({
          sort: "priority",
          dir: "asc",
          cursor: first.body.nextCursor,
        })
      ).status,
      400,
    );
    assert.equal((await list({ sort: "loudest" })).status, 400);

    // Bulk "everything in this view" is everything in the status shown.
    const prepared = await agent("bulk", {
      op: "prepare",
      action: { type: "close" },
      viewId: all.id,
      status: "snoozed",
    });
    assert.equal(prepared.status, 200);
    assert.equal(prepared.body.total, 2);
    const everything = await agent("bulk", {
      op: "prepare",
      action: { type: "close" },
      viewId: all.id,
    });
    assert.equal(everything.body.total, 156);

    // Another workspace's conversations never reach these counts or lists.
    const initB = await agent(
      "views",
      { action: "initialize" },
      "owner-b",
      "b",
    );
    await drain(initB.body.jobId, "b");
    const allB = (
      await agent("views", undefined, "owner-b", "b")
    ).body.views.find((v: any) => v.builtin === "all");
    const b = await agent(
      "view-page?" + new URLSearchParams({ view: allB.id, status: "all" }),
      undefined,
      "owner-b",
      "b",
    );
    assert.equal(b.body.conversations.length, 6);
    assert(b.body.conversations.every((c: any) => c.id.startsWith("b-")));
    assert.equal(b.body.counts.open, 3);
    assert.equal((await list({}, "owner-b", "b")).status, 404);
  } finally {
    await db.close();
  }
});
