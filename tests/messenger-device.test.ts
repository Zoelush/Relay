import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { testDatabase } from "./database";
import { seedFoundation } from "../server/people";
import { tenant } from "../server/db";
import { handleApi, type ApiEnvironment } from "../server/api";
import { identityIssuer } from "../server/identity";

/**
 * A shared device: one signed-in customer, then another on the same browser without logging out.
 * The second boots (it used to be refused with MERGE_NOT_ALLOWED), sees none of the first's
 * conversations, and nothing is merged between them; the first, back again, still has theirs.
 */
const secret = new TextEncoder().encode("test-only-customer-signing-secret-32-bytes");
test("a device that switches signed-in users boots the new user apart from the old one", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "test-only-session-signing-secret-32-bytes",
    identityMaster: "test-only-identity-wrapping-key-32-bytes",
    bridgeSecret: "test-only-bridge-signing-secret-32-bytes",
  };
  const call = (path: string, data?: unknown, token?: string) =>
    handleApi(
      new Request("https://relay.example" + path, {
        method: data ? "POST" : "GET",
        headers: {
          origin: "https://shop.example",
          "content-type": "application/json",
          ...(token ? { authorization: "Bearer " + token } : {}),
          "idempotency-key": crypto.randomUUID(),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      }),
      env,
    );
  const sql = async (text: string, values: unknown[] = []) => tenant(db.connect, "a", async (q) => (await q.query(text, values)).rows);
  const deviceToken = "device-shared-aaaaaaaaaaaaaaaaaaaaaaaaaa";
  const boot = async (userId: string | null) => {
    const user = userId
      ? {
          userId,
          email: `${userId}@example.com`,
          jwt: await new SignJWT({ workspace_id: "a", email: `${userId}@example.com` })
            .setProtectedHeader({ alg: "HS256", kid: "initial" })
            .setSubject(userId)
            .setIssuer(identityIssuer("a"))
            .setAudience("relay-messenger")
            .setIssuedAt()
            .setExpirationTime("5m")
            .sign(secret),
        }
      : undefined;
    const r = await call("/v1/messenger/boot", { workspaceId: "a", brandId: "default", deviceToken, pageUrl: "https://shop.example/", locale: "en", ...(user ? { user } : {}) });
    const body = (await r.json()) as any;
    assert.equal(r.status, 200, JSON.stringify(body));
    return body;
  };
  const conversations = async (token: string) => ((await (await call("/v1/messenger/conversations", undefined, token)).json()) as any).conversations.map((c: { title: string }) => c.title);
  try {
    await tenant(db.connect, "a", (q) => seedFoundation(q, "a", "owner-a", { origins: ["https://shop.example"], master: env.identityMaster, identitySecret: secret, enable: true }));
    // A visitor writes, then signs in as Ada: the visitor merges into Ada (as before).
    const visitor = await boot(null);
    await call("/v1/messenger/command", { action: "start", text: "Before signing in" }, visitor.token);
    const ada = await boot("ada");
    await call("/v1/messenger/command", { action: "start", text: "Ada's order question" }, ada.token);
    assert.deepEqual((await conversations(ada.token)).sort(), ["Ada's order question", "Before signing in"]);
    const merges = (await sql("SELECT count(*)::int AS n FROM contact_merges"))[0].n;
    assert.equal(merges, 1);

    // Grace signs in on the same device without Ada logging out: she boots, apart from Ada.
    const grace = await boot("grace");
    assert.notEqual(grace.session.identityId, ada.session.identityId);
    assert.deepEqual(await conversations(grace.token), [], "none of Ada's");
    assert.equal(
      (await call("/v1/messenger/history?conversation=" + (await sql("SELECT id FROM conversations WHERE title='Ada''s order question'"))[0].id, undefined, grace.token)).status,
      404,
    );
    assert.equal((await sql("SELECT count(*)::int AS n FROM contact_merges"))[0].n, merges, "nothing merged");
    await call("/v1/messenger/command", { action: "start", text: "Grace's question" }, grace.token);
    assert.deepEqual(await conversations(grace.token), ["Grace's question"]);

    // Ada again on the device: hers are still hers, and Grace's aren't.
    const again = await boot("ada");
    assert.deepEqual((await conversations(again.token)).sort(), ["Ada's order question", "Before signing in"]);
  } finally {
    await db.close();
  }
});
