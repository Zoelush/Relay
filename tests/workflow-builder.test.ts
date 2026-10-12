import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { LAYOUT_COLUMN, LAYOUT_ROW, autoLayout, checkLayout, nextLetter, outlets, validate } from "../lib/workflow-definition";

const path = (id: string, steps: unknown[], next: unknown) => ({ id, label: "", steps, next });
const step = (type: string, options: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), type, options });
const lang = (value: string) => ({ field: "conversation.language", op: "is", value });

/** The builder's shared pieces (phase 11, W2; docs/WORKFLOWS_STEP2.md). */
test("the builder's layout: ways on as handles, cards tidied into columns, positions checked, paths lettered", () => {
  const def = validate({
    trigger: { type: "first_message", options: {} },
    paths: [
      path("A", [], { type: "branch", branches: [{ label: "French", when: { match: "all", items: [lang("fr")] }, path: "B" }], else: "C" }),
      path("B", [], { type: "wait_until", when: { match: "all", items: [lang("fr")] }, timeoutSeconds: 3600, met: "D", timedOut: "" }),
      path("C", [], { type: "goto", path: "D" }),
      path("D", [], { type: "end" }),
      path("E", [], { type: "end" }),
    ],
  });
  assert.deepEqual(outlets(def.paths[0]), [
    { id: "b0", label: "French", target: "B" },
    { id: "else", label: "Else", target: "C" },
  ]);
  assert.deepEqual(outlets(def.paths[1]), [
    { id: "met", label: "When it holds", target: "D" },
    { id: "timedOut", label: "If it times out", target: "" },
  ]);
  assert.deepEqual(outlets(def.paths[2]), [{ id: "next", label: "Then", target: "D" }]);
  assert.deepEqual(outlets(def.paths[3]), []);
  // Columns by distance from the trigger, in path order within one; the unreachable path last.
  assert.deepEqual(autoLayout(def), {
    trigger: { x: 0, y: 0 },
    A: { x: LAYOUT_COLUMN, y: 0 },
    B: { x: 2 * LAYOUT_COLUMN, y: 0 },
    C: { x: 2 * LAYOUT_COLUMN, y: LAYOUT_ROW },
    D: { x: 3 * LAYOUT_COLUMN, y: 0 },
    E: { x: 4 * LAYOUT_COLUMN, y: 0 },
  });
  // Only known cards, finite numbers, rounded and kept on the canvas.
  assert.deepEqual(checkLayout({ trigger: { x: 1.4, y: -2.6 }, A: { x: 9e9, y: 0 }, Z: { x: 1, y: 1 }, B: { x: "1", y: 2 }, C: { x: Infinity, y: 0 } }, def), {
    trigger: { x: 1, y: -3 },
    A: { x: 100000, y: 0 },
  });
  assert.deepEqual(checkLayout("nonsense", def), {});
  assert.equal(nextLetter(def), "F");
  const full = validate({ trigger: { type: "manual" }, paths: [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map((id) => path(id, [], { type: "end" })) });
  assert.equal(nextLetter(full), "AA");
});

test("workflows' builder API: layouts kept beside drafts, pickers' options, and a live estimate of who it runs for", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const agent = async (path: string, data?: unknown, principal = "owner-a", workspace = "a") => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: { origin: "https://app.test", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
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
  const start = (w: string, text: string) =>
    tenant(db.connect, w, async (q) => {
      const identity = await getIdentity(q, w, "anonymous", crypto.randomUUID(), {});
      return ((await command(q, w, { type: "contact", identityId: identity.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text })) as { conversationId: string })
        .conversationId;
    });
  const estimate = (when: unknown, principal = "owner-a", workspace = "a") => agent(`workflow-estimate?when=${encodeURIComponent(JSON.stringify(when))}`, undefined, principal, workspace);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
      );
      await sql(w, "DELETE FROM calendar_assignments");
      await sql(w, "UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
    }
    await sql("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");
    await sql("a", "INSERT INTO tags(workspace_id,id,name) VALUES('a','vip','VIP'),('a','refund','Refund')");
    await sql("a", "INSERT INTO tags(workspace_id,id,name,archived_at) VALUES('a','gone','Gone',now())");
    await sql("a", "INSERT INTO teams(workspace_id,id,name) VALUES('a','fr','French')");
    await sql("a", "UPDATE workspace_features SET enabled=true WHERE name='settings_v1'");

    const linked = async (principal = "owner-a") => ((await agent("settings?section=overview", undefined, principal)).body.pages as string[]).includes("workflows");
    // Off by default: no area, no link in Settings, no estimate.
    assert.equal((await agent("inbox")).body.capabilities.workflows, false);
    assert.equal(await linked(), false);
    assert.equal((await estimate({ match: "all", items: [] })).body.error.code, "WORKFLOWS_DISABLED");
    await sql("a", "UPDATE workspace_features SET enabled=true WHERE name='workflows_v1'");
    await sql("b", "UPDATE workspace_features SET enabled=true WHERE name='workflows_v1'");
    assert.equal((await agent("inbox")).body.capabilities.workflows, true);
    // Only for those who manage the workspace.
    assert.equal((await agent("inbox", undefined, "agent-1-a")).body.capabilities.workflows, false);
    assert.equal(await linked(), true);
    assert.equal(await linked("agent-1-a"), false);
    assert.equal((await estimate({ match: "all", items: [] }, "agent-1-a")).status, 403);

    // Created with card positions; read with what the pickers offer (archived tags left out).
    const definition = {
      trigger: { type: "first_message", options: {} },
      paths: [
        path("A", [], { type: "branch", branches: [{ label: "French", when: { match: "all", items: [lang("fr")] }, path: "B" }], else: "C" }),
        path("B", [step("assign", { teamId: "fr" })], { type: "end" }),
        path("C", [step("tag_add", { tagId: "vip" })], { type: "end" }),
      ],
    };
    const made = await agent("workflow", { action: "create", name: "Route French", definition, layout: { trigger: { x: 0, y: 0 }, A: { x: 400, y: 10 }, Q: { x: 1, y: 1 } } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const wf = made.body.workflow;
    assert.deepEqual(wf.layout, { trigger: { x: 0, y: 0 }, A: { x: 400, y: 10 } });
    assert.deepEqual(
      made.body.options.tags.map((t: { id: string }) => t.id),
      ["refund", "vip"],
    );
    assert.deepEqual(made.body.options.teams, [{ id: "fr", name: "French" }]);
    assert.ok(made.body.options.teammates.some((t: { id: string }) => t.id === "agent-1"));
    for (const k of ["brands", "attributes", "slaPolicies", "ticketTypes"]) assert.ok(Array.isArray(made.body.options[k]), k);
    assert.equal(typeof wf.updatedAt, "string");

    // Saved with a new layout; then without one, the old is kept for cards that still exist.
    let saved = await agent("workflow", { action: "save", id: wf.id, version: wf.version, name: "Route French", definition, layout: { trigger: { x: 0, y: 0 }, A: { x: 380, y: 0 }, B: { x: 760, y: 0 }, C: { x: 760, y: 260 } } });
    assert.deepEqual(saved.body.workflow.layout.C, { x: 760, y: 260 });
    const fewer = { ...definition, paths: [path("A", [], { type: "goto", path: "B" }), definition.paths[1]] };
    saved = await agent("workflow", { action: "save", id: wf.id, version: saved.body.workflow.version, name: "Route French", definition: fewer });
    assert.deepEqual(saved.body.workflow.layout, { trigger: { x: 0, y: 0 }, A: { x: 380, y: 0 }, B: { x: 760, y: 0 } });
    // Published, moving cards isn't an unpublished change; editing the draft is.
    const live = await agent("workflow", { action: "publish", id: wf.id, version: saved.body.workflow.version });
    assert.equal(live.body.workflow.changed, false);
    saved = await agent("workflow", { action: "save", id: wf.id, version: live.body.workflow.version, name: "Route French", definition: fewer, layout: { trigger: { x: 50, y: 50 } } });
    assert.equal(saved.body.workflow.changed, false);
    assert.deepEqual(saved.body.workflow.layout, { trigger: { x: 50, y: 50 } });
    assert.equal((await sql("a", "SELECT definition FROM workflow_versions WHERE workflow_id=$1", [wf.id]))[0].definition.layout, undefined);
    saved = await agent("workflow", { action: "save", id: wf.id, version: saved.body.workflow.version, name: "Route French", definition });
    assert.equal(saved.body.workflow.changed, true);
    // Another workspace can't read it, or its layout.
    assert.equal((await agent(`workflows?id=${wf.id}`, undefined, "owner-b", "b")).status, 404);

    // The estimate: of recent conversations, how many "who it runs for" lets through, judged as a run would.
    const fr1 = await start("a", "Bonjour, ma commande est en retard, pouvez-vous m'aider ?");
    await start("a", "Bonjour, je voudrais changer mon adresse de livraison s'il vous plaît.");
    await start("a", "Hello, my order is late, can you help?");
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "tag_add", conversationId: fr1, tagId: "vip" } as never));
    // A conversation merged into another is counted once, as the one it went into.
    const old = await start("a", "Bonjour, encore une question");
    await sql("a", "UPDATE conversations SET merged_into_id=$2 WHERE id=$1", [old, fr1]);
    let e = (await estimate({ match: "all", items: [] })).body;
    assert.deepEqual(e, { sample: 3, matched: 3, days: 30, limit: 500, assumed: [] });
    e = (await estimate({ match: "all", items: [lang("fr")] })).body;
    assert.equal(e.matched, 2);
    e = (await estimate({ match: "all", items: [lang("fr"), { field: "conversation.tag", op: "has", value: "vip" }] })).body;
    assert.equal(e.matched, 1);
    e = (await estimate({ match: "any", items: [lang("en"), { match: "all", items: [{ field: "conversation.tag", op: "has", value: "vip" }] }] })).body;
    assert.equal(e.matched, 2);
    // What depends on the moment is taken to hold, and named: the figure is then at most.
    e = (await estimate({ match: "all", items: [lang("fr"), { field: "office_hours", op: "is", value: "closed" }, { field: "message.text", op: "contains", value: "x" }] })).body;
    assert.equal(e.matched, 2);
    assert.deepEqual(e.assumed, ["The message", "Office hours"]);
    // Old conversations fall out of the window.
    await sql("a", "UPDATE conversations SET created_at=now()-interval '31 days' WHERE id=$1", [fr1]);
    assert.equal((await estimate({ match: "all", items: [lang("fr")] })).body.matched, 1);
    // Unfinished or unreadable conditions are refused in words, never estimated as "no match".
    const bad = await estimate({ match: "all", items: [lang("")] });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.message, "Who it runs for: give a value for Language.");
    assert.match((await estimate({ match: "all", items: [{ field: "topic", op: "is", value: "billing" }] })).body.error.message, /arrive with phase 14/);
    assert.equal((await agent("workflow-estimate?when=%7Bnot-json")).body.error.message, "The conditions couldn't be read.");
    // Another workspace's estimate sees only its own conversations.
    assert.deepEqual((await estimate({ match: "all", items: [] }, "owner-b", "b")).body.sample, 0);
    await start("b", "Bonjour");
    assert.deepEqual((await estimate({ match: "all", items: [] }, "owner-b", "b")).body.sample, 1);

    // The rollback clears positions; drafts and versions stay.
    const rollback = await readFile("db/rollback/0059_workflow_builder.sql", "utf8");
    await sql("a", rollback);
    const after = (await sql<{ layout: unknown; draft: unknown }>("a", "SELECT layout,draft FROM workflows WHERE id=$1", [wf.id]))[0];
    assert.deepEqual(after.layout, {});
    assert.ok(after.draft);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM workflow_versions WHERE workflow_id=$1", [wf.id]))[0].n, 1);
  } finally {
    await db.close();
  }
});
