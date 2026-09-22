import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { testDatabase } from "./database";
import { seedFoundation } from "../server/people";
import { tenant, digest } from "../server/db";
import { handleApi, type ApiEnvironment } from "../server/api";
import { identityIssuer } from "../server/identity";
const secret = new TextEncoder().encode(
  "test-only-customer-signing-secret-32-bytes",
);

test("HTTP: forged identity rejected; tenant/session isolation; chat reply, cycle, merge and append-only enforcement", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "test-only-session-signing-secret-32-bytes",
    identityMaster: "test-only-identity-wrapping-key-32-bytes",
    bridgeSecret: "test-only-bridge-signing-secret-32-bytes",
  };
  const call = async (
    path: string,
    data?: unknown,
    token?: string,
    key = crypto.randomUUID(),
  ) =>
    handleApi(
      new Request("https://relay.example" + path, {
        method: data ? "POST" : "GET",
        headers: {
          origin: "https://shop.example",
          "content-type": "application/json",
          ...(token ? { authorization: "Bearer " + token } : {}),
          "idempotency-key": key,
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      }),
      env,
    );
  try {
    for (const w of ["a", "b"])
      await tenant(db.connect, w, (sql) =>
        seedFoundation(sql, w, "owner-" + w, {
          origins: ["https://shop.example"],
          master: env.identityMaster,
          identitySecret: secret,
          enable: true,
        }),
      );
    const deviceToken = "device-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const base = {
      workspaceId: "a",
      brandId: "default",
      deviceToken,
      pageUrl: "https://shop.example/products?secret=removed",
      locale: "en",
    };
    const jwt = await new SignJWT({ workspace_id: "a", email: "u@example.com" })
      .setProtectedHeader({ alg: "HS256", kid: "initial" })
      .setSubject("u")
      .setIssuer(identityIssuer("a"))
      .setAudience("relay-messenger")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("forged-secret-not-valid"));
    assert.equal(
      (
        await call("/v1/messenger/boot", {
          ...base,
          user: { userId: "u", email: "u@example.com", jwt },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call("/v1/messenger/boot", {
          ...base,
          user: { userId: "u", email: "u@example.com" },
        })
      ).status,
      401,
    );
    const boot = await call("/v1/messenger/boot", base);
    assert.equal(boot.status, 200);
    const a = (await boot.json()) as any;
    const b = (await (
      await call("/v1/messenger/boot", { ...base, workspaceId: "b" })
    ).json()) as any;
    const post = async (p: unknown, token = a.token) => {
      const r = await call("/v1/messenger/command", p, token);
      const data = (await r.json()) as any;
      assert.equal(r.status, 200, JSON.stringify(data));
      return data;
    };
    const first = await post({ action: "start", text: "Hello" });
    const second = await post({ action: "start", text: "Second thread" });
    assert.equal(
      (
        await call(
          "/v1/messenger/history?conversation=" + first.conversationId,
          undefined,
          b.token,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          "/v1/messenger/command",
          {
            action: "reply",
            conversationId: first.conversationId,
            text: "intrude",
          },
          b.token,
        )
      ).status,
      404,
    );
    const agent = async (p: unknown) => {
      const key = crypto.randomUUID(),
        path = "/v1/agent/command";
      const proof = await new SignJWT({
        workspace: "a",
        principal: "owner-a",
        method: "POST",
        path,
        digest: await digest(p),
        key,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("relay-sites")
        .setAudience("relay-agent")
        .setIssuedAt()
        .setExpirationTime("1m")
        .sign(new TextEncoder().encode(env.bridgeSecret));
      const r = await call(path, p, proof, key);
      const data = (await r.json()) as any;
      assert.equal(r.status, 200, JSON.stringify(data));
      return data;
    };
    await agent({
      action: "note",
      conversationId: first.conversationId,
      text: "Secret note",
    });
    await agent({
      action: "reply",
      conversationId: first.conversationId,
      text: "Hi there",
    });
    await agent({ action: "close", conversationId: first.conversationId });
    await agent({ action: "reopen", conversationId: first.conversationId });
    const before = (await (
      await call(
        "/v1/messenger/history?conversation=" + first.conversationId,
        undefined,
        a.token,
      )
    ).json()) as any;
    assert(!before.parts.some((p: any) => p.body === "Secret note"));
    assert(before.parts.some((p: any) => p.body === "Hi there"));
    await agent({
      action: "merge",
      conversationId: second.conversationId,
      targetId: first.conversationId,
    });
    for (const id of [first.conversationId, second.conversationId]) {
      const history = (await (
        await call(
          "/v1/messenger/history?conversation=" + id,
          undefined,
          a.token,
        )
      ).json()) as any;
      assert.equal(history.conversation.id, first.conversationId);
      assert.equal(
        history.parts.filter((p: any) => p.body === "Hello").length,
        1,
      );
      assert.equal(
        history.parts.filter((p: any) => p.body === "Second thread").length,
        1,
      );
    }
    await assert.rejects(
      tenant(db.connect, "a", (sql) =>
        sql.query(
          "UPDATE conversation_parts SET body=$1 WHERE workspace_id=$2",
          ["tampered", "a"],
        ),
      ),
      /append-only/,
    );
    const cycles = await tenant(db.connect, "a", (sql) =>
      sql.query(
        "SELECT * FROM conversation_cycles WHERE workspace_id=$1 AND conversation_id=$2",
        ["a", first.conversationId],
      ),
    );
    assert.equal(cycles.rows.length, 2);
    // The single-transaction command path must still enforce all session gates.
    const reply = {
      action: "reply",
      conversationId: first.conversationId,
      text: "Must not be stored",
    };
    const deniedOrigin = await handleApi(
      new Request("https://relay.example/v1/messenger/command", {
        method: "POST",
        headers: {
          origin: "https://untrusted.example",
          authorization: "Bearer " + a.token,
          "idempotency-key": crypto.randomUUID(),
          "content-type": "application/json",
        },
        body: JSON.stringify(reply),
      }),
      env,
    );
    assert.equal(deniedOrigin.status, 403);
    await tenant(db.connect, "a", (sql) =>
      sql.query(
        "UPDATE workspace_features SET enabled=false WHERE workspace_id=$1 AND name='messenger_v2'",
        ["a"],
      ),
    );
    assert.equal(
      (await call("/v1/messenger/command", reply, a.token)).status,
      401,
    );
    await tenant(db.connect, "a", (sql) =>
      sql.query(
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name='messenger_v2'",
        ["a"],
      ),
    );
    assert.equal((await call("/v1/messenger/logout", {}, a.token)).status, 200);
    assert.equal(
      (await call("/v1/messenger/command", reply, a.token)).status,
      401,
    );
    const rejectedWrites = await tenant(db.connect, "a", (sql) =>
      sql.query(
        "SELECT id FROM conversation_parts WHERE workspace_id=$1 AND body=$2",
        ["a", reply.text],
      ),
    );
    assert.equal(rejectedWrites.rows.length, 0);
  } finally {
    await db.close();
  }
});
