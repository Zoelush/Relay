import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";

/** Settings (S1; docs/SETTINGS_STEP1.md): personal pages, General, and who sees which page. */
test("settings: off by default; your profile and notifications for everyone; General for workspace managers only; validated, idempotent and kept to the workspace", async () => {
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
    }
    // Off by default: no pages, and the snapshot says so.
    assert.equal((await agent("settings?section=overview")).status, 404);
    assert.equal((await agent("inbox")).body.capabilities.settings, false);
    for (const w of ["a", "b"])
      await sql(
        w,
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name IN ('settings_v1','agent_inbox_views_v1')",
        [w],
      );
    const snapshot = (await agent("inbox")).body;
    assert.equal(snapshot.capabilities.settings, true);
    assert.deepEqual(snapshot.profile, {
      signature: "",
      notifications: { desktop: false, sound: false },
    });

    // Each teammate is offered only the pages they may use.
    const pages = async (principal: string) =>
      (await agent("settings?section=overview", undefined, principal)).body
        .pages as string[];
    assert.deepEqual(await pages("owner-a"), [
      "profile",
      "notifications",
      "appearance",
      "general",
      "teammates",
      "roles",
      "tags",
      "attributes",
      "brands",
      "messenger",
      "macros",
      "views",
    ]);
    assert(!(await pages("agent-1-a")).includes("general"));
    assert((await pages("agent-1-a")).includes("profile"));
    // Knowledge pages follow knowledge.manage and each feature's flag.
    await sql(
      "a",
      "UPDATE workspace_features SET enabled=true WHERE workspace_id='a' AND name IN ('knowledge_v1','knowledge_sync_v1')",
    );
    assert.deepEqual(
      (await pages("owner-a")).filter((p) =>
        ["help-centers", "websites", "ai-index"].includes(p),
      ),
      ["help-centers", "websites"],
    );
    assert(!(await pages("agent-1-a")).includes("help-centers"));

    // Your profile: name, timezone (or your device's) and signature, validated.
    const profile = await agent(
      "settings?section=profile",
      undefined,
      "agent-1-a",
    );
    assert.deepEqual(profile.body, {
      name: "Agent one",
      role: "agent",
      timezone: null,
      signature: "",
      notifications: { desktop: false, sound: false },
    });
    const saved = await agent(
      "settings",
      {
        section: "profile",
        name: "  Ada   Lovelace ",
        timezone: "Europe/London",
        signature: "Best wishes,\r\nAda",
      },
      "agent-1-a",
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.name, "Ada Lovelace");
    assert.equal(saved.body.timezone, "Europe/London");
    assert.equal(saved.body.signature, "Best wishes,\nAda");
    for (const [body, code] of [
      [{ section: "profile", name: "", timezone: "" }, "INVALID_SETTINGS"],
      [
        { section: "profile", name: "Ada", timezone: "Mars/Olympus" },
        "INVALID_SETTINGS",
      ],
      [
        { section: "profile", name: "Ada", signature: "x".repeat(1001) },
        "INVALID_SETTINGS",
      ],
      [{ section: "nonsense" }, "INVALID_SETTINGS"],
    ] as const) {
      const r = await agent("settings", body, "agent-1-a");
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, code);
    }
    // An empty timezone means "your device's".
    assert.equal(
      (
        await agent(
          "settings",
          {
            section: "profile",
            name: "Ada Lovelace",
            timezone: "",
            signature: "Best wishes,\nAda",
          },
          "agent-1-a",
        )
      ).body.timezone,
      null,
    );
    // Notifications follow the account.
    const prefs = await agent(
      "settings",
      {
        section: "notifications",
        notifications: { desktop: true, sound: "yes" },
      },
      "agent-1-a",
    );
    assert.deepEqual(prefs.body.notifications, { desktop: true, sound: false });
    assert.deepEqual(
      (await agent("inbox", undefined, "agent-1-a")).body.profile,
      {
        signature: "Best wishes,\nAda",
        notifications: { desktop: true, sound: false },
      },
    );

    // General: workspace managers only.
    assert.equal(
      (await agent("settings?section=general", undefined, "agent-1-a")).status,
      403,
    );
    assert.equal(
      (
        await agent(
          "settings",
          {
            section: "general",
            name: "Hijack",
            timezone: "UTC",
            language: "en",
          },
          "agent-1-a",
        )
      ).status,
      403,
    );
    const general = await agent("settings?section=general");
    assert.equal(general.status, 200);
    assert.equal(general.body.id, "a");
    assert.deepEqual(general.body.counts, {
      teammates: 2,
      contacts: 0,
      conversations: 0,
    });
    // A retried save with the same key is applied once and answers the same.
    const key = crypto.randomUUID();
    const change = {
      section: "general",
      name: "TX3 Funding",
      timezone: "America/New_York",
      language: "pt-br",
    };
    const first = await agent("settings", change, "owner-a", "a", key);
    assert.equal(first.status, 200);
    assert.equal(first.body.language, "pt-BR");
    assert.deepEqual(
      (await agent("settings", change, "owner-a", "a", key)).body,
      first.body,
    );
    assert.equal(
      (await agent("settings", { ...change, timezone: "Nowhere/Land" })).status,
      400,
    );
    // The account menu reads the new name.
    assert.equal(
      (await agent("inbox")).body.account.workspace.name,
      "TX3 Funding",
    );

    // Kept to the workspace: B's settings are B's, and A's owner isn't a teammate in B.
    assert.equal(
      (await agent("settings?section=general", undefined, "owner-b", "b")).body
        .name,
      "Relay",
    );
    assert.equal(
      (await agent("settings?section=general", undefined, "owner-a", "b"))
        .status,
      403,
    );
    assert.equal(
      (await sql("b", "SELECT name FROM teammates WHERE id='agent-1'"))[0].name,
      "Agent one",
    );
  } finally {
    await db.close();
  }
});
