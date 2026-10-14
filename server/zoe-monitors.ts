import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { enqueueJob } from "./jobs";
import { aiEnabled, agentRow } from "./ai-agent";
import { zoeAccess } from "./zoe";
import {
  MONITORS,
  SENSITIVITY,
  changeSentence,
  monitorOf,
  tripped,
  type Metric,
  type Sensitivity,
} from "../lib/zoe-monitors";

/**
 * Monitors and incidents for Zoe (phase 08, step C2b; docs/AI_STEP12.md), behind `zoe_monitors_v1`,
 * for those who manage her. Once an hour the scheduled sweep compares each built-in monitor's rate
 * over the last 24 hours with the 7 days before (`checkMonitors`). A sharp change the bad way, with
 * enough answers on both sides, opens an incident (one open per monitor) and notifies her managers
 * in the app. Two normal checks in a row resolve it; so does switching its monitor off, or a
 * teammate. All of it is computed here; the pages only show it. Phase 12 E4: with email on, an
 * incident is also emailed to the addresses her managers set (`email.alert`, through the
 * suppression list).
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BASELINE_DAYS = 7;
/** Checks are kept this long. */
const CHECKS_KEPT = 30 * DAY;
/** Normal checks in a row that resolve an incident. */
const RECOVERY_CHECKS = 2;
/** Changes this close before an incident opened are listed with it. */
const CHANGES_WINDOW = 2 * DAY;

export async function monitorsEnabled(db: Sql, w: string) {
  return (
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='zoe_monitors_v1' AND enabled",
        [w],
      )
    ).rows.length > 0
  );
}
async function monitorAccess(db: Sql, w: string, principal: string) {
  const agent = await zoeAccess(db, w, principal);
  assert(
    await monitorsEnabled(db, w),
    "MONITORS_DISABLED",
    "Zoe's monitors are not enabled for this workspace.",
    404,
  );
  return { agent, teammate: await authorize(db, w, principal, "workspace.manage") };
}

/* ------------------------------------------------------------------------------------------ */
/* Measuring                                                                                   */

type Counts = { n: number; d: number };
export type Measure = {
  metric: Metric;
  current: number | null;
  baseline: number | null;
  volume: number;
  baselineVolume: number;
};

/** Every monitor's rate over [now-24h, now) and [now-8d, now-24h). */
export async function measure(db: Sql, w: string, now: number): Promise<Measure[]> {
  const to = new Date(now).toISOString();
  const mid = new Date(now - DAY).toISOString();
  const from = new Date(now - DAY - BASELINE_DAYS * DAY).toISOString();
  const answers = (
    await db.query<Record<string, number>>(
      `SELECT ${["c", "b"]
        .map((p) => {
          const at = p === "c" ? "created_at>=$3 AND created_at<$4" : "created_at>=$2 AND created_at<$3";
          return `count(*) FILTER (WHERE ${at} AND outcome IN ('answered','clarified','unknown','failed'))::int AS ${p}_tried,
            count(*) FILTER (WHERE ${at} AND outcome<>'skipped')::int AS ${p}_decided,
            count(*) FILTER (WHERE ${at} AND outcome='unknown' AND guard IS NULL)::int AS ${p}_unknown,
            count(*) FILTER (WHERE ${at} AND outcome='escalated')::int AS ${p}_escalated,
            count(*) FILTER (WHERE ${at} AND guard IS NOT NULL)::int AS ${p}_blocked,
            count(*) FILTER (WHERE ${at} AND outcome='failed')::int AS ${p}_failed,
            count(*) FILTER (WHERE ${at} AND outcome='answered')::int AS ${p}_answered`;
        })
        .join(",")}
       FROM ai_answers WHERE workspace_id=$1 AND created_at>=$2 AND created_at<$4`,
      [w, from, mid, to],
    )
  ).rows[0];
  const helped = (
    await db.query<{ c: number; b: number }>(
      `SELECT count(*) FILTER (WHERE recorded_at>=$3)::int AS c,count(*) FILTER (WHERE recorded_at<$3)::int AS b
       FROM ai_resolutions WHERE workspace_id=$1 AND kind='resolution' AND rule='confirmed' AND recorded_at>=$2 AND recorded_at<$4`,
      [w, from, mid, to],
    )
  ).rows[0];
  const reviews = (
    await db.query<{ c_bad: number; c_rated: number; b_bad: number; b_rated: number }>(
      `SELECT count(*) FILTER (WHERE rated_at>=$3 AND rating='bad')::int AS c_bad,count(*) FILTER (WHERE rated_at>=$3)::int AS c_rated,
         count(*) FILTER (WHERE rated_at<$3 AND rating='bad')::int AS b_bad,count(*) FILTER (WHERE rated_at<$3)::int AS b_rated
       FROM ai_reviews WHERE workspace_id=$1 AND rating IS NOT NULL AND rated_at>=$2 AND rated_at<$4`,
      [w, from, mid, to],
    )
  ).rows[0];
  const pair = (p: "c" | "b"): Record<Metric, Counts> => ({
    unknown_rate: { n: answers[p + "_unknown"], d: answers[p + "_tried"] },
    handover_rate: { n: answers[p + "_escalated"], d: answers[p + "_decided"] },
    blocked_rate: { n: answers[p + "_blocked"], d: answers[p + "_tried"] },
    error_rate: { n: answers[p + "_failed"], d: answers[p + "_tried"] },
    helped_rate: { n: Math.min(helped[p], answers[p + "_answered"]), d: answers[p + "_answered"] },
    bad_review_rate: { n: reviews[`${p}_bad`], d: reviews[`${p}_rated`] },
  });
  const c = pair("c");
  const b = pair("b");
  const rate = (x: Counts) => (x.d ? x.n / x.d : null);
  return MONITORS.map((m) => ({
    metric: m.metric,
    current: rate(c[m.metric]),
    baseline: rate(b[m.metric]),
    volume: c[m.metric].d,
    baselineVolume: b[m.metric].d,
  }));
}

