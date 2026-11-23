import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { changeApps, decideConsent, oauthToken, readApps, readConsent, readInstallations, upgradeInstallation } from "../server/oauth";
import { listCanvasApps, type CanvasEnvironment } from "../server/canvas";
import { createTestWorkspace } from "../server/test-workspace";
import { resolveRunning, type AppVersion } from "../server/app-versions";

/**
 * An app's versions and its sandbox (docs/TEST_WORKSPACE_STEP5.md, T3a): the draft published as
 * kept versions; the developer's workspace and its test pair install a version that isn't released
 * yet, and nobody else does; an installation pinned to what a manager consented to, moving by
 * itself to a version that asks for nothing new and waiting, named, for one that does; tokens and
 * Canvas following the running version, never the draft.
 */
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}
const CB = "https://orders.example/cb";

test("app versions: published and kept, a sandbox on the test pair, installations pinned, upgrades by the scope rule", async () => {
  const db = await testDatabase();
  const env: CanvasEnvironment = { key: "k".repeat(64) };
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const dev = (p: Record<string, unknown>) => tenant(db.connect, "dev", (x) => changeApps(x, "dev", "owner-dev", p, env)) as Promise<any>;
  try {
    for (const w of ["dev", "a"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
      await q(w, "DELETE FROM calendar_assignments");
    }
    // The developer's sandbox: their workspace's test pair.
    const pair = (await createTestWorkspace(db.connect, "dev", "owner-dev")).id;

    /* ---- The developer's side: create is version 1, the draft changes nothing, publish, keep -- */
    const app = await dev({
      action: "create",
      name: "Order Sync",
      redirectUris: [CB],
      scopes: ["conversations.read"],
      canvasUrl: "https://orders.example/canvas",
      canvasPlacements: ["settings"],
    });
    assert.deepEqual(
      app.versions.map((v: AppVersion) => [v.version, v.releasedAt]),
      [[1, null]],
      "creating publishes version 1, in development",
    );
    await dev({ action: "update", id: app.id, name: "Order Sync (draft)" });
    const listed = await tenant(db.connect, "dev", (x) => readApps(x, "dev", "owner-dev"));
    assert.equal(listed.apps[0].name, "Order Sync (draft)");
    assert.equal(listed.apps[0].versions[0].name, "Order Sync", "a version is kept as it was published");
    await assert.rejects(q("dev", "UPDATE oauth_app_versions SET name='changed'"), /kept as they were published/);
    await assert.rejects(q("dev", "DELETE FROM oauth_app_versions"), /kept as they were published/);

    /* ---- The sandbox: the pair installs version 1; another workspace is refused until release - */
    const { verifier, challenge } = await pkcePair();
    const ask = { client_id: app.clientId, redirect_uri: CB, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s" };
    await assert.rejects(readConsent(db.connect, "a", "owner-a", ask), /still in development: only its developer's workspace and its test workspace/);
    const inPair = await readConsent(db.connect, pair, "owner-dev", ask);
    assert.deepEqual([inPair.app.name, inPair.app.version], ["Order Sync", 1], "the published version, never the draft's name");
    const token = (form: Record<string, string>) =>
      oauthToken(
        new Request("http://api.test/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ ...form, client_id: app.clientId, client_secret: app.clientSecret }),
        }),
        db.connect,
      );
    const install = async (w: string, principal: string) => {
      const back = new URL((await decideConsent(db.connect, w, principal, { ...ask, decision: "approve" })).redirect);
      const r = await token({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: CB, code_verifier: verifier });
      assert.equal(r.status, 200);
      return (await r.json()) as { access_token: string; refresh_token: string; scope: string };
    };
    const inSandbox = await install(pair, "owner-dev");
    assert.equal((await q(pair, "SELECT app_version FROM oauth_grants WHERE revoked_at IS NULL"))[0].app_version, 1, "pinned to what was consented to");
    assert.deepEqual((await listCanvasApps(db.connect, pair, "owner-dev", "settings")).apps.map((a) => a.appName), ["Order Sync"]);

    // Released: any workspace may install it now.
    const released = await dev({ action: "release", id: app.id, version: 1 });
    assert.ok(released.versions[0].releasedAt);
    await assert.rejects(dev({ action: "release", id: app.id, version: 1 }), /already released/);
    assert.equal((await q("dev", "SELECT 1 FROM audit_events WHERE action='app_version.released'")).length, 1);
    const elsewhere = await install("a", "owner-a");
    assert.equal(elsewhere.scope, "conversations.read");

    /* ---- A version that asks for nothing new reaches everyone by itself ------------------------ */
    await dev({ action: "update", id: app.id, name: "Order Sync", canvasPlacements: ["settings", "composer"] });
    const v2 = await dev({ action: "publish", id: app.id, notes: "Also in the composer." });
    assert.equal(v2.published, 2);
    // Unreleased, so only the sandbox runs it; "a" stays on the released version 1.
    assert.deepEqual(Object.values(await readInstallations(db.connect, pair))[0], { running: 2, waiting: null, newScopes: [], notes: "", suspended: null }, "the sandbox runs an unreleased version");
    assert.equal(Object.values(await readInstallations(db.connect, "a"))[0].running, 1);
    await dev({ action: "release", id: app.id, version: 2 });
    assert.equal(Object.values(await readInstallations(db.connect, "a"))[0].running, 2, "released, with no new scopes: it moved by itself");
    assert.equal((await q("a", "SELECT app_version FROM oauth_grants WHERE revoked_at IS NULL"))[0].app_version, 1, "and nothing was written to move it");

    /* ---- A version that asks for more waits, named, for a manager's approval --------------- */
    await dev({ action: "update", id: app.id, scopes: ["conversations.read", "conversations.reply"] });
    await dev({ action: "publish", id: app.id, notes: "Replies to customers." });
    await dev({ action: "release", id: app.id, version: 3 });
    const waiting = Object.entries(await readInstallations(db.connect, "a"))[0];
    assert.deepEqual(waiting[1], { running: 2, waiting: 3, newScopes: ["conversations.reply"], notes: "Replies to customers.", suspended: null });
    // Its tokens meanwhile carry only what was granted for the version it runs.
    const refreshed = (await (await token({ grant_type: "refresh_token", refresh_token: elsewhere.refresh_token })).json()) as { scope: string; refresh_token: string };
    assert.equal(refreshed.scope, "conversations.read");
    // An agent can't approve; a manager can, and gets what they have of what it asks.
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent1','agent-a','Agent','agent')");
    await assert.rejects(upgradeInstallation(db.connect, "a", "agent-a", { id: waiting[0] }), (e: { status?: number }) => e.status === 403);
    const moved = await upgradeInstallation(db.connect, "a", "owner-a", { id: waiting[0] });
    assert.deepEqual([moved.running, moved.scopes], [3, ["conversations.read", "conversations.reply"]]);
    const upgraded = (await (await token({ grant_type: "refresh_token", refresh_token: refreshed.refresh_token })).json()) as { scope: string; refresh_token: string };
    assert.equal(upgraded.scope, "conversations.read conversations.reply", "approved: its tokens carry the new scope");
    assert.deepEqual(Object.values(await readInstallations(db.connect, "a"))[0], { running: 3, waiting: null, newScopes: [], notes: "", suspended: null });
    await assert.rejects(upgradeInstallation(db.connect, "a", "owner-a", { id: waiting[0] }), /no new version waiting/);

    /* ---- A version that asks for less gets less at once ----------------------------------- */
    await dev({ action: "update", id: app.id, scopes: ["conversations.read"] });
    await dev({ action: "publish", id: app.id });
    await dev({ action: "release", id: app.id, version: 4 });
    assert.equal(Object.values(await readInstallations(db.connect, "a"))[0].running, 4);
    // "a" was granted read and reply; version 4 asks only for read, so its tokens drop reply at once,
    // while the grant still records what its manager consented to.
    const narrowed = (await (await token({ grant_type: "refresh_token", refresh_token: upgraded.refresh_token })).json()) as { scope: string };
    assert.equal(narrowed.scope, "conversations.read");
    assert.deepEqual((await q("a", "SELECT scopes FROM oauth_grants WHERE revoked_at IS NULL"))[0].scopes, ["conversations.read", "conversations.reply"]);
    assert.ok(inSandbox.access_token, "the sandbox installation stays as it was");

    /* ---- The rule itself, apart from any database ------------------------------------------ */
    const v = (version: number, scopes: string[], released = true): AppVersion => ({
      version,
      name: "A",
      description: "",
      redirectUris: [CB],
      scopes,
      canvasUrl: null,
      canvasPlacements: [],
      notes: "",
      publishedAt: "",
      releasedAt: released ? "x" : null,
      installUrl: null,
    });
    const list = [v(1, ["a"]), v(2, ["a"]), v(3, ["a", "b"]), v(4, ["a"], false)];
    assert.deepEqual(resolveRunning(list, false, 1), { running: list[1], waiting: list[2], newScopes: ["b"] }, "elsewhere: released only");
    assert.deepEqual(resolveRunning(list, true, 1)?.running.version, 4, "in the sandbox: v3 asks for more, v4 doesn't");
    assert.equal(resolveRunning(list, false, 9), null, "a version that doesn't exist runs nothing");
  } finally {
    await db.close();
  }
});
