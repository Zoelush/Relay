import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { testDatabase } from "./database";
import { digest, tenant, type Sql } from "../server/db";
import { seedFoundation } from "../server/people";
import { changeKnowledge, readKnowledge } from "../server/knowledge";
import { changeHelpCenter } from "../server/help-centers";
import { handleApi, type ApiEnvironment } from "../server/api";
import { identityIssuer } from "../server/identity";
import { helpSite } from "../server/help-site";
import { PORTAL_COOKIE } from "../server/portal";
import {
  helpInsights,
  issueReceipt,
  normalize,
  purgeHelpSearches,
  redactQuery,
  searchConfig,
  searchHelp,
  verifyReceipt,
} from "../server/help-search";

const RELAY = "https://relay.test";
const identitySecret = new TextEncoder().encode("i".repeat(32));
const doc = (...paragraphs: string[]) => ({
  type: "doc",
  content: paragraphs.map((text) => ({
    type: "paragraph",
    content: [{ type: "text", text }],
  })),
});

test("normalising, redaction, language configurations and signed receipts", async () => {
  assert.equal(normalize("  Réinitialiser   ÉTÉ  "), "reinitialiser ete");
  assert.equal(
    redactQuery("refund for jo.doe+x@example.com order 4111 1111 1111 1111"),
    "refund for [email] order [number]",
  );
  assert.equal(
    redactQuery("call +44 (0) 20 7946 0958 now"),
    "call [number] now",
  );
  assert.equal(
    redactQuery("plan 2024 or 12345"),
    "plan 2024 or 12345",
    "short numbers stay",
  );
  assert.equal(redactQuery("x".repeat(300)).length, 200);
  assert.equal(searchConfig("fr-CA"), "french");
  assert.equal(searchConfig("pt-BR"), "portuguese");
  assert.equal(searchConfig("ja"), "simple");

  const scope = { workspace: "a", brand: "default", identity: "id-1" };
  const now = Date.now();
  const receipt = await issueReceipt(
    "secret".repeat(8),
    { ...scope, query: "reset jo@example.com" },
    now,
  );
  assert.equal(
    await verifyReceipt("secret".repeat(8), receipt, scope, now),
    "reset [email]",
  );
  assert.equal(
    await verifyReceipt(
      "secret".repeat(8),
      receipt,
      { ...scope, identity: "id-2" },
      now,
    ),
    null,
  );
  assert.equal(
    await verifyReceipt(
      "secret".repeat(8),
      receipt,
      { ...scope, brand: "other" },
      now,
    ),
    null,
  );
  assert.equal(
    await verifyReceipt(
      "secret".repeat(8),
      receipt,
      { ...scope, workspace: "b" },
      now,
    ),
    null,
  );
  assert.equal(
    await verifyReceipt("other".repeat(8), receipt, scope, now),
    null,
    "another key",
  );
  assert.equal(
    await verifyReceipt("secret".repeat(8), receipt, scope, now + 31 * 60_000),
    null,
    "expired",
  );
  const [body, signature] = receipt.split(".");
  const forged = btoa(
    atob(body.replace(/-/g, "+").replace(/_/g, "/")).replace("id-1", "id-2"),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(
    await verifyReceipt(
      "secret".repeat(8),
      `${forged}.${signature}`,
      { ...scope, identity: "id-2" },
      now,
    ),
    null,
  );
  assert.equal(
    await verifyReceipt("secret".repeat(8), "nonsense", scope, now),
    null,
  );
  assert.equal(await verifyReceipt("secret".repeat(8), 42, scope, now), null);
});

test("help center search, the query log and feedback, in the help center and the messenger", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    storageTransport: "local-pglite",
  };
  const run = <T>(fn: (q: Sql) => Promise<T>, w = "a") =>
    tenant(db.connect, w, fn);
  const sql = <T = any>(query: string, values: unknown[] = [], w = "a") =>
    run(async (q) => (await q.query<T>(query, values)).rows, w);
  const knowledge = (data: Record<string, unknown>) =>
    run((q) => changeKnowledge(q, "a", "owner-a", data)) as Promise<any>;
  const help = (data: Record<string, unknown>) =>
    run((q) => changeHelpCenter(q, "a", "owner-a", data)) as Promise<any>;
  async function article(
    versions: Record<string, [string, string]>,
    settings: Record<string, unknown> = {},
  ) {
    const [[first, [title, text]], ...others] = Object.entries(versions);
    const { id } = await knowledge({
      op: "create",
      source: "article",
      locale: first,
      title,
      body: doc(text),
      forHelpCenter: true,
      ...settings,
    });
    await knowledge({ op: "publish", id, locale: first, draftVersion: "1" });
    for (const [locale, [t, x]] of others) {
      await knowledge({ op: "add_locale", id, locale, fromLocale: first });
      await knowledge({
        op: "save",
        id,
        locale,
        title: t,
        body: doc(x),
        draftVersion: "1",
      });
      await knowledge({ op: "publish", id, locale, draftVersion: "2" });
    }
    return id as string;
  }
  const site = async (path: string, init: RequestInit = {}) => {
    const r = await helpSite(
      new Request(RELAY + path, init),
      db.connect,
      RELAY,
      async () => new Response("static", { status: 299 }),
    );
    return { status: r.status, headers: r.headers, body: await r.text() };
  };
  try {
    for (const w of ["a", "b"])
      await run(
        (q) =>
          seedFoundation(q, w, "owner-" + w, {
            origins: ["https://shop.test"],
            master: env.identityMaster,
            identitySecret,
            enable: true,
          }),
        w,
      );
    await sql(
      "UPDATE workspace_features SET enabled=true WHERE name IN ('knowledge_v1','help_center_v1','portal_v1')",
    );
    const { id: centerId } = await help({
      op: "center_create",
      brandId: "default",
      name: "Acme Help",
      slug: "acme",
      defaultLocale: "en",
      locales: ["en", "fr", "de"],
    });
    const accounts = await help({
      op: "node_create",
      centerId,
      locale: "en",
      name: "Accounts",
    });
    const billing = await help({
      op: "node_create",
      centerId,
      locale: "en",
      name: "Billing",
    });

    const reset = await article({
      en: [
        "Reset your password",
        "Use the link on the sign-in page to choose a new password.",
      ],
      fr: [
        "Réinitialiser votre mot de passe",
        "Utilisez le lien de la page de connexion.",
      ],
    });
    const twoFactor = await article({
      en: [
        "Two-factor sign-in",
        "If you lose your phone, you can reset the password with a backup code.",
      ],
    });
    const refunds = await article({
      en: ["Refunds", "Refunds take five working days to reach your card."],
      de: ["Rückerstattungen", "Rückerstattungen dauern fünf Werktage."],
    });
    const sso = await article(
      {
        en: [
          "Single sign-on for teams",
          "Set up SAML for your password policy.",
        ],
      },
      {
        audience: "signed_in",
      },
    );
    const unplaced = await article({
      en: ["Password history", "Old password rules."],
    });
    const switchedOff = await article(
      { en: ["Password expiry", "Passwords never expire."] },
      {
        forHelpCenter: false,
      },
    );
    for (const [node, id] of [
      [accounts.id, reset],
      [accounts.id, twoFactor],
      [accounts.id, sso],
      [billing.id, refunds],
      [billing.id, switchedOff],
    ])
      await sql(
        "INSERT INTO help_placements(workspace_id,node_id,record_id) VALUES('a',$1,$2) ON CONFLICT DO NOTHING",
        [node, id],
      );
    const search = (q: string, chain = ["en"], signedIn = false) =>
      run((x) => searchHelp(x, "a", centerId, chain, q, signedIn)).then((r) =>
        r.map((h) => h.title),
      );

    // Ranking: a title match before a text match.
    assert.deepEqual(await search("password"), [
      "Reset your password",
      "Two-factor sign-in",
    ]);
    // Typos, stemming and accents.
    assert.deepEqual(await search("pasword"), [
      "Reset your password",
      "Two-factor sign-in",
    ]);
    assert.deepEqual((await search("resetting"))[0], "Reset your password");
    assert.deepEqual(await search("refnds"), ["Refunds"]);
    assert.deepEqual(await search("reinitialiser", ["fr", "en"]), [
      "Réinitialiser votre mot de passe",
    ]);
    assert.deepEqual(await search("Rückerstattung", ["de", "en"]), [
      "Rückerstattungen",
    ]);
    // One result per article, in the first language along the chain.
    assert.deepEqual(await search("password", ["fr", "en"]), [
      "Réinitialiser votre mot de passe",
      "Two-factor sign-in",
    ]);
    // Not placed, switched off, or for signed-in customers only: not found (the last unless signed in).
    assert.deepEqual(await search("password history"), [
      "Reset your password",
      "Two-factor sign-in",
    ]);
    assert(!(await search("expire")).length);
    assert(!(await search("SAML")).length);
    assert.deepEqual(await search("SAML", ["en"], true), [
      "Single sign-on for teams",
    ]);
    // Personal details are not searched for; nothing but details finds nothing.
    assert.deepEqual(await search("jo@example.com 4111111111111111"), []);
    // Unpublishing removes it from search; publishing again brings it back.
    await knowledge({ op: "unpublish", id: refunds, locale: "en" });
    assert.deepEqual(await search("refunds"), []);
    assert.deepEqual(
      await search("Rückerstattung", ["de", "en"]),
      ["Rückerstattungen"],
      "German is still live",
    );
    await knowledge({
      op: "publish",
      id: refunds,
      locale: "en",
      draftVersion: "1",
    });
    assert.deepEqual(await search("refunds"), ["Refunds"]);
    // An archived collection hides its articles from search too.
    await help({ op: "node_archive", id: billing.id });
    assert.deepEqual(await search("refunds"), []);
    await help({ op: "node_restore", id: billing.id });
    void unplaced;

    // The public search page: results, logged without personal details, never cached.
    const page = await site(
      "/help/a/acme/en/search?q=" +
        encodeURIComponent("pasword jo@example.com"),
    );
    assert.equal(page.status, 200);
    assert.match(page.body, /2 results for “pasword jo@example.com”/);
    assert.equal(page.headers.get("cache-control"), "private, no-store");
    assert.match(page.body, /name="robots" content="noindex, nofollow"/);
    assert.match(
      page.headers.get("content-security-policy")!,
      /form-action 'self'/,
    );
    // Switching language keeps the search; search pages have no hreflang (they are noindex).
    assert.match(
      page.body,
      /href="\/help\/a\/acme\/fr\/search\?q=pasword%20jo%40example.com" hrefLang="fr"/,
    );
    assert.doesNotMatch(page.body, /rel="alternate"/);
    const [logged] = await sql(
      "SELECT id,query,results,surface,locale FROM help_search_queries",
    );
    assert.deepEqual(
      { ...logged, id: undefined },
      {
        id: undefined,
        query: "pasword [email]",
        results: 2,
        surface: "help_center",
        locale: "en",
      },
    );
    const open = page.body
      .match(/href="(\/help\/a\/acme\/en\/search\/open\?r=[^"]+)"/)![1]
      .replace(/&amp;/g, "&");
    const opened = await site(open);
    assert.equal(opened.status, 302);
    assert.equal(
      opened.headers.get("location"),
      "/help/a/acme/en/articles/reset-your-password",
    );
    assert.equal(
      (await sql("SELECT opened_record_id FROM help_search_queries"))[0]
        .opened_record_id,
      reset,
    );
    await site("/help/a/acme/en/search?q=invoice+address");
    await site("/help/a/acme/en/search?q=Invoice%20address");
    const none = await site("/help/a/acme/en/search?q=invoice+address");
    assert.match(none.body, /No results for “invoice address”/);
    // The home page has the search box (the homepage "search" block), and so does every header.
    assert.match(
      (await site("/help/a/acme/en")).body,
      /<form role="search" class="search" action="\/help\/a\/acme\/en\/search" method="get">/,
    );
    assert.equal(
      (await site("/help/a/acme/fr-BE/search?q=x")).headers.get("location"),
      "/help/a/acme/fr/search?q=x",
    );

    // Feedback on the public article: a vote, then the comment after a "No".
    const articlePath = "/help/a/acme/en/articles/reset-your-password";
    const post = (
      body: Record<string, string>,
      headers: Record<string, string> = {},
    ) =>
      site(articlePath + "/feedback", {
        method: "POST",
        headers: {
          origin: RELAY,
          "content-type": "application/x-www-form-urlencoded",
          ...headers,
        },
        body: new URLSearchParams(body).toString(),
      });
    const yes = await post({ helpful: "yes" });
    assert.equal(yes.status, 303);
    assert.equal(
      yes.headers.get("location"),
      articlePath + "?feedback=thanks#feedback",
    );
    const no = await post({ helpful: "no" });
    const feedbackId = no.headers
      .get("location")!
      .match(/feedback=([0-9a-f-]{36})/)![1];
    const commentPage = await site(articlePath + "?feedback=" + feedbackId);
    assert.match(commentPage.body, /<textarea name="comment"/);
    assert.equal(commentPage.headers.get("cache-control"), "private, no-store");
    const sent = await post({
      feedback: feedbackId,
      comment: "Where is the sign-in page?",
      action: "send",
    });
    assert.equal(
      sent.headers.get("location"),
      articlePath + "?feedback=thanks#feedback",
    );
    // A comment can't be changed or added to a "Yes".
    await post({ feedback: feedbackId, comment: "Changed", action: "send" });
    assert.deepEqual(
      (
        await sql(
          "SELECT helpful,comment FROM knowledge_feedback ORDER BY created_at",
        )
      ).map((r) => [r.helpful, r.comment]),
      [
        [true, null],
        [false, "Where is the sign-in page?"],
      ],
    );
    // "Talk to us" without a session: told how to reach the team.
    const anonymousNo = await post({ helpful: "no" });
    const anonymousId = anonymousNo.headers
      .get("location")!
      .match(/feedback=([0-9a-f-]{36})/)![1];
    const anonymousTalk = await post({
      feedback: anonymousId,
      comment: "",
      action: "talk",
    });
    assert.equal(
      anonymousTalk.headers.get("location"),
      articlePath + "?feedback=talk#feedback",
    );
    assert.match(
      (await site(articlePath + "?feedback=talk")).body,
      /To talk to us, open the chat/,
    );
    // Cross-site posts are refused.
    assert.equal(
      (await post({ helpful: "yes" }, { origin: "https://evil.test" })).status,
      403,
    );
    assert.equal(
      (
        await post(
          { helpful: "yes" },
          { origin: "", "sec-fetch-site": "cross-site" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await site(articlePath, { method: "POST" })).status,
      405,
      "only …/feedback takes a POST",
    );

    // "Talk to us" signed in through the portal: a conversation with the article, opened in the portal.
    const identity = (
      await sql(
        "INSERT INTO identities(workspace_id,id,kind,identifier_hash) VALUES('a','id-jo','user','jo-hash') RETURNING id",
      )
    )[0].id;
    const sessionId = crypto.randomUUID();
    await sql(
      "INSERT INTO portal_sessions(workspace_id,id,brand_id,identity_id,secret_hash,expires_at) VALUES('a',$1,'default',$2,$3,now()+interval '1 hour')",
      [sessionId, identity, await digest("s3cret")],
    );
    const cookie = { cookie: `${PORTAL_COOKIE}=${sessionId}.s3cret` };
    const joNo = await post({ helpful: "no" }, cookie);
    const joId = joNo.headers
      .get("location")!
      .match(/feedback=([0-9a-f-]{36})/)![1];
    const talk = await post(
      { feedback: joId, comment: "The link doesn't arrive", action: "talk" },
      cookie,
    );
    assert.equal(talk.status, 303);
    const conversationId = talk.headers
      .get("location")!
      .match(/^\/portal\/a\/default\?request=(.+)$/)![1];
    const parts = await sql(
      "SELECT kind,audience,body,data FROM conversation_parts WHERE conversation_id=$1 ORDER BY seq",
      [conversationId],
    );
    assert.equal(
      parts.find((p) => p.kind === "customer_message").body,
      "The link doesn't arrive",
    );
    const context = parts.find((p) => p.kind === "system_event");
    assert.equal(context.audience, "internal", "for the teammate only");
    assert.deepEqual(context.data, {
      event: "help_context",
      article: { id: reset, title: "Reset your password" },
      feedback: "not_helpful",
    });
    assert.equal(
      (
        await sql(
          "SELECT conversation_id FROM knowledge_feedback WHERE id=$1",
          [joId],
        )
      )[0].conversation_id,
      conversationId,
    );
    // Posting again (a double click) does not start a second conversation.
    const again = await post(
      { feedback: joId, comment: "", action: "talk" },
      cookie,
    );
    assert.equal(again.headers.get("location"), talk.headers.get("location"));

    // The editor's feedback summary and the content team's report.
    const record = await run((q) => readKnowledge(q, "a", "owner-a", reset));
    assert.equal(record.feedback!.helpful, 1);
    assert.equal(record.feedback!.unhelpful, 3);
    assert.deepEqual(
      record.feedback!.comments.map((c) => c.comment),
      ["The link doesn't arrive", "Where is the sign-in page?"],
    );
    const insights = await run((q) =>
      helpInsights(q, "a", "owner-a", centerId, 30),
    );
    assert.deepEqual(insights.totals, { searches: 4, empty: 3, opened: 1 });
    assert.deepEqual(
      insights.noResults.map((r) => [r.query, r.searches]),
      [["invoice address", 3]],
    );
    assert.deepEqual(insights.noClicks, []);
    assert.deepEqual(
      insights.unhelpful.map((a) => [a.title, a.unhelpful, a.helpful]),
      [["Reset your password", 3, 1]],
    );
    await assert.rejects(
      run((q) => helpInsights(q, "a", "ada-nobody", centerId)),
    );
    await assert.rejects(
      run((q) => helpInsights(q, "b", "owner-b", centerId), "b"),
      /Help center unavailable|not enabled/,
    );

    // Retention: searches older than 180 days are removed.
    await sql(
      "UPDATE help_search_queries SET created_at=now()-interval '181 days' WHERE query='invoice address'",
    );
    assert.equal(await purgeHelpSearches(db.connect, "a"), 2);
    assert.equal(
      (await sql("SELECT count(*)::int AS n FROM help_search_queries"))[0].n,
      2,
    );

    // The messenger's Help space.
    const call = (
      path: string,
      init: { token?: string; body?: unknown; key?: string } = {},
    ) =>
      handleApi(
        new Request(RELAY + path, {
          method: init.body ? "POST" : "GET",
          headers: {
            origin: "https://shop.test",
            "content-type": "application/json",
            "idempotency-key": init.key ?? crypto.randomUUID(),
            ...(init.token ? { authorization: "Bearer " + init.token } : {}),
          },
          ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        }),
        env,
      ).then(async (r) => ({
        status: r.status,
        body: (await r.json()) as any,
      }));
    const boot = async (device: string, user?: string) =>
      (
        await call("/v1/messenger/boot", {
          body: {
            workspaceId: "a",
            brandId: "default",
            deviceToken: device.repeat(4),
            pageUrl: "https://shop.test",
            ...(user
              ? {
                  user: {
                    userId: user,
                    email: user + "@example.test",
                    jwt: await new SignJWT({
                      email: user + "@example.test",
                      workspace_id: "a",
                    })
                      .setProtectedHeader({ alg: "HS256", kid: "initial" })
                      .setSubject(user)
                      .setIssuer(identityIssuer("a"))
                      .setAudience("relay-messenger")
                      .setIssuedAt()
                      .setExpirationTime("10m")
                      .sign(identitySecret),
                  },
                }
              : {}),
          },
        })
      ).body;
    const visitor = await boot("visitor-device-");
    assert.equal(visitor.capabilities.help, true);
    const token = visitor.token as string;
    const home = (await call("/v1/messenger/help", { token })).body;
    assert.deepEqual(
      home.collections.map((c: any) => [c.name, c.articles]),
      [
        ["Accounts", 2],
        ["Billing", 1],
      ],
    );
    const found = (await call("/v1/messenger/help/search?q=pasword", { token }))
      .body;
    assert.deepEqual(
      found.results.map((r: any) => r.title),
      ["Reset your password", "Two-factor sign-in"],
    );
    assert.match(found.receipt, /^[\w-]+\.[\w-]+$/);
    const read = (
      await call(
        `/v1/messenger/help/article?id=${reset}&query=${found.queryId}`,
        { token },
      )
    ).body;
    assert.equal(read.title, "Reset your password");
    assert.equal(read.doc.type, "doc");
    assert.equal(
      (
        await sql(
          "SELECT opened_record_id FROM help_search_queries WHERE id=$1",
          [found.queryId],
        )
      )[0].opened_record_id,
      reset,
    );
    // Signed-in articles: not for an anonymous visitor; a verified customer reads them.
    assert.equal(
      (await call(`/v1/messenger/help/article?id=${sso}`, { token })).status,
      404,
    );
    const verified = await boot("verified-device-", "sam");
    assert.equal(
      (
        await call(`/v1/messenger/help/article?id=${sso}`, {
          token: verified.token,
        })
      ).status,
      200,
    );
    assert.equal(
      (await call(`/v1/messenger/help/article?id=${switchedOff}`, { token }))
        .status,
      404,
    );
    // Feedback from the messenger.
    const vote = (
      await call("/v1/messenger/help/feedback", {
        token,
        body: { articleId: reset, helpful: false },
      })
    ).body;
    assert.match(vote.id, /^[0-9a-f-]{36}$/);

    // "Search before contacting": refused without a receipt, or with someone else's; allowed after searching.
    await sql(
      "UPDATE brands SET settings=settings||'{\"requireSearch\":true}' WHERE id='default'",
    );
    const start = (t: string, extra: Record<string, unknown> = {}) =>
      call("/v1/messenger/command", {
        token: t,
        body: { action: "start", text: "Hello", ...extra },
      });
    assert.equal((await start(token)).body.error.code, "HELP_SEARCH_REQUIRED");
    assert.equal(
      (await start(verified.token, { searchReceipt: found.receipt })).body.error
        .code,
      "HELP_SEARCH_REQUIRED",
      "a receipt is the searcher's own",
    );
    assert.equal(
      (await start(token, { helpContext: { searched: "forged" } })).body.error
        .code,
      "HELP_SEARCH_REQUIRED",
      "help context from the client is ignored",
    );
    const searched = await start(token, { searchReceipt: found.receipt });
    assert.equal(searched.status, 200);
    const searchedContext = await sql(
      "SELECT audience,data FROM conversation_parts WHERE conversation_id=$1 AND kind='system_event'",
      [searched.body.conversationId],
    );
    assert.deepEqual(searchedContext, [
      {
        audience: "internal",
        data: { event: "help_context", searched: "pasword" },
      },
    ]);
    // The customer never sees it.
    const history = (
      await call(
        `/v1/messenger/history?conversation=${searched.body.conversationId}`,
        { token },
      )
    ).body;
    assert(!JSON.stringify(history).includes("help_context"));
    // "Talk to us" after a "No" in the messenger: the article goes with it, and it counts as having looked.
    const talked = await start(token, {
      helpArticleId: reset,
      helpFeedbackId: vote.id,
    });
    assert.equal(talked.status, 200);
    assert.deepEqual(
      (
        await sql(
          "SELECT data FROM conversation_parts WHERE conversation_id=$1 AND kind='system_event'",
          [talked.body.conversationId],
        )
      )[0].data,
      {
        event: "help_context",
        article: { id: reset, title: "Reset your password" },
        feedback: "not_helpful",
      },
    );
    assert.equal(
      (
        await sql(
          "SELECT conversation_id FROM knowledge_feedback WHERE id=$1",
          [vote.id],
        )
      )[0].conversation_id,
      talked.body.conversationId,
    );
    // Someone else's vote can't be linked to my conversation.
    const other = await start(verified.token, {
      helpArticleId: reset,
      helpFeedbackId: joId,
    });
    assert.equal(other.status, 200);
    assert.equal(
      (
        await sql(
          "SELECT conversation_id FROM knowledge_feedback WHERE id=$1",
          [joId],
        )
      )[0].conversation_id,
      conversationId,
      "still linked to Jo's own conversation",
    );

    // Isolation: workspace b's messenger sees no help center, and its search finds nothing of a's.
    await sql(
      "UPDATE workspace_features SET enabled=true WHERE name IN ('knowledge_v1','help_center_v1')",
      [],
      "b",
    );
    const outsider = (
      await call("/v1/messenger/boot", {
        body: {
          workspaceId: "b",
          brandId: "default",
          deviceToken: "outsider-device-".repeat(4),
          pageUrl: "https://shop.test",
        },
      })
    ).body;
    assert.equal(outsider.capabilities.help, false);
    assert.equal(
      (await call("/v1/messenger/help", { token: outsider.token })).body
        .available,
      false,
    );
    assert.equal(
      (
        await call(`/v1/messenger/help/article?id=${reset}`, {
          token: outsider.token,
        })
      ).status,
      404,
    );
    assert.deepEqual(
      await run(
        (q) => searchHelp(q, "b", centerId, ["en"], "password", true),
        "b",
      ),
      [],
    );
  } finally {
    await db.close();
  }
});
