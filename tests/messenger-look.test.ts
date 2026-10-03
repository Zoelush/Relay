import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { bootBrand, handleApi, type ApiEnvironment } from "../server/api";
import { DEFAULT_LOOK } from "../server/messenger-config";

/** Messenger settings M2 (docs/MESSENGER_SETTINGS_STEP2.md): the look, and teammates on Home. */
test("messenger look: older drafts get the default look, the look is validated and published, and Home's teammates are initials from this workspace only", async () => {
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
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name IN ('settings_v1','messenger_v3')",
        [w],
      );
    }
    await sql(
      "a",
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id,presence) VALUES('a','t1','p1','Grace Hopper','agent','active'),('a','t2','p2','Ada Lovelace','agent','away'),('a','t3','p3','Alan Turing','agent','active'),('a','t4','p4','Linus','agent','active')",
    );
    await sql(
      "b",
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('b','tb','pb','Barbara Liskov','agent')",
    );

    // A draft from before M2 (no look) reads with the default look, and isn't "changed" by it.
    const first = (await agent("messenger?brand=default")).body;
    const { look: _ignored, ...older } = first.draft;
    void _ignored;
    await sql("a", "UPDATE messenger_drafts SET config=$1", [
      JSON.stringify(older),
    ]);
    const read = (await agent("messenger?brand=default")).body;
    assert.deepEqual(read.draft.look, DEFAULT_LOOK);
    assert.equal(read.changed, false);

    // What a look can't be, each with its reason.
    const refuse = async (change: (l: any) => void, text: RegExp) => {
      const d = structuredClone(read.draft);
      change(d.look);
      const r = await agent("messenger", {
        brandId: "default",
        action: "save",
        draftVersion: read.draftVersion,
        config: d,
      });
      assert.equal(r.status, 400, String(text));
      assert.match(r.body.error.message, text);
    };
    await refuse((l) => (l.darkColor = "black"), /dark-theme colour/);
    await refuse(
      (l) =>
        (l.header = {
          ...l.header,
          background: "gradient",
          colors: ["#000000"],
        }),
      /two or three colours/,
    );
    await refuse(
      (l) =>
        (l.header = {
          ...l.header,
          background: "image",
          image: "http://cdn.test/bg.jpg",
        }),
      /background image needs an https/,
    );
    await refuse(
      (l) => (l.header = { ...l.header, text: "grey" }),
      /light or dark text/,
    );
    await refuse(
      (l) => (l.launcherLogo = "http://cdn.test/l.png"),
      /launcher logo needs an https/,
    );
    await refuse(
      (l) => (l.launcherSpacing = { side: 130, bottom: 20 }),
      /side spacing is 0 to 120/,
    );

    // A look saved and published: the messenger boots with it.
    const look = {
      darkColor: "#2BB88A",
      header: {
        background: "gradient",
        colors: ["#087A57", "#1D3A8A"],
        image: "ignored",
        text: "light",
        fade: true,
      },
      launcherLogo: "https://cdn.shop.test/launcher.png",
      launcherSpacing: { side: 40, bottom: 32 },
      showTeammates: true,
    };
    const saved = await agent("messenger", {
      brandId: "default",
      action: "save",
      draftVersion: read.draftVersion,
      config: { ...read.draft, look },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.draft.look, {
      ...look,
      darkColor: "#2bb88a",
      header: { ...look.header, colors: ["#087a57", "#1d3a8a"], image: "" },
    });
    await agent("messenger", {
      brandId: "default",
      action: "publish",
      draftVersion: saved.body.draftVersion,
    });
    const brand = await booted();
    assert.equal(brand.messenger3.look.launcherSpacing.side, 40);
    // Teammates: three, active first, initials and first names only.
    assert.deepEqual(brand.messenger3.team, [
      { firstName: "Alan", initials: "AT" },
      { firstName: "Grace", initials: "GH" },
      { firstName: "Linus", initials: "L" },
    ]);
    // Off: no teammates in the boot.
    const again = (await agent("messenger?brand=default")).body;
    const off = await agent("messenger", {
      brandId: "default",
      action: "save",
      draftVersion: again.draftVersion,
      config: {
        ...again.draft,
        look: { ...again.draft.look, showTeammates: false },
      },
    });
    await agent("messenger", {
      brandId: "default",
      action: "publish",
      draftVersion: off.body.draftVersion,
    });
    assert.deepEqual((await booted()).messenger3.team, []);

    // Workspace B's messenger shows only its own teammates.
    const b = (
      await agent("messenger?brand=default", undefined, "owner-b", "b")
    ).body;
    const bs = await agent(
      "messenger",
      {
        brandId: "default",
        action: "save",
        draftVersion: b.draftVersion,
        config: { ...b.draft, look: { ...b.draft.look, showTeammates: true } },
      },
      "owner-b",
      "b",
    );
    await agent(
      "messenger",
      {
        brandId: "default",
        action: "publish",
        draftVersion: bs.body.draftVersion,
      },
      "owner-b",
      "b",
    );
    assert.deepEqual(
      (await booted("b")).messenger3.team.map((t: any) => t.firstName).sort(),
      ["Barbara", "Support"],
    );
  } finally {
    await db.close();
  }
});
