import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { saveRole } from "../server/people-settings";
import { AGENT_ROUTES, bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { handleRest } from "../server/rest";
import { changeDeveloperTokens } from "../server/developer";
import { searchConversations } from "../server/search";
import { authorize } from "../server/policy";

/**
 * Restricted roles (phase 16, C2; docs/SECURITY_STEP2.md): a teammate whose role is restricted to
 * assigned conversations sees only those assigned to them or their teams, everywhere: the inbox
 * list, views and their counts, search, a conversation's details and its customer's other
 * conversations, notifications, every conversation route, and the API. No route answers with
 * another conversation's content. The role can't hold personal data, reports, exports or any
 * management permission (refused in words, and by the database), and never on the owner role.
 */
test("restricted roles: only assigned conversations, on every surface; the role's limits held by the database", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const q = <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => tenant(db.connect, "a", async (x) => (await x.query<T>(sql, values)).rows);
  const agent = async (path: string, principal = "owner-a", data?: unknown) => {
    const r = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: { origin: "https://app.test", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      principal,
      { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: "a", RELAY_BRIDGE_SECRET: env.bridgeSecret },
      (x) => handleApi(x, env),
    );
    return { status: r.status, text: await r.text() };
  };
  try {
    await tenant(db.connect, "a", (x) => seedFoundation(x, "a", "owner-a", { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
    await q("UPDATE workspace_features SET enabled=true");

    // The role: restricted, with what such a role may have. Its limits are refused in words.
    const save = (p: Record<string, unknown>) => tenant(db.connect, "a", (x) => saveRole(x, "a", "owner-a", p));
    await assert.rejects(
      save({ name: "Outsourced", scope: "assigned", capabilities: ["conversations.read", "contacts.personal_data"] }),
      /A restricted role can't have: See customers' personal details/,
    );
    await assert.rejects(
      save({ name: "Outsourced", scope: "assigned", capabilities: ["conversations.read", "reports.view", "workspace.manage"] }),
      /can't have: View reports, Manage workspace settings/,
    );
    await assert.rejects(save({ id: "owner", scope: "assigned", capabilities: ["conversations.read"] }), /owner role always has every permission/);
    const { id: role } = await save({ name: "Outsourced", scope: "assigned", capabilities: ["conversations.read", "conversations.reply", "conversations.note", "macros.use"] });
    // And by the database, whatever the code does.
    await assert.rejects(q("INSERT INTO role_capabilities(workspace_id,role_id,capability) VALUES('a',$1,'data.export')", [role]), /restricted role can't have data.export/);
    await assert.rejects(q("UPDATE roles SET scope='assigned' WHERE workspace_id='a' AND id='agent'"), /restricted role can't keep permissions/);

    // Rex (restricted, on Billing), Olive (an agent), and conversations for one customer, each with its own marker.
    await q("INSERT INTO teams(workspace_id,id,name) VALUES('a','billing','Billing')");
    await q("INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','rex','rex-a','Rex',$1),('a','olive','olive-a','Olive','agent')", [role]);
    await q("INSERT INTO teammate_teams(workspace_id,teammate_id,team_id) VALUES('a','rex','billing')");
    const owner = (
      (await tenant(db.connect, "a", (x) =>
        changeDeveloperTokens(x, "a", "owner-a", { action: "create", name: "seed", scopes: ["contacts.personal_data", "conversations.reply", "conversations.assign"] }),
      )) as { token: string }
    ).token;
    const rest = async (token: string, method: string, path: string, body?: unknown) => {
      const r = await handleRest(
        new Request("http://api.test/rest" + path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }),
        { connect: db.connect },
      );
      return { status: r.status, text: await r.text() };
    };
    const contact = JSON.parse((await rest(owner, "POST", "/contacts", { email: "ada@example.test" })).text).id;
    const make = async (marker: string, assign?: Record<string, unknown>) => {
      const id = JSON.parse((await rest(owner, "POST", "/conversations", { contact_id: contact, body: `Help please ${marker}` })).text).id as string;
      if (assign) assert.ok((await rest(owner, "POST", `/conversations/${id}/assign`, assign)).status < 300);
      return id;
    };
    const mine = await make("MarkerMine", { assignee_id: "rex" });
    const team = await make("MarkerTeam", { team_id: "billing" });
    const theirs = await make("MarkerTheirs", { assignee_id: "olive" });
    const nobody = await make("MarkerNobody");
    const hidden = ["MarkerTheirs", "MarkerNobody", theirs, nobody];
    const leaks = (text: string) => hidden.filter((m) => text.includes(m));

    // The inbox list, and its counters: only what's Rex's or Billing's.
    const inbox = JSON.parse((await agent("inbox", "rex-a")).text);
    assert.deepEqual(inbox.conversations.map((c: { id: string }) => c.id).sort(), [mine, team].sort());
    assert.ok(inbox.counters.every((c: { view: string }) => c.view === "mine" || c.view.startsWith("team:")));
    // Views: only Mine and the team inbox; All can't be opened; no new views.
    assert.ok((await agent("views", "rex-a", { action: "initialize" })).status < 300);
    const views = JSON.parse((await agent("views", "rex-a")).text).views as { id: string; builtin: string }[];
    assert.deepEqual(views.map((v) => v.builtin).sort(), ["mine", "team:billing"]);
    const all = (await q<{ id: string }>("SELECT id FROM inbox_views WHERE workspace_id='a' AND owner_id='rex' AND builtin='all'"))[0];
    if (all) assert.equal((await agent("view-page?view=" + all.id, "rex-a")).status, 404);
    assert.equal((await agent("views", "rex-a", { action: "create", name: "Everything", filter: { field: "status", op: "eq", value: "open" } })).status, 403);
    // Search, the details sidebar (and the customer's other conversations), the timeline.
    // Search (as the inbox's search and the command palette run it), as Rex.
    const found = await tenant(db.connect, "a", async (x) =>
      (await searchConversations(x, "a", new URLSearchParams({ q: "please" }), await authorize(x, "a", "rex-a", "conversations.read"))).conversations.map((c) => String(c.id)),
    );
    assert.deepEqual(found.sort(), [mine, team].sort());
    const details = await agent("context?conversation=" + mine, "rex-a");
    assert.equal(details.status, 200);
    assert.deepEqual(
      JSON.parse(details.text).recent.map((r: { id: string }) => r.id),
      [team],
    );
    assert.ok(!JSON.parse(details.text).personalData);
    assert.equal((await agent("context?conversation=" + theirs, "rex-a")).status, 404);
    assert.equal((await agent("command", "rex-a", { conversationId: theirs, action: "reply", text: "Hi" })).status, 404);
    assert.ok((await agent("command", "rex-a", { conversationId: mine, action: "reply", text: "On it" })).status < 300);
    // Notifications: a mention in a conversation Rex can't see isn't shown (its excerpt included).
    const part = (id: string) => q<{ id: string }>("SELECT id FROM conversation_parts WHERE workspace_id='a' AND conversation_id=$1 ORDER BY seq LIMIT 1", [id]);
    for (const [id, text] of [
      [mine, "MarkerMineNote"],
      [theirs, "MarkerTheirsNote"],
    ] as const)
      await q("INSERT INTO notifications(workspace_id,id,teammate_id,kind,conversation_id,part_id,actor_teammate_id,excerpt) VALUES('a',$1,'rex','mention',$2,$3,'owner',$4)", [
        crypto.randomUUID(),
        id,
        (await part(id))[0].id,
        text,
      ]);
    const notes = (await agent("notifications", "rex-a")).text;
    assert.ok(notes.includes("MarkerMineNote") && !notes.includes("MarkerTheirsNote"));

    // Every agent route Rex can call, asked about a conversation he can't see: nothing of it comes back.
    const answered: string[] = [];
    for (const path of AGENT_ROUTES.GET) {
      for (const query of ["", `?conversation=${theirs}`, `?id=${theirs}`, `?conversation=${nobody}`]) {
        const r = await agent(path + query, "rex-a");
        if (r.status < 300 && leaks(r.text).length) answered.push(`${path}${query}: ${leaks(r.text).join(", ")}`);
      }
    }
    assert.deepEqual(answered, [], "no route shows a conversation outside Rex's scope");

    // The API, with Rex's own token: the same scope.
    const rex = (
      (await tenant(db.connect, "a", (x) => changeDeveloperTokens(x, "a", "rex-a", { action: "create", name: "rex", scopes: ["conversations.read", "conversations.reply"] }))) as { token: string }
    ).token;
    const listed = JSON.parse((await rest(rex, "GET", "/conversations")).text).data.map((c: { id: string }) => c.id);
    assert.deepEqual(listed.sort(), [mine, team].sort());
    assert.equal((await rest(rex, "GET", "/conversations/" + theirs)).status, 404);
    assert.equal((await rest(rex, "GET", `/conversations/${theirs}/parts`)).status, 404);
    assert.equal((await rest(rex, "POST", `/conversations/${theirs}/reply`, { body: "Hello" })).status, 404);
    const searched = JSON.parse((await rest(rex, "POST", "/conversations/search", { query: { field: "status", operator: "=", value: "open" } })).text).data.map((c: { id: string }) => c.id);
    assert.deepEqual(searched.sort(), [mine, team].sort());
    assert.equal((await rest(rex, "GET", "/contacts/" + contact)).status, 403, "no personal data, even through the API");

    // An unrestricted agent sees everything; widening Rex's role (scope first) lets it have more.
    assert.equal(JSON.parse((await agent("inbox", "olive-a")).text).conversations.length, 4);
    await save({ id: role, name: "Outsourced", scope: "all", capabilities: ["conversations.read", "conversations.reply", "contacts.personal_data"] });
    assert.equal(JSON.parse((await agent("inbox", "rex-a")).text).conversations.length, 4);
    // Restricting it again drops what it can't keep only if asked to: otherwise it's refused.
    await assert.rejects(save({ id: role, name: "Outsourced", scope: "assigned", capabilities: ["conversations.read", "contacts.personal_data"] }), /can't have/);
    await save({ id: role, name: "Outsourced", scope: "assigned", capabilities: ["conversations.read", "conversations.reply"] });
    assert.equal(JSON.parse((await agent("inbox", "rex-a")).text).conversations.length, 2);

    // The rollback: everyone sees every conversation again.
    const rollback = await readFile("db/rollback/0082_role_scope.sql", "utf8");
    for (const statement of rollback
      .split("\n")
      .filter((l) => !l.startsWith("--"))
      .join("\n")
      .split(";")
      .filter((s) => s.trim()))
      await db.pg.exec(statement);
    assert.equal(JSON.parse((await agent("inbox", "rex-a")).text).conversations.length, 4);
  } finally {
    await db.close();
  }
});
