import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { testDatabase } from "./database";
import { seedFoundation } from "../server/people";
import { tenant, digest } from "../server/db";
import { handleApi, type ApiEnvironment } from "../server/api";
import type { AttachmentStorage } from "../server/attachments";
import { RealtimeClient } from "../server/realtime";
import { readFile } from "node:fs/promises";

test("HTTP isolation matrix: every messenger/agent route keeps credentials in their workspace", async () => {
  const db = await testDatabase(),
    storage: AttachmentStorage = {
      signUpload: async () => ({
        url: "https://example.invalid/upload",
        headers: {},
        expiresAt: "",
      }),
      getQuarantine: async () => null,
      scan: async () => {
        throw new Error("Test does not scan");
      },
      putClean: async () => {},
      deleteQuarantine: async () => {},
      signDownload: async () => ({
        url: "https://example.invalid/download",
        expiresAt: "",
      }),
    };
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    attachments: storage,
    realtimeUrl: "wss://relay.example/realtime",
  };
  const call = (
    path: string,
    body?: unknown,
    token?: string,
    key = crypto.randomUUID(),
  ) =>
    handleApi(
      new Request("https://relay.example" + path, {
        method: body ? "POST" : "GET",
        headers: {
          origin: "https://shop.example",
          authorization: "Bearer " + (token ?? ""),
          "content-type": "application/json",
          "idempotency-key": key,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env,
    );
  const agent = async (w: string, path: string, body?: unknown) => {
    const url = new URL(path, "https://relay.example"),
      key = crypto.randomUUID();
    const jwt = await new SignJWT({
      workspace: w,
      principal: "owner-" + w,
      method: body ? "POST" : "GET",
      path: url.pathname,
      query: url.search,
      ...(body ? { digest: await digest(body), key } : {}),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("relay-sites")
      .setAudience("relay-agent")
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(new TextEncoder().encode(env.bridgeSecret));
    return call(path, body, jwt, key);
  };
  try {
    for (const w of ["a", "b"])
      await tenant(db.connect, w, (sql) =>
        seedFoundation(sql, w, "owner-" + w, {
          origins: ["https://shop.example"],
          master: env.identityMaster,
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        }),
      );
    const sessions: Record<string, any> = {};
    for (const workspaceId of ["a", "b"]) {
      const r = await call("/v1/messenger/boot", {
        workspaceId,
        brandId: "default",
        deviceToken: "same-device-token-with-tenant-scope",
        pageUrl: "https://shop.example/original",
        locale: "en",
      });
      assert.equal(r.status, 200);
      sessions[workspaceId] = await r.json();
    }
    const a = sessions.a,
      b = sessions.b;
    const created = (await (
      await call(
        "/v1/messenger/command",
        { action: "start", text: "Private workspace A" },
        a.token,
      )
    ).json()) as any;
    const id = created.conversationId;
    const reply = (await (
      await agent("a", "/v1/agent/command", {
        action: "reply",
        conversationId: id,
        text: "Private agent response",
      })
    ).json()) as any;
    const attachment = (await (
      await call(
        "/v1/messenger/attachment/prepare",
        { conversationId: id, name: "file.txt", size: 5, type: "text/plain" },
        a.token,
      )
    ).json()) as any;
    for (const path of [
      "/v1/messenger/history?conversation=" + id,
      "/v1/messenger/job?id=" + reply.metricsJobId,
      "/v1/messenger/attachment?id=" + attachment.attachmentId,
    ])
      assert.equal((await call(path, undefined, b.token)).status, 404, path);
    for (const [path, body] of [
      [
        "/v1/messenger/command",
        { action: "reply", conversationId: id, text: "Cross tenant" },
      ],
      ["/v1/messenger/read", { conversationId: id, partId: reply.partId }],
      [
        "/v1/messenger/attachment/prepare",
        { conversationId: id, name: "file.txt", size: 5, type: "text/plain" },
      ],
      [
        "/v1/messenger/attachment/complete",
        { attachmentId: attachment.attachmentId },
      ],
    ] as const)
      assert.equal((await call(path, body, b.token)).status, 404, path);
    assert.deepEqual(
      (
        (await (
          await call(
            "/v1/messenger/conversations?workspace=a",
            undefined,
            b.token,
          )
        ).json()) as any
      ).conversations,
      [],
    );
    assert.equal(
      (
        (await (
          await call("/v1/messenger/unread?workspace=a", undefined, b.token)
        ).json()) as any
      ).unread_count,
      0,
    );
    assert.equal(
      (
        await call(
          "/v1/messenger/context",
          { workspaceId: "a", pageUrl: "https://shop.example/changed" },
          b.token,
        )
      ).status,
      200,
    );
    const aContext = await tenant(db.connect, "a", (sql) =>
      sql.query<{ page_url: string }>(
        "SELECT page_url FROM messenger_sessions WHERE workspace_id=$1 AND id=$2",
        ["a", a.session.sessionId],
      ),
    );
    assert.equal(aContext.rows[0].page_url, "https://shop.example/original");
    const ticket = (await (
        await call("/v1/messenger/realtime-ticket", {}, b.token)
      ).json()) as any,
      frames: any[] = [];
    const socket = new RealtimeClient(
      { send: (raw) => frames.push(JSON.parse(raw)), close: () => {} },
      env,
      () => {},
      "a",
    );
    await socket.receive(
      JSON.stringify({ type: "authenticate", ticket: ticket.ticket }),
    );
    assert(frames.some((f) => f.code === "FORBIDDEN"));
    assert.equal(socket.session, undefined);
    for (const path of [
      "/v1/agent/inbox?conversation=" + id,
      "/v1/agent/job?id=" + reply.metricsJobId,
    ])
      assert.equal((await agent("b", path)).status, 404, path);
    assert.deepEqual(
      ((await (await agent("b", "/v1/agent/search?q=Private")).json()) as any)
        .conversations,
      [],
    );
    assert.equal(
      (
        await agent("b", "/v1/agent/command", {
          action: "close",
          conversationId: id,
        })
      ).status,
      404,
    );
    const reindex = await agent("b", "/v1/agent/search/reindex", {});
    assert.equal(reindex.status, 202);
    const job = (await reindex.json()) as any;
    assert.equal(
      (await agent("a", "/v1/agent/job?id=" + job.jobId)).status,
      404,
    );
    const rebuild = await agent("b", "/v1/agent/unread/rebuild", {});
    assert.equal(rebuild.status, 202);
    const rebuildJob = (await rebuild.json()) as any;
    assert.equal(
      (await agent("a", "/v1/agent/job?id=" + rebuildJob.jobId)).status,
      404,
    );
    const agentTicket = (await (
      await agent("b", "/v1/agent/realtime-ticket", {})
    ).json()) as any;
    await socket.receive(
      JSON.stringify({ type: "authenticate", ticket: agentTicket.ticket }),
    );
    assert.equal(socket.session, undefined);
    assert.equal(
      (await call("/v1/messenger/logout", { workspaceId: "a" }, b.token))
        .status,
      200,
    );
    assert.equal(
      (await call("/v1/messenger/unread", undefined, b.token)).status,
      401,
    );
    assert.equal(
      (await call("/v1/messenger/unread", undefined, a.token)).status,
      200,
    );
    // Every application table has both a tenant column and forced RLS, including new history/projection tables.
    const tables = await db.pg.query<{
      table_name: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      "SELECT c.relname AS table_name,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'",
    );
    for (const table of tables.rows) {
      assert(
        table.relrowsecurity && table.relforcerowsecurity,
        table.table_name,
      );
      assert.equal(
        (
          await tenant(db.connect, "b", (sql) =>
            sql.query(
              'SELECT * FROM "' + table.table_name + '" WHERE workspace_id=$1',
              ["a"],
            ),
          )
        ).rows.length,
        0,
        table.table_name,
      );
    }
    const rollback = await readFile(
      "db/rollback/0011_customer_unread.sql",
      "utf8",
    );
    await tenant(db.connect, "a", () => db.pg.exec(rollback));
    assert.equal(
      (await call("/v1/messenger/unread", undefined, a.token)).status,
      401,
    );
    const retryBoot = {
      workspaceId: "a",
      brandId: "default",
      deviceToken: "rollback-scope-device-".repeat(3),
      pageUrl: "https://shop.example/",
    };
    assert.equal((await call("/v1/messenger/boot", retryBoot)).status, 404);
    assert.equal(
      (await call("/v1/messenger/boot", { ...retryBoot, workspaceId: "b" }))
        .status,
      200,
    );
    assert.equal(
      (await agent("a", "/v1/agent/inbox?conversation=" + id)).status,
      200,
    );
  } finally {
    await db.close();
  }
});
