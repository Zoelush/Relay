import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { helpSite } from "../server/help-site";
import { runJob } from "../server/jobs";
import {
  extract,
  ExtractError,
  html,
  matchesType,
  MAX_EXTRACTED_CHARS,
  tidy,
} from "../server/knowledge-extract";
import {
  processKnowledgeFile,
  signFileUrl,
  verifyFileUrl,
} from "../server/knowledge-files";
import { localAttachmentStorage } from "../scripts/local-storage";
import {
  EICAR_TEXT,
  imageOnlyPdf,
  PNG_PIXEL,
  textPdf,
  wordDocument,
} from "./fixtures/documents";

const PDF = "application/pdf";
const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const text = (s: string) => new TextEncoder().encode(s);
const failure = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (e) {
    return e instanceof ExtractError ? e.code : String(e);
  }
  return "extracted";
};

test("extraction: PDF pages, encrypted and scanned PDFs, Word, HTML, Markdown, type checks and truncation", async () => {
  const pdf = await extract(
    textPdf(["Hello refund policy\nSecond line", "Page two text"]),
    PDF,
  );
  assert.equal(pdf.pages, 2);
  assert.equal(pdf.text, "Hello refund policy\nSecond line\n\nPage two text");
  assert.equal(pdf.truncated, false);
  assert.equal(
    await failure(extract(textPdf(["Secret"], { encryptWith: "pw" }), PDF)),
    "PDF_ENCRYPTED",
  );
  assert.equal(await failure(extract(imageOnlyPdf(), PDF)), "NO_TEXT");
  assert.equal(
    await failure(extract(text("%PDF-1.4 not really"), PDF)),
    "UNREADABLE",
  );

  const word = await extract(
    wordDocument(["Refunds\tare fast", "Fish & chips <hot>"]),
    DOCX,
  );
  assert.equal(word.text, "Refunds are fast\nFish & chips <hot>");
  assert.equal(
    await failure(extract(text("PK\x03\x04broken"), DOCX)),
    "UNREADABLE",
  );

  const page = await extract(
    text(
      "<!doctype html><html><head><title> Shipping  times </title><style>p{color:red}</style></head>" +
        "<body><script>alert('no')</script><h1>Shipping</h1><p>Orders ship in <b>2&nbsp;days</b>.</p>" +
        "<noscript>Enable JS</noscript><table><tr><td>EU</td><td>3 days</td></tr></table></body></html>",
    ),
    "text/html",
  );
  assert.equal(page.title, "Shipping times");
  // Blocks are separated by a blank line; table cells by a space.
  assert.equal(
    page.text,
    "Shipping\n\nOrders ship in 2\u00a0days.\n\nEU 3 days",
  );
  assert.equal(html("<template>x</template><p>y</p>").text.trim(), "y");

  const markdown = await extract(
    text("﻿# Returns\r\n\r\n\r\n\r\nSend it   back."),
    "text/markdown",
  );
  assert.equal(markdown.text, "# Returns\n\nSend it back.");
  assert.equal(await failure(extract(text("  \n "), "text/plain")), "NO_TEXT");

  // The declared type must match the bytes.
  assert.equal(matchesType(PNG_PIXEL, "image/png"), true);
  assert.equal(matchesType(PNG_PIXEL, "image/jpeg"), false);
  assert.equal(matchesType(PNG_PIXEL, "text/plain"), false);
  assert.equal(matchesType(text("plain words"), PDF), false);
  assert.equal(
    await failure(extract(text("plain words"), PDF)),
    "TYPE_MISMATCH",
  );
  const long = tidy("a".repeat(MAX_EXTRACTED_CHARS + 5));
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, MAX_EXTRACTED_CHARS);
});

test("signed messenger image addresses expire and cannot be altered", async () => {
  const secret = "s".repeat(40),
    now = Date.parse("2026-10-01T12:00:00Z");
  const url = new URL(
    await signFileUrl(secret, "a", "img-1", now),
    "https://relay.test",
  );
  assert.equal(url.pathname, "/v1/messenger/help/file");
  assert.deepEqual(await verifyFileUrl(secret, url.searchParams, now), {
    workspace: "a",
    id: "img-1",
  });
  assert.equal(
    await verifyFileUrl(secret, url.searchParams, now + 3601_000),
    null,
    "expired after an hour",
  );
  for (const [name, value] of [
    ["w", "b"],
    ["id", "img-2"],
    ["e", String(Number(url.searchParams.get("e")) + 60)],
    ["s", "x" + url.searchParams.get("s")!.slice(1)],
  ]) {
    const q = new URLSearchParams(url.searchParams);
    q.set(name, value);
    assert.equal(await verifyFileUrl(secret, q, now), null, name);
  }
  assert.equal(
    await verifyFileUrl("t".repeat(40), url.searchParams, now),
    null,
  );
});

