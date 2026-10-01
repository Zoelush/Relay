import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { digest, tenant, type Sql } from "../server/db";
import { getIdentity, seedFoundation } from "../server/people";
import { changeKnowledge } from "../server/knowledge";
import { changeHelpCenter } from "../server/help-centers";
import { faqPairs, helpSite, negotiate, summary } from "../server/help-site";
import { portalContext } from "../server/portal";
import { PORTAL_COOKIE } from "../server/portal";

const OWN = "https://relay.test";
const p = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const doc = (...content: unknown[]) => ({ type: "doc", content });
const h2 = (text: string) => ({
  type: "heading",
  attrs: { level: 2 },
  content: [{ type: "text", text }],
});

test("FAQ pairs, summaries and language negotiation", () => {
  const faq = faqPairs(
    doc(
      p("Intro"),
      h2("How do I reset my password?"),
      p("Use the link on the sign-in page."),
      p("It expires in an hour."),
      h2("Billing"),
      p("Not a question."),
      h2("¿Puedo pagar con tarjeta？"),
      p("Sí."),
      h2("Empty?"),
    ) as never,
  );
  assert.deepEqual(faq, [
    {
      question: "How do I reset my password?",
      answer: "Use the link on the sign-in page.\n\nIt expires in an hour.",
    },
    { question: "¿Puedo pagar con tarjeta？", answer: "Sí." },
  ]);
  assert.equal(summary("short"), "short");
  const long = summary("word ".repeat(80));
  assert(long.length <= 158 && long.endsWith("…") && !long.includes("  "));

  const center = { default_locale: "en", locales: ["en", "fr", "de"] };
  const ask = (value: string) =>
    negotiate(
      new Request(OWN, { headers: { "accept-language": value } }),
      center,
    );
  assert.equal(ask("fr-CH,fr;q=0.9,en;q=0.8"), "fr");
  assert.equal(ask("ja,de;q=0.5"), "de");
  assert.equal(ask("en;q=0.2,de;q=0.9"), "de");
  assert.equal(ask("ja"), "en");
  assert.equal(ask(""), "en");
  assert.equal(ask("*"), "en");
});

