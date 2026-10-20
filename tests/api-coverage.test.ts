import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { changeDeveloperTokens } from "../server/developer";
import { handleRest } from "../server/rest";
import { exportJob } from "../server/rest-more";
import type { RateLimiter } from "../server/rate-limit";
import type { AttachmentStorage } from "../server/attachments";
import { jsSdk, jsTypes, pythonSdk } from "../lib/api-sdk";
// The generated SDK, used as a customer would.
import { Relay, RelayError } from "../sdk/javascript/relay.mjs";

/**
 * The API's wider coverage (phase 15, D2; docs/DEVELOPER_PLATFORM_STEP2.md), through the generated
 * JavaScript SDK: events, search (nested, by type, sorted, paged, with named errors), tickets,
 * articles and knowledge, macros, workflows, outbound, data attributes, segments and export; the
 * SDK's 429 retry; another workspace sees none of it. And the Python SDK against a running API.
 */
test("the SDKs are generated from the spec", () => {
  assert.equal(readFileSync("sdk/javascript/relay.mjs", "utf8"), jsSdk(), "run npm run api:doc");
  assert.equal(readFileSync("sdk/javascript/relay.d.ts", "utf8"), jsTypes(), "run npm run api:doc");
  assert.equal(readFileSync("sdk/python/relay.py", "utf8"), pythonSdk(), "run npm run api:doc");
});

