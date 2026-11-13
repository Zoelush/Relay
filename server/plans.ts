import type { PriceBook } from "../lib/invoices";
import { DomainError, tenant, type Connect, type Sql } from "./db";
import { periodOf } from "../lib/seats";
import { authorize } from "./policy";
import {
  FEATURES,
  FLAG_FEATURE,
  includes,
  LIMITS,
  limitOf,
  PLAN_IDS,
  PLANS,
  placeholders,
  UNIT_PRICES,
  type Feature,
  type Limit,
  type PlanId,
} from "../lib/plans";

/**
 * The one plan gate (phase 16, step C8a; docs/SECURITY_STEP14.md). Nothing else reads a workspace's
 * plan or the plan policy (`lib/plans.ts`) to decide anything; `tests/plans.test.ts` fails on a
 * plan check, or a raw read of a plan-gated rollout flag, anywhere else.
 *
 * - `featureOn`: a product feature's rollout flag and the plan, together. Beyond the plan, the
 *   feature is off exactly as if its flag were.
 * - `gate` / `assertGate`: whether the plan includes a feature. Security features beyond the plan
 *   refuse changes, but what's configured keeps applying (never weaken security silently).
 * - `limit` / `assertWithinLimit`: a plan's number of brands or help centers.
 */
export type PlanRow = {
  plan: PlanId;
  period_anchor: Date;
  trial_plan: PlanId | null;
  trial_ends_at: Date | null;
  trial_used: boolean;
  pending_plan: PlanId | null;
  pending_from: Date | null;
};
const PLAN_ROW =
  "SELECT plan,period_anchor,trial_plan,trial_ends_at,trial_used,pending_plan,pending_from FROM workspace_plans";
export async function planRow(db: Sql, w: string) {
  return (await db.query<PlanRow>(`${PLAN_ROW} WHERE workspace_id=$1`, [w])).rows[0] ?? null;
}
/**
 * The plan in force (phase 16 C10b): a running trial's plan, then a scheduled downgrade whose time
 * has come (so the gate is right even before the sweep tidies it), then the plan itself.
 */
export function planInForce(row: PlanRow | null, now = new Date()): PlanId {
  if (!row) return "enterprise";
  if (row.trial_plan && row.trial_ends_at && new Date(row.trial_ends_at) > now) return row.trial_plan;
  if (row.pending_plan && row.pending_from && new Date(row.pending_from) <= now) return row.pending_plan;
  return row.plan;
}
export async function planOf(db: Sql, w: string): Promise<PlanId> {
  return planInForce(await planRow(db, w));
}
export const gate = async (db: Sql, w: string, feature: Feature) =>
  includes(await planOf(db, w), feature);
export async function assertGate(db: Sql, w: string, feature: Feature) {
  if (!(await gate(db, w, feature))) {
    const needs = PLANS[FEATURES[feature].plan].name;
    throw new DomainError(
      "PLAN_REQUIRED",
      `${FEATURES[feature].label} ${FEATURES[feature].plural ? "are" : "is"} on the ${needs} plan.`,
      403,
      { feature, plan: FEATURES[feature].plan },
    );
  }
}

/** A rollout flag, and the plan when the flag's feature is gated. */
export async function featureOn(db: Sql, w: string, flag: string) {
  const on =
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name=$2 AND enabled",
        [w, flag],
      )
    ).rows.length > 0;
  return on && (!FLAG_FEATURE[flag] || (await gate(db, w, FLAG_FEATURE[flag])));
}
/** Which of these flags are on, plan included (for lists of flags read at once). */
export async function flagsOn(db: Sql, w: string) {
  const plan = await planOf(db, w);
  return new Set(
    (
      await db.query<{ name: string }>(
        "SELECT name FROM workspace_features WHERE workspace_id=$1 AND enabled",
        [w],
      )
    ).rows
      .map((r) => r.name)
      .filter(
        (name) => !FLAG_FEATURE[name] || includes(plan, FLAG_FEATURE[name]),
      ),
  );
}

