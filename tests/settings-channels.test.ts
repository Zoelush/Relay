import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { messengerAsset } from "../server/assets";
import { websiteOrigin } from "../server/channel-settings";

/** Settings › Channels (S3b; docs/SETTINGS_STEP5.md): brands, the messenger, the portal. */
test("channel settings: brands are added and renamed, a brand's messenger is validated and read by the messenger at once, identity keys are listed without secrets, portal saves are idempotent, and all of it stays in its workspace", async () => {
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
    key: string = crypto.randomUUID(),
  ) => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
          "idempotency-key": key,
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
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const code = (r: { body: any }) => r.body.error?.code;
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
        "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES($1,'agent-1','agent-1-'||$1,'Agent one','agent')",
        [w],
      );
      await sql(
        w,
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name='settings_v1'",
        [w],
      );
    }

    // Pages: brands and the messenger for managers; the portal with its flag.
    const pages = async (principal = "owner-a") =>
      (
        (await agent("settings?section=overview", undefined, principal)).body
          .pages as string[]
      ).filter((p) => ["brands", "messenger", "portal"].includes(p));
    assert.deepEqual(await pages(), ["brands", "messenger"]);
    assert.deepEqual(await pages("agent-1-a"), []);
    await sql(
      "a",
      "UPDATE workspace_features SET enabled=true WHERE workspace_id='a' AND name='portal_v1'",
    );
    assert.deepEqual(await pages(), ["brands", "messenger", "portal"]);
    assert.equal((await agent("brands", undefined, "agent-1-a")).status, 403);

    // The list: the default brand's messenger, the install details, keys without secrets.
    const listed = (await agent("brands")).body;
    assert.equal(listed.workspaceId, "a");
    assert.equal(listed.apiOrigin, "https://relay.test");
    assert.deepEqual(
      listed.brands.map((b: any) => [b.id, b.name, b.portalUrl]),
      [["default", "Relay", "https://relay.test/portal/a/default"]],
    );
    assert.deepEqual(listed.brands[0].messenger.allowedOrigins, [
      "https://shop.test",
    ]);
    assert.deepEqual(listed.brands[0].identity, {
      enforced: true,
      legacyHmac: false,
    });
    assert.deepEqual(
      listed.identityKeys.map((k: any) => Object.keys(k).sort()),
      [["createdAt", "kid", "slot"]],
    );
    assert(!JSON.stringify(listed).includes("wrapped"));

    // A brand added once for a retried key; names unique whatever their case.
    const key = crypto.randomUUID();
    const added = await agent(
      "brands",
      { name: "Acme Outdoors" },
      "owner-a",
      "a",
      key,
    );
    assert.equal(added.status, 200);
    assert.deepEqual(
      (await agent("brands", { name: "Acme Outdoors" }, "owner-a", "a", key))
        .body,
      added.body,
    );
    assert.equal(added.body.id, "acme-outdoors");
    assert.equal(
      (await sql("a", "SELECT count(*)::int AS n FROM brands"))[0].n,
      2,
    );
    assert.equal(
      code(await agent("brands", { name: "acme OUTDOORS" })),
      "BRAND_EXISTS",
    );
    assert.equal(
      (await agent("brands", { id: "acme-outdoors", name: "Acme" })).status,
      200,
    );
    // A new brand loads nowhere until it has a website.
    const acme = (await agent("brands")).body.brands.find(
      (b: any) => b.id === "acme-outdoors",
    );
    assert.equal(acme.name, "Acme");
    assert.deepEqual(acme.messenger.allowedOrigins, []);

    // The messenger: saved, normalised, and other settings kept.
    const messenger = {
      ...listed.brands[0].messenger,
      color: "#AA3311",
      theme: "dark",
      position: "left",
      shape: "circle",
      logo: "https://cdn.shop.test/logo.png",
      locale: "pt-br",
      teamIntroduction: "  Ask us anything  ",
      allowedOrigins: [
        "https://shop.test/",
        "https://www.shop.test",
        "http://localhost:3000",
      ],
      directConversation: true,
    };
    const saved = await agent("brands", {
      id: "default",
      section: "messenger",
      messenger,
    });
    assert.equal(saved.status, 200);
    const stored = (
      await sql("a", "SELECT settings FROM brands WHERE id='default'")
    )[0].settings;
    assert.equal(stored.color, "#aa3311");
    assert.equal(stored.locale, "pt-BR");
    assert.equal(stored.teamIntroduction, "Ask us anything");
    assert.deepEqual(stored.allowedOrigins, [
      "https://shop.test",
      "https://www.shop.test",
      "http://localhost:3000",
    ]);
    assert.ok(stored.calendarId, "office hours kept");
    assert.deepEqual(stored.homeBlocks, [
      { type: "start" },
      { type: "recent" },
    ]);
    // The messenger's stylesheet uses the new colour at once.
    const css = await (
      await messengerAsset(
        new Request(
          "https://relay.test/messenger/theme.css?workspace=a&brand=default",
        ),
        db.connect,
        async () => new Response(""),
      )
    ).text();
    assert.match(css, /#aa3311/);

    // Refusals: each says what's wrong, and nothing is stored.
    for (const [change, text] of [
      [{ allowedOrigins: ["https://*.shop.test"] }, "isn't a website address"],
      [{ allowedOrigins: ["https://shop.test/support"] }, "with no path"],
      [{ allowedOrigins: ["http://shop.test"] }, "isn't a website address"],
      [{ color: "red" }, "Choose the primary colour"],
      [{ logo: "http://cdn.shop.test/logo.png" }, "https://"],
      [{ theme: "neon" }, "Choose a theme"],
      [{ teamIntroduction: " " }, "Write a greeting"],
    ] as const) {
      const r = await agent("brands", {
        id: "default",
        section: "messenger",
        messenger: { ...messenger, ...change },
      });
      assert.equal(r.status, 400, JSON.stringify(change));
      assert.match(
        r.body.error.message,
        new RegExp(text.replace(/[*.]/g, "\\$&")),
      );
    }
    assert.equal(
      (
        await sql(
          "a",
          "SELECT settings->>'color' AS c FROM brands WHERE id='default'",
        )
      )[0].c,
      "#aa3311",
    );
    assert.equal(websiteOrigin("https://Shop.Test:443/"), "https://shop.test");

    // Identity verification, per brand.
    assert.equal(
      (
        await agent("brands", {
          id: "acme-outdoors",
          section: "identity",
          enforced: false,
          legacyHmac: true,
        })
      ).status,
      200,
    );
    assert.deepEqual(
      await sql(
        "a",
        "SELECT id,identity_enforced,legacy_hmac_enabled FROM brands ORDER BY id",
      ),
      [
        {
          id: "acme-outdoors",
          identity_enforced: false,
          legacy_hmac_enabled: true,
        },
        { id: "default", identity_enforced: true, legacy_hmac_enabled: false },
      ],
    );
    assert.equal(
      code(
        await agent("brands", {
          id: "default",
          section: "identity",
          enforced: "no",
        }),
      ),
      "INVALID_BRAND",
    );

    // The portal: a retried domain add is applied once and answers the same.
    const portalKey = crypto.randomUUID();
    const domain = {
      op: "add_domain",
      host: "help.shop.test",
      brandId: "acme-outdoors",
    };
    const first = await agent(
      "portal-settings",
      domain,
      "owner-a",
      "a",
      portalKey,
    );
    assert.equal(first.status, 200);
    assert.deepEqual(
      (await agent("portal-settings", domain, "owner-a", "a", portalKey)).body,
      first.body,
    );
    assert.deepEqual(first.body.domains, [
      { host: "help.shop.test", brandId: "acme-outdoors" },
    ]);

    // Agents can't change any of it.
    assert.equal(
      (await agent("brands", { id: "default", name: "Mine" }, "agent-1-a"))
        .status,
      403,
    );

    // Kept to the workspace: B has only its own brand, and A's can't be reached.
    assert.deepEqual(
      (await agent("brands", undefined, "owner-b", "b")).body.brands.map(
        (b: any) => b.id,
      ),
      ["default"],
    );
    assert.equal(
      code(
        await agent(
          "brands",
          { id: "acme-outdoors", name: "Taken" },
          "owner-b",
          "b",
        ),
      ),
      "BRAND_NOT_FOUND",
    );
    assert.equal(
      (
        await sql(
          "b",
          "SELECT settings->>'color' AS c FROM brands WHERE id='default'",
        )
      )[0].c,
      "#087a57",
    );
    assert.equal(
      (await agent("brands", undefined, "owner-a", "b")).status,
      403,
    );
    await sql(
      "b",
      "UPDATE workspace_features SET enabled=false WHERE workspace_id='b' AND name='settings_v1'",
    );
    assert.equal(
      code(await agent("brands", undefined, "owner-b", "b")),
      "SETTINGS_DISABLED",
    );
  } finally {
    await db.close();
  }
});
