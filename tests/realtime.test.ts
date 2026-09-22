import test from "node:test";
import assert from "node:assert/strict";
import { startLocalRelay } from "../scripts/local-relay";
import { RealtimeClient } from "../server/realtime";
import { notifyWorkspace } from "../server/realtime-batch";
import { tenant } from "../server/db";

// Transport is in-process; HTTP/SQL/auth/cursor paths are the same as the browser client.
test("live subscribers follow both aliases through repeated merges and can edit original replies", async () => {
  const relay = await startLocalRelay({ apiPort: 8878, hostPort: 8879 });
  try {
    const boot = (await (
      await fetch(relay.apiOrigin + "/v1/messenger/boot", {
        method: "POST",
        headers: {
          origin: relay.hostOrigin,
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          workspaceId: "demo",
          brandId: "default",
          deviceToken: "alias-device-token-".repeat(3),
          pageUrl: relay.hostOrigin,
        }),
      })
    ).json()) as any;
    const post = async (body: unknown) => {
      const r = await fetch(relay.apiOrigin + "/v1/messenger/command", {
        method: "POST",
        headers: {
          authorization: "Bearer " + boot.token,
          origin: relay.hostOrigin,
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 200);
      return r.json() as Promise<any>;
    };
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push(
        (await post({ action: "start", text: "Timeline " + i })).conversationId,
      );
    const originalReply = (await (
      await relay.agent({
        action: "reply",
        conversationId: ids[0],
        text: "Original reply",
      })
    ).json()) as any;
    const frames: any[] = [],
      client = new RealtimeClient(
        { send: (raw) => frames.push(JSON.parse(raw)), close: () => {} },
        relay.env,
        () => {},
        "demo",
      );
    await client.receive(
      JSON.stringify({ type: "authenticate", ticket: boot.realtime.ticket }),
    );
    await client.receive(
      JSON.stringify({ type: "subscribe", conversationId: ids[0] }),
    );
    for (const [source, target] of [
      [ids[0], ids[1]],
      [ids[1], ids[2]],
    ]) {
      assert.equal(
        (
          await relay.agent({
            action: "merge",
            conversationId: source,
            targetId: target,
          })
        ).status,
        200,
      );
      await notifyWorkspace(relay.db.connect, "demo", [client], target);
      const frame = frames.filter((f) => f.type === "timeline").at(-1);
      assert.equal(frame.conversation.id, target);
      assert.equal(frame.reset, true);
    }
    assert.equal(
      (
        await relay.agent({
          action: "edit",
          conversationId: ids[0],
          partId: originalReply.partId,
          text: "Edited after merge",
        })
      ).status,
      200,
    );
    await notifyWorkspace(relay.db.connect, "demo", [client], ids[2]);
    assert(
      frames
        .filter((f) => f.type === "timeline")
        .at(-1)
        .parts.some((p: any) => p.body === "Edited after merge"),
    );
    for (const id of ids) {
      const response = (await (
        await relay.agent(undefined, "demo", "?conversation=" + id)
      ).json()) as any;
      assert.equal(response.conversation.id, ids[2]);
      assert.equal(
        new Set(response.parts.map((p: any) => p.id)).size,
        response.parts.length,
      );
    }
  } finally {
    await relay.close();
  }
});

test("local jobs persist completion and push status over the shared socket without client polling", async () => {
  const relay = await startLocalRelay({ apiPort: 8888, hostPort: 8889 });
  try {
    const authorization = (await (
      await relay.agent({}, "demo", "", "/v1/agent/realtime-ticket")
    ).json()) as { ticket: string };
    const queued = await relay.agent(
      {},
      "demo",
      "",
      "/v1/agent/unread/rebuild",
    );
    assert.equal(queued.status, 202);
    const { jobId } = (await queued.json()) as { jobId: string };
    let finished!: (value: unknown) => void;
    const done = new Promise((resolve) => {
      finished = resolve;
    });
    const client = new RealtimeClient(
      {
        send: (raw) => {
          const data = JSON.parse(raw);
          if (
            data.type === "job" &&
            data.id === jobId &&
            data.state === "succeeded"
          )
            finished(data);
        },
        close: () => {},
      },
      relay.env,
      () => {},
      "demo",
    );
    relay.clients.add(client);
    await client.receive(
      JSON.stringify({ type: "authenticate", ticket: authorization.ticket }),
    );
    await client.receive(JSON.stringify({ type: "subscribe_job", jobId }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        done,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("No completion was pushed")),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const events = await tenant(relay.db.connect, "demo", (db) =>
      db.query<{ state: string }>(
        "SELECT state FROM job_events WHERE workspace_id=$1 AND job_id=$2 ORDER BY version",
        ["demo", jobId],
      ),
    );
    assert.deepEqual(
      events.rows.map((r) => r.state),
      ["queued", "running", "succeeded"],
    );
    relay.clients.delete(client);
  } finally {
    await relay.close();
  }
});