type Setting = { metric: Metric; enabled: boolean; sensitivity: Sensitivity; version: string };
async function settings(db: Sql, w: string, agentId: string): Promise<Map<Metric, Setting>> {
  const rows = (
    await db.query<Setting>(
      "SELECT metric,enabled,sensitivity,version::text AS version FROM ai_monitor_settings WHERE workspace_id=$1 AND agent_id=$2",
      [w, agentId],
    )
  ).rows;
  return new Map(
    MONITORS.map((m) => [
      m.metric,
      rows.find((r) => r.metric === m.metric) ?? {
        metric: m.metric,
        enabled: true,
        sensitivity: "medium",
        version: "0",
      },
    ]),
  );
}

/** What a monitor shows for these numbers. */
function statusOf(s: Setting, x: Measure) {
  if (!s.enabled) return "off" as const;
  const min = monitorOf(x.metric)!.min;
  if (x.current === null || x.baseline === null || x.volume < min || x.baselineVolume < min)
    return "low_volume" as const;
  return tripped(x.metric, s.sensitivity, x.current, x.baseline) ? ("tripped" as const) : ("normal" as const);
}

/* ------------------------------------------------------------------------------------------ */
/* The hourly check                                                                            */

/** Conversations behind the change: the latest few in the last 24 hours. */
async function examples(db: Sql, w: string, metric: Metric, now: number) {
  const from = new Date(now - DAY).toISOString();
  const to = new Date(now).toISOString();
  const where: Record<Metric, string> = {
    unknown_rate: "outcome='unknown' AND guard IS NULL",
    handover_rate: "outcome='escalated'",
    blocked_rate: "guard IS NOT NULL",
    error_rate: "outcome='failed'",
    helped_rate: "outcome='answered'",
    bad_review_rate: "",
  };
  if (metric === "bad_review_rate")
    return (
      await db.query<{ conversation_id: string }>(
        `SELECT conversation_id FROM ai_reviews WHERE workspace_id=$1 AND rating='bad' AND rated_at>=$2 AND rated_at<$3
         GROUP BY conversation_id ORDER BY max(rated_at) DESC LIMIT 5`,
        [w, from, to],
      )
    ).rows.map((r) => r.conversation_id);
  return (
    await db.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM ai_answers WHERE workspace_id=$1 AND ${where[metric]} AND created_at>=$2 AND created_at<$3
       GROUP BY conversation_id ORDER BY max(created_at) DESC LIMIT 5`,
      [w, from, to],
    )
  ).rows.map((r) => r.conversation_id);
}

/** What changed shortly before: guidance versions, Zoe's settings, specialists, published content. */
async function nearbyChanges(db: Sql, w: string, agentId: string, now: number) {
  const from = new Date(now - CHANGES_WINDOW).toISOString();
  const to = new Date(now).toISOString();
  const rows = (
    await db.query<{ kind: string; label: string; at: string }>(
      `(SELECT 'guidance' AS kind,'Guidance version '||g.version||COALESCE(' saved by '||t.name,'') AS label,g.saved_at AS at
          FROM ai_guidance_versions g LEFT JOIN teammates t ON t.workspace_id=g.workspace_id AND t.id=g.saved_by
          WHERE g.workspace_id=$1 AND g.agent_id=$2 AND g.saved_at>=$3 AND g.saved_at<$4)
       UNION ALL
       (SELECT 'settings','Her settings changed',updated_at FROM ai_agents WHERE workspace_id=$1 AND id=$2 AND updated_at>=$3 AND updated_at<$4)
       UNION ALL
       (SELECT 'specialist','Specialist “'||name||'” changed',updated_at FROM ai_specialists
          WHERE workspace_id=$1 AND agent_id=$2 AND updated_at>=$3 AND updated_at<$4)
       UNION ALL
       (SELECT 'content','“'||COALESCE(l.published_title,'Untitled')||'” published',l.published_at
          FROM knowledge_locales l JOIN knowledge_records r ON r.workspace_id=l.workspace_id AND r.id=l.record_id
          WHERE l.workspace_id=$1 AND r.for_ai AND l.status='published' AND l.published_at>=$3 AND l.published_at<$4)
       ORDER BY at DESC LIMIT 10`,
      [w, agentId, from, to],
    )
  ).rows;
  return rows.map((r) => ({ kind: r.kind, label: r.label, at: new Date(r.at).toISOString() }));
}

/** Notifies everyone who manages Zoe, once per incident; and (E4) emails the alert addresses. */
export async function notify(db: Sql, w: string, incidentId: string, excerpt: string) {
  await db.query(
    `INSERT INTO notifications(workspace_id,id,teammate_id,kind,incident_id,excerpt)
     SELECT $1,gen_random_uuid()::text,t.id,'zoe_incident',$2,$3 FROM teammates t
     JOIN role_capabilities p ON p.workspace_id=t.workspace_id AND p.role_id=t.role_id AND p.capability='workspace.manage'
     WHERE t.workspace_id=$1
     ON CONFLICT DO NOTHING`,
    [w, incidentId, excerpt.slice(0, 140)],
  );
  if (!(await emailOn(db, w))) return;
  const addresses = (await db.query<{ incident_emails: string[] }>("SELECT incident_emails FROM ai_agents WHERE workspace_id=$1 AND id='default'", [w])).rows[0]?.incident_emails ?? [];
  for (const address of addresses) {
    const added = await db.query(
      "INSERT INTO email_alerts(workspace_id,id,incident_id,address) VALUES($1,$2,$3,$4) ON CONFLICT (workspace_id,incident_id,address) DO NOTHING RETURNING id",
      [w, crypto.randomUUID(), incidentId, address],
    );
    if (added.rows.length) await enqueueJob(db, w, "email.alert", { alertId: added.rows[0].id }, {});
  }
}
async function emailOn(db: Sql, w: string) {
  return (
    (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM workspace_features WHERE workspace_id=$1 AND enabled AND name IN ('channels_v1','channel_email_v1')", [w]))
      .rows[0].n === 2
  );
}

/**
 * Checks every monitor once per UTC hour (the scheduled sweep calls this each pass): records each
 * one's numbers, opens or updates incidents, and resolves those that recovered. Safe to repeat.
 */
export async function checkMonitors(connect: Connect, w: string, now = Date.now()) {
  return tenant(connect, w, async (db) => {
    if (!(await aiEnabled(db, w)) || !(await monitorsEnabled(db, w))) return null;
    const hour = new Date(Math.floor(now / HOUR) * HOUR).toISOString();
    const fresh = (
      await db.query(
        "INSERT INTO ai_monitor_runs(workspace_id,hour) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING hour",
        [w, hour],
      )
    ).rows.length;
    if (!fresh) return null;
    const agent = await agentRow(db, w);
    const set = await settings(db, w, agent.id);
    const opened: Metric[] = [];
    const resolved: Metric[] = [];
    for (const x of await measure(db, w, now)) {
      const s = set.get(x.metric)!;
      const status = statusOf(s, x);
      await db.query(
        `INSERT INTO ai_monitor_checks(workspace_id,hour,metric,current,baseline,volume,baseline_volume,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [w, hour, x.metric, x.current, x.baseline, x.volume, x.baselineVolume, status],
      );
      const open = (
        await db.query<{ id: string; normal_checks: number }>(
          "SELECT id,normal_checks FROM ai_incidents WHERE workspace_id=$1 AND metric=$2 AND status<>'resolved'",
          [w, x.metric],
        )
      ).rows[0];
      if (status === "tripped") {
        if (open) {
          const worse = monitorOf(x.metric)!.worse === "up" ? "greatest" : "least";
          await db.query(
            `UPDATE ai_incidents SET latest_value=$3,worst_value=${worse}(worst_value,$3),volume=$4,normal_checks=0,last_checked_at=$5
             WHERE workspace_id=$1 AND id=$2`,
            [w, open.id, x.current, x.volume, new Date(now).toISOString()],
          );
        } else {
          const id = crypto.randomUUID();
          await db.query(
            `INSERT INTO ai_incidents(workspace_id,id,agent_id,metric,opened_at,baseline,opened_value,latest_value,worst_value,volume,examples,changes,last_checked_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,$7,$7,$8,$9,$10,$5)`,
            [
              w,
              id,
              agent.id,
              x.metric,
              new Date(now).toISOString(),
              x.baseline,
              x.current,
              x.volume,
              await examples(db, w, x.metric, now),
              JSON.stringify(await nearbyChanges(db, w, agent.id, now)),
            ],
          );
          await notify(db, w, id, changeSentence(x.metric, x.baseline!, x.current!));
          opened.push(x.metric);
        }
      } else if (open && status === "normal") {
        const recovered = open.normal_checks + 1 >= RECOVERY_CHECKS;
        await db.query(
          `UPDATE ai_incidents SET normal_checks=normal_checks+1,last_checked_at=$3,latest_value=COALESCE($4,latest_value)
             ${recovered ? ",status='resolved',resolution='auto',resolved_at=$3,version=version+1" : ""}
           WHERE workspace_id=$1 AND id=$2`,
          [w, open.id, new Date(now).toISOString(), x.current],
        );
        if (recovered) resolved.push(x.metric);
      }
    }
    await db.query("DELETE FROM ai_monitor_checks WHERE workspace_id=$1 AND hour<$2", [
      w,
      new Date(now - CHECKS_KEPT).toISOString(),
    ]);
    await db.query("DELETE FROM ai_monitor_runs WHERE workspace_id=$1 AND hour<$2", [
      w,
      new Date(now - CHECKS_KEPT).toISOString(),
    ]);
    return { opened, resolved };
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Reading                                                                                     */

type IncidentRow = {
  id: string;
  metric: Metric;
  status: "open" | "acknowledged" | "resolved";
  opened_at: string;
  baseline: number;
  opened_value: number;
  latest_value: number;
  worst_value: number;
  volume: number;
  examples: string[];
  changes: { kind: string; label: string; at: string }[];
  normal_checks: number;
  last_checked_at: string;
  acknowledged_by_name: string | null;
  acknowledged_at: string | null;
  resolution: "auto" | "manual" | "monitor_off" | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  note: string;
  version: string;
};
const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
const incidentView = (r: IncidentRow) => ({
  id: r.id,
  metric: r.metric,
  status: r.status,
  openedAt: iso(r.opened_at),
  baseline: r.baseline,
  openedValue: r.opened_value,
  latestValue: r.latest_value,
  worstValue: r.worst_value,
  volume: r.volume,
  examples: r.examples,
  changes: r.changes,
  normalChecks: r.normal_checks,
  lastCheckedAt: iso(r.last_checked_at),
  acknowledgedBy: r.acknowledged_by_name,
  acknowledgedAt: iso(r.acknowledged_at),
  resolution: r.resolution,
  resolvedBy: r.resolved_by_name,
  resolvedAt: iso(r.resolved_at),
  note: r.note,
  version: r.version,
});
const INCIDENT_FIELDS = `i.id,i.metric,i.status,i.opened_at,i.baseline,i.opened_value,i.latest_value,i.worst_value,i.volume,i.examples,i.changes,
  i.normal_checks,i.last_checked_at,a.name AS acknowledged_by_name,i.acknowledged_at,i.resolution,r.name AS resolved_by_name,i.resolved_at,i.note,
  i.version::text AS version
  FROM ai_incidents i
  LEFT JOIN teammates a ON a.workspace_id=i.workspace_id AND a.id=i.acknowledged_by
  LEFT JOIN teammates r ON r.workspace_id=i.workspace_id AND r.id=i.resolved_by`;

async function openIncidents(db: Sql, w: string) {
  return (
    await db.query<IncidentRow>(
      `SELECT ${INCIDENT_FIELDS} WHERE i.workspace_id=$1 AND i.status<>'resolved' ORDER BY i.opened_at DESC,i.id`,
      [w],
    )
  ).rows.map(incidentView);
}

/** Analyze › Monitors: each monitor's setting, its numbers now, and whether an incident is open. */
export async function readMonitors(db: Sql, w: string, principal: string) {
  const { agent } = await monitorAccess(db, w, principal);
  const set = await settings(db, w, agent.id);
  const open = await openIncidents(db, w);
  const last = (
    await db.query<{ hour: string | null }>(
      "SELECT max(hour) AS hour FROM ai_monitor_runs WHERE workspace_id=$1",
      [w],
    )
  ).rows[0].hour;
  const now = Date.now();
  return {
    // E4: where incidents are emailed (when email is on).
    alerts: {
      email: await emailOn(db, w),
      addresses: (await db.query<{ incident_emails: string[] }>("SELECT incident_emails FROM ai_agents WHERE workspace_id=$1 AND id=$2", [w, agent.id])).rows[0]?.incident_emails ?? [],
    },
    lastCheckedAt: iso(last),
    monitors: (await measure(db, w, now)).map((x) => {
      const s = set.get(x.metric)!;
      return {
        metric: x.metric,
        enabled: s.enabled,
        sensitivity: s.sensitivity,
        version: s.version,
        current: x.current,
        baseline: x.baseline,
        volume: x.volume,
        baselineVolume: x.baselineVolume,
        status: statusOf(s, x),
        incidentId: open.find((i) => i.metric === x.metric)?.id ?? null,
      };
    }),
  };
}

/** Analyze › Incidents: open ones first, then those resolved in the last 30 days. */
export async function readIncidents(db: Sql, w: string, principal: string) {
  await monitorAccess(db, w, principal);
  const recent = (
    await db.query<IncidentRow>(
      `SELECT ${INCIDENT_FIELDS} WHERE i.workspace_id=$1 AND i.status='resolved' AND i.resolved_at>=$2
       ORDER BY i.resolved_at DESC,i.id LIMIT 50`,
      [w, new Date(Date.now() - 30 * DAY).toISOString()],
    )
  ).rows.map(incidentView);
  return { open: await openIncidents(db, w), recent };
}

/** For the Overview's banner: open incidents, while monitors are on. */
export async function incidentSummary(db: Sql, w: string) {
  if (!(await monitorsEnabled(db, w))) return null;
  return {
    open: (await openIncidents(db, w)).map((i) => ({
      id: i.id,
      metric: i.metric,
      baseline: i.baseline,
      latestValue: i.latestValue,
      status: i.status,
    })),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Changes                                                                                     */

const invalid = (message: string): never => {
  throw new DomainError("INVALID_MONITORS", message, 400);
};

/**
 * One change, idempotent by key: a `monitor`'s setting (switching it off resolves its open
 * incident), or an incident `acknowledge`d or `resolve`d with an optional note, by version.
 */
export async function changeMonitors(
  db: Sql,
  w: string,
  principal: string,
  key: string,
  p: Record<string, unknown>,
) {
  const { agent, teammate } = await monitorAccess(db, w, principal);
  return once(db, w, "zoe-monitors:" + principal, key, p, async () => {
    if (p.action === "monitor") {
      const m = monitorOf(String(p.metric ?? ""));
      if (!m) invalid("Choose one of her monitors.");
      const metric = m!.metric;
      if (typeof p.enabled !== "boolean") invalid("Switch the monitor on or off.");
      const sensitivity = p.sensitivity as Sensitivity;
      if (!(sensitivity in SENSITIVITY)) invalid("Choose low, medium or high sensitivity.");
      const current = (await settings(db, w, agent.id)).get(metric)!;
      if (String(p.version ?? "") !== current.version)
        throw new DomainError("MONITOR_CHANGED", "Someone else changed this monitor. Reload to see it.", 409);
      await db.query(
        `INSERT INTO ai_monitor_settings(workspace_id,agent_id,metric,enabled,sensitivity,updated_by)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(workspace_id,agent_id,metric) DO UPDATE SET enabled=EXCLUDED.enabled,sensitivity=EXCLUDED.sensitivity,
           updated_by=EXCLUDED.updated_by,updated_at=now(),version=ai_monitor_settings.version+1`,
        [w, agent.id, metric, p.enabled, sensitivity, teammate.id],
      );
      if (!p.enabled)
        await db.query(
          `UPDATE ai_incidents SET status='resolved',resolution='monitor_off',resolved_by=$3,resolved_at=now(),version=version+1
           WHERE workspace_id=$1 AND metric=$2 AND status<>'resolved'`,
          [w, metric, teammate.id],
        );
      return readMonitors(db, w, principal);
    }
    if (p.action === "alerts") {
      // E4: up to five addresses incidents are emailed to (none: in the app only).
      const raw = Array.isArray(p.addresses) ? p.addresses : [];
      const addresses = [...new Set(raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
      if (addresses.length > 5 || addresses.some((a) => !/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(a) || a.length > 254))
        invalid("Email incident alerts to up to five email addresses.");
      if (!(await emailOn(db, w)) && addresses.length) invalid("Email is not enabled for this workspace.");
      await db.query("UPDATE ai_agents SET incident_emails=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2", [w, agent.id, addresses]);
      return readMonitors(db, w, principal);
    }
    if (p.action === "acknowledge" || p.action === "resolve") {
      const note = typeof p.note === "string" ? p.note.trim() : "";
      if (note.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(note))
        invalid("Keep the note to 1,000 characters.");
      const id = String(p.incidentId ?? "");
      const row = (
        await db.query<{ status: string; version: string }>(
          "SELECT status,version::text AS version FROM ai_incidents WHERE workspace_id=$1 AND id=$2",
          [w, id],
        )
      ).rows[0];
      assert(row, "INCIDENT_NOT_FOUND", "That incident isn't available.", 404);
      if (row.version !== String(p.version ?? ""))
        throw new DomainError("INCIDENT_CHANGED", "This incident changed. Reload to see it.", 409);
      if (row.status === "resolved")
        throw new DomainError("INCIDENT_RESOLVED", "This incident is already resolved.", 409);
      if (p.action === "acknowledge") {
        if (row.status === "acknowledged") invalid("This incident is already acknowledged.");
        await db.query(
          `UPDATE ai_incidents SET status='acknowledged',acknowledged_by=$3,acknowledged_at=now(),note=CASE WHEN $4='' THEN note ELSE $4 END,version=version+1
           WHERE workspace_id=$1 AND id=$2`,
          [w, id, teammate.id, note],
        );
      } else
        await db.query(
          `UPDATE ai_incidents SET status='resolved',resolution='manual',resolved_by=$3,resolved_at=now(),note=CASE WHEN $4='' THEN note ELSE $4 END,version=version+1
           WHERE workspace_id=$1 AND id=$2`,
          [w, id, teammate.id, note],
        );
      return readIncidents(db, w, principal);
    }
    return invalid("Unknown monitor change.");
  });
}
