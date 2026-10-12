import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { memoryVectorStore, testEmbedder, type IndexEnvironment } from "../server/knowledge-index";
import { standInAnswerModel, standInClassifier, standInReranker } from "../server/ai-model";
import { checkMonitors } from "../server/zoe-monitors";
import { changeSentence, tripped } from "../lib/zoe-monitors";

test("monitor thresholds: a sharp change the bad way, by sensitivity, in either direction", () => {
  // Up is bad: at least the points, and at least the factor.
  assert.equal(tripped("unknown_rate", "medium", 0.2, 0.08), true);
  assert.equal(tripped("unknown_rate", "medium", 0.15, 0.08), false); // under 10 points
  assert.equal(tripped("unknown_rate", "medium", 0.65, 0.5), false); // 15 points, but not double
  assert.equal(tripped("unknown_rate", "low", 0.2, 0.08), false);
  assert.equal(tripped("unknown_rate", "high", 0.14, 0.08), true);
  assert.equal(tripped("error_rate", "medium", 0.1, 0), true);
  assert.equal(tripped("error_rate", "medium", 0, 0.3), false); // better is never an incident
  // Down is bad for "That helped".
  assert.equal(tripped("helped_rate", "medium", 0.1, 0.3), true);
  assert.equal(tripped("helped_rate", "medium", 0.5, 0.3), false);
  assert.equal(changeSentence("unknown_rate", 0.048, 0.333), "“I don't know” rate rose from 4.8% to 33.3%");
  assert.equal(changeSentence("helped_rate", 0.3, 0.1), "“That helped” rate fell from 30% to 10%");
});

