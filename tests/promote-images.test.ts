import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { localAttachmentStorage } from "../scripts/local-storage";
import { PNG_PIXEL } from "./fixtures/documents";
import { cleanKeyIn } from "../server/uploads";

/**
 * The messenger and a help centre's look promoted back to production, with the images they use
 * (docs/TEST_WORKSPACE_PLAN.md, T2b; docs/TEST_WORKSPACE_STEP4.md).
 *
 * An image the test workspace got from production keeps its id on both sides and is left alone.
 * An image uploaded in the test workspace is copied in as production's own upload, with a new id,
 * and the promoted configuration is rewritten to name it. A look, which keeps no versions of its
 * own, can be put back from the ledger that recorded it.
 */
test("the messenger and a help centre's look: images copied into the pair, promoted back with what is new, and a look put back", async () => {
  const db = await testDatabase();
  const local = localAttachmentStorage();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    storageTransport: "local-pglite",
    attachments: local.storage,
  };
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const agent = async (route: string, data?: unknown, principal = "owner-a", actAs?: string) => {
    const r = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + route, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          ...(actAs ? { "x-relay-workspace": actAs } : {}),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      principal,
      { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: "a", RELAY_BRIDGE_SECRET: env.bridgeSecret },
      (x) => handleApi(x, env),
    );
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  /** An image already checked and stored, as its upload path leaves it. */
  const image = async (w: string, table: "brand_assets" | "knowledge_files", row: Record<string, unknown>) => {
    const id = crypto.randomUUID();
    const checksum = id.replace(/-/g, "");
    const key = cleanKeyIn(table, w, id, checksum);
    await local.storage.putClean(key, PNG_PIXEL, "image/png", String(row.name));
    const columns = { workspace_id: w, id, clean_key: key, checksum, status: "ready", mime: "image/png", size: PNG_PIXEL.length, object_key: `${w}/x/${id}/quarantine`, ready_at: new Date(), ...row };
    const names = Object.keys(columns);
    await q(w, `INSERT INTO ${table}(${names.join(",")}) VALUES(${names.map((_, i) => "$" + (i + 1)).join(",")})`, Object.values(columns));
    return id;
  };
  const bytes = async (key: string) => {
    const r = await local.storage.readClean!(key);
    return r.ok ? new Uint8Array(await r.arrayBuffer()).length : 0;
  };

  try {
    await tenant(db.connect, "a", (x) =>
      seedFoundation(x, "a", "owner-a", { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
    );
    await q("a", "UPDATE workspace_features SET enabled=true");
    await q("a", "DELETE FROM calendar_assignments");

    // Production: a messenger with an uploaded Home background, and a styled help centre whose
    // hero is an uploaded image.
    const background = await image("a", "brand_assets", { brand_id: "default", purpose: "home_background", name: "hero.png", uploaded_by: "owner" });
    const live = await agent("messenger?brand=default");
    assert.equal(live.status, 200, JSON.stringify(live.body));
    const first = { ...live.body.draft, look: { ...live.body.draft.look, header: { ...live.body.draft.look.header, background: "image", image: `asset:${background}` } } };
    assert.equal((await agent("messenger", { action: "save", brandId: "default", draftVersion: live.body.draftVersion, config: first })).status, 200);
    const published = await agent("messenger", { action: "publish", brandId: "default", draftVersion: String(Number(live.body.draftVersion) + 1) });
    assert.equal(published.body.liveVersion, 1, JSON.stringify(published.body));

    const center = await agent("help-centers", { op: "center_create", brandId: "default", name: "Help", slug: "help" });
    const hc = center.body.id as string;
    const hero = await image("a", "knowledge_files", { purpose: "theme_image", center_id: hc, name: "clouds.png", uploaded_by: "owner", version: 1 });
    const read = await agent("help-centers");
    const version = read.body.centers[0].version as string;
    const styled = await agent("help-centers", {
      op: "center_settings",
      id: hc,
      version,
      theme: { ...read.body.centers[0].theme, actionColor: "#0b5fff", heroBackground: { type: "image", fileId: hero } },
    });
    assert.equal(styled.status, 200, JSON.stringify(styled.body));

    /* ---- The pair is made, and the images come with it ------------------------------------- */
    const t = (await agent("workspaces", { action: "create_test" })).body.id as string;
    const inTest = (route: string, data?: unknown, principal = "owner-a") => agent(route, data, principal, t);
    const copiedAssets = await q<{ id: string; clean_key: string; status: string }>(t, "SELECT id,clean_key,status FROM brand_assets");
    assert.deepEqual(
      copiedAssets.map((a) => [a.id, a.status]),
      [[background, "ready"]],
      "the image the copied messenger names came, with its id kept",
    );
    assert.equal(copiedAssets[0].clean_key, cleanKeyIn("brand_assets", t, background, background.replace(/-/g, "")), "under the test workspace's own key");
    assert.equal(await bytes(copiedAssets[0].clean_key), PNG_PIXEL.length, "and its bytes are there");
    const copiedFiles = await q<{ id: string; clean_key: string }>(t, "SELECT id,clean_key FROM knowledge_files");
    assert.deepEqual(copiedFiles.map((f) => f.id), [hero], "the help centre's hero image came too");
    assert.equal(await bytes(copiedFiles[0].clean_key), PNG_PIXEL.length);
    // The copied look still finds its image, which is what was broken before this step.
    const there = await inTest("help-centers");
    assert.equal(there.body.centers[0].theme.heroBackground.fileId, hero);

    /* ---- A messenger changed in the test workspace, with an image only it has -------------- */
    const launcher = await image(t, "brand_assets", { brand_id: "default", purpose: "launcher_logo", name: "mark.png", uploaded_by: "owner" });
    const mine = await inTest("messenger?brand=default");
    const changed = {
      ...mine.body.draft,
      look: { ...mine.body.draft.look, launcherLogo: `asset:${launcher}`, header: { ...mine.body.draft.look.header, background: "image", image: `asset:${background}` } },
    };
    assert.equal((await inTest("messenger", { action: "save", brandId: "default", draftVersion: mine.body.draftVersion, config: changed })).status, 200);
    assert.equal((await inTest("messenger", { action: "publish", brandId: "default", draftVersion: String(Number(mine.body.draftVersion) + 1) })).body.liveVersion, 2);

    const ready = (await inTest("promotable")).body.candidates.find((c: any) => c.kind === "messenger");
    assert.equal(ready.status, "ready", JSON.stringify(ready));
    assert.deepEqual(ready.brings, [{ what: "launcher logo", name: "mark.png" }], "only the image production hasn't got comes with it");

    // A deployment that cannot copy stored objects says so, instead of landing a messenger whose
    // launcher logo isn't there.
    const noStorage = async (route: string) => {
      const r = await bridgeAgentRequest(
        new Request("https://app.test/api/agent/" + route, { headers: { origin: "https://app.test", "x-relay-workspace": t } }),
        "owner-a",
        { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: "a", RELAY_BRIDGE_SECRET: env.bridgeSecret },
        (x) => handleApi(x, { ...env, attachments: undefined }),
      );
      return (await r.json()) as any;
    };
    const without = (await noStorage("promotable")).candidates.find((c: any) => c.kind === "messenger");
    assert.deepEqual(
      [without.status, without.missing],
      ["needs", ["Images can't be copied in this deployment, so this one can't come with it."]],
    );

    const promoted = await inTest("promote", { kind: "messenger", id: "default" });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    assert.equal(promoted.body.promoted.version, 2, "production's next published version");
    const [now] = await q<{ version: number; config: any }>("a", "SELECT version,config FROM messenger_versions WHERE brand_id='default' ORDER BY version DESC LIMIT 1");
    assert.equal(now.version, 2);
    assert.equal(now.config.look.header.image, `asset:${background}`, "the image production already had is left exactly as it was");
    const brought = String(now.config.look.launcherLogo).slice("asset:".length);
    assert.notEqual(brought, launcher, "the new image is production's own upload, with an id of its own");
    const [arrived] = await q<{ brand_id: string; purpose: string; name: string; clean_key: string; uploaded_by: string }>(
      "a",
      "SELECT brand_id,purpose,name,clean_key,uploaded_by FROM brand_assets WHERE id=$1",
      [brought],
    );
    assert.deepEqual(
      [arrived.brand_id, arrived.purpose, arrived.name, arrived.uploaded_by],
      ["default", "launcher_logo", "mark.png", "owner"],
      "in the place it is used, by whoever promoted it",
    );
    assert.equal(await bytes(arrived.clean_key), PNG_PIXEL.length, "with its bytes, under production's own key");
    // The live settings the messenger itself reads, and the draft, as publishing there leaves them.
    const [brand] = await q<{ settings: any }>("a", "SELECT settings FROM brands WHERE id='default'");
    assert.equal(brand.settings.messenger3.look.launcherLogo, `asset:${brought}`);
    const [draft] = await q<{ config: any }>("a", "SELECT config FROM messenger_drafts WHERE brand_id='default'");
    assert.equal(draft.config.look.launcherLogo, `asset:${brought}`);
    // The ledger says what arrived, images and all.
    const ledger = (await agent("promotions")).body.promotions;
    assert.deepEqual([ledger[0].kind, ledger[0].version, ledger[0].brought], ["messenger", 2, [{ what: "launcher logo", name: "mark.png" }]]);
    assert.equal(ledger[0].canPutBack, false, "a published version is restored where it is published, not here");
    // Promoting it again has nothing to promote: the mark moved with the change.
    assert.equal((await inTest("promotable")).body.candidates.find((c: any) => c.kind === "messenger").status, "unchanged");

    /* ---- A help centre's look, promoted and then put back ---------------------------------- */
    const look = await inTest("help-centers");
    assert.equal(
      (await inTest("help-centers", { op: "center_settings", id: hc, version: look.body.centers[0].version, theme: { ...look.body.centers[0].theme, actionColor: "#a3122b" } }))
        .status,
      200,
    );
    const lookReady = (await inTest("promotable")).body.candidates.find((c: any) => c.kind === "help_center");
    assert.equal(lookReady.status, "ready", JSON.stringify(lookReady));
    assert.deepEqual(lookReady.brings, [], "its hero image is already production's");
    const lookPromoted = await inTest("promote", { kind: "help_center", id: hc });
    assert.equal(lookPromoted.status, 200, JSON.stringify(lookPromoted.body));
    const [after] = await q<{ theme: any; layout: any[]; version: string }>("a", "SELECT theme,layout,version::text AS version FROM help_centers WHERE id=$1", [hc]);
    assert.equal(after.theme.actionColor, "#a3122b", "production's look is the one that was tried");
    assert.equal(after.theme.heroBackground.fileId, hero, "and still names production's own image");

    const withLook = (await agent("promotions")).body.promotions;
    assert.equal(withLook[0].kind, "help_center");
    assert.equal(withLook[0].canPutBack, true, "a look keeps no versions, so the ledger offers the one it replaced");
    const back = await agent("promotions", { id: withLook[0].id });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const [restored] = await q<{ theme: any; version: string }>("a", "SELECT theme,version::text AS version FROM help_centers WHERE id=$1", [hc]);
    assert.equal(restored.theme.actionColor, "#0b5fff", "the look production had is back");
    assert.equal(restored.theme.heroBackground.fileId, hero);
    assert.equal(Number(restored.version), Number(after.version) + 1, "written as a save of its own, never by undoing history");
    const afterBack = (await agent("promotions")).body.promotions;
    assert.deepEqual([afterBack[0].action, afterBack[0].kind], ["reverted", "help_center"], "the ledger says it was put back");
    assert.equal(afterBack[0].canPutBack, false);
    assert.equal(afterBack[1].canPutBack, false, "and the promotion it undid is no longer the one to put back");
    assert.equal(
      (await q("a", "SELECT 1 FROM audit_events WHERE action='workspace.promotion_reverted'")).length,
      1,
      "with an audit event of its own",
    );
    // Putting it back returned the pair's mark too, so what was tried can go again.
    const again = (await inTest("promotable")).body.candidates.find((c: any) => c.kind === "help_center");
    assert.equal(again.status, "ready", JSON.stringify(again));
    const second = await inTest("promote", { kind: "help_center", id: hc });
    assert.equal(second.status, 200, JSON.stringify(second.body));

    /* ---- Refused rather than overwriting, and rather than inventing ------------------------ */
    // An article featured on the homepage that production hasn't got: refused, by its title.
    await q(t, "INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_help_center) VALUES($1,'art','article','owner','public',true)", [t]);
    await q(t, "INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,published_title) VALUES($1,'art','en','published','Only here','Only here')", [t]);
    const mineAgain = await inTest("help-centers");
    const centerHere = mineAgain.body.centers.find((c: any) => c.id === hc);
    assert.equal(
      (
        await inTest("help-centers", {
          op: "center_settings",
          id: hc,
          version: centerHere.version,
          layout: [{ type: "collections" }, { type: "featured", recordIds: ["art"] }],
        })
      ).status,
      200,
    );
    const needsArticle = (await inTest("promotable")).body.candidates.find((c: any) => c.kind === "help_center" && c.id === hc);
    assert.deepEqual(needsArticle.missing, ["The homepage features “Only here”, which production doesn't have."]);
    const stopped = await inTest("promote", { kind: "help_center", id: hc });
    assert.equal(stopped.status, 409);
    assert.equal(stopped.body.error.code, "PROMOTION_NEEDS");
    // A brand and a help centre the test workspace invented: refused, by name.
    await q(t, "INSERT INTO brands(workspace_id,id,name,settings) VALUES($1,'tried','Tried here','{}')", [t]);
    await q(t, "INSERT INTO messenger_versions(workspace_id,brand_id,version,config,published_by) VALUES($1,'tried',1,$2,'owner')", [t, JSON.stringify({ look: {} })]);
    await q(t, "INSERT INTO help_centers(workspace_id,id,brand_id,name,slug,default_locale,locales) VALUES($1,'hc-tried','tried','Tried','tried','en','{en}')", [t]);
    const invented = (await inTest("promotable")).body.candidates;
    assert.deepEqual(
      invented.find((c: any) => c.kind === "messenger" && c.id === "tried").missing,
      ["Tried here isn't a brand production has."],
    );
    assert.deepEqual(invented.find((c: any) => c.kind === "help_center" && c.id === "hc-tried").missing, ["Production doesn't have this help centre."]);
    assert.equal((await inTest("promote", { kind: "messenger", id: "tried" })).body.error.code, "PROMOTION_NEEDS");
    assert.equal((await q("a", "SELECT 1 FROM brands WHERE id='tried'")).length, 0, "and nothing was invented in production");

    // Production styles the help centre itself, so the look promoted a moment ago can't go back.
    const since = await agent("help-centers");
    assert.equal(
      (await agent("help-centers", { op: "center_settings", id: hc, version: since.body.centers[0].version, theme: { ...since.body.centers[0].theme, radius: 4 } })).status,
      200,
    );
    const stale = (await agent("promotions")).body.promotions.find((p: any) => p.action === "promoted" && p.kind === "help_center");
    assert.equal(stale.canPutBack, false, "the card stops offering it");
    const refused = await agent("promotions", { id: stale.id });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /changed here since it was promoted/);
    assert.equal((await q<{ theme: any }>("a", "SELECT theme FROM help_centers WHERE id=$1", [hc]))[0].theme.radius, 4, "and production keeps its own change");

  } finally {
    await db.close();
  }
});
