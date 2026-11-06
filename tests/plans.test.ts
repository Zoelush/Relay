import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { testDatabase } from "./database";
import { tenant, type Sql } from "../server/db";
import { seedFoundation } from "../server/people";
import { saveRole } from "../server/people-settings";
import { saveBrand } from "../server/channel-settings";
import { changeHelpCenter } from "../server/help-centers";
import { settingsOverview } from "../server/settings";
import { enabledChannels } from "../server/channels";
import { workflowsEnabled } from "../server/workflow-engine";
import { changeAccess } from "../server/two-factor";
import { assertNetwork } from "../server/allowlists";
import { changeRetention } from "../server/retention";
import { changeDataProtection } from "../server/redaction";
import { changeSupport } from "../server/support";
import { changeSso } from "../server/sso";
import { featureOn, planOf, readPlan } from "../server/plans";
import { FEATURES, FLAG_FEATURE, includes, limitOf, PLAN_IDS, placeholders } from "../lib/plans";

/** Plans and the one gate (phase 16, C8a; docs/SECURITY_STEP14.md). */
test("the plan policy: tiers include what's below them, limits grow, flags name real features, prices set before billing goes live", () => {
  for (const f of Object.keys(FEATURES) as (keyof typeof FEATURES)[]) {
    assert.equal(includes("enterprise", f), true, f);
    assert.equal(includes("starter", f), false, f);
    if (includes("pro", f)) assert.equal(FEATURES[f].plan, "pro");
  }
  assert.deepEqual(PLAN_IDS.map((p) => limitOf(p, "brands")), [1, 3, null]);
  for (const feature of Object.values(FLAG_FEATURE)) assert.ok(feature in FEATURES, feature);
  if (process.env.RELAY_BILLING_LIVE === "true") assert.deepEqual(placeholders(), [], "set every price in lib/plans.ts before billing goes live");
  else assert.ok(placeholders().length > 0, "prices are placeholders until launch");
});

