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
import { resumeWorkflow, startWorkflows } from "../server/workflow-engine";
import { checkTimedWorkflows, nextOccurrence, pageVisited, runTimedWorkflows } from "../server/workflow-triggers";
import { DefinitionError, problems, validate } from "../lib/workflow-definition";
import { TEMPLATES, fromTemplate } from "../lib/workflow-templates";

const path = (id: string, steps: unknown[], next: unknown) => ({ id, label: "", steps, next });
const step = (type: string, options: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), type, options });
const end = { type: "end" };

/** Templates, schedules and the new triggers' options (phase 11, W4; docs/WORKFLOWS_STEP4.md). */
test("templates are complete workflows once their slots are filled; schedules find their next time; new triggers' options are checked", () => {
  assert.equal(TEMPLATES.length, 10);
  for (const t of TEMPLATES) {
    const slots = Object.fromEntries(t.slots.map((s) => [s.key, s.kind + "-1"]));
    const def = validate(fromTemplate(t.id, slots).definition);
    assert.deepEqual(problems(def), [], t.id);
  }
  assert.throws(() => fromTemplate("route_by_language", {}), /Choose the French-speaking team/);
  assert.throws(() => fromTemplate("nope", {}), /doesn't exist/);

  // 09:00 in London (summer time, UTC+1), every day, weekdays, or Mondays.
  const at = (iso: string) => Date.parse(iso);
  const iso = (n: number) => new Date(n).toISOString();
  const london = { at: "09:00", timezone: "Europe/London" };
  assert.equal(iso(nextOccurrence(at("2026-10-09T07:00:00Z"), { ...london, every: "day" })), "2026-10-09T08:00:00.000Z");
  assert.equal(iso(nextOccurrence(at("2026-10-09T08:00:00Z"), { ...london, every: "day" })), "2026-10-10T08:00:00.000Z");
  assert.equal(iso(nextOccurrence(at("2026-10-09T09:00:00Z"), { ...london, every: "weekdays" })), "2026-10-12T08:00:00.000Z", "Friday after 9: Monday");
  assert.equal(iso(nextOccurrence(at("2026-10-12T09:00:00Z"), { ...london, every: "week", weekday: 1 })), "2026-10-19T08:00:00.000Z");
  // After the clocks go back (25 October), 09:00 is 09:00 UTC.
  assert.equal(iso(nextOccurrence(at("2026-10-25T00:00:00Z"), { ...london, every: "day" })), "2026-10-25T09:00:00.000Z");
  assert.equal(iso(nextOccurrence(at("2026-10-09T07:40:00Z"), { at: "09:15", every: "hour", timezone: "UTC" })), "2026-10-09T08:15:00.000Z");

  const t = (trigger: unknown) => validate({ trigger, paths: [path("A", [], end)] }).trigger;
  assert.deepEqual(t({ type: "schedule", options: {} }).options, { every: "day", at: "09:00", timezone: "UTC" });
  assert.deepEqual(t({ type: "unresponsive", options: {} }).options, { minutes: 60 });
  assert.deepEqual(t({ type: "page_visit", options: { url: " /pricing " } }).options, { url: "/pricing" });
  const refuse = (trigger: unknown, m: RegExp) => assert.throws(() => t(trigger), (e) => e instanceof DefinitionError && m.test(e.message));
  refuse({ type: "schedule", options: { at: "25:00" } }, /HH:MM/);
  refuse({ type: "schedule", options: { timezone: "Mars/Olympus" } }, /time zone/);
  refuse({ type: "sla_before_breach", options: { minutes: 0 } }, /whole minutes/);
  refuse({ type: "segment_changed" }, /arrives with phase 13/);
  assert.deepEqual(problems(validate({ trigger: { type: "first_message" }, paths: [path("A", [], { type: "workflow", workflowId: "" })] })), [
    "Path A: choose the reusable workflow to pass to.",
  ]);
});

test("workflows in operation: the failing alert, the run log, reusable workflows, time, page and webhook triggers, and templates", async () => {
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
    "workflow.timed": (j: Job) => runTimedWorkflows(db.connect, j),
  };
  const drain = async (w = "a") => {
    for (let i = 0; i < 200; i++) {
      const job = (await sql<{ id: string }>(w, "SELECT id FROM jobs WHERE kind LIKE 'workflow.%' AND state IN ('queued','running') ORDER BY created_at LIMIT 1"))[0];
      if (!job) return;
      await runJob(db.connect, w, job.id, handlers);
    }
  };
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
  const publish = async (name: string, definition: unknown) => {
    const made = await agent("workflow", { action: "create", name, definition });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const r = await agent("workflow", { action: "publish", id: made.body.workflow.id, version: made.body.workflow.version });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return made.body.workflow.id as string;
  };
  const pause = async (id: string) => {
    const v = (await agent(`workflows?id=${id}`)).body.workflow.version;
    assert.equal((await agent("workflow", { action: "pause", id, version: v })).status, 200);
  };
  const start = (text: string, w = "a", email?: string) =>
    tenant(db.connect, w, async (q) => {
      const identity = await getIdentity(q, w, "anonymous", crypto.randomUUID(), {});
      if (email)
        await q.query(
          "INSERT INTO contact_emails(workspace_id,contact_id,email) SELECT $1,contact_id,$3 FROM identity_contact_mappings WHERE workspace_id=$1 AND identity_id=$2",
          [w, identity.identityId, email],
        );
      const { conversationId } = (await command(q, w, { type: "contact", identityId: identity.identityId, brandId: "default" }, crypto.randomUUID(), {
        action: "start",
        text,
      })) as { conversationId: string };
      return { id: conversationId, identityId: identity.identityId };
    });
  const teammate = (id: string, p: Record<string, unknown>) =>
    tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { conversationId: id, ...p } as never));
  const tagsOf = (id: string) => sql<{ tag_id: string }>("a", "SELECT tag_id FROM conversation_tags WHERE conversation_id=$1 ORDER BY tag_id", [id]).then((r) => r.map((x) => x.tag_id));
  const runsOf = (workflowId: string) =>
    sql<{ status: string; reason: string; error: string; trigger: string; conversation_id: string }>(
      "a",
      "SELECT status,reason,error,trigger,conversation_id FROM workflow_runs WHERE workflow_id=$1 ORDER BY started_at,id",
      [workflowId],
    );
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
      );
      await sql(w, "DELETE FROM calendar_assignments");
      await sql(w, "UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE name='workflows_v1'");
    }
    await sql("a", "INSERT INTO tags(workspace_id,id,name) VALUES('a','seen','Seen'),('a','old','Old'),('a','passed','Passed'),('a','late','Late'),('a','due','Due'),('a','daily','Daily'),('a','browse','Browsing'),('a','pro','Pro')");
    await sql("a", "INSERT INTO teams(workspace_id,id,name) VALUES('a','fr','French'),('a','en','English')");

    // The failing alert: three failed runs in a row open it, notify managers once, and show on the
    // list and the run log; a completed run closes it.
    const broken = await publish("Tag old", { trigger: { type: "first_message" }, paths: [path("A", [step("tag_add", { tagId: "old" })], end)] });
    await sql("a", "UPDATE tags SET archived_at=now() WHERE id='old'");
    for (const text of ["one", "two"]) await start(text);
    await drain();
    assert.deepEqual((await agent("workflows")).body.alerts, []);
    await start("three");
    await drain();
    const list = (await agent("workflows")).body;
    assert.equal(list.alerts.length, 1);
    assert.deepEqual(
      { workflow: list.alerts[0].workflow, failures: list.alerts[0].failures, lastError: list.alerts[0].lastError },
      { workflow: "Tag old", failures: 3, lastError: "This tag is archived. Restore it in Settings to use it again." },
    );
    assert.equal(list.triggers.find((t: { trigger: string }) => t.trigger === "first_message").workflows[0].failing, true);
    const notes = (await agent("notifications")).body.items.filter((n: { kind: string }) => n.kind === "workflow_alert");
    assert.deepEqual(notes.map((n: { workflowId: string; excerpt: string }) => [n.workflowId, n.excerpt.slice(0, 33)]), [[broken, "“Tag old” failed 3 times in a row"]]);
    await start("four");
    await drain();
    assert.equal((await agent("workflows")).body.alerts[0].failures, 4);
    assert.equal((await agent("notifications")).body.items.filter((n: { kind: string }) => n.kind === "workflow_alert").length, 1, "notified once");
    assert.equal((await agent(`workflows?id=${broken}`)).body.workflow.alert.failures, 4);
    await sql("a", "UPDATE tags SET archived_at=NULL WHERE id='old'");
    await start("five");
    await drain();
    assert.deepEqual((await agent("workflows")).body.alerts, []);
    assert.deepEqual((await sql("a", "SELECT resolution FROM workflow_alerts WHERE workflow_id=$1", [broken])).map((r) => r.resolution), ["recovered"]);
    // Dismissed by a manager.
    await sql("a", "UPDATE tags SET archived_at=now() WHERE id='old'");
    for (const text of ["six", "seven", "eight"]) await start(text);
    await drain();
    assert.equal((await agent("workflows")).body.alerts.length, 1);
    assert.deepEqual((await agent("workflow", { action: "dismiss_alert", id: broken })).body.alerts, []);
    await pause(broken);

    // The run log: filtered (workflow, outcome, trigger, conversation), paged, another workspace's unseen.
    const failed = (await agent(`workflow-runs?workflow=${broken}&status=failed`)).body;
    assert.equal(failed.runs.length, 7);
    assert.equal((await agent("workflow-runs?trigger=first_message")).body.runs.length, 8);
    assert.equal((await agent("workflow-runs?trigger=manual")).body.runs.length, 0);
    const one = failed.runs[0].conversationId;
    assert.deepEqual((await agent(`workflow-runs?conversation=${one}`)).body.runs.map((r: { conversationId: string }) => r.conversationId), [one]);
    await sql(
      "a",
      `INSERT INTO workflow_runs(workspace_id,id,workflow_id,workflow_version,conversation_id,trigger,source,chain,status,reason,started_at,ended_at,duration_ms)
       SELECT 'a',gen_random_uuid()::text,$1,1,$2,'first_message','customer','{}','skipped','Filler.',now()-make_interval(mins=>i),now(),0 FROM generate_series(1,60) i`,
      [broken, one],
    );
    const first = (await agent(`workflow-runs?workflow=${broken}`)).body;
    assert.equal(first.runs.length, 50);
    const second = (await agent(`workflow-runs?workflow=${broken}&before=${encodeURIComponent(first.next)}`)).body;
    assert.equal(second.runs.length, 18);
    assert.equal(second.next, null);
    assert.equal(new Set([...first.runs, ...second.runs].map((r: { id: string }) => r.id)).size, 68);
    assert.deepEqual((await agent("workflow-runs", undefined, "owner-b", "b")).body.runs, []);

    // A reusable workflow: passed to, run on its own (in the same chain); publishing checks the target.
    const reusable = await agent("workflow", {
      action: "create",
      name: "Shared: tag as passed",
      definition: { trigger: { type: "reusable" }, paths: [path("A", [step("tag_add", { tagId: "passed" })], end)] },
    });
    const rid = reusable.body.workflow.id;
    const passer = await agent("workflow", {
      action: "create",
      name: "Pass it on",
      definition: { trigger: { type: "first_message" }, paths: [path("A", [step("tag_add", { tagId: "seen" })], { type: "workflow", workflowId: rid })] },
    });
    assert.deepEqual(passer.body.workflow.problems, ["Path A: the reusable workflow it passes to isn't live."]);
    assert.deepEqual(passer.body.options.reusable.map((r: { id: string }) => r.id), [rid]);
    assert.equal((await agent("workflow", { action: "publish", id: rid, version: reusable.body.workflow.version })).status, 200);
    const pid = passer.body.workflow.id;
    assert.equal((await agent("workflow", { action: "publish", id: pid, version: passer.body.workflow.version })).status, 200);
    const handed = await start("Hello, pass me on");
    await drain();
    assert.deepEqual(await tagsOf(handed.id), ["passed", "seen"]);
    assert.deepEqual((await runsOf(pid)).map((r) => [r.status, r.reason]), [["completed", "Passed to “Shared: tag as passed”."]]);
    assert.deepEqual((await runsOf(rid)).map((r) => [r.status, r.trigger]), [["completed", "reusable"]]);
    assert.deepEqual((await sql("a", "SELECT chain FROM workflow_runs WHERE workflow_id=$1", [rid]))[0].chain, [pid]);
    // A reusable workflow never starts on its own, and one can't pass to itself.
    const self = await agent("workflow", {
      action: "save",
      id: rid,
      version: (await agent(`workflows?id=${rid}`)).body.workflow.version,
      name: "Shared: tag as passed",
      definition: { trigger: { type: "reusable" }, paths: [path("A", [], { type: "workflow", workflowId: rid })] },
    });
    assert.deepEqual(self.body.workflow.problems, ["Path A: it passes to itself."]);
    await pause(pid);

    // Time: a customer who hasn't replied (once per message), an SLA about to breach, a schedule.
    const quiet = await publish("Chase", { trigger: { type: "unresponsive", options: { minutes: 60 } }, paths: [path("A", [step("tag_add", { tagId: "late" })], end)] });
    const waiting = await start("Can you help?");
    await teammate(waiting.id, { action: "reply", text: "Sure, what's your order number?" });
    const fresh = await start("Another question");
    await teammate(fresh.id, { action: "reply", text: "Looking now." });
    const answered = await start("Thanks");
    await teammate(answered.id, { action: "reply", text: "Anything else?" });
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "contact", identityId: answered.identityId, brandId: "default" }, crypto.randomUUID(), { action: "reply", conversationId: answered.id, text: "No, thanks" }));
    // Two hours on, the replied-to conversations are due; the one that answered isn't.
    const later = Date.now() + 2 * 3_600_000;
    const fresh2 = await start("Asked just now");
    await teammate(fresh2.id, { action: "reply", text: "On it." });
    assert.equal(await checkTimedWorkflows(db.connect, "a", later), true);
    assert.equal(await checkTimedWorkflows(db.connect, "a", later), false, "once a minute");
    await drain();
    assert.deepEqual(await tagsOf(waiting.id), ["late"]);
    assert.deepEqual(await tagsOf(answered.id), []);
    assert.equal((await runsOf(quiet)).length, 3, "the two waiting ones and the one asked just now (two hours on, it's due too)");
    await checkTimedWorkflows(db.connect, "a", later + 60_000);
    await drain();
    assert.equal((await runsOf(quiet)).length, 3, "once per unanswered message");
    await checkTimedWorkflows(db.connect, "a", Date.now() + 120_000);
    await drain();
    assert.equal((await runsOf(quiet)).length, 3, "not before its time");
    await pause(quiet);
    const soon = await publish("Before breach", { trigger: { type: "sla_before_breach", options: { minutes: 30 } }, paths: [path("A", [step("tag_add", { tagId: "due" })], end)] });
    await sql("a", "UPDATE conversations SET sla_next_due_at=$2,sla_breached=false WHERE id=$1", [fresh.id, new Date(later + 10 * 60_000).toISOString()]);
    await checkTimedWorkflows(db.connect, "a", later + 120_000);
    await drain();
    await checkTimedWorkflows(db.connect, "a", later + 180_000);
    await drain();
    assert.deepEqual(await tagsOf(fresh.id), ["due", "late"]);
    assert.equal((await runsOf(soon)).length, 1, "once per SLA target");
    await pause(soon);
    const daily = await publish("Daily sweep", {
      trigger: { type: "schedule", options: { every: "day", at: "09:00", timezone: "UTC" } },
      when: { match: "all", items: [{ field: "conversation.tag", op: "has", value: "late" }] },
      paths: [path("A", [step("tag_add", { tagId: "daily" })], end)],
    });
    await checkTimedWorkflows(db.connect, "a", later + 240_000);
    await drain();
    const next = (await sql("a", "SELECT schedule_next_at FROM workflows WHERE id=$1", [daily]))[0].schedule_next_at;
    assert.ok(new Date(next).getTime() > later, "the first check only sets the next time");
    assert.equal((await runsOf(daily)).length, 0);
    await checkTimedWorkflows(db.connect, "a", new Date(next).getTime() + 60_000);
    await drain();
    assert.deepEqual(await tagsOf(waiting.id), ["daily", "late"], "who it runs for picks the conversations");
    assert.equal((await runsOf(daily)).filter((r) => r.status === "completed").length, 3);
    await pause(daily);

    // A page visit: for the customer's open conversation, once per page, where the address matches.
    const visits = await publish("Pricing visit", { trigger: { type: "page_visit", options: { url: "/pricing" } }, paths: [path("A", [step("tag_add", { tagId: "browse" })], end)] });
    const browsing = await start("Just looking");
    await tenant(db.connect, "a", (q) => pageVisited(q, "a", { identityId: browsing.identityId, brandId: "default" }, "https://shop.test/about"));
    await drain();
    assert.deepEqual(await tagsOf(browsing.id), []);
    for (let i = 0; i < 2; i++) await tenant(db.connect, "a", (q) => pageVisited(q, "a", { identityId: browsing.identityId, brandId: "default" }, "https://shop.test/pricing"));
    await drain();
    assert.deepEqual(await tagsOf(browsing.id), ["browse"]);
    assert.equal((await runsOf(visits)).length, 1);
    await pause(visits);

    // A webhook: refused without its secret; called with it, idempotently, by conversation or email.
    const hooked = await agent("workflow", {
      action: "create",
      name: "From billing system",
      definition: {
        trigger: { type: "webhook" },
        when: { match: "all", items: [{ field: "trigger.data", key: "plan", op: "is", value: "pro" }] },
        paths: [path("A", [step("tag_add", { tagId: "pro" })], end)],
      },
    });
    const hid = hooked.body.workflow.id;
    assert.equal(hooked.body.workflow.hook.configured, false);
    const view = await agent(`workflows?id=${hid}`);
    assert.equal(view.body.workflow.hook.url, `https://relay.test/v1/hooks/a/workflows/${hid}`);
    const call = async (body: unknown, token: string, key: string | null = crypto.randomUUID(), w = "a") => {
      const r = await handleApi(
        new Request(`https://relay.test/v1/hooks/${w}/workflows/${hid}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(key ? { "idempotency-key": key } : {}) },
          body: JSON.stringify(body),
        }),
        env,
      );
      return { status: r.status, body: (await r.json()) as any };
    };
    const target = await start("Upgrade question", "a", "pat@example.com");
    assert.equal((await call({ conversationId: target.id }, "whk_nothing")).status, 401);
    const secret = (await agent("workflow", { action: "hook_secret", id: hid, version: view.body.workflow.version })).body;
    assert.match(secret.secret, /^whk_/);
    assert.equal(secret.workflow.hook.configured, true);
    assert.deepEqual((await sql("a", "SELECT 1 FROM idempotency_receipts WHERE response::text LIKE '%' || $1 || '%'", [secret.secret])).length, 0, "the secret is never stored");
    assert.equal((await call({ conversationId: target.id }, secret.secret)).body.error.code, "WORKFLOW_NOT_LIVE");
    await agent("workflow", { action: "publish", id: hid, version: secret.workflow.version });
    assert.equal((await call({ conversationId: target.id }, secret.secret, null)).body.error.code, "IDEMPOTENCY_KEY_REQUIRED");
    assert.equal((await call({ conversationId: target.id }, secret.secret, crypto.randomUUID(), "b")).status, 401, "another workspace's address");
    const key = crypto.randomUUID();
    const sent = await call({ conversationId: target.id, data: { plan: "starter" } }, secret.secret, key);
    assert.deepEqual(sent.body, { queued: true, conversationId: target.id });
    assert.deepEqual((await call({ conversationId: target.id, data: { plan: "starter" } }, secret.secret, key)).body, sent.body, "a retry answers the same");
    await drain();
    assert.deepEqual(await tagsOf(target.id), [], "its data didn't match");
    assert.equal((await runsOf(hid)).length, 0);
    assert.deepEqual((await call({ email: "PAT@example.com", data: { plan: "pro", nested: { no: 1 } } }, secret.secret)).body.conversationId, target.id);
    await drain();
    assert.deepEqual(await tagsOf(target.id), ["pro"]);
    assert.deepEqual((await sql("a", "SELECT trigger_data FROM workflow_runs WHERE workflow_id=$1", [hid]))[0].trigger_data, { plan: "pro" });
    assert.equal((await call({ email: "nobody@example.com" }, secret.secret)).status, 404);
    assert.equal((await call({}, secret.secret)).body.error.code, "INVALID_HOOK");

    // Templates: created with their slots filled; a missing slot is refused in words.
    const templates = (await agent("workflows")).body.templates;
    assert.equal(templates.length, 10);
    assert.deepEqual((await agent("workflows")).body.choices.teams.map((t: { id: string }) => t.id), ["en", "fr"]);
    const fromT = await agent("workflow", { action: "create", name: "Route by language", template: "route_by_language", slots: { frenchTeam: "fr", generalTeam: "en" } });
    assert.equal(fromT.status, 200, JSON.stringify(fromT.body));
    assert.deepEqual(fromT.body.workflow.problems, []);
    assert.equal(fromT.body.workflow.definition.paths[1].steps[0].options.teamId, "fr");
    assert.equal((await agent("workflow", { action: "create", name: "Half done", template: "route_by_language", slots: {} })).body.error.message, "Choose the French-speaking team.");

    // The rollback: alerts close, their notifications go, the new triggers' workflows pause.
    await sql("a", "UPDATE tags SET archived_at=now() WHERE id='pro'");
    const untagged = await start("Not yet tagged");
    for (let k = 0; k < 3; k++) {
      await call({ conversationId: untagged.id, data: { plan: "pro" } }, secret.secret);
      await drain();
    }
    assert.equal((await agent("workflows")).body.alerts.length, 1);
    const rollback = await readFile("db/rollback/0061_workflow_operations.sql", "utf8");
    for (const statement of rollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await sql("a", statement);
    assert.deepEqual((await agent("workflows")).body.alerts, []);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM notifications WHERE kind='workflow_alert'"))[0].n, 0);
    assert.deepEqual((await sql("a", "SELECT state,hook_secret_hash FROM workflows WHERE id=$1", [hid]))[0], { state: "paused", hook_secret_hash: null });
  } finally {
    await db.close();
  }
});
