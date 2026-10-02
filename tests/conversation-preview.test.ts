import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { runJob, type Job } from "../server/jobs";
import { command, messagePreview } from "../server/conversations";
import { projectInboxChanges, rebuildViews } from "../server/inbox-views";

/**
 * The list cards' preview line (docs/AGENT_CARDS_AND_COMPOSER.md): the latest message, its
 * newest version, never a deleted one or a system event; notes labelled; scoped to the workspace.
 */
test("preview text: whitespace folded, long text cut, attachments named, who wrote it", () => {
  const row = (extra: Record<string, unknown>) => ({
    preview_kind: "customer_message",
    preview_author_type: "contact",
    preview_audience: "public",
    preview_body: "",
    ...extra,
  });
  assert.equal(messagePreview({}), null);
  assert.deepEqual(
    messagePreview(row({ preview_body: "  Where\n\n  is   my order?  " })),
    {
      from: "customer",
      author: null,
      authorId: null,
      text: "Where is my order?",
    },
  );
  const long = messagePreview(row({ preview_body: "word ".repeat(80) }))!;
  assert.equal(long.text.length, 160);
  assert(long.text.endsWith("…"));
  assert.equal(
    messagePreview(
      row({ preview_kind: "attachment", preview_file: "invoice.pdf" }),
    )!.text,
    "Attachment: invoice.pdf",
  );
  assert.deepEqual(
    messagePreview(
      row({
        preview_kind: "teammate_reply",
        preview_author_type: "teammate",
        preview_author: "Ada",
        preview_author_id: "ada",
        preview_body: "On its way",
      }),
    ),
    { from: "teammate", author: "Ada", authorId: "ada", text: "On its way" },
  );
  // Internal parts are notes, whatever their kind (an internal attachment, say).
  assert.equal(
    messagePreview(
      row({
        preview_kind: "attachment",
        preview_audience: "internal",
        preview_author_type: "teammate",
      }),
    )!.from,
    "note",
  );
  assert.equal(
    messagePreview(
      row({ preview_author_type: "ai", preview_kind: "ai_reply" }),
    )!.from,
    "ai",
  );
});

