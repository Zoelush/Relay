import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { resolvePath } from "../server/help-centers";
import { resolveLocale, slugify } from "../lib/help-paths";

test("slugs: accents, special letters, punctuation, length and scripts without Latin letters", () => {
  assert.equal(
    slugify("Réinitialiser votre mot de passe"),
    "reinitialiser-votre-mot-de-passe",
  );
  assert.equal(slugify("Straße & Größe"), "strasse-and-grosse");
  assert.equal(slugify("Ærø, Łódź — Œuvre!"), "aero-lodz-oeuvre");
  assert.equal(slugify("  --Hello__World 2.0--  "), "hello-world-2-0");
  assert.equal(slugify("كيف أعيد تعيين كلمة المرور"), "");
  const long = slugify("word ".repeat(40));
  assert(
    long.length <= 80 && !long.endsWith("-") && long.startsWith("word-word"),
  );
  assert.equal(slugify("a".repeat(100)).length, 80);
});

test("language fallback: requested, its supported bases, then the default", () => {
  const center = { defaultLocale: "en", locales: ["en", "fr", "fr-CA", "de"] };
  assert.deepEqual(resolveLocale("fr-CA", center), {
    locale: "fr-CA",
    chain: ["fr-CA", "fr", "en"],
  });
  assert.deepEqual(resolveLocale("fr-ca", center).locale, "fr-CA");
  // Unsupported region: the nearest supported base.
  assert.deepEqual(resolveLocale("fr-BE", center), {
    locale: "fr",
    chain: ["fr", "en"],
  });
  assert.deepEqual(resolveLocale("de-AT", center), {
    locale: "de",
    chain: ["de", "en"],
  });
  // Unsupported language or nonsense: the default.
  assert.deepEqual(resolveLocale("ja", center), {
    locale: "en",
    chain: ["en"],
  });
  assert.deepEqual(resolveLocale("??", center), {
    locale: "en",
    chain: ["en"],
  });
  // A supported region whose base is not supported falls straight back to the default.
  assert.deepEqual(
    resolveLocale("pt-BR", { defaultLocale: "en", locales: ["en", "pt-BR"] }),
    { locale: "pt-BR", chain: ["pt-BR", "en"] },
  );
});