/** Zoe's monitors and incidents (phase 08, C2b; docs/AI_STEP12.md). */
test("Zoe's monitors: an hourly check opens one incident on a sharp change, notifies her managers, and resolves by itself, by hand or when switched off; per workspace", async () => {
  const db = await testDatabase();
  const index: IndexEnvironment = { embedders: [testEmbedder()], vectors: memoryVectorStore() };
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    knowledgeIndex: index,
    ai: {
      model: standInAnswerModel(),
      rerank: standInReranker(),
      index,
      classify: standInClassifier(),
    },
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
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
  const HOUR = 3_600_000;
  let n = 0;
  /** Answers Zoe gave this many hours ago, each in its own conversation. */
  const answers = async (count: number, outcome: string, hoursAgo: number, w = "a") => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++)
      await tenant(db.connect, w, async (q) => {
        const identity = await getIdentity(q, w, "anonymous", "customer-" + ++n);
        const { conversationId } = (await command(
          q,
          w,
          { type: "contact", identityId: identity.identityId, brandId: "default" },
          "start-key-" + n,
          { action: "start", text: "Question " + n },
        )) as { conversationId: string };
        const part = (
          await q.query<{ id: string }>(
            "SELECT id FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY created_at LIMIT 1",
            [w, conversationId],
          )
        ).rows[0];
        await q.query(
          `INSERT INTO ai_answers(workspace_id,id,agent_id,conversation_id,question_part_id,outcome,reason,threshold,prompt_version,created_at)
           SELECT $1,$2,id,$3,$4,$5,'test',0.5,'test',now()-make_interval(hours=>$6) FROM ai_agents WHERE workspace_id=$1`,
          [w, "answer-" + n, conversationId, part.id, outcome, hoursAgo],
        );
        ids.push(conversationId);
      });
    return ids;
  };
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, {
          origins: [],
          master: env.identityMaster,
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        }),
      );
      await sql(
        w,
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name IN ('knowledge_v1','knowledge_index_v1','ai_agent_v1')",
        [w],
      );
      // Her agent row, with its settings changed long ago.
      await agent("zoe?view=overview", undefined, "owner-" + w, w);
      await sql(w, "UPDATE ai_agents SET updated_at=now()-interval '30 days'");
    }
    await sql(
      "a",
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')",
    );

    // The usual week: 40 answers and 2 "I don't know"; the last 24 hours: 20 answers and 10.
    await answers(40, "answered", 60);
    await answers(2, "unknown", 50);
    await answers(20, "answered", 3);
    const unknown = await answers(10, "unknown", 2);
    // Published shortly before: listed with the incident.
    await sql(
      "a",
      "INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_help_center) VALUES('a','refunds','article','owner','public',true,true)",
    );
    await sql(
      "a",
      `INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,published_title,published_text,published_revision,published_at)
       VALUES('a','refunds','en','published','Refunds','Refunds','Refunds take five days.',1,now()-interval '5 hours')`,
    );

    // Off by default.
    const now = Date.now();
    assert.equal(await checkMonitors(db.connect, "a", now), null);
    assert.equal((await agent("zoe?view=monitors")).body.error.code, "MONITORS_DISABLED");
    assert.equal((await agent("zoe?view=overview")).body.incidents, null);

    await sql("a", "UPDATE workspace_features SET enabled=true WHERE name='zoe_monitors_v1'");
    // One check an hour; the "I don't know" rate opens an incident.
    assert.deepEqual(await checkMonitors(db.connect, "a", now), { opened: ["unknown_rate"], resolved: [] });
    assert.equal(await checkMonitors(db.connect, "a", now), null);

    const monitors = (await agent("zoe?view=monitors")).body;
    assert.ok(monitors.lastCheckedAt);
    const by = Object.fromEntries(monitors.monitors.map((m: any) => [m.metric, m]));
    assert.equal(by.unknown_rate.status, "tripped");
    assert.ok(by.unknown_rate.incidentId);
    assert.equal(by.unknown_rate.volume, 30);
    assert.equal(by.unknown_rate.baselineVolume, 42);
    assert.equal(by.handover_rate.status, "normal");
    assert.equal(by.bad_review_rate.status, "low_volume");
    assert.equal(by.unknown_rate.sensitivity, "medium");

    let incidents = (await agent("zoe?view=incidents")).body;
    assert.equal(incidents.open.length, 1);
    const incident = incidents.open[0];
    assert.equal(incident.metric, "unknown_rate");
    assert.equal(incident.status, "open");
    assert.ok(Math.abs(incident.baseline - 2 / 42) < 1e-4);
    assert.ok(Math.abs(incident.openedValue - 1 / 3) < 1e-4);
    assert.equal(incident.examples.length, 5);
    assert.ok(incident.examples.every((c: string) => unknown.includes(c)));
    assert.deepEqual(
      incident.changes.map((c: any) => [c.kind, c.label]),
      [["content", "“Refunds” published"]],
    );
    assert.deepEqual((await agent("zoe?view=overview")).body.incidents.open.map((i: any) => i.metric), [
      "unknown_rate",
    ]);

    // Her managers are notified in the app, once; nobody else.
    const notes = (await agent("notifications")).body;
    assert.equal(notes.unread, 1);
    assert.equal(notes.items[0].kind, "zoe_incident");
    assert.equal(notes.items[0].incidentId, incident.id);
    assert.equal(notes.items[0].excerpt, "“I don't know” rate rose from 4.8% to 33.3%");
    assert.equal(notes.items[0].conversationId, null);
    assert.equal((await agent("notifications", undefined, "agent-1-a")).body.items.length, 0);

    // Still sharp an hour later: the same incident, updated.
    assert.deepEqual(await checkMonitors(db.connect, "a", now + HOUR), { opened: [], resolved: [] });
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM ai_incidents"))[0].n, 1);
    assert.equal((await agent("notifications")).body.unread, 1);

    // Managers only; only their own workspace's.
    assert.equal((await agent("zoe?view=incidents", undefined, "agent-1-a")).status, 403);
    await sql("b", "UPDATE workspace_features SET enabled=true WHERE name='zoe_monitors_v1'");
    assert.deepEqual((await agent("zoe?view=incidents", undefined, "owner-b", "b")).body.open, []);
    const across = await agent(
      "zoe-monitors",
      { action: "resolve", incidentId: incident.id, version: incident.version },
      "owner-b",
      "b",
    );
    assert.equal(across.body.error.code, "INCIDENT_NOT_FOUND");
    assert.equal((await agent("notifications", undefined, "owner-b", "b")).body.items.length, 0);

    // Acknowledged, by version, with a note.
    incidents = (await agent("zoe?view=incidents")).body;
    const current = incidents.open[0];
    assert.equal(
      (await agent("zoe-monitors", { action: "acknowledge", incidentId: current.id, version: "0" })).body.error.code,
      "INCIDENT_CHANGED",
    );
    const acked = await agent("zoe-monitors", {
      action: "acknowledge",
      incidentId: current.id,
      version: current.version,
      note: "Looking at the new returns policy.",
    });
    assert.equal(acked.status, 200, JSON.stringify(acked.body));
    assert.equal(acked.body.open[0].status, "acknowledged");
    assert.equal(acked.body.open[0].acknowledgedBy, "Support teammate");
    assert.equal(acked.body.open[0].note, "Looking at the new returns policy.");

    // Back to normal: two normal checks in a row resolve it.
    await sql("a", "UPDATE ai_answers SET outcome='answered' WHERE outcome='unknown' AND created_at>now()-interval '1 day'");
    assert.deepEqual(await checkMonitors(db.connect, "a", now + 2 * HOUR), { opened: [], resolved: [] });
    assert.equal((await agent("zoe?view=incidents")).body.open[0].normalChecks, 1);
    assert.deepEqual(await checkMonitors(db.connect, "a", now + 3 * HOUR), {
      opened: [],
      resolved: ["unknown_rate"],
    });
    incidents = (await agent("zoe?view=incidents")).body;
    assert.deepEqual(incidents.open, []);
    assert.equal(incidents.recent[0].resolution, "auto");
    assert.equal(incidents.recent[0].note, "Looking at the new returns policy.");

    // It happens again: a new incident and a new notification; resolved by hand, once.
    await sql(
      "a",
      "UPDATE ai_answers SET outcome='unknown' WHERE conversation_id=ANY($1::text[])",
      [unknown],
    );
    assert.deepEqual(await checkMonitors(db.connect, "a", now + 4 * HOUR), { opened: ["unknown_rate"], resolved: [] });
    assert.equal((await agent("notifications")).body.unread, 2);
    const second = (await agent("zoe?view=incidents")).body.open[0];
    const done = await agent("zoe-monitors", {
      action: "resolve",
      incidentId: second.id,
      version: second.version,
      note: "Article fixed.",
    });
    // (The checks above ran in simulated later hours, so look incidents up by id.)
    const manual = done.body.recent.find((i: any) => i.id === second.id);
    assert.equal(manual.resolution, "manual");
    assert.equal(manual.resolvedBy, "Support teammate");
    assert.equal(manual.note, "Article fixed.");
    const fresh = (await sql("a", "SELECT version::text AS v FROM ai_incidents WHERE id=$1", [second.id]))[0].v;
    assert.equal(
      (await agent("zoe-monitors", { action: "resolve", incidentId: second.id, version: fresh })).body.error.code,
      "INCIDENT_RESOLVED",
    );

    // A monitor's setting: validated, by version; switching it off resolves its incident and stops it.
    assert.deepEqual(await checkMonitors(db.connect, "a", now + 5 * HOUR), { opened: ["unknown_rate"], resolved: [] });
    const code = async (body: unknown) => (await agent("zoe-monitors", body)).body.error?.code;
    assert.equal(await code({ action: "monitor", metric: "mood", enabled: true, sensitivity: "low", version: "0" }), "INVALID_MONITORS");
    assert.equal(await code({ action: "monitor", metric: "unknown_rate", enabled: true, sensitivity: "max", version: "0" }), "INVALID_MONITORS");
    assert.equal(await code({ action: "monitor", metric: "unknown_rate", enabled: "no", sensitivity: "low", version: "0" }), "INVALID_MONITORS");
    assert.equal(await code({ action: "monitor", metric: "unknown_rate", enabled: false, sensitivity: "low", version: "3" }), "MONITOR_CHANGED");
    const off = await agent("zoe-monitors", {
      action: "monitor",
      metric: "unknown_rate",
      enabled: false,
      sensitivity: "low",
      version: "0",
    });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const offBy = Object.fromEntries(off.body.monitors.map((m: any) => [m.metric, m]));
    assert.deepEqual([offBy.unknown_rate.enabled, offBy.unknown_rate.sensitivity, offBy.unknown_rate.status, offBy.unknown_rate.version], [
      false,
      "low",
      "off",
      "1",
    ]);
    assert.equal(offBy.unknown_rate.incidentId, null);
    assert.deepEqual(
      (await agent("zoe?view=incidents")).body.recent.map((i: any) => i.resolution).sort(),
      ["auto", "manual", "monitor_off"],
    );
    assert.deepEqual(await checkMonitors(db.connect, "a", now + 6 * HOUR), { opened: [], resolved: [] });
    assert.deepEqual(
      await sql("a", "SELECT status FROM ai_monitor_checks WHERE metric='unknown_rate' ORDER BY hour DESC LIMIT 1"),
      [{ status: "off" }],
    );

    // The rollback: the flag off everywhere, and incident notifications read (the previous version
    // can't show them).
    const rollback = await readFile("db/rollback/0053_zoe_monitors.sql", "utf8");
    for (const statement of rollback
      .split("\n")
      .filter((l) => !l.startsWith("--"))
      .join("\n")
      .split(";")
      .filter((x) => x.trim()))
      await tenant(db.connect, "a", (q) => q.query(statement));
    assert.equal((await agent("zoe?view=monitors")).body.error.code, "MONITORS_DISABLED");
    assert.equal((await agent("notifications")).body.unread, 0);
    assert.equal(await checkMonitors(db.connect, "a", now + 7 * HOUR), null);
  } finally {
    await db.close();
  }
});
