import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { changeDeveloperTokens, readDeveloperSettings } from "../server/developer";
import { handledOperations, handleRest, VERSION_CHANGES } from "../server/rest";
import { memoryRateLimiter, type RateLimiter } from "../server/rate-limit";
import { operations, SPEC, type Schema } from "../lib/api-spec";
import { CHECKED } from "../lib/api-validate";
import { apiReferenceMarkdown } from "../lib/api-reference";

/**
 * The public API's foundation (phase 15, D1; docs/DEVELOPER_PLATFORM_STEP1.md): the spec is the
 * source (every operation served, every keyword enforced, the reference generated from it); tokens
 * act as their teammate within their scopes, and never reach another workspace; conversations and
 * contacts through the API; errors name the field; lists page by cursor; rate limits answer 429
 * with Retry-After; an older version's requests and responses are translated.
 */
test("the spec is the source: every operation is served, every schema keyword is enforced, and the reference is generated from it", () => {
  assert.deepEqual(operations().map((o) => o.operation.operationId).sort(), handledOperations().sort());
  const used = new Set<string>();
  const walk = (s: Schema) => {
    for (const k of Object.keys(s)) used.add(k);
    Object.values(s.properties ?? {}).forEach(walk);
    if (s.items) walk(s.items);
    if (typeof s.additionalProperties === "object") walk(s.additionalProperties);
  };
  Object.values(SPEC.components.schemas).forEach(walk);
  for (const { operation } of operations()) {
    (operation.parameters ?? []).forEach((p) => walk(p.schema));
    if (operation.requestBody) walk(operation.requestBody.content["application/json"].schema);
  }
  assert.deepEqual([...used].filter((k) => !CHECKED.has(k)), [], "the validator checks every keyword the spec uses");
  assert.equal(readFileSync("docs/API.md", "utf8"), apiReferenceMarkdown(), "run npm run api:doc");
  assert.deepEqual(JSON.parse(readFileSync("docs/openapi.json", "utf8")), JSON.parse(JSON.stringify(SPEC)), "run npm run api:doc");
  for (const { operation } of operations()) assert.ok(operation.description.length > 10 && operation.summary, operation.operationId);
});

