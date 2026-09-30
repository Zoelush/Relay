import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { RealtimeClient } from "../server/realtime";
import { purgeDrafts } from "../server/drafts";

const text = (t: string, marks?: unknown[]) => ({
  type: "text",
  text: t,
  ...(marks ? { marks } : {}),
});
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", content });

test("drafts are author-only and version-checked; rich messages store a validated doc and never leak notes", async () => {
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
  const draft = (
    data: Record<string, unknown>,
    principal = "owner-a",
    w = "a",
  ) => agent("drafts", data, principal, w);
  const drafts = (id: string, principal = "owner-a", w = "a") =>
    agent(
      "drafts?" + new URLSearchParams({ conversation: id }),
      undefined,
      principal,
      w,
    );
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
    await tenant(db.connect, "a", (q) =>
      q.query(
        "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')",
      ),
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
          deviceToken: "drafts-device-token-".repeat(3),
          pageUrl: "https://shop.test",
        }),
      }),
      env,
    ).then((r) => r.json())) as any;
    const id = (
      await customer("command", boot.token, {
        action: "start",
        text: "Help with my order",
      })
    ).body.conversationId as string;

    // Create, update and read back; a stale or missing base version conflicts.
    const first = await draft({
      conversationId: id,
      mode: "reply",
      doc: doc(p(text("Hello"))),
      baseVersion: null,
      timezone: "Europe/London",
    });
    assert.deepEqual(first, { status: 200, body: { version: "1" } });
    const second = await draft({
      conversationId: id,
      mode: "reply",
      doc: doc(p(text("Hello there"))),
      baseVersion: "1",
    });
    assert.equal(second.body.version, "2");
    const stale = await draft({
      conversationId: id,
      mode: "reply",
      doc: doc(p(text("From an old tab"))),
      baseVersion: "1",
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "DRAFT_CONFLICT");
    assert.equal(stale.body.draft.version, "2");
    assert.deepEqual(stale.body.draft.doc, doc(p(text("Hello there"))));
    assert.equal(
      (
        await draft({
          conversationId: id,
          mode: "reply",
          doc: doc(p(text("x"))),
          baseVersion: null,
        })
      ).status,
      409,
      "a new tab cannot silently overwrite an existing draft",
    );
    await draft({
      conversationId: id,
      mode: "note",
      doc: doc(p(text("private idea"))),
      baseVersion: null,
    });
    const mine = (await drafts(id)).body;
    assert.deepEqual(Object.keys(mine).sort(), ["note", "reply"]);
    assert.equal(mine.reply.version, "2");

    // Author-only: another teammate, even in the same workspace, sees none of them.
    assert.deepEqual((await drafts(id, "agent-1-a")).body, {});
    const theirs = await draft(
      {
        conversationId: id,
        mode: "reply",
        doc: doc(p(text("Agent one's draft"))),
        baseVersion: null,
      },
      "agent-1-a",
    );
    assert.equal(
      theirs.body.version,
      "1",
      "each teammate has an independent draft",
    );
    assert.equal((await drafts(id)).body.reply.version, "2");
    // Other workspaces and invalid content are refused.
    assert.equal((await drafts(id, "owner-b", "b")).status, 404);
    assert.equal(
      (
        await draft(
          {
            conversationId: id,
            mode: "reply",
            doc: doc(p(text("x"))),
            baseVersion: null,
          },
          "owner-b",
          "b",
        )
      ).status,
      404,
    );
    const badLink = await draft({
      conversationId: id,
      mode: "reply",
      doc: doc(
        p(
          text("x", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
        ),
      ),
      baseVersion: "2",
    });
    assert.equal(badLink.status, 400);
    assert.equal(badLink.body.error.code, "INVALID_LINK");
    assert.equal(
      (
        await draft({
          conversationId: id,
          mode: "shout",
          doc: null,
          baseVersion: null,
        })
      ).status,
      400,
    );

    // Sending a rich reply stores the rebuilt doc and plain body, and consumes only that draft.
    const rich = doc(
      p(
        text("Your order "),
        text("shipped", [{ type: "bold" }]),
        text(". Track it "),
        text("here", [
          {
            type: "link",
            attrs: { href: "https://track.test/123", onclick: "x" },
          },
        ]),
      ),
      {
        type: "bulletList",
        content: [{ type: "listItem", content: [p(text("Arrives Friday"))] }],
      },
    );
    const sent = await agent("command", {
      action: "reply",
      conversationId: id,
      doc: rich,
    });
    assert.equal(sent.status, 200);
    const stored = await tenant(
      db.connect,
      "a",
      async (q) =>
        (
          await q.query<{ body: string; data: any }>(
            "SELECT body,data FROM conversation_parts WHERE workspace_id='a' AND id=$1",
            [sent.body.partId],
          )
        ).rows[0],
    );
    assert.equal(
      stored.body,
      "Your order shipped. Track it here (https://track.test/123)\n\n- Arrives Friday",
    );
    assert.deepEqual(stored.data.doc.content[0].content[3].marks, [
      { type: "link", attrs: { href: "https://track.test/123" } },
    ]);
    const after = (await drafts(id)).body;
    assert.equal(
      after.reply,
      undefined,
      "the reply draft was deleted with the send",
    );
    assert(after.note, "the note draft is untouched");
    assert.equal(
      (await drafts(id, "agent-1-a")).body.reply.version,
      "1",
      "another teammate's draft is untouched",
    );
    // An unformatted document is stored as plain text.
    const plain = await agent("command", {
      action: "reply",
      conversationId: id,
      doc: doc(p(text("Thanks!"))),
    });
    const plainRow = await tenant(
      db.connect,
      "a",
      async (q) =>
        (
          await q.query<{ body: string; data: any }>(
            "SELECT body,data FROM conversation_parts WHERE workspace_id='a' AND id=$1",
            [plain.body.partId],
          )
        ).rows[0],
    );
    assert.equal(plainRow.body, "Thanks!");
    assert.equal(plainRow.data.doc, undefined);
    // Invalid documents and customer-sent documents are refused.
    assert.equal(
      (
        await agent("command", {
          action: "reply",
          conversationId: id,
          doc: doc({ type: "image", attrs: { src: "x" } }),
        })
      ).body.error.code,
      "INVALID_DOCUMENT",
    );
    assert.equal(
      (
        await customer("command", boot.token, {
          action: "reply",
          conversationId: id,
          doc: rich,
        })
      ).status,
      403,
    );

    // A rich note's secret never reaches the customer: not via text, link text, URL or code.
    const secret = "secret-" + crypto.randomUUID();
    const note = await agent("command", {
      action: "note",
      conversationId: id,
      doc: doc(
        p(
          text("Note " + secret),
          text("link " + secret, [
            {
              type: "link",
              attrs: { href: "https://internal.test/" + secret },
            },
          ]),
        ),
        { type: "codeBlock", content: [text("code " + secret)] },
      ),
    });
    assert.equal(note.status, 200);
    const history = await customer("history?conversation=" + id, boot.token);
    assert.equal(history.status, 200);
    assert(
      JSON.stringify(history.body).includes("Your order"),
      "the rich reply is visible",
    );
    assert(
      JSON.stringify(history.body).includes('"doc"'),
      "customers receive the reply's doc",
    );
    assert(!JSON.stringify(history.body).includes(secret));
    const frames: unknown[] = [];
    const client = new RealtimeClient(
      { send: (raw) => frames.push(JSON.parse(raw)), close: () => {} },
      env,
      () => {},
      "a",
    );
    await client.receive(
      JSON.stringify({ type: "authenticate", ticket: boot.realtime.ticket }),
    );
    await client.receive(
      JSON.stringify({ type: "subscribe", conversationId: id }),
    );
    assert(JSON.stringify(frames).includes("Your order"));
    assert(!JSON.stringify(frames).includes(secret));
    assert(
      JSON.stringify(
        (await agent("history?" + new URLSearchParams({ conversation: id })))
          .body,
      ).includes(secret),
      "teammates see the note",
    );

    assert.equal(
      (await drafts(id)).body.note,
      undefined,
      "sending the note consumed its draft",
    );
    // Retention: drafts untouched for 30 days are purged; recent ones stay.
    await draft({
      conversationId: id,
      mode: "reply",
      doc: doc(p(text("A recent draft"))),
      baseVersion: null,
    });
    await tenant(db.connect, "a", (q) =>
      q.query(
        "UPDATE conversation_drafts SET updated_at=now()-interval '31 days' WHERE teammate_id='agent-1'",
      ),
    );
    assert.equal(await purgeDrafts(db.connect, "a"), 1);
    assert.deepEqual((await drafts(id, "agent-1-a")).body, {});
    assert((await drafts(id)).body.reply, "the owner's recent draft remains");
  } finally {
    await db.close();
  }
});
