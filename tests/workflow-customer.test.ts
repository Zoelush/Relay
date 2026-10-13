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
import { customerFacing, outlets, problems, setOutlet, validate, DefinitionError } from "../lib/workflow-definition";
import { ORDER_STATUS, SHOP_KEY, recordedFetch } from "./fixtures/connectors";

const path = (id: string, steps: unknown[], next: unknown, label = "") => ({ id, label, steps, next });
const step = (type: string, options: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), type, options });
const end = { type: "end" };

/** Customer-facing steps' definitions (phase 11, W3; docs/WORKFLOWS_STEP3.md). */
test("customer-facing steps: checked in shape, their ways on as handles, and what makes a workflow customer-facing", () => {
  const buttons = { type: "buttons", text: "What do you need?", buttons: [{ label: "Billing", path: "B" }, { label: "A bug", path: "C" }], other: "D", timeoutSeconds: 3600, timedOut: "D" };
  const def = validate({
    trigger: { type: "first_message" },
    paths: [path("A", [step("message", { text: "Hi!" })], buttons), path("B", [], end), path("C", [], end), path("D", [], end)],
  });
  assert.equal(customerFacing(def), true);
  assert.equal(customerFacing(validate({ trigger: { type: "first_message" }, paths: [path("A", [step("tag_add", { tagId: "x" })], end)] })), false);
  assert.equal(customerFacing(validate({ trigger: { type: "first_message" }, paths: [path("A", [step("ai_handover")], end)] })), true);
  assert.deepEqual(
    outlets(def.paths[0]).map((o) => [o.id, o.label, o.target]),
    [
      ["b0", "Billing", "B"],
      ["b1", "A bug", "C"],
      ["other", "If they type instead", "D"],
      ["timedOut", "If they don't answer", "D"],
    ],
  );
  assert.deepEqual(problems(def), []);
  const moved = setOutlet(def.paths[0], "b1", "B");
  assert.equal(moved.next.type === "buttons" && moved.next.buttons[1].path, "B");
  const zoe = validate({ trigger: { type: "first_message" }, paths: [path("A", [], { type: "zoe", resolved: "B", handedOver: "", timeoutSeconds: 3600, timedOut: "B" }), path("B", [], end)] });
  assert.deepEqual(outlets(zoe.paths[0]).map((o) => o.id), ["resolved", "handedOver", "timedOut"]);
  assert.deepEqual(problems(zoe), ["Path A: a way on doesn't lead anywhere. Choose its path."]);
  const call = validate({
    trigger: { type: "manual" },
    paths: [path("A", [], { type: "connector", connectorId: "c1", inputs: { order_id: { from: "contact", key: "order" } }, save: { status: "s" }, ok: "B", failed: "B" }), path("B", [], end)],
  });
  assert.deepEqual(outlets(call.paths[0]).map((o) => o.id), ["ok", "failed"]);
  assert.equal(setOutlet(call.paths[0], "failed", "").next.type === "connector" && (setOutlet(call.paths[0], "failed", "").next as { failed: string }).failed, "");
  const refuse = (paths: unknown[], message: RegExp) =>
    assert.throws(() => validate({ trigger: { type: "first_message" }, paths }), (e) => e instanceof DefinitionError && message.test(e.message));
  refuse([path("A", [], { ...buttons, buttons: [{ label: "Yes", path: "B" }, { label: "yes", path: "B" }] })], /two buttons have the same label/);
  refuse([path("A", [], { ...buttons, buttons: Array.from({ length: 9 }, (_, i) => ({ label: "B" + i, path: "B" })) })], /between 1 and 8 reply buttons/);
  refuse([path("A", [], { ...buttons, text: " " })], /write the question/);
  refuse([path("A", [step("message", { text: "" })], end)], /Send a message needs its text|write the message/);
  refuse([path("A", [step("collect", { text: "Your plan?", into: "contact", key: "no spaces" })], end)], /name the customer attribute/);
  refuse([path("A", [step("collect", { text: "Your email?", into: "email", timeoutSeconds: 5 })], end)], /between a minute and 30 days/);
  refuse([path("A", [], { type: "connector", connectorId: "c1", inputs: { order_id: { from: "nowhere" } }, ok: "", failed: "" })], /where the connector's order_id comes from/);
});

/** The engine, through real messages (phase 11, W3). */
test("customer-facing workflows: messages, reply buttons, collected replies, Zoe's outcome and connector results; Zoe waits for them; one talks at a time; simulation changes nothing", async () => {
  const db = await testDatabase();
  const recorded = recordedFetch();
  const connectors = { key: "k".repeat(48), policy: { fetch: recorded.fetch }, sleep: async () => {} };
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    connectors,
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "workflow.start": (j: Job) => startWorkflows(db.connect, j, { connectors }),
    "workflow.resume": (j: Job) => resumeWorkflow(db.connect, j, { connectors }),
  };
  const drain = async (w = "a") => {
    for (let i = 0; i < 60; i++) {
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
  type Customer = { id: string; identityId: string };
  const start = async (text: string, w = "a"): Promise<Customer> => {
    const c = await tenant(db.connect, w, async (q) => {
      const identity = await getIdentity(q, w, "anonymous", crypto.randomUUID(), {});
      const { conversationId } = (await command(q, w, { type: "contact", identityId: identity.identityId, brandId: "default" }, crypto.randomUUID(), {
        action: "start",
        text,
      })) as { conversationId: string };
      return { id: conversationId, identityId: identity.identityId };
    });
    await drain(w);
    return c;
  };
  const say = async (c: Customer, text: string) => {
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "contact", identityId: c.identityId, brandId: "default" }, crypto.randomUUID(), { action: "reply", conversationId: c.id, text }));
    await drain();
  };
  const told = (id: string) =>
    sql<{ body: string; options: string[] | null; author_type: string }>(
      "a",
      "SELECT body,data->'options' AS options,author_type FROM conversation_parts WHERE conversation_id=$1 AND kind='workflow_message' ORDER BY seq",
      [id],
    );
  const runsOf = (id: string) =>
    sql<{ workflow_id: string; status: string; reason: string; error: string; path: string }>(
      "a",
      "SELECT workflow_id,status,reason,error,path FROM workflow_runs WHERE conversation_id=$1 ORDER BY started_at,id",
      [id],
    );
  const zoeJobs = (id: string) => sql("a", "SELECT payload->>'partId' AS part FROM jobs WHERE kind='ai.reply' AND payload->>'conversationId'=$1", [id]);
  const tagsOf = (id: string) => sql<{ tag_id: string }>("a", "SELECT tag_id FROM conversation_tags WHERE conversation_id=$1 ORDER BY tag_id", [id]).then((r) => r.map((x) => x.tag_id));
  const expire = (id: string) => sql("a", "UPDATE workflow_runs SET wait_until=now()-interval '1 second' WHERE conversation_id=$1 AND status='waiting'", [id]);
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }),
      );
      await sql(w, "DELETE FROM calendar_assignments");
      await sql(w, "UPDATE brands SET settings=settings-'calendarId'-'calendarVersion'");
      await sql(w, "UPDATE workspace_features SET enabled=true WHERE name IN ('workflows_v1','ai_agent_v1','ai_actions_v1')");
    }
    await sql("a", "INSERT INTO tags(workspace_id,id,name) VALUES('a','billing','Billing'),('a','bug','Bug'),('a','typed','Typed'),('a','quiet','Quiet'),('a','got','Got it'),('a','found','Found'),('a','lost','Lost')");
    await sql("a", "INSERT INTO attribute_definitions(workspace_id,id,name,owner_type,value_type) VALUES('a','order_status','Order status','conversation','string'),('a','size','Team size','conversation','integer')");

    // Reply buttons on the first message: Zoe waits, and the answer picks the path.
    const triage = await publish("Triage", {
      trigger: { type: "first_message" },
      paths: [
        path("A", [step("message", { text: "Hi! I'm here to point you the right way." })], {
          type: "buttons",
          text: "What do you need help with?",
          buttons: [
            { label: "Billing", path: "B" },
            { label: "A bug", path: "C" },
          ],
          other: "D",
          timeoutSeconds: 3600,
          timedOut: "E",
        }),
        path("B", [step("tag_add", { tagId: "billing" })], end),
        path("C", [step("tag_add", { tagId: "bug" })], end),
        path("D", [step("tag_add", { tagId: "typed" }), step("ai_handover")], end),
        path("E", [step("tag_add", { tagId: "quiet" })], end),
      ],
    });
    assert.equal((await agent("workflows")).body.triggers.find((t: { trigger: string }) => t.trigger === "first_message").workflows[0].customerFacing, true);
    const one = await start("Hello there");
    assert.deepEqual(await told(one.id), [
      { body: "Hi! I'm here to point you the right way.", options: null, author_type: "system" },
      { body: "What do you need help with?", options: ["Billing", "A bug"], author_type: "system" },
    ]);
    assert.deepEqual((await runsOf(one.id)).map((r) => r.status), ["waiting"]);
    // Zoe didn't answer: the workflow had it. A workflow's message is no teammate's first reply.
    assert.deepEqual(await zoeJobs(one.id), []);
    const [conv] = await sql("a", "SELECT first_response_ms,last_teammate_reply_at FROM conversations WHERE id=$1", [one.id]);
    assert.deepEqual(conv, { first_response_ms: null, last_teammate_reply_at: null });
    await say(one, "billing");
    assert.deepEqual(await tagsOf(one.id), ["billing"]);
    assert.deepEqual((await runsOf(one.id)).map((r) => [r.status, r.reason]), [["completed", "Ended at path B."]]);
    assert.deepEqual(await zoeJobs(one.id), []);
    const detail = (await agent(`workflow-runs?id=${(await sql("a", "SELECT id FROM workflow_runs WHERE conversation_id=$1", [one.id]))[0].id}`)).body;
    assert.deepEqual(
      detail.steps.map((s: { label: string }) => s.label),
      ["A customer sends their first message", "Sent a message", "Asked with reply buttons", "They chose “Billing”", "Added a tag", "End"],
    );
    // Typing instead goes its own way (here: to Zoe, who then answers that message).
    const two = await start("Hi");
    await say(two, "Where is my parcel?");
    assert.deepEqual(await tagsOf(two.id), ["typed"]);
    const parcel = (await sql("a", "SELECT id FROM conversation_parts WHERE conversation_id=$1 AND body='Where is my parcel?'", [two.id]))[0].id;
    assert.deepEqual(await zoeJobs(two.id), [{ part: parcel }]);
    // No answer in time: the timed-out way.
    const three = await start("Hey");
    await expire(three.id);
    await resumeDueWorkflows(db.connect, "a");
    await drain();
    assert.deepEqual(await tagsOf(three.id), ["quiet"]);

    // One customer-facing workflow talks at a time: another for the same trigger is skipped, and
    // so is one for "any message" while the customer is answering.
    const second = await publish("Greet", { trigger: { type: "first_message" }, paths: [path("A", [step("message", { text: "Welcome!" })], end)] });
    const chatter = await publish("Echo", { trigger: { type: "customer_message" }, paths: [path("A", [step("message", { text: "Noted." })], end)] });
    const four = await start("Morning");
    const four1 = await runsOf(four.id);
    assert.deepEqual(
      four1.filter((r) => r.workflow_id === second).map((r) => [r.status, r.reason]),
      [["skipped", "“Triage” ran first: only the highest-priority customer-facing workflow runs for a trigger."]],
    );
    assert.deepEqual(four1.filter((r) => r.workflow_id === chatter).map((r) => r.status), ["skipped"]);
    await say(four, "A bug");
    const echoes = (await runsOf(four.id)).filter((r) => r.workflow_id === chatter);
    assert.deepEqual(echoes.map((r) => r.reason), ["“Triage” is still talking to the customer.", "“Triage” is still talking to the customer."]);
    assert.deepEqual((await told(four.id)).map((m) => m.body), ["Hi! I'm here to point you the right way.", "What do you need help with?"]);
    await pause(second);
    await pause(chatter);
    await pause(triage);

    // When no customer-facing workflow takes a first message, Zoe answers it.
    const five = await start("Plain question");
    assert.equal((await zoeJobs(five.id)).length, 1);

    // Collecting a reply: asked again once when it doesn't fit, then kept.
    await publish("Get email", {
      trigger: { type: "first_message" },
      paths: [
        path("A", [step("collect", { text: "What's your email?", into: "email", timeoutSeconds: 3600 }), step("collect", { text: "How big is your team?", into: "conversation", attributeId: "size", format: "number" }), step("tag_add", { tagId: "got" })], end),
      ],
    });
    const six = await start("Hi, quick question");
    await say(six, "not an email");
    assert.equal((await told(six.id)).at(-1)!.body, "That doesn't look like an email address. Could you check it and send it again?");
    await say(six, "Jo@Example.com");
    const emails = await sql(
      "a",
      `SELECT e.email,e.verified FROM contact_emails e JOIN identity_contact_mappings m ON m.workspace_id=e.workspace_id AND m.contact_id=e.contact_id WHERE m.identity_id=$1`,
      [six.identityId],
    );
    assert.deepEqual(emails, [{ email: "jo@example.com", verified: false }]);
    assert.equal((await told(six.id)).at(-1)!.body, "How big is your team?");
    await say(six, "12");
    assert.deepEqual((await sql("a", "SELECT attributes FROM conversations WHERE id=$1", [six.id]))[0].attributes, { size: 12 });
    assert.deepEqual(await tagsOf(six.id), ["got"]);
    assert.deepEqual(await zoeJobs(six.id), []);
    await pause((await sql("a", "SELECT id FROM workflows WHERE name='Get email'"))[0].id);

    // Zoe's outcome: handed over, or resolved (a resolution after the wait began), or nothing.
    const zoeFlow = await publish("Let Zoe try", {
      trigger: { type: "first_message" },
      paths: [
        path("A", [], { type: "zoe", resolved: "B", handedOver: "C", timeoutSeconds: 3600, timedOut: "C" }),
        path("B", [step("tag_add", { tagId: "found" })], end),
        path("C", [step("tag_add", { tagId: "lost" })], end),
      ],
    });
    const seven = await start("Can I change my plan?");
    assert.deepEqual((await runsOf(seven.id)).map((r) => r.status), ["waiting"]);
    assert.equal((await zoeJobs(seven.id)).length, 1, "the workflow hands the message to Zoe");
    await sql("a", "UPDATE conversations SET ai_state='escalated' WHERE id=$1", [seven.id]);
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "note", conversationId: seven.id, text: "Over to us." }));
    await drain();
    assert.deepEqual(await tagsOf(seven.id), ["lost"]);
    const eight = await start("Can I change my address?");
    await sql(
      "a",
      `INSERT INTO ai_resolutions(workspace_id,id,kind,conversation_id,agent_id,rule,window_hours) SELECT 'a',gen_random_uuid()::text,'resolution',$1,id,'confirmed',24 FROM ai_agents WHERE workspace_id='a' LIMIT 1`,
      [eight.id],
    );
    await tenant(db.connect, "a", (q) => command(q, "a", { type: "teammate", principal: "owner-a" }, crypto.randomUUID(), { action: "note", conversationId: eight.id, text: "Looks done." }));
    await drain();
    assert.deepEqual(await tagsOf(eight.id), ["found"]);
    await pause(zoeFlow);

    // A read connector: refused for an unverified customer by the fallback rule, then called.
    const c = await agent("zoe-connector", { action: "create", name: "Order status" });
    const cid = c.body.connector.id;
    let cv = (await agent("zoe-connector", { action: "save", id: cid, version: c.body.connector.version, name: "Order status", definition: ORDER_STATUS.definition })).body.connector.version;
    cv = (await agent("zoe-connector", { action: "secret", id: cid, name: "api_key", value: SHOP_KEY })).body.connector.version;
    assert.equal((await agent("zoe-connector", { action: "publish", id: cid, version: cv })).body.connector.liveVersion, 1);
    const lookup = {
      trigger: { type: "first_message" },
      paths: [
        path("A", [], { type: "connector", connectorId: cid, inputs: { order_id: { from: "contact", key: "order" } }, save: { status: "order_status" }, ok: "B", failed: "C" }),
        path("B", [step("tag_add", { tagId: "found" })], end),
        path("C", [step("tag_add", { tagId: "lost" })], end),
      ],
    };
    // The builder offers it, with what to give it; a missing input blocks publishing.
    const made = await agent("workflow", { action: "create", name: "Look up order", definition: { ...lookup, paths: [{ ...lookup.paths[0], next: { ...(lookup.paths[0].next as object), inputs: {} } }, ...lookup.paths.slice(1)] } });
    assert.deepEqual(made.body.options.connectors, [
      { id: cid, name: "Order status", inputs: [{ name: "order_id", label: "Order number", required: true }], outputs: ORDER_STATUS.definition.outputs.map((o) => ({ name: o.name, label: o.label })) },
    ]);
    assert.deepEqual(made.body.workflow.problems, ["Path A, its connector: choose where its Order number comes from."]);
    await agent("workflow", { action: "save", id: made.body.workflow.id, version: made.body.workflow.version, name: "Look up order", definition: lookup });
    const look = made.body.workflow.id as string;
    assert.equal((await agent("workflow", { action: "publish", id: look, version: (await agent(`workflows?id=${look}`)).body.workflow.version })).status, 200);
    const nine = await start("Where is my order?");
    assert.deepEqual(await tagsOf(nine.id), ["lost"]);
    const refusedRun = (await sql("a", "SELECT id FROM workflow_runs WHERE conversation_id=$1", [nine.id]))[0].id;
    assert.match(
      (await agent(`workflow-runs?id=${refusedRun}`)).body.steps.find((s: { kind: string }) => s.kind === "branch").label,
      /Order status needs a signed-in customer \(the fallback rule\)/,
    );
    await sql("a", "UPDATE ai_agents SET verification_fallback='none'");
    const ten = await tenant(db.connect, "a", async (q) => {
      const identity = await getIdentity(q, "a", "anonymous", crypto.randomUUID(), {});
      await q.query(
        "UPDATE contacts SET profile=profile||'{\"order\":\"A1001\"}' WHERE workspace_id='a' AND id=(SELECT contact_id FROM identity_contact_mappings WHERE workspace_id='a' AND identity_id=$1)",
        [identity.identityId],
      );
      return ((await command(q, "a", { type: "contact", identityId: identity.identityId, brandId: "default" }, crypto.randomUUID(), { action: "start", text: "Order?" })) as {
        conversationId: string;
      }).conversationId;
    });
    await drain();
    assert.deepEqual(await tagsOf(ten), ["found"]);
    assert.deepEqual((await sql("a", "SELECT attributes FROM conversations WHERE id=$1", [ten]))[0].attributes, { order_status: "shipped" });
    const audited = await sql("a", "SELECT source,invoked_by,result FROM ai_connector_calls WHERE conversation_id=$1", [ten]);
    assert.deepEqual(audited, [{ source: "workflow", invoked_by: "workflow:" + look, result: "ok" }]);
    assert.deepEqual(recorded.unmatched, []);
    await pause(look);

    // Simulation: the draft against a real conversation, every decision shown, nothing changed.
    const draft = {
      trigger: { type: "first_message" },
      paths: [
        path("A", [step("tag_add", { tagId: "billing" })], {
          type: "branch",
          branches: [{ label: "Tagged", when: { match: "all", items: [{ field: "conversation.tag", op: "has", value: "billing" }] }, path: "B" }],
          else: "C",
        }),
        path("B", [step("message", { text: "Thanks!" })], { type: "buttons", text: "Anything else?", buttons: [{ label: "Yes", path: "C" }, { label: "No", path: "C" }], other: "C", timeoutSeconds: 3600, timedOut: "C" }),
        path("C", [step("close")], end),
      ],
    };
    const count = async () =>
      (await sql("a", "SELECT (SELECT count(*) FROM conversation_parts)::int AS parts,(SELECT count(*) FROM conversation_tags)::int AS tags,(SELECT count(*) FROM workflow_runs)::int AS runs,(SELECT count(*) FROM jobs)::int AS jobs"))[0];
    const before = await count();
    const sim = (await agent("workflow-simulate", { definition: draft, conversationId: five.id })).body;
    assert.deepEqual(sim.visited, ["A", "B", "C"]);
    assert.equal(sim.ended, "completed");
    const labels = sim.trace.map((t: { label: string }) => t.label);
    assert.ok(labels.includes("Would add the tag “Billing”"));
    assert.ok(labels.includes("Branch “Tagged”: matches"), "the step's effect is seen by the next condition");
    assert.ok(labels.includes("Would send: “Thanks!”"));
    const choice = sim.trace.find((t: { decision?: unknown }) => t.decision).decision;
    assert.deepEqual(choice, {
      id: "B:buttons#1",
      options: [
        { value: "b0", label: "They choose “Yes”" },
        { value: "b1", label: "They choose “No”" },
        { value: "other", label: "They type something else" },
        { value: "timedOut", label: "No answer in 1 hour" },
      ],
      chosen: "b0",
    });
    const again = (await agent("workflow-simulate", { definition: draft, conversationId: five.id, choices: { "B:buttons#1": "timedOut" } })).body;
    assert.ok(again.trace.some((t: { label: string }) => t.label === "No answer → path C"));
    assert.deepEqual(await count(), before, "a simulation writes nothing");
    assert.deepEqual(await tagsOf(five.id), []);
    // Who it runs for that doesn't match stops it, unless asked to run anyway.
    const narrow = { ...draft, when: { match: "all", items: [{ field: "conversation.language", op: "is", value: "fr" }] } };
    assert.equal((await agent("workflow-simulate", { definition: narrow, conversationId: five.id })).body.ended, "not run");
    assert.equal((await agent("workflow-simulate", { definition: narrow, conversationId: five.id, choices: { "when#1": "run" } })).body.ended, "completed");
    // Conversations to choose from; another workspace's can't be used; unfinished drafts refused.
    assert.ok((await agent("workflow-conversations?q=Plain")).body.conversations.some((x: { id: string }) => x.id === five.id));
    const theirs = await start("Bonjour", "b");
    assert.equal((await agent("workflow-simulate", { definition: draft, conversationId: theirs.id })).status, 404);
    assert.deepEqual((await agent("workflow-conversations", undefined, "owner-b", "b")).body.conversations.map((x: { id: string }) => x.id), [theirs.id]);
    assert.equal((await agent("workflow-simulate", { definition: { ...draft, paths: [path("A", [step("message", { text: "" })], end)] }, conversationId: five.id })).status, 400);
    await sql("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");
    assert.equal((await agent("workflow-simulate", { definition: draft, conversationId: five.id }, "agent-1-a")).status, 403);

    // The rollback: runs waiting for a customer fail; live workflows that talk to customers pause.
    await agent("workflow", { action: "resume", id: triage, version: (await agent(`workflows?id=${triage}`)).body.workflow.version });
    const eleven = await start("Last one");
    assert.deepEqual((await runsOf(eleven.id)).map((r) => r.status), ["waiting"]);
    const rollback = await readFile("db/rollback/0060_workflow_customer_steps.sql", "utf8");
    for (const statement of rollback.split(";").map((x) => x.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await sql("a", statement);
    assert.deepEqual((await runsOf(eleven.id)).map((r) => [r.status, r.error]), [["failed", "Stopped by rollback."]]);
    assert.equal((await sql("a", "SELECT state FROM workflows WHERE id=$1", [triage]))[0].state, "paused");
  } finally {
    await db.close();
  }
});
