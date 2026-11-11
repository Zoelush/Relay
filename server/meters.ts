import { assert, type Sql } from "./db";
import { authorize } from "./policy";
import { seatPrice, unitPrices } from "./plans";
import { periodOf, type Period } from "../lib/seats";
import { segmentsOf } from "../lib/sms";
import { METER_IDS, METERS, type MeterId, type Unit } from "../lib/meters";

/**
 * The meters (phase 16, step C9a; docs/SECURITY_STEP16.md): each billable unit read from its source
 * record for a billing period, never counted. Every unit keeps its id, time, quantity and the
 * conversation (or contact) it came from, so an invoice line can be traced unit by unit.
 * Settings › Billing › Usage (`billing.manage`) shows them. Nothing here writes.
 */
type Row = { id: string; at: Date; quantity: number; conversation_id: string | null; contact_id: string | null; detail: string; body?: string };
const SENT = "('sent','delivered','read')";
const deliveries = (channel: string, withBody = false) =>
  `SELECT d.id,d.created_at AS at,1 AS quantity,d.conversation_id,NULL::text AS contact_id,d.purpose AS detail${withBody ? ",p.body" : ""}
   FROM channel_deliveries d${withBody ? " JOIN conversation_parts p ON p.workspace_id=d.workspace_id AND p.id=d.part_id" : ""}
   WHERE d.workspace_id=$1 AND d.channel='${channel}' AND d.status IN ${SENT} AND d.created_at>=$2 AND d.created_at<$3`;
const outbound = (type: "chat" | "banner") =>
  `SELECT e.id,COALESCE(e.entered_at,e.created_at) AS at,1 AS quantity,e.conversation_id,e.contact_id,m.title AS detail
   FROM outbound_entries e JOIN outbound_messages m ON m.workspace_id=e.workspace_id AND m.id=e.message_id
   WHERE e.workspace_id=$1 AND e.status='sent' AND m.type='${type}' AND COALESCE(e.entered_at,e.created_at)>=$2 AND COALESCE(e.entered_at,e.created_at)<$3`;
// Phase 16 C9d: resolutions by whose AI key answered (the ledger's `key_source`; a reversal carries its resolution's).
const resolutions = (key: "relay" | "workspace") =>
  `SELECT r.id,r.recorded_at AS at,CASE r.kind WHEN 'resolution' THEN 1 ELSE -1 END AS quantity,r.conversation_id,NULL::text AS contact_id,
     CASE r.kind WHEN 'resolution' THEN 'Resolved (' || replace(r.rule,'_',' ') || ')' ELSE 'Reversed' END AS detail
     FROM ai_resolutions r WHERE r.workspace_id=$1 AND r.key_source='${key}' AND r.recorded_at>=$2 AND r.recorded_at<$3`;
/** Each meter's units, as one query over its source ($1 workspace, $2 period start, $3 period end). */
const SOURCES: Record<MeterId, string> = {
  ai_resolutions: resolutions("relay"),
  ai_resolutions_own_key: resolutions("workspace"),
  emails: deliveries("email"),
  whatsapp: deliveries("whatsapp"),
  sms_segments: deliveries("sms", true),
  phone_minutes: `SELECT c.id,c.started_at AS at,ceil(c.duration_seconds/60.0)::int AS quantity,c.conversation_id,NULL::text AS contact_id,
     c.duration_seconds || ' seconds' AS detail
     FROM voice_calls c WHERE c.workspace_id=$1 AND c.status='completed' AND c.duration_seconds>0 AND c.started_at>=$2 AND c.started_at<$3`,
  outbound_chats: outbound("chat"),
  outbound_banners: outbound("banner"),
  connector_calls: `SELECT k.id,k.created_at AS at,1 AS quantity,k.conversation_id,NULL::text AS contact_id,n.name AS detail
     FROM ai_connector_calls k JOIN ai_connectors n ON n.workspace_id=k.workspace_id AND n.id=k.connector_id
     WHERE k.workspace_id=$1 AND k.source IN ('agent','workflow') AND k.result='ok' AND k.created_at>=$2 AND k.created_at<$3`,
};
const toUnit = (meter: MeterId, r: Row): Unit => ({
  id: r.id,
  at: new Date(r.at).toISOString(),
  // An SMS's segments are counted from its message, by the same rule as the composer and the limit.
  quantity: meter === "sms_segments" ? segmentsOf(r.body ?? "").segments : Number(r.quantity),
  conversationId: r.conversation_id,
  contactId: r.contact_id,
  detail: r.detail,
});

