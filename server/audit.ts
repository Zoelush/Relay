import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { enqueueJob, type Job } from "./jobs";
import type { AttachmentStorage } from "./attachments";
import { actionsIn, AREAS, describeAction, EXPLICIT_ACTIONS, type Area, type ExplicitAction } from "../lib/audit-actions";

/**
 * The audit log (phase 16, step C1; docs/SECURITY_STEP1.md). Settings › Security › Audit log is
 * behind `security_v1`; recording is always on.
 *
 * - **Written in the action's transaction:** row changes to administrative tables by migration
 *   0081's triggers; everything else by `recordAudit` here. Who acted is the transaction's actor
 *   (`relay.actor_*`), set by `authorize` and, for the API, by the token check (`relay.actor_via`).
 * - **Append-only:** the database refuses an update or delete; only `pruneAudit` (retention)
 *   removes rows, past the workspace's retention (365 days unless changed; 90 days to 7 years).
 * - **Read** by who has `security.manage`: filtered by time, area, action, teammate and target,
 *   newest first; exported as CSV or JSON by a job (the export is itself audited).
 */
const PAGE = 50;
const EXPORT_BATCH = 5000;
const CONTACT_VIEW_EVERY = "1 hour";

/** A non-row action, recorded with the transaction's actor. */
export async function recordAudit(db: Sql, w: string, action: ExplicitAction, target: { type: string; id?: string | null; name?: string | null }, details: Record<string, unknown> = {}) {
  await db.query(
    `INSERT INTO audit_events(workspace_id,action,actor_type,actor_id,actor_name,via,target_type,target_id,target_name,details)
     VALUES($1,$2,CASE WHEN NULLIF(current_setting('relay.actor_id',true),'') IS NULL THEN 'system' ELSE 'teammate' END,
       NULLIF(current_setting('relay.actor_id',true),''),NULLIF(current_setting('relay.actor_name',true),''),NULLIF(current_setting('relay.actor_via',true),''),$3,$4,$5,$6)`,
    [w, action, target.type, target.id ?? null, target.name ?? null, JSON.stringify(details)],
  );
}

/** A teammate opened a customer's record: recorded once an hour per teammate and customer. */
export async function recordContactView(db: Sql, w: string, contactId: string, details: { where: "inbox" | "people" | "api"; personalData: boolean; conversationId?: string }) {
  const recent = (
    await db.query(
      `SELECT 1 FROM audit_events WHERE workspace_id=$1 AND target_type='contact' AND target_id=$2 AND action='contact.viewed'
         AND actor_id IS NOT DISTINCT FROM NULLIF(current_setting('relay.actor_id',true),'') AND at>now()-interval '${CONTACT_VIEW_EVERY}' LIMIT 1`,
      [w, contactId],
    )
  ).rows.length;
  if (!recent) await recordAudit(db, w, "contact.viewed", { type: "contact", id: contactId }, details);
}

/** The actor of this transaction's audit rows: set by `authorize`, and by the API for how they acted. */
export async function actingVia(db: Sql, via: string) {
  await db.query("SELECT set_config('relay.actor_via',$1,true)", [via]);
}