test("help centers: one per brand, collections and optional sections, placements, slugs with redirects, language fallback and isolation", async () => {
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
  const help = (data: Record<string, unknown>, principal = "owner-a") =>
    agent("help-centers", data, principal);
  const knowledge = (data: Record<string, unknown>) => agent("knowledge", data);
  const resolve = (path: string, w = "a") =>
    tenant(db.connect, w, (q) => resolvePath(q, w, path));
  const doc = (text: string) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  /** A published article in the given languages (the first one creates it). */
  async function article(titles: Record<string, string>, settings = {}) {
    const [first, ...others] = Object.entries(titles);
    const { id } = (
      await knowledge({
        op: "create",
        source: "article",
        locale: first[0],
        title: first[1],
        body: doc(first[1]),
        forHelpCenter: true,
        ...settings,
      })
    ).body;
    for (const [locale, title] of [first, ...others]) {
      if (locale !== first[0])
        await knowledge({ op: "add_locale", id, locale, fromLocale: first[0] });
      const v = (await agent("knowledge-record?id=" + id)).body.locales.find(
        (l: any) => l.locale === locale,
      ).draft.version;
      const saved = await knowledge({
        op: "save",
        id,
        locale,
        title,
        body: doc(title),
        draftVersion: v,
      });
      const r = await knowledge({
        op: "publish",
        id,
        locale,
        draftVersion: saved.body.draftVersion,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    return id as string;
  }
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
    assert.equal(code(await agent("help-centers")), "KNOWLEDGE_DISABLED");
    for (const w of ["a", "b"])
      await sql(
        "UPDATE workspace_features SET enabled=true WHERE name='knowledge_v1'",
        [],
        w,
      );
    assert.equal((await agent("help-centers", undefined, "ada-a")).status, 403);
    assert.equal(
      (
        await help(
          { op: "center_create", brandId: "default", name: "x" },
          "ada-a",
        )
      ).status,
      403,
    );

    // One help center per brand; languages canonicalised, the default always included.
    const created = await help({
      op: "center_create",
      brandId: "default",
      name: "Acme Help",
      defaultLocale: "en",
      locales: ["fr", "fr-ca", "de"],
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const centerId = created.body.id;
    assert.equal(created.body.slug, "acme-help");
    assert.equal(
      code(
        await help({ op: "center_create", brandId: "default", name: "Again" }),
      ),
      "HELP_CENTER_EXISTS",
    );
    assert.equal(
      code(await help({ op: "center_create", brandId: "nope", name: "x" })),
      "INVALID_HELP_CENTER",
    );
    let center = (await agent("help-center?id=" + centerId)).body.center;
    assert.deepEqual(center.locales, ["en", "fr", "fr-CA", "de"]);
    assert.deepEqual(center.layout, [
      { type: "search" },
      { type: "collections" },
      { type: "contact" },
    ]);
    const brands = (await agent("help-centers")).body.brands;
    assert.equal(
      brands.find((b: any) => b.id === "default").centerId,
      centerId,
    );

    // Settings: version conflicts, theme and layout validation, the default must be a language.
    const settings = (data: Record<string, unknown>) =>
      help({ op: "center_settings", id: centerId, ...data });
    assert.equal(
      code(await settings({ version: "99", name: "x" })),
      "HELP_CENTER_CONFLICT",
    );
    assert.equal(
      code(
        await settings({
          version: center.version,
          theme: { primaryColor: "red" },
        }),
      ),
      "INVALID_HELP_CENTER",
    );
    assert.equal(
      code(
        await settings({
          version: center.version,
          layout: [{ type: "search" }, { type: "search" }],
        }),
      ),
      "INVALID_HELP_CENTER",
    );
    assert.equal(
      code(await settings({ version: center.version, defaultLocale: "es" })),
      "INVALID_HELP_CENTER",
    );
    const themed = await settings({
      version: center.version,
      theme: { primaryColor: "#AA3300", headerStyle: "light" },
      noindex: true,
    });
    assert.equal(themed.status, 200, JSON.stringify(themed.body));
    center = (await agent("help-center?id=" + centerId)).body.center;
    assert.deepEqual(center.theme, {
      primaryColor: "#aa3300",
      headerStyle: "light",
      font: "system",
    });
    assert.equal(center.noindex, true);

    // Collections and sections, with a fixed depth of two.
    const node = async (data: Record<string, unknown>) => {
      const r = await help({
        op: "node_create",
        centerId,
        locale: "en",
        ...data,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body as { id: string; slug: string };
    };
    const start = await node({ name: "Getting started" });
    const billing = await node({ name: "Billing" });
    const accounts = await node({ name: "Accounts", parentId: start.id });
    assert.equal(start.slug, "getting-started");
    // The same name in the same language gets the next free slug.
    const again = await node({ name: "Getting started" });
    assert.equal(again.slug, "getting-started-2");
    assert.equal(
      code(
        await help({
          op: "node_create",
          centerId,
          locale: "en",
          name: "Deep",
          parentId: accounts.id,
        }),
      ),
      "INVALID_HELP_CENTER",
      "no sections inside sections",
    );
    assert.equal(
      code(
        await help({ op: "node_create", centerId, locale: "es", name: "Hola" }),
      ),
      "INVALID_HELP_CENTER",
      "only the help center's languages",
    );

    // Placement: only public articles with the help center switch on.
    const reset = await article({
      en: "Reset your password",
      fr: "Réinitialiser votre mot de passe",
    });
    const switchedOff = await article(
      { en: "Draft policy" },
      { forHelpCenter: false },
    );
    const internal = (
      await knowledge({
        op: "create",
        source: "internal_article",
        title: "Refunds",
      })
    ).body.id;
    const snippet = (
      await knowledge({ op: "create", source: "snippet", title: "Greeting" })
    ).body.id;
    const place = (nodeId: string, recordId: string) =>
      help({ op: "place", nodeId, recordId });
    const refused = async (recordId: string, message: RegExp) => {
      const r = await place(accounts.id, recordId);
      assert.equal(r.status, 409);
      assert.equal(code(r), "HELP_NOT_PLACEABLE");
      assert.match(r.body.error.message, message);
    };
    await refused(internal, /Internal articles are for teammates only/);
    await refused(snippet, /Only articles/);
    await refused(switchedOff, /Turn on "Show in the help center"/);
    assert.equal((await place(accounts.id, reset)).status, 200);
    // In several places at once, and placing twice changes nothing.
    assert.equal((await place(billing.id, reset)).status, 200);
    assert.equal((await place(billing.id, reset)).status, 200);
    // Articles can sit directly in a collection.
    const pricing = await article({ en: "Pricing" });
    assert.equal((await place(billing.id, pricing)).status, 200);
    assert.deepEqual(
      (
        await sql(
          "SELECT node_id FROM help_placements WHERE record_id=$1 ORDER BY node_id",
          [reset],
        )
      ).length,
      2,
    );

    // Slugs come from the published title on first publish.
    const slugs = await sql(
      "SELECT locale,slug FROM knowledge_locales WHERE record_id=$1 ORDER BY locale",
      [reset],
    );
    assert.deepEqual(slugs, [
      { locale: "en", slug: "reset-your-password" },
      { locale: "fr", slug: "reinitialiser-votre-mot-de-passe" },
    ]);

    // Resolving public paths.
    assert.deepEqual(
      await resolve("acme-help/en/articles/reset-your-password"),
      {
        type: "article",
        centerId,
        id: reset,
        locale: "en",
        contentLocale: "en",
        chain: ["en"],
        canonical: "acme-help/en/articles/reset-your-password",
        audience: "public",
      },
    );
    assert.deepEqual(await resolve("acme-help"), {
      type: "redirect",
      path: "acme-help/en",
    });
    assert.deepEqual((await resolve("acme-help/en")).type, "home");
    // Another language's slug goes to this language's own slug.
    assert.deepEqual(
      await resolve("acme-help/fr/articles/reset-your-password"),
      {
        type: "redirect",
        path: "acme-help/fr/articles/reinitialiser-votre-mot-de-passe",
      },
    );
    // fr-CA has no version: shown in French (the fallback) with the French page as canonical.
    const canadian = await resolve(
      "acme-help/fr-CA/articles/reinitialiser-votre-mot-de-passe",
    );
    assert.equal(canadian.type, "article");
    assert.deepEqual(
      canadian.type === "article" && [
        canadian.contentLocale,
        canadian.chain,
        canadian.canonical,
      ],
      [
        "fr",
        ["fr-CA", "fr", "en"],
        "acme-help/fr/articles/reinitialiser-votre-mot-de-passe",
      ],
    );
    // German has none either: English.
    const german = await resolve("acme-help/de/articles/reset-your-password");
    assert.deepEqual(german.type === "article" && german.contentLocale, "en");
    // An unsupported language goes to the nearest supported one.
    assert.deepEqual(await resolve("acme-help/fr-BE/articles/x"), {
      type: "redirect",
      path: "acme-help/fr/articles/x",
    });
    assert.deepEqual(await resolve("acme-help/en/articles/nothing-here"), {
      type: "not_found",
    });
    assert.deepEqual(await resolve("acme-help/en/articles/a/b"), {
      type: "not_found",
    });
    assert.deepEqual(await resolve("acme-help/en/widgets/x"), {
      type: "not_found",
    });

    // Renaming an article's slug, twice: both old slugs redirect, and renaming back never loops.
    const rename = (slug: string, locale = "en") =>
      knowledge({ op: "slug", id: reset, locale, slug });
    assert.equal(code(await rename("Bad Slug")), "INVALID_KNOWLEDGE");
    assert.equal(code(await rename("pricing")), "SLUG_TAKEN");
    assert.equal((await rename("password-reset")).status, 200);
    assert.equal((await rename("forgot-password")).status, 200);
    for (const old of ["reset-your-password", "password-reset"])
      assert.deepEqual(await resolve("acme-help/en/articles/" + old), {
        type: "redirect",
        path: "acme-help/en/articles/forgot-password",
      });
    assert.equal((await rename("reset-your-password")).status, 200);
    assert.equal(
      (await resolve("acme-help/en/articles/reset-your-password")).type,
      "article",
      "the live slug wins over its old redirect",
    );
    assert.deepEqual(await resolve("acme-help/en/articles/forgot-password"), {
      type: "redirect",
      path: "acme-help/en/articles/reset-your-password",
    });
    // A redirect slug can be claimed by another article; then it is that article's page.
    const forgot = await article({ en: "Forgot password" });
    await place(accounts.id, forgot);
    assert.deepEqual(
      (await resolve("acme-help/en/articles/forgot-password")).type,
      "article",
    );
    assert.equal(
      ((await resolve("acme-help/en/articles/forgot-password")) as any).id,
      forgot,
    );
    // Snippets and internal articles have no public address.
    assert.equal(
      code(
        await knowledge({
          op: "slug",
          id: snippet,
          locale: "en",
          slug: "greeting",
        }),
      ),
      "INVALID_KNOWLEDGE",
    );

    // Visibility: unplaced, switched off, unpublished, or in an archived collection: not found.
    const visible = async () =>
      (await resolve("acme-help/en/articles/reset-your-password")).type;
    const record = (await agent("knowledge-record?id=" + reset)).body;
    await knowledge({
      op: "settings",
      id: reset,
      version: record.version,
      forHelpCenter: false,
    });
    assert.equal(await visible(), "not_found");
    let tree = (await agent("help-center?id=" + centerId)).body;
    assert.match(
      tree.nodes.find((n: any) => n.id === accounts.id).articles[0].hidden,
      /switch off/,
    );
    // Turning it back on restores it: placements are kept.
    await knowledge({
      op: "settings",
      id: reset,
      version: String(Number(record.version) + 1),
      forHelpCenter: true,
    });
    assert.equal(await visible(), "article");
    await help({ op: "node_archive", id: start.id });
    await help({ op: "unplace", nodeId: billing.id, recordId: reset });
    assert.equal(
      await visible(),
      "not_found",
      "its section's collection is archived",
    );
    await help({ op: "node_restore", id: start.id });
    assert.equal(await visible(), "article");

    // Collections and sections: names per language, slug edits redirect, fallback names.
    const rename2 = await help({
      op: "node_update",
      id: start.id,
      version: (
        await sql("SELECT version::text AS v FROM help_nodes WHERE id=$1", [
          start.id,
        ])
      )[0].v,
      locale: "en",
      slug: "first-steps",
    });
    assert.equal(rename2.status, 200, JSON.stringify(rename2.body));
    assert.deepEqual(
      await resolve("acme-help/en/collections/getting-started"),
      {
        type: "redirect",
        path: "acme-help/en/collections/first-steps",
      },
    );
    assert.equal(
      code(
        await help({
          op: "node_update",
          id: billing.id,
          version: (
            await sql("SELECT version::text AS v FROM help_nodes WHERE id=$1", [
              billing.id,
            ])
          )[0].v,
          locale: "en",
          slug: "first-steps",
        }),
      ),
      "SLUG_TAKEN",
    );
    assert.equal(
      code(
        await help({
          op: "node_update",
          id: start.id,
          version: "1",
          locale: "en",
          name: "x",
        }),
      ),
      "HELP_CENTER_CONFLICT",
    );
    // No French name yet: the English one is shown, under the French path.
    const fr = await resolve("acme-help/fr/collections/first-steps");
    assert.deepEqual(
      fr.type === "collection" && [fr.contentLocale, fr.canonical],
      ["en", "acme-help/en/collections/first-steps"],
    );
    const named = await help({
      op: "node_update",
      id: start.id,
      version: (
        await sql("SELECT version::text AS v FROM help_nodes WHERE id=$1", [
          start.id,
        ])
      )[0].v,
      locale: "fr",
      name: "Premiers pas",
    });
    assert.equal(named.body.slug, "premiers-pas");
    assert.deepEqual(await resolve("acme-help/fr/collections/first-steps"), {
      type: "redirect",
      path: "acme-help/fr/collections/premiers-pas",
    });
    assert.equal(
      (await resolve("acme-help/en/sections/accounts")).type,
      "section",
    );

    // The help center's own slug.
    center = (await agent("help-center?id=" + centerId)).body.center;
    assert.equal(
      (await settings({ version: center.version, slug: "support" })).status,
      200,
    );
    assert.deepEqual(
      await resolve("acme-help/en/articles/reset-your-password"),
      {
        type: "redirect",
        path: "support/en/articles/reset-your-password",
      },
    );

    // Arranging: the order must name exactly the current members.
    const order = [billing.id, again.id, start.id];
    assert.equal(
      code(
        await help({
          op: "arrange",
          kind: "collections",
          centerId,
          order: order.slice(1),
        }),
      ),
      "HELP_CENTER_CONFLICT",
    );
    assert.equal(
      (await help({ op: "arrange", kind: "collections", centerId, order }))
        .status,
      200,
    );
    tree = (await agent("help-center?id=" + centerId)).body;
    assert.deepEqual(
      tree.nodes
        .filter((n: any) => n.kind === "collection")
        .map((n: any) => n.id),
      order,
    );
    assert.equal(
      (
        await help({
          op: "arrange",
          kind: "articles",
          nodeId: accounts.id,
          order: [forgot, reset],
        })
      ).status,
      200,
    );
    tree = (await agent("help-center?id=" + centerId)).body;
    assert.deepEqual(
      tree.nodes
        .find((n: any) => n.id === accounts.id)
        .articles.map((a: any) => a.id),
      [forgot, reset],
    );
    assert(
      tree.redirects.some(
        (r: any) => r.kind === "article" && r.slug === "forgot-password",
      ) === false,
      "a claimed redirect slug is gone",
    );
    assert(
      tree.redirects.some(
        (r: any) => r.kind === "collection" && r.slug === "getting-started",
      ),
    );

    // Featured articles must be placeable.
    assert.equal(
      code(
        await settings({
          version: (await agent("help-center?id=" + centerId)).body.center
            .version,
          layout: [{ type: "featured", recordIds: [internal] }],
        }),
      ),
      "HELP_NOT_PLACEABLE",
    );

    // A retried create returns the first result.
    const retry = {
      op: "node_create",
      centerId,
      locale: "en",
      name: "Retried",
    };
    const one = await agent(
      "help-centers",
      retry,
      "owner-a",
      "a",
      "retry-node-1",
    );
    const two = await agent(
      "help-centers",
      retry,
      "owner-a",
      "a",
      "retry-node-1",
    );
    assert.equal(one.body.id, two.body.id);

    // Other workspaces see none of it.
    assert.deepEqual(
      (await agent("help-centers", undefined, "owner-b", "b")).body.centers,
      [],
    );
    assert.equal(
      (await agent("help-center?id=" + centerId, undefined, "owner-b", "b"))
        .status,
      404,
    );
    assert.equal(
      (
        await agent(
          "help-centers",
          { op: "place", nodeId: accounts.id, recordId: reset },
          "owner-b",
          "b",
        )
      ).status,
      404,
    );
    assert.deepEqual(
      await resolve("support/en/articles/reset-your-password", "b"),
      {
        type: "not_found",
      },
    );
  } finally {
    await db.close();
  }
});