/** A meter's units in a period, in time order, 50 at a time after a cursor. */
export async function meterUnits(db: Sql, w: string, meter: MeterId, period: Period, after: { at: string; id: string } | null = null, limit = 50) {
  const values: unknown[] = [w, period.start, period.end];
  const keyset = after ? ` WHERE (u.at,u.id)>($${values.push(after.at)}::timestamptz,$${values.push(after.id)})` : "";
  const rows = (await db.query<Row>(`SELECT * FROM (${SOURCES[meter]}) u${keyset} ORDER BY u.at,u.id LIMIT ${limit + 1}`, values)).rows;
  return { units: rows.slice(0, limit).map((r) => toUnit(meter, r)), more: rows.length > limit };
}

/** A meter's total in a period (its units' quantities). */
export async function meterTotal(db: Sql, w: string, meter: MeterId, period: Period) {
  const values = [w, period.start, period.end];
  if (meter === "sms_segments")
    return (await db.query<Row>(SOURCES[meter], values)).rows.reduce((sum, r) => sum + toUnit(meter, r).quantity, 0);
  return Number((await db.query<{ q: string | null }>(`SELECT sum(u.quantity) AS q FROM (${SOURCES[meter]}) u`, values)).rows[0].q ?? 0);
}

export async function periodFor(db: Sql, w: string, which: unknown, now: Date) {
  const { anchor } = await seatPrice(db, w);
  const current = periodOf(anchor, now);
  return which === "previous" ? periodOf(anchor, new Date(current.start.getTime() - 1)) : current;
}
const cents = (quantity: number, price: number | null) => (price === null ? null : Math.round(quantity * price * 100) / 100);

/** Settings › Billing › Usage: each meter's total, price and amount, for this period or the last. */
export async function readUsage(db: Sql, w: string, principal: string, which: unknown = "current", now = new Date()) {
  await authorize(db, w, principal, "billing.manage");
  const period = await periodFor(db, w, which, now);
  const prices = unitPrices();
  const meters = [];
  for (const id of METER_IDS) {
    const quantity = await meterTotal(db, w, id, period);
    meters.push({ id, ...METERS[id], quantity, priceCents: prices[id], amountCents: cents(quantity, prices[id]) });
  }
  const priced = meters.every((m) => m.priceCents !== null);
  return {
    period: { which: which === "previous" ? "previous" : "current", start: period.start.toISOString(), end: period.end.toISOString() },
    meters,
    totalCents: priced ? Math.round(meters.reduce((s, m) => s + (m.amountCents ?? 0), 0)) : null,
    pricesSet: priced,
  };
}

/** One meter's units for the Usage page, traced to their conversations. */
export async function readUsageUnits(db: Sql, w: string, principal: string, q: URLSearchParams, now = new Date()) {
  await authorize(db, w, principal, "billing.manage");
  const meter = q.get("meter") as MeterId;
  assert(METER_IDS.includes(meter), "INVALID_FIELD", "Choose a meter.");
  const period = await periodFor(db, w, q.get("period"), now);
  let after: { at: string; id: string } | null = null;
  const cursor = q.get("cursor");
  if (cursor)
    try {
      const v = JSON.parse(atob(cursor)) as { at?: unknown; id?: unknown };
      if (typeof v.at === "string" && typeof v.id === "string" && !Number.isNaN(Date.parse(v.at))) after = { at: v.at, id: v.id };
    } catch {
      // An unreadable cursor starts from the beginning.
    }
  const page = await meterUnits(db, w, meter, period, after);
  const last = page.units.at(-1);
  return { meter, units: page.units, next: page.more && last ? btoa(JSON.stringify({ at: last.at, id: last.id })) : null };
}
