import { assert, DomainError, type Sql } from "./db";
import { authorize } from "./policy";
import { unitPrices } from "./plans";
import { meterTotal, periodFor } from "./meters";
import { METER_IDS, METERS, type MeterId } from "../lib/meters";

/**
 * Limits and the spend cap (phase 16, step C9b; docs/SECURITY_STEP17.md). A meter's limit is a
 * number of units per billing period; the spend cap is on metered usage. Reaching either pauses
 * automated sends only (never the product): `pausedFor` is asked, exactly, at each one:
 *
 * - Zoe (AI resolutions; on a call, phone minutes too) hands the conversation to the team;
 * - outbound chats and banners wait (`admit`'s "later");
 * - Zoe's, workflows' and away messages on email, WhatsApp and SMS are held to the period's end
 *   (`limit_held`), released at once when the limit is raised;
 * - Zoe's and workflows' connector calls are refused.
 *
 * Teammates' own replies, calls and the inbox are never paused. Two sends at the same moment can
 * both pass a limit; that's accepted.
 */
export const CHANNEL_METER: Record<string, MeterId> = { email: "emails", whatsapp: "whatsapp", sms: "sms_segments" };

/** Why a meter's automated sends are paused this period, or null. */
export async function pausedFor(db: Sql, w: string, meter: MeterId, now = new Date()) {
  const limit = (await db.query<{ units: number }>("SELECT units FROM usage_limits WHERE workspace_id=$1 AND meter=$2", [w, meter])).rows[0]?.units;
  const cap = (await db.query<{ spend_cap_cents: number | null }>("SELECT spend_cap_cents FROM usage_settings WHERE workspace_id=$1", [w])).rows[0]?.spend_cap_cents ?? null;
  if (limit === undefined && cap === null) return null;
  const period = await periodFor(db, w, "current", now);
  if (limit !== undefined && (await meterTotal(db, w, meter, period)) >= limit) return `This period's limit for ${METERS[meter].noun} (${limit.toLocaleString("en")}) is reached.`;
  if (cap !== null) {
    const spend = await spent(db, w, period);
    if (spend !== null && spend >= cap) return "This period's spend cap is reached.";
  }
  return null;
}

/** Metered spend this period, in cents; null while any price is a placeholder. */
async function spent(db: Sql, w: string, period: Awaited<ReturnType<typeof periodFor>>) {
  const prices = unitPrices();
  if (METER_IDS.some((m) => prices[m] === null)) return null;
  let total = 0;
  for (const m of METER_IDS) total += (await meterTotal(db, w, m, period)) * prices[m]!;
  return total;
}

export async function readLimits(db: Sql, w: string, now = new Date()) {
  const rows = (await db.query<{ meter: MeterId; units: number }>("SELECT meter,units FROM usage_limits WHERE workspace_id=$1", [w])).rows;
  const cap = (await db.query<{ spend_cap_cents: number | null }>("SELECT spend_cap_cents FROM usage_settings WHERE workspace_id=$1", [w])).rows[0]?.spend_cap_cents ?? null;
  const paused: Partial<Record<MeterId, string>> = {};
  for (const m of METER_IDS) {
    const why = await pausedFor(db, w, m, now);
    if (why) paused[m] = why;
  }
  const period = await periodFor(db, w, "current", now);
  return {
    limits: Object.fromEntries(METER_IDS.map((m) => [m, rows.find((r) => r.meter === m)?.units ?? null])) as Record<MeterId, number | null>,
    spendCapCents: cap,
    capApplies: Object.values(unitPrices()).every((p) => p !== null),
    spentCents: await spent(db, w, period),
    paused,
  };
}

/** Set limits (a number per meter, or null for none) and the spend cap; held messages are released when no longer over. */
export async function changeLimits(db: Sql, w: string, principal: string, p: Record<string, unknown>) {
  const me = await authorize(db, w, principal, "billing.manage");
  const limits = (p.limits ?? {}) as Record<string, unknown>;
  for (const [meter, value] of Object.entries(limits)) {
    assert(METER_IDS.includes(meter as MeterId), "INVALID_FIELD", "Choose a meter.");
    if (value === null || value === "") {
      await db.query("DELETE FROM usage_limits WHERE workspace_id=$1 AND meter=$2", [w, meter]);
      continue;
    }
    const units = Number(value);
    if (!Number.isInteger(units) || units < 1 || units > 100_000_000) throw new DomainError("INVALID_FIELD", `A limit is a whole number of ${METERS[meter as MeterId].unit}s, at least 1.`, 400, { meter });
    await db.query(
      "INSERT INTO usage_limits(workspace_id,meter,units,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,meter) DO UPDATE SET units=EXCLUDED.units,updated_by=EXCLUDED.updated_by,updated_at=now()",
      [w, meter, units, me.id],
    );
  }
  if ("spendCapCents" in p) {
    const cap = p.spendCapCents === null || p.spendCapCents === "" ? null : Number(p.spendCapCents);
    if (cap !== null && (!Number.isInteger(cap) || cap < 100 || cap > 1_000_000_000)) throw new DomainError("INVALID_FIELD", "A spend cap is at least $1.00.", 400, { field: "spendCapCents" });
    await db.query(
      `INSERT INTO usage_settings(workspace_id,spend_cap_cents,updated_by) VALUES($1,$2,$3)
       ON CONFLICT(workspace_id) DO UPDATE SET spend_cap_cents=EXCLUDED.spend_cap_cents,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [w, cap, me.id],
    );
  }
  // Messages a limit held go now (the sweep sends them) when their meter isn't paused any more.
  for (const [channel, meter] of Object.entries(CHANNEL_METER))
    if (!(await pausedFor(db, w, meter)))
      await db.query("UPDATE channel_deliveries SET not_before=now(),limit_held=false,error='' WHERE workspace_id=$1 AND channel=$2 AND limit_held", [w, channel]);
  return readLimits(db, w);
}
