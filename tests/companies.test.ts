import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { SignJWT } from "jose";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, mergeVisitorIdentity, reverseContactMerge, seedFoundation } from "../server/people";
import { changeDeveloperTokens } from "../server/developer";
import { handleRest } from "../server/rest";
import { handleApi, type ApiEnvironment } from "../server/api";
import { identityIssuer } from "../server/identity";
import { command } from "../server/conversations";
import { conversationContext } from "../server/context";
import { erase, findSubject } from "../server/erasure";
import { attachCompany, changeCompanies, changePeopleSettings, companiesOf, findCompanies, readCompany, upsertCompany } from "../server/companies";

/**
 * Companies (docs/PEOPLE_STEP2.md, phase 01 P1b): companies with typed custom data, people in many
 * companies with a role in each, written by the API and teammates always and by a verified user's
 * messenger only through the signed token's claim and only while the workspace allows it; carried
 * through merges and their reversal; webhooks; deletion audited; the portal's company visibility,
 * trusting a messenger membership only while that's allowed; erasure; per workspace.
 */
const secret = new TextEncoder().encode("i".repeat(32));
const RELAY = "https://relay.test";
const jwt = (userId: string, claims: Record<string, unknown> = {}) =>
  new SignJWT({ email: userId + "@example.test", workspace_id: "a", ...claims })
    .setProtectedHeader({ alg: "HS256", kid: "initial" })
    .setSubject(userId)
    .setIssuer(identityIssuer("a"))
    .setAudience("relay-messenger")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(secret);
async function hmac(userId: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const data = new TextEncoder().encode(JSON.stringify(["relay-identity-v1", "a", userId, userId + "@example.test", expiresAt]));
  const signature = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, data))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { kid: "initial", expiresAt, signature };
}

