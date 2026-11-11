import { tenant, type Connect, type Sql } from "./db";
import { enqueueJob } from "./jobs";
import { meterTotal, periodFor } from "./meters";
import { spent } from "./limits";
import { METERS, type MeterId } from "../lib/meters";

/**
 * Usage alerts (phase 16, step C9c; docs/SECURITY_STEP18.md): when a meter's usage crosses a
 * threshold of its limit (or the metered spend crosses one of the spend cap's), every teammate who
 * manages billing, on a full seat, is told once per threshold per billing period: a notification in
 * Relay and an email (the alert email path, `sendAlert`). Checked by the sweep; notify only (limits
 * pause, C9b). Thresholds are percentages, 80% and 100% unless the workspace sets others.
 */
export const DEFAULT_THRESHOLDS = [80, 100];
export type Subject = MeterId | "spend_cap";
const words = (subject: Subject) => (subject === "spend_cap" ? "spend cap" : `limit for ${METERS[subject].noun}`);
const amount = (subject: Subject, n: number) => (subject === "spend_cap" ? `$${(n / 100).toFixed(2)}` : Math.round(n).toLocaleString("en"));
/** What an alert says, in the notification and the email. */
export const alertText = (a: { subject: Subject; threshold: number; used: number; of: number }) =>
  `${a.threshold}% of this period's ${words(a.subject)}: ${amount(a.subject, a.used)} of ${amount(a.subject, a.of)}.`;

/** The sweep's check: new crossings recorded, and each one told to billing managers. Returns how many. */
export async function checkUsageAlerts(connect: Connect, w: string, now = new Date()) {
  return tenant(connect, w, async (db) => {
    const settings = (
      await db.query<{ spend_cap_cents: number | null; alert_thresholds: number[] }>("SELECT spend_cap_cents,alert_thresholds FROM usage_settings WHERE workspace_id=$1", [w])
    ).rows[0];
    const thresholds = settings?.alert_thresholds ?? DEFAULT_THRESHOLDS;
    if (!thresholds.length) return 0;
    const limits = (await db.query<{ meter: MeterId; units: number }>("SELECT meter,units FROM usage_limits WHERE workspace_id=$1", [w])).rows;
    if (!limits.length && !settings?.spend_cap_cents) return 0;
    const period = await periodFor(db, w, "current", now);
    const subjects: { subject: Subject; used: number; of: number }[] = [];
    for (const l of limits) subjects.push({ subject: l.meter, used: await meterTotal(db, w, l.meter, period), of: l.units });
    if (settings?.spend_cap_cents) {
      const spend = await spent(db, w, period);
      if (spend !== null) subjects.push({ subject: "spend_cap", used: spend, of: settings.spend_cap_cents });
    }
    let sent = 0;
    for (const s of subjects)
      for (const threshold of [...thresholds].sort((a, b) => a - b)) {
        if (s.used < (s.of * threshold) / 100) continue;
        const id = crypto.randomUUID();
        const added = (
          await db.query(
            "INSERT INTO usage_alerts(workspace_id,id,subject,threshold,period_start,used,of) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,subject,threshold,period_start) DO NOTHING RETURNING id",
            [w, id, s.subject, threshold, period.start, s.used, s.of],
          )
        ).rows.length;
        if (!added) continue;
        await tell(db, w, id, alertText({ ...s, threshold }));
        sent++;
      }
    return sent;
  });
}

/** Each billing manager on a full seat: a notification, and an email to their sign-in address. */
async function tell(db: Sql, w: string, alertId: string, text: string) {
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
    await db.query("INSERT INTO notifications(workspace_id,id,teammate_id,kind,usage_alert_id,excerpt) VALUES($1,$2,$3,'usage_alert',$4,$5) ON CONFLICT DO NOTHING", [
      w,
      crypto.randomUUID(),
      m.id,
      alertId,
      text.slice(0, 140),
    ]);
    if (!m.email) continue;
    const emailId = crypto.randomUUID();
    await db.query("INSERT INTO email_alerts(workspace_id,id,kind,usage_alert_id,address) VALUES($1,$2,'usage',$3,$4)", [w, emailId, alertId, m.email]);
    await enqueueJob(db, w, "email.alert", { alertId: emailId }, {});
  }
}
