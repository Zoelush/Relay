import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { runJob } from "../server/jobs";
import {
  runSync,
  scheduleDueSyncs,
  type PageRenderer,
  type SyncEnvironment,
} from "../server/knowledge-sync";
import {
  checkAddress,
  FetchRefused,
  safeFetch,
  type FetchPolicy,
} from "../server/safe-fetch";
import {
  excluded,
  normalizeUrl,
  parseRobots,
  parseSelector,
  parseSitemap,
  readPage,
  robotsAllow,
} from "../server/web-crawl";
import { standardSite, testSite } from "./fixtures/site";

const refusal = async (work: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (e) {
    return e instanceof FetchRefused ? e.code : String(e);
  }
  return "allowed";
};

test("fetch safety: public https names only, every redirect checked, size and time limits", async () => {
  for (const address of [
    "http://example.com/",
    "https://localhost/",
    "https://help.localhost/",
    "https://127.0.0.1/",
    "https://10.0.0.8/",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/",
    "https://user:secret@example.com/",
    "https://metadata.google.internal/",
    "https://intranet/",
    "https://printer.local/",
    "https://example.com:8443/",
    "ftp://example.com/",
    "not an address",
  ])
    assert.equal(
      await refusal(() => checkAddress(address)),
      "ADDRESS_NOT_ALLOWED",
      address,
    );
  assert.equal(
    await refusal(() => checkAddress("https://help.example.com/a")),
    "allowed",
  );
  // Tests reach their own site only through an explicit allowance.
  const policy: FetchPolicy = { allowHosts: ["127.0.0.1:9"] };
  assert.equal(
    await refusal(() => checkAddress("http://127.0.0.1:9/x", policy)),
    "allowed",
  );
  assert.equal(
    await refusal(() => checkAddress("http://127.0.0.1:10/x", policy)),
    "ADDRESS_NOT_ALLOWED",
  );

  const respond =
    (make: (url: string) => Response): typeof fetch =>
    async (input) =>
      make(String(input));
  // A redirect to a private address is refused, however it arrives.
  assert.equal(
    await refusal(
      safeFetch("https://help.example.com/", {
        fetch: respond(
          () =>
            new Response(null, {
              status: 302,
              headers: { location: "http://169.254.169.254/" },
            }),
        ),
      }),
    ),
    "ADDRESS_NOT_ALLOWED",
  );
  let hops = 0;
  assert.equal(
    await refusal(
      safeFetch("https://help.example.com/", {
        fetch: respond(
          () =>
            new Response(null, {
              status: 301,
              headers: { location: `/loop-${hops++}` },
            }),
        ),
      }),
    ),
    "TOO_MANY_REDIRECTS",
  );
  const big = "x".repeat(2048);
  assert.equal(
    await refusal(
      safeFetch(
        "https://help.example.com/",
        { fetch: respond(() => new Response(big)) },
        {},
        { maxBytes: 1024 },
      ),
    ),
    "TOO_LARGE",
  );
  assert.equal(
    await refusal(
      safeFetch(
        "https://help.example.com/",
        {
          fetch: (_input, init) =>
            new Promise((_, reject) =>
              init!.signal!.addEventListener("abort", () =>
                reject(new Error("aborted")),
              ),
            ),
        },
        {},
        { timeoutMs: 50 },
      ),
    ),
    "TIMEOUT",
  );
  const ok = await safeFetch("https://help.example.com/a", {
    fetch: respond((url) =>
      url.endsWith("/a")
        ? new Response(null, { status: 302, headers: { location: "/b" } })
        : new Response("<p>B</p>", {
            headers: { "content-type": "text/html" },
          }),
    ),
  });
  assert.equal(ok.url, "https://help.example.com/b");
  assert.equal(ok.body, "<p>B</p>");
});

