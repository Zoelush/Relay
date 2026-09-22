import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import {
  bridgeAgentRequest,
  legacyWritesEnabled,
  postgresInboxEnabled,
  type AgentBridgeConfig,
} from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { attachmentScan, type AttachmentStorage } from "../server/attachments";
import { runJob } from "../server/jobs";
import { RealtimeClient } from "../server/realtime";
import { customerVisiblePart } from "../server/delivery-policy";

test("inbox flag preserves the legacy screen without silently reopening D1 writes", () => {
  assert.equal(postgresInboxEnabled({}), false);
  assert.equal(legacyWritesEnabled({}), true);
  assert.equal(legacyWritesEnabled({ RELAY_AGENT_INBOX_V1: "true" }), false);
  assert.equal(
    legacyWritesEnabled({
      RELAY_AGENT_INBOX_V1: "false",
      RELAY_STORAGE_AUTHORITY: "postgres",
    }),
    false,
  );
  assert.equal(
    legacyWritesEnabled({
      RELAY_AGENT_INBOX_V1: "false",
      RELAY_STORAGE_AUTHORITY: "d1",
    }),
    true,
  );
});

test("authenticated bridge, tenant route isolation, private note/attachment replay and copied-link denial", async () => {
  const db = await testDatabase();
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  let signedDownloads = 0;
  let reads = 0;
  const storage: AttachmentStorage = {
    signUpload: async (key) => ({
      url: "https://private.invalid/" + key,
      headers: {},
      expiresAt: "",
    }),
    getQuarantine: async (key) => objects.get(key) ?? null,
    scan: async () => "clean",
    putClean: async (key, bytes, type) => {
      objects.set(key, { bytes, type });
    },
    preview: async (bytes) => bytes,
    deleteQuarantine: async (key) => {
      objects.delete(key);
    },
    signDownload: async () => {
      signedDownloads++;
      return { url: "https://private.invalid/public-only", expiresAt: "" };
    },
    readClean: async (key) => {
      reads++;
      const data = objects.get(key);
      return data
        ? new Response(data.bytes as BodyInit, {
            headers: { "content-type": data.type },
          })
        : new Response(null, { status: 404 });
    },
  };
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    attachments: storage,
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const config: AgentBridgeConfig = {
    RELAY_AGENT_INBOX_V1: "true",
    RELAY_STORAGE_AUTHORITY: "postgres",
    RELAY_API_ORIGIN: "https://relay.test",
    RELAY_WORKSPACE_ID: "a",
    RELAY_BRIDGE_SECRET: env.bridgeSecret,
  };
  const send = (r: Request) => handleApi(r, env);
  const agent = (
    path: string,
    data?: unknown,
    workspace = "a",
    principal: string | undefined = "owner-a",
    key = crypto.randomUUID(),
    origin = "https://app.test",
  ) =>
    bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "idempotency-key": key,
          authorization: "Bearer untrusted-browser-value",
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      principal,
      { ...config, RELAY_WORKSPACE_ID: workspace },
      send,
    );
  const customer = (path: string, data?: unknown, token?: string) =>
    handleApi(
      new Request("https://relay.test/v1/messenger/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          origin: "https://shop.test",
          authorization: "Bearer " + (token ?? ""),
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      env,
    );
  try {
    for (const workspace of ["a", "b"])
      await tenant(db.connect, workspace, (sql) =>
        seedFoundation(sql, workspace, "owner-" + workspace, {
          origins: ["https://shop.test"],
          master: env.identityMaster,
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        }),
      );
    const boot: any = await (
      await customer("boot", {
        workspaceId: "a",
        brandId: "default",
        deviceToken: "privacy-device-token".repeat(3),
        pageUrl: "https://shop.test",
      })
    ).json();
    const started: any = await (
      await customer(
        "command",
        { action: "start", text: "Customer-visible greeting" },
        boot.token,
      )
    ).json();
    const id = started.conversationId;
    const inbox = await agent("inbox");
    assert.equal(inbox.status, 200);
    assert.equal(inbox.headers.get("x-relay-storage"), "postgresql");
    assert.equal(((await inbox.json()) as any).conversations[0].id, id);
    assert.equal(
      (await agent("inbox", undefined, "a", "outsider")).status,
      403,
    );
    assert.equal(
      (
        await bridgeAgentRequest(
          new Request("https://app.test/api/agent/inbox"),
          undefined,
          config,
          send,
        )
      ).status,
      401,
    );
    assert.equal(
      (await agent("inbox?conversation=" + id, undefined, "b", "owner-b"))
        .status,
      404,
    );
    assert.equal(
      (
        await agent(
          "command",
          { action: "note", conversationId: id, text: "Intrusion" },
          "b",
          "owner-b",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await agent(
          "command",
          { action: "note", conversationId: id, text: "Cross-origin" },
          "a",
          "owner-a",
          crypto.randomUUID(),
          "https://evil.test",
        )
      ).status,
      403,
    );
    const secret = "private-note-" + crypto.randomUUID();
    const note: any = await (
      await agent("command", {
        action: "note",
        conversationId: id,
        text: secret,
        audience: "public",
      })
    ).json();
    assert(note.partId);
    await agent("command", {
      action: "edit",
      conversationId: id,
      partId: note.partId,
      text: secret + " edited",
    });
    const history: any = await (
      await customer("history?conversation=" + id, undefined, boot.token)
    ).json();
    assert(!JSON.stringify(history).includes(secret));
    assert(
      JSON.stringify(
        await (await agent("inbox?conversation=" + id)).json(),
      ).includes(secret),
    );
    assert.equal(
      customerVisiblePart({ kind: "internal_note", audience: "public" }),
      false,
    );
    assert.equal(
      customerVisiblePart({
        kind: "attachment",
        audience: "public",
        attachment_audience: "internal",
      }),
      false,
    );
    const prepared = await agent("attachment/prepare", {
      conversationId: id,
      name: "private.txt",
      size: secret.length,
      type: "text/plain",
      audience: "internal",
    });
    assert.equal(prepared.status, 200);
    const file: any = await prepared.json();
    const metadata = await tenant(
      db.connect,
      "a",
      async (sql) =>
        (
          await sql.query<{ object_key: string }>(
            "SELECT object_key FROM attachments WHERE workspace_id=$1 AND id=$2",
            ["a", file.attachmentId],
          )
        ).rows[0],
    );
    objects.set(metadata.object_key, {
      bytes: new TextEncoder().encode(secret),
      type: "text/plain",
    });
    const done = await agent("attachment/complete", {
      attachmentId: file.attachmentId,
    });
    assert.equal(done.status, 202);
    const job: any = await done.json();
    assert.equal(
      (
        await runJob(db.connect, "a", job.jobId, {
          "attachment.scan": (job) => attachmentScan(db.connect, storage, job),
        })
      ).state,
      "succeeded",
    );
    const direct = "attachment/content?id=" + file.attachmentId;
    const allowed = await agent(direct);
    assert.equal(allowed.status, 200);
    assert.equal(await allowed.text(), secret);
    assert.equal(allowed.headers.get("cache-control"), "private, no-store");
    assert.equal(
      signedDownloads,
      0,
      "internal files must never mint a transferable GET link",
    );
    const readsBefore = reads;
    for (const suffix of ["", "&preview=true"]) {
      assert.equal(
        (
          await customer(
            "attachment?id=" + file.attachmentId + suffix,
            undefined,
            boot.token,
          )
        ).status,
        404,
      );
      assert.equal(
        (await agent(direct + suffix, undefined, "b", "owner-b")).status,
        404,
      );
      assert.equal(
        (
          await bridgeAgentRequest(
            new Request("https://app.test/api/agent/" + direct + suffix, {
              headers: { authorization: "Bearer " + boot.token },
            }),
            undefined,
            config,
            send,
          )
        ).status,
        401,
      );
      assert.equal(
        (
          await handleApi(
            new Request("https://relay.test/v1/agent/" + direct + suffix, {
              headers: { authorization: "Bearer " + boot.token },
            }),
            env,
          )
        ).status,
        401,
      );
    }
    assert.equal(
      reads,
      readsBefore,
      "denied direct and preview URLs must not fetch storage bytes",
    );
    assert.equal(
      (
        await agent(
          "attachment/prepare",
          {
            conversationId: id,
            name: "x.txt",
            size: 1,
            type: "text/plain",
            audience: "internal",
          },
          "b",
          "owner-b",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await agent(
          "attachment/complete",
          { attachmentId: file.attachmentId },
          "b",
          "owner-b",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await customer(
          "attachment/complete",
          { attachmentId: file.attachmentId },
          boot.token,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await customer(
          "attachment/prepare",
          {
            conversationId: id,
            name: "x.txt",
            size: 1,
            type: "text/plain",
            audience: "internal",
          },
          boot.token,
        )
      ).status,
      403,
    );
    const frames: any[] = [];
    const client = new RealtimeClient(
      { send: (raw) => frames.push(JSON.parse(raw)), close: () => {} },
      env,
      () => {},
      "a",
    );
    await client.receive(
      JSON.stringify({ type: "authenticate", ticket: boot.realtime.ticket }),
    );
    await client.receive(
      JSON.stringify({ type: "subscribe", conversationId: id }),
    );
    const replay = JSON.stringify(frames);
    assert(!replay.includes(secret));
    assert(!replay.includes(file.attachmentId));
    assert(replay.includes("Customer-visible greeting"));
    const unread: any = await (
      await customer("unread", undefined, boot.token)
    ).json();
    assert.equal(unread.unread_count, 0);
    // A real public reply still delivers through the same boundary.
    await agent("command", {
      action: "reply",
      conversationId: id,
      text: "Public response",
    });
    await client.notify(id);
    assert(JSON.stringify(frames).includes("Public response"));
    assert(!JSON.stringify(frames).includes(secret));
    // Workspace-specific exposure rollback retains privacy and the other workspace.
    await tenant(db.connect, "a", async (sql) =>
      sql.query(
        await readFile("db/rollback/0013_agent_inbox_privacy.sql", "utf8"),
      ),
    );
    assert.equal((await agent("inbox")).status, 404);
    assert.equal((await agent("inbox", undefined, "b", "owner-b")).status, 200);
    assert.equal(
      (
        await customer(
          "attachment?id=" + file.attachmentId,
          undefined,
          boot.token,
        )
      ).status,
      404,
    );
  } finally {
    await db.close();
  }
});
