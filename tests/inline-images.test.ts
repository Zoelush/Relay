import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import {
  attachmentScan,
  purgeInlineImages,
  type AttachmentStorage,
} from "../server/attachments";
import { runJob, type Job } from "../server/jobs";
import { RealtimeClient } from "../server/realtime";

const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6, 7, 8,
]);
const EICAR =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const infected = new Uint8Array([...PNG, ...new TextEncoder().encode(EICAR)]);
const text = (t: string) => ({ type: "text", text: t });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const img = (attachmentId: string, alt = "diagram") => ({
  type: "image",
  attrs: { attachmentId, alt },
});
const doc = (...content: unknown[]) => ({ type: "doc", content });

test("inline images: scanned but never parts, checked at send, customer-visible only once sent, purged when orphaned", async () => {
  const db = await testDatabase();
  const objects = new Map<string, { bytes: Uint8Array; type: string }>();
  const deleted: string[] = [];
  const storage: AttachmentStorage = {
    signUpload: async (key) => ({
      url: "https://storage.test/" + key,
      headers: {},
      expiresAt: "",
    }),
    getQuarantine: async (key) => objects.get(key) ?? null,
    scan: async (bytes) =>
      new TextDecoder().decode(bytes).includes(EICAR) ? "infected" : "clean",
    putClean: async (key, bytes, type) =>
      void objects.set(key, { bytes, type }),
    preview: async (bytes) => bytes,
    deleteQuarantine: async (key) => void objects.delete(key),
    deleteClean: async (key) => {
      deleted.push(key);
      objects.delete(key);
    },
    signDownload: async (key) => ({
      url: "https://storage.test/download/" + key,
      expiresAt: "",
    }),
    readClean: async (key) => {
      const o = objects.get(key);
      return o
        ? new Response(o.bytes as BodyInit, {
            headers: { "content-type": o.type },
          })
        : new Response(null, { status: 404 });
    },
  };
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    attachments: storage,
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const agent = async (path: string, data?: unknown, principal = "owner-a") => {
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
        RELAY_WORKSPACE_ID: "a",
        RELAY_BRIDGE_SECRET: env.bridgeSecret,
      },
      (r) => handleApi(r, env),
    );
    return {
      status: response.status,
      body: (await response.json().catch(() => null)) as any,
    };
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
  /** Prepares, uploads and (unless `scan` is false) scans an inline image. */
  const upload = async (
    conversationId: string,
    audience: "customer_visible" | "internal",
    bytes = PNG,
    principal = "owner-a",
    scan = true,
  ) => {
    const prepared = await agent(
      "attachment/prepare",
      {
        conversationId,
        name: "diagram.png",
        size: bytes.length,
        type: "image/png",
        audience,
        purpose: "inline",
      },
      principal,
    );
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    const id = prepared.body.attachmentId as string;
    const [row] = await sql<{ object_key: string }>(
      "SELECT object_key FROM attachments WHERE id=$1",
      [id],
    );
    objects.set(row.object_key, { bytes, type: "image/png" });
    if (!scan) return id;
    const done = await agent(
      "attachment/complete",
      { attachmentId: id },
      principal,
    );
    assert.equal(done.status, 202);
    assert.equal(
      (
        await runJob(db.connect, "a", done.body.jobId, {
          "attachment.scan": (job: Job) =>
            attachmentScan(db.connect, storage, job),
        })
      ).state,
      "succeeded",
    );
    return id;
  };
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
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')",
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
          deviceToken: "inline-images-device-".repeat(3),
          pageUrl: "https://shop.test",
        }),
      }),
      env,
    ).then((r) => r.json())) as any;
    const start = async (t: string) =>
      (await customer("command", boot.token, { action: "start", text: t })).body
        .conversationId as string;
    const id = await start("Can you show me?"),
      other = await start("Another question");

    // Inline uploads are images only, from teammates only, and never become their own part.
    assert.equal(
      (
        await agent("attachment/prepare", {
          conversationId: id,
          name: "a.txt",
          size: 3,
          type: "text/plain",
          audience: "customer_visible",
          purpose: "inline",
        })
      ).body.error.code,
      "ATTACHMENT_TYPE",
    );
    assert.equal(
      (
        await customer("attachment/prepare", boot.token, {
          conversationId: id,
          name: "a.png",
          size: 16,
          type: "image/png",
          purpose: "inline",
        })
      ).body.error.code,
      "ATTACHMENT_TYPE",
    );
    const shown = await upload(id, "customer_visible");
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM conversation_parts WHERE kind='attachment'",
        )
      )[0].n,
      0,
    );
    assert.equal(
      (
        await sql("SELECT status,purpose FROM attachments WHERE id=$1", [shown])
      )[0].status,
      "clean",
    );

    // Customers cannot fetch an inline image that no sent message references.
    assert.equal(
      (await customer("attachment?preview=true&id=" + shown, boot.token))
        .status,
      404,
    );

    // Send-time checks, each with its own error.
    const reply = (d: unknown) =>
      agent("command", { action: "reply", conversationId: id, doc: d });
    const pending = await upload(id, "customer_visible", PNG, "owner-a", false);
    assert.equal(
      (await reply(doc(img(pending)))).body.error.code,
      "IMAGE_NOT_READY",
    );
    const blocked = await upload(id, "customer_visible", infected);
    assert.equal(
      (await sql("SELECT status FROM attachments WHERE id=$1", [blocked]))[0]
        .status,
      "rejected",
    );
    assert.equal(
      (await reply(doc(img(blocked)))).body.error.code,
      "IMAGE_BLOCKED",
    );
    const internal = await upload(id, "internal");
    assert.equal(
      (await reply(doc(img(internal)))).body.error.code,
      "IMAGE_AUDIENCE",
    );
    const theirs = await upload(id, "customer_visible", PNG, "agent-1-a");
    assert.equal(
      (await reply(doc(img(theirs)))).body.error.code,
      "IMAGE_NOT_FOUND",
    );
    const elsewhere = await upload(other, "customer_visible");
    assert.equal(
      (await reply(doc(img(elsewhere)))).body.error.code,
      "IMAGE_NOT_FOUND",
    );
    assert.equal(
      (await reply(doc(img(crypto.randomUUID())))).body.error.code,
      "IMAGE_NOT_FOUND",
    );
    assert.equal(
      (await reply(doc(img("not-a-uuid")))).body.error.code,
      "INVALID_DOCUMENT",
    );

    // A valid reply records the reference; the customer can now fetch that image, and only it.
    const sent = await reply(doc(p(text("Here it is:")), img(shown)));
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual(
      await sql(
        "SELECT attachment_id FROM conversation_part_images WHERE part_id=$1",
        [sent.body.partId],
      ),
      [{ attachment_id: shown }],
    );
    assert.equal(
      (
        await sql("SELECT body FROM conversation_parts WHERE id=$1", [
          sent.body.partId,
        ])
      )[0].body,
      "Here it is:\n\n[Image: diagram]",
    );
    const fetched = await customer(
      "attachment?preview=true&id=" + shown,
      boot.token,
    );
    assert.equal(fetched.status, 200);
    assert.match(fetched.body.url, /storage\.test\/download\//);

    // A note's internal image never reaches the customer, even with its id.
    const note = await agent("command", {
      action: "note",
      conversationId: id,
      doc: doc(p(text("For the team")), img(internal, "internal-only")),
    });
    assert.equal(note.status, 200, JSON.stringify(note.body));
    assert.equal(
      (await customer("attachment?preview=true&id=" + internal, boot.token))
        .status,
      404,
    );
    assert.equal(
      (await customer("attachment?id=" + internal, boot.token)).status,
      404,
    );
    const history = JSON.stringify(
      (await customer("history?conversation=" + id, boot.token)).body,
    );
    assert(history.includes(shown));
    assert(!history.includes(internal) && !history.includes("internal-only"));
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
    assert(JSON.stringify(frames).includes(shown));
    assert(!JSON.stringify(frames).includes(internal));
    // Teammates load both through the authenticated proxy.
    assert.equal(
      (await agent("attachment/content?preview=true&id=" + internal)).status,
      200,
    );

    // Retention: old inline uploads that no part or draft references are deleted, others kept.
    const drafted = await upload(id, "customer_visible");
    const draftSave = await agent("drafts", {
      conversationId: id,
      mode: "reply",
      doc: doc(img(drafted)),
      baseVersion: null,
    });
    assert.equal(draftSave.status, 200);
    await sql(
      "UPDATE attachments SET created_at=now()-interval '31 days' WHERE purpose='inline'",
    );
    const orphans = [pending, blocked, theirs, elsewhere];
    assert.equal(
      await purgeInlineImages(db.connect, storage, "a"),
      orphans.length,
    );
    const left = (
      await sql<{ id: string }>(
        "SELECT id FROM attachments WHERE purpose='inline' ORDER BY id",
      )
    ).map((r) => r.id);
    assert.deepEqual(left, [shown, internal, drafted].sort());
    assert(
      deleted.some((key) => key.includes(elsewhere)),
      "clean objects are deleted from storage",
    );
  } finally {
    await db.close();
  }
});
