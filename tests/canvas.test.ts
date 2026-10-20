import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { changeApps, decideConsent, oauthToken } from "../server/oauth";
import { handleRest } from "../server/rest";
import { changeDeveloperTokens } from "../server/developer";
import { canvasOverview, canvasRequest, listCanvasApps, type CanvasEnvironment, type CanvasResult } from "../server/canvas";
import { CanvasInvalid, inputValues, parseAnswer, submittable, validateCanvas, type Canvas } from "../lib/canvas";
import { orderLookupApp } from "../demo/order-lookup/app";
import { ordersFor, orderService } from "../demo/order-lookup/orders";
import { apiReferenceMarkdown } from "../lib/api-reference";

/**
 * Canvas apps (phase 15, D5; docs/DEVELOPER_PLATFORM_STEP5.md): the component schema refuses what
 * it doesn't describe, with the path to the problem; and the order-lookup example app, installed
 * through OAuth and reading the customer through the API with its own token, draws in the sidebar,
 * the composer and settings. Requests are signed (a rotated secret still signs for a day); a time
 * out, an unreachable app, an error status or a card Relay can't show is a failure card, logged and
 * counted for both sides; nothing crosses to a workspace that didn't install it.
 */
const ALL: Canvas["components"] = [
  { type: "text", text: "Orders", style: "header" },
  { type: "image", url: "https://cdn.example/logo.png", alt: "Acme", width: 40, height: 40, rounded: true },
  { type: "button", id: "go", label: "Go", style: "primary", action: { type: "submit" } },
  { type: "button", id: "open", label: "Open", action: { type: "url", url: "https://admin.example/1" } },
  { type: "link", text: "Help", url: "https://help.example" },
  { type: "input", id: "q", label: "Search", placeholder: "Order number", action: { type: "submit" } },
  { type: "textarea", id: "note", label: "Note", value: "" },
  { type: "dropdown", id: "shop", label: "Shop", options: [{ id: "uk", text: "UK" }, { id: "us", text: "US" }], value: "uk" },
  { type: "checkbox", id: "opts", label: "Options", options: [{ id: "a", text: "A" }, { id: "b", text: "B" }], value: ["a"] },
  { type: "list", items: [{ id: "o:1", title: "#1", subtitle: "Shipped", action: { type: "submit" } }, { id: "o:2", title: "#2", disabled: true, action: { type: "submit" } }] },
  { type: "data_table", items: [{ field: "Status", value: "Shipped" }] },
  { type: "divider" },
  { type: "spacer", size: "s" },
];

