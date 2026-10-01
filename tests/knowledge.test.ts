import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { normalizeDoc, plainText, RichDocError } from "../lib/rich-doc";

const p = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const doc = (...content: unknown[]) => ({ type: "doc", content });
const cell = (
  type: string,
  text: string,
  attrs: Record<string, unknown> = {},
) => ({
  type,
  attrs: { colspan: 1, rowspan: 1, colwidth: null, ...attrs },
  content: [p(text)],
});
const RECORD = "3f2a8c1e-9b7d-4e6a-8c5b-1d2e3f4a5b6c";

test("the article profile: headings, callouts, code languages, videos, tables, internal links, described images", () => {
  const article = doc(
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Refunds" }],
    },
    {
      type: "callout",
      attrs: { tone: "warning" },
      content: [p("Refunds take 5 days.")],
    },
    {
      type: "codeBlock",
      attrs: { language: "Bash" },
      content: [{ type: "text", text: "relay refund 42" }],
    },
    { type: "video", attrs: { provider: "youtube", id: "dQw4w9WgXcQ" } },
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [cell("tableHeader", "Plan"), cell("tableHeader", "Days")],
        },
        {
          type: "tableRow",
          content: [
            cell("tableCell", "Pro", { colspan: 1, colwidth: [120] }),
            cell("tableCell", "3"),
          ],
        },
      ],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "See billing",
          marks: [
            { type: "articleLink", attrs: { recordId: RECORD.toUpperCase() } },
          ],
        },
      ],
    },
    {
      type: "image",
      attrs: {
        attachmentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        alt: "The refund screen",
      },
    },
  );
  const normal = normalizeDoc(article, { article: true });
  assert.equal(
    (normal.content[2] as any).attrs.language,
    "bash",
    "languages are lower-cased",
  );
  assert.equal(
    (normal.content[5] as any).content[0].marks[0].attrs.recordId,
    RECORD,
    "internal links keep the record id",
  );
  assert.match(plainText(normal), /Refunds take 5 days\./);
  assert.match(plainText(normal), /Plan \| Days\nPro \| 3/);
  assert.match(
    plainText(normal),
    /\[Video: https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ\]/,
  );
  const refused = (
    input: unknown,
    message: RegExp,
    options = { article: true },
  ) =>
    assert.throws(
      () => normalizeDoc(input, options),
      (e: unknown) => e instanceof RichDocError && message.test(e.message),
    );
  refused(
    doc({ type: "heading", attrs: { level: 1 }, content: [] }),
    /levels 2 to 4/,
  );
  refused(
    doc({ type: "video", attrs: { provider: "dailymotion", id: "x" } }),
    /YouTube or Vimeo/,
  );
  refused(
    doc({ type: "video", attrs: { provider: "vimeo", id: "abc" } }),
    /not recognised/,
  );
  refused(
    doc({ type: "callout", attrs: { tone: "loud" }, content: [p("x")] }),
    /info, warning or success/,
  );
  refused(
    doc({
      type: "image",
      attrs: { attachmentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    }),
    /alt text/,
  );
  refused(doc({ type: "table", content: [] }), /needs a row/);
  refused(
    doc({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "x",
          marks: [{ type: "articleLink", attrs: { recordId: "nope" } }],
        },
      ],
    }),
    /Link to an article/,
  );
  // Messages keep their smaller profile: none of these are allowed there.
  for (const block of [
    article.content[0],
    article.content[1],
    article.content[3],
    article.content[4],
  ])
    refused(doc(block), /Unsupported content/, { article: false });
  refused(doc(article.content[5]), /Unsupported formatting/, {
    article: false,
  });
});

