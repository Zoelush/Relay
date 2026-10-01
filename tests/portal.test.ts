import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { handleApi, type ApiEnvironment } from "../server/api";
import { identityIssuer } from "../server/identity";
import { saveTicketType } from "../server/tickets";
import { createInternalTicket } from "../server/ticket-links";

const secret = new TextEncoder().encode("i".repeat(32));
const RELAY = "https://relay.test";
async function identityToken(
  userId: string,
  workspace = "a",
  expiresIn = "10m",
) {
  return new SignJWT({
    email: userId + "@example.test",
    workspace_id: workspace,
  })
    .setProtectedHeader({ alg: "HS256", kid: "initial" })
    .setSubject(userId)
    .setIssuer(identityIssuer(workspace))
    .setAudience("relay-messenger")
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

test("portal: verified sign-in only, own requests only, nothing internal, same-origin changes, idempotent replies", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const sql = async <T = any>(query: string, values: unknown[] = [], w = "a") =>
    tenant(db.connect, w, async (q) => (await q.query<T>(query, values)).rows);
  const call = async (
    path: string,
    init: {
      body?: unknown;
      cookie?: string;
      origin?: string | null;
      key?: string;
      host?: string;
    } = {},
  ) => {
    const base = init.host ? `https://${init.host}` : RELAY;
    const response = await handleApi(
      new Request(base + path, {
        method: init.body === undefined ? "GET" : "POST",
        headers: {
          ...(init.origin === null ? {} : { origin: init.origin ?? base }),
          "content-type": "application/json",
          "idempotency-key": init.key ?? crypto.randomUUID(),
          ...(init.cookie ? { cookie: init.cookie } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
      env,
    );
    return {
      status: response.status,
      body: (await response.json()) as any,
      cookie: response.headers.get("set-cookie"),
    };
  };
  const scope = { workspace: "a", brand: "default" };
  const signIn = async (body: Record<string, unknown>) => {
    const r = await call("/v1/portal/session", { body: { ...scope, ...body } });
    return { ...r, session: r.cookie?.split(";")[0] ?? "" };
  };
  /** A messenger session (verified if a user is given) and a conversation it starts. */
  const messenger = async (device: string, user?: string) => {
    const boot = (
      await call("/v1/messenger/boot", {
        origin: "https://shop.test",
        body: {
          workspaceId: "a",
          brandId: "default",
          deviceToken: device.repeat(4),
          pageUrl: "https://shop.test",
          ...(user
            ? {
                user: {
                  userId: user,
                  email: user + "@example.test",
                  jwt: await identityToken(user),
                },
              }
            : {}),
        },
      })
    ).body;
    const post = (path: string, body: unknown) =>
      handleApi(
        new Request(RELAY + "/v1/messenger/" + path, {
          method: "POST",
          headers: {
            origin: "https://shop.test",
            authorization: "Bearer " + boot.token,
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          body: JSON.stringify(body),
        }),
        env,
      ).then(async (r) => ({
        status: r.status,
        body: (await r.json()) as any,
      }));
    return { boot, post };
  };
  const code = (r: { body: any }) => r.body.error?.code;
  try {
    for (const w of ["a", "b"])
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, {
          origins: ["https://shop.test"],
          master: env.identityMaster,
          identitySecret: secret,
          enable: true,
        }),
      );

    // Off by default.
    assert.equal(
      code(await call("/v1/portal/context?workspace=a&brand=default")),
      "PORTAL_DISABLED",
    );
    assert.equal(
      code(
        await signIn({
          user: {
            userId: "jo",
            email: "jo@example.test",
            jwt: await identityToken("jo"),
          },
        }),
      ),
      "PORTAL_DISABLED",
    );
    for (const w of ["a", "b"])
      await sql(
        "UPDATE workspace_features SET enabled=true WHERE name IN ('portal_v1','tickets_v1')",
        [],
        w,
      );
    const context = await call("/v1/portal/context?workspace=a&brand=default");
    assert.deepEqual(context.body, {
      brand: { name: "Relay", color: "#087a57", locale: "en" },
      signedIn: false,
      // No public help center for this brand (phase 07, B1).
      helpCenter: null,
    });

    // Jo: a verified messenger customer with two conversations; Sam: another customer.
    const jo = await messenger("jo-device-", "jo");
    assert.equal(
      jo.boot.capabilities.tickets,
      true,
      "the messenger offers the portal to verified customers",
    );
    const joFirst = (
      await jo.post("command", { action: "start", text: "Refund please" })
    ).body.conversationId;
    const joSecond = (
      await jo.post("command", {
        action: "start",
        text: "Question about billing",
      })
    ).body.conversationId;
    const sam = await messenger("sam-device-", "sam");
    const samConversation = (
      await sam.post("command", {
        action: "start",
        text: "Sam's private issue",
      })
    ).body.conversationId;
    const anonymous = await messenger("anon-device-");
    assert.equal(anonymous.boot.capabilities.tickets, false);
    assert.equal(
      code(await anonymous.post("portal-handoff", {})),
      "PORTAL_VERIFIED_ONLY",
      "anonymous visitors cannot open the portal",
    );

    // Signing in: a hand-over code works once, within its minute.
    const handoff = await jo.post("portal-handoff", {});
    assert.equal(handoff.status, 200, JSON.stringify(handoff.body));
    const url = new URL(handoff.body.url);
    assert.equal(url.origin + url.pathname, RELAY + "/portal/a/default");
    assert.equal(url.search, "", "the code is only in the fragment");
    const codeValue = new URLSearchParams(url.hash.slice(1)).get("handoff")!;
    const first = await signIn({ handoff: codeValue });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.match(
      first.cookie!,
      /^relay_portal=[0-9a-f-]{36}\.[\w-]+; Max-Age=43200; HttpOnly; SameSite=Lax; Path=\/; Secure$/,
    );
    assert.equal(
      code(await signIn({ handoff: codeValue })),
      "PORTAL_SIGN_IN_FAILED",
      "single use",
    );
    const stale = await jo.post("portal-handoff", {});
    await sql(
      "UPDATE portal_handoffs SET expires_at=now()-interval '1 second' WHERE used_at IS NULL",
    );
    assert.equal(
      code(
        await signIn({
          handoff: new URLSearchParams(
            new URL(stale.body.url).hash.slice(1),
          ).get("handoff"),
        }),
      ),
      "PORTAL_SIGN_IN_FAILED",
      "expired",
    );
    // A signed identity token works; forged, expired and other-workspace tokens do not.
    const signed = await signIn({
      user: {
        userId: "jo",
        email: "jo@example.test",
        jwt: await identityToken("jo"),
      },
    });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    for (const jwt of [
      "forged.token.value",
      await identityToken("jo", "a", "-1m"),
      await identityToken("jo", "b"),
    ])
      assert.equal(
        code(
          await signIn({
            user: { userId: "jo", email: "jo@example.test", jwt },
          }),
        ),
        "PORTAL_SIGN_IN_FAILED",
      );
    assert.equal(code(await signIn({})), "PORTAL_SIGN_IN_FAILED");
    assert.equal(
      (await sql("SELECT count(*)::int AS n FROM portal_sessions"))[0].n,
      2,
    );
    assert(
      !(
        await sql("SELECT secret_hash FROM portal_sessions")
      )[0].secret_hash.includes(first.session.split(".")[1]),
      "only a hash is stored",
    );
    const cookie = first.session;
    assert.equal(
      (await call("/v1/portal/context?workspace=a&brand=default", { cookie }))
        .body.signedIn,
      true,
    );

    // Tickets: a customer ticket shows its customer label; a hidden type and internal tickets never show.
    await tenant(db.connect, "a", async (q) => {
      await saveTicketType(q, "a", "owner-a", {
        name: "Refund",
        category: "customer",
        states: [
          {
            key: "new",
            name: "Queue",
            customerLabel: "Received",
            kind: "submitted",
          },
          {
            key: "done",
            name: "Paid out",
            customerLabel: "Refunded",
            kind: "resolved",
          },
        ],
        transitions: [["new", "done"]],
      });
      await saveTicketType(q, "a", "owner-a", {
        name: "Security review",
        category: "customer",
        portalVisible: false,
        states: [
          { key: "new", name: "New", kind: "submitted" },
          { key: "done", name: "Done", kind: "resolved" },
        ],
        transitions: [["new", "done"]],
      });
      await saveTicketType(q, "a", "owner-a", {
        name: "Finance check",
        category: "back_office",
        states: [
          { key: "new", name: "New", kind: "submitted" },
          { key: "done", name: "Done", kind: "resolved" },
        ],
        transitions: [["new", "done"]],
      });
      const teammate = { type: "teammate" as const, principal: "owner-a" };
      await command(q, "a", teammate, "portal-t1", {
        action: "ticket",
        conversationId: joFirst,
        typeId: "refund",
      });
      await command(q, "a", teammate, "portal-t2", {
        action: "ticket",
        conversationId: joSecond,
        typeId: "security-review",
      });
      await command(q, "a", teammate, "portal-n1", {
        action: "note",
        conversationId: joFirst,
        text: "Customer seems angry, check fraud score",
      });
      await command(q, "a", teammate, "portal-r1", {
        action: "reply",
        conversationId: joFirst,
        text: "We're on it.",
      });
      await createInternalTicket(q, "a", "owner-a", "portal-bo-1", {
        typeId: "finance-check",
        title: "Finance: approve Jo's refund",
        conversationId: joFirst,
      });
    });
    const list = (
      await call("/v1/portal/requests?workspace=a&brand=default", { cookie })
    ).body.requests;
    assert.deepEqual(
      list.map((r: any) => [r.id, r.ticket]),
      [[joFirst, { number: 1, typeName: "Refund", label: "Received" }]],
      "own requests only; the hidden type and the back-office ticket are absent",
    );
    const detail = (
      await call(`/v1/portal/request?workspace=a&brand=default&id=${joFirst}`, {
        cookie,
      })
    ).body;
    assert.equal(detail.ticket.label, "Received");
    const text = JSON.stringify(detail);
    for (const secretText of [
      "fraud score",
      "Finance",
      "Queue",
      "ticket_created",
      "internal",
    ])
      assert(
        !text.includes(secretText),
        `the portal must not show ${secretText}`,
      );
    assert.deepEqual(
      detail.parts
        .filter((p: any) => p.body)
        .map((p: any) => [p.author, p.body]),
      [
        ["you", "Refund please"],
        ["teammate", "We're on it."],
      ],
    );
    assert.deepEqual(
      detail.parts.find((p: any) => p.event?.ticket).event.ticket,
      { number: 1, typeName: "Refund", label: "Received" },
    );
    // Other requests cannot be opened, even by id.
    for (const id of [samConversation, joSecond])
      assert.equal(
        (
          await call(`/v1/portal/request?workspace=a&brand=default&id=${id}`, {
            cookie,
          })
        ).status,
        404,
      );
    const backOffice = (
      await sql("SELECT id FROM conversations WHERE visibility='internal'")
    )[0].id;
    assert.equal(
      (
        await call(
          `/v1/portal/request?workspace=a&brand=default&id=${backOffice}`,
          { cookie },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call("/v1/portal/reply", {
          cookie,
          body: { ...scope, id: samConversation, text: "hi" },
        })
      ).status,
      404,
      "no replying to someone else's request",
    );

    // Replies: same-origin only, idempotent, and a closed request reopens.
    assert.equal(
      (
        await call("/v1/portal/reply", {
          cookie,
          origin: "https://evil.test",
          body: { ...scope, id: joFirst, text: "x" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call("/v1/portal/reply", {
          cookie,
          origin: null,
          body: { ...scope, id: joFirst, text: "x" },
        })
      ).status,
      403,
    );
    await tenant(db.connect, "a", (q) =>
      command(q, "a", { type: "teammate", principal: "owner-a" }, "portal-close-1", {
        action: "close",
        conversationId: joFirst,
      }),
    );
    const key = crypto.randomUUID();
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await call("/v1/portal/reply", {
            cookie,
            key,
            body: { ...scope, id: joFirst, text: "Any update?" },
          })
        ).status,
        200,
      );
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversation_parts WHERE conversation_id=$1 AND body='Any update?'",
          [joFirst],
        )
      )[0].n,
      1,
      "a retried reply is sent once",
    );
    assert.equal(
      (await sql("SELECT status FROM conversations WHERE id=$1", [joFirst]))[0]
        .status,
      "open",
    );

    // Signed out, and other workspaces: no access.
    assert.equal(
      code(await call("/v1/portal/requests?workspace=a&brand=default")),
      "PORTAL_SIGN_IN_REQUIRED",
    );
    assert.equal(
      code(
        await call("/v1/portal/requests?workspace=b&brand=default", { cookie }),
      ),
      "PORTAL_SIGN_IN_REQUIRED",
      "a session belongs to one workspace",
    );
    const signedOut = await call("/v1/portal/logout", { cookie, body: scope });
    assert.match(signedOut.cookie!, /^relay_portal=; Max-Age=0/);
    assert.equal(
      code(
        await call("/v1/portal/requests?workspace=a&brand=default", { cookie }),
      ),
      "PORTAL_SIGN_IN_REQUIRED",
      "revoked",
    );

    // Custom domains route to a brand; settings need workspace.manage; company visibility is inert.
    await sql(
      "INSERT INTO role_capabilities(workspace_id,role_id,capability) VALUES('a','owner','workspace.manage') ON CONFLICT DO NOTHING",
    );
    const { bridgeAgentRequest } = await import("../server/agent-bridge");
    const agent = async (
      data?: unknown,
      principal = "owner-a",
      workspace = "a",
    ) => {
      const response = await bridgeAgentRequest(
        new Request("https://app.test/api/agent/portal-settings", {
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
          RELAY_API_ORIGIN: RELAY,
          RELAY_WORKSPACE_ID: workspace,
          RELAY_BRIDGE_SECRET: env.bridgeSecret,
        },
        (r) => handleApi(r, env),
      );
      return { status: response.status, body: (await response.json()) as any };
    };
    assert.equal(
      (
        await agent({
          op: "add_domain",
          host: "help.shop.test",
          brandId: "default",
        })
      ).status,
      200,
    );
    assert.equal(
      code(
        await agent(
          { op: "add_domain", host: "help.shop.test", brandId: "default" },
          "owner-b",
          "b",
        ),
      ),
      "PORTAL_DOMAIN_TAKEN",
    );
    const company = (await agent({ op: "visibility", visibility: "company" }))
      .body;
    assert.equal(company.visibility, "company");
    assert.match(company.notice, /once companies exist/);
    assert.equal(
      (await call("/v1/portal/context", { host: "help.shop.test" })).body.brand
        .name,
      "Relay",
      "the domain resolves the workspace and brand",
    );
    const viaDomain = await jo.post("portal-handoff", {});
    assert.match(
      viaDomain.body.url,
      /^https:\/\/help\.shop\.test\/portal#handoff=/,
    );
    const domainSession = await call("/v1/portal/session", {
      host: "help.shop.test",
      body: {
        handoff: new URLSearchParams(
          new URL(viaDomain.body.url).hash.slice(1),
        ).get("handoff"),
      },
    });
    assert.equal(domainSession.status, 200, JSON.stringify(domainSession.body));
    assert.deepEqual(
      (
        await call("/v1/portal/requests", {
          host: "help.shop.test",
          cookie: domainSession.cookie!.split(";")[0],
        })
      ).body.requests.map((r: any) => r.id),
      [joFirst],
      "company visibility still shows only the customer's own requests",
    );
  } finally {
    await db.close();
  }
});
