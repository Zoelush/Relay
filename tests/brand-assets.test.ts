import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { bootBrand, handleApi, type ApiEnvironment } from "../server/api";
import { runJob } from "../server/jobs";
import { processBrandAsset } from "../server/brand-assets";
import { localAttachmentStorage } from "../scripts/local-storage";
import { EICAR_TEXT, PNG_PIXEL } from "./fixtures/documents";

/** Messenger settings M5 (docs/MESSENGER_SETTINGS_STEP5.md): the brand's uploaded images. */
test("brand images: checked uploads, used by drafts and published versions, served to customers only while live, tidied when unused, and kept in their workspace", async () => {
  const db = await testDatabase();
  const local = localAttachmentStorage();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    attachments: local.storage,
  };
  const call = (
    path: string,
    data?: unknown,
    principal = "owner-a",
    workspace = "a",
    key: string = crypto.randomUUID(),
  ) =>
    bridgeAgentRequest(
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
  const agent = async (...args: Parameters<typeof call>) => {
    const response = await call(...args);
    return { status: response.status, body: (await response.json()) as any };
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "messenger.asset.process": (job: any) =>
      processBrandAsset(db.connect, local.storage, job),
  };
  const prepare = (data: Record<string, unknown>, w = "a") =>
    agent(
      "messenger-assets",
      {
        op: "prepare",
        brandId: "default",
        name: "logo.png",
        type: "image/png",
        size: PNG_PIXEL.length,
        ...data,
      },
      "owner-" + w,
      w,
    );
  /** Prepare, put the bytes where the signed URL says, complete, and run the check. */
  async function upload(
    purpose: string,
    bytes: Uint8Array = PNG_PIXEL,
    w = "a",
    type = "image/png",
  ) {
    const prepared = await prepare({ purpose, size: bytes.length, type }, w);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.equal(prepared.body.removedKeys, undefined, "keys stay server-side");
    const put = await local.handle(
      new Request("https://relay.test" + prepared.body.url, {
        method: "PUT",
        headers: prepared.body.headers,
        body: bytes as BodyInit,
      }),
    );
    assert.equal(put?.status, 200);
    const key = crypto.randomUUID();
    const done = await agent(
      "messenger-assets",
      { op: "complete", assetId: prepared.body.assetId },
      "owner-" + w,
      w,
      key,
    );
    assert.equal(done.status, 202);
    // Completing again with the same key is harmless.
    const again = await agent(
      "messenger-assets",
      { op: "complete", assetId: prepared.body.assetId },
      "owner-" + w,
      w,
      key,
    );
    assert.equal(again.body.jobId, done.body.jobId);
    await runJob(db.connect, w, done.body.jobId, handlers);
    return prepared.body.assetId as string;
  }
  const status = async (id: string, w = "a") =>
    (
      await sql<{ status: string; failure_code: string | null }>(
        w,
        "SELECT status,failure_code FROM brand_assets WHERE id=$1",
        [id],
      )
    )[0];
  const draft = async (w = "a") =>
    (await agent("messenger?brand=default", undefined, "owner-" + w, w)).body;
  const save = async (change: (c: any) => void, w = "a") => {
    const d = await draft(w);
    const config = structuredClone(d.draft);
    change(config);
    return agent(
      "messenger",
      {
        brandId: "default",
        action: "save",
        draftVersion: d.draftVersion,
        config,
      },
      "owner-" + w,
      w,
    );
  };
  const publish = async (w = "a") =>
    agent(
      "messenger",
      {
        brandId: "default",
        action: "publish",
        draftVersion: (await draft(w)).draftVersion,
      },
      "owner-" + w,
      w,
    );
  const served = (w: string, id: string) =>
    handleApi(
      new Request(
        "https://relay.test/v1/messenger/brand-asset?" +
          new URLSearchParams({ w, id }),
      ),
      env,
    );
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

    // Refused before any bytes move, each with its reason.
    for (const [data, text] of [
      [{ purpose: "favicon" }, /Choose which image/],
      [{ purpose: "home_logo", type: "image/svg+xml", name: "logo.svg" }, /SVG images can carry scripts/],
      [{ purpose: "home_logo", type: "image/webp" }, /PNG, JPG or GIF/],
      [{ purpose: "home_logo", size: 1024 * 1024 + 1 }, /up to 1 MB/],
      [{ purpose: "home_logo", brandId: "missing" }, /Brand unavailable/],
    ] as const) {
      const r = await prepare(data);
      assert.ok(r.status >= 400, JSON.stringify(data));
      assert.match(r.body.error.message, text);
    }
    // Only managers upload.
    await sql(
      "a",
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')",
    );
    assert.equal(
      (
        await agent(
          "messenger-assets",
          { op: "prepare", brandId: "default", purpose: "home_logo", name: "x.png", type: "image/png", size: 10 },
          "agent-1-a",
        )
      ).status,
      403,
    );

    // A PNG that's really HTML, and the test virus, are rejected by the check.
    const fake = await upload(
      "home_logo",
      new TextEncoder().encode("<html><script>alert(1)</script></html>"),
    );
    assert.deepEqual(await status(fake), {
      status: "rejected",
      failure_code: "TYPE_MISMATCH",
    });
    const virus = await upload(
      "home_logo",
      new TextEncoder().encode("GIF89a" + EICAR_TEXT),
      "a",
      "image/gif",
    );
    assert.deepEqual(await status(virus), {
      status: "rejected",
      failure_code: "VIRUS_DETECTED",
    });
    // A rejected image can't be used.
    const refused = await save((c) => (c.logo = "asset:" + fake));
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.message, /Home screen logo isn't available/);

    // Real images, in their places; one in the wrong place is refused.
    const logo = await upload("home_logo");
    const launcher = await upload("launcher_logo");
    const background = await upload("home_background");
    assert.equal((await status(logo)).status, "ready");
    const misplaced = await save(
      (c) => (c.look.launcherLogo = "asset:" + logo),
    );
    assert.match(misplaced.body.error.message, /launcher logo isn't available/);
    const saved = await save((c) => {
      c.logo = "asset:" + logo;
      c.look.launcherLogo = "asset:" + launcher;
      c.look.header = {
        ...c.look.header,
        background: "image",
        image: "asset:" + background,
      };
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    // Teammates see the draft's image; customers don't until it's live.
    const preview = await call(
      "messenger-asset?" + new URLSearchParams({ id: logo }),
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "image/png");
    assert.equal((await served("a", logo)).status, 404);

    // Published: the boot gives Relay's addresses, and customers are served the images.
    assert.equal((await publish()).status, 200);
    const boot = await tenant(db.connect, "a", async (q) => {
      const b = (
        await q.query<{
          id: string;
          name: string;
          settings: Record<string, unknown>;
        }>("SELECT id,name,settings FROM brands WHERE id='default'")
      ).rows[0];
      return (await bootBrand(q, "a", b, "https://relay.test")) as any;
    });
    const address = (id: string) =>
      `https://relay.test/v1/messenger/brand-asset?w=a&id=${id}`;
    assert.equal(boot.logo, address(logo));
    assert.equal(boot.messenger3.look.launcherLogo, address(launcher));
    assert.equal(boot.messenger3.look.header.image, address(background));
    const image = await served("a", launcher);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      image.headers.get("cross-origin-resource-policy"),
      "cross-origin",
    );
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), PNG_PIXEL);

    // Replaced and set live: the old launcher logo is no longer served, but version 1 keeps it.
    const second = await upload("launcher_logo");
    await save((c) => (c.look.launcherLogo = "asset:" + second));
    await publish();
    assert.equal((await served("a", launcher)).status, 404);
    assert.equal((await served("a", second)).status, 200);
    // Days later, the next upload tidies what nothing uses: the rejected ones and an abandoned
    // upload go; version 1's launcher logo stays, so restoring it still works.
    const abandoned = await prepare({ purpose: "home_logo" });
    await sql(
      "a",
      "UPDATE brand_assets SET created_at=now()-interval '2 days'",
    );
    await upload("home_logo");
    const left = (
      await sql<{ id: string }>("a", "SELECT id FROM brand_assets")
    ).map((r) => r.id);
    for (const gone of [fake, virus, abandoned.body.assetId])
      assert.ok(!left.includes(gone), "tidied " + gone);
    for (const kept of [logo, launcher, background, second])
      assert.ok(left.includes(kept), "kept " + kept);
    const d = await draft();
    const restored = await agent("messenger", {
      brandId: "default",
      action: "restore",
      draftVersion: d.draftVersion,
      version: 1,
    });
    assert.equal(restored.body.draft.look.launcherLogo, "asset:" + launcher);
    assert.equal((await publish()).status, 200);
    assert.equal((await served("a", launcher)).status, 200);

    // Another workspace can't read, use or be served these images.
    assert.equal((await served("b", launcher)).status, 404);
    const crossPreview = await call(
      "messenger-asset?" + new URLSearchParams({ id: logo }),
      undefined,
      "owner-b",
      "b",
    );
    assert.equal(crossPreview.status, 404);
    const crossUse = await save((c) => (c.logo = "asset:" + logo), "b");
    assert.equal(crossUse.status, 400);
    assert.match(crossUse.body.error.message, /isn't available/);
    const crossComplete = await agent(
      "messenger-assets",
      { op: "complete", assetId: second },
      "owner-b",
      "b",
    );
    assert.equal(crossComplete.status, 404);
  } finally {
    await db.close();
  }
});
