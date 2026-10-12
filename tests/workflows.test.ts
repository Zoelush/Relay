import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { runJob, type Job } from "../server/jobs";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { resumeDueWorkflows, resumeWorkflow, startWorkflows } from "../server/workflow-engine";
import { DefinitionError, problems, validate, type Definition } from "../lib/workflow-definition";

const path = (id: string, steps: unknown[], next: unknown) => ({ id, label: "", steps, next });
const step = (type: string, options: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), type, options });

test("a workflow's definition: checked in shape on save, and for its graph before publishing", () => {
  const ok: Definition = validate({
    trigger: { type: "first_message", options: {} },
    paths: [
      path("A", [step("tag_add", { tagId: "x" })], {
        type: "branch",
        branches: [{ label: "French", when: { match: "all", items: [{ field: "conversation.language", op: "is", value: "fr" }] }, path: "B" }],
        else: "C",
      }),
      path("B", [], { type: "end" }),
      path("C", [], { type: "end" }),
    ],
  });
  assert.deepEqual(problems(ok), []);
  const refuse = (def: unknown, message: RegExp) => assert.throws(() => validate(def), (e) => e instanceof DefinitionError && message.test(e.message));
  refuse({ trigger: { type: "segment_changed" }, paths: [path("A", [], { type: "end" })] }, /arrives with phase 13/);
  refuse({ trigger: { type: "nope" }, paths: [path("A", [], { type: "end" })] }, /Choose what starts/);
  refuse(
    { trigger: { type: "first_message" }, when: { match: "all", items: [{ field: "topic", op: "is", value: "billing" }] }, paths: [path("A", [], { type: "end" })] },
    /topic conditions arrive with phase 14 \(topics\); it can't be evaluated yet/,
  );
  refuse(
    { trigger: { type: "first_message" }, when: { match: "all", items: [{ match: "any", items: [{ match: "all", items: [{ match: "any", items: [] }] }] }] }, paths: [path("A", [], { type: "end" })] },
    /nest groups at most 3 deep/,
  );
  refuse({ trigger: { type: "first_message" }, paths: [path("A", [step("send_email")], { type: "end" })] }, /isn't a step a workflow can take yet/);
  refuse({ trigger: { type: "first_message" }, paths: [path("A", [step("wait", { seconds: 5 })], { type: "end" })] }, /between a minute and 30 days/);
  refuse({ trigger: { type: "first_message" }, paths: [path("a", [], { type: "end" })] }, /letter it A/);
  // Graph problems block publishing, each said plainly.
  const bad = validate({
    trigger: { type: "first_message" },
    paths: [
      path("A", [], { type: "branch", branches: [{ label: "x", when: { match: "all", items: [] }, path: "B" }], else: "Z" }),
      path("B", [], { type: "goto", path: "C" }),
      path("C", [], { type: "goto", path: "B" }),
      path("D", [], { type: "end" }),
    ],
  });
  assert.deepEqual(problems(bad), [
    "Path A: it leads to path Z, which doesn't exist.",
    "Path A, branch 1: give it a condition.",
    "Path D can't be reached from path A.",
    "Path A never reaches an end.",
    "Path B never reaches an end.",
    "Path C never reaches an end.",
  ]);
});

/** The workflow engine (phase 11, W1; docs/WORKFLOWS_STEP1.md). */
test("workflows: triggered by what happens, conditions and actions recorded step by step, versions pinned, waits resumed, loops and limits stopped, failures isolated", async () => {
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
  const handlers = {
    "workflow.start": (j: Job) => startWorkflows(db.connect, j),
    "workflow.resume": (j: Job) => resumeWorkflow(db.connect, j),
  };
  const drain = async (w = "a") => {
    for (let i = 0; i < 60; i++) {
      const job = (await sql<{ id: string }>(w, "SELECT id FROM jobs WHERE kind LIKE 'workflow.%' AND state IN ('queued','running') ORDER BY created_at LIMIT 1"))[0];
      if (!job) return;
      await runJob(db.connect, w, job.id, handlers);
    }
  };
  const agent = async (path: string, data?: unknown, principal = "owner-a", workspace = "a", key: string = crypto.randomUUID()) => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: { origin: "https://app.test", "content-type": "application/json", "idempotency-key": key },
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
  /** Creates and publishes a workflow; returns its id. */
  const publish = async (name: string, definition: unknown) => {
    const made = await agent("workflow", { action: "create", name, definition });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const r = await agent("workflow", { action: "publish", id: made.body.workflow.id, version: made.body.workflow.version });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return made.body.workflow.id as string;
  };
  const start = async (text: string) => {
    const id = await tenant(db.connect, "a", async (q) => {
      const identity = await getIdentity(q, "a", "anonymous", crypto.randomUUID(), {});
      return ((await command(q, "a", { type: "contact", identityId: identity.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text })) as { conversationId: string })
        .conversationId;
    });
    await drain();
    return id;
  };
  const teammate = async (conversationId: string, p: Record<string, unknown>) => {
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { conversationId, ...p } as never));
    await drain();
  };
  const runsOf = (conversationId: string) =>
    sql<{ id: string; workflow_id: string; status: string; reason: string; error: string; workflow_version: number }>(
      "a",
      "SELECT id,workflow_id,status,reason,error,workflow_version FROM workflow_runs WHERE conversation_id=$1 ORDER BY started_at,id",
      [conversationId],
    );
  const tagsOf = (id: string) => sql<{ tag_id: string }>("a", "SELECT tag_id FROM conversation_tags WHERE conversation_id=$1 ORDER BY tag_id", [id]).then((r) => r.map((x) => x.tag_id));
  const convo = (id: string) => sql<{ status: string; team_id: string | null; priority: boolean; assigned: string }>("a", "SELECT status,team_id,priority,assigned FROM conversations WHERE id=$1", [id]).then((r) => r[0]);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
      );
      await sql(w, "DELETE FROM calendar_assignments");
      await sql(w, "UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
    }
    await sql("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");
    await sql("a", "INSERT INTO tags(workspace_id,id,name) VALUES('a','triaged','Triaged'),('a','urgent','Urgent'),('a','ping','Ping'),('a','pong','Pong'),('a','old','Old')");
    await sql("a", "INSERT INTO teams(workspace_id,id,name) VALUES('a','fr','French'),('a','en','English')");

    // Off by default.
    assert.equal((await agent("workflows")).body.error.code, "WORKFLOWS_DISABLED");
    await sql("a", "UPDATE workspace_features SET enabled=true WHERE name='workflows_v1'");
    await sql("b", "UPDATE workspace_features SET enabled=true WHERE name='workflows_v1'");

    // A draft saves unfinished; publishing names what's wrong, including references.
    const made = await agent("workflow", { action: "create", name: "Triage by language", trigger: "first_message" });
    const wid = made.body.workflow.id;
    const triage = {
      trigger: { type: "first_message", options: {} },
      paths: [
        path("A", [step("tag_add", { tagId: "triaged" })], {
          type: "branch",
          branches: [{ label: "French", when: { match: "all", items: [{ field: "conversation.language", op: "is", value: "fr" }] }, path: "B" }],
          else: "C",
        }),
        path("B", [step("assign", { teamId: "fr" })], { type: "end" }),
        path("C", [step("assign", { teamId: "nowhere" })], { type: "end" }),
      ],
    };
    let saved = await agent("workflow", { action: "save", id: wid, version: made.body.workflow.version, name: "Triage by language", definition: triage });
    assert.deepEqual(saved.body.workflow.problems, ["Path C, step 1: its team doesn't exist."]);
    const refused = await agent("workflow", { action: "publish", id: wid, version: saved.body.workflow.version });
    assert.equal(refused.body.error.code, "WORKFLOW_INVALID");
    assert.equal(refused.body.error.message, "It can't be published yet: Path C, step 1: its team doesn't exist.");
    triage.paths[2].steps = [step("assign", { teamId: "en" })];
    saved = await agent("workflow", { action: "save", id: wid, version: saved.body.workflow.version, name: "Triage by language", definition: triage });
    const live = await agent("workflow", { action: "publish", id: wid, version: saved.body.workflow.version });
    assert.deepEqual([live.body.workflow.state, live.body.workflow.liveVersion, live.body.workflow.problems], ["live", 1, []]);
    assert.equal((await agent("workflow", { action: "create", name: "x" }, "agent-1-a")).status, 403);

    // A French customer: tagged, routed to French; an English one to English. Each step recorded.
    const fr = await start("Bonjour, ma commande est en retard, pouvez-vous m'aider ?");
    assert.deepEqual(await tagsOf(fr), ["triaged"]);
    assert.equal((await convo(fr)).team_id, "fr");
    const en = await start("Hello, my order is late, can you help?");
    assert.equal((await convo(en)).team_id, "en");
    const [frRun] = await runsOf(fr);
    assert.equal(frRun.status, "completed");
    const detail = (await agent(`workflow-runs?id=${frRun.id}`)).body;
    assert.deepEqual(
      detail.steps.map((s: any) => [s.kind, s.label, s.result]),
      [
        ["trigger", "A customer sends their first message", "fired"],
        ["action", "Added a tag", "ok"],
        ["branch", "Branch “French” matched", "to path B"],
        ["action", "Assigned to a team (routed by its method)", "ok"],
        ["end", "End", "completed"],
      ],
    );
    assert.deepEqual(detail.steps[2].inputs, [{ field: "conversation.language", op: "is", value: "fr", actual: "fr", result: true }]);
    assert.equal(detail.steps[0].inputs.source, "customer");
    const enDetail = (await agent(`workflow-runs?id=${(await runsOf(en))[0].id}`)).body;
    assert.deepEqual(
      enDetail.steps.map((s: any) => [s.kind, s.label, s.result]).slice(2, 4),
      [
        ["condition", "Branch “French”", "no match"],
        ["branch", "No branch matched: else", "to path C"],
      ],
    );
    assert.deepEqual(enDetail.steps.find((s: any) => s.kind === "condition").inputs, [{ field: "conversation.language", op: "is", value: "fr", actual: "en", result: false }]);
    // The timeline says which workflow made the change.
    const [tagPart] = await sql("a", "SELECT author_type,author_id,data FROM conversation_parts WHERE conversation_id=$1 AND kind='tag_change'", [fr]);
    assert.deepEqual([tagPart.author_type, tagPart.author_id, tagPart.data.workflowName, tagPart.data.workflowRun], ["system", "workflow:" + wid, "Triage by language", frRun.id]);
    // A later message doesn't fire "first message" again.
    await tenant(db.connect, "a", async (q) => {
      const c = (await q.query<{ primary_identity_id: string }>("SELECT primary_identity_id FROM conversations WHERE id=$1", [fr])).rows[0];
      await command(q, "a", { type: "contact", identityId: c.primary_identity_id, brandId: "default" }, crypto.randomUUID(), { action: "reply", conversationId: fr, text: "Merci" });
    });
    await drain();
    assert.equal((await runsOf(fr)).length, 1);

    // The list, by trigger; the run log, filtered; per workspace.
    const list = (await agent("workflows")).body;
    const first = list.triggers.find((t: any) => t.trigger === "first_message");
    assert.deepEqual(first.workflows.map((x: any) => [x.name, x.state, x.runs.completed]), [["Triage by language", "live", 2]]);
    assert.equal(first.firedBy, "The customer's first message in a conversation.");
    assert.equal((await agent(`workflow-runs?workflow=${wid}&status=completed`)).body.runs.length, 2);
    assert.equal((await agent(`workflow-runs?conversation=${fr}`)).body.runs.length, 1);
    assert.equal((await agent(`workflows?id=${wid}`, undefined, "owner-b", "b")).status, 404);
    assert.equal((await agent(`workflow-runs?id=${frRun.id}`, undefined, "owner-b", "b")).status, 404);
    assert.deepEqual((await agent("workflow-runs", undefined, "owner-b", "b")).body.runs, []);
    await agent("workflow", { action: "pause", id: wid, version: (await agent(`workflows?id=${wid}`)).body.workflow.version });

    // In-flight runs finish on their version; rollback publishes an old version as the next.
    const noted = (text: string) => ({
      trigger: { type: "first_message", options: {} },
      paths: [path("A", [step("wait", { seconds: 3600 }), step("note", { text })], { type: "end" })],
    });
    const nid = await publish("Note after an hour", noted("Version one"));
    const waiting = await start("Anyone there?");
    const [w1] = await runsOf(waiting);
    assert.equal(w1.status, "waiting");
    const nv = (await agent(`workflows?id=${nid}`)).body.workflow;
    const s2 = await agent("workflow", { action: "save", id: nid, version: nv.version, name: "Note after an hour", definition: noted("Version two") });
    assert.equal((await agent("workflow", { action: "publish", id: nid, version: s2.body.workflow.version })).body.workflow.liveVersion, 2);
    await sql("a", "UPDATE workflow_runs SET wait_until=now()-interval '1 second' WHERE id=$1", [w1.id]);
    assert.equal(await resumeDueWorkflows(db.connect, "a"), 1);
    await drain();
    assert.deepEqual(await sql("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='internal_note'", [waiting]), [{ body: "Version one" }]);
    assert.equal((await runsOf(waiting))[0].status, "completed");
    const rolled = await agent("workflow", { action: "rollback", id: nid, version: (await agent(`workflows?id=${nid}`)).body.workflow.version, to: 1 });
    assert.equal(rolled.body.workflow.liveVersion, 3);
    assert.deepEqual(rolled.body.versions.map((v: any) => [v.version, v.restoredFrom]), [[3, 1], [2, null], [1, null]]);
    await assert.rejects(sql("a", "UPDATE workflow_versions SET definition='{}'"), /never changed/);
    await agent("workflow", { action: "archive", id: nid, version: rolled.body.workflow.version });

    // Waiting until a condition holds (a teammate's tag), or timing out (then closing).
    const watch = await publish("Watch for urgent", {
      trigger: { type: "first_message", options: {} },
      paths: [
        path("A", [], { type: "wait_until", when: { match: "all", items: [{ field: "conversation.tag", op: "has", value: "urgent" }] }, timeoutSeconds: 3600, met: "B", timedOut: "C" }),
        path("B", [step("priority", { value: true })], { type: "end" }),
        path("C", [step("close")], { type: "end" }),
      ],
    });
    const hot = await start("Something is broken");
    const cold = await start("Just a question");
    assert.deepEqual((await runsOf(hot)).map((r) => r.status), ["waiting"]);
    await teammate(hot, { action: "tag_add", tagId: "urgent" });
    assert.equal((await convo(hot)).priority, true);
    assert.equal((await runsOf(hot))[0].status, "completed");
    // An unrelated change re-checks and keeps waiting, with its deadline unchanged.
    const before = (await sql("a", "SELECT wait_until FROM workflow_runs WHERE conversation_id=$1", [cold]))[0].wait_until;
    await teammate(cold, { action: "priority", value: false });
    const after = await sql("a", "SELECT status,wait_until FROM workflow_runs WHERE conversation_id=$1", [cold]);
    assert.deepEqual([after[0].status, new Date(after[0].wait_until).getTime()], ["waiting", new Date(before).getTime()]);
    await sql("a", "UPDATE workflow_runs SET wait_until=now()-interval '1 second' WHERE conversation_id=$1", [cold]);
    await resumeDueWorkflows(db.connect, "a");
    await drain();
    assert.equal((await convo(cold)).status, "closed");
    const coldRun = (await agent(`workflow-runs?id=${(await runsOf(cold))[0].id}`)).body;
    assert.ok(coldRun.steps.some((s: any) => s.label === "The wait timed out"));
    await agent("workflow", { action: "archive", id: watch, version: (await agent(`workflows?id=${watch}`)).body.workflow.version });

    // Loops: a workflow's own change never starts it again; workflows starting each other stop.
    await publish("Ping", { trigger: { type: "tagged", options: { tagId: "ping" } }, paths: [path("A", [step("tag_add", { tagId: "pong" })], { type: "end" })] });
    await publish("Pong", { trigger: { type: "tagged", options: { tagId: "pong" } }, paths: [path("A", [step("tag_remove", { tagId: "ping" }), step("tag_add", { tagId: "ping" })], { type: "end" })] });
    const self = await publish("Retag", { trigger: { type: "tagged", options: {} }, paths: [path("A", [step("tag_add", { tagId: "old" })], { type: "end" })] });
    const loopy = await start("Loop me");
    await teammate(loopy, { action: "tag_add", tagId: "ping" });
    const loopRuns = await sql<{ name: string; status: string; reason: string }>(
      "a",
      "SELECT w.name,r.status,r.reason FROM workflow_runs r JOIN workflows w ON w.workspace_id=r.workspace_id AND w.id=r.workflow_id WHERE r.conversation_id=$1 ORDER BY r.started_at,w.name",
      [loopy],
    );
    assert.ok(loopRuns.some((r) => r.name === "Ping" && r.status === "completed"));
    assert.ok(loopRuns.some((r) => r.name === "Pong" && r.status === "completed"));
    assert.ok(loopRuns.some((r) => r.status === "skipped" && /A loop|Its own change would start it again/.test(r.reason)), JSON.stringify(loopRuns));
    assert.ok(loopRuns.some((r) => r.name === "Retag" && r.status === "skipped" && r.reason === "Its own change would start it again."));
    assert.ok(loopRuns.length < 15, `${loopRuns.length} runs`);
    for (const name of ["Ping", "Pong", "Retag"]) {
      const id = (await sql("a", "SELECT id FROM workflows WHERE name=$1", [name]))[0].id;
      await agent("workflow", { action: "archive", id, version: (await agent(`workflows?id=${id}`)).body.workflow.version });
    }
    void self;

    // A loop between paths stops at the step limit; a refusal fails that run only.
    await publish("Spin", {
      trigger: { type: "manual", options: {} },
      paths: [
        path("A", [], { type: "goto", path: "B" }),
        path("B", [], { type: "branch", branches: [{ label: "Open", when: { match: "all", items: [{ field: "conversation.status", op: "is", value: "open" }] }, path: "A" }], else: "C" }),
        path("C", [], { type: "end" }),
      ],
    });
    const spin = (await sql("a", "SELECT id FROM workflows WHERE name='Spin'"))[0].id;
    const target = await start("Spin me");
    // Teammates who manage conversations run manual workflows; another workspace can't.
    assert.equal((await agent("workflow-run", { workflowId: spin, conversationId: target }, "owner-b", "b")).status, 404);
    assert.equal((await agent("workflow-run", { workflowId: spin, conversationId: target }, "agent-1-a")).status, 200);
    await drain();
    const [spun] = await runsOf(target);
    assert.deepEqual([spun.status, spun.error], ["failed", "It took more than 100 steps; a loop in its paths?"]);
    const tagger = await publish("Tag old", { trigger: { type: "manual", options: {} }, paths: [path("A", [step("tag_add", { tagId: "old" }), step("priority", { value: true })], { type: "end" })] });
    await sql("a", "UPDATE tags SET archived_at=now() WHERE id='old'");
    await agent("workflow-run", { workflowId: tagger, conversationId: target });
    await drain();
    const failed = (await runsOf(target)).at(-1)!;
    assert.deepEqual([failed.status, failed.error], ["failed", "This tag is archived. Restore it in Settings to use it again."]);
    assert.equal((await convo(target)).priority, false); // the failed step rolled back; nothing after it ran
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM jobs WHERE kind='workflow.start' AND state<>'succeeded'"))[0].n, 0);
    assert.equal((await agent("workflow-run", { workflowId: wid, conversationId: target })).status, 404); // not a manual workflow

    // The hourly limit per conversation.
    const busy = await start("Busy");
    const many = await publish("Many", { trigger: { type: "manual", options: {} }, paths: [path("A", [], { type: "end" })] });
    for (let i = 0; i < 21; i++) await agent("workflow-run", { workflowId: many, conversationId: busy });
    await drain();
    const busyRuns = await runsOf(busy);
    assert.equal(busyRuns.filter((r) => r.status === "completed").length, 20);
    assert.equal(busyRuns.filter((r) => r.status === "skipped")[0].reason, "This conversation already had 20 workflow runs in the last hour.");

    // Two background workflows on one trigger both run, in priority order; reorder changes it.
    const one = await publish("First note", { trigger: { type: "closed", options: {} }, paths: [path("A", [step("note", { text: "one" })], { type: "end" })] });
    const two = await publish("Second note", { trigger: { type: "closed", options: {} }, paths: [path("A", [step("note", { text: "two" })], { type: "end" })] });
    await agent("workflow", { action: "reorder", trigger: "closed", ids: [two, one] });
    const closing = await start("Close me");
    await teammate(closing, { action: "close" });
    assert.deepEqual(
      (await sql("a", "SELECT body FROM conversation_parts WHERE conversation_id=$1 AND kind='internal_note' ORDER BY seq", [closing])).map((r: any) => r.body),
      ["two", "one"],
    );
    assert.equal((await agent("workflow", { action: "reorder", trigger: "closed", ids: [two] })).body.error.code, "INVALID_WORKFLOW");

    // The rollback: off everywhere; runs in progress end.
    await publish("Wait long", { trigger: { type: "first_message", options: {} }, paths: [path("A", [step("wait", { seconds: 86400 })], { type: "end" })] });
    await start("Hold on");
    const rollback = await readFile("db/rollback/0058_workflows.sql", "utf8");
    for (const statement of rollback.split("\n").filter((l) => !l.startsWith("--")).join("\n").split(";").filter((s) => s.trim()))
      await tenant(db.connect, "a", (q) => q.query(statement));
    assert.deepEqual(await sql("a", "SELECT 1 FROM workflow_runs WHERE status IN ('running','waiting')"), []);
    assert.equal((await agent("workflows")).body.error.code, "WORKFLOWS_DISABLED");
  } finally {
    await db.close();
  }
});