test("reading the web: stable addresses, exclusions, robots.txt, sitemaps, and stripping parts of a page", () => {
  assert.equal(
    normalizeUrl(
      "https://Help.Example.com:443/a/?utm_source=x&b=2&a=1&fbclid=z#section",
    ),
    "https://help.example.com/a/?a=1&b=2",
  );
  assert.equal(normalizeUrl("../c", "https://e.com/a/b"), "https://e.com/c");
  assert.equal(normalizeUrl("mailto:x@e.com"), null);
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert(excluded("https://e.com/blog/2024/post", ["/blog/*"]));
  assert(excluded("https://e.com/fr/help", ["e.com/fr/*"]));
  assert(!excluded("https://e.com/help/blog", ["/blog/*"]));

  // RFC 9309: the most specific group, the longest rule, Allow on a tie, `*` and `$`.
  const robots = parseRobots(
    [
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: RelayBot",
      "User-agent: otherbot",
      "Disallow: /admin",
      "Allow: /admin/public",
      "Disallow: /*.json$",
      "Disallow:",
      "Sitemap: https://e.com/sitemap-index.xml",
    ].join("\n"),
  );
  assert.equal(robotsAllow(robots, "https://e.com/help"), true);
  assert.equal(robotsAllow(robots, "https://e.com/admin/users"), false);
  assert.equal(robotsAllow(robots, "https://e.com/admin/public/faq"), true);
  assert.equal(robotsAllow(robots, "https://e.com/data.json"), false);
  assert.equal(robotsAllow(robots, "https://e.com/data.json?x=1"), true);
  assert.deepEqual(robots.sitemaps, ["https://e.com/sitemap-index.xml"]);
  assert.equal(
    robotsAllow(parseRobots("User-agent: *\nDisallow: /"), "https://e.com/x"),
    false,
  );
  assert.equal(robotsAllow(parseRobots(""), "https://e.com/x"), true);

  assert.deepEqual(
    parseSitemap(
      '<sitemapindex xmlns="x"><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>',
    ),
    { urls: [], sitemaps: ["https://e.com/s1.xml"] },
  );
  for (const bad of ["nav > a", "div p", "a:hover", "", "::before"])
    assert.equal(parseSelector(bad), null, bad);
  const page = readPage(
    `<html lang="fr-CA"><head><title> Tarifs </title><link rel="canonical" href="/tarifs"></head><body>
      <nav>Menu</nav><div class="cookie banner" role="dialog">Cookies <b>OK</b></div><div id="footer">Footer</div>
      <main><h1>Prix</h1><p>Payez par carte.</p><table><tr><td>A</td><td>B</td></tr></table>
      <a href="/next" rel="nofollow">skip</a><a href="/other">other</a></main></body></html>`,
    ["nav", ".cookie[role=dialog]", "#footer"].map((s) => parseSelector(s)!),
  );
  assert.equal(page.title, "Tarifs");
  assert.equal(page.lang, "fr-CA");
  assert.equal(page.canonical, "/tarifs");
  assert.deepEqual(page.links, ["/other"]);
  assert(!/Menu|Cookies|Footer/.test(page.text));
  assert.match(page.text, /Payez par carte\./);
  assert.match(page.text, /A B/);
});

