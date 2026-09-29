import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { command, type Actor } from "../server/conversations";
import { RealtimeClient } from "../server/realtime";

test("inbox timeline opens on the newest parts, pages back without gaps or repeats, continues live, and guards its cursors", async () => {
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
  const owner: Actor = { type: "teammate", principal: "owner-a" };
  const run = (p: Parameters<typeof command>[4]) =>
    tenant(db.connect, "a", (q) =>
      command(q, "a", owner, crypto.randomUUID(), p),
    );
  const history = (
    id: string,
    before: string,
    principal = "owner-a",
    w = "a",
  ) =>
    agent(
      "history?" + new URLSearchParams({ conversation: id, before }),
      undefined,
      principal,
      w,
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
    await tenant(db.connect, "a", (q) =>
      q.query(
        "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')",
      ),
    );
    const boot: any = await (
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
            deviceToken: "timeline-device-token-".repeat(3),
            pageUrl: "https://shop.test",
          }),
        }),
        env,
      )
    ).json();
    const start = async (text: string) =>
      (
        (await (
          await handleApi(
            new Request("https://relay.test/v1/messenger/command", {
              method: "POST",
              headers: {
                origin: "https://shop.test",
                authorization: "Bearer " + boot.token,
                "content-type": "application/json",
                "idempotency-key": crypto.randomUUID(),
              },
              body: JSON.stringify({ action: "start", text }),
            }),
            env,
          )
        ).json()) as { conversationId: string }
      ).conversationId;
    const main = await start("Main conversation"),
      side = await start("Side conversation");
    // Interleave parts across two conversations, then merge: one timeline, two seq spaces.
    for (let i = 0; i < 110; i++) {
      await run({
        action: i % 5 === 0 ? "note" : "reply",
        conversationId: main,
        text: "Main " + i,
      });
      if (i < 60)
        await run({ action: "reply", conversationId: side, text: "Side " + i });
    }
    await run({ action: "merge", conversationId: side, targetId: main });
    const all = (
      await tenant(db.connect, "a", (q) =>
        q.query<{ id: string }>(
          "SELECT id FROM conversation_parts WHERE workspace_id='a' AND conversation_id IN ($1,$2) ORDER BY created_at,conversation_id,seq",
          [main, side],
        ),
      )
    ).rows.map((r) => r.id);
    assert(all.length > 150, "fixture spans a first screen and two pages");

    // Socket subscribe without a cursor: one frame holding the newest 50 parts, oldest first.
    const ticket = await agent("realtime-ticket", {});
    const frames: any[] = [];
    const client = new RealtimeClient(
      { send: (raw) => frames.push(JSON.parse(raw)), close: () => {} },
      env,
      () => {},
      "a",
    );
    await client.receive(
      JSON.stringify({ type: "authenticate", ticket: ticket.body.ticket }),
    );
    await client.receive(
      JSON.stringify({ type: "subscribe", conversationId: main }),
    );
    const timelines = () => frames.filter((f) => f.type === "timeline");
    assert.equal(timelines().length, 1);
    const first = timelines()[0];
    assert.equal(first.reset, true);
    assert.equal(first.hasMore, false);
    assert.deepEqual(
      first.parts.map((p: any) => p.id),
      all.slice(-50),
    );
    assert(first.parts.some((p: any) => p.kind === "internal_note"));
    assert(typeof first.older === "string");

    // Paging back returns every earlier part exactly once, in order.
    let loaded: string[] = first.parts.map((p: any) => p.id);
    let older: string | null = first.older;
    let pages = 0;
    while (older) {
      const page = await history(main, older);
      assert.equal(page.status, 200);
      assert(page.body.parts.length <= 100);
      loaded = [...page.body.parts.map((p: any) => p.id), ...loaded];
      older = page.body.older;
      pages++;
    }
    assert.equal(pages, 2);
    assert.deepEqual(loaded, all);

    // Live continuation starts exactly after the first screen: only the new part arrives.
    const reply = await run({
      action: "reply",
      conversationId: main,
      text: "Arrived after opening",
    });
    await client.notify(main);
    const live = timelines().at(-1);
    assert.equal(live.reset, false);
    assert.deepEqual(
      live.parts.map((p: any) => p.id),
      [(reply as any).partId],
    );

    // Cursors are bound to workspace, teammate, conversation and timeline revision.
    const cursor = first.older as string;
    assert.equal((await history(main, cursor, "agent-1-a")).status, 403);
    assert.equal((await history(side, cursor)).status, 403);
    assert.equal((await history(main, cursor, "owner-b", "b")).status, 403);
    assert.equal(
      (await history(main, cursor.slice(0, -4) + "AAAA")).status,
      401,
    );
    assert.equal((await history(main, "")).status, 401);
    const customer = await handleApi(
      new Request(
        "https://relay.test/v1/agent/history?" +
          new URLSearchParams({ conversation: main, before: cursor }),
        { headers: { authorization: "Bearer " + boot.token } },
      ),
      env,
    );
    assert.equal(
      customer.status,
      401,
      "customer credentials never reach agent history",
    );
    const third = await start("Third conversation");
    await run({ action: "merge", conversationId: third, targetId: main });
    const stale = await history(main, cursor);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "CURSOR_INVALID");
  } finally {
    await db.close();
  }
});
