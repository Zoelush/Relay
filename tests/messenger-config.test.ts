import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { bootBrand, handleApi, type ApiEnvironment } from "../server/api";
import { pageMatches } from "../server/messenger-config";

/** Messenger settings M1 (docs/MESSENGER_SETTINGS_STEP1.md): drafts, publishing, audiences. */
test("messenger drafts: saved with a version check, validated, published as versions the messenger boots with, discarded and restored, and kept to the workspace", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
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
      (r) => handleApi(r, env),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const code = (r: { body: any }) => r.body.error?.code;
  const booted = async (w = "a") =>
    tenant(db.connect, w, async (q) => {
      const b = (
        await q.query<{
          id: string;
          name: string;
          settings: Record<string, unknown>;
        }>("SELECT id,name,settings FROM brands WHERE id='default'")
      ).rows[0];
      return (await bootBrand(q, w, b)) as any;
    });
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
    // Off by default: the earlier page edits the brand directly.
    assert.equal(
      code(await agent("messenger?brand=default")),
      "MESSENGER_V3_DISABLED",
    );
    await sql(
      "a",
      "UPDATE workspace_features SET enabled=true WHERE workspace_id='a' AND name='messenger_v3'",
    );
    // With drafts on, editing the brand directly is refused.
    const legacy = (await agent("brands")).body.brands[0].messenger;
    assert.equal(
      code(
        await agent("brands", {
          id: "default",
          section: "messenger",
          messenger: legacy,
        }),
      ),
      "MESSENGER_DRAFTS",
    );
    assert.equal(
      (await agent("messenger?brand=default", undefined, "agent-1-a")).status,
      403,
    );

    // The first draft is what's live now, as a full config.
    const first = (await agent("messenger?brand=default")).body;
    assert.equal(first.liveVersion, null);
    assert.equal(first.changed, false);
    assert.deepEqual(first.draft.audiences.visitors, {
      spaces: ["home", "messages", "help"],
      launchToConversation: false,
      startButton: "start",
      launcher: { show: "always", rules: [] },
      // Messenger M3's conversation rules, at their defaults.
      inbound: {
        oneConversation: false,
        talkAfterUnhelpful: true,
        blockClosedReplies: false,
        blockClosedTicketReplies: false,
      },
    });
    assert.deepEqual(
      first.draft.home.map((c: any) => c.type),
      ["start", "recent"],
    );
    assert.deepEqual(first.draft.welcome, {
      en: { greeting: "Hi {first_name} 👋", intro: "How can we help?" },
    });

    // A draft: users get Tickets and a different start button; a link card; French; a notice.
    const draft = {
      ...first.draft,
      audiences: {
        visitors: {
          ...first.draft.audiences.visitors,
          launcher: {
            show: "except_matching",
            rules: [{ op: "starts_with", value: "https://shop.test/checkout" }],
          },
        },
        users: {
          spaces: ["messages", "home", "tickets"],
          launchToConversation: true,
          startButton: "support",
          launcher: { show: "always", rules: [] },
        },
      },
      home: [
        ...first.draft.home,
        {
          id: "status",
          type: "link",
          audience: "everyone",
          title: "System status",
          body: "All systems go",
          url: "https://status.shop.test",
        },
        { id: "mine", type: "tickets", audience: "users" },
      ],
      welcome: {
        ...first.draft.welcome,
        fr: {
          greeting: "Bonjour {first_name} 👋",
          intro: "Comment pouvons-nous aider ?",
        },
      },
      notice: {
        enabled: true,
        text: {
          en: "Replies are slower today.",
          fr: "Réponses plus lentes aujourd'hui.",
        },
      },
    };
    const key = crypto.randomUUID();
    const saved = await agent(
      "messenger",
      {
        brandId: "default",
        action: "save",
        draftVersion: first.draftVersion,
        config: draft,
      },
      "owner-a",
      "a",
      key,
    );
    assert.equal(saved.status, 200);
    assert.deepEqual(
      (
        await agent(
          "messenger",
          {
            brandId: "default",
            action: "save",
            draftVersion: first.draftVersion,
            config: draft,
          },
          "owner-a",
          "a",
          key,
        )
      ).body,
      saved.body,
      "a retried save is applied once",
    );
    assert.equal(
      saved.body.draftVersion,
      String(Number(first.draftVersion) + 1),
    );
    assert.equal(saved.body.changed, true);
    // Saved from an old version: refused, nothing overwritten.
    const stale = await agent("messenger", {
      brandId: "default",
      action: "save",
      draftVersion: first.draftVersion,
      config: first.draft,
    });
    assert.equal(stale.status, 409);
    assert.equal(code(stale), "MESSENGER_CONFLICT");

    // What a draft can't be, each with its reason.
    const refuse = async (change: (d: any) => void, text: RegExp) => {
      const d = structuredClone(saved.body.draft);
      change(d);
      const r = await agent("messenger", {
        brandId: "default",
        action: "save",
        draftVersion: saved.body.draftVersion,
        config: d,
      });
      assert.equal(r.status, 400, String(text));
      assert.match(r.body.error.message, text);
    };
    await refuse(
      (d) => (d.audiences.visitors.spaces = ["home", "help"]),
      /Messages is always shown/,
    );
    await refuse(
      (d) => d.audiences.visitors.spaces.push("tickets"),
      /signed-in users/,
    );
    await refuse(
      (d) => (d.home[2].url = "http://status.shop.test"),
      /needs an https/,
    );
    await refuse(
      (d) => (d.home[3].audience = "everyone"),
      /tickets card is for signed-in users/,
    );
    await refuse(
      (d) => (d.audiences.visitors.launcher.rules = []),
      /at least one page rule/,
    );
    await refuse((d) => delete d.welcome.en, /messenger's own language/);
    await refuse(
      (d) => (d.notice.text = { fr: "Seulement en français" }),
      /notice in the messenger's own language/,
    );
    await refuse(
      (d) => (d.audiences.users.startButton = "yell"),
      /start button's wording/,
    );

    // Before publishing, the messenger boots with what was live.
    assert.equal((await booted()).messenger3, undefined);
    // Published: version 1, written to the live settings, and the messenger boots with it.
    const published = await agent("messenger", {
      brandId: "default",
      action: "publish",
      draftVersion: saved.body.draftVersion,
    });
    assert.equal(published.status, 200);
    assert.equal(published.body.liveVersion, 1);
    assert.equal(published.body.changed, false);
    const brand = await booted();
    assert.deepEqual(brand.messenger3.audiences.users.spaces, [
      "messages",
      "home",
      "tickets",
    ]);
    assert.equal(brand.messenger3.notice.enabled, true);
    assert.equal(
      brand.directConversation,
      false,
      "the earlier setting follows visitors",
    );
    assert.deepEqual(brand.allowedOrigins, ["https://shop.test"]);
    // Published versions are kept as they were.
    await assert.rejects(sql("a", "UPDATE messenger_versions SET config='{}'"));

    // A second version, then the first restored into the draft and published again.
    const v2draft = {
      ...published.body.draft,
      notice: { enabled: false, text: published.body.draft.notice.text },
    };
    const s2 = await agent("messenger", {
      brandId: "default",
      action: "save",
      draftVersion: published.body.draftVersion,
      config: v2draft,
    });
    const v2 = await agent("messenger", {
      brandId: "default",
      action: "publish",
      draftVersion: s2.body.draftVersion,
    });
    assert.equal(v2.body.liveVersion, 2);
    assert.equal((await booted()).messenger3.notice.enabled, false);
    // Discard: an unpublished edit goes back to what's live.
    const edit = await agent("messenger", {
      brandId: "default",
      action: "save",
      draftVersion: v2.body.draftVersion,
      config: { ...v2.body.draft, color: "#112233" },
    });
    assert.equal(edit.body.changed, true);
    const discarded = await agent("messenger", {
      brandId: "default",
      action: "discard",
    });
    assert.equal(discarded.body.changed, false);
    assert.equal(discarded.body.draft.color, v2.body.draft.color);
    const restored = await agent("messenger", {
      brandId: "default",
      action: "restore",
      version: 1,
    });
    assert.equal(restored.body.draft.notice.enabled, true);
    assert.equal(restored.body.changed, true);
    const v3 = await agent("messenger", {
      brandId: "default",
      action: "publish",
      draftVersion: restored.body.draftVersion,
    });
    assert.equal(v3.body.liveVersion, 3);
    assert.deepEqual(
      v3.body.versions.map((v: any) => v.version),
      [3, 2, 1],
    );
    assert.equal(
      code(
        await agent("messenger", {
          brandId: "default",
          action: "restore",
          version: 9,
        }),
      ),
      "VERSION_NOT_FOUND",
    );

    // Switching drafts off: the messenger falls back to the earlier settings.
    await sql(
      "a",
      "UPDATE workspace_features SET enabled=false WHERE workspace_id='a' AND name='messenger_v3'",
    );
    assert.equal((await booted()).messenger3, undefined);
    await sql(
      "a",
      "UPDATE workspace_features SET enabled=true WHERE workspace_id='a' AND name='messenger_v3'",
    );

    // Kept to the workspace.
    await sql(
      "a",
      "INSERT INTO brands(workspace_id,id,name) VALUES('a','acme','Acme')",
    );
    await sql(
      "b",
      "UPDATE workspace_features SET enabled=true WHERE workspace_id='b' AND name='messenger_v3'",
    );
    assert.equal(
      code(await agent("messenger?brand=acme", undefined, "owner-b", "b")),
      "BRAND_NOT_FOUND",
    );
    assert.equal(
      (await agent("messenger?brand=default", undefined, "owner-b", "b")).body
        .liveVersion,
      null,
    );
    assert.equal(
      (await agent("messenger?brand=default", undefined, "owner-a", "b"))
        .status,
      403,
    );
    assert.equal(
      (await sql("b", "SELECT count(*)::int AS n FROM messenger_versions"))[0]
        .n,
      0,
    );
  } finally {
    await db.close();
  }
});

test("launcher page rules match the page's address", () => {
  const url = "https://shop.test/checkout/pay?step=2";
  assert(pageMatches(url, [{ op: "contains", value: "/checkout" }]));
  assert(
    pageMatches(url, [
      { op: "starts_with", value: "https://shop.test/checkout" },
    ]),
  );
  assert(
    !pageMatches(url, [{ op: "equals", value: "https://shop.test/checkout" }]),
  );
  assert(
    pageMatches("https://shop.test/", [
      { op: "equals", value: "https://shop.test/" },
    ]),
  );
  assert(!pageMatches(url, []));
});
