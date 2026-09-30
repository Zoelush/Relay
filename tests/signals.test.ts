import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { RealtimeClient, fanOutSignal } from "../server/realtime";

test("signals: viewing and note typing reach teammates only; reply typing reaches the customer; joins, refreshes and leaves are announced", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const ticket = async (principal: string, workspace: string) =>
    (
      (await (
        await bridgeAgentRequest(
          new Request("https://app.test/api/agent/realtime-ticket", {
            method: "POST",
            headers: {
              origin: "https://app.test",
              "content-type": "application/json",
              "idempotency-key": crypto.randomUUID(),
            },
            body: "{}",
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
        )
      ).json()) as { ticket: string }
    ).ticket;
  // Every connection is routed through the same fan-out the Worker and local relay use.
  const clients = new Set<RealtimeClient>();
  const frames = new Map<RealtimeClient, any[]>();
  const connect = async (authTicket: string, workspace: string) => {
    const received: any[] = [];
    const client: RealtimeClient = new RealtimeClient(
      { send: (raw) => received.push(JSON.parse(raw)), close: () => {} },
      env,
      (sender, data) => fanOutSignal(clients, sender, data),
      workspace,
    );
    clients.add(client);
    frames.set(client, received);
    await client.receive(
      JSON.stringify({ type: "authenticate", ticket: authTicket }),
    );
    return client;
  };
  const signals = (client: RealtimeClient) =>
    frames
      .get(client)!
      .filter((f) => ["viewing", "typing", "presence"].includes(f.type));
  const reset = () => frames.forEach((list) => (list.length = 0));
  const send = (client: RealtimeClient, frame: Record<string, unknown>) =>
    client.receive(JSON.stringify(frame));
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
        "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','grace','grace-a','Grace','agent')",
      ),
    );
    const boot = (await handleApi(
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
          deviceToken: "signals-device-token-".repeat(3),
          pageUrl: "https://shop.test",
        }),
      }),
      env,
    ).then((r) => r.json())) as any;
    const id = (
      (await handleApi(
        new Request("https://relay.test/v1/messenger/command", {
          method: "POST",
          headers: {
            origin: "https://shop.test",
            authorization: "Bearer " + boot.token,
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify({ action: "start", text: "Signals" }),
        }),
        env,
      ).then((r) => r.json())) as any
    ).conversationId as string;

    const owner = await connect(await ticket("owner-a", "a"), "a");
    const grace = await connect(await ticket("grace-a", "a"), "a");
    const customer = await connect(boot.realtime.ticket, "a");
    const elsewhere = await connect(await ticket("owner-b", "b"), "b");
    for (const c of [owner, customer])
      await send(c, { type: "subscribe", conversationId: id });
    reset();

    // Grace joins: the owner sees her arrive, and she learns the owner is already there.
    await send(grace, { type: "subscribe", conversationId: id });
    assert.deepEqual(
      signals(owner).map((f) => [f.type, f.teammateId, f.active, f.joined]),
      [["viewing", "grace", true, true]],
    );
    assert.deepEqual(
      signals(grace).map((f) => [f.type, f.teammateId, f.active]),
      [["viewing", "owner", true]],
    );
    assert.deepEqual(
      signals(customer),
      [],
      "customers never see who is viewing",
    );
    assert.deepEqual(signals(elsewhere), []);

    // Note typing, and typing without a mode, stay with teammates; reply typing reaches the customer.
    for (const [frame, customerSees] of [
      [
        { type: "typing", conversationId: id, active: true, mode: "note" },
        false,
      ],
      [{ type: "typing", conversationId: id, active: true }, false],
      [
        { type: "typing", conversationId: id, active: true, mode: "whisper" },
        false,
      ],
      [
        { type: "typing", conversationId: id, active: true, mode: "reply" },
        true,
      ],
    ] as const) {
      reset();
      await new Promise((r) => setTimeout(r, 210)); // server throttle between typing frames
      await send(grace, frame);
      const toOwner = signals(owner);
      assert.equal(toOwner.length, 1);
      assert.equal(toOwner[0].collision, true);
      assert.equal(toOwner[0].mode, frame.mode === "reply" ? "reply" : "note");
      assert.equal(
        signals(customer).length,
        customerSees ? 1 : 0,
        JSON.stringify(frame),
      );
      assert.deepEqual(signals(grace), [], "never echoed to the sender");
      assert.deepEqual(signals(elsewhere), []);
    }

    // A stop signal is never throttled and does not use up the window for the next active one
    // (a mode switch sends both back to back).
    reset();
    await new Promise((r) => setTimeout(r, 210));
    await send(grace, {
      type: "typing",
      conversationId: id,
      active: false,
      mode: "note",
    });
    await send(grace, {
      type: "typing",
      conversationId: id,
      active: true,
      mode: "reply",
    });
    assert.deepEqual(
      signals(owner).map((f) => [f.active, f.mode]),
      [
        [false, "note"],
        [true, "reply"],
      ],
    );

    // Customer typing reaches both teammates, without a collision flag.
    reset();
    await send(customer, { type: "typing", conversationId: id, active: true });
    for (const c of [owner, grace]) {
      assert.equal(signals(c).length, 1);
      assert.equal(signals(c)[0].authorType, "contact");
      assert.equal(signals(c)[0].collision, undefined);
    }

    // Presence goes to teammates in the workspace only.
    reset();
    await send(owner, { type: "presence", status: "away" });
    assert.equal(signals(grace)[0].type, "presence");
    assert.deepEqual(signals(customer), []);
    assert.deepEqual(signals(elsewhere), []);

    // "Still viewing" refreshes reach teammates, at most every five seconds per conversation.
    reset();
    await send(grace, { type: "viewing", conversationId: id });
    await send(grace, { type: "viewing", conversationId: id });
    assert.equal(signals(owner).length, 1);
    assert(signals(owner)[0].expiresAt > Date.now() + 40_000);
    assert.deepEqual(signals(customer), []);
    // Customers cannot send viewing signals at all.
    await send(customer, { type: "viewing", conversationId: id });
    assert(
      frames
        .get(customer)!
        .some((f) => f.type === "error" && f.code === "INVALID_FRAME"),
    );

    // Leaving: unsubscribing and a closed socket both announce it.
    reset();
    await send(grace, { type: "unsubscribe", conversationId: id });
    assert.deepEqual(
      signals(owner).map((f) => [f.type, f.teammateId, f.active]),
      [["viewing", "grace", false]],
    );
    await send(grace, { type: "subscribe", conversationId: id });
    reset();
    owner.leave();
    clients.delete(owner);
    assert.deepEqual(
      signals(grace).map((f) => [f.type, f.teammateId, f.active]),
      [["viewing", "owner", false]],
    );
    assert.deepEqual(signals(customer), []);
  } finally {
    await db.close();
  }
});
