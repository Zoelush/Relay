import test from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database";
import { tenant } from "../server/db";
import { seedFoundation } from "../server/people";
import { bridgeAgentRequest } from "../server/agent-bridge";
import { handleApi, type ApiEnvironment } from "../server/api";
import { applyPlanChanges, assertGate, assertWithinLimit, planInForce, planOf, planRow, readPlan, TRIAL } from "../server/plans";
import { buildInvoice } from "../server/invoices";
import { periodOf } from "../lib/seats";
import type { PriceBook } from "../lib/invoices";

/** Trials, upgrades and downgrades (phase 16, C10b; docs/SECURITY_STEP21.md). */
const PRICES: PriceBook = {
  seat: { starter: 2900, pro: 5900, enterprise: 11900 },
  units: { ai_resolutions: 99, ai_resolutions_own_key: 29, emails: 0.4, whatsapp: 5, sms_segments: 2, phone_minutes: 3, outbound_chats: 1, outbound_banners: 0.5, connector_calls: 0.2 },
};
const day = 86_400_000;

test("plan changes: a trial taken once, an upgrade at once with its difference prorated, a downgrade at the period's end", async () => {
  const db = await testDatabase();
  const api: ApiEnvironment = {
    connect: db.connect,
    sessionSecret: "s".repeat(40),
    identityMaster: "m".repeat(40),
    bridgeSecret: "b".repeat(40),
    storageTransport: "local-pglite",
  };
  const q = <T = any>(w: string, sql: string, values: unknown[] = []) => tenant(db.connect, w, async (x) => (await x.query<T>(sql, values)).rows);
  const agent = async (path: string, data?: unknown, principal = "owner-a", w = "a") => {
    const r = await bridgeAgentRequest(
      new Request("https://app.test/api/agent/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: { origin: "https://app.test", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      principal,
      { RELAY_AGENT_INBOX_V1: "true", RELAY_STORAGE_AUTHORITY: "postgres", RELAY_API_ORIGIN: "https://relay.test", RELAY_WORKSPACE_ID: w, RELAY_BRIDGE_SECRET: api.bridgeSecret },
      (x) => handleApi(x, api),
    );
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  const plan = (data?: unknown, principal = "owner-a") => agent("plan", data, principal);
  const inForce = () => tenant(db.connect, "a", (x) => planOf(x, "a"));
  const ledger = () => q<{ kind: string; from_plan: string; to_plan: string }>("a", "SELECT kind,from_plan,to_plan FROM plan_changes ORDER BY seq");
  try {
    for (const w of ["a", "b"]) {
      await tenant(db.connect, w, (x) => seedFoundation(x, w, "owner-" + w, { origins: [], master: api.identityMaster, identitySecret: new TextEncoder().encode("i".repeat(32)), enable: true }));
      await q(w, "UPDATE workspace_features SET enabled=true");
      await q(w, "DELETE FROM calendar_assignments");
      await q(w, "INSERT INTO teammates(workspace_id,id,principal_id,name,role_id) VALUES($1,'agent-1','agent-1-' || $1,'Agent one','agent')", [w]);
    }
    // Workspaces start on Enterprise (C8a); this one takes the smallest plan to try the rest.
    await q("a", "UPDATE workspace_plans SET plan='starter'");
    assert.equal(await inForce(), "starter");
    await tenant(db.connect, "a", async (x) => {
      await assert.rejects(assertGate(x, "a", "workflows"), /Workflows are on the Pro plan/);
    });

    // The trial: a fortnight of Pro, no card, taken once.
    const started = await plan({ action: "start_trial" });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.plan, TRIAL.plan);
    assert.equal(started.body.trial.days, 14);
    assert.equal(started.body.trialAvailable, false);
    assert.equal(await inForce(), "pro", "the plan in force is the trial's");
    await tenant(db.connect, "a", (x) => assertGate(x, "a", "workflows"));
    assert.equal((await plan({ action: "start_trial" })).body.error.code, "TRIAL_USED");
    const row = (await tenant(db.connect, "a", (x) => planRow(x, "a")))!;
    assert.equal(planInForce(row, new Date(Date.now() + 13 * day)), "pro", "on its last day");
    assert.equal(planInForce(row, new Date(Date.now() + 15 * day)), "starter", "and Starter after it, before the sweep runs");

    // The sweep tidies the ended trial away and writes it down.
    assert.deepEqual(await applyPlanChanges(db.connect, "a", new Date(Date.now() + 15 * day)), ["trial_ended"]);
    assert.equal(await inForce(), "starter");
    assert.deepEqual(
      (await ledger()).map((c) => [c.kind, c.from_plan, c.to_plan]),
      [
        ["trial_started", "starter", "pro"],
        ["trial_ended", "pro", "starter"],
      ],
    );
    assert.deepEqual(await applyPlanChanges(db.connect, "a", new Date(Date.now() + 16 * day)), [], "nothing left to do");

    // An upgrade: at once.
    const anchor = new Date(Date.now() - 10 * day);
    await q("a", "UPDATE workspace_plans SET period_anchor=$1", [anchor]);
    const upgraded = await plan({ action: "change", plan: "pro" });
    assert.equal(upgraded.status, 200, JSON.stringify(upgraded.body));
    assert.equal(upgraded.body.plan, "pro");
    assert.equal(await inForce(), "pro");
    assert.equal((await plan({ action: "change", plan: "pro" })).body.error.code, "SAME_PLAN");
    assert.equal((await plan({ action: "change", plan: "nothing" })).body.error.code, "INVALID_FIELD");

    // A downgrade waits for the end of the period already paid for, and can be called off.
    const period = periodOf(anchor, new Date());
    const scheduled = await plan({ action: "change", plan: "starter" });
    assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
    assert.equal(scheduled.body.plan, "pro", "still Pro until then");
    assert.equal(scheduled.body.pending.plan, "starter");
    assert.equal(Date.parse(scheduled.body.pending.from), period.end.getTime());
    const pendingRow = (await tenant(db.connect, "a", (x) => planRow(x, "a")))!;
    assert.equal(planInForce(pendingRow, new Date(period.end.getTime() + 1000)), "starter", "right on time, before the sweep");
    const cancelled = await plan({ action: "cancel_change" });
    assert.equal(cancelled.body.pending, null);
    assert.equal((await plan({ action: "cancel_change" })).body.error.code, "NOTHING_SCHEDULED");
    // Scheduled again, then applied by the sweep.
    await plan({ action: "change", plan: "starter" });
    assert.deepEqual(await applyPlanChanges(db.connect, "a", new Date(period.end.getTime() + 1000)), ["downgraded"]);
    assert.equal(await inForce(), "starter");
    assert.equal((await q<{ plan: string; pending_plan: string | null }>("a", "SELECT plan,pending_plan FROM workspace_plans"))[0].pending_plan, null);

    // Data is kept, new things are blocked: the brand stays, a second one is refused on Starter.
    assert.equal((await q("a", "SELECT 1 FROM brands")).length, 1);
    await tenant(db.connect, "a", async (x) => {
      await assert.rejects(assertWithinLimit(x, "a", "brands"), /Your plan includes 1 brand/);
      await assert.rejects(assertGate(x, "a", "workflows"), /Workflows are on the Pro plan/);
    });

    // An upgrade calls off a scheduled downgrade, and ends a running trial.
    await q("a", "UPDATE workspace_plans SET trial_used=false");
    await plan({ action: "start_trial" });
    const second = await plan({ action: "change", plan: "enterprise" });
    assert.equal(second.body.plan, "enterprise");
    assert.equal(second.body.trial, null, "the trial ends with the upgrade");
    assert.deepEqual((await ledger()).slice(-2).map((c) => c.kind), ["trial_ended", "upgraded"]);

    // The ledger is append-only, and the plan's changes are audited.
    await assert.rejects(q("a", "UPDATE plan_changes SET to_plan='starter'"), /append-only/);
    await assert.rejects(q("a", "DELETE FROM plan_changes"), /append-only/);
    assert.ok((await q("a", "SELECT 1 FROM audit_events WHERE action='plan.changed'")).length >= 2);

    // Only a billing manager changes the plan.
    assert.equal((await plan({ action: "change", plan: "starter" }, "agent-1-a")).status, 403);
    assert.equal((await agent("plan", undefined, "agent-1-a")).status, 403);
    // And only in their own workspace: b is untouched by all of this.
    assert.equal(await tenant(db.connect, "b", (x) => planOf(x, "b")), "enterprise");
    assert.deepEqual(await q("b", "SELECT 1 FROM plan_changes"), []);

    // The upgrade's difference, prorated on the next invoice: read from the plan ledger, never
    // counted. Workspace b, whose ledger is empty, so the line under test is the only one.
    await q("b", "UPDATE workspace_plans SET plan='pro',period_anchor=$1", [anchor]);
    const previous = periodOf(anchor, new Date());
    const next = periodOf(anchor, new Date(previous.end.getTime() + 1000));
    const at = new Date(previous.start.getTime() + (previous.end.getTime() - previous.start.getTime()) / 2);
    await q("b", "INSERT INTO plan_changes(workspace_id,kind,from_plan,to_plan,at,effective_at) VALUES('b','upgraded','starter','pro',$1,$1)", [at]);
    const built = await tenant(db.connect, "b", (x) => buildInvoice(x, "b", next, PRICES));
    const line = built.lines.find((l) => l.kind === "plan_change");
    assert.ok(line, JSON.stringify(built.lines.map((l) => l.kind)));
    assert.equal(line!.description, "Upgrade to Pro partway through the last period");
    assert.equal(line!.unitCents, 3000, "the difference between Starter and Pro");
    assert.ok(Math.abs(line!.quantity - 1) < 0.02, `half a period for two full seats: ${line!.quantity}`);
    assert.equal(line!.amountCents, Math.round(line!.quantity * 3000));
    assert.equal(line!.units.length, 1, "frozen with the change it came from");
    assert.match(line!.units[0].detail, /Starter to Pro, 2 full seats/);

    // The page says what is happening, in order.
    const page = await tenant(db.connect, "a", (x) => readPlan(x, "a", "owner-a"));
    assert.equal(page.plan, "enterprise");
    assert.equal(page.trialAvailable, false, "the trial is offered once");
    assert.equal(page.history[0].kind, "upgraded");

    // Rollback: no plan changes anywhere, and nothing a workspace uses switches off.
    await q("a", "UPDATE workspace_plans SET plan='starter',trial_plan='pro',trial_ends_at=now()+interval '3 days',pending_plan='starter',pending_from=now()+interval '9 days'");
    await q("a", "UPDATE workspace_plans SET plan=trial_plan WHERE trial_plan IS NOT NULL AND trial_ends_at > now()");
    await q("a", "UPDATE workspace_plans SET trial_plan=NULL,trial_ends_at=NULL,pending_plan=NULL,pending_from=NULL");
    assert.equal(await inForce(), "pro", "the trial's plan becomes the plan");
  } finally {
    await db.close();
  }
});