async function setUp() {
  const db = await testDatabase();
  const files = new Map<string, Uint8Array>();
  const storage = {
    putClean: async (key: string, bytes: Uint8Array) => void files.set(key, bytes),
    signDownload: async (key: string) => ({ url: "memory://" + key, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
  } as unknown as AttachmentStorage;
  let refuse = 0;
  const limiter: RateLimiter = {
    take: () => (refuse-- > 0 ? { ok: false, remaining: 0, resetSeconds: 1, retryAfterSeconds: 1 } : { ok: true, remaining: 99, resetSeconds: 0, retryAfterSeconds: 0 }),
  };
  const env = { connect: db.connect, rateLimiter: limiter, storage };
  const flags = ["developer_api_v1", "tickets_v1", "knowledge_v1", "help_center_v1", "workflows_v1", "segments_v1", "outbound_v1", "settings_v1"];
  const tokens: Record<string, string> = {};
  for (const w of ["a", "b"]) {
    await tenant(db.connect, w, (q) => seedFoundation(q, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
    await tenant(db.connect, w, (q) => q.query("UPDATE workspace_features SET enabled=true WHERE name=ANY($1)", [flags]));
    const scopes = ["conversations.read", "conversations.reply", "conversations.note", "conversations.manage", "conversations.assign", "contacts.personal_data", "workspace.manage", "knowledge.manage", "macros.use", "data.export"];
    tokens[w] = ((await tenant(db.connect, w, (q) => changeDeveloperTokens(q, w, "owner-" + w, { action: "create", name: "SDK", scopes }))) as { token: string }).token;
  }
  return { db, env, files, tokens, refuseNext: (n: number) => (refuse = n) };
}

test("D2 through the JavaScript SDK: events, search, tickets, articles, macros, workflows, outbound, attributes, segments, export", async () => {
  const { db, env, files, tokens, refuseNext } = await setUp();
  const sql = <T = any>(text: string, values: unknown[] = [], w = "a") => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const client = (token: string) => new Relay({ token, baseUrl: "http://api.test/rest", fetch: ((url: string, init: RequestInit) => handleRest(new Request(url, init), env)) as typeof fetch });
  const relay = client(tokens.a);
  const other = client(tokens.b);
  try {
    // Contacts and their events (an id seen before is ignored).
    const ada = await relay.createContact({ external_id: "u-ada", name: "Ada Lovelace", email: "ada@example.com", custom_attributes: { plan: "pro", seats: 12 } });
    const bob = await relay.createContact({ external_id: "u-bob", name: "Bob", email: "bob@example.org", custom_attributes: { plan: "free", seats: 2 } });
    const ev = await relay.createContactEvent(ada.id, { id: "evt-1", name: "upgraded plan", metadata: { to: "pro" } });
    assert.deepEqual([ev.name, ev.metadata, ev.source], ["upgraded plan", { to: "pro" }, "api"]);
    assert.equal((await relay.createContactEvent(ada.id, { id: "evt-1", name: "upgraded plan" })).id, ev.id, "the same id is kept once");
    assert.deepEqual((await relay.listContactEvents(ada.id)).data.map((e: { id: string }) => e.id), [ev.id]);

    // Conversations to search.
    const c1 = await relay.createConversation({ contact_id: ada.id, body: "Billing question" });
    const c2 = await relay.createConversation({ contact_id: bob.id, body: "Where's my order?" });
    const c3 = await relay.createConversation({ contact_id: ada.id, body: "Another thing" });
    const tag = await relay.createTag({ name: "VIP" });
    await relay.tagConversation(c1.id, { tag_id: tag.id });
    await relay.replyToConversation(c2.id, { body: "On its way" });
    await relay.closeConversation(c3.id);

    // Search: nested AND/OR, membership, sorting and paging, item by item.
    const ids = async (q: unknown, sort?: unknown) => {
      const out: string[] = [];
      for await (const c of relay.searchConversationsAll({ query: q, ...(sort ? { sort } : {}), per_page: 1 })) out.push(c.id);
      return out;
    };
    assert.deepEqual(
      await ids(
        { operator: "AND", value: [{ field: "status", operator: "=", value: "open" }, { operator: "OR", value: [{ field: "tag_id", operator: "=", value: tag.id }, { field: "contact_id", operator: "=", value: bob.id }] }] },
        { field: "created_at", order: "asc" },
      ),
      [c1.id, c2.id],
    );
    assert.deepEqual(await ids({ field: "tag_id", operator: "!=", value: tag.id }, { field: "created_at", order: "asc" }), [c2.id, c3.id], "without the tag");
    assert.deepEqual(await ids({ field: "waiting_since", operator: "<", value: new Date(Date.now() + 60_000).toISOString() }), [c1.id], "only c1 still waits (c2 answered, c3 closed)");
    const contacts = async (q: unknown) => (await relay.searchContacts({ query: q })).data.map((c: { id: string }) => c.id).sort();
    assert.deepEqual(await contacts({ field: "email", operator: "=", value: "ADA@example.com" }), [ada.id]);
    assert.deepEqual(await contacts({ field: "custom_attributes.seats", operator: ">", value: 5 }), [ada.id]);
    assert.deepEqual(await contacts({ operator: "OR", value: [{ field: "name", operator: "^", value: "bo" }, { field: "custom_attributes.plan", operator: "=", value: "pro" }] }), [ada.id, bob.id].sort());
    assert.deepEqual(await contacts({ field: "email", operator: "~", value: "%" }), [], "wildcards are literal");
    // Refused searches name the part at fault.
    for (const [q, field] of [
      [{ field: "colour", operator: "=", value: "red" }, "query.field"],
      [{ operator: "AND", value: [{ field: "status", operator: ">", value: "open" }] }, "query.value[0].operator"],
      [{ field: "status", operator: "=", value: "lost" }, "query.value"],
      [{ field: "created_at", operator: ">", value: "yesterday" }, "query.value"],
      [{ operator: "AND", value: [{ operator: "OR", value: [{ operator: "AND", value: [{ operator: "OR", value: [{ field: "id", operator: "=", value: "x" }] }] }] }] }, "query.value[0].value[0].value[0]"],
    ] as const) {
      const e = await relay.searchConversations({ query: q }).then(() => null, (x: unknown) => x);
      assert.ok(e instanceof RelayError, JSON.stringify(q));
      assert.deepEqual([e.status, e.code, e.field], [400, "invalid_field", field]);
    }

    // Tickets: a type with states, a conversation made a ticket, its state moved.
    await sql("INSERT INTO ticket_types(workspace_id,id,name,category) VALUES('a','bug','Bug report','customer')");
    await sql("INSERT INTO ticket_states(workspace_id,id,type_id,name,customer_label,kind,position) VALUES('a','new','bug','New','Received','submitted',1),('a','fixed','bug','Fixed','Fixed','resolved',2)");
    await sql("INSERT INTO ticket_transitions(workspace_id,type_id,from_state,to_state) VALUES('a','bug','new','fixed')");
    assert.deepEqual((await relay.getTicketType("bug")).states.map((s: { id: string }) => s.id), ["new", "fixed"]);
    const ticket = await relay.createTicket({ conversation_id: c2.id, ticket_type_id: "bug" });
    assert.deepEqual([ticket.id, ticket.state.id, ticket.number > 0], [c2.id, "new", true]);
    assert.equal((await relay.setTicketState(c2.id, { state_id: "fixed" })).state.kind, "resolved");
    const back = await relay.setTicketState(c2.id, { state_id: "new" }).then(() => null, (x: unknown) => x);
    assert.deepEqual(back instanceof RelayError && [back.status, back.code], [409, "ticket_transition"], "the type's own transitions hold");
    assert.deepEqual((await relay.listTickets({ query: { state: "resolved" } })).data.map((t: { id: string }) => t.id), [c2.id]);

    // Articles: a draft, edited, published; listed as knowledge.
    const draft = await relay.createArticle({ title: "Refunds", body: "We refund within 14 days.\n\nAsk us how." });
    assert.deepEqual([draft.state, draft.body], ["draft", "We refund within 14 days.\n\nAsk us how."]);
    await relay.updateArticle(draft.id, { title: "Refunds and returns" });
    const live = await relay.publishArticle(draft.id);
    assert.deepEqual([live.state, live.published_title, live.published_body?.includes("14 days")], ["published", "Refunds and returns", true]);
    assert.deepEqual((await relay.listArticles({ query: { state: "published" } })).data.map((a: { id: string }) => a.id), [draft.id]);
    assert.deepEqual((await relay.listKnowledgeRecords({ query: { source: "article" } })).data.map((k: { published: boolean }) => k.published), [true]);

    // A shared macro, applied: its reply lands as the token's teammate.
    await sql(
      "INSERT INTO macros(workspace_id,id,owner_id,shared,name,mode,body,actions) VALUES('a','thanks','owner',true,'Thanks','reply',$1,'[]')",
      [JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Thanks for writing in" }] }] })],
    );
    assert.deepEqual((await relay.listMacros()).data.map((m: { id: string; body: string }) => [m.id, m.body]), [["thanks", "Thanks for writing in"]]);
    await relay.applyMacro(c1.id, { macro_id: "thanks" });
    const said = (await relay.listConversationParts(c1.id, { query: { per_page: 100 } })).data.filter((p: { kind: string }) => p.kind === "teammate_reply");
    assert.deepEqual(said.map((p: { body: string }) => p.body), ["Thanks for writing in"]);

    // Workflows: listed; only a live manual one can be run.
    await sql("INSERT INTO workflows(workspace_id,id,name,trigger,state,draft,created_by,updated_by) VALUES('a','wf1','Escalate','manual','draft','{}','owner','owner')");
    assert.deepEqual((await relay.listWorkflows()).data.map((x: { id: string; state: string }) => [x.id, x.state]), [["wf1", "draft"]]);
    const notLive = await relay.triggerWorkflow("wf1", { conversation_id: c1.id }).then(() => null, (x: unknown) => x);
    assert.ok(notLive instanceof RelayError && notLive.status === 404);

    // Outbound, with its numbers.
    await sql("INSERT INTO outbound_messages(workspace_id,id,type,title,state,draft,created_by,updated_by) VALUES('a','m1','chat','Welcome','live','{}','owner','owner')");
    await sql(
      "INSERT INTO outbound_entries(workspace_id,id,message_id,version,contact_id,entry_key,status,entered_at,seen_at,replied_at) VALUES('a','e1','m1',1,$1,'k1','sent',now(),now(),now()),('a','e2','m1',1,$2,'k2','sent',now(),now(),NULL)",
      [ada.id, bob.id],
    );
    assert.deepEqual((await relay.getOutboundMessage("m1")).stats, { sent: 2, seen: 2, replied: 1, clicked: 0, dismissed: 0 });

    // Data attributes and segments.
    const attr = await relay.createDataAttribute({ name: "Order number", value_type: "string" });
    assert.deepEqual((await relay.listDataAttributes({ query: { model: "conversation" } })).data.map((a: { id: string }) => a.id), [attr.id]);
    assert.ok((await relay.listSegments()).data.some((s: { id: string }) => s.id === "all-users"));
    const users: string[] = [];
    for await (const c of relay.listSegmentContactsAll("all-users", { query: { per_page: 1 } })) users.push(c.id);
    assert.deepEqual(users.sort(), [ada.id, bob.id].sort());

    // Export: queued, run in parts, then links to its files.
    const exp = await relay.createExport({ resources: ["conversations", "contacts", "tickets"] });
    assert.equal(exp.status, "queued");
    const job = (await sql<{ id: string; payload: Record<string, unknown> }>("SELECT id,payload FROM jobs WHERE id=$1", [exp.id]))[0];
    let result: Record<string, unknown> | null = null;
    for (let i = 0; i < 10; i++) {
      const step = await exportJob(db.connect, env.storage, { workspace_id: "a", id: job.id, payload: job.payload, result } as never);
      result = step.result;
      if (step.done) break;
    }
    await sql("UPDATE jobs SET state='succeeded',result=$2 WHERE id=$1", [exp.id, JSON.stringify(result)]);
    const done = await relay.getExport(exp.id);
    assert.deepEqual([done.status, done.rows], ["done", 3 + 2 + 1]);
    const lines = done.files.flatMap((f: { url: string }) => new TextDecoder().decode(files.get(f.url.replace("memory://", ""))!).trim().split("\n").map((l) => JSON.parse(l)));
    assert.deepEqual(lines.map((l: { type: string }) => l.type).sort(), ["contact", "contact", "conversation", "conversation", "conversation", "ticket"]);

    // The SDK waits out a 429 and tries again.
    refuseNext(1);
    const started = Date.now();
    assert.equal((await relay.getMe()).workspace_id, "a");
    assert.ok(Date.now() - started >= 900, "it waited Retry-After");

    // Another workspace sees none of it.
    for (const call of [() => other.getTicket(c2.id), () => other.getArticle(draft.id), () => other.getOutboundMessage("m1"), () => other.getExport(exp.id), () => other.listContactEvents(ada.id)]) {
      const e = await call().then(() => null, (x: unknown) => x);
      assert.ok(e instanceof RelayError && e.status === 404);
    }
    assert.deepEqual((await other.searchConversations({ query: { field: "status", operator: "=", value: "open" } })).data, []);
  } finally {
    await db.close();
  }
});

test("the Python SDK calls a running API: pages, errors and retries", async () => {
  const { db, env, tokens, refuseNext } = await setUp();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const r = await handleRest(
      new Request("http://127.0.0.1" + req.url, { method: req.method, headers: req.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks) : undefined }),
      env,
    );
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const script = `
import json, sys
sys.path.insert(0, "sdk/python")
from relay import Relay, RelayError
r = Relay(sys.argv[1], sys.argv[2])
c = r.create_contact({"external_id": "py-1", "name": "Py", "email": "py@example.com"})
for i in range(3):
    r.create_conversation({"contact_id": c["id"], "body": "Hello %d" % i})
seen = [x["id"] for x in r.iter_list_conversations(per_page=2)]
try:
    r.reply_to_conversation("nope", {"body": ""})
    err = None
except RelayError as e:
    err = [e.status, e.code, e.field]
me = r.get_me()
print(json.dumps({"contact": c["role"], "conversations": len(seen), "unique": len(set(seen)), "error": err, "workspace": me["workspace_id"]}))
`;
  try {
    refuseNext(1);
    const out = await new Promise<string>((resolve, reject) =>
      execFile("python3", ["-c", script, tokens.a, `http://127.0.0.1:${port}/rest`], { timeout: 60_000 }, (e, stdout, stderr) => (e ? reject(new Error(stderr || e.message)) : resolve(stdout))),
    );
    assert.deepEqual(JSON.parse(out), { contact: "user", conversations: 3, unique: 3, error: [400, "invalid_field", "body"], workspace: "a" });
  } finally {
    server.close();
    await db.close();
  }
});