test("plans: one gate; no plan check, plan read or raw read of a gated flag anywhere else", async () => {
  const gated = Object.keys(FLAG_FEATURE);
  const offenders: string[] = [];
  const allowed = new Set(["server/plans.ts", "lib/plans.ts", "scripts/check-plans.ts"]);
  for (const dir of ["server", "workers", "app", "lib", "agent", "components", "scripts"]) {
    let files: string[] = [];
    try {
      files = ((await readdir(dir, { recursive: true })) as string[]).filter((f) => /\.(ts|tsx|mjs)$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = `${dir}/${f}`;
      if (allowed.has(path)) continue;
      const source = await readFile(path, "utf8");
      if (/from "(\.\.\/)+lib\/plans"/.test(source)) offenders.push(`${path}: imports lib/plans (ask server/plans.ts)`);
      for (const [i, line] of source.split("\n").entries()) {
        if (/workspace_plans/.test(line) && !(path === "server/people.ts" && /INSERT INTO workspace_plans/.test(line)) && path !== "server/erasure.ts") offenders.push(`${path}:${i + 1}: reads workspace_plans`);
        if (/workspace_features/.test(line) && !/INSERT INTO|UPDATE workspace_features/.test(line) && gated.some((g) => line.includes(`'${g}'`) || line.includes(`"${g}"`)))
          offenders.push(`${path}:${i + 1}: reads a plan-gated flag directly (use featureOn)`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("plans: beyond the plan, product features are off and security changes refused (what's set keeps applying); limits; the Plan page; per workspace; rollback", async () => {
  const db = await testDatabase();
  const t = <T>(w: string, fn: (x: Sql) => Promise<T>) => tenant(db.connect, w, fn);
  const q = (w: string, sql: string, values: unknown[] = []) => t(w, (x) => x.query(sql, values));
  const setPlan = (w: string, plan: string) => q(w, "UPDATE workspace_plans SET plan=$2 WHERE workspace_id=$1", [w, plan]);
  const refused = (fn: () => Promise<unknown>, pattern: RegExp) =>
    assert.rejects(fn, (e: { code?: string; message?: string }) => ["PLAN_REQUIRED", "PLAN_LIMIT"].includes(e.code ?? "") && pattern.test(e.message ?? ""));
  try {
    for (const w of ["a", "b"]) {
      await t(w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: "m".repeat(40), identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
    }
    await q("a", "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES('a','agent-1','agent-1-a','Agent one','agent')");

    // A new workspace is on Enterprise: everything is on.
    assert.equal(await t("a", (x) => planOf(x, "a")), "enterprise");
    assert.equal(await t("a", (x) => featureOn(x, "a", "workflows_v1")), true);
    const enterprisePages = (await t("a", (x) => settingsOverview(x, "a", "owner-a"))).pages as string[];
    for (const p of ["workflows", "teams", "whatsapp", "sms", "outbound", "sso", "plan"]) assert.ok(enterprisePages.includes(p), p);
    // An allowlist set while on Enterprise, to show it keeps applying after.
    await t("a", (x) => changeAccess(x, "a", "owner-a", { ip: "203.0.113.5" }, { action: "allowlists", app: ["203.0.113.0/24"], api: [] }));

    // Starter: Pro's product features are off, as if their flags were.
    await setPlan("a", "starter");
    assert.equal(await t("a", (x) => workflowsEnabled(x, "a")), false);
    assert.equal(await t("a", (x) => featureOn(x, "a", "workflows_v1")), false);
    assert.equal(await t("a", (x) => featureOn(x, "a", "knowledge_v1")), true, "ungated flags are untouched");
    const starterPages = (await t("a", (x) => settingsOverview(x, "a", "owner-a"))).pages as string[];
    for (const p of ["workflows", "teams", "whatsapp", "sms", "outbound"]) assert.ok(!starterPages.includes(p), p);
    for (const p of ["email", "plan", "audit", "health-check"]) assert.ok(starterPages.includes(p), p);
    // Only the messenger and email remain (Pro's channels are off; email registers when its module loads).
    const channels = (await t("a", (x) => enabledChannels(x, "a"))).map((c) => c.id);
    assert.ok(channels.includes("messenger") && channels.every((c) => ["messenger", "email"].includes(c)), channels.join(","));

    // Starter: security changes are refused, naming the plan; what's set keeps applying.
    await refused(() => t("a", (x) => changeAccess(x, "a", "owner-a", { ip: "203.0.113.5" }, { action: "allowlists", app: [], api: [] })), /IP allowlists are on the Enterprise plan/);
    await assert.rejects(t("a", (x) => assertNetwork(x, "a", "app", "198.51.100.1")), /network/, "the list set earlier still applies");
    await refused(() => t("a", (x) => changeRetention(x, "a", "owner-a", { action: "policies", policies: { conversations: 365 } })), /Retention policies are on the Enterprise plan/);
    await refused(() => t("a", (x) => changeDataProtection(x, "a", "owner-a", { action: "builtin", builtin: "card", on: true })), /Content redaction is on the Enterprise plan/);
    await refused(() => t("a", (x) => changeSupport(x, "a", "owner-a", { action: "grant", days: 1 }, true)), /Relay support access is on the Enterprise plan/);
    await refused(() => t("a", (x) => changeSso(x, "a", "owner-a", {}, {}, { action: "enforce", on: false })), /Single sign-on \(OIDC and SAML\) is on the Enterprise plan/);
    await refused(() => t("a", (x) => saveRole(x, "a", "owner-a", { name: "Leads", capabilities: ["conversations.read"] })), /Custom roles are on the Pro plan/);
    // Changes that aren't plan features still work.
    await t("a", (x) => changeDataProtection(x, "a", "owner-a", { action: "model", redactPersonalData: true, memory: false, historyMessages: 5 }));

    // Limits: Starter has one brand; Pro three.
    await refused(() => t("a", (x) => saveBrand(x, "a", "owner-a", { name: "Second brand" })), /^Your plan includes 1 brand, and you have 1\. Pro has more\.$/);
    await setPlan("a", "pro");
    await t("a", (x) => saveBrand(x, "a", "owner-a", { name: "Second brand" }));
    await t("a", (x) => saveBrand(x, "a", "owner-a", { name: "Third brand" }));
    await refused(() => t("a", (x) => saveBrand(x, "a", "owner-a", { name: "Fourth brand" })), /^Your plan includes 3 brands, and you have 3\. Enterprise has more\.$/);
    const centers = (await q("a", "SELECT count(*)::int AS n FROM help_centers")).rows[0].n as number;
    const brands = (await q("a", "SELECT id FROM brands ORDER BY id")).rows as { id: string }[];
    for (const b of brands.slice(0, 3 - centers)) await t("a", (x) => changeHelpCenter(x, "a", "owner-a", { op: "center_create", brandId: b.id, name: `Help ${b.id}` }));
    // A fourth brand (made on Enterprise), then back on Pro: its help center would be the fourth.
    await setPlan("a", "enterprise");
    const fourth = (await t("a", (x) => saveBrand(x, "a", "owner-a", { name: "Fourth brand" }))) as { id: string };
    await setPlan("a", "pro");
    await refused(() => t("a", (x) => changeHelpCenter(x, "a", "owner-a", { op: "center_create", brandId: fourth.id, name: "One too many" })), /3 help centers, and you have 3/);

    // Pro: features on; a custom role yes, a restricted one no.
    assert.equal(await t("a", (x) => workflowsEnabled(x, "a")), true);
    const role = (await t("a", (x) => saveRole(x, "a", "owner-a", { name: "Leads", capabilities: ["conversations.read"] }))) as { id: string };
    await refused(() => t("a", (x) => saveRole(x, "a", "owner-a", { id: role.id, name: "Leads", capabilities: ["conversations.read"], scope: "assigned" })), /Restricted roles are on the Enterprise plan/);

    // The Plan page: for billing.manage; usage, every tier, prices not set.
    const page = await t("a", (x) => readPlan(x, "a", "owner-a"));
    assert.equal(page.plan, "pro");
    assert.deepEqual(page.usage.brands, { label: "Brands", limit: 3, used: 4 }, "over the limit after a move down shows as such");
    assert.deepEqual(page.plans.map((p) => p.id), ["starter", "pro", "enterprise"]);
    assert.ok(page.plans[1].features.includes("workflows") && !page.plans[1].features.includes("sso"));
    assert.equal(page.pricesSet, false);
    await assert.rejects(t("a", (x) => readPlan(x, "a", "agent-1-a")), /permission/);
    await assert.rejects(t("b", (x) => readPlan(x, "b", "owner-a")), /permission/);
    // Another workspace's plan is its own; changing a plan is audited.
    assert.equal(await t("b", (x) => planOf(x, "b")), "enterprise");
    assert.ok((await q("a", "SELECT 1 FROM audit_events WHERE action='plan.changed'")).rows.length >= 2);

    // The rollback: every workspace back on Enterprise.
    await db.pg.exec(await readFile("db/rollback/0092_plans.sql", "utf8"));
    assert.equal(await t("a", (x) => planOf(x, "a")), "enterprise");
    assert.equal(await t("a", (x) => featureOn(x, "a", "workflows_v1")), true);
  } finally {
    await db.close();
  }
});
