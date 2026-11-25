import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { getIdentity, mergeVisitorIdentity, seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { handleRest } from "../server/rest";
import { changeDeveloperTokens } from "../server/developer";
import { attachCompany, upsertCompany } from "../server/companies";
import { tagContact } from "../server/people-tags";
import { inSegment } from "../server/segments";
import type { SegmentDefinition } from "../lib/segments";

/**
 * Segments of companies, and grouped, tag and company rules in use (docs/PEOPLE_STEP4.md, phase 01
 * P2a): saved with what they're made of and counted in People; listed through the API (a people
 * segment has no companies, nor the reverse); never an outbound audience; the cheap single-person
 * check agreeing with the lists and ignoring merged-away people; per workspace.
 */
test("company segments and grouped rules: People, the API, outbound and the single-person check; per workspace", async () => {
  const db = await testDatabase();
  const env: ApiEnvironment = { connect: db.connect, sessionSecret: "s".repeat(40), identityMaster: "m".repeat(40), bridgeSecret: "b".repeat(40), realtimeUrl: "wss://relay.test/realtime", storageTransport: "local-pglite" };
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const as = <T>(w: string, f: (x: Parameters<Parameters<typeof tenant>[2]>[0]) => Promise<T>) => tenant(db.connect, w, f);
  const agent = async (path: string, data?: unknown, workspace = "a") => {
    const r = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: { origin: "https://app.test", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      "owner-" + workspace,
      { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: workspace, RELAY_BRIDGE_SECRET: env.bridgeSecret },
      (x) => handleApi(x, env),
    );
    return { status: r.status, body: (await r.json()) as any };
  };
  try {
    for (const w of ["a", "b"]) {
      await as(w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: env.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true WHERE name IN ('settings_v1','segments_v1','outbound_v1','developer_api_v1')");
    }
    await q("a", "INSERT INTO tags(workspace_id,id,name) VALUES('a','vip','VIP')");
    // Ada at Acme (Pro, 50 seats) and tagged VIP; Bo at Globex (Free); Cy in no company.
    const people = await as("a", async (x) => {
      const acme = (await upsertCompany(x, "a", { company_id: "acme", name: "Acme", plan: "Pro", seats: 50, monthly_spend: 2500 })).id;
      const globex = (await upsertCompany(x, "a", { company_id: "globex", name: "Globex", plan: "Free", seats: 2 })).id;
      await upsertCompany(x, "a", { company_id: "empty", name: "Empty Co", plan: "Pro" });
      const ada = (await getIdentity(x, "a", "user", "ada", { name: "Ada" })).contactId;
      const bo = (await getIdentity(x, "a", "user", "bo", { name: "Bo" })).contactId;
      const cy = (await getIdentity(x, "a", "user", "cy", { name: "Cy" })).contactId;
      await attachCompany(x, "a", ada, acme, "Admin", "api");
      await attachCompany(x, "a", bo, globex, "", "api");
      await tagContact(x, "a", ada, "vip", "api");
      return { ada, bo, cy, acme, globex };
    });

    /* ---- People: a company segment saved with its target, and counted -------------------------- */
    const paying: SegmentDefinition = { match: "all", rules: [{ field: "plan", op: "is", value: "pro" }, { field: "people", op: "greater_than", value: 0 }] };
    const list = (await agent("people", { action: "list", target: "companies", definition: paying })).body;
    assert.deepEqual([list.count, list.companies.map((c: any) => [c.name, c.plan, c.seats, c.monthlySpend, c.people])], [1, [["Acme", "Pro", 50, 2500, 1]]]);
    assert.equal((await agent("people", { action: "list", target: "companies", definition: { match: "all", rules: [{ field: "role", op: "is", value: "user" }] } })).body.error.message, "Rule 1: choose what to filter on.", "a person's rule on companies is refused");
    const saved = (await agent("people", { action: "save", target: "companies", name: "Paying companies", definition: paying })).body;
    const seg = saved.segments.find((s: any) => s.id === saved.id);
    assert.deepEqual([seg.target, seg.count], ["companies", 1]);
    assert.deepEqual(saved.segments.find((s: any) => s.id === "all-companies").count, 3);
    // Saving it again keeps it a company segment, whatever the request says.
    await agent("people", { action: "save", id: saved.id, target: "contacts", name: "Paying companies", definition: { ...paying, match: "any" } });
    assert.equal((await q("a", "SELECT target FROM segments WHERE id=$1", [saved.id]))[0].target, "companies");

    /* ---- Grouped rules with tags and companies, on people -------------------------------------- */
    const vipsOrProCompanies: SegmentDefinition = {
      match: "all",
      rules: [
        { field: "role", op: "is", value: "user" },
        { match: "any", rules: [{ field: "tag", op: "has", value: "vip" }, { field: "company.plan", op: "is", value: "free" }] },
      ],
    };
    const grouped = (await agent("people", { action: "list", definition: vipsOrProCompanies })).body;
    assert.deepEqual(grouped.contacts.map((c: any) => c.name).sort(), ["Ada", "Bo"]);
    const nobodyCompany = (await agent("people", { action: "list", definition: { match: "all", rules: [{ field: "companies", op: "is_not_set" }] } })).body;
    assert.deepEqual(nobodyCompany.contacts.map((c: any) => c.name), ["Cy"]);

    /* ---- The single-person check agrees, and a merged-away person is in nothing ------------------- */
    for (const [id, want] of [[people.ada, true], [people.bo, true], [people.cy, false]] as const) assert.equal(await as("a", (x) => inSegment(x, "a", vipsOrProCompanies, id)), want);
    const visitor = await as("a", (x) => getIdentity(x, "a", "anonymous", "device-cy", {}));
    await as("a", (x) => tagContact(x, "a", visitor.contactId, "vip", "api"));
    await q("a", "UPDATE contacts SET role='lead' WHERE id=$1", [visitor.contactId]);
    const leadVip: SegmentDefinition = { match: "all", rules: [{ field: "tag", op: "has", value: "vip" }] };
    assert.equal(await as("a", (x) => inSegment(x, "a", leadVip, visitor.contactId)), true);
    await as("a", (x) => mergeVisitorIdentity(x, "a", visitor.identityId, people.cy));
    assert.equal(await as("a", (x) => inSegment(x, "a", leadVip, visitor.contactId)), false, "merged away: in no segment");
    assert.equal(await as("a", (x) => inSegment(x, "a", leadVip, people.cy)), true, "the survivor gained the tag");

    /* ---- The API ------------------------------------------------------------------------------ */
    const { token } = (await as("a", (x) => changeDeveloperTokens(x, "a", "owner-a", { action: "create", name: "t", scopes: ["contacts.personal_data"] }))) as { token: string };
    const rest = async (path: string) => {
      const r = await handleRest(new Request("http://api.test/rest" + path, { headers: { authorization: "Bearer " + token } }), { connect: db.connect });
      return { status: r.status, body: (await r.json()) as any };
    };
    const segs = (await rest("/segments")).body.data;
    assert.deepEqual(segs.filter((s: any) => s.of === "companies").map((s: any) => s.name), ["All companies", "Paying companies"]);
    assert.deepEqual((await rest(`/segments/${saved.id}/companies`)).body.data.map((c: any) => c.name).sort(), ["Acme", "Empty Co", "Globex"], "any: Pro (Acme, Empty Co), or with people (Acme, Globex)");
    assert.equal((await rest(`/segments/${saved.id}/contacts`)).status, 404, "a company segment has no contacts");
    assert.equal((await rest("/segments/all-users/companies")).status, 404, "nor a people segment companies");
    assert.equal((await rest("/segments/all-companies/companies")).body.data.length, 3);

    /* ---- Outbound: a company segment is never an audience --------------------------------------- */
    await agent("subscription-settings", { action: "create", name: "Tips", consent: "opt_out", channel: "in_app" });
    const tips = (await q<{ id: string }>("a", "SELECT id FROM subscription_types WHERE name='Tips'"))[0].id;
    const outbound = (await agent("outbound")).body;
    assert.ok(!outbound.choices.segments.some((s: any) => s.id === saved.id || s.id === "all-companies"), "not offered");
    assert.deepEqual(outbound.choices.tags.map((t: any) => t.name), ["VIP"]);
    const made = (await agent("outbound-message", { action: "create", type: "chat", title: "Hi" })).body;
    const def = { ...made.draft, content: { text: "Hi!", senderId: "owner" }, subscriptionTypeId: tips, audience: { segmentId: saved.id, rules: vipsOrProCompanies, sendTime: [] } };
    await agent("outbound-message", { action: "save", id: made.message.id, definition: def });
    const refused = await agent("outbound-message", { action: "publish", id: made.message.id });
    assert.notEqual(refused.status, 200);
    assert.match(JSON.stringify(refused.body), /segment is of companies/);
    // Grouped rules with tags and companies make a fine audience.
    await agent("outbound-message", { action: "save", id: made.message.id, definition: { ...def, audience: { ...def.audience, segmentId: null } } });
    assert.equal((await agent("outbound-message", { action: "publish", id: made.message.id })).status, 200);

    /* ---- Per workspace -------------------------------------------------------------------------- */
    const other = (await agent("people", undefined, "b")).body;
    assert.deepEqual(other.segments.map((s: any) => [s.id, s.count]).filter(([id]: [string]) => id === "all-companies"), [["all-companies", 0]]);
    assert.equal((await agent("people", { action: "list", segmentId: saved.id }, "b")).status, 404);
  } finally {
    await db.close();
  }
});