test("the API: tokens, scopes and workspaces; conversations and contacts; errors, pages, limits and versions", async () => {
  const db = await testDatabase();
  let limiter: RateLimiter = memoryRateLimiter();
  const call = async (token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await handleRest(
      new Request("http://api.test/rest" + path, {
        method,
        headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { connect: db.connect, rateLimiter: { take: (k, b, n) => limiter.take(k, b, n) } },
    );
    return { status: r.status, headers: r.headers, json: (await r.json()) as any };
  };
  const make = (w: string, principal: string, scopes: string[]) =>
    tenant(db.connect, w, (q) => changeDeveloperTokens(q, w, principal, { action: "create", name: "Test", scopes })) as Promise<{ id: string; token: string }>;
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) => seedFoundation(q, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await tenant(db.connect, w, (q) => q.query("UPDATE workspace_features SET enabled=true WHERE name='developer_api_v1'"));
    }
    const all = ["conversations.read", "conversations.reply", "conversations.note", "conversations.assign", "conversations.manage", "contacts.personal_data", "workspace.manage"];
    const { token } = await make("a", "owner-a", all);
    const { token: tokenB } = await make("b", "owner-b", all);
    assert.match(token, /^relay_pat_[A-Za-z0-9_-]+_[A-Za-z0-9]{40}$/);

    // Who the token is; headers on every answer.
    const me = await call(token, "GET", "/me");
    assert.equal(me.status, 200);
    assert.equal(me.json.workspace_id, "a");
    assert.equal(me.json.teammate.id, "owner");
    assert.equal(me.headers.get("relay-version"), "2026-10-20");
    assert.equal(me.headers.get("x-ratelimit-limit"), "600");
    assert.ok(me.headers.get("x-request-id"));
    // No token, a made-up one, an unknown endpoint and method.
    assert.equal((await call(null, "GET", "/me")).json.errors[0].code, "unauthorized");
    assert.equal((await call("relay_pat_YQ_" + "x".repeat(40), "GET", "/me")).status, 401);
    assert.equal((await call(token, "GET", "/nothing")).json.errors[0].code, "not_found");
    assert.equal((await call(token, "PUT", "/me")).status, 405);
    assert.equal((await call(token, "GET", "/me", undefined, { "relay-version": "2020-01-01" })).json.errors[0].field, "Relay-Version");

    // Contacts: a user by your id (again returns the same one), a lead by email, attributes set and removed.
    const ada = await call(token, "POST", "/contacts", { external_id: "u-1", name: "Ada", email: "ada@example.com", custom_attributes: { plan: "pro", seats: 3 } });
    assert.equal(ada.status, 201);
    assert.deepEqual([ada.json.role, ada.json.name, ada.json.email, ada.json.custom_attributes], ["user", "Ada", "ada@example.com", { plan: "pro", seats: 3 }]);
    assert.equal((await call(token, "POST", "/contacts", { external_id: "u-1" })).json.id, ada.json.id);
    const lead = await call(token, "POST", "/contacts", { email: "lee@example.com" });
    assert.equal(lead.json.role, "lead");
    assert.equal((await call(token, "POST", "/contacts", { name: "Nobody" })).json.errors[0].field, "external_id");
    const updated = await call(token, "PATCH", "/contacts/" + ada.json.id, { name: "Ada L", custom_attributes: { seats: null } });
    assert.deepEqual([updated.json.name, updated.json.custom_attributes], ["Ada L", { plan: "pro" }]);
    assert.deepEqual((await call(token, "GET", "/contacts?email=ADA@example.com")).json.data.map((c: { id: string }) => c.id), [ada.json.id]);
    // Validation names the field.
    assert.deepEqual((await call(token, "PATCH", "/contacts/" + ada.json.id, { colour: "red" })).json.errors[0], { code: "invalid_field", message: "Not a field here.", field: "colour" });
    assert.equal((await call(token, "POST", "/contacts", { email: "not an email" })).json.errors[0].field, "email");

    // Conversations: started for the contact, replied to, noted, assigned, tagged, snoozed, reopened, closed.
    const started = await call(token, "POST", "/conversations", { contact_id: ada.json.id, body: "My order hasn't come" }, { "idempotency-key": "start-1" });
    assert.equal(started.status, 201);
    const c = started.json;
    assert.deepEqual([c.status, c.contact_id, c.assignee_id], ["open", ada.json.id, null]);
    assert.ok(c.waiting_since, "the customer is waiting");
    assert.equal((await call(token, "POST", "/conversations", { contact_id: ada.json.id, body: "My order hasn't come" }, { "idempotency-key": "start-1" })).json.id, c.id, "the same key starts it once");
    assert.equal((await call(token, "POST", `/conversations/${c.id}/reply`, { body: "" })).json.errors[0].field, "body");
    const replied = await call(token, "POST", `/conversations/${c.id}/reply`, { body: "On its way" }, { "idempotency-key": "r-1" });
    assert.equal(replied.json.waiting_since, null);
    await call(token, "POST", `/conversations/${c.id}/reply`, { body: "On its way" }, { "idempotency-key": "r-1" });
    await call(token, "POST", `/conversations/${c.id}/notes`, { body: "Checked the courier" });
    const parts = await call(token, "GET", `/conversations/${c.id}/parts?per_page=100`);
    const said = parts.json.data.filter((p: { kind: string }) => ["customer_message", "teammate_reply", "internal_note"].includes(p.kind));
    assert.deepEqual(
      said.map((p: { kind: string; audience: string; body: string }) => [p.kind, p.audience, p.body]),
      [
        ["customer_message", "public", "My order hasn't come"],
        ["teammate_reply", "public", "On its way"],
        ["internal_note", "internal", "Checked the courier"],
      ],
      "one reply for a repeated key; the note is internal",
    );
    assert.equal((await call(token, "POST", `/conversations/${c.id}/assign`, { assignee_id: "owner" })).json.assignee_id, "owner");
    await tenant(db.connect, "a", (q) => q.query("INSERT INTO teams(workspace_id,id,name,method) VALUES('a','billing','Billing','manual')"));
    const teamed = (await call(token, "POST", `/conversations/${c.id}/assign`, { team_id: "billing" })).json;
    assert.deepEqual([teamed.assignee_id, teamed.team_id], ["owner", "billing"], "setting the team keeps the assignee");
    const tag = (await call(token, "POST", "/tags", { name: "Shipping" })).json;
    assert.equal((await call(token, "POST", "/tags", { name: "shipping" })).json.id, tag.id, "a taken name returns the tag");
    assert.deepEqual((await call(token, "POST", `/conversations/${c.id}/tags`, { tag_id: tag.id })).json.tags.map((t: { name: string }) => t.name), ["Shipping"]);
    assert.deepEqual((await call(token, "DELETE", `/conversations/${c.id}/tags/${tag.id}`)).json.tags, []);
    const until = new Date(Date.now() + 86_400_000).toISOString().replace("Z", "+00:00");
    assert.equal((await call(token, "POST", `/conversations/${c.id}/snooze`, { until })).json.status, "snoozed");
    assert.equal((await call(token, "POST", `/conversations/${c.id}/open`)).json.status, "open");
    assert.equal((await call(token, "POST", `/conversations/${c.id}/close`)).json.status, "closed");

    // Lists page by cursor, and filter.
    await call(token, "POST", "/conversations", { contact_id: lead.json.id, body: "Hello" });
    const first = await call(token, "GET", "/conversations?per_page=1");
    assert.equal(first.json.data.length, 1);
    assert.ok(first.json.pages.next);
    const second = await call(token, "GET", "/conversations?per_page=1&starting_after=" + encodeURIComponent(first.json.pages.next));
    assert.notEqual(second.json.data[0].id, first.json.data[0].id);
    assert.equal(second.json.pages.next, null);
    assert.deepEqual((await call(token, "GET", "/conversations?status=closed")).json.data.map((x: { id: string }) => x.id), [c.id]);
    assert.equal((await call(token, "GET", "/conversations?status=lost")).json.errors[0].field, "status");
    assert.equal((await call(token, "GET", "/conversations?starting_after=nonsense")).json.errors[0].field, "starting_after");
    assert.deepEqual((await call(token, "GET", "/teams")).json.data.map((t: { name: string }) => t.name), ["Billing"]);

    // Another workspace's token sees none of a's.
    assert.equal((await call(tokenB, "GET", "/conversations/" + c.id)).status, 404);
    assert.equal((await call(tokenB, "GET", "/contacts/" + ada.json.id)).status, 404);
    assert.equal((await call(tokenB, "POST", `/conversations/${c.id}/reply`, { body: "Hi" })).status, 404);
    assert.deepEqual((await call(tokenB, "GET", "/conversations")).json.data, []);

    // Scopes: a token can't do what it wasn't given, nor be given more than its maker has.
    const reader = (await make("a", "owner-a", ["conversations.read"])).token;
    assert.equal((await call(reader, "GET", "/conversations/" + c.id)).status, 200);
    const refused = await call(reader, "POST", `/conversations/${c.id}/reply`, { body: "Hi" });
    assert.deepEqual([refused.status, refused.json.errors[0].code], [403, "forbidden"]);
    await tenant(db.connect, "a", (q) => q.query("INSERT INTO roles(workspace_id,id,name) VALUES('a','limited','Limited')"));
    await tenant(db.connect, "a", (q) => q.query("INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','lim','lim-a','Lim','limited')"));
    await assert.rejects(make("a", "lim-a", ["conversations.reply"]), /a token can't have more than you/);

    // Rate limits: refused with 429 and Retry-After, counted as refused.
    limiter = { take: () => ({ ok: false, remaining: 0, resetSeconds: 10, retryAfterSeconds: 3 }) };
    const limited = await call(token, "GET", "/me");
    assert.deepEqual([limited.status, limited.json.errors[0].code, limited.headers.get("retry-after")], [429, "rate_limited", "3"]);
    limiter = memoryRateLimiter();
    const settings = await tenant(db.connect, "a", (q) => readDeveloperSettings(q, "a", "owner-a", "http://api.test/rest"));
    const mine = settings.tokens.find((k) => k.lastHour.limited > 0)!;
    assert.ok(mine.lastHour.calls > 10 && mine.lastHour.limited === 1);
    // The burst: 100, then refused.
    const burst = memoryRateLimiter();
    const results = Array.from({ length: 101 }, () => burst.take("t", { capacity: 100, perSecond: 10 }, 1_000));
    assert.deepEqual([results[99].ok, results[100].ok, results[100].retryAfterSeconds], [true, false, 1]);

    // An older version: its requests are brought forward and its responses taken back.
    VERSION_CHANGES.push({
      version: "2026-10-20",
      before: "2026-09-01",
      request: (id, b) => (id === "replyToConversation" ? { body: (b as { text: string }).text } : b),
      response: (id, b) => (id === "getMe" ? { ...(b as object), token_version: (b as { version: string }).version } : b),
    });
    try {
      const old = await call(token, "GET", "/me", undefined, { "relay-version": "2026-09-01" });
      assert.deepEqual([old.headers.get("relay-version"), old.json.token_version], ["2026-09-01", "2026-10-20"]);
      assert.equal((await call(token, "POST", `/conversations/${c.id}/reply`, { text: "Old shape" }, { "relay-version": "2026-09-01" })).status, 200);
      assert.equal((await call(token, "GET", "/me")).json.token_version, undefined, "the newest is untouched");
    } finally {
      VERSION_CHANGES.pop();
    }

    // Revoked: refused at once. And with the API off, every token is.
    const id = settings.tokens.find((k) => k.scopes.length === 1)!.id;
    await tenant(db.connect, "a", (q) => changeDeveloperTokens(q, "a", "owner-a", { action: "revoke", id }));
    assert.equal((await call(reader, "GET", "/me")).status, 401);
    await tenant(db.connect, "b", (q) => q.query("UPDATE workspace_features SET enabled=false WHERE name='developer_api_v1'"));
    assert.equal((await call(tokenB, "GET", "/me")).status, 401);
    // Only hashes are kept.
    const kept = await tenant(db.connect, "a", (q) => q.query<{ token_hash: string }>("SELECT token_hash FROM api_tokens"));
    assert.ok(kept.rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash) && r.token_hash !== token));
  } finally {
    await db.close();
  }
});
