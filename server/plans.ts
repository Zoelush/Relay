import { DomainError, type Sql } from "./db";
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
export async function planOf(db: Sql, w: string): Promise<PlanId> {
  const plan = (
    await db.query<{ plan: PlanId }>(
      "SELECT plan FROM workspace_plans WHERE workspace_id=$1",
      [w],
    )
  ).rows[0]?.plan;
  return plan ?? "enterprise";
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

/** Settings › Billing › Plan: the current plan, every tier and what it includes, usage of each limit, and prices. */
export async function readPlan(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "billing.manage");
  const plan = await planOf(db, w);
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
  };
}

/** Phase 16 C8b: the workspace's plan, its full seat's monthly price (null while a placeholder), and its billing period's anchor. */
export async function seatPrice(db: Sql, w: string) {
  const row = (await db.query<{ plan: PlanId; period_anchor: Date }>("SELECT plan,period_anchor FROM workspace_plans WHERE workspace_id=$1", [w])).rows[0];
  const plan = row?.plan ?? "enterprise";
  return { plan, planName: PLANS[plan].name, monthlyCents: PLANS[plan].monthlyCents, anchor: row ? new Date(row.period_anchor) : new Date() };
}

/** Phase 16 C9a: each meter's price per unit (null while a placeholder). */
export const unitPrices = () => ({ ...UNIT_PRICES });