test("companies: typed, written by the API, teammates and (when allowed) a signed messenger claim; merges, webhooks, the portal, erasure; per workspace", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    realtimeUrl: "wss://relay.test/realtime",
    storageTransport: "local-pglite",
  };
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const as = <T>(w: string, f: (x: Parameters<Parameters<typeof tenant>[2]>[0]) => Promise<T>) => tenant(db.connect, w, f);
  try {
    for (const w of ["a", "b"]) {
      await as(w, (x) => seedFoundation(x, w, "owner-" + w, { origins: ["https://shop.test"], master: env.identityMaster, identitySecret: secret, enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true WHERE name IN ('developer_api_v1','portal_v1','tickets_v1')");
    }
    // Every company event is written while a webhook wants it.
    await q("a", "INSERT INTO webhook_subscriptions(workspace_id,id,url,topics,version,secret_sealed,created_by) VALUES('a','hook','https://hooks.test/x',$1,'2026-10-20','x','owner-a')", [
      ["company.created", "company.updated", "company.deleted", "company.contact_attached", "company.contact_detached"],
    ]);
    const events = async () => (await q<{ topic: string; resource_id: string; detail: any }>("a", "SELECT topic,resource_id,detail FROM webhook_events ORDER BY created_at,id")).map((e) => e.topic);

    /* ---- The writer: by company_id, typed, refused in words -------------------------------- */
    const acme = (await as("a", (x) => upsertCompany(x, "a", { company_id: "acme", name: "Acme", plan: "Pro", seats: 25, monthly_spend: 1250.5, custom_attributes: { region: "EMEA", trial: false } }))).id;
    const again = await as("a", (x) => upsertCompany(x, "a", { company_id: "acme", seats: 30, custom_attributes: { region: "AMER" } }));
    assert.deepEqual(again, { id: acme, created: false }, "the same company_id updates, so syncs are safe");
    const read = await as("a", (x) => readCompany(x, "a", acme));
    assert.equal(read.name, "Acme");
    assert.equal(read.seats, 30);
    assert.equal(read.monthly_spend, 1250.5);
    assert.deepEqual(read.custom_attributes, { region: "AMER", trial: false });
    assert.deepEqual(
      Object.fromEntries((await q<{ name: string; value_type: string }>("a", "SELECT name,value_type FROM attribute_definitions WHERE owner_type='company'")).map((d) => [d.name, d.value_type])),
      { region: "string", trial: "boolean" },
      "company attributes are defined apart from contacts'",
    );
    await assert.rejects(as("a", (x) => upsertCompany(x, "a", { company_id: "nameless" })), /A new company needs a name/);
    await assert.rejects(as("a", (x) => upsertCompany(x, "a", { company_id: "acme", seats: -1 })), /seats is a whole number/);
    await assert.rejects(as("a", (x) => upsertCompany(x, "a", { company_id: "acme", custom_attributes: { trial: "maybe" } })), (e: any) => e.details?.field === "custom_attributes.trial");
    assert.deepEqual(await events(), ["company.created", "company.updated"], "one created, one updated (the refused writes change nothing)");

    /* ---- The API -------------------------------------------------------------------------- */
    const { token } = (await as("a", (x) => changeDeveloperTokens(x, "a", "owner-a", { action: "create", name: "t", scopes: ["contacts.personal_data"] }))) as { token: string };
    const rest = async (method: string, path: string, body?: unknown) => {
      const r = await handleRest(
        new Request("http://api.test/rest" + path, {
          method,
          headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        { connect: db.connect },
      );
      return { status: r.status, body: (await r.json()) as any };
    };
    const globex = await rest("POST", "/companies", { company_id: "globex", name: "Globex", plan: "Free", custom_attributes: { region: "APAC" } });
    assert.equal(globex.status, 200, JSON.stringify(globex.body));
    assert.equal(globex.body.contact_count, 0);
    assert.deepEqual((await rest("GET", "/companies?company_id=globex")).body.data.map((c: any) => c.name), ["Globex"]);
    assert.deepEqual((await rest("GET", "/companies?per_page=1")).body.data.map((c: any) => c.name), ["Acme"], "by name, paged");
    const patched = await rest("PATCH", `/companies/${globex.body.id}`, { plan: null, website: "https://globex.test" });
    assert.equal(patched.body.plan, null);
    assert.equal(patched.body.website, "https://globex.test");
    assert.equal((await rest("PATCH", `/companies/${globex.body.id}`, { company_id: "acme" })).body.errors[0].field, "company_id", "a company_id another company has is refused");

    const grace = await rest("POST", "/contacts", { external_id: "grace", name: "Grace" });
    const joined = await rest("POST", `/contacts/${grace.body.id}/companies`, { company_id: acme, role: "Admin" });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.deepEqual([joined.body.name, joined.body.role, joined.body.source], ["Acme", "Admin", "api"]);
    await rest("POST", `/contacts/${grace.body.id}/companies`, { company_id: globex.body.id });
    assert.deepEqual((await rest("GET", `/contacts/${grace.body.id}/companies`)).body.data.map((m: any) => [m.name, m.role]), [["Acme", "Admin"], ["Globex", ""]]);
    assert.deepEqual((await rest("GET", `/companies/${acme}/contacts`)).body.data.map((c: any) => c.name), ["Grace"]);
    assert.equal((await rest("DELETE", `/contacts/${grace.body.id}/companies/${globex.body.id}`)).body.detached, true);
    assert.equal((await rest("DELETE", `/contacts/${grace.body.id}/companies/${globex.body.id}`)).status, 404, "not in it any more");

    // Deleting: the company goes with its memberships and values, in one event, and is audited.
    const doomed = await rest("POST", "/companies", { company_id: "doomed", name: "Doomed Inc", custom_attributes: { region: "EMEA" } });
    await rest("POST", `/contacts/${grace.body.id}/companies`, { company_id: doomed.body.id });
    const before = (await events()).length;
    assert.deepEqual((await rest("DELETE", `/companies/${doomed.body.id}`)).body, { id: doomed.body.id, deleted: true });
    assert.deepEqual((await events()).slice(before), ["company.deleted"], "no 'detached' per person when the company itself goes");
    assert.equal((await rest("GET", `/companies/${doomed.body.id}`)).status, 404);
    assert.deepEqual(await q("a", "SELECT 1 FROM company_attribute_values WHERE company_id=$1", [doomed.body.id]), []);
    const audit = (await q<{ action: string; target_name: string; details: any }>("a", "SELECT action,target_name,details FROM audit_events WHERE action='company.deleted'"))[0];
    assert.deepEqual([audit.target_name, audit.details.companyId, audit.details.members], ["Doomed Inc", "doomed", 1]);
    assert.deepEqual(
      (await events()).filter((t) => t.includes("contact_")),
      ["company.contact_attached", "company.contact_attached", "company.contact_detached", "company.contact_attached"],
    );

    /* ---- Merges: the survivor gains the loser's companies; a reversal takes exactly those away --- */
    const user = await as("a", (x) => getIdentity(x, "a", "user", "uma", { name: "Uma" }));
    const visitor = await as("a", (x) => getIdentity(x, "a", "anonymous", "device-uma", {}));
    await as("a", (x) => attachCompany(x, "a", user.contactId, acme, "Owner", "api"));
    await as("a", (x) => attachCompany(x, "a", visitor.contactId, acme, "Visitor", "api"));
    await as("a", (x) => attachCompany(x, "a", visitor.contactId, globex.body.id, "Lurker", "api"));
    const merge = (await as("a", (x) => mergeVisitorIdentity(x, "a", visitor.identityId, user.contactId)))!;
    const merged = (await as("a", (x) => companiesOf(x, "a", [user.contactId])))[user.contactId];
    assert.deepEqual(merged.map((m) => [m.name, m.role, m.source]), [["Acme", "Owner", "api"], ["Globex", "Lurker", "merge"]], "theirs kept; the loser's added, marked as the merge's");
    await as("a", (x) => reverseContactMerge(x, "a", merge));
    assert.deepEqual((await as("a", (x) => companiesOf(x, "a", [user.contactId])))[user.contactId].map((m) => m.name), ["Acme"]);

    /* ---- The messenger: a signed claim, only while allowed; never from HMAC -------------------- */
    const boot = async (userId: string, proof: Record<string, unknown>) => {
      const r = await handleApi(
        new Request(RELAY + "/v1/messenger/boot", {
          method: "POST",
          headers: { origin: "https://shop.test", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({ workspaceId: "a", brandId: "default", deviceToken: (userId + "-device-").repeat(4), pageUrl: "https://shop.test", user: { userId, email: userId + "@example.test", name: userId[0].toUpperCase() + userId.slice(1), ...proof } }),
        }),
        env,
      );
      assert.equal(r.status, 200, await r.clone().text());
      return (await r.json()) as any;
    };
    const companiesOfUser = async (userId: string) => {
      const id = (await q<{ id: string }>("a", "SELECT id FROM contacts WHERE external_id=$1", [userId]))[0].id;
      return (await as("a", (x) => companiesOf(x, "a", [id])))[id].map((m) => [m.name, m.role, m.source]);
    };
    const claim = { companies: [{ company_id: "initech", name: "Initech", role: "Engineer" }, { company_id: "acme" }, { name: "no id" }] };
    await boot("pat", { jwt: await jwt("pat", claim) });
    assert.deepEqual(await companiesOfUser("pat"), [], "off by default: a signed claim is ignored");
    assert.deepEqual(await q("a", "SELECT 1 FROM companies WHERE company_id='initech'"), [], "and makes no company");
    await as("a", (x) => changePeopleSettings(x, "a", "owner-a", { messengerSetsCompanies: true }));
    await boot("pat", { jwt: await jwt("pat", claim) });
    assert.deepEqual(await companiesOfUser("pat"), [["Acme", "", "messenger"], ["Initech", "Engineer", "messenger"]], "joined; a new company made by name; a malformed entry skipped");
    await q("a", "UPDATE brands SET legacy_hmac_enabled=true WHERE id='default'");
    await boot("hal", { hmac: await hmac("hal"), companies: [{ company_id: "acme" }], jwt: undefined });
    assert.deepEqual(await companiesOfUser("hal"), [], "a legacy HMAC proof can never set companies, whatever else is sent");
    assert.equal((await q("a", "SELECT action FROM audit_events WHERE action LIKE 'people_settings.%'")).length, 1, "the setting's change is audited");

    /* ---- The portal: colleagues' requests where visibility is 'company', trusted memberships only --- */
    const portal = async (path: string, cookie = "", body?: unknown) => {
      const r = await handleApi(
        new Request(RELAY + path, {
          method: body ? "POST" : "GET",
          headers: { origin: RELAY, "content-type": "application/json", "idempotency-key": crypto.randomUUID(), ...(cookie ? { cookie } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
        env,
      );
      return { status: r.status, body: (await r.json()) as any, cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
    };
    const signIn = async (userId: string) => (await portal("/v1/portal/session", "", { workspace: "a", brand: "default", user: { userId, email: userId + "@example.test", jwt: await jwt(userId) } })).cookie;
    const start = async (userId: string, text: string) => {
      const identity = (await q<{ id: string }>("a", "SELECT m.identity_id AS id FROM identity_contact_mappings m JOIN contacts c ON c.workspace_id=m.workspace_id AND c.id=m.contact_id JOIN identities i ON i.workspace_id=m.workspace_id AND i.id=m.identity_id WHERE c.external_id=$1 AND i.kind='user'", [userId]))[0].id;
      return ((await as("a", (x) => command(x, "a", { type: "contact", identityId: identity, brandId: "default" }, crypto.randomUUID(), { action: "start", text } as never))) as { conversationId: string }).conversationId;
    };
    // Grace is in Acme (by the API); Pat joined Acme from the messenger; Uma is in Acme (API).
    const graceAsks = await start("grace", "Grace's invoice question");
    const patAsks = await start("pat", "Pat's login problem");
    await start("uma", "Uma's feature idea");
    const requests = async (userId: string) => (await portal("/v1/portal/requests?workspace=a&brand=default", await signIn(userId))).body.requests.map((r: any) => [r.title, r.sharedBy]);
    assert.deepEqual(await requests("grace"), [["Grace's invoice question", null]], "individual by default: only their own");
    await q("a", "INSERT INTO portal_settings(workspace_id,visibility) VALUES('a','company')");
    assert.deepEqual(
      (await requests("grace")).sort(),
      [["Grace's invoice question", null], ["Pat's login problem", "Pat"], ["Uma's feature idea", "Uma"]].sort(),
      "company: colleagues' requests too, marked with whose",
    );
    const graceCookie = await signIn("grace");
    const shared = await portal(`/v1/portal/request?workspace=a&brand=default&id=${patAsks}`, graceCookie);
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.equal(shared.body.sharedBy, "Pat");
    assert.deepEqual(shared.body.parts.filter((p: any) => p.body).map((p: any) => [p.author, p.authorName]), [["colleague", "Pat"]]);
    assert.equal((await portal("/v1/portal/reply", graceCookie, { workspace: "a", brand: "default", id: patAsks, text: "Me too" })).status, 404, "read, never replied to");
    assert.equal((await portal(`/v1/portal/request?workspace=a&brand=default&id=${graceAsks}`, graceCookie)).body.sharedBy, null);
    // With messenger companies turned off, Pat's messenger-made membership stops counting, both ways.
    await as("a", (x) => changePeopleSettings(x, "a", "owner-a", { messengerSetsCompanies: false }));
    assert.deepEqual((await requests("grace")).sort(), [["Grace's invoice question", null], ["Uma's feature idea", "Uma"]].sort());
    assert.deepEqual(await requests("pat"), [["Pat's login problem", null]]);
    assert.equal((await portal(`/v1/portal/request?workspace=a&brand=default&id=${patAsks}`, graceCookie)).status, 404);

    /* ---- The inbox: the sidebar shows them, and a teammate changes them ------------------------- */
    const conversation = await start("grace", "Another question");
    const context = await as("a", (x) => conversationContext(x, "a", "owner-a", conversation));
    const graceId = grace.body.id;
    assert.deepEqual(
      (context.customer as any).companies.map((c: any) => [c.name, c.plan, c.seats, c.role, c.people]),
      [["Acme", "Pro", 30, "Admin", 4]],
    );
    const picked = await as("a", (x) => findCompanies(x, "a", "owner-a", "glo"));
    assert.deepEqual(picked.companies.map((c) => c.name), ["Globex"]);
    let after = await as("a", (x) => changeCompanies(x, "a", "owner-a", crypto.randomUUID(), { action: "attach", contactId: graceId, companyId: globex.body.id, role: "Buyer" }));
    after = await as("a", (x) => changeCompanies(x, "a", "owner-a", crypto.randomUUID(), { action: "attach", contactId: graceId, name: "Hooli", role: "Advisor" }));
    after = await as("a", (x) => changeCompanies(x, "a", "owner-a", crypto.randomUUID(), { action: "role", contactId: graceId, companyId: acme, role: "Billing" }));
    assert.deepEqual(after.companies.map((m) => [m.name, m.role, m.source]), [["Acme", "Billing", "api"], ["Globex", "Buyer", "inbox"], ["Hooli", "Advisor", "inbox"]], "who added it stays the first adder's");
    after = await as("a", (x) => changeCompanies(x, "a", "owner-a", crypto.randomUUID(), { action: "detach", contactId: graceId, companyId: globex.body.id }));
    assert.deepEqual(after.companies.map((m) => m.name), ["Acme", "Hooli"]);
    // A role that may not see personal data may not change them either.
    await q("a", "INSERT INTO roles(workspace_id,id,name) VALUES('a','reader','Reader')");
    await q("a", "INSERT INTO role_capabilities(workspace_id,role_id,capability) VALUES('a','reader','conversations.read')");
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','t-reader','p-reader','Reader','reader')");
    await assert.rejects(as("a", (x) => changeCompanies(x, "a", "p-reader", crypto.randomUUID(), { action: "detach", contactId: graceId, companyId: acme })), (e: any) => e.status === 403);
    const hidden = await as("a", (x) => conversationContext(x, "a", "p-reader", conversation));
    assert.equal((hidden.customer as any).companies, undefined, "nor see them");

    /* ---- Erasure: the person's memberships go; the companies stay -------------------------------- */
    await as("a", async (x) => {
      await x.query("SELECT set_config('relay.actor_id','owner-a',true)");
      const subject = await findSubject(x, "a", { contactId: graceId });
      await erase(x, "a", subject!);
    });
    assert.deepEqual(await q("a", "SELECT 1 FROM contact_companies WHERE contact_id=$1", [graceId]), []);
    assert.equal((await as("a", (x) => readCompany(x, "a", acme))).name, "Acme");

    /* ---- Per workspace ------------------------------------------------------------------------- */
    for (const table of ["companies", "company_attribute_values", "contact_companies", "people_settings"]) assert.deepEqual(await q("b", `SELECT * FROM ${table}`), [], `${table}: another workspace sees none`);
    await assert.rejects(as("b", (x) => readCompany(x, "b", acme)), /No such company/);

    /* ---- One writer for companies and memberships, and for every typed value ---------------------- */
    const offenders: string[] = [];
    for (const dir of ["server", "workers", "scripts", "lib", "app", "tests"]) {
      let files: string[] = [];
      try {
        files = (await readdir(dir, { recursive: true })) as string[];
      } catch {
        continue;
      }
      for (const f of files.filter((x) => /\.(ts|tsx)$/.test(x))) {
        const source = await readFile(`${dir}/${f}`, "utf8");
        const path = `${dir}/${f}`;
        if (path !== "server/companies.ts" && path !== "tests/companies.test.ts" && /(INSERT INTO|UPDATE|DELETE FROM) (companies|contact_companies)\b/.test(source)) offenders.push(path);
        if (path !== "server/contact-attributes.ts" && /(INSERT INTO|UPDATE|DELETE FROM) company_attribute_values\b/.test(source)) offenders.push(path);
      }
    }
    assert.deepEqual(offenders, [], "write companies through server/companies.ts, and typed values through server/contact-attributes.ts");
  } finally {
    await db.close();
  }
});