/* ------------------------------------------------------------------------------------------ */
/* Reading                                                                                     */
/* ------------------------------------------------------------------------------------------ */
export type AuditFilters = { from?: string; to?: string; area?: string; action?: string; actor?: string; q?: string };
type Row = {
  seq: string;
  at: Date;
  action: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  via: string | null;
  target_type: string;
  target_id: string | null;
  target_name: string | null;
  details: Record<string, unknown>;
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The filters as SQL, from the registry (an area is its tables' prefixes and its explicit actions). */
function where(w: string, f: AuditFilters) {
  const values: unknown[] = [w];
  const parts = ["workspace_id=$1"];
  const time = (v: string | undefined, field: string) => {
    if (!v) return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new DomainError("INVALID_FIELD", "Dates are ISO 8601.", 400, { field });
    return d.toISOString();
  };
  const from = time(f.from, "from");
  const to = time(f.to, "to");
  if (from) parts.push(`at>=$${values.push(from)}`);
  if (to) parts.push(`at<$${values.push(to)}`);
  if (f.area) {
    assert((AREAS as readonly string[]).includes(f.area), "INVALID_FIELD", "No such area.");
    const { prefixes, explicit } = actionsIn(f.area as Area);
    const re = prefixes.length ? `^(${prefixes.map(escapeRe).join("|")})\\.[a-z_]+$` : "^$";
    parts.push(`(action ~ $${values.push(re)} OR action = ANY($${values.push(explicit)}))`);
  }
  if (f.action) parts.push(`action=$${values.push(f.action)}`);
  if (f.actor) parts.push(f.actor === "system" ? "actor_type='system'" : `actor_id=$${values.push(f.actor)}`);
  if (f.q) {
    const like = `%${f.q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    parts.push(`(target_name ILIKE $${values.push(like)} OR target_id ILIKE $${values.length} OR actor_name ILIKE $${values.length})`);
  }
  return { sql: parts.join(" AND "), values };
}
const out = (r: Row) => {
  const d = describeAction(r.action);
  return {
    id: r.seq,
    at: new Date(r.at).toISOString(),
    action: r.action,
    label: d.label,
    area: d.area,
    actor: r.actor_type === "system" ? { type: "system", name: "Relay" } : { type: "teammate", id: r.actor_id, name: r.actor_name ?? "A teammate" },
    via: r.via,
    target: { type: r.target_type, id: r.target_id, name: r.target_name },
    details: r.details,
  };
};
const SELECT = "SELECT seq::text,at,action,actor_type,actor_id,actor_name,via,target_type,target_id,target_name,details FROM audit_events";

async function managing(db: Sql, w: string, principal: string) {
  // Phase 16 C2: its own permission (migration 0082 gave it to every role that managed the workspace).
  const t = await authorize(db, w, principal, "security.manage");
  assert(
    (await db.query("SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='security_v1' AND enabled", [w])).rows.length,
    "NOT_FOUND",
    "The audit log isn't turned on for this workspace.",
    404,
  );
  return t;
}

/** Settings › Security › Audit log: a page of events (newest first), the filters' choices, retention and exports. */
export async function readAudit(db: Sql, w: string, principal: string, f: AuditFilters & { before?: string }, storage?: AttachmentStorage, origin?: string) {
  const me = await managing(db, w, principal);
  const q = where(w, f);
  if (f.before) q.sql += ` AND seq<$${q.values.push(f.before)}::bigint`;
  const rows = (await db.query<Row>(`${SELECT} WHERE ${q.sql} ORDER BY audit_events.seq DESC LIMIT ${PAGE + 1}`, q.values)).rows;
  const teammates = (await db.query<{ id: string; name: string }>("SELECT id,name FROM teammates WHERE workspace_id=$1 ORDER BY lower(name),id", [w])).rows;
  const retention = (await db.query<{ retention_days: number }>("SELECT retention_days FROM audit_settings WHERE workspace_id=$1", [w])).rows[0]?.retention_days ?? 365;
  const exports = (
    await db.query<{ id: string; state: string; payload: { format: string; filters: AuditFilters }; result: { key?: string; rows?: number } | null; created_at: Date }>(
      "SELECT id,state,payload,result,created_at FROM jobs WHERE workspace_id=$1 AND kind='audit.export' AND owner_teammate_id=$2 ORDER BY created_at DESC LIMIT 5",
      [w, me.id],
    )
  ).rows;
  return {
    events: rows.slice(0, PAGE).map(out),
    next: rows.length > PAGE ? rows[PAGE - 1].seq : null,
    areas: AREAS,
    explicit: Object.keys(EXPLICIT_ACTIONS),
    teammates,
    retentionDays: retention,
    exports: await Promise.all(
      exports.map(async (e) => ({
        id: e.id,
        format: e.payload.format,
        status: e.state === "succeeded" ? "done" : e.state === "failed" || e.state === "dead_letter" ? "failed" : "preparing",
        rows: e.result?.rows ?? 0,
        createdAt: new Date(e.created_at).toISOString(),
        url: e.state === "succeeded" && e.result?.key && storage ? new URL((await storage.signDownload(e.result.key, false)).url, origin ?? "http://localhost").toString() : null,
      })),
    ),
  };
}

/** Retention, or an export of what's filtered (a job). Both are audited. */
export async function changeAudit(db: Sql, w: string, principal: string, p: Record<string, unknown>) {
  const me = await managing(db, w, principal);
  if (p.action === "retention") {
    const days = Number(p.retentionDays);
    assert(Number.isInteger(days) && days >= 90 && days <= 2555, "INVALID_FIELD", "Keep the log for 90 days to 7 years.");
    await db.query(
      `INSERT INTO audit_settings(workspace_id,retention_days,updated_by) VALUES($1,$2,$3)
       ON CONFLICT(workspace_id) DO UPDATE SET retention_days=EXCLUDED.retention_days,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [w, days, me.id],
    );
    return { retentionDays: days };
  }
  if (p.action === "export") {
    const format = p.format === "json" ? "json" : "csv";
    const filters = (p.filters ?? {}) as AuditFilters;
    where(w, filters); // refuses bad filters now, not in the job
    const id = await enqueueJob(db, w, "audit.export", { format, filters }, { teammateId: me.id });
    await recordAudit(db, w, "audit.exported", { type: "audit_log" }, { format, filters });
    return { id };
  }
  throw new DomainError("INVALID_AUDIT", "Choose retention or export.");
}

const CSV_COLUMNS = ["at", "action", "label", "area", "actor_type", "actor_id", "actor_name", "via", "target_type", "target_id", "target_name", "details"] as const;
const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  // Quoted, and a leading formula character neutralised (CSV injection).
  return `"${(/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`;
};