test("website sync: crawl, records, search, changes, removals, scheduling, settings, failures and isolation", async () => {
  const db = await testDatabase();
  const site = await testSite();
  standardSite(site);
  const renders: string[] = [];
  const renderer: PageRenderer = {
    async render(url) {
      renders.push(url);
      return {
        status: 200,
        url,
        html: "<html><head><title>Rendered</title></head><body><p>Rendered by the fake browser.</p></body></html>",
      };
    },
  };
  const sync: SyncEnvironment = { policy: { allowHosts: [site.host] } };
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    storageTransport: "local-pglite",
    sync,
  };
  const agent = async (
    path: string,
    data?: unknown,
    principal = "owner-a",
    workspace = "a",
    environment = env,
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
        RELAY_BRIDGE_SECRET: environment.bridgeSecret,
      },
      (r) => handleApi(r, environment),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const sql = async <T = any>(query: string, values: unknown[] = [], w = "a") =>
    tenant(db.connect, w, async (q) => (await q.query<T>(query, values)).rows);
  const code = (r: { body: any }) => r.body.error?.code;
  const sources = (
    data: Record<string, unknown>,
    principal = "owner-a",
    w = "a",
  ) => agent("knowledge-sources", data, principal, w);
  const detail = async (id: string) =>
    (await agent("knowledge-source?" + new URLSearchParams({ id }))).body;
  const search = async (q: string) =>
    (await agent("knowledge?" + new URLSearchParams({ q }))).body.records;
  /** Runs a sync job batch by batch until it finishes. */
  async function run(
    jobId: string,
    environment: SyncEnvironment = sync,
    w = "a",
  ) {
    for (let i = 0; i < 200; i++) {
      const r = await runJob(db.connect, w, jobId, {
        "knowledge.sync.run": (job) => runSync(db.connect, environment, job),
      });
      if (r.state !== "queued") return r.state;
    }
    throw new Error("The sync did not finish");
  }
  const page = (d: any, path: string) =>
    d.pages.find((p: any) => p.url === site.origin + path);

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
        "UPDATE workspace_features SET enabled=true WHERE name='knowledge_v1'",
        [],
        w,
      );
    }
    await sql(
      "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','ada','ada-a','Ada','agent')",
    );
    const create = { op: "create", url: site.origin + "/", locale: "en" };
    // Off by default.
    assert.equal(code(await sources(create)), "SYNC_DISABLED");
    assert.equal((await agent("knowledge")).body.sync, false);
    for (const w of ["a", "b"])
      await sql(
        "UPDATE workspace_features SET enabled=true WHERE name='knowledge_sync_v1'",
        [],
        w,
      );
    assert.equal((await agent("knowledge")).body.sync, true);
    assert.equal(
      (await agent("knowledge", undefined, "ada-a")).body.sync,
      false,
    );

    // Only knowledge.manage, only public https addresses, no JavaScript rendering yet.
    assert.equal((await sources(create, "ada-a")).status, 403);
    for (const url of [
      "http://example.com/",
      "https://localhost/",
      "https://10.1.2.3/",
    ])
      assert.equal(
        code(await sources({ ...create, url })),
        "SYNC_ADDRESS",
        url,
      );
    assert.equal(
      code(await sources({ ...create, renderJs: true })),
      "SYNC_RENDER_UNAVAILABLE",
    );
    assert.equal(
      code(await sources({ ...create, strip: ["nav > a"] })),
      "INVALID_SOURCE",
    );
    assert.equal(
      code(await sources({ ...create, audience: "internal", forAi: true })),
      "INVALID_SOURCE",
    );

    // The first run: robots.txt, the sitemap, links on the same site.
    const created = await sources({
      ...create,
      exclude: ["/blog/*"],
      strip: "nav\n.cookie-banner",
    });
    assert.equal(created.status, 202);
    const id = created.body.id as string;
    assert.equal(await run(created.body.jobId), "succeeded");
    let d = await detail(id);
    assert.equal(d.run.status, "succeeded");
    assert.equal(d.pageCount, 4);
    for (const path of ["/", "/shipping", "/returns", "/only-in-sitemap"])
      assert.equal(page(d, path)?.status, "active", path);
    assert.equal(page(d, "/private/staff").reason, "ROBOTS_DISALLOWED");
    assert.equal(page(d, "/quiet").reason, "NOINDEX");
    // Never fetched: disallowed by robots.txt, excluded, not a page, or another site.
    for (const path of ["/private/staff", "/blog/news", "/guide.pdf"])
      assert(!site.hits.includes(path), path);
    assert.equal(page(d, "/blog/news"), undefined);
    assert(!d.pages.some((p: any) => p.url.includes("elsewhere")));
    // Tracking parameters and fragments are not part of a page's id.
    assert(!d.pages.some((p: any) => p.url.includes("utm_")));

    // Pages are records: found by their content, internal and for the inbox, nothing stripped.
    const [shipping] = await search("wombat");
    assert.equal(shipping.source, "external_page");
    assert.equal(shipping.audience, "internal");
    assert.equal(shipping.forAi, false);
    const record = (
      await agent(
        "knowledge-record?" + new URLSearchParams({ id: shipping.id }),
      )
    ).body;
    assert.equal(record.page.url, site.origin + "/shipping");
    assert.equal(record.page.sourceName, site.host);
    assert.equal(record.locales[0].published.title, "Shipping times");
    assert.equal(
      (await search("platypus")).length,
      1,
      "a page only in the sitemap",
    );
    const home = page(d, "/").recordId;
    const homeText = (
      await sql(
        "SELECT published_text FROM knowledge_locales WHERE record_id=$1",
        [home],
      )
    )[0].published_text;
    assert(!/Menu|cookies/.test(homeText), homeText);
    assert.match(homeText, /Welcome to the help site/);
    // A synced page is not edited by hand.
    assert.equal(
      code(
        await agent("knowledge", {
          op: "save",
          id: shipping.id,
          locale: "en",
          title: "x",
          draftVersion: "1",
        }),
      ),
      "KNOWLEDGE_SOURCE",
    );

    // Who can use the pages is set once, for every page.
    assert.equal(
      (
        await sources({
          op: "update",
          id,
          version: d.version,
          audience: "public",
          forAi: true,
        })
      ).status,
      200,
    );
    assert.deepEqual(
      await sql(
        "SELECT DISTINCT audience,for_ai FROM knowledge_records WHERE source='external_page'",
      ),
      [{ audience: "public", for_ai: true }],
    );

    // A second run: a changed page republishes, a 404 is archived, unchanged pages are kept.
    site.page(
      "/shipping",
      "Shipping times",
      "<p>Orders now ship the same day by platypus express.</p>",
      { headers: { etag: '"ship-2"' } },
    );
    site.routes.delete("/returns");
    site.routes.set("/sitemap.xml", {
      type: "application/xml",
      body: '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
    });
    site.routes.delete("/only-in-sitemap");
    let started = await sources({ op: "sync", id });
    assert.equal(started.status, 202);
    assert.equal(await run(started.body.jobId), "succeeded");
    d = await detail(id);
    assert.equal(d.run.changed, 1);
    assert.equal(d.run.removed, 1);
    assert.equal(page(d, "/returns").status, "removed");
    assert.equal((await search("wombat")).length, 0);
    assert.equal((await search("express")).length, 1);
    assert.equal(
      (
        await sql(
          "SELECT published_revision FROM knowledge_locales WHERE record_id=$1",
          [shipping.id],
        )
      )[0].published_revision,
      2,
    );
    assert.equal(
      (
        await sql(
          "SELECT published_revision FROM knowledge_locales WHERE record_id=$1",
          [home],
        )
      )[0].published_revision,
      1,
      "the unchanged home page is not republished",
    );
    // Missing once: kept for now.
    assert.equal(page(d, "/only-in-sitemap").status, "active");
    // A third run: missing twice, so archived; the unchanged shipping page answers 304.
    site.hits.length = 0;
    started = await sources({ op: "sync", id });
    assert.equal(await run(started.body.jobId), "succeeded");
    d = await detail(id);
    assert.equal(page(d, "/only-in-sitemap").status, "removed");
    assert.equal(page(d, "/only-in-sitemap").reason, "MISSING");
    assert.deepEqual(site.notModified, ["/shipping"]);
    assert.equal(
      (await search("platypus")).length,
      1,
      "only the shipping page now",
    );
    assert.equal(d.pageCount, 2);

    // Paused sources do not sync; resuming does.
    await sources({ op: "pause", id });
    assert.equal(code(await sources({ op: "sync", id })), "SOURCE_PAUSED");
    await sources({ op: "resume", id });

    // The schedule: a due source starts once; a running one is not started twice.
    await sql(
      "UPDATE knowledge_sources SET next_run_at=now()-interval '1 minute'",
    );
    assert.equal(await scheduleDueSyncs(db.connect, "a"), 1);
    assert.equal(await scheduleDueSyncs(db.connect, "a"), 0);
    const scheduled = (
      await sql<{ job_id: string; trigger: string }>(
        "SELECT job_id,trigger FROM knowledge_sync_runs WHERE status='running'",
      )
    )[0];
    assert.equal(scheduled.trigger, "schedule");
    assert.equal(await run(scheduled.job_id), "succeeded");
    const next = (
      await sql("SELECT next_run_at FROM knowledge_sources WHERE id=$1", [id])
    )[0].next_run_at;
    const days = (new Date(next).getTime() - Date.now()) / 86_400_000;
    assert(days > 6.9 && days < 7.1, String(days));

    // Failure: robots.txt erroring means nothing is fetched, and the next try is in a day.
    site.routes.set("/robots.txt", {
      status: 500,
      type: "text/plain",
      body: "oops",
    });
    site.hits.length = 0;
    started = await sources({ op: "sync", id });
    assert.equal(await run(started.body.jobId), "succeeded");
    d = await detail(id);
    assert.equal(d.run.status, "failed");
    assert.equal(d.run.failure, "ROBOTS_UNAVAILABLE");
    assert.deepEqual(site.hits, ["/robots.txt"]);
    assert.equal(d.pageCount, 2, "pages are kept when a run fails");
    standardSite(site);

    // Another workspace sees none of it.
    assert.deepEqual(
      (await agent("knowledge-sources", undefined, "owner-b", "b")).body
        .sources,
      [],
    );
    assert.equal(
      code(
        await agent(
          "knowledge-source?" + new URLSearchParams({ id }),
          undefined,
          "owner-b",
          "b",
        ),
      ),
      "SOURCE_NOT_FOUND",
    );
    assert.equal(
      code(await sources({ op: "sync", id }, "owner-b", "b")),
      "SOURCE_NOT_FOUND",
    );
    assert.equal(
      code(await sources({ op: "remove", id }, "owner-b", "b")),
      "SOURCE_NOT_FOUND",
    );

    // Removing the source archives its pages; the records remain.
    const removed = await sources({ op: "remove", id });
    assert.equal(removed.body.removed, 4);
    assert.equal((await search("express")).length, 0);
    assert.deepEqual((await agent("knowledge-sources")).body.sources, []);
    assert.equal(
      (
        await sql(
          "SELECT count(*)::int AS n FROM knowledge_records WHERE source='external_page'",
        )
      )[0].n,
      4,
    );

    // With a renderer, a JavaScript site is read through it.
    const rendering = { ...env, sync: { ...sync, renderer } };
    const js = await agent(
      "knowledge-sources",
      { ...create, renderJs: true },
      "owner-a",
      "a",
      rendering,
    );
    assert.equal(js.status, 202);
    assert.equal(await run(js.body.jobId, rendering.sync), "succeeded");
    assert(renders.includes(site.origin + "/"));
    assert((await search("fake browser")).length >= 1);
    assert.equal(
      (
        await sql("SELECT interval_days FROM knowledge_sources WHERE id=$1", [
          js.body.id,
        ])
      )[0].interval_days,
      14,
    );
  } finally {
    await site.close();
    await db.close();
  }
});
