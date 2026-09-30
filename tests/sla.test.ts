import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { runJob } from "../server/jobs";
import { checkDueSlas, reevaluateJob, syncSla } from "../server/sla";
import { compileFilter } from "../server/inbox-views";
import { saveTicketType } from "../server/tickets";

const MIN = 60_000,
  H = 60 * MIN;

test("SLA clocks follow the conversation: policy choice, pauses, reopen, tickets, breach once, pinned calendars", async () => {
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
  const start = (key: string, w = "a") =>
    tenant(db.connect, w, async (q) => {
      const identity = await getIdentity(q, w, "anonymous", "sla-" + key);
      const id = (
        (await command(
          q,
          w,
          {
            type: "contact",
            identityId: identity.identityId,
            brandId: "default",
          },
          "sla-" + key,
          { action: "start", text: "Help " + key },
        )) as { conversationId: string }
      ).conversationId;
      identities[id] = identity.identityId;
      return id;
    });
  const teammate = (p: Record<string, unknown>) =>
    tenant(db.connect, "a", (q) =>
      command(
        q,
        "a",
        { type: "teammate", principal: "owner-a" },
        crypto.randomUUID(),
        p as never,
      ),
    );
  const customer = (id: string, text: string) =>
    tenant(db.connect, "a", (q) =>
      command(
        q,
        "a",
        { type: "contact", identityId: identities[id], brandId: "default" },
        crypto.randomUUID(),
        { action: "reply", conversationId: id, text },
      ),
    );
  const sync = (id: string, now: number) =>
    tenant(db.connect, "a", (q) => syncSla(q, "a", id, now));
  const clocks = async (id: string) =>
    Object.fromEntries(
      (
        await sql(
          "SELECT metric,cycle,state,target_ms::bigint AS target,elapsed_ms::bigint AS elapsed,due_at,breached_at FROM sla_clocks WHERE conversation_id=$1 ORDER BY metric,cycle",
          [id],
        )
      ).map((r) => [
        `${r.metric}:${r.cycle}`,
        { ...r, target: Number(r.target), elapsed: Number(r.elapsed) },
      ]),
    );
  const created = async (id: string) =>
    Date.parse(
      (await sql("SELECT created_at FROM conversations WHERE id=$1", [id]))[0]
        .created_at,
    );
  const near = (actual: number, expected: number, why: string) =>
    assert(
      Math.abs(actual - expected) < 5000,
      `${why}: ${actual - expected}ms off`,
    );
  const summary = async (id: string) =>
    (
      await sql(
        "SELECT sla_policy_id AS policy,sla_next_due_at AS next,sla_sort_at AS sort,sla_overdue AS overdue,sla_breached AS breached FROM conversations WHERE id=$1",
        [id],
      )
    )[0];
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

    // Off by default: commands leave no clocks.
    const early = await start("early");
    assert.equal(code(await agent("sla-policies")), "SLA_DISABLED");
    assert.equal(
      (await sql("SELECT count(*)::int AS n FROM sla_clocks"))[0].n,
      0,
    );
    for (const w of ["a", "b"])
      await sql(
        "UPDATE workspace_features SET enabled=true WHERE name IN ('sla_v1','tickets_v1')",
        [],
        w,
      );

    // Policies: validated whole, managed with workspace.manage, versioned.
    const standard = {
      name: "Standard",
      position: 1,
      hours: "always",
      targets: {
        first_response: 1 * H,
        next_response: 30 * MIN,
        time_to_close: 8 * H,
        time_to_resolve: 48 * H,
      },
      pause: { snoozed: true, waiting_on_customer: true },
    };
    assert.equal(
      (await agent("sla-policies", { op: "save", ...standard }, "ada-a"))
        .status,
      403,
    );
    for (const [bad, message] of [
      [{ ...standard, targets: {} }, /at least one target/],
      [
        { ...standard, targets: { first_response: 10 } },
        /between one second and a year/,
      ],
      [{ ...standard, targets: { lunch: H } }, /first response, next response/],
      [{ ...standard, hours: "sometimes" }, /business hours or all hours/],
      [
        { ...standard, conditions: { field: "nope", op: "eq", value: "x" } },
        /unavailable/,
      ],
    ] as const) {
      const r = await agent("sla-policies", { op: "save", ...bad });
      assert.equal(code(r), "INVALID_SLA_POLICY", JSON.stringify(r.body));
      assert.match(r.body.error.message, message);
    }
    const saved = await agent("sla-policies", { op: "save", ...standard });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const priority = await agent("sla-policies", {
      op: "save",
      name: "Priority",
      position: 0,
      hours: "always",
      conditions: { field: "priority", op: "eq", value: true },
      targets: { first_response: 10 * MIN },
    });
    assert.equal(
      code(
        await agent("sla-policies", {
          op: "save",
          ...standard,
          id: saved.body.id,
          version: "9",
        }),
      ),
      "SLA_POLICY_CONFLICT",
    );
    assert.deepEqual(
      (await agent("sla-policies", undefined, "owner-b", "b")).body.policies,
      [],
      "other workspaces see none",
    );

    // A policy change re-evaluates existing conversations in the background.
    const handlers = {
      "sla.reevaluate": (j: any) => reevaluateJob(db.connect, j),
    };
    await runJob(db.connect, "a", saved.body.jobId, handlers);
    assert.equal((await summary(early)).policy, saved.body.id);

    // A new conversation: first response and time to close run; next response has not started.
    const c = await start("main");
    const t0 = await created(c);
    let k = await clocks(c);
    assert.deepEqual(Object.keys(k), ["first_response:0", "time_to_close:0"]);
    assert.equal(k["first_response:0"].state, "running");
    near(
      Date.parse(k["first_response:0"].due_at),
      t0 + H,
      "first response due in an hour",
    );
    near(
      Date.parse((await summary(c)).next),
      t0 + H,
      "the timer wakes at the earliest due time",
    );

    // Priority tightens the target, keeping the time already used.
    await teammate({ action: "priority", conversationId: c, value: true });
    await sync(c, t0 + 4 * MIN);
    k = await clocks(c);
    assert.equal((await summary(c)).policy, priority.body.id);
    assert.equal(k["first_response:0"].target, 10 * MIN);
    near(k["first_response:0"].elapsed, 4 * MIN, "time used is kept");
    near(Date.parse(k["first_response:0"].due_at), t0 + 10 * MIN, "due sooner");
    assert.equal(
      k["time_to_close:0"].state,
      "inactive",
      "the priority policy has no close target",
    );

    // Past due: the breach is recorded once, on the timeline and as an outbox event.
    assert.equal((await sync(c, t0 + 11 * MIN)).breached, 1);
    assert.equal((await sync(c, t0 + 12 * MIN)).breached, 0, "recorded once");
    k = await clocks(c);
    near(
      Date.parse(k["first_response:0"].breached_at),
      t0 + 10 * MIN,
      "breached when the target ran out",
    );
    assert.deepEqual(
      (
        await sql(
          "SELECT data->>'metric' AS metric,audience FROM conversation_parts WHERE conversation_id=$1 AND data->>'event'='sla_breached'",
          [c],
        )
      ).map((r) => [r.metric, r.audience]),
      [["first_response", "internal"]],
    );
    const [event] = await sql(
      "SELECT kind,payload FROM outbox WHERE kind='event' AND resource_id=$1",
      [c],
    );
    assert.equal(event.payload.name, "sla.breached");
    assert.equal(event.payload.metric, "first_response");
    assert.deepEqual(
      [(await summary(c)).overdue, (await summary(c)).breached],
      [true, true],
    );
    // The customer never sees it.
    const customerView = await tenant(db.connect, "a", async (q) =>
      JSON.stringify(
        (
          await (
            await import("../server/conversations")
          ).timeline(q, "a", c, {
            type: "contact",
            identityId: identities[c],
            brandId: "default",
          })
        ).parts,
      ),
    );
    assert(!customerView.includes("sla_breached"));

    // Back to the standard policy; a reply stops first response; the breach stays.
    await teammate({ action: "priority", conversationId: c, value: false });
    await teammate({
      action: "reply",
      conversationId: c,
      text: "Hello, looking now",
    });
    k = await clocks(c);
    assert.equal(k["first_response:0"].state, "stopped");
    assert(k["first_response:0"].breached_at, "a breach is never cleared");
    assert.deepEqual(
      [(await summary(c)).overdue, (await summary(c)).breached],
      [false, true],
    );
    // Waiting on the customer (last message is ours): time to close pauses.
    assert.equal(k["time_to_close:0"].state, "paused");
    // The customer writes again: next response starts (cycle 1) and time to close resumes.
    await customer(c, "Any news?");
    k = await clocks(c);
    assert.equal(k["next_response:1"].state, "running");
    assert.equal(k["time_to_close:0"].state, "running");
    await teammate({ action: "reply", conversationId: c, text: "Fixed" });
    await customer(c, "Thanks, one more thing");
    k = await clocks(c);
    assert.equal(k["next_response:1"].state, "stopped");
    assert.equal(k["next_response:2"].state, "running");

    // Snooze pauses; waking resumes. Close stops; reopening continues from the time used.
    await teammate({
      action: "snooze",
      conversationId: c,
      preset: "tomorrow",
      timezone: "UTC",
    });
    assert.equal((await clocks(c))["time_to_close:0"].state, "paused");
    const pausedSort = Date.parse((await summary(c)).sort);
    assert(
      pausedSort >= Date.parse("3000-01-01T00:00:00Z"),
      "paused clocks sort after running ones",
    );
    await teammate({ action: "reopen", conversationId: c });
    assert.equal((await clocks(c))["time_to_close:0"].state, "running");
    await teammate({ action: "close", conversationId: c });
    const closedClock = (await clocks(c))["time_to_close:0"];
    assert.equal(closedClock.state, "stopped");
    await teammate({ action: "reopen", conversationId: c });
    const reopened = (await clocks(c))["time_to_close:0"];
    assert.equal(reopened.state, "running");
    assert(
      reopened.elapsed >= closedClock.elapsed,
      "reopening continues from the time used",
    );

    // Tickets: time to resolve, paused while waiting on the customer, stopped when resolved.
    await tenant(db.connect, "a", (q) =>
      saveTicketType(q, "a", "owner-a", {
        name: "Bug",
        category: "customer",
        states: [
          { key: "new", name: "New", kind: "submitted" },
          { key: "waiting", name: "Waiting", kind: "waiting_on_customer" },
          { key: "done", name: "Done", kind: "resolved" },
        ],
        transitions: [
          ["new", "waiting"],
          ["waiting", "new"],
          ["new", "done"],
        ],
      }),
    );
    const ticket = await start("ticket");
    await teammate({ action: "ticket", conversationId: ticket, typeId: "bug" });
    assert.equal((await clocks(ticket))["time_to_resolve:0"].state, "running");
    await teammate({
      action: "ticket_state",
      conversationId: ticket,
      stateId: "bug.waiting",
    });
    k = await clocks(ticket);
    assert.equal(k["time_to_resolve:0"].state, "paused");
    assert.equal(
      k["time_to_close:0"].state,
      "paused",
      "a ticket waiting on the customer pauses by its state",
    );
    await teammate({
      action: "ticket_state",
      conversationId: ticket,
      stateId: "bug.new",
    });
    await teammate({
      action: "ticket_state",
      conversationId: ticket,
      stateId: "bug.done",
    });
    assert.equal((await clocks(ticket))["time_to_resolve:0"].state, "stopped");

    // Sort keys: running (by due time) before paused before none; filters on overdue/breached.
    const plain = await start("plain");
    const values: unknown[] = ["a"];
    const overdueFilter = compileFilter(
      { field: "sla", op: "eq", value: "breached" },
      values,
    );
    assert.deepEqual(
      (
        await sql(
          `SELECT c.id FROM conversations c WHERE c.workspace_id=$1 AND ${overdueFilter} ORDER BY c.id`,
          values,
        )
      ).map((r) => r.id),
      [c],
    );
    const ticketValues: unknown[] = ["a"];
    const ticketFilter = compileFilter(
      { field: "ticket_type", op: "eq", value: "bug" },
      ticketValues,
    );
    assert.deepEqual(
      (
        await sql(
          `SELECT c.id FROM conversations c WHERE c.workspace_id=$1 AND ${ticketFilter}`,
          ticketValues,
        )
      ).map((r) => r.id),
      [ticket],
    );
    await teammate({
      action: "snooze",
      conversationId: plain,
      preset: "tomorrow",
      timezone: "UTC",
    });
    const order = (
      await sql(
        "SELECT id FROM conversations WHERE id=ANY($1::text[]) ORDER BY COALESCE(sla_sort_at,'9999-12-31'),id",
        [[plain, c, early]],
      )
    ).map((r) => r.id);
    assert.equal(
      order.indexOf(plain),
      2,
      "snoozed with paused clocks sorts last of these",
    );

    // The timer path: a due time that passes records the breach.
    const quick = await agent("sla-policies", {
      op: "save",
      name: "Quick",
      position: 0,
      hours: "always",
      conditions: { field: "tag", op: "eq", value: "urgent" },
      targets: { first_response: 1000 },
    });
    await runJob(db.connect, "a", quick.body.jobId, handlers);
    await sql(
      "INSERT INTO tags(workspace_id,id,name) VALUES('a','urgent','Urgent')",
    );
    const urgent = await start("urgent");
    await teammate({
      action: "tag_add",
      conversationId: urgent,
      tagId: "urgent",
    });
    assert.equal((await summary(urgent)).policy, quick.body.id);
    await new Promise((r) => setTimeout(r, 1200));
    assert.deepEqual(await checkDueSlas(db.connect, "a"), [urgent]);
    assert.deepEqual(
      await checkDueSlas(db.connect, "a"),
      [],
      "nothing further is due",
    );

    // Business hours: a clock pins the calendar version it started under.
    await sql(
      "UPDATE brands SET settings=settings-'calendarId'-'calendarVersion' WHERE id='default'",
    );
    await agent("calendars", {
      op: "publish",
      name: "Office",
      timezone: "Europe/London",
      weekly: Object.fromEntries(
        ["1", "2", "3", "4", "5"].map((d) => [d, [["09:00", "17:00"]]]),
      ),
    });
    await agent("calendars", {
      op: "assign",
      scope: "workspace",
      calendarId: "office",
    });
    const business = await agent("sla-policies", {
      op: "save",
      name: "Business",
      position: 0,
      hours: "business",
      conditions: { field: "tag", op: "eq", value: "business" },
      targets: { first_response: 4 * H },
    });
    await sql(
      "INSERT INTO tags(workspace_id,id,name) VALUES('a','business','Business')",
    );
    const office = await start("office");
    await teammate({
      action: "tag_add",
      conversationId: office,
      tagId: "business",
    });
    await runJob(db.connect, "a", business.body.jobId, handlers);
    assert.deepEqual(
      (
        await sql(
          "SELECT calendar_id,calendar_version FROM sla_clocks WHERE conversation_id=$1 AND metric='first_response'",
          [office],
        )
      )[0],
      { calendar_id: "office", calendar_version: 1 },
    );
    await agent("calendars", {
      op: "publish",
      id: "office",
      version: 1,
      name: "Office",
      timezone: "America/New_York",
      weekly: Object.fromEntries(
        ["1", "2", "3", "4", "5"].map((d) => [d, [["09:00", "17:00"]]]),
      ),
    });
    await teammate({
      action: "priority",
      conversationId: office,
      value: false,
    });
    assert.equal(
      (
        await sql(
          "SELECT calendar_version FROM sla_clocks WHERE conversation_id=$1 AND metric='first_response'",
          [office],
        )
      )[0].calendar_version,
      1,
      "a running clock keeps its version",
    );
    // Monday 16:00 London is 1 business hour before close: 4h is due 12:00 Tuesday, London.
    const monday = Date.parse("2026-01-12T16:00:00Z");
    await sql(
      "UPDATE sla_clocks SET calendar_version=1 WHERE conversation_id=$1",
      [office],
    );
    const dueLondon = await tenant(db.connect, "a", async (q) => {
      const { clock } = await import("../server/business-time");
      const { calendarVersion } = await import("../server/calendars");
      const cal = (await calendarVersion(q, "a", "office", 1))!;
      return clock(cal, 4 * H, [{ at: monday, type: "start" }], monday).dueAt;
    });
    assert.equal(
      new Date(dueLondon!).toISOString(),
      "2026-01-13T12:00:00.000Z",
    );

    // Internal tickets (no customer) have no SLA; other workspaces are untouched.
    await tenant(db.connect, "a", (q) =>
      saveTicketType(q, "a", "owner-a", {
        name: "Ops",
        category: "back_office",
        states: [
          { key: "open", name: "Open", kind: "submitted" },
          { key: "done", name: "Done", kind: "resolved" },
        ],
        transitions: [["open", "done"]],
      }),
    );
    const internal = await agent("tickets", {
      op: "create",
      typeId: "ops",
      title: "Check",
      conversationId: plain,
    });
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM sla_clocks WHERE conversation_id=$1",
          [internal.body.conversationId],
        )
      )[0].n,
      0,
    );
    const foreign = await start("foreign", "b");
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM sla_clocks WHERE conversation_id=$1",
          [foreign],
          "b",
        )
      )[0].n,
      0,
    );
    assert.equal(
      (
        await agent(
          "context?" + new URLSearchParams({ conversation: c }),
          undefined,
          "owner-b",
          "b",
        )
      ).status,
      404,
    );

    // The sidebar's SLA section.
    const ctx = (
      await agent("context?" + new URLSearchParams({ conversation: c }))
    ).body.sla;
    assert.equal(ctx.enabled, true);
    assert.equal(ctx.policy.name, "Standard");
    assert.deepEqual(
      ctx.clocks.map((k: any) => [k.metric, k.cycle, k.state, !!k.breachedAt]),
      [
        ["first_response", 0, "stopped", true],
        ["next_response", 2, "running", false],
        ["time_to_close", 0, "running", false],
      ],
    );
  } finally {
    await db.close();
  }
});
