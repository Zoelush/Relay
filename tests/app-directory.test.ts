import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { changeApps, decideConsent, oauthToken, readConsent, readDirectory, readInstallations, releaseFromWorkspace, submitToDirectory } from "../server/oauth";
import { listCanvasApps, notifyUninstalled, type CanvasEnvironment } from "../server/canvas";
import { handleRest } from "../server/rest";
import { directoryStateFor, widensReach, type Card } from "../server/directory";
import { approveSubmission, delistApp, liftSuspension, pendingReviews, rejectSubmission, relistApp, suspendApp } from "../server/directory-review";
import type { Job } from "../server/jobs";

/**
 * Review and the app directory (docs/TEST_WORKSPACE_STEP6.md, T3b): a developer submits, Relay's
 * operators approve or reject with a reason, workspaces browse and install; a version that widens a
 * listed app's reach waits for review while one that doesn't goes out; delisting keeps installations,
 * suspending stops an app everywhere with the reason shown; uninstalling cleans up and tells the app.
 */
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const APP = "https://orders.example";
const CB = APP + "/cb";

test("the app directory: submitted, reviewed, listed, installed; widening waits; delisted, suspended and lifted; uninstalled cleanly", async () => {
  const db = await testDatabase();
  const seen: { url: string; signature: string; body: Record<string, unknown> }[] = [];
  let appDown = false;
  const env: CanvasEnvironment = {
    key: "k".repeat(64),
    timeoutMs: 200,
    policy: {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        seen.push({ url: req.url, signature: req.headers.get("relay-signature") ?? "", body: JSON.parse(await req.clone().text()) });
        if (appDown) throw new TypeError("fetch failed");
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    },
  };
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const dev = (p: Record<string, unknown>) => tenant(db.connect, "dev", (x) => changeApps(x, "dev", "owner-dev", p, env)) as Promise<any>;
  const rest = (token: string, path: string) => handleRest(new Request("http://api.test/rest" + path, { headers: { authorization: "Bearer " + token } }), { connect: db.connect });
  try {
    for (const w of ["dev", "a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true WHERE name='developer_api_v1'");
    }

    /* ---- Submitting: an install address first, one open submission at a time ------------------ */
    const bare = await dev({ action: "create", name: "No Door", redirectUris: [CB], scopes: ["conversations.read"] });
    await assert.rejects(submitToDirectory(db.connect, "dev", "owner-dev", { id: bare.id, version: 1 }, env), /install address first/);
    const app = await dev({
      action: "create",
      name: "Order Sync",
      description: "Orders beside conversations.",
      redirectUris: [CB],
      scopes: ["conversations.read"],
      canvasUrl: APP + "/canvas",
      canvasPlacements: ["settings"],
      installUrl: APP + "/install",
    });
    await assert.rejects(
      submitToDirectory(db.connect, "dev", "agent-nobody", { id: app.id, version: 1 }, env),
      (e: { status?: number }) => e.status === 403 || e.status === 401,
      "only who manages the workspace submits",
    );
    const sub1 = await submitToDirectory(db.connect, "dev", "owner-dev", { id: app.id, version: 1 }, env);
    await assert.rejects(submitToDirectory(db.connect, "dev", "owner-dev", { id: app.id, version: 1 }, env), /already has a version waiting/);
    const pending = await pendingReviews(db.connect);
    assert.deepEqual(
      pending.map((s) => [s.kind, s.card.name, s.card.version, s.card.installUrl, s.card.hosts]),
      [["listing", "Order Sync", 1, APP + "/install", ["orders.example"]]],
    );
    // Nothing is listed until an operator approves; another workspace still can't install it.
    assert.deepEqual((await readDirectory(db.connect, "a", "owner-a")).apps, []);
    const { challenge, verifier } = await (async () => {
      const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
      return { verifier, challenge: b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))) };
    })();
    const ask = { client_id: app.clientId, redirect_uri: CB, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s" };
    await assert.rejects(readConsent(db.connect, "a", "owner-a", ask), /still in development/);

    /* ---- Approved: released, listed, browsed and installed ------------------------------------ */
    await assert.rejects(approveSubmission(db.connect, sub1.submitted, ""), /Say who you are/);
    assert.deepEqual(await approveSubmission(db.connect, sub1.submitted, "Ada"), { approved: sub1.submitted, app: "Order Sync", version: 1 });
    const afterApproval = (await directoryStateFor(db.connect, "dev"))[app.id];
    assert.deepEqual([afterApproval.listing?.version, afterApproval.submissions[0].state], [1, "approved"]);
    const audit = await q<{ actor_name: string; via: string }>("dev", "SELECT actor_name,via FROM audit_events WHERE action='app_review.approved'");
    assert.deepEqual([audit[0].actor_name, audit[0].via], ["Relay review: Ada", "operator"], "recorded in the developer's log, by the operator's name");
    const listedForA = (await readDirectory(db.connect, "a", "owner-a")).apps;
    assert.deepEqual(
      listedForA.map((x) => [x.name, x.developer, x.installUrl, x.installed]),
      [["Order Sync", "Relay", APP + "/install", false]],
    );
    const token = async (form: Record<string, string>) =>
      oauthToken(
        new Request("http://api.test/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ ...form, client_id: app.clientId, client_secret: app.clientSecret }),
        }),
        db.connect,
      );
    const install = async (w: string) => {
      const back = new URL((await decideConsent(db.connect, w, "owner-" + w, { ...ask, decision: "approve" })).redirect);
      const r = await token({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: CB, code_verifier: verifier });
      assert.equal(r.status, 200);
      return (await r.json()) as { access_token: string; refresh_token: string };
    };
    const inA = await install("a");
    assert.equal((await readDirectory(db.connect, "a", "owner-a")).apps[0].installed, true);

    /* ---- A release that doesn't widen its reach goes out; the card follows ------------------- */
    const v2 = await dev({ action: "publish", id: app.id, notes: "Faster lookups." });
    assert.ok(v2.versions[0].releasedAt, "the approval released version 1");
    const r2 = await releaseFromWorkspace(db.connect, "dev", "owner-dev", { id: app.id, version: 2 }, env);
    assert.equal((r2 as { submitted?: string }).submitted, undefined);
    assert.equal(Object.values(await readInstallations(db.connect, "a"))[0].running, 2);
    assert.equal((await readDirectory(db.connect, "a", "owner-a")).apps[0].version, 2, "the directory's card follows the release");

    /* ---- One that does waits for review: rejected with a reason, then approved ---------------- */
    await dev({ action: "update", id: app.id, scopes: ["conversations.read", "conversations.reply"] });
    await dev({ action: "publish", id: app.id, notes: "Replies too." });
    const r3 = (await releaseFromWorkspace(db.connect, "dev", "owner-dev", { id: app.id, version: 3 }, env)) as { submitted: string; versions: { releasedAt: string | null }[] };
    assert.ok(r3.submitted, "submitted instead of released");
    assert.equal(r3.versions[2].releasedAt, null);
    assert.deepEqual((await pendingReviews(db.connect))[0].widens, ["It asks for a new permission: conversations.reply."]);
    // Even asked for directly, the developer's own workspace refuses to release it unreviewed.
    const direct = await dev({ action: "release", id: app.id, version: 3 });
    assert.deepEqual(direct.review.widens, ["It asks for a new permission: conversations.reply."]);
    assert.equal(direct.versions[2].releasedAt, null);
    assert.equal(Object.values(await readInstallations(db.connect, "a"))[0].running, 2, "installations never see it while it waits");
    await assert.rejects(rejectSubmission(db.connect, r3.submitted, "Ada", ""), /Give the reason/);
    await rejectSubmission(db.connect, r3.submitted, "Ada", "Say what it replies with, and why it needs to.");
    const state = (await directoryStateFor(db.connect, "dev"))[app.id];
    assert.deepEqual([state.submissions[0].state, state.submissions[0].reason], ["rejected", "Say what it replies with, and why it needs to."]);
    const again = (await releaseFromWorkspace(db.connect, "dev", "owner-dev", { id: app.id, version: 3 }, env)) as { submitted: string };
    await approveSubmission(db.connect, again.submitted, "Ada");
    // Released by the approval; the installation waits for its own manager, as T3a decides.
    assert.deepEqual(
      (({ running, waiting, newScopes }) => ({ running, waiting, newScopes }))(Object.values(await readInstallations(db.connect, "a"))[0]),
      { running: 2, waiting: 3, newScopes: ["conversations.reply"] },
    );

    /* ---- Delisted: no new installs from the directory; installations keep working ------------ */
    await delistApp(db.connect, app.clientId, "Ada", "Its listing needs new screenshots.");
    assert.deepEqual((await readDirectory(db.connect, "b", "owner-b")).apps, []);
    assert.equal((await rest(inA.access_token, "/me")).status, 200);
    await assert.rejects(submitToDirectory(db.connect, "dev", "owner-dev", { id: app.id, version: 3 }, env), /only Relay can put it back/);
    await relistApp(db.connect, app.clientId, "Ada");
    assert.equal((await readDirectory(db.connect, "b", "owner-b")).apps.length, 1);

    /* ---- Suspended: stopped everywhere, with the reason; lifted, it works again ----------------- */
    const card = await q("a", "SELECT id FROM oauth_grants WHERE revoked_at IS NULL");
    await suspendApp(db.connect, app.clientId, "Ada", "It sent customer data to an undisclosed address.");
    const refused = await rest(inA.access_token, "/me");
    assert.equal(refused.status, 403);
    const why = ((await refused.json()) as { errors: { code: string; message: string }[] }).errors[0];
    assert.equal(why.code, "app_suspended");
    assert.match(why.message, /undisclosed address/, "the reason travels with the refusal");
    await assert.rejects(readConsent(db.connect, "b", "owner-b", ask), /Relay has suspended this app/);
    assert.equal((await token({ grant_type: "refresh_token", refresh_token: inA.refresh_token })).status, 401);
    assert.equal(Object.values(await readInstallations(db.connect, "a"))[0].suspended, "It sent customer data to an undisclosed address.");
    assert.deepEqual((await readDirectory(db.connect, "b", "owner-b")).apps, [], "out of the directory too");
    assert.deepEqual((await listCanvasApps(db.connect, "a", "owner-a", "settings")).apps, [], "and it draws nothing");
    await liftSuspension(db.connect, app.clientId, "Ada");
    assert.equal((await rest(inA.access_token, "/me")).status, 200, "the same token works again");
    await assert.rejects(liftSuspension(db.connect, app.clientId, "Ada"), /isn't suspended/);

    /* ---- Uninstalled: its cards and settings gone, and the app told, signed ------------------- */
    const grantId = card[0].id as string;
    await q("a", "UPDATE oauth_grants SET canvas_settings='{\"store\":\"x\"}',configured_at=now() WHERE id=$1", [grantId]);
    await q("a", "INSERT INTO canvas_sessions(workspace_id,id,grant_id,placement,teammate_id,canvas,expires_at) VALUES('a','s1',$1,'settings','owner','{}',now()+interval '1 hour')", [grantId]);
    await tenant(db.connect, "a", (x) => changeApps(x, "a", "owner-a", { action: "uninstall", id: grantId }, env));
    assert.deepEqual(await q("a", "SELECT canvas_settings,configured_at FROM oauth_grants WHERE id=$1", [grantId]), [{ canvas_settings: null, configured_at: null }]);
    assert.equal((await q("a", "SELECT 1 FROM canvas_sessions WHERE grant_id=$1", [grantId])).length, 0);
    const [job] = await q<Job>("a", "SELECT * FROM jobs WHERE kind='app.uninstalled'");
    assert.deepEqual(job.payload, { grantId });
    // A failure throws, so the job tries again (a few times); the uninstall stands regardless.
    appDown = true;
    await assert.rejects(notifyUninstalled(db.connect, env, job), /wasn't told/);
    appDown = false;
    const before = seen.length;
    assert.deepEqual(await notifyUninstalled(db.connect, env, job), { done: true, result: { sent: true } });
    const notice = seen.slice(before);
    assert.deepEqual(
      notice.map((n) => [n.url, n.body.type, n.body.installation_id, n.signature.length > 0]),
      [[APP + "/canvas/uninstalled", "uninstalled", grantId, true]],
    );
    assert.deepEqual(
      (await q<{ outcome: string }>("a", "SELECT outcome FROM canvas_calls WHERE kind='uninstalled' ORDER BY created_at")).map((c) => c.outcome),
      ["unreachable", "ok"],
      "both tries logged with the app's other requests",
    );

    /* ---- The widening rule on its own --------------------------------------------------------- */
    const base: Card = { name: "A", description: "d", developer: "x", clientId: "c", version: 1, scopes: ["a"], placements: ["settings"], installUrl: null, hosts: ["one.example"] };
    assert.deepEqual(widensReach(base, { ...base, version: 2, scopes: [] }), [], "fewer permissions is not wider");
    assert.deepEqual(widensReach(base, { ...base, hosts: ["one.example", "two.example"] }), ["It sends people or data to a new address: two.example."]);
    assert.deepEqual(widensReach(base, { ...base, placements: ["settings", "composer"] }), ["It shows somewhere new: composer."]);
    assert.deepEqual(widensReach(base, { ...base, name: "B", description: "e" }), ["Its name changes.", "Its description changes."]);
  } finally {
    await db.close();
  }
});