test("knowledge files: upload, scan and extract, search, replace, remove; article and theme images on the public help center; isolation", async () => {
  const db = await testDatabase();
  const local = localAttachmentStorage();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    storageTransport: "local-pglite",
    attachments: local.storage,
  };
  const call = async (
    path: string,
    data?: unknown,
    principal = "owner-a",
    workspace = "a",
  ) =>
    bridgeAgentRequest(
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
  const agent = async (
    path: string,
    data?: unknown,
    principal = "owner-a",
    workspace = "a",
  ) => {
    const response = await call(path, data, principal, workspace);
    return { status: response.status, body: (await response.json()) as any };
  };
  const sql = async <T = any>(query: string, values: unknown[] = [], w = "a") =>
    tenant(db.connect, w, async (q) => (await q.query<T>(query, values)).rows);
  const code = (r: { body: any }) => r.body.error?.code;
  const files = (
    data: Record<string, unknown>,
    principal = "owner-a",
    w = "a",
  ) => agent("knowledge-files", data, principal, w);
  const knowledge = (data: Record<string, unknown>) => agent("knowledge", data);
  const help = (data: Record<string, unknown>) => agent("help-centers", data);
  const read = (id: string, principal = "owner-a") =>
    agent(
      "knowledge-record?" + new URLSearchParams({ id }),
      undefined,
      principal,
    );
  const search = (q: string, principal = "owner-a") =>
    agent("knowledge?" + new URLSearchParams({ q }), undefined, principal);
  const handlers = {
    "knowledge.file.process": (job: any) =>
      processKnowledgeFile(db.connect, local.storage, job),
  };
  /** Prepare, put the bytes where the signed URL says, complete, and run the job. */
  async function upload(
    data: Record<string, unknown>,
    bytes: Uint8Array,
    w = "a",
  ) {
    const prepared = await files(
      { op: "prepare", size: bytes.length, ...data },
      "owner-" + w,
      w,
    );
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    const put = await local.handle(
      new Request("https://relay.test" + prepared.body.url, {
        method: "PUT",
        headers: prepared.body.headers,
        body: bytes as BodyInit,
      }),
    );
    assert.equal(put?.status, 200);
    const done = await files(
      { op: "complete", fileId: prepared.body.fileId },
      "owner-" + w,
      w,
    );
    assert.equal(done.status, 202);
    await runJob(db.connect, w, done.body.jobId, handlers);
    return prepared.body as { fileId: string; recordId: string };
  }
  const status = async (fileId: string) =>
    (
      await sql<{ status: string; failure_code: string | null }>(
        "SELECT status,failure_code FROM knowledge_files WHERE id=$1",
        [fileId],
      )
    )[0];
  const site = async (path: string) => {
    const r = await helpSite(
      new Request("https://relay.test" + path),
      db.connect,
      "https://relay.test",
      async () => new Response("static", { status: 299 }),
      undefined,
      local.storage,
    );
    return r;
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
        "UPDATE workspace_features SET enabled=true WHERE name IN ('knowledge_v1','help_center_v1')",
        [],
        w,
      );
    }
    await sql(
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','ada','ada-a','Ada','agent')",
    );

    // Only knowledge.manage uploads; sizes and types are checked before any bytes move.
    const policy = {
      op: "prepare",
      purpose: "source",
      name: "Refund policy.pdf",
      type: PDF,
      size: 10,
    };
    assert.equal((await files(policy, "ada-a")).status, 403);
    assert.equal(
      code(await files({ ...policy, size: 21 * 1024 * 1024 })),
      "FILE_SIZE",
    );
    assert.equal(
      code(await files({ ...policy, type: "image/svg+xml" })),
      "FILE_TYPE",
    );
    assert.equal(
      code(
        await files({
          ...policy,
          purpose: "article_image",
          type: "image/png",
          size: 6 * 1024 * 1024,
        }),
      ),
      "FILE_SIZE",
    );

    // A PDF becomes a published, searchable file record.
    const first = await upload(
      { purpose: "source", name: "Refund policy.pdf", type: PDF, locale: "en" },
      textPdf(["Refunds reach a wombat account\nwithin five days", "Page two"]),
    );
    assert.equal((await status(first.fileId)).status, "ready");
    let record = await read(first.recordId);
    assert.equal(record.body.source, "file");
    assert.equal(record.body.audience, "internal");
    assert.equal(record.body.forInbox, true);
    assert.equal(record.body.forAi, false);
    assert.equal(record.body.locales[0].status, "published");
    assert.equal(record.body.locales[0].published.title, "Refund policy");
    assert.equal(record.body.file.status, "ready");
    assert.equal(record.body.file.pages, 2);
    assert.equal(record.body.file.liveVersion, 1);
    assert.match(record.body.file.excerpt, /wombat account/);
    // Found by what is inside it, not only by its title; by teammates who use the inbox too.
    assert.deepEqual(
      (await search("wombat")).body.records.map((r: any) => r.id),
      [first.recordId],
    );
    assert.deepEqual(
      (await search("wombat", "ada-a")).body.records.map((r: any) => r.id),
      [first.recordId],
    );
    assert.equal((await search("kangaroo")).body.records.length, 0);
    // The original downloads, with headers that stop a browser running it.
    const download = await call(
      "knowledge-file?" + new URLSearchParams({ id: first.fileId }),
      undefined,
      "ada-a",
    );
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), PDF);
    assert.match(download.headers.get("content-disposition")!, /^attachment;/);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      new TextDecoder().decode(await download.arrayBuffer()),
      /^%PDF-/,
    );

    // Its content comes from the file: editing operations are refused; settings are allowed.
    for (const op of [
      { op: "save", locale: "en", title: "x", draftVersion: "1" },
      { op: "add_locale", locale: "fr" },
      { op: "restore", locale: "en", revision: 1, draftVersion: "1" },
      { op: "slug", locale: "en", slug: "x" },
    ])
      assert.equal(
        code(await knowledge({ ...op, id: first.recordId })),
        "KNOWLEDGE_SOURCE",
        op.op,
      );
    assert.equal(
      code(
        await knowledge({
          op: "settings",
          id: first.recordId,
          version: record.body.version,
          forAi: true,
        }),
      ),
      "INVALID_KNOWLEDGE",
      "internal content stays away from the AI agent",
    );
    assert.equal(
      (
        await knowledge({
          op: "settings",
          id: first.recordId,
          version: record.body.version,
          audience: "public",
          forAi: true,
        })
      ).status,
      200,
    );
    assert.equal(
      code(
        await knowledge({
          op: "settings",
          id: first.recordId,
          version: String(Number(record.body.version) + 1),
          forHelpCenter: true,
        }),
      ),
      "INVALID_KNOWLEDGE",
      "only articles appear in the help center",
    );
    // Unpublishing takes it out of search; publishing brings the same text back.
    await knowledge({ op: "unpublish", id: first.recordId, locale: "en" });
    assert.equal((await search("wombat")).body.records.length, 0);
    assert.equal(
      (await knowledge({ op: "publish", id: first.recordId, locale: "en" }))
        .status,
      200,
    );
    assert.equal((await search("wombat")).body.records.length, 1);

    // Replacing the file publishes a new version; the old one is kept as history, its bytes gone.
    const second = await upload(
      {
        purpose: "source",
        recordId: first.recordId,
        name: "Refunds v2.docx",
        type: DOCX,
      },
      wordDocument(["Refunds now reach a platypus account", "within two days"]),
    );
    assert.equal(second.recordId, first.recordId);
    assert.equal((await status(first.fileId)).status, "replaced");
    assert.equal((await status(second.fileId)).status, "ready");
    record = await read(first.recordId);
    assert.equal(record.body.file.version, 2);
    assert.equal(record.body.file.liveVersion, 2);
    assert.equal(record.body.locales[0].published.revision, 2);
    assert.equal((await search("wombat")).body.records.length, 0);
    assert.equal((await search("platypus")).body.records.length, 1);
    assert.equal(
      (
        await call(
          "knowledge-file?" + new URLSearchParams({ id: first.fileId }),
        )
      ).status,
      404,
      "replaced bytes are deleted",
    );

    // Failure paths: a virus, a mislabelled file and a password-protected PDF, each explained.
    const virus = await upload(
      {
        purpose: "source",
        name: "notes.txt",
        type: "text/plain",
        locale: "en",
      },
      text("Notes " + EICAR_TEXT),
    );
    assert.deepEqual(await status(virus.fileId), {
      status: "rejected",
      failure_code: "VIRUS_DETECTED",
    });
    record = await read(virus.recordId);
    assert.equal(record.body.file.failure, "VIRUS_DETECTED");
    assert.equal(record.body.locales[0].status, "draft");
    assert.equal(
      (
        await call(
          "knowledge-file?" + new URLSearchParams({ id: virus.fileId }),
        )
      ).status,
      404,
      "a rejected file never downloads",
    );
    const fake = await upload(
      { purpose: "source", name: "fake.pdf", type: PDF, locale: "en" },
      text("not a pdf at all"),
    );
    assert.equal((await status(fake.fileId)).failure_code, "TYPE_MISMATCH");
    const locked = await upload(
      { purpose: "source", name: "locked.pdf", type: PDF, locale: "en" },
      textPdf(["Payroll"], { encryptWith: "secret" }),
    );
    assert.deepEqual(await status(locked.fileId), {
      status: "failed",
      failure_code: "PDF_ENCRYPTED",
    });
    assert.equal(
      code(
        await knowledge({ op: "publish", id: locked.recordId, locale: "en" }),
      ),
      "KNOWLEDGE_SOURCE",
      "nothing to publish until a readable file is uploaded",
    );
    // Completing twice is harmless.
    const again = await files({ op: "complete", fileId: locked.fileId });
    assert.equal(again.status, 202);

    // Isolation: another workspace sees none of it.
    assert.equal(
      (
        await call(
          "knowledge-file?" + new URLSearchParams({ id: second.fileId }),
          undefined,
          "owner-b",
          "b",
        )
      ).status,
      404,
    );
    assert.equal(
      code(
        await files({ op: "complete", fileId: second.fileId }, "owner-b", "b"),
      ),
      "FILE_NOT_FOUND",
    );
    assert.equal(
      code(
        await files({ op: "remove", recordId: first.recordId }, "owner-b", "b"),
      ),
      "KNOWLEDGE_NOT_FOUND",
    );
    assert.equal(
      (
        await agent(
          "knowledge?" + new URLSearchParams({ q: "platypus" }),
          undefined,
          "owner-b",
          "b",
        )
      ).body.records.length,
      0,
    );

    // Removing archives it and deletes every stored version.
    const removed = await files({ op: "remove", recordId: first.recordId });
    assert.deepEqual(removed.body, { recordId: first.recordId, removed: 1 });
    assert.equal((await search("platypus")).body.records.length, 0);
    assert.equal((await status(second.fileId)).status, "removed");
    assert.equal(
      (await read(first.recordId)).body.locales[0].status,
      "archived",
    );

    // Article images: uploaded and scanned before the article can be published with them.
    const { body: center } = await help({
      op: "center_create",
      brandId: "default",
      name: "Acme Help",
      slug: "acme",
      defaultLocale: "en",
      locales: ["en"],
    });
    const { body: node } = await help({
      op: "node_create",
      centerId: center.id,
      locale: "en",
      name: "Billing",
    });
    const { body: article } = await knowledge({
      op: "create",
      source: "article",
      locale: "en",
      title: "Card payments",
      forHelpCenter: true,
    });
    await help({ op: "place", nodeId: node.id, recordId: article.id });
    const image = await upload(
      {
        purpose: "article_image",
        recordId: article.id,
        name: "card.png",
        type: "image/png",
      },
      PNG_PIXEL,
    );
    const unused = await upload(
      {
        purpose: "article_image",
        recordId: article.id,
        name: "other.png",
        type: "image/png",
      },
      PNG_PIXEL,
    );
    const pending = (
      await files({
        op: "prepare",
        purpose: "article_image",
        recordId: article.id,
        name: "late.png",
        type: "image/png",
        size: PNG_PIXEL.length,
      })
    ).body.fileId as string;
    const body = (ids: string[]) => ({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Pay by card." }],
        },
        ...ids.map((attachmentId) => ({
          type: "image",
          attrs: { attachmentId, alt: "The card form" },
        })),
      ],
    });
    await knowledge({
      op: "save",
      id: article.id,
      locale: "en",
      title: "Card payments",
      body: body([image.fileId, pending]),
      draftVersion: "1",
    });
    assert.equal(
      code(
        await knowledge({
          op: "publish",
          id: article.id,
          locale: "en",
          draftVersion: "2",
        }),
      ),
      "IMAGE_NOT_READY",
    );
    await knowledge({
      op: "save",
      id: article.id,
      locale: "en",
      title: "Card payments",
      body: body([image.fileId]),
      draftVersion: "2",
    });
    assert.equal(
      (
        await knowledge({
          op: "publish",
          id: article.id,
          locale: "en",
          draftVersion: "3",
        })
      ).status,
      200,
    );
    // An image only goes in an article; a file record takes documents only.
    assert.equal(
      code(
        await files({
          op: "prepare",
          purpose: "article_image",
          recordId: virus.recordId,
          name: "x.png",
          type: "image/png",
          size: 10,
        }),
      ),
      "KNOWLEDGE_SOURCE",
    );

    // The public page shows the image from this help center; only images the article uses.
    const page = await site("/help/a/acme/en/articles/card-payments");
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(
      pageHtml,
      new RegExp(
        `<img src="/help/a/acme/files/${image.fileId}" alt="The card form"`,
      ),
    );
    const served = await site(`/help/a/acme/files/${image.fileId}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.match(served.headers.get("cache-control")!, /^public/);
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), PNG_PIXEL);
    assert.equal(
      (await site(`/help/a/acme/files/${unused.fileId}`)).status,
      404,
    );
    assert.equal(
      (await site(`/help/a/acme/files/${second.fileId}`)).status,
      404,
    );
    assert.equal(
      (await site(`/help/b/acme/files/${image.fileId}`)).status,
      404,
      "not through another workspace",
    );
    // Signed-in articles keep their images from visitors without a session.
    const { body: current } = await read(article.id);
    await knowledge({
      op: "settings",
      id: article.id,
      version: current.version,
      audience: "signed_in",
    });
    assert.equal(
      (await site(`/help/a/acme/files/${image.fileId}`)).status,
      404,
    );
    await knowledge({
      op: "settings",
      id: article.id,
      version: String(Number(current.version) + 1),
      audience: "public",
    });

    // The messenger gets short-lived signed addresses for the same image.
    const signed = await signFileUrl(env.sessionSecret, "a", image.fileId);
    const messenger = await handleApi(
      new Request("https://relay.test" + signed),
      env,
    );
    assert.equal(messenger.status, 200);
    assert.equal(messenger.headers.get("content-type"), "image/png");
    const forged = new URL(signed, "https://relay.test");
    forged.searchParams.set("id", unused.fileId);
    assert.equal((await handleApi(new Request(forged), env)).status, 404);
    assert.equal(
      (
        await handleApi(
          new Request(
            "https://relay.test" +
              (await signFileUrl(env.sessionSecret, "b", image.fileId)),
          ),
          env,
        )
      ).status,
      404,
      "signed for another workspace",
    );

    // Theme images: a logo, favicon and social image of this help center.
    const logo = await upload(
      {
        purpose: "theme_logo",
        centerId: center.id,
        name: "logo.png",
        type: "image/png",
      },
      PNG_PIXEL,
    );
    const social = await upload(
      {
        purpose: "social_image",
        centerId: center.id,
        name: "card.png",
        type: "image/png",
      },
      PNG_PIXEL,
    );
    const { body: settings } = await agent(
      "help-center?" + new URLSearchParams({ id: center.id }),
    );
    const version = settings.center?.version ?? settings.version;
    assert.equal(
      code(
        await help({
          op: "center_settings",
          id: center.id,
          version,
          theme: { faviconFileId: logo.fileId },
        }),
      ),
      "INVALID_HELP_CENTER",
      "an image uploaded as a logo is not a favicon",
    );
    assert.equal(
      code(
        await help({
          op: "center_settings",
          id: center.id,
          version,
          theme: { logoFileId: image.fileId },
        }),
      ),
      "INVALID_HELP_CENTER",
    );
    assert.equal(
      (
        await help({
          op: "center_settings",
          id: center.id,
          version,
          theme: { logoFileId: logo.fileId, socialImageFileId: social.fileId },
        })
      ).status,
      200,
    );
    const themed = await (
      await site("/help/a/acme/en/articles/card-payments")
    ).text();
    assert.match(
      themed,
      new RegExp(
        `<a class="brand"[^>]*><img src="/help/a/acme/files/${logo.fileId}" alt="Acme Help"/>`,
      ),
    );
    assert.match(
      themed,
      new RegExp(
        `<meta property="og:image" content="https://relay.test/help/a/acme/files/${social.fileId}"/>`,
      ),
    );
    assert.match(
      themed,
      /<meta name="twitter:card" content="summary_large_image"\/>/,
    );
    assert.equal((await site(`/help/a/acme/files/${logo.fileId}`)).status, 200);
  } finally {
    await db.close();
  }
});
