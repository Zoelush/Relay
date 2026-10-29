import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, reverseContactMerge, seedFoundation } from "../server/people";
import { command } from "../server/conversations";
import { runJob, type Job } from "../server/jobs";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { linksJob, readLinks } from "../server/links";
import { safeBrowsing, standInReputation } from "../server/link-reputation";
import { acceptEmail, receiveEmailJob, type EmailEnvironment } from "../server/email-in";
import { attachmentScan } from "../server/attachments";
import { runDelivery } from "../server/channels";
import { localAttachmentStorage } from "../scripts/local-storage";
import { anchorsIn, codeReasons, findLinks, policyDomain, verdictOf } from "../lib/links";

/** Link safety and risky merges (phase 16, C7a; docs/SECURITY_STEP11.md). */
test("links: found in text, checked in code, and judged in one order", () => {
  assert.deepEqual(
    findLinks("See https://shop.example/a?b=1, or www.help.example. Not ftp://x.example").map((l) => [l.text, l.url]),
    [
      ["https://shop.example/a?b=1", "https://shop.example/a?b=1"],
      ["www.help.example", "https://www.help.example/"],
    ],
  );
  assert.equal(findLinks("x ".repeat(5) + "https://a.example ".repeat(30)).length, 20);
  assert.deepEqual(codeReasons("https://shop.example/"), []);
  assert.deepEqual(codeReasons("http://192.168.1.20/login"), ["ip"]);
  assert.deepEqual(codeReasons("https://xn--pple-43d.com/"), ["lookalike"]);
  assert.deepEqual(codeReasons("https://bank.example@evil.example/"), ["credentials"]);
  assert.deepEqual(codeReasons("https://evil.example/", "https://bank.example/login"), ["mismatch"]);
  assert.deepEqual(codeReasons("https://www.bank.example/", "bank.example"), [], "www. and subdomains aren't a mismatch");
  assert.deepEqual(codeReasons("https://evil.example/", "Click here"), [], "text that isn't an address names nothing");
  assert.deepEqual(codeReasons("https://files.example/setup.EXE"), ["download"]);
  assert.equal(policyDomain("https://Shop.Example.com/path"), "shop.example.com");
  assert.equal(policyDomain("*.example.com"), "example.com");
  assert.equal(policyDomain("not a domain"), null);
  assert.equal(policyDomain("localhost"), null);
  const policy = { trusted: ["good.example"], blocked: ["bad.example"], own: ["shop.example"] };
  const judge = (url: string, reasons: Parameters<typeof verdictOf>[2]["reasons"] = [], threat: string | null = null) => verdictOf(url, policy, { reasons, threat }).verdict;
  assert.equal(judge("https://docs.good.example/"), "trusted");
  assert.equal(judge("https://shop.example/cart"), "trusted", "the workspace's own websites");
  assert.equal(judge("https://other.example/"), "untrusted");
  assert.equal(judge("https://cdn.bad.example/"), "blocked");
  assert.equal(judge("https://good.example/x", [], "MALWARE"), "malicious", "a threat outranks trust");
  assert.equal(judge("https://bad.example/x", [], "MALWARE"), "blocked", "blocked outranks everything");
  assert.equal(judge("https://other.example/", ["download"]), "malicious");
  assert.deepEqual(anchorsIn('<p><a href="https://evil.example/?a=1&amp;b=2" rel="x">bank.example</a> <a href="mailto:x@y">mail</a></p>'), [
    { url: "https://evil.example/?a=1&b=2", text: "bank.example" },
  ]);
});