test("public help center: server-rendered pages, metadata, redirects, access, sitemap, custom domains and isolation", async () => {
  const db = await testDatabase();
  const run = <T>(fn: (q: Sql) => Promise<T>, w = "a") =>
    tenant(db.connect, w, fn);
  const sql = <T = any>(query: string, values: unknown[] = [], w = "a") =>
    run(async (q) => (await q.query<T>(query, values)).rows, w);
  const knowledge = (data: Record<string, unknown>) =>
    run((q) => changeKnowledge(q, "a", "owner-a", data)) as Promise<any>;
  const help = (data: Record<string, unknown>) =>
    run((q) => changeHelpCenter(q, "a", "owner-a", data)) as Promise<any>;
  const passed: string[] = [];
  const get = async (
    path: string,
    headers: Record<string, string> = {},
    origin = OWN,
    method = "GET",
  ) => {
    const r = await helpSite(
      new Request(origin + path, { headers, method }),
      db.connect,
      OWN,
      async (req) => {
        passed.push(new URL(req.url).pathname);
        return new Response("static", { status: 299 });
      },
    );
    return { status: r.status, headers: r.headers, body: await r.text() };
  };
  /** An article published in each language given. */
  async function article(
    titles: Record<string, string>,
    body: (title: string) => unknown,
    settings: Record<string, unknown> = {},
  ) {
    const [[firstLocale, firstTitle], ...others] = Object.entries(titles);
    const { id } = await knowledge({
      op: "create",
      source: "article",
      locale: firstLocale,
      title: firstTitle,
      body: body(firstTitle),
      forHelpCenter: true,
      ...settings,
    });
    await knowledge({
      op: "publish",
      id,
      locale: firstLocale,
      draftVersion: "1",
    });
    for (const [locale, title] of others) {
      await knowledge({
        op: "add_locale",
        id,
        locale,
        fromLocale: firstLocale,
      });
      await knowledge({
        op: "save",
        id,
        locale,
        title,
        body: body(title),
        draftVersion: "1",
      });
      await knowledge({ op: "publish", id, locale, draftVersion: "2" });
    }
    return id as string;
  }
  const meta = (html: string, pattern: RegExp) =>
    [...html.matchAll(pattern)].map((m) => m[1]);
  try {
    for (const w of ["a", "b"])
      await run(
        (q) =>
          seedFoundation(q, w, "owner-" + w, {
            origins: ["https://shop.test"],
            master: "m".repeat(40),
            identitySecret: new TextEncoder().encode("i".repeat(32)),
            enable: true,
          }),
        w,
      );
    // Off by default: nothing is served, and other paths pass through untouched.
    assert.equal((await get("/help/a/acme/en")).status, 404);
    assert.equal((await get("/agent")).status, 299);
    for (const w of ["a", "b"])
      await sql(
        "UPDATE workspace_features SET enabled=true WHERE name IN ('knowledge_v1','portal_v1')",
        [],
        w,
      );
    assert.equal(
      (await get("/help/a/acme/en")).status,
      404,
      "knowledge on, public help center still off",
    );
    await sql(
      "UPDATE workspace_features SET enabled=true WHERE name='help_center_v1'",
    );

    const { id: centerId } = await help({
      op: "center_create",
      brandId: "default",
      name: "Acme Help",
      slug: "acme",
      defaultLocale: "en",
      locales: ["en", "fr", "de", "es"],
      theme: { primaryColor: "#ffd400" },
    });
    const start = await help({
      op: "node_create",
      centerId,
      locale: "en",
      name: "Getting started",
      description: "First steps",
    });
    await help({
      op: "node_update",
      id: start.id,
      version: "1",
      locale: "fr",
      name: "Premiers pas",
    });
    const accounts = await help({
      op: "node_create",
      centerId,
      parentId: start.id,
      locale: "en",
      name: "Accounts",
    });
    const rich = (title: string) =>
      doc(
        p(`${title}: start here.`),
        h2("Steps"),
        {
          type: "callout",
          attrs: { tone: "warning" },
          content: [p("Keep your code private.")],
        },
        { type: "video", attrs: { provider: "youtube", id: "dQw4w9WgXcQ" } },
        {
          type: "codeBlock",
          attrs: { language: "bash" },
          content: [{ type: "text", text: "relay login <token>" }],
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { colspan: 2, rowspan: 1, colwidth: null },
                  content: [p("Plan")],
                },
              ],
            },
            {
              type: "tableRow",
              content: [
                {
                  type: "tableCell",
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [p("Free")],
                },
                {
                  type: "tableCell",
                  attrs: { colspan: 1, rowspan: 1, colwidth: null },
                  content: [p("<script>alert(1)</script>")],
                },
              ],
            },
          ],
        },
      );
    // The acceptance criterion: one article in three languages.
    const reset = await article(
      {
        en: "Reset your password",
        fr: "Réinitialiser votre mot de passe",
        de: "Passwort zurücksetzen",
      },
      rich,
    );
    await help({ op: "place", nodeId: accounts.id, recordId: reset });
    const pages = {
      en: "/help/a/acme/en/articles/reset-your-password",
      fr: "/help/a/acme/fr/articles/reinitialiser-votre-mot-de-passe",
      de: "/help/a/acme/de/articles/passwort-zurucksetzen",
    };
    for (const [locale, path] of Object.entries(pages)) {
      const r = await get(path);
      assert.equal(r.status, 200, path + " " + r.body.slice(0, 200));
      assert.match(
        r.body,
        new RegExp(`^<!doctype html><html lang="${locale}" dir="ltr">`),
      );
      assert.equal(r.headers.get("content-language"), locale);
      assert.deepEqual(meta(r.body, /<link rel="canonical" href="([^"]+)"/g), [
        OWN + path,
      ]);
      assert.deepEqual(meta(r.body, /hrefLang="([^"]+)" href=/g), [
        "en",
        "fr",
        "de",
        "x-default",
      ]);
      assert.deepEqual(meta(r.body, /hrefLang="x-default" href="([^"]+)"/g), [
        OWN + pages.en,
      ]);
      assert.deepEqual(meta(r.body, /property="og:url" content="([^"]+)"/g), [
        OWN + path,
      ]);
      assert.deepEqual(meta(r.body, /property="og:type" content="([^"]+)"/g), [
        "article",
      ]);
      assert.doesNotMatch(r.body, /name="robots"/);
      const ld = JSON.parse(
        meta(
          r.body,
          /<script type="application\/ld\+json">(.*?)<\/script>/g,
        )[0],
      );
      const articleLd = ld["@graph"].find((x: any) => x["@type"] === "Article");
      assert.equal(articleLd.inLanguage, locale);
      assert.equal(articleLd.mainEntityOfPage, OWN + path);
      const crumbs = ld["@graph"].find(
        (x: any) => x["@type"] === "BreadcrumbList",
      );
      assert.equal(
        crumbs.itemListElement.length,
        4,
        "home, collection, section, article",
      );
      assert(!ld["@graph"].some((x: any) => x["@type"] === "FAQPage"));
      assert.equal(
        r.headers.get("cache-control"),
        "public, max-age=60, stale-while-revalidate=300",
      );
    }
    // The renderer: every article node, escaped text, a strict CSP whose hashes match the styles.
    const en = await get(pages.en);
    assert.match(en.body, /<title>Reset your password \| Acme Help<\/title>/);
    assert.match(
      en.body,
      /<meta name="description" content="Reset your password: start here."\/>/,
    );
    assert.match(
      en.body,
      /<aside class="callout callout-warning" role="note">/,
    );
    assert.match(
      en.body,
      /<iframe src="https:\/\/www.youtube-nocookie.com\/embed\/dQw4w9WgXcQ" title="YouTube video" loading="lazy"/,
    );
    assert.match(
      en.body,
      /<code class="language-bash">relay login &lt;token&gt;<\/code>/,
    );
    assert.match(en.body, /<th colSpan="2"><p><span>Plan<\/span><\/p><\/th>/);
    assert.match(en.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(en.body, /<script>alert/);
    const csp = en.headers.get("content-security-policy")!;
    for (const style of meta(en.body, /<style>([\s\S]*?)<\/style>/g)) {
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(style),
      );
      assert(
        csp.includes(
          "sha256-" + btoa(String.fromCharCode(...new Uint8Array(hash))),
        ),
      );
    }
    assert.match(csp, /default-src 'none'/);
    assert.match(
      csp,
      /frame-src https:\/\/www.youtube-nocookie.com https:\/\/player.vimeo.com/,
    );
    assert.doesNotMatch(csp, /script-src/);
    // A yellow theme gets dark header text.
    assert.match(en.body, /--header-text:#111111/);

    // Spanish has no version: shown in English, with the English page as canonical and a notice.
    const es = await get("/help/a/acme/es/articles/reset-your-password");
    assert.equal(es.status, 200);
    assert.match(es.body, /<html lang="es"/);
    assert.deepEqual(meta(es.body, /<link rel="canonical" href="([^"]+)"/g), [
      OWN + pages.en,
    ]);
    assert.deepEqual(meta(es.body, /hrefLang="([^"]+)" href=/g), [
      "en",
      "fr",
      "de",
      "x-default",
    ]);
    assert.match(es.body, /Se muestra en inglés/);
    assert.match(es.body, /<article class="article" lang="en">/);
    assert.equal(es.headers.get("content-language"), "en");

    // The help center root picks the visitor's language.
    const root = await get("/help/a/acme", {
      "accept-language": "de-AT,de;q=0.9",
    });
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), "/help/a/acme/de");
    assert.equal(root.headers.get("vary"), "accept-language");
    // Home: collections with names per language (French has its own), the portal link.
    const home = await get("/help/a/acme/fr");
    assert.match(home.body, /Premiers pas/);
    assert.match(
      home.body,
      /href="\/help\/a\/acme\/fr\/collections\/premiers-pas"/,
    );
    assert.match(home.body, /href="\/portal\/a\/default">Vos demandes/);
    assert.deepEqual(meta(home.body, /hrefLang="([^"]+)" href=/g), [
      "en",
      "fr",
      "de",
      "es",
      "x-default",
    ]);

    // Slug changes and unsupported languages: 301.
    await knowledge({
      op: "slug",
      id: reset,
      locale: "en",
      slug: "password-reset",
    });
    const moved = await get("/help/a/acme/en/articles/reset-your-password");
    assert.equal(moved.status, 301);
    assert.equal(
      moved.headers.get("location"),
      "/help/a/acme/en/articles/password-reset",
    );
    assert.equal(
      (await get("/help/a/acme/en/articles/password-reset")).status,
      200,
    );
    const region = await get(
      "/help/a/acme/fr-BE/articles/reinitialiser-votre-mot-de-passe",
    );
    assert.equal(region.status, 301);
    assert.equal(
      region.headers.get("location"),
      "/help/a/acme/fr/articles/reinitialiser-votre-mot-de-passe",
    );

    // Internal links by id follow the target's current address, in the page's language.
    const linking = await article({ en: "Account basics" }, () =>
      doc({
        type: "paragraph",
        content: [
          { type: "text", text: "See " },
          {
            type: "text",
            text: "resetting",
            marks: [{ type: "articleLink", attrs: { recordId: reset } }],
          },
          { type: "text", text: " or " },
          {
            type: "text",
            text: "drafts",
            marks: [
              {
                type: "articleLink",
                attrs: { recordId: "00000000-0000-4000-8000-000000000000" },
              },
            ],
          },
        ],
      }),
    );
    await help({ op: "place", nodeId: start.id, recordId: linking });
    const basics = await get("/help/a/acme/fr/articles/account-basics");
    assert.match(
      basics.body,
      /<a href="\/help\/a\/acme\/fr\/articles\/reinitialiser-votre-mot-de-passe" class="rich-article-link">resetting<\/a>/,
    );
    assert.match(
      basics.body,
      /<span data-article-link="00000000-0000-4000-8000-000000000000">drafts<\/span>/,
    );

    // FAQ articles get FAQ structured data.
    const faq = await article(
      { en: "Billing questions" },
      () => doc(h2("Can I pay by card?"), p("Yes, all major cards.")),
      { faq: false },
    );
    const faqVersion = (
      await sql(
        "SELECT version::text AS v FROM knowledge_records WHERE id=$1",
        [faq],
      )
    )[0].v;
    await knowledge({
      op: "settings",
      id: faq,
      version: faqVersion,
      faq: true,
    });
    await help({ op: "place", nodeId: start.id, recordId: faq });
    const faqPage = await get("/help/a/acme/en/articles/billing-questions");
    const faqLd = JSON.parse(
      meta(
        faqPage.body,
        /<script type="application\/ld\+json">(.*?)<\/script>/g,
      )[0],
    );
    assert.deepEqual(
      faqLd["@graph"].find((x: any) => x["@type"] === "FAQPage").mainEntity,
      [
        {
          "@type": "Question",
          name: "Can I pay by card?",
          acceptedAnswer: { "@type": "Answer", text: "Yes, all major cards." },
        },
      ],
    );
    await assert.rejects(
      knowledge({
        op: "settings",
        id: (await knowledge({ op: "create", source: "snippet", title: "x" }))
          .id,
        version: "1",
        faq: true,
      }),
      /Only articles can be marked as FAQs/,
    );

    // Signed-in articles: a sign-in page without a session that names nothing; the page with one.
    const secret = await article(
      { en: "Enterprise SSO setup" },
      (t) => doc(p(t + " details")),
      {
        audience: "signed_in",
      },
    );
    await help({ op: "place", nodeId: start.id, recordId: secret });
    const anonymous = await get(
      "/help/a/acme/en/articles/enterprise-sso-setup",
    );
    assert.equal(anonymous.status, 401);
    assert.doesNotMatch(anonymous.body, /Enterprise|SSO/);
    assert.match(anonymous.body, /Sign in to continue/);
    assert.match(anonymous.body, /name="robots" content="noindex, nofollow"/);
    assert.equal(anonymous.headers.get("cache-control"), "private, no-store");
    assert.doesNotMatch(
      (await get("/help/a/acme/en/collections/getting-started")).body,
      /Enterprise/,
    );
    const identity = await run((q) =>
      getIdentity(q, "a", "anonymous", "help-site-visitor"),
    );
    const sessionId = crypto.randomUUID();
    await sql(
      "INSERT INTO portal_sessions(workspace_id,id,brand_id,identity_id,secret_hash,expires_at) VALUES('a',$1,'default',$2,$3,now()+interval '1 hour')",
      [sessionId, identity.identityId, await digest("s3cret")],
    );
    const cookie = { cookie: `${PORTAL_COOKIE}=${sessionId}.s3cret` };
    const signedIn = await get(
      "/help/a/acme/en/articles/enterprise-sso-setup",
      cookie,
    );
    assert.equal(signedIn.status, 200);
    assert.match(signedIn.body, /Enterprise SSO setup details/);
    assert.equal(signedIn.headers.get("cache-control"), "private, no-store");
    assert.match(signedIn.body, /name="robots" content="noindex, nofollow"/);
    assert.equal(signedIn.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.match(
      (await get("/help/a/acme/en/collections/getting-started", cookie)).body,
      /Enterprise/,
    );
    // A wrong secret is no session.
    assert.equal(
      (
        await get("/help/a/acme/en/articles/enterprise-sso-setup", {
          cookie: `${PORTAL_COOKIE}=${sessionId}.nope`,
        })
      ).status,
      401,
    );

    // The sitemap: public pages in each language with alternates; nothing signed-in.
    const map = await get("/help/a/acme/sitemap.xml");
    assert.equal(
      map.headers.get("content-type"),
      "application/xml; charset=utf-8",
    );
    assert.match(
      map.body,
      /<loc>https:\/\/relay.test\/help\/a\/acme\/de\/articles\/passwort-zurucksetzen<\/loc><lastmod>/,
    );
    assert.match(
      map.body,
      /hreflang="fr" href="https:\/\/relay.test\/help\/a\/acme\/fr\/articles\/reinitialiser-votre-mot-de-passe"/,
    );
    assert.doesNotMatch(map.body, /enterprise/);
    assert.doesNotMatch(
      map.body,
      /\/es\/articles\//,
      "only languages the article exists in",
    );

    // 404s: unknown article, archived collection, a path that isn't a language.
    const missing = await get("/help/a/acme/en/articles/nothing");
    assert.equal(missing.status, 404);
    assert.match(missing.body, /Page not found/);
    assert.equal(missing.headers.get("x-robots-tag"), "noindex, nofollow");
    await help({ op: "node_archive", id: start.id });
    assert.equal(
      (await get("/help/a/acme/en/articles/password-reset")).status,
      404,
    );
    assert.equal(
      (await get("/help/a/acme/en/collections/getting-started")).status,
      404,
    );
    await help({ op: "node_restore", id: start.id });
    assert.equal((await get("/help/a/acme/portal/x")).status, 404);
    assert.equal(
      (await get("/help/a/acme/en/articles/password-reset", {}, OWN, "POST"))
        .status,
      405,
    );

    // ETag and 304; HEAD has no body.
    const first = await get(pages.de);
    const tag = first.headers.get("etag")!;
    assert.match(tag, /^"[A-Za-z0-9+/]+"$/);
    const again = await get(pages.de, { "if-none-match": tag });
    assert.equal(again.status, 304);
    assert.equal(again.body, "");
    const head = await get(pages.de, {}, OWN, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body, "");

    // Hidden from search engines: noindex everywhere, no alternates or JSON-LD, empty sitemap.
    const settings = async (data: Record<string, unknown>) => {
      const version = (
        await sql("SELECT version::text AS v FROM help_centers WHERE id=$1", [
          centerId,
        ])
      )[0].v;
      return help({ op: "center_settings", id: centerId, version, ...data });
    };
    await settings({ noindex: true });
    const hidden = await get(
      pages.en.replace("reset-your-password", "password-reset"),
    );
    assert.equal(hidden.status, 200);
    assert.match(hidden.body, /name="robots" content="noindex, nofollow"/);
    assert.doesNotMatch(hidden.body, /rel="alternate"|application\/ld\+json/);
    assert.doesNotMatch((await get("/help/a/acme/sitemap.xml")).body, /<url>/);
    await settings({ noindex: false });

    // Signed-in customers only: every page asks to sign in; the sitemap is empty.
    await settings({ access: "signed_in" });
    const closed = await get("/help/a/acme/en");
    assert.equal(closed.status, 401);
    assert.doesNotMatch(closed.body, /Getting started/);
    assert.equal((await get("/help/a/acme/en", cookie)).status, 200);
    assert.doesNotMatch((await get("/help/a/acme/sitemap.xml")).body, /<url>/);
    await settings({ access: "public" });

    // A custom domain: the brand's help center at the root, the portal untouched.
    await sql(
      "INSERT INTO portal_domains(host,workspace_id,brand_id) VALUES('help.acme.test','a','default')",
    );
    const CUSTOM = "https://help.acme.test";
    const custom = await get("/en/articles/password-reset", {}, CUSTOM);
    assert.equal(custom.status, 200);
    assert.deepEqual(
      meta(custom.body, /<link rel="canonical" href="([^"]+)"/g),
      [CUSTOM + "/en/articles/password-reset"],
    );
    assert.match(custom.body, /href="\/portal">Your requests/);
    assert.equal(
      (await get("/en/articles/reset-your-password", {}, CUSTOM)).headers.get(
        "location",
      ),
      "/en/articles/password-reset",
    );
    assert.equal(
      (await get("/", { "accept-language": "fr" }, CUSTOM)).headers.get(
        "location",
      ),
      "/fr",
    );
    const robots = await get("/robots.txt", {}, CUSTOM);
    assert.match(robots.body, /Sitemap: https:\/\/help.acme.test\/sitemap.xml/);
    assert.match(
      (await get("/sitemap.xml", {}, CUSTOM)).body,
      /<loc>https:\/\/help.acme.test\/en\/articles\/password-reset<\/loc>/,
    );
    passed.length = 0;
    assert.equal((await get("/portal", {}, CUSTOM)).status, 299);
    assert.equal((await get("/v1/portal/context", {}, CUSTOM)).status, 299);
    assert.deepEqual(passed, ["/portal", "/v1/portal/context"]);
    // Another workspace's help center can't be reached through this domain.
    assert.equal((await get("/help/b/acme/en", {}, CUSTOM)).status, 404);

    // The portal, as a section: the help center's colour and a link back.
    const context = await run((q) =>
      portalContext(q, { workspace: "a", brand: "default" }, null),
    );
    assert.equal(context.brand.color, "#ffd400");
    assert.deepEqual(context.helpCenter, { slug: "acme" });

    // Isolation: workspace b has none of it, under any slug.
    await sql(
      "UPDATE workspace_features SET enabled=true WHERE name='help_center_v1'",
      [],
      "b",
    );
    assert.equal((await get("/help/b/acme/en")).status, 404);
    assert.equal(
      (await get("/help/b/acme/en/articles/password-reset")).status,
      404,
    );
    assert.equal((await get("/help/a%2Fb/acme/en")).status, 404);
  } finally {
    await db.close();
  }
});
