import { assert, DomainError, type Sql } from "./db";
import { authorize } from "./policy";
import { seatPrice } from "./plans";
import { periodOf, seatBill, type SeatChange } from "../lib/seats";

/**
 * Settings › Billing › Seats (phase 16, step C8b; docs/SECURITY_STEP15.md), for `billing.manage`:
 * who occupies a full or limited seat, this period's seats and prorated additions (computed from the
 * seat ledger by `seatBill`, never counted), and changing a teammate's seat. The ledger is written by
 * the database (migration 0093's trigger) whenever a teammate joins or their seat changes.
 */
export async function readSeats(db: Sql, w: string, principal: string, now = new Date()) {
  await authorize(db, w, principal, "billing.manage");
  const price = await seatPrice(db, w);
  const period = periodOf(price.anchor, now);
  const changes = (
    await db.query<{ teammate_id: string; teammate_name: string; from_seat: "full" | "limited" | null; to_seat: "full" | "limited"; at: Date }>(
      "SELECT teammate_id,teammate_name,from_seat,to_seat,at FROM seat_changes WHERE workspace_id=$1 AND at<$2 ORDER BY at,seq",
      [w, period.end],
    )
  ).rows.map((c): SeatChange => ({ teammateId: c.teammate_id, teammateName: c.teammate_name, from: c.from_seat, to: c.to_seat, at: new Date(c.at) }));
  const bill = seatBill(changes, period, price.monthlyCents);
  const teammates = (
    await db.query<{ id: string; name: string; role: string; role_id: string; seat: "full" | "limited"; since: Date | null }>(
      `SELECT t.id,t.name,r.name AS role,t.role_id,t.seat,(SELECT max(c.at) FROM seat_changes c WHERE c.workspace_id=t.workspace_id AND c.teammate_id=t.id) AS since
       FROM teammates t JOIN roles r ON r.workspace_id=t.workspace_id AND r.id=t.role_id WHERE t.workspace_id=$1 ORDER BY t.seat,t.name,t.id`,
      [w],
    )
  ).rows;
  return {
    plan: price.planName,
    priceSet: price.monthlyCents !== null,
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    full: teammates.filter((t) => t.seat === "full").length,
    limited: teammates.filter((t) => t.seat === "limited").length,
    bill,
    teammates: teammates.map((t) => ({ id: t.id, name: t.name, role: t.role, seat: t.seat, owner: t.role_id === "owner", since: t.since ? new Date(t.since).toISOString() : null })),
  };
}

export async function changeSeat(db: Sql, w: string, principal: string, p: Record<string, unknown>) {
  await authorize(db, w, principal, "billing.manage");
  assert(p.seat === "full" || p.seat === "limited", "INVALID_FIELD", "Choose a full or limited seat.");
  const t = (await db.query<{ id: string; name: string; role_id: string; seat: string }>("SELECT id,name,role_id,seat FROM teammates WHERE workspace_id=$1 AND id=$2", [w, String(p.teammateId ?? "")]))
    .rows[0];
  assert(t, "NOT_FOUND", "That teammate isn't in this workspace.", 404);
  if (t!.role_id === "owner" && p.seat === "limited") throw new DomainError("OWNER_FULL_SEAT", "The owner always has a full seat.", 409);
  // The ledger and the audit log are written by the database, with this transaction's actor.
  if (t!.seat !== p.seat) await db.query("UPDATE teammates SET seat=$3 WHERE workspace_id=$1 AND id=$2", [w, t!.id, p.seat]);
  return readSeats(db, w, principal);
}