test("link reputation: Safe Browsing's request and answer, and the stand-in", async () => {
  let sent: { url: string; body: any } | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    sent = { url, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ matches: [{ threatType: "SOCIAL_ENGINEERING", threat: { url: "https://phish.example/" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const found = await safeBrowsing("key 1", fake).check(["https://phish.example/", "https://fine.example/"]);
  assert.deepEqual(found, { "https://phish.example/": "SOCIAL_ENGINEERING" });
  assert.match(sent!.url, /^https:\/\/safebrowsing\.googleapis\.com\/v4\/threatMatches:find\?key=key%201$/);
  assert.deepEqual(sent!.body.threatInfo.threatEntries, [{ url: "https://phish.example/" }, { url: "https://fine.example/" }], "only the addresses are sent");
  const failing = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(safeBrowsing("k", failing).check(["https://a.example/"]), /503/);
  assert.deepEqual(await standInReputation().check(["https://x.malware.test/", "https://phishing.test/a", "https://ok.example/"]), {
    "https://x.malware.test/": "MALWARE",
    "https://phishing.test/a": "SOCIAL_ENGINEERING",
  });
});

test("link safety and risky merges: the policy page, each click judged, the lookup job, blocked links refused, merges behind their switches, per workspace, rollback", async () => {
  const db = await testDatabase();
  const storage = localAttachmentStorage().storage;
  const DOMAIN = "inbound.relay.test";
  const reputation = standInReputation();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
    attachments: storage,
    emailDomain: DOMAIN,
    linkReputation: reputation,
  };
  const emailEnv: EmailEnvironment = { storage, domain: DOMAIN, trustedAuthServ: ["mx.cloudflare.net"] };
  const sql = <T = any>(w: string, text: string, values: unknown[] = []) => tenant(db.connect, w, async (q) => (await q.query<T>(text, values)).rows);
  const handlers = {
    "links.check": (j: Job) => linksJob(db.connect, { reputation }, j),
    "email.receive": (j: Job) => receiveEmailJob(db.connect, emailEnv, j),
    "attachment.scan": (j: Job) => attachmentScan(db.connect, storage, j),
    "channel.deliver": (j: Job) => runDelivery(db.connect, {}, j),
  };
  const drain = async (w = "a") => {
    for (let i = 0; i < 100; i++) {
      const job = (await sql<{ id: string }>(w, "SELECT id FROM jobs WHERE kind IN ('links.check','email.receive','attachment.scan','channel.deliver') AND state IN ('queued','running') ORDER BY created_at LIMIT 1"))[0];
      if (!job) return;
      await runJob(db.connect, w, job.id, handlers);
    }
  };
  const agent = async (path: string, data?: unknown, principal = "owner-a", workspace = "a") => {
    const response = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: { origin: "https://app.test", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      principal,
      { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: workspace, RELAY_BRIDGE_SECRET: env.bridgeSecret },
      (r) => handleApi(r, env),
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  const contact = (identityId: string) => ({ type: "contact" as const, identityId, brandId: "default" });
  const start = async (w: string, kind: "anonymous" | "user", external: string, text: string, profile: { name?: string; email?: string } = {}) =>
    tenant(db.connect, w, async (q) => {
      const who = await getIdentity(q, w, kind, external, profile);
      const r = (await command(q, w, { ...contact(who.identityId), verified: kind === "user" }, crypto.randomUUID(), { action: "start", text } as unknown as Parameters<typeof command>[4])) as {
        conversationId: string;
      };
      return { id: r.conversationId, identityId: who.identityId, contactId: who.contactId };
    });
  const firstPart = async (conversationId: string, w = "a") =>
    (await sql<{ id: string }>(w, "SELECT id FROM conversation_parts WHERE conversation_id=$1 AND author_type='contact' ORDER BY seq LIMIT 1", [conversationId]))[0].id;
  const verdict = (part: string, url: string, principal = "owner-a", w = "a") => agent(`link-verdict?part=${encodeURIComponent(part)}&url=${encodeURIComponent(url)}`, undefined, principal, w);
  const teammate = (w: string, p: Record<string, unknown>) => tenant(db.connect, w, (q) => command(q, w, { type: "teammate", principal: "owner-" + w }, crypto.randomUUID(), p as unknown as Parameters<typeof command>[4]));
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (q) => seedFoundation(q, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await sql(w, "UPDATE workspace_features SET enabled=true");
      await sql(w, "DELETE FROM calendar_assignments");
    }
    await sql("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");
    await sql("a", `UPDATE brands SET settings=jsonb_set(settings,'{allowedOrigins}','["https://shop.example"]') WHERE id='default'`);

    // The page: the workspace's own website trusted by default; domains added, moved and removed.
    assert.deepEqual((await agent("links")).body, { trusted: [], blocked: [], own: ["shop.example"], lookup: "Stand-in" });
    assert.equal((await agent("links", { action: "add", kind: "trusted", domain: "not a domain" })).status, 400);
    await agent("links", { action: "add", kind: "trusted", domain: "https://Docs.Good.example/x" });
    await agent("links", { action: "add", kind: "trusted", domain: "bad.example" });
    const moved = await agent("links", { action: "add", kind: "blocked", domain: "bad.example" });
    assert.deepEqual([moved.body.trusted, moved.body.blocked], [["docs.good.example"], ["bad.example"]], "a domain is on one list");
    assert.equal((await agent("links", { action: "remove", domain: "nowhere.example" })).status, 404);
    assert.deepEqual(
      (await sql("a", "SELECT action FROM audit_events WHERE target_type='link_policy' ORDER BY seq")).map((r: { action: string }) => r.action),
      ["link_policy.created", "link_policy.created", "link_policy.changed"],
    );
    assert.equal((await agent("links", undefined, "agent-1-a")).status, 403);
    assert.deepEqual((await agent("links", undefined, "owner-b", "b")).body.blocked, [], "another workspace's lists are its own");
    await assert.rejects(tenant(db.connect, "b", (x) => readLinks(x, "b", "owner-a", null)));

    // A customer's links: noted for the lookup, which flags the known one.
    const c = await start("a", "anonymous", "visitor-1", "Links: https://shop.example/cart https://docs.good.example/a https://other.example/ https://evil.malware.test/x http://10.0.0.1/ https://cdn.bad.example/f");
    const part = await firstPart(c.id);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM part_links WHERE part_id=$1 AND checked_at IS NULL", [part]))[0].n, 6);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM jobs WHERE kind='links.check' AND state='queued'"))[0].n, 1);
    await drain();
    assert.deepEqual(await sql("a", "SELECT url,threat FROM part_links WHERE part_id=$1 AND threat IS NOT NULL", [part]), [{ url: "https://evil.malware.test/x", threat: "MALWARE" }]);
    assert.equal((await sql("a", "SELECT count(*)::int AS n FROM part_links WHERE part_id=$1 AND checked_at IS NULL", [part]))[0].n, 0);
    // Without a lookup, the job leaves them unchecked (the checks in code still apply).
    const noLookup = await start("a", "anonymous", "visitor-2", "See https://later.example/");
    const job = (await sql<Job>("a", "SELECT * FROM jobs WHERE kind='links.check' AND state='queued'"))[0];
    assert.deepEqual((await linksJob(db.connect, {}, job)).result, { skipped: "No reputation lookup." });
    await drain();
    assert.ok(await firstPart(noLookup.id));

    // Each click is judged by the server, with the lists as they are now.
    const judged = async (url: string) => (await verdict(part, url)).body;
    assert.equal((await judged("https://shop.example/cart")).verdict, "trusted");
    assert.equal((await judged("https://docs.good.example/a")).verdict, "trusted");
    assert.equal((await judged("https://other.example/")).verdict, "untrusted");
    assert.deepEqual(await judged("https://evil.malware.test/x"), {
      url: "https://evil.malware.test/x",
      host: "evil.malware.test",
      verdict: "malicious",
      reasons: [{ id: "reputation", text: "It's on a list of known phishing or malware addresses." }],
    });
    assert.deepEqual((await judged("http://10.0.0.1/")).reasons.map((r: { id: string }) => r.id), ["ip"]);
    assert.equal((await judged("https://cdn.bad.example/f")).verdict, "blocked");
    await agent("links", { action: "add", kind: "blocked", domain: "other.example" });
    assert.equal((await judged("https://other.example/")).verdict, "blocked", "a change applies at once");
    assert.equal((await verdict(part, "https://not-in-it.example/")).status, 404, "only a link in that part");
    assert.equal((await verdict(part, "https://shop.example/cart", "owner-b", "b")).status, 404, "not across workspaces");

    // Opening: blocked is refused, malicious needs the risk acknowledged (and is audited).
    assert.equal((await agent("link-verdict", { partId: part, url: "https://cdn.bad.example/f" })).status, 403);
    const unconfirmed = await agent("link-verdict", { partId: part, url: "https://evil.malware.test/x" });
    assert.equal(unconfirmed.status, 409);
    assert.equal(unconfirmed.body.error.code, "ACKNOWLEDGE_REQUIRED");
    assert.equal((await agent("link-verdict", { partId: part, url: "https://evil.malware.test/x", acknowledged: true })).status, 200);
    assert.equal((await agent("link-verdict", { partId: part, url: "https://shop.example/cart" })).status, 200);
    const opened = await sql("a", "SELECT actor_id,target_id,details FROM audit_events WHERE action='link.opened_despite_warning'");
    assert.equal(opened.length, 1);
    assert.deepEqual(opened[0].details, { host: "evil.malware.test", reasons: ["reputation"] });
    assert.ok(!JSON.stringify(opened[0]).includes("/x"), "the audit keeps the host, not the address");

    // An email's HTML links: noted, and an anchor whose text names another site is flagged.
    await sql("a", "INSERT INTO email_settings(workspace_id,brand_id,token) VALUES('a','default','hello')");
    const raw = new TextEncoder().encode(
      [
        "From: Ada <ada@customer.example>",
        "To: help@acme.example",
        "Subject: My bank",
        "Message-ID: <links-1@customer.example>",
        "MIME-Version: 1.0",
        "Content-Type: text/html; charset=utf-8",
        "",
        '<p>Please log in at <a href="https://login.evil.example/">https://bank.example/login</a>.</p>',
        "",
      ].join("\r\n"),
    );
    assert.equal((await acceptEmail(db.connect, emailEnv, { raw, to: `a+hello@${DOMAIN}`, from: "ada@customer.example" })).accepted, true);
    await drain();
    const [mail] = await sql<{ part_id: string }>("a", "SELECT part_id FROM email_inbound ORDER BY received_at DESC LIMIT 1");
    // The text's address (the anchor's text) and the HTML's real destination.
    assert.deepEqual(await sql("a", "SELECT url FROM part_links WHERE part_id=$1 ORDER BY url", [mail.part_id]), [{ url: "https://bank.example/login" }, { url: "https://login.evil.example/" }]);
    const mismatch = (await verdict(mail.part_id, "https://login.evil.example/")).body;
    assert.deepEqual([mismatch.verdict, mismatch.reasons.map((r: { id: string }) => r.id)], ["malicious", ["mismatch"]]);

    // A teammate can't send a link to a blocked domain, in text or a rich message.
    await assert.rejects(teammate("a", { action: "reply", conversationId: c.id, text: "Try https://cdn.bad.example/x" }), /blocked in this workspace/);
    await assert.rejects(
      teammate("a", {
        action: "note",
        conversationId: c.id,
        doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "here", marks: [{ type: "link", attrs: { href: "https://bad.example/" } }] }] }] },
      }),
      /blocked in this workspace/,
    );
    await teammate("a", { action: "reply", conversationId: c.id, text: "Try https://shop.example/help" });
    await teammate("b", { action: "reply", conversationId: (await start("b", "anonymous", "v-b", "Hi")).id, text: "https://bad.example/ is fine here" });

    // Risky merges: different people's conversations are refused, until the switch and a confirmation.
    const ada = await start("a", "user", "ada", "Ada's question", { name: "Ada", email: "ada@people.example" });
    const bob = await start("a", "user", "bob", "Bob's question", { name: "Bob", email: "bob@people.example" });
    const merge = (extra: Record<string, unknown> = {}) => teammate("a", { action: "merge", conversationId: bob.id, targetId: ada.id, ...extra });
    await assert.rejects(merge({ acrossPeople: true }), (e: { code?: string; message?: string }) => e.code === "MERGE_CONTACT_MISMATCH" && /Settings › Security › Data protection/.test(e.message!));
    assert.equal((await agent("data-protection")).body.merges.acrossPeople, false);
    const switched = await agent("data-protection", { action: "merges", acrossPeople: true, leadsByEmail: false });
    assert.deepEqual(switched.body.merges, { acrossPeople: true, leadsByEmail: false });
    assert.equal((await agent("data-protection", { action: "merges", acrossPeople: false, leadsByEmail: false }, "agent-1-a")).status, 403);
    await assert.rejects(merge(), (e: { code?: string; message?: string }) => e.code === "MERGE_ACROSS_PEOPLE" && /each sees the whole conversation/.test(e.message!));
    assert.equal(((await merge({ acrossPeople: true })) as { conversationId: string }).conversationId, ada.id);
    const across = await sql("a", "SELECT target_id,details FROM audit_events WHERE action='conversation.merged_across_people'");
    assert.deepEqual(across, [{ target_id: ada.id, details: { from: bob.id, contacts: [bob.contactId, ada.contactId] } }]);

    // Leads by email: off, nothing; on, a lead's message joins the only user with that email.
    const lead1 = await start("a", "anonymous", "lead-1", "Hello from a lead", { email: "ADA@people.example" });
    const contactOf = async (identityId: string) => (await sql<{ contact_id: string }>("a", "SELECT contact_id FROM identity_contact_mappings WHERE identity_id=$1", [identityId]))[0].contact_id;
    assert.equal(await contactOf(lead1.identityId), lead1.contactId, "off: not merged");
    await agent("data-protection", { action: "merges", acrossPeople: true, leadsByEmail: true });
    await tenant(db.connect, "a", (q) => command(q, "a", contact(lead1.identityId), crypto.randomUUID(), { action: "reply", conversationId: lead1.id, text: "Me again" } as unknown as Parameters<typeof command>[4]));
    assert.equal(await contactOf(lead1.identityId), ada.contactId, "on: merged into Ada");
    const leadAudit = await sql<{ target_id: string; details: { merge: string; lead: string } }>("a", "SELECT target_id,details FROM audit_events WHERE action='contact.lead_merged_by_email'");
    assert.deepEqual([leadAudit.length, leadAudit[0].target_id, leadAudit[0].details.lead], [1, ada.contactId, lead1.contactId]);
    // The lead's device stays unverified: it still can't reach Ada's own conversation.
    await assert.rejects(
      tenant(db.connect, "a", (q) => command(q, "a", contact(lead1.identityId), crypto.randomUUID(), { action: "reply", conversationId: ada.id, text: "Let me in" } as unknown as Parameters<typeof command>[4])),
      /Conversation unavailable/,
    );
    // Reversible, as every contact merge is.
    await tenant(db.connect, "a", (q) => reverseContactMerge(q, "a", leadAudit[0].details.merge));
    assert.equal(await contactOf(lead1.identityId), lead1.contactId);
    // Two users with the email: no merge.
    await start("a", "user", "ada-2", "Another Ada", { email: "ada@people.example" });
    await tenant(db.connect, "a", (q) => command(q, "a", contact(lead1.identityId), crypto.randomUUID(), { action: "reply", conversationId: lead1.id, text: "Once more" } as unknown as Parameters<typeof command>[4]));
    assert.equal(await contactOf(lead1.identityId), lead1.contactId, "ambiguous: not merged");

    // The rollback: both switches off (merges made stay); link policies stay.
    await db.pg.exec(await readFile("db/rollback/0090_links_merges.sql", "utf8"));
    assert.deepEqual((await agent("data-protection")).body.merges, { acrossPeople: false, leadsByEmail: false });
    assert.equal((await sql("a", "SELECT merged_into_id FROM conversations WHERE id=$1", [bob.id]))[0].merged_into_id, ada.id);
    assert.deepEqual((await agent("links")).body.blocked, ["bad.example", "other.example"]);
  } finally {
    await db.close();
  }
});