/** The export job: every filtered event, oldest first, into one file. */
export async function auditExportJob(connect: Connect, storage: AttachmentStorage, job: Job): Promise<{ done: boolean; result: Record<string, unknown> }> {
  const w = job.workspace_id;
  const p = job.payload as { format: "csv" | "json"; filters: AuditFilters };
  const lines: string[] = p.format === "csv" ? [CSV_COLUMNS.join(",")] : [];
  let after = "0";
  let count = 0;
  for (;;) {
    const rows = await tenant(connect, w, async (db) => {
      const q = where(w, p.filters);
      return (await db.query<Row>(`${SELECT} WHERE ${q.sql} AND seq>$${q.values.push(after)}::bigint ORDER BY audit_events.seq LIMIT ${EXPORT_BATCH}`, q.values)).rows;
    });
    for (const r of rows) {
      const e = out(r);
      const flat = {
        at: e.at,
        action: e.action,
        label: e.label,
        area: e.area,
        actor_type: r.actor_type,
        actor_id: r.actor_id,
        actor_name: r.actor_name,
        via: r.via,
        target_type: r.target_type,
        target_id: r.target_id,
        target_name: r.target_name,
        details: r.details,
      };
      lines.push(p.format === "csv" ? CSV_COLUMNS.map((c) => cell(flat[c])).join(",") : JSON.stringify(flat));
    }
    count += rows.length;
    if (rows.length < EXPORT_BATCH) break;
    after = rows.at(-1)!.seq;
  }
  const key = `audit/${w}/${job.id}.${p.format === "csv" ? "csv" : "ndjson"}`;
  await storage.putClean(key, new TextEncoder().encode(lines.join("\n") + "\n"), p.format === "csv" ? "text/csv" : "application/x-ndjson", `audit-log.${p.format === "csv" ? "csv" : "ndjson"}`);
  return { done: true, result: { key, rows: count } };
}

/** Retention, from the sweep: events older than the workspace's period go, a thousand at a time. */
export async function pruneAudit(connect: Connect, w: string) {
  return tenant(connect, w, async (db) => {
    await db.query("SELECT set_config('relay.audit_prune','on',true)");
    const r = await db.query(
      `DELETE FROM audit_events WHERE workspace_id=$1 AND seq IN (
         SELECT seq FROM audit_events WHERE workspace_id=$1
           AND at<now()-make_interval(days=>COALESCE((SELECT retention_days FROM audit_settings WHERE workspace_id=$1),365)) ORDER BY seq LIMIT 1000) RETURNING seq`,
      [w],
    );
    return r.rows.length;
  });
}
