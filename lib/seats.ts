/**
 * Seats (phase 16, step C8b; docs/SECURITY_STEP15.md): what a limited seat may do, the billing
 * period, and proration from the seat ledger. Pure: shared by the server (policy, the Seats page)
 * and C10's invoices.
 *
 * - A **full seat** is paid; a **limited seat** is free and keeps only `LIMITED_CAPABILITIES`,
 *   whatever the teammate's role, and sees no conversation lists (it opens conversations by link).
 * - **Proration:** a full seat added mid-period is charged for the rest of it, by the second; one
 *   removed (or moved to limited) stays paid until the period ends, with no credit; a teammate
 *   already paid for the period isn't charged again.
 */
export const LIMITED_CAPABILITIES = ["conversations.read", "conversations.note", "conversations.delete_note", "contacts.personal_data", "reports.view"] as const;

export type SeatChange = { teammateId: string; teammateName: string; from: "full" | "limited" | null; to: "full" | "limited"; at: Date };
export type Period = { start: Date; end: Date };

/** The month-long billing period containing `at`, counted from the anchor (its day of month, clamped). */
export function periodOf(anchor: Date, at: Date): Period {
  const add = (months: number) => {
    const d = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + months, 1, anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), anchor.getUTCMilliseconds()));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(anchor.getUTCDate(), last));
    return d;
  };
  let n = (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (at.getUTCMonth() - anchor.getUTCMonth());
  if (add(n) > at) n -= 1;
  if (n < 0) n = 0;
  return { start: add(n), end: add(n + 1) };
}

export type Proration = { teammateId: string; teammateName: string; at: string; fraction: number; amountCents: number | null };
/**
 * What a period's seats cost: the full seats at its start (each a whole period), and each addition
 * within it (its prorated share). `priceCents` null (a placeholder) gives no amounts.
 */
export function seatBill(changes: SeatChange[], period: Period, priceCents: number | null) {
  const ordered = [...changes].sort((a, b) => a.at.getTime() - b.at.getTime());
  const seatAt = new Map<string, "full" | "limited">();
  for (const c of ordered) if (c.at <= period.start) seatAt.set(c.teammateId, c.to);
  const paid = new Set([...seatAt].filter(([, s]) => s === "full").map(([id]) => id));
  const fullAtStart = paid.size;
  const length = period.end.getTime() - period.start.getTime();
  const prorations: Proration[] = [];
  for (const c of ordered) {
    if (c.at <= period.start || c.at >= period.end) continue;
    if (c.to === "full" && c.from !== "full" && !paid.has(c.teammateId)) {
      paid.add(c.teammateId);
      const fraction = Math.round(((period.end.getTime() - c.at.getTime()) / length) * 1e6) / 1e6;
      prorations.push({ teammateId: c.teammateId, teammateName: c.teammateName, at: c.at.toISOString(), fraction, amountCents: priceCents === null ? null : Math.round(priceCents * fraction) });
    }
  }
  const now = new Map<string, "full" | "limited">();
  for (const c of ordered) if (c.at < period.end) now.set(c.teammateId, c.to);
  const fullAtEnd = [...now.values()].filter((s) => s === "full").length;
  return {
    fullAtStart,
    baseCents: priceCents === null ? null : fullAtStart * priceCents,
    prorations,
    proratedCents: priceCents === null ? null : prorations.reduce((s, p) => s + (p.amountCents ?? 0), 0),
    /** Full seats carried into the next period (removals take effect then). */
    fullNextPeriod: fullAtEnd,
  };
}
