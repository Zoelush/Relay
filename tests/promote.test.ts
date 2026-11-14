import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";

/**
 * Promoting a change from a test workspace to production (docs/TEST_WORKSPACE_PLAN.md, T2a):
 * what was tried in the pair becomes a published version in production — or is refused, in plain
 * words, because production has moved on or is missing something the change needs.
 */
const path = (id: string, steps: unknown[], next: unknown) => ({ id, label: "", steps, next });
const step = (type: string, options: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), type, options });
const triage = (teamId: string) => ({
  trigger: { type: "first_message", options: {} },
  paths: [path("A", [step("assign", { teamId })], { type: "end" })],
});

test("promoting from the test workspace: published as a version, refused on a conflict or a missing dependency, and recorded", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    storageTransport: "local-pglite",
  };
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  /** A request as the agent app makes it: the session's workspace, and the one chosen in it. */
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
  try {
    await tenant(db.connect, "a", (x) =>
      seedFoundation(x, "a", "owner-a", { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
    );
    await q("a", "UPDATE workspace_features SET enabled=true");
    await q("a", "DELETE FROM calendar_assignments");
    await q("a", "INSERT INTO teams(workspace_id,id,name) VALUES('a','support','Support')");
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");

    // Production has a live workflow and Zoe's page has been opened, so the pair starts in step.
    const made = await agent("workflow", { action: "create", name: "Triage", definition: triage("support") });
    const workflow = made.body.workflow.id as string;
    assert.equal((await agent("workflow", { action: "publish", id: workflow, version: made.body.workflow.version })).body.workflow.liveVersion, 1);
    assert.equal((await agent("zoe?view=guidance")).status, 200);
    // A help centre and a published messenger too, so the baselines T2b will read are proved here.
    await q("a", "INSERT INTO help_centers(workspace_id,id,brand_id,name,slug,default_locale,locales) VALUES('a','hc','default','Help','help','en','{en}')");
    await q("a", "INSERT INTO messenger_versions(workspace_id,brand_id,version,config,published_by) VALUES('a','default',1,'{}','owner')");

    const t = (await agent("workspaces", { action: "create_test" })).body.id as string;
    const inTest = (route: string, data?: unknown, principal = "owner-a") => agent(route, data, principal, t);
    // The baselines were taken where they are read: in production, for both sides of the pair.
    const baselines = await q<{ kind: string; object_id: string; version: string; from_version: string }>(
      "a",
      "SELECT kind,object_id,version::text AS version,from_version::text AS from_version FROM test_baselines ORDER BY kind,object_id",
    );
    assert.deepEqual(
      baselines.map((b) => b.kind),
      ["help_center", "messenger", "workflow", "zoe_guidance"],
      "every kind that publishes as versions, including the two T2b promotes: " + JSON.stringify(baselines),
    );
    assert.ok(
      baselines.every((b) => b.version === b.from_version),
      "a fresh pair is in step, because the copy gives both the same numbers",
    );
    assert.equal((await q(t, "SELECT 1 FROM test_baselines")).length, 0, "the test workspace keeps none of its own");

    // Nothing has changed in the pair yet, so there is nothing to promote.
    const quiet = await inTest("promotable");
    assert.equal(quiet.status, 200, JSON.stringify(quiet.body));
    assert.equal(quiet.body.into.id, "a");
    assert.deepEqual(
      quiet.body.candidates.map((c: any) => [c.kind, c.status]),
      [["workflow", "unchanged"], ["zoe_guidance", "unchanged"]],
    );
    assert.match(quiet.body.candidates[0].why, /Nothing has changed here/);
    // Only from a test workspace, and only for someone who may manage the workspace.
    assert.equal((await agent("promotable")).body.error.code, "NOT_A_TEST_WORKSPACE");
    assert.equal((await inTest("promotable", undefined, "agent-1-a")).status, 403);
    assert.equal((await inTest("promote", { kind: "workflow", id: workflow }, "agent-1-a")).status, 403);
    assert.equal((await inTest("promote", { kind: "messenger", id: "default" })).body.error.code, "INVALID_FIELD");

    /* A change tried in the pair, then promoted ------------------------------------------------ */

    const tried = await inTest("workflow", { action: "save", id: workflow, version: (await inTest("workflows?id=" + workflow)).body.workflow.version, name: "Triage", definition: triage("support") });
    assert.equal(tried.status, 200, JSON.stringify(tried.body));
    await inTest("workflow", { action: "publish", id: workflow, version: tried.body.workflow.version });
    const ready = (await inTest("promotable")).body.candidates.find((c: any) => c.kind === "workflow");
    assert.equal(ready.status, "ready", JSON.stringify(ready));
    assert.match(ready.why, /untouched in production/);

    const promoted = await inTest("promote", { kind: "workflow", id: workflow });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    assert.equal(promoted.body.promoted.version, 2, "a new published version in production, not an overwrite");
    const live = await q<{ live_version: number; state: string }>("a", "SELECT live_version,state FROM workflows WHERE id=$1", [workflow]);
    assert.deepEqual([live[0].live_version, live[0].state], [2, "live"]);
    assert.equal((await q("a", "SELECT 1 FROM workflow_versions WHERE workflow_id=$1", [workflow])).length, 2, "version 1 is still there to go back to");

    // Recorded where it landed: the ledger in production, and its audit log.
    const ledger = (await agent("promotions")).body.promotions;
    assert.deepEqual(
      ledger.map((p: any) => [p.kind, p.name, p.from, p.version]),
      [["workflow", "Triage", t, 2]],
    );
    assert.equal(ledger[0].by, "Support teammate", "who promoted it, as the audit log names them");
    assert.equal((await q("a", "SELECT 1 FROM audit_events WHERE action='workspace.promoted'")).length, 1);
    assert.deepEqual((await inTest("promotions")).body.promotions, [], "nothing was promoted into the test workspace");
    // The ledger is append-only, like the other records of what happened.
    await assert.rejects(q("a", "UPDATE promotions SET object_name='else'"), /append-only/);

    // Promoting again changes nothing: the two are in step, and the promotion itself moved the mark.
    const again = (await inTest("promotable")).body.candidates.find((c: any) => c.kind === "workflow");
    assert.equal(again.status, "unchanged", JSON.stringify(again));
    assert.equal((await inTest("promote", { kind: "workflow", id: workflow })).body.error.code, "NOT_PROMOTABLE");

    /* Production moved on: refused, never overwritten ------------------------------------------ */

    const here = (await inTest("workflows?id=" + workflow)).body.workflow;
    await inTest("workflow", { action: "save", id: workflow, version: here.version, name: "Triage", definition: triage("support") });
    const there = (await agent("workflows?id=" + workflow)).body.workflow;
    await agent("workflow", { action: "save", id: workflow, version: there.version, name: "Triage", definition: triage("support") });
    const clash = (await inTest("promotable")).body.candidates.find((c: any) => c.kind === "workflow");
    assert.equal(clash.status, "changed_in_production");
    assert.match(clash.why, /changed in production/);
    const refused = await inTest("promote", { kind: "workflow", id: workflow });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "NOT_PROMOTABLE");
    assert.equal((await q<{ live_version: number }>("a", "SELECT live_version FROM workflows WHERE id=$1", [workflow]))[0].live_version, 2, "production keeps what it had");

    /* Something production hasn't got: refused, with what's missing ---------------------------- */

    await q(t, "INSERT INTO teams(workspace_id,id,name) VALUES($1,'weekend','Weekend')", [t]);
    const local = await inTest("workflow", { action: "create", name: "Weekend cover", definition: triage("weekend") });
    const localId = local.body.workflow.id as string;
    await inTest("workflow", { action: "publish", id: localId, version: local.body.workflow.version });
    const needs = (await inTest("promotable")).body.candidates.find((c: any) => c.id === localId);
    assert.equal(needs.status, "needs");
    assert.deepEqual(needs.missing, ["Path A, step 1: its team doesn't exist."], "the same check publishing makes, asked of production");
    const refusedNeeds = await inTest("promote", { kind: "workflow", id: localId });
    assert.equal(refusedNeeds.body.error.code, "PROMOTION_NEEDS");
    assert.deepEqual(refusedNeeds.body.error.details.missing, ["Path A, step 1: its team doesn't exist."]);
    assert.equal((await q("a", "SELECT 1 FROM workflows WHERE id=$1", [localId])).length, 0, "nothing half-made in production");

    // With the team there, the same workflow is new to production and arrives live.
    await q("a", "INSERT INTO teams(workspace_id,id,name) VALUES('a','weekend','Weekend')");
    const now = (await inTest("promotable")).body.candidates.find((c: any) => c.id === localId);
    assert.equal(now.status, "ready");
    assert.match(now.why, /New here/);
    assert.equal((await inTest("promote", { kind: "workflow", id: localId })).body.promoted.version, 1);
    const arrived = await q<{ name: string; state: string; live_version: number }>("a", "SELECT name,state,live_version FROM workflows WHERE id=$1", [localId]);
    assert.deepEqual([arrived[0].name, arrived[0].state, arrived[0].live_version], ["Weekend cover", "live", 1]);

    // A name production already uses on another workflow is refused rather than taken.
    const twin = await inTest("workflow", { action: "create", name: "Second", definition: triage("support") });
    await inTest("workflow", { action: "publish", id: twin.body.workflow.id, version: twin.body.workflow.version });
    await q("a", "UPDATE workflows SET name='Second' WHERE id=$1", [localId]);
    const taken = (await inTest("promotable")).body.candidates.find((c: any) => c.id === twin.body.workflow.id);
    assert.equal(taken.status, "name_taken");
    assert.match(taken.why, /already called Second/);

    /* Zoe's guidance -------------------------------------------------------------------------- */

    const guidance = (await inTest("zoe?view=guidance")).body;
    const guideline = {
      id: "plain",
      category: "style",
      title: "Plain words",
      text: "Use plain words and short sentences.",
      enabled: true,
      audience: "everyone",
      brandId: null,
      specialistId: null,
    };
    const saved = await inTest("zoe-guidance", { version: guidance.version, tone: "professional", guidance: [guideline] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const her = (await inTest("promotable")).body.candidates.find((c: any) => c.kind === "zoe_guidance");
    assert.equal(her.status, "ready", JSON.stringify(her));
    assert.equal((await inTest("promote", { kind: "zoe_guidance", id: "default" })).body.promoted.version, 1);
    const inProduction = await q<{ tone: string; guidance_version: number; answer_guidance: any[] }>("a", "SELECT tone,guidance_version,answer_guidance FROM ai_agents WHERE id='default'");
    assert.deepEqual([inProduction[0].tone, inProduction[0].guidance_version], ["professional", 1]);
    assert.deepEqual(inProduction[0].answer_guidance.map((g: any) => g.title), ["Plain words"]);
    assert.equal((await q("a", "SELECT 1 FROM ai_guidance_versions WHERE agent_id='default'")).length, 1, "saved as a version there, so it can be restored");

    // Guidance for a specialist only the test workspace has: refused with which guideline it is.
    await q(t, "INSERT INTO ai_specialists(workspace_id,id,agent_id,name,handles) VALUES($1,'billing','default','Billing','Billing questions')", [t]);
    const forSpecialist = await inTest("zoe-guidance", {
      version: (await inTest("zoe?view=guidance")).body.version,
      guidance: [{ ...guideline, specialistId: "billing" }],
    });
    assert.equal(forSpecialist.status, 200, JSON.stringify(forSpecialist.body));
    const hers = (await inTest("promotable")).body.candidates.find((c: any) => c.kind === "zoe_guidance");
    assert.equal(hers.status, "needs");
    assert.deepEqual(hers.missing, ["“Plain words” is for a specialist production doesn't have."]);
    assert.equal((await inTest("promote", { kind: "zoe_guidance", id: "default" })).body.error.code, "PROMOTION_NEEDS");
    assert.equal((await q<{ guidance_version: number }>("a", "SELECT guidance_version FROM ai_agents WHERE id='default'"))[0].guidance_version, 1, "hers in production is untouched");
  } finally {
    await db.close();
  }
});