test("knowledge store: per-locale drafts and publishing, revisions and restore, independent switches, internal content kept from customers", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    storageTransport: "local-pglite",
  };
  const agent = async (
    path: string,
    data?: unknown,
    principal = "owner-a",
    workspace = "a",
    key: string = crypto.randomUUID(),
  ) => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/json",
          "idempotency-key": key,
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
  const sql = async <T = any>(query: string, values: unknown[] = [], w = "a") =>
    tenant(db.connect, w, async (q) => (await q.query<T>(query, values)).rows);
  const code = (r: { body: any }) => r.body.error?.code;
  const change = (data: Record<string, unknown>, principal = "owner-a") =>
    agent("knowledge", data, principal);
  const read = (id: string, principal = "owner-a", workspace = "a") =>
    agent(
      "knowledge-record?" + new URLSearchParams({ id }),
      undefined,
      principal,
      workspace,
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
    await sql(
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','ada','ada-a','Ada','agent')",
    );
    assert.equal(
      code(await agent("knowledge")),
      "KNOWLEDGE_DISABLED",
      "off by default",
    );
    for (const w of ["a", "b"])
      await sql(
        "UPDATE workspace_features SET enabled=true WHERE name='knowledge_v1'",
        [],
        w,
      );

    // Only knowledge.manage writes.
    assert.equal(
      (await change({ op: "create", source: "article", title: "x" }, "ada-a"))
        .status,
      403,
    );
    // Files and synced pages arrive with upload and sync (step C1).
    assert.equal(
      code(await change({ op: "create", source: "file", title: "x" })),
      "KNOWLEDGE_SOURCE",
    );
    // Internal content is never customer-facing.
    for (const [data, message] of [
      [
        { source: "internal_article", forAi: true },
        /cannot be shown in the help center or used by the AI agent/,
      ],
      [
        { source: "article", audience: "internal", forHelpCenter: true },
        /cannot be shown in the help center/,
      ],
      [
        { source: "snippet", audience: "public", forHelpCenter: true },
        /Only public articles/,
      ],
      [{ source: "article", locale: "english" }, /Choose a language/],
    ] as const) {
      const r = await change({ op: "create", title: "x", ...data });
      assert.equal(code(r), "INVALID_KNOWLEDGE", JSON.stringify(r.body));
      assert.match(r.body.error.message, message);
    }

    // An article in English, for the help center and the AI agent.
    const created = await change({
      op: "create",
      source: "article",
      locale: "en-gb",
      title: "How refunds work",
      forHelpCenter: true,
      forAi: true,
      body: doc(p("Refunds take 5 days.")),
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.locale, "en-GB", "locales are canonicalised");
    const id = created.body.id;
    let record = (await read(id)).body;
    assert.deepEqual(
      [record.audience, record.forHelpCenter, record.forAi, record.forInbox],
      ["public", true, true, true],
    );
    const en = () => record.locales.find((l: any) => l.locale === "en-GB");
    assert.equal(en().status, "draft");
    assert.equal(en().published, null);

    // Autosave works from the draft version the editor started from; a stale one conflicts.
    const v1 = en().draft.version;
    const saved = await change({
      op: "save",
      id,
      locale: "en-GB",
      draftVersion: v1,
      title: "How refunds work",
      body: doc(p("Refunds take 3 to 5 days.")),
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(
      code(
        await change({
          op: "save",
          id,
          locale: "en-GB",
          draftVersion: v1,
          title: "Stale",
          body: doc(p("Old tab")),
        }),
      ),
      "DRAFT_CONFLICT",
    );
    // Bodies are checked against the article profile.
    assert.equal(
      code(
        await change({
          op: "save",
          id,
          locale: "en-GB",
          draftVersion: saved.body.draftVersion,
          title: "x",
          body: doc({ type: "heading", attrs: { level: 1 } }),
        }),
      ),
      "INVALID_DOCUMENT",
    );

    // Publish: revision 1 goes live.
    const pub1 = await change({
      op: "publish",
      id,
      locale: "en-GB",
      draftVersion: saved.body.draftVersion,
    });
    assert.equal(pub1.body.revision, 1);
    record = (await read(id)).body;
    assert.equal(en().status, "published");
    assert.equal(en().published.revision, 1);
    assert.equal(en().changed, false);
    assert.equal(
      (
        await sql(
          "SELECT published_text FROM knowledge_locales WHERE record_id=$1",
          [id],
        )
      )[0].published_text,
      "Refunds take 3 to 5 days.",
      "the plain text is kept for search",
    );
    // Editing the draft leaves the live version alone until the next publish.
    const draft2 = await change({
      op: "save",
      id,
      locale: "en-GB",
      draftVersion: en().draft.version,
      title: "How refunds work",
      body: doc(p("Refunds take 2 days now.")),
    });
    record = (await read(id)).body;
    assert.equal(en().changed, true);
    assert.equal(
      en().published.body.content[0].content[0].text,
      "Refunds take 3 to 5 days.",
    );
    await change({
      op: "publish",
      id,
      locale: "en-GB",
      draftVersion: draft2.body.draftVersion,
    });
    // Restore revision 1 into the draft; publishing it makes revision 3.
    record = (await read(id)).body;
    assert.deepEqual(
      record.revisions.map((r: any) => [r.locale, r.revision]),
      [
        ["en-GB", 2],
        ["en-GB", 1],
      ],
    );
    const restored = await change({
      op: "restore",
      id,
      locale: "en-GB",
      draftVersion: en().draft.version,
      revision: 1,
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    record = (await read(id)).body;
    assert.equal(
      en().draft.body.content[0].content[0].text,
      "Refunds take 3 to 5 days.",
    );
    assert.equal(
      (
        await change({
          op: "publish",
          id,
          locale: "en-GB",
          draftVersion: en().draft.version,
        })
      ).body.revision,
      3,
    );
    // Revisions are history: they cannot be changed.
    await assert.rejects(
      sql("UPDATE knowledge_revisions SET title='x' WHERE record_id=$1", [id]),
    );

    // Languages are drafted and published independently.
    assert.equal(
      (
        await change({
          op: "add_locale",
          id,
          locale: "fr",
          fromLocale: "en-GB",
        })
      ).status,
      200,
    );
    assert.equal(
      code(await change({ op: "add_locale", id, locale: "fr" })),
      "KNOWLEDGE_LOCALE_EXISTS",
    );
    record = (await read(id)).body;
    const fr = () => record.locales.find((l: any) => l.locale === "fr");
    assert.equal(fr().draft.title, "How refunds work", "copied from English");
    assert.equal(fr().status, "draft", "not live until published");
    const frSaved = await change({
      op: "save",
      id,
      locale: "fr",
      draftVersion: fr().draft.version,
      title: "Les remboursements",
      body: doc(p("Sous 5 jours.")),
    });
    await change({
      op: "publish",
      id,
      locale: "fr",
      draftVersion: frSaved.body.draftVersion,
    });
    await change({ op: "unpublish", id, locale: "en-GB" });
    record = (await read(id)).body;
    assert.deepEqual(
      record.locales.map((l: any) => [l.locale, l.status]),
      [
        ["en-GB", "draft"],
        ["fr", "published"],
      ],
    );
    await change({ op: "archive", id, locale: "en-GB" });

    // Settings: independent switches, from the version the editor started from.
    assert.equal(
      code(await change({ op: "settings", id, version: "99", forAi: false })),
      "KNOWLEDGE_CONFLICT",
    );
    const settings = await change({
      op: "settings",
      id,
      version: record.version,
      forAi: false,
      forInbox: false,
    });
    assert.equal(settings.status, 200, JSON.stringify(settings.body));
    assert.equal(
      code(
        await change({
          op: "settings",
          id,
          version: settings.body.version,
          audience: "internal",
        }),
      ),
      "INVALID_KNOWLEDGE",
      "still in the help center",
    );
    await change({ op: "review", id });
    assert((await read(id)).body.lastReviewedAt);

    // An internal article for teammates, and a large one through the bridge (over the usual 20 KB).
    const big = await change({
      op: "create",
      source: "internal_article",
      title: "Escalation runbook",
      body: doc(
        ...Array.from({ length: 300 }, (_, i) =>
          p(`Step ${i}: ` + "check the logs ".repeat(20)),
        ),
      ),
    });
    assert.equal(big.status, 200, JSON.stringify(big.body));
    record = (await read(big.body.id)).body;
    assert.deepEqual(
      [record.audience, record.forAi, record.forHelpCenter, record.forInbox],
      ["internal", false, false, true],
    );

    // Other teammates see what is available to the inbox, and only what is live.
    const visible = (await agent("knowledge", undefined, "ada-a")).body;
    assert.deepEqual(
      visible.records.map((r: any) => r.id),
      [big.body.id],
      "the refunds article was taken out of the inbox",
    );
    assert.equal(visible.canManage, false);
    assert.deepEqual(
      (await read(big.body.id, "ada-a")).body.locales,
      [],
      "its draft is not shown",
    );
    assert.equal((await read(id, "ada-a")).status, 404);
    // Search by title; filter by source.
    assert.deepEqual(
      (await agent("knowledge?q=runbook")).body.records.map((r: any) => r.id),
      [big.body.id],
    );
    assert.deepEqual(
      (await agent("knowledge?source=article")).body.records.map(
        (r: any) => r.id,
      ),
      [id],
    );

    // A retried create (same idempotency key) returns the first result and adds nothing.
    const retry = { op: "create", source: "snippet", title: "Retried snippet" };
    const first = await agent(
      "knowledge",
      retry,
      "owner-a",
      "a",
      "retry-create-1",
    );
    const again = await agent(
      "knowledge",
      retry,
      "owner-a",
      "a",
      "retry-create-1",
    );
    assert.equal(again.body.id, first.body.id);
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM knowledge_locales WHERE draft_title='Retried snippet'",
        )
      )[0].n,
      1,
    );

    // Other workspaces see none of it.
    assert.deepEqual(
      (await agent("knowledge", undefined, "owner-b", "b")).body.records,
      [],
    );
    assert.equal((await read(id, "owner-b", "b")).status, 404);
  } finally {
    await db.close();
  }
});
