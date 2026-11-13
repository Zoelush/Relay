import { tenant, type Connect, type Sql } from "./db";
import { enqueueJob } from "./jobs";

/**
 * Dunning (phase 16, step C10c; docs/SECURITY_STEP22.md): what happens after a charge is declined.
 *
 * - **Three more tries,** on day 1, 3 and 7 after the first failure. Each is the same
 *   `invoice.charge` job as a manager's "Pay now", so a charge still happens once per job.
 * - **Then the workspace is unpaid:** automated sending pauses exactly as the spend cap pauses it
 *   (`pausedFor`), and paying lifts it at once. Nothing is hidden, nothing is deleted, and a
 *   teammate's own replies and calls are never paused.
 * - **Billing managers are told three times:** at the first failure, before the last try, and when
 *   the tries run out. Each is told once (`billing_alerts`, unique per invoice and stage).
 */
/** Days after the first failure that Relay tries again. */
export const RETRY_DAYS = [1, 3, 7];
export type DunningStage = "failed" | "last_try" | "unpaid";

const DAY = 86_400_000;
/** When the try after `retries` of them is due, counted from the first failure (null: none left). */
export function nextAttempt(retries: number, firstFailedAt: Date) {
  const day = RETRY_DAYS[retries];
  return day === undefined ? null : new Date(firstFailedAt.getTime() + day * DAY);
}

/** What a manager is told, in plain words. */
export function dunningText(stage: DunningStage, p: { number: string; failure: string; nextAt: Date | null }) {
  const when = p.nextAt ? p.nextAt.toUTCString().replace(" GMT", " UTC") : "";
  if (stage === "failed")
    return `Invoice ${p.number} wasn't paid: ${p.failure} We'll try again on ${when}. You can pay it now, or change the card, in Settings › Billing › Invoices.`;
  if (stage === "last_try")
    return `Invoice ${p.number} still isn't paid. We'll try one last time on ${when}. If that fails, Relay pauses automated sending until it's paid.`;
  return `Invoice ${p.number} wasn't paid after three more tries, so automated sending is paused: Zoe's replies, outbound messages and automated emails and texts. Your team's own replies and calls still work. Paying the invoice lifts it at once.`;
}

/**
 * A charge was declined. The first one starts the schedule; each scheduled try that fails moves it
 * on, and when there are none left the workspace is unpaid. A manager's own "Pay now" never spends
 * a try and never pushes the end away: it only reports.
 */
export async function afterFailedCharge(db: Sql, w: string, invoiceId: string, o: { scheduled?: boolean } = {}, now = new Date()) {
  const inv = (
    await db.query<{ number: string; status: string; failure: string; dunning: string; first_failed_at: Date | null; retries: number }>(
      "SELECT number,status,failure,dunning,first_failed_at,retries FROM invoices WHERE workspace_id=$1 AND id=$2",
      [w, invoiceId],
    )
  ).rows[0];
  if (!inv || inv.status !== "failed" || inv.dunning === "unpaid") return null;
  // A try by hand between the scheduled ones changes nothing about them.
  if (inv.dunning === "retrying" && !o.scheduled) return { stage: "failed" as const, nextAt: null, told: false };
  const first = inv.first_failed_at ? new Date(inv.first_failed_at) : now;
  const retries = inv.dunning === "none" ? 0 : inv.retries + 1;
  const nextAt = nextAttempt(retries, first);
  if (nextAt) {
    await db.query(
      "UPDATE invoices SET dunning='retrying',retries=$3,first_failed_at=COALESCE(first_failed_at,$4),next_attempt_at=$5 WHERE workspace_id=$1 AND id=$2",
      [w, invoiceId, retries, first, nextAt],
    );
    // The try being scheduled is the last one: say so now, not after it fails.
    const stage: DunningStage = retries === RETRY_DAYS.length - 1 ? "last_try" : "failed";
    await tellBilling(db, w, invoiceId, stage, dunningText(stage, { number: inv.number, failure: inv.failure, nextAt }), retries);
    return { stage, nextAt, told: true };
  }
  await db.query("UPDATE invoices SET dunning='unpaid',retries=$3,next_attempt_at=NULL,unpaid_at=COALESCE(unpaid_at,$4) WHERE workspace_id=$1 AND id=$2", [w, invoiceId, retries, now]);
  await tellBilling(db, w, invoiceId, "unpaid", dunningText("unpaid", { number: inv.number, failure: inv.failure, nextAt: null }), retries);
  return { stage: "unpaid" as const, nextAt: null, told: true };
}