const COUNTS: Record<Limit, string> = {
  brands: "SELECT count(*)::int AS n FROM brands WHERE workspace_id=$1",
  help_centers:
    "SELECT count(*)::int AS n FROM help_centers WHERE workspace_id=$1",
};
export async function limit(db: Sql, w: string, which: Limit) {
  const used = (await db.query<{ n: number }>(COUNTS[which], [w])).rows[0].n;
  return { limit: limitOf(await planOf(db, w), which), used };
}
/** Before creating one more: refused at the plan's number. */
export async function assertWithinLimit(db: Sql, w: string, which: Limit) {
  const l = await limit(db, w, which);
  if (l.limit !== null && l.used >= l.limit) {
    const next = PLAN_IDS.find(
      (id) => (limitOf(id, which) ?? Infinity) > l.used,
    );
    throw new DomainError(
      "PLAN_LIMIT",
      `Your plan includes ${l.limit} ${(l.limit === 1 ? LIMITS[which].label.slice(0, -1) : LIMITS[which].label).toLowerCase()}, and you have ${l.used}.${next ? ` ${PLANS[next].name} has more.` : ""}`,
      403,
      { limit: which, of: l.limit },
    );
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Trials, upgrades and downgrades (phase 16, step C10b; docs/SECURITY_STEP21.md)               */

/** The trial Relay offers: a fortnight of Pro, taken once, with no card. */
export const TRIAL = { plan: "pro" as PlanId, days: 14 };
export type PlanChangeKind = "trial_started" | "trial_ended" | "upgraded" | "downgrade_scheduled" | "downgrade_cancelled" | "downgraded";
const RANK_OF: Record<PlanId, number> = { starter: 0, pro: 1, enterprise: 2 };
const isPlan = (v: unknown): v is PlanId => PLAN_IDS.includes(v as PlanId);

async function recordPlanChange(
  db: Sql,
  w: string,
  c: { kind: PlanChangeKind; from: PlanId; to: PlanId; effectiveAt?: Date; actor?: { id: string; name: string } },
) {
  await db.query(
    `INSERT INTO plan_changes(workspace_id,kind,from_plan,to_plan,effective_at,actor_id,actor_name)
     VALUES($1,$2,$3,$4,COALESCE($5,clock_timestamp()),$6,$7)`,
    [w, c.kind, c.from, c.to, c.effectiveAt ?? null, c.actor?.id ?? null, c.actor?.name ?? null],
  );
}

/**
 * Changing plan (`billing.manage`): starting the trial, upgrading (at once, its difference
 * prorated on the next invoice), scheduling a downgrade for the end of the period already paid
 * for, and calling that off. Every one is written to the ledger the invoice reads.
 */
export async function changePlan(db: Sql, w: string, principal: string, p: Record<string, unknown>, now = new Date()) {
  const me = await authorize(db, w, principal, "billing.manage");
  const row = await planRow(db, w);
  if (!row) throw new DomainError("NOT_FOUND", "This workspace has no plan.", 404);
  const actor = { id: me.id, name: me.name };
  const inForce = planInForce(row, now);
  const trialRunning = !!row.trial_plan && !!row.trial_ends_at && new Date(row.trial_ends_at) > now;

  if (p.action === "start_trial") {
    if (row.trial_used) throw new DomainError("TRIAL_USED", "This workspace has already had its trial.", 409);
    if (inForce !== "starter") throw new DomainError("TRIAL_NOT_NEEDED", `The trial is a fortnight of ${PLANS[TRIAL.plan].name}, and you are already on ${PLANS[inForce].name}.`, 409);
    const ends = new Date(now.getTime() + TRIAL.days * 86_400_000);
    await db.query("UPDATE workspace_plans SET trial_plan=$2,trial_ends_at=$3,trial_used=true,updated_by=$4,updated_at=now() WHERE workspace_id=$1", [w, TRIAL.plan, ends, me.id]);
    await recordPlanChange(db, w, { kind: "trial_started", from: inForce, to: TRIAL.plan, actor });
    return readPlan(db, w, principal, now);
  }

  if (p.action === "change") {
    const to = p.plan;
    if (!isPlan(to)) throw new DomainError("INVALID_FIELD", "Choose one of the plans.", 400, { field: "plan" });
    if (to === inForce) throw new DomainError("SAME_PLAN", `You are already on ${PLANS[to].name}.`, 409);
    if (RANK_OF[to] > RANK_OF[inForce]) {
      // An upgrade applies at once; a running trial ends with it, and a scheduled downgrade is off.
      if (trialRunning) await recordPlanChange(db, w, { kind: "trial_ended", from: row.trial_plan!, to, actor });
      if (row.pending_plan) await recordPlanChange(db, w, { kind: "downgrade_cancelled", from: inForce, to: row.pending_plan, actor });
      await db.query("UPDATE workspace_plans SET plan=$2,trial_plan=NULL,trial_ends_at=NULL,pending_plan=NULL,pending_from=NULL,updated_by=$3,updated_at=now() WHERE workspace_id=$1", [w, to, me.id]);
      await recordPlanChange(db, w, { kind: "upgraded", from: inForce, to, actor });
      return readPlan(db, w, principal, now);
    }
    // A downgrade waits for the end of the period already paid for (a trial, for its last day).
    const from = trialRunning ? new Date(row.trial_ends_at!) : periodOf(new Date(row.period_anchor), now).end;
    if (trialRunning && to === row.plan)
      throw new DomainError("ALREADY_ENDING", `Your trial already ends on ${from.toISOString().slice(0, 10)}, and you go to ${PLANS[row.plan].name} then.`, 409);
    await db.query("UPDATE workspace_plans SET pending_plan=$2,pending_from=$3,updated_by=$4,updated_at=now() WHERE workspace_id=$1", [w, to, from, me.id]);
    await recordPlanChange(db, w, { kind: "downgrade_scheduled", from: inForce, to, effectiveAt: from, actor });
    return readPlan(db, w, principal, now);
  }

  if (p.action === "cancel_change") {
    if (!row.pending_plan) throw new DomainError("NOTHING_SCHEDULED", "No plan change is waiting.", 409);
    if (row.pending_from && new Date(row.pending_from) <= now) throw new DomainError("ALREADY_APPLIED", "That change has already taken effect.", 409);
    await db.query("UPDATE workspace_plans SET pending_plan=NULL,pending_from=NULL,updated_by=$2,updated_at=now() WHERE workspace_id=$1", [w, me.id]);
    await recordPlanChange(db, w, { kind: "downgrade_cancelled", from: inForce, to: row.pending_plan, actor });
    return readPlan(db, w, principal, now);
  }
  throw new DomainError("INVALID_FIELD", "Unknown plan change.", 400);
}

/**
 * The sweep: a trial that has run its course, and a downgrade whose time has come, written to the
 * ledger and tidied away. `planInForce` already reads both, so nothing waits on this to be right.
 */
export async function applyPlanChanges(connect: Connect, w: string, now = new Date()) {
  return tenant(connect, w, async (db) => {
    const row = (await db.query<PlanRow>(`${PLAN_ROW} WHERE workspace_id=$1 FOR UPDATE`, [w])).rows[0];
    if (!row) return null;
    const done: PlanChangeKind[] = [];
    if (row.trial_plan && row.trial_ends_at && new Date(row.trial_ends_at) <= now) {
      await recordPlanChange(db, w, { kind: "trial_ended", from: row.trial_plan, to: row.plan, effectiveAt: new Date(row.trial_ends_at) });
      await db.query("UPDATE workspace_plans SET trial_plan=NULL,trial_ends_at=NULL,updated_at=now() WHERE workspace_id=$1", [w]);
      done.push("trial_ended");
    }
    if (row.pending_plan && row.pending_from && new Date(row.pending_from) <= now) {
      await recordPlanChange(db, w, { kind: "downgraded", from: row.plan, to: row.pending_plan, effectiveAt: new Date(row.pending_from) });
      await db.query("UPDATE workspace_plans SET plan=$2,pending_plan=NULL,pending_from=NULL,updated_at=now() WHERE workspace_id=$1", [w, row.pending_plan]);
      done.push("downgraded");
    }
    return done;
  });
}

/** Settings › Billing › Plan: the current plan, every tier and what it includes, usage of each limit, and prices. */
export async function readPlan(db: Sql, w: string, principal: string, now = new Date()) {
  await authorize(db, w, principal, "billing.manage");
  const row = await planRow(db, w);
  const plan = planInForce(row, now);
  const trialRunning = !!row?.trial_plan && !!row.trial_ends_at && new Date(row.trial_ends_at) > now;
  const changes = (
    await db.query<{ kind: PlanChangeKind; from_plan: PlanId; to_plan: PlanId; at: Date; effective_at: Date; actor_name: string | null }>(
      "SELECT kind,from_plan,to_plan,at,effective_at,actor_name FROM plan_changes WHERE workspace_id=$1 ORDER BY seq DESC LIMIT 20",
      [w],
    )
  ).rows;
  return {
    plan,
    plans: PLAN_IDS.map((id) => ({
      id,
      name: PLANS[id].name,
      summary: PLANS[id].summary,
      monthlyCents: PLANS[id].monthlyCents,
      annualMonthlyCents: PLANS[id].annualMonthlyCents,
      features: (Object.keys(FEATURES) as Feature[]).filter((f) =>
        includes(id, f),
      ),
      limits: Object.fromEntries(
        (Object.keys(LIMITS) as Limit[]).map((l) => [l, limitOf(id, l)]),
      ),
    })),
    features: Object.fromEntries(
      (Object.keys(FEATURES) as Feature[]).map((f) => [f, FEATURES[f].label]),
    ),
    usage: Object.fromEntries(
      await (async () => {
        const out: [
          Limit,
          { label: string; limit: number | null; used: number },
        ][] = [];
        for (const l of Object.keys(LIMITS) as Limit[])
          out.push([l, { label: LIMITS[l].label, ...(await limit(db, w, l)) }]);
        return out;
      })(),
    ),
    pricesSet: placeholders().length === 0,
    // C10b: the trial, a change waiting for the period's end, and what has happened to the plan.
    trial: trialRunning
      ? { plan: row!.trial_plan!, endsAt: new Date(row!.trial_ends_at!).toISOString(), days: TRIAL.days }
      : null,
    trialAvailable: !row?.trial_used && plan === "starter",
    trialPlan: TRIAL.plan,
    trialDays: TRIAL.days,
    pending: row?.pending_plan && row.pending_from ? { plan: row.pending_plan, from: new Date(row.pending_from).toISOString() } : null,
    periodEnd: row ? periodOf(new Date(row.period_anchor), now).end.toISOString() : null,
    history: changes.map((c) => ({
      kind: c.kind,
      from: c.from_plan,
      to: c.to_plan,
      at: new Date(c.at).toISOString(),
      effectiveAt: new Date(c.effective_at).toISOString(),
      by: c.actor_name,
    })),
  };
}

/** Phase 16 C8b: the workspace's plan, its full seat's monthly price (null while a placeholder), and its billing period's anchor. */
export async function seatPrice(db: Sql, w: string, now = new Date()) {
  const row = await planRow(db, w);
  const plan = planInForce(row, now);
  return { plan, planName: PLANS[plan].name, monthlyCents: PLANS[plan].monthlyCents, anchor: row ? new Date(row.period_anchor) : new Date() };
}

/**
 * The paired test workspace: its plan is its production workspace's, so the features and limits a
 * test proves are the ones production has. Read there, written here, in the test workspace's own
 * transaction — the only place outside this module that would otherwise touch `workspace_plans`.
 */
export async function copyPlanInto(db: Sql, test: string, from: { plan: PlanId; anchor: Date }) {
  await db.query("INSERT INTO workspace_plans(workspace_id,plan,period_anchor) VALUES($1,$2,$3) ON CONFLICT(workspace_id) DO UPDATE SET plan=EXCLUDED.plan,period_anchor=EXCLUDED.period_anchor", [
    test,
    from.plan,
    from.anchor,
  ]);
}
/** A plan's name, for anything that shows one (the id if it is one Relay no longer has). */
export const planLabel = (id: string) => PLANS[id as PlanId]?.name ?? id;
/** Phase 16 C9a: each meter's price per unit (null while a placeholder). */
export const unitPrices = () => ({ ...UNIT_PRICES });
/** Phase 16 C10a: every price an invoice needs (a full seat on each plan, each meter's unit). */
export const priceBook = (): PriceBook => ({
  seat: Object.fromEntries(PLAN_IDS.map((id) => [id, PLANS[id].monthlyCents])) as PriceBook["seat"],
  units: unitPrices(),
});
