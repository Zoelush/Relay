import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { RealtimeClient } from "../server/realtime";
import { runJob, type Job } from "../server/jobs";
import { rebuildViews, projectInboxChanges } from "../server/inbox-views";

const text = (t: string) => ({ type: "text", text: t });
const mention = (kind: "teammate" | "team", id: string, label = id) => ({
  type: "mention",
  attrs: { kind, id, label },
});
const note = (...content: unknown[]) => ({
  type: "doc",
  content: [{ type: "paragraph", content }],
});

test("mentions: directory labels, notes only, team expansion without the author, new-only on edit, private notifications, live counts and the Mentions view", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const agent = async (
    path: string,
    data?: unknown,
    principal = "owner-a",
    workspace = "a",
  ) => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
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
  const customer = async (path: string, token: string, data?: unknown) => {
    const r = await handleApi(
      new Request("https://relay.test/v1/messenger/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          origin: "https://shop.test",
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      env,
    );
    return { status: r.status, body: (await r.json()) as any };
  };
  const sql = async <T = any>(query: string, values: unknown[] = []) =>
    tenant(
      db.connect,
      "a",
      async (q) => (await q.query<T>(query, values)).rows,
    );
  const notified = async () =>
    (
      await sql<{ teammate_id: string }>(
        "SELECT teammate_id FROM notifications ORDER BY teammate_id",
      )
    ).map((r) => r.teammate_id);
  try {
    for (const w of ["a", "b"])
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, {
          origins: ["https://shop.test"],
          master: env.identityMaster,
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        }),
      );
    await sql(
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','ada','ada-a','Ada','agent'),('a','grace','grace-a','Grace','agent'),('a','lin','lin-a','Lin','agent')",
    );
    await sql(
      "INSERT INTO teams(workspace_id,id,name) VALUES('a','billing','Billing')",
    );
    // The author is in the team: a team mention must still not notify them.
    await sql(
      "INSERT INTO teammate_teams(workspace_id,teammate_id,team_id) VALUES('a','grace','billing'),('a','owner','billing')",
    );
    await sql(
      "UPDATE workspace_features SET enabled=true WHERE name='agent_inbox_views_v1'",
    );
    const boot = (await handleApi(
      new Request("https://relay.test/v1/messenger/boot", {
        method: "POST",
        headers: {
          origin: "https://shop.test",
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          workspaceId: "a",
          brandId: "default",
          deviceToken: "mentions-device-token-".repeat(3),
          pageUrl: "https://shop.test",
        }),
      }),
      env,
    ).then((r) => r.json())) as any;
    const id = (
      await customer("command", boot.token, {
        action: "start",
        text: "Refund please",
      })
    ).body.conversationId as string;

    // A spoofed label is replaced from the directory; Grace (direct and via Billing) is notified
    // once; the author, although in Billing, is not.
    const sent = await agent("command", {
      action: "note",
      conversationId: id,
      doc: note(
        text("Can "),
        mention("teammate", "ada", "The CEO"),
        text(" and "),
        mention("team", "billing", "Everyone"),
        text(" check this? cc "),
        mention("teammate", "grace"),
      ),
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const [stored] = await sql<{ body: string; data: any }>(
      "SELECT body,data FROM conversation_parts WHERE id=$1",
      [sent.body.partId],
    );
    assert.equal(stored.body, "Can @Ada and @Billing check this? cc @Grace");
    assert.deepEqual(stored.data.doc.content[0].content[1].attrs, {
      kind: "teammate",
      id: "ada",
      label: "Ada",
    });
    assert.deepEqual(await notified(), ["ada", "grace"]);
    assert.deepEqual(
      (
        await sql<{ teammate_id: string }>(
          "SELECT teammate_id FROM conversation_mentions ORDER BY teammate_id",
        )
      ).map((r) => r.teammate_id),
      ["ada", "grace"],
    );

    // Mentions are for notes only, and must name someone in this workspace.
    const inReply = await agent("command", {
      action: "reply",
      conversationId: id,
      doc: note(text("Hi "), mention("teammate", "ada")),
    });
    assert.equal(inReply.status, 400);
    assert.equal(inReply.body.error.code, "MENTION_IN_REPLY");
    assert.equal(
      (
        await agent("command", {
          action: "note",
          conversationId: id,
          doc: note(mention("teammate", "zed")),
        })
      ).body.error.code,
      "MENTION_NOT_FOUND",
    );
    assert.equal(
      (
        await agent("command", {
          action: "note",
          conversationId: id,
          doc: note(mention("teammate", "../ada")),
        })
      ).body.error.code,
      "INVALID_DOCUMENT",
    );

    // Editing the note notifies only people it newly mentions.
    const edited = await agent("command", {
      action: "edit",
      conversationId: id,
      partId: sent.body.partId,
      doc: note(
        mention("teammate", "ada"),
        text(" and "),
        mention("teammate", "lin"),
      ),
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.deepEqual(await notified(), ["ada", "grace", "lin"]);

    // Notifications are per teammate: each sees only their own.
    const ada = await agent("notifications", undefined, "ada-a");
    assert.equal(ada.body.unread, 1);
    assert.equal(ada.body.items.length, 1);
    assert.equal(ada.body.items[0].actorName, "Support teammate");
    assert.equal(ada.body.items[0].conversationTitle, "Refund please");
    assert.match(ada.body.items[0].excerpt, /^Can @Ada and @Billing/);
    assert.deepEqual((await agent("notifications")).body, {
      unread: 0,
      items: [],
    });
    assert.deepEqual(
      (await agent("notifications", undefined, "owner-b", "b")).body,
      {
        unread: 0,
        items: [],
      },
    );
    // Grace cannot mark Ada's notification read.
    await agent(
      "notifications",
      { action: "read", ids: [ada.body.items[0].id] },
      "grace-a",
    );
    assert.equal(
      (await agent("notifications", undefined, "ada-a")).body.unread,
      1,
    );
    assert.equal(
      (await agent("notifications", { action: "read", ids: "all" }, "ada-a"))
        .status,
      400,
    );

    // The unread count reaches Ada's socket without a request.
    const ticket = await agent("realtime-ticket", {}, "ada-a");
    const frames: any[] = [];
    const client = new RealtimeClient(
      { send: (raw) => frames.push(JSON.parse(raw)), close: () => {} },
      env,
      () => {},
      "a",
    );
    await client.receive(
      JSON.stringify({ type: "authenticate", ticket: ticket.body.ticket }),
    );
    await client.notify("");
    assert.equal(
      frames.filter((f) => f.type === "unread").at(-1).notifications,
      1,
    );
    assert.deepEqual(
      (await agent("notifications", { action: "read", all: true }, "ada-a"))
        .body,
      { unread: 0 },
    );
    await client.notify("");
    assert.equal(
      frames.filter((f) => f.type === "unread").at(-1).notifications,
      0,
    );

    // Ada's Mentions view holds the conversation, and follows new mentions live.
    const init = await agent("views", { action: "initialize" }, "ada-a");
    let jobId = init.body.jobId as string;
    while (
      jobId &&
      (
        await runJob(db.connect, "a", jobId, {
          "inbox.views.rebuild": (job: Job) => rebuildViews(db.connect, job),
        })
      ).state === "queued"
    );
    const mentionsView = async () =>
      (await agent("views", undefined, "ada-a")).body.views.find(
        (v: any) => v.builtin === "mentions",
      );
    assert.equal((await mentionsView()).count, "1");
    const second = (
      await customer("command", boot.token, {
        action: "start",
        text: "Another one",
      })
    ).body.conversationId;
    await agent("command", {
      action: "note",
      conversationId: second,
      doc: note(mention("teammate", "ada"), text(" please")),
    });
    while (await projectInboxChanges(db.connect, "a"));
    assert.equal((await mentionsView()).count, "2");
    const page = await agent(
      "view-page?" + new URLSearchParams({ view: (await mentionsView()).id }),
      undefined,
      "ada-a",
    );
    assert.deepEqual(
      page.body.conversations.map((c: any) => c.id).sort(),
      [id, second].sort(),
    );

    // None of it reaches the customer.
    const history = JSON.stringify(
      (await customer("history?conversation=" + id, boot.token)).body,
    );
    assert(!history.includes("@Ada") && !history.includes("mention"));
  } finally {
    await db.close();
  }
});