test("canvas schema: every component, and refusals with the path to the problem", () => {
  const ok = validateCanvas({ content: { components: ALL }, stored_data: { email: "ada@example.test" } });
  assert.equal(ok.canvas.components.length, 12 + 1);
  assert.deepEqual(ok.storedData, { email: "ada@example.test" });
  const refused = (components: unknown[], path: RegExp, extra: Record<string, unknown> = {}) =>
    assert.throws(() => validateCanvas({ content: { components }, ...extra }), (e: unknown) => e instanceof CanvasInvalid && path.test(e.message));
  refused([{ type: "script", text: "alert(1)" }], /components\[0\]\.type: must be one of text, image/);
  refused([{ type: "text", text: "x", lable: "typo" }], /components\[0\]\.lable: isn't a property/);
  refused([{ type: "image", url: "http://cdn.example/x.png", alt: "x" }], /components\[0\]\.url: must be a full https address/);
  refused([{ type: "link", text: "x", url: "javascript:alert(1)" }], /components\[0\]\.url/);
  refused([{ type: "button", id: "b", label: "x", action: { type: "url", url: "https://u:p@x.example" } }], /action\.url/);
  refused([{ type: "image", url: "https://x.example/a.png" }], /\.alt: must be text/);
  refused([{ type: "button", id: "a", label: "x", action: { type: "submit" } }, { type: "list", items: [{ id: "a", title: "dup" }] }], /items\[0\]\.id: a is used twice/);
  refused([{ type: "input", id: "q", label: "x", action: { type: "url", url: "https://x.example" } }], /must be \{"type":"submit"\}/);
  refused([{ type: "dropdown", id: "d", label: "x", options: [{ id: "a", text: "A" }], value: "z" }], /\.value: must be one of its options/);
  refused(Array.from({ length: 51 }, () => ({ type: "divider" })), /must be a list of 1 to 50/);
  refused([{ type: "text", text: "<b>x</b>".repeat(300) }], /\.text: must be 1 to 2000/);
  refused([{ type: "divider" }], /stored_data: must be at most 4096/, { stored_data: { big: "x".repeat(5000) } });
  assert.throws(() => validateCanvas({ content: { components: [] } }), /must be a list of 1 to 50/);

  // What each request may answer, for where it's drawn.
  assert.equal(parseAnswer({ insert_text: "Hi" }, "composer", "submit").kind, "insert");
  assert.throws(() => parseAnswer({ insert_text: "Hi" }, "conversation.sidebar", "submit"), /only answered to a submit in the composer/);
  assert.equal(parseAnswer({ results: { shop: "uk" } }, "settings", "configure").kind, "results");
  assert.throws(() => parseAnswer({ results: {} }, "composer", "submit"), /only answered to configure/);
  assert.throws(() => parseAnswer({ canvas: { content: { components: ALL } }, extra: 1 }, "composer", "initialize"), /exactly one of canvas/);

  // What can be pressed, and which values are kept (only this canvas's own, checked).
  const c = ok.canvas;
  assert.deepEqual(["go", "open", "q", "o:1", "o:2", "shop", "nope"].map((id) => submittable(c, id)), [true, false, true, true, false, false, false]);
  assert.deepEqual(inputValues(c, { q: "1001", shop: "fr", opts: ["b", "zzz"], note: 7, other: "x" }), { q: "1001", opts: ["b"] });
});

test("the reference's Canvas example is the order-lookup app's own code", async () => {
  const md = apiReferenceMarkdown();
  const section = md.slice(md.indexOf("## Canvas apps"), md.indexOf("## Retries"));
  const blocks = [...section.matchAll(/```ts\n([\s\S]*?)\n```/g)].map((m) => m[1].split("\n").map((l) => l.trim()));
  assert.equal(blocks.length, 2);
  const source = (await readFile("demo/order-lookup/app.ts", "utf8")).split("\n").map((l) => l.trim());
  for (const block of blocks) {
    const at = source.indexOf(block[0]);
    assert.ok(at >= 0, `not in the app: ${block[0]}`);
    assert.deepEqual(source.slice(at, at + block.length), block, "the excerpt and the app have drifted: update it in lib/api-reference.ts, then npm run api:doc");
  }
});

test("canvas apps: the order-lookup app installed, drawn in the sidebar, composer and settings; failures; rates; isolation", async () => {
  const db = await testDatabase();
  const API = "http://api.test";
  const APP = "https://orders.example";
  const ORDERS = "http://orders-service.test";
  let orderServiceDown = false;
  const orders = orderService({ down: () => orderServiceDown });
  // The app reaches Relay's API and the order service; nothing here touches the network.
  const appFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin === ORDERS) return orders(req);
    if (url.pathname === "/oauth/token") return oauthToken(req, db.connect);
    if (url.pathname.startsWith("/rest")) return handleRest(req, { connect: db.connect });
    throw new Error("unexpected " + req.url);
  }) as typeof fetch;
  const app = orderLookupApp({ relayHost: "http://relay.test", relayApi: API, publicUrl: APP, orderService: ORDERS, fetch: appFetch });
  // Relay reaches the app; a test can make it hang, fail or answer nonsense.
  let mode: "app" | "hang" | "down" | "nonsense" | "huge" = "app";
  const seen: { url: string; signature: string; body: Record<string, unknown> }[] = [];
  const env: CanvasEnvironment = {
    key: "k".repeat(64),
    timeoutMs: 200,
    policy: {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        seen.push({ url: req.url, signature: req.headers.get("relay-signature") ?? "", body: JSON.parse(await req.clone().text()) });
        if (mode === "hang") return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        if (mode === "down") throw new TypeError("fetch failed");
        if (mode === "nonsense") return Response.json({ canvas: { content: { components: [{ type: "iframe", src: "https://evil.example" }] } } });
        if (mode === "huge") return Response.json({ canvas: { content: { components: [{ type: "text", text: "x".repeat(2000) }] } }, pad: "y".repeat(70_000) });
        return app.handle(req);
      }) as typeof fetch,
    },
  };
  try {
    for (const w of ["dev", "a", "b"]) {
      await tenant(db.connect, w, (q) => seedFoundation(q, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await tenant(db.connect, w, (q) => q.query("UPDATE workspace_features SET enabled=true WHERE name='developer_api_v1'"));
    }
    // Registered with a canvas: its address follows the fetch policy (public https), and its signing secret is shown once.
    const register = (p: Record<string, unknown>) => tenant(db.connect, "dev", (q) => changeApps(q, "dev", "owner-dev", { action: "create", ...p }, env));
    const base = { name: "Order lookup", redirectUris: [APP + "/oauth/callback"], scopes: ["conversations.read", "contacts.personal_data"] };
    await assert.rejects(register({ ...base, canvasUrl: "http://127.0.0.1:9/canvas", canvasPlacements: ["composer"] }), /public https address/);
    await assert.rejects(register({ ...base, canvasPlacements: ["composer"] }), /Give the canvas address/);
    await assert.rejects(register({ ...base, canvasUrl: APP + "/canvas", canvasPlacements: ["messenger.home"] }), /no placement messenger.home/);
    const registered = (await register({ ...base, canvasUrl: APP + "/canvas/", canvasPlacements: ["settings", "composer", "conversation.sidebar"] })) as {
      id: string;
      clientId: string;
      clientSecret: string;
      canvasSecret: string;
      canvasUrl: string;
      canvasPlacements: string[];
    };
    assert.match(registered.canvasSecret, /^relay_cvs_/);
    assert.equal(registered.canvasUrl, APP + "/canvas");
    assert.deepEqual(registered.canvasPlacements, ["conversation.sidebar", "composer", "settings"]);
    app.setCredentials({ clientId: registered.clientId, clientSecret: registered.clientSecret, canvasSecret: registered.canvasSecret });

    // Installed into "a" through the consent screen, from the app's own install page.
    const install = await app.handle(new Request(APP + "/install"));
    const authorize = new URL(install.headers.get("location")!);
    assert.equal(authorize.searchParams.get("scope"), "conversations.read contacts.personal_data");
    const back = await decideConsent(db.connect, "a", "owner-a", { ...(Object.fromEntries(authorize.searchParams) as Record<string, string>), decision: "approve" });
    assert.match(await (await app.handle(new Request(back.redirect))).text(), /Order lookup is installed/);
    assert.ok(app.installedIn("a"));

    // A customer with an email, and their conversation, made through the API.
    const personal = (await tenant(db.connect, "a", (q) => changeDeveloperTokens(q, "a", "owner-a", { action: "create", name: "seed", scopes: ["contacts.personal_data", "conversations.reply"] }))) as { token: string };
    const rest = async (path: string, body: unknown) =>
      (await (await handleRest(new Request(API + "/rest" + path, { method: "POST", headers: { authorization: "Bearer " + personal.token, "content-type": "application/json" }, body: JSON.stringify(body) }), { connect: db.connect })).json()) as { id: string };
    const contact = await rest("/contacts", { email: "ada@example.test", name: "Ada" });
    const conversation = await rest("/conversations", { contact_id: contact.id, body: "Where's my order?" });

    // Where it shows: in "a", for this conversation; not in "b".
    assert.deepEqual((await listCanvasApps(db.connect, "a", "owner-a", "conversation.sidebar", conversation.id)).apps.map((x) => x.appName), ["Order lookup"]);
    assert.deepEqual((await listCanvasApps(db.connect, "a", "owner-a", "composer", conversation.id)).apps.length, 1);
    assert.deepEqual((await listCanvasApps(db.connect, "b", "owner-b", "settings")).apps, []);
    const installationId = (await listCanvasApps(db.connect, "a", "owner-a", "settings")).apps[0].installationId;
    const ask = (p: Record<string, unknown>, w = "a", principal = "owner-a") => canvasRequest(db.connect, env, w, principal, { installationId, ...p }) as Promise<CanvasResult>;
    const ready = (r: CanvasResult) => {
      assert.equal(r.status, "ready", JSON.stringify(r));
      return r as Extract<CanvasResult, { status: "ready" }>;
    };
    const texts = (r: CanvasResult) => JSON.stringify(ready(r).canvas);

    // The sidebar: the customer read through the API with the app's token, their orders listed.
    const sidebar = { placement: "conversation.sidebar", conversationId: conversation.id };
    const first = ready(await ask({ ...sidebar, action: "initialize" }));
    const expected = ordersFor("uk", "ada@example.test").filter((o) => o.status !== "refunded");
    const list = first.canvas.components.find((c) => c.type === "list") as Extract<Canvas["components"][number], { type: "list" }>;
    assert.deepEqual(
      list.items.map((i) => i.id),
      expected.map((o) => "order:" + o.number),
    );
    assert.match(texts(first), /ada@example.test · Acme UK/);
    // The request was signed, to <canvas>/initialize, with ids and no customer data.
    const request = seen.at(-1)!;
    assert.equal(request.url, APP + "/canvas/initialize");
    assert.match(request.signature, /^t=\d+,v1=[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(request.body).sort(), ["conversation", "installation_id", "placement", "request_id", "settings", "teammate", "type", "workspace_id"]);
    assert.ok(!JSON.stringify(request.body).includes("ada@"), "the app reads the customer through the API, within its scopes");
    // Stored data stays on the server.
    assert.ok(!JSON.stringify(first).includes("stored_data"));

    // Pressing an order: its details. Only what's on the card can be pressed, by who opened it.
    const details = ready(await ask({ ...sidebar, action: "submit", sessionId: first.sessionId, componentId: list.items[0].id }));
    assert.match(texts(details), new RegExp(`Order #${expected[0].number}.*"field":"Status"`));
    assert.equal(seen.at(-1)!.body.component_id, list.items[0].id);
    assert.deepEqual(seen.at(-1)!.body.stored_data, { email: "ada@example.test" });
    await assert.rejects(ask({ ...sidebar, action: "submit", sessionId: first.sessionId, componentId: "order:0000" }), /isn't something on this card/);
    await tenant(db.connect, "a", (x) => x.query("INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','grace','grace-a','Grace','admin')"));
    await assert.rejects(ask({ ...sidebar, action: "submit", sessionId: first.sessionId, componentId: "back" }, "a", "grace-a"), /expired/);

    // Settings: configure draws a form; saving keeps its results with the installation, sent with every request.
    const form = ready(await ask({ placement: "settings", action: "initialize" }));
    assert.equal(seen.at(-1)!.url, APP + "/canvas/configure");
    assert.match(texts(form), /"type":"dropdown","id":"shop"/);
    // Only who manages the workspace configures it.
    await tenant(db.connect, "a", (x) => x.query("INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent1','agent-a','Agent','agent')"));
    await assert.rejects(ask({ placement: "settings", action: "initialize" }, "a", "agent-a"), (e: unknown) => (e as { status?: number }).status === 403);
    assert.deepEqual(await ask({ placement: "settings", action: "submit", sessionId: form.sessionId, componentId: "save", inputValues: { shop: "us", options: ["show_refunded"] } }), { status: "configured" });
    assert.deepEqual((await tenant(db.connect, "a", (q) => q.query("SELECT canvas_settings FROM oauth_grants WHERE id=$1", [installationId]))).rows[0].canvas_settings, { shop: "us", show_refunded: true });
    const us = ready(await ask({ ...sidebar, action: "initialize" }));
    assert.match(texts(us), /Acme US/);
    assert.deepEqual(seen.at(-1)!.body.settings, { shop: "us", show_refunded: true });

    // The composer: choose an order, add a line, and its status comes back as text for the reply.
    const composer = { placement: "composer", conversationId: conversation.id };
    const pick = ready(await ask({ ...composer, action: "initialize" }));
    const order = ordersFor("us", "ada@example.test")[0];
    const preview = ready(await ask({ ...composer, action: "submit", sessionId: pick.sessionId, componentId: "order:" + order.number }));
    const inserted = await ask({ ...composer, action: "submit", sessionId: preview.sessionId, componentId: "insert:" + order.number, inputValues: { note: "Thanks for waiting!" } });
    assert.equal(inserted.status, "insert");
    assert.match((inserted as { text: string }).text, new RegExp(`^Your order #${order.number} .*\\n\\nThanks for waiting!$`, "s"));

    // The app's own failure (its order service down) is its own card; Relay draws it.
    orderServiceDown = true;
    assert.match(texts(await ask({ ...sidebar, action: "initialize" })), /The order service isn't answering.*"id":"retry"/);
    orderServiceDown = false;

    // Signing: a new secret, and the app (still on the old one) keeps working for a day; a wrong secret is refused by the app.
    await tenant(db.connect, "dev", (q) => changeApps(q, "dev", "owner-dev", { action: "canvas-secret", id: registered.id }, env));
    ready(await ask({ ...sidebar, action: "initialize" }));
    assert.equal(seen.at(-1)!.signature.split(",").length, 3, "both secrets sign while the old one is retiring");
    app.setCredentials({ clientId: registered.clientId, clientSecret: registered.clientSecret, canvasSecret: "relay_cvs_wrong" });
    const unsigned = await ask({ ...sidebar, action: "initialize" });
    assert.deepEqual([unsigned.status, (unsigned as { outcome: string }).outcome, (unsigned as { message: string }).message], ["failed", "http_error", "Order lookup answered with an error."]);
    assert.equal((await app.handle(new Request(APP + "/canvas/initialize", { method: "POST", body: "{}" }))).status, 401);
    app.setCredentials({ clientId: registered.clientId, clientSecret: registered.clientSecret, canvasSecret: registered.canvasSecret });

    // Relay's failure cards: a time out, an unreachable app, a card it can't show, an answer too large.
    const failed = async (m: typeof mode) => {
      mode = m;
      const r = (await ask({ ...sidebar, action: "initialize" })) as Extract<CanvasResult, { status: "failed" }>;
      mode = "app";
      assert.equal(r.status, "failed");
      return r;
    };
    const slow = await failed("hang");
    assert.deepEqual([slow.outcome, slow.message, slow.detail], ["timeout", "Order lookup didn't answer in time.", "No answer within 0.2 seconds."]);
    assert.equal((await failed("down")).outcome, "unreachable");
    const nonsense = await failed("nonsense");
    assert.deepEqual([nonsense.outcome, nonsense.message], ["invalid_response", "Order lookup sent a card Relay can't show."]);
    assert.match(nonsense.detail, /^canvas\.content\.components\[0\]\.type: must be one of/);
    assert.match((await failed("huge")).detail, /larger than 64 KB/);

    // Error rates: the workspace's own, per installation; the developer's, across workspaces (counts only).
    const here = (await canvasOverview(db.connect, "a")).installed[installationId];
    assert.deepEqual([here.placements, here.configured, here.failures], [["conversation.sidebar", "composer", "settings"], true, 5]);
    assert.equal(here.calls, (await tenant(db.connect, "a", (q) => q.query("SELECT count(*)::int AS n FROM canvas_calls"))).rows[0].n);
    const theirs = (await canvasOverview(db.connect, "dev")).apps[registered.id];
    assert.deepEqual([theirs.calls, theirs.failures, theirs.timeouts], [here.calls, 5, 1]);
    assert.deepEqual(await canvasOverview(db.connect, "b"), { installed: {}, apps: {}, days: 7 });

    // Isolation: another workspace can't use this installation or see this conversation.
    await assert.rejects(ask({ ...sidebar, action: "initialize" }, "b", "owner-b"), /Conversation unavailable/);
    await assert.rejects(ask({ placement: "settings", action: "initialize" }, "b", "owner-b"), /isn't installed here/);

    // With the API off, apps don't show; an archived app no longer shows anywhere.
    await tenant(db.connect, "a", (q) => q.query("UPDATE workspace_features SET enabled=false WHERE name='developer_api_v1'"));
    assert.deepEqual((await listCanvasApps(db.connect, "a", "owner-a", "conversation.sidebar", conversation.id)).apps, []);
    await tenant(db.connect, "a", (q) => q.query("UPDATE workspace_features SET enabled=true WHERE name='developer_api_v1'"));
    await tenant(db.connect, "dev", (q) => changeApps(q, "dev", "owner-dev", { action: "archive", id: registered.id }, env));
    assert.deepEqual((await listCanvasApps(db.connect, "a", "owner-a", "conversation.sidebar", conversation.id)).apps, []);
    await assert.rejects(ask({ ...sidebar, action: "initialize" }), /no longer shows here/);

    // The rollback: no placements anywhere, and the cards on screen forgotten.
    const rollback = await readFile("db/rollback/0080_canvas_apps.sql", "utf8");
    for (const w of ["dev", "a"])
      for (const statement of rollback.split("\n").filter((l) => !l.startsWith("--")).join("\n").split(";").filter((s) => s.trim()))
        await tenant(db.connect, w, (q) => q.query(statement));
    assert.deepEqual((await tenant(db.connect, "dev", (q) => q.query("SELECT canvas_placements FROM oauth_apps"))).rows, [{ canvas_placements: [] }]);
    assert.deepEqual((await tenant(db.connect, "a", (q) => q.query("SELECT 1 FROM canvas_sessions"))).rows, []);
  } finally {
    await db.close();
  }
});