test("list previews: the latest message, edits and deletes respected, notes labelled, no messages yet, and never another workspace's", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const send = (r: Request) => handleApi(r, env);
  const agent = async (path: string, data?: unknown, workspace = "a") => {
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
      "owner-" + workspace,
      {
        RELAY_AGENT_INBOX_V1: "true",
        RELAY_STORAGE_AUTHORITY: "postgres",
        RELAY_API_ORIGIN: "https://relay.test",
        RELAY_WORKSPACE_ID: workspace,
        RELAY_BRIDGE_SECRET: env.bridgeSecret,
      },
      send,
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) =>
    tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "inbox.views.rebuild": (job: Job) => rebuildViews(db.connect, job),
  };
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) =>
        seedFoundation(q, w, "owner-" + w, {
          origins: ["https://shop.test"],
          master: env.identityMaster,
          identitySecret: new TextEncoder().encode("i".repeat(32)),
          enable: true,
        }),
      );
      await sql(
        w,
        "UPDATE workspace_features SET enabled=true WHERE workspace_id=$1 AND name='agent_inbox_views_v1'",
        [w],
      );
    }
    const owner = (
      await sql<{ id: string }>(
        "a",
        "SELECT id FROM teammates WHERE principal_id='owner-a'",
      )
    )[0].id;
    const teammate = { type: "teammate" as const, principal: "owner-a" };
    const { id, reply, note } = await tenant(db.connect, "a", async (q) => {
      const identity = await getIdentity(q, "a", "anonymous", "preview-1");
      const { conversationId } = (await command(
        q,
        "a",
        {
          type: "contact",
          identityId: identity.identityId,
          brandId: "default",
        },
        "preview-start",
        { action: "start", text: "Where is my order?" },
      )) as { conversationId: string };
      const reply = (await command(q, "a", teammate, "preview-reply", {
        action: "reply",
        conversationId,
        text: "It ships today.",
      })) as { partId: string };
      const note = (await command(q, "a", teammate, "preview-note", {
        action: "note",
        conversationId,
        text: "Refund approved by Ada.",
      })) as { partId: string };
      return { id: conversationId, reply, note };
    });
    // A conversation with no messages yet.
    await sql(
      "a",
      "INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,status,assigned,created_at,updated_at) VALUES('a','preview-empty','default','','Customer','','Brand new','open','',now(),now())",
    );
    // Workspace B has a conversation with the same id and its own message: A must never see it.
    await sql(
      "b",
      "INSERT INTO conversations(workspace_id,id,brand_id,token_hash,name,email,title,status,assigned,created_at,updated_at) VALUES('b',$1,'default','','Customer','','B side','open','',now(),now())",
      [id],
    );
    await sql(
      "b",
      "INSERT INTO conversation_parts(workspace_id,id,conversation_id,seq,kind,author_type,author_id,audience,channel,body) VALUES('b','b-part',$1,999,'customer_message','contact','x','public','messenger','Workspace B secret')",
      [id],
    );

    const init = await agent("views", { action: "initialize" });
    let jobId = init.body.jobId;
    while (jobId) {
      const r = await runJob(db.connect, "a", jobId, handlers);
      if (r.state !== "queued") jobId = null;
    }
    while (await projectInboxChanges(db.connect, "a"));
    const all = (await agent("views")).body.views.find(
      (v: any) => v.builtin === "all",
    );
    // Both lists: the saved-view page and the plain inbox snapshot.
    const previews = async () => {
      const page = await agent(
        "view-page?" + new URLSearchParams({ view: all.id, status: "all" }),
      );
      assert.equal(page.status, 200);
      const snapshot = await agent("inbox");
      assert.equal(snapshot.status, 200);
      const pick = (rows: any[]) =>
        Object.fromEntries(
          rows
            .filter((c) => c.id === id || c.id === "preview-empty")
            .map((c) => [c.id, c.preview]),
        );
      const fromPage = pick(page.body.conversations);
      assert.deepEqual(pick(snapshot.body.conversations), fromPage);
      assert(page.body.conversations.every((c: any) => c.activity_at));
      return fromPage;
    };

    // The latest message is the internal note, labelled as one, with its writer.
    let shown = await previews();
    assert.deepEqual(shown[id], {
      from: "note",
      author: "Support teammate",
      authorId: owner,
      text: "Refund approved by Ada.",
    });
    assert.equal(shown["preview-empty"], null);
    assert(!JSON.stringify(shown).includes("Workspace B secret"));

    // A system event after it (priority) changes nothing; deleting the note shows the reply.
    await tenant(db.connect, "a", (q) =>
      command(q, "a", teammate, "preview-priority", {
        action: "priority",
        conversationId: id,
        value: true,
      }),
    );
    assert.equal((await previews())[id].text, "Refund approved by Ada.");
    await tenant(db.connect, "a", (q) =>
      command(q, "a", teammate, "preview-delete", {
        action: "delete",
        conversationId: id,
        partId: note.partId,
      }),
    );
    shown = await previews();
    assert.equal(shown[id].from, "teammate");
    assert.equal(shown[id].text, "It ships today.");
    // An edited message previews its newest version.
    await tenant(db.connect, "a", (q) =>
      command(q, "a", teammate, "preview-edit", {
        action: "edit",
        conversationId: id,
        partId: reply.partId,
        text: "It ships tomorrow instead.",
      }),
    );
    assert.equal((await previews())[id].text, "It ships tomorrow instead.");

    // Workspace B sees its own message and nothing of A's.
    const b = await agent("inbox", undefined, "b");
    const bRow = b.body.conversations.find((c: any) => c.id === id);
    assert.equal(bRow.preview.text, "Workspace B secret");
    assert(!JSON.stringify(b.body).includes("It ships"));
  } finally {
    await db.close();
  }
});