/** An invoice was paid: its retries stop, and with the last unpaid one paid, sending runs again. */
export async function afterPaidCharge(db: Sql, w: string, invoiceId: string) {
  await db.query("UPDATE invoices SET dunning='none',next_attempt_at=NULL,unpaid_at=NULL,retries=0 WHERE workspace_id=$1 AND id=$2", [w, invoiceId]);
}

/** The sweep: every invoice whose next try is due, charged again by its own job. */
export async function runDunning(connect: Connect, w: string, now = new Date()) {
  return tenant(connect, w, async (db) => {
    const due = (
      await db.query<{ id: string }>(
        "SELECT id FROM invoices WHERE workspace_id=$1 AND status='failed' AND dunning='retrying' AND next_attempt_at<=$2 ORDER BY next_attempt_at LIMIT 20",
        [w, now],
      )
    ).rows;
    for (const inv of due) {
      // Taken off the queue first, so a slow sweep can't start the same try twice.
      await db.query("UPDATE invoices SET next_attempt_at=NULL WHERE workspace_id=$1 AND id=$2", [w, inv.id]);
      await enqueueJob(db, w, "invoice.charge", { invoiceId: inv.id, scheduled: true }, {});
    }
    return due.length;
  });
}

/**
 * Why automated sending is paused for this workspace, or null. Read by `pausedFor`, so every
 * automated sender already asks it.
 */
export async function unpaidPause(db: Sql, w: string) {
  const inv = (
    await db.query<{ number: string }>("SELECT number FROM invoices WHERE workspace_id=$1 AND dunning='unpaid' ORDER BY period_start LIMIT 1", [w])
  ).rows[0];
  return inv ? `Invoice ${inv.number} hasn't been paid.` : null;
}

/** Each billing manager on a full seat: a notification, and an email to their sign-in address. */
async function tellBilling(db: Sql, w: string, invoiceId: string, stage: DunningStage, text: string, attempts: number) {
  const id = crypto.randomUUID();
  const added = (
    await db.query(
      "INSERT INTO billing_alerts(workspace_id,id,invoice_id,stage,attempts,text) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,invoice_id,stage) DO NOTHING RETURNING id",
      [w, id, invoiceId, stage, attempts, text],
    )
  ).rows.length;
  if (!added) return;
  const managers = (
    await db.query<{ id: string; email: string | null }>(
      `SELECT t.id,COALESCE((SELECT c.email FROM teammate_credentials c WHERE c.workspace_id=t.workspace_id AND c.teammate_id=t.id),
         (SELECT i.email FROM sso_identities i WHERE i.workspace_id=t.workspace_id AND i.teammate_id=t.id ORDER BY i.last_sign_in_at DESC NULLS LAST LIMIT 1)) AS email
       FROM teammates t JOIN role_capabilities p ON p.workspace_id=t.workspace_id AND p.role_id=t.role_id AND p.capability='billing.manage'
       WHERE t.workspace_id=$1 AND t.seat='full'`,
      [w],
    )
  ).rows;
  for (const m of managers) {
    await db.query("INSERT INTO notifications(workspace_id,id,teammate_id,kind,billing_alert_id,excerpt) VALUES($1,$2,$3,'billing_alert',$4,$5) ON CONFLICT DO NOTHING", [
      w,
      crypto.randomUUID(),
      m.id,
      id,
      text.slice(0, 140),
    ]);
    if (!m.email) continue;
    const emailId = crypto.randomUUID();
    await db.query("INSERT INTO email_alerts(workspace_id,id,kind,billing_alert_id,address) VALUES($1,$2,'billing',$3,$4)", [w, emailId, id, m.email]);
    await enqueueJob(db, w, "email.alert", { alertId: emailId }, {});
  }
}
