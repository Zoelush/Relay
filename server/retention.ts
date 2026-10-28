import { DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { enqueueJob, type Job } from "./jobs";
import { recordAudit } from "./audit";
import { securityOn } from "./two-factor";
import { erase, objectsOf, type Subject } from "./erasure";
import { outsideStores, twilioOf, type DataRequestEnvironment, type Pending } from "./data-requests";
import { SmsRejected } from "./sms-api";
import { credentials as smsCredentials } from "./sms";

/**
 * Retention policies (phase 16, step C6a; docs/SECURITY_STEP9.md): Settings › Security › Retention
 * (`security.manage`, behind `security_v1`). One policy per kind of data, "keep" by default or a
 * period of 30 days to 7 years. The sweep queues `retention.apply` at most hourly for a workspace
 * with a policy; each run takes a bounded batch per kind, and is in the audit log with its counts.
 *
 * - **Conversations** closed and untouched for the period go through C5's cascade (`erase` with
 *   only those conversations), with their files, Twilio records and report rows (`outsideStores`,
 *   counts kept). The contact stays; open and snoozed conversations are never touched.
 * - **Attachments** older than the period: the file deleted, the record kept as expired.
 * - **Call recordings:** the audio and Twilio's copy; any transcript stays.
 * - **Events:** contacts' events.
 * - **Logs:** model calls, the connector log, webhook deliveries, raw inbound payloads (and failed
 *   emails' raw files), email events, finished workflow runs and jobs, published outbox entries.
 *
 * Append-only logs accept these deletions only while `relay.retention` is set, by this job.
 */
export type RetentionKind = "conversations" | "attachments" | "recordings" | "events" | "logs";
export const RETENTION: { kind: RetentionKind; label: string; covers: string }[] = [
  { kind: "conversations", label: "Conversations", covers: "Closed conversations not touched for this long, with their messages, files and tickets. Reports keep their counts." },
  { kind: "attachments", label: "Attachments", covers: "Files older than this. The message stays and says the file has expired." },
  { kind: "recordings", label: "Call recordings", covers: "Call and voicemail recordings older than this, here and at Twilio. Transcripts stay." },
  { kind: "events", label: "Events", covers: "Events recorded about contacts (from the messenger or the API) older than this." },
  {
    kind: "logs",
    label: "Logs",
    covers: "Records of model calls, connector calls, webhook deliveries, incoming payloads, email events, finished workflow runs and background work. The audit log keeps its own retention.",
  },
];
export const PERIODS = [30, 90, 180, 365, 730, 1095, 2557] as const;
const MIN_DAYS = 30;
const MAX_DAYS = 2557;
const CONVERSATION_BATCH = 200;
const ROW_BATCH = 1000;
const HOURLY = 60 * 60_000;
type Policies = Record<RetentionKind, number | null>;
const column = (k: RetentionKind) => `${k}_days`;

async function policiesOf(db: Sql, w: string) {
  const r = (
    await db.query<Record<string, unknown>>(
      "SELECT conversations_days,attachments_days,recordings_days,events_days,logs_days,last_run_at,last_result,pending FROM retention_settings WHERE workspace_id=$1",
      [w],
    )
  ).rows[0];
  const policies = Object.fromEntries(RETENTION.map(({ kind }) => [kind, (r?.[column(kind)] as number | null) ?? null])) as Policies;
  return { policies, lastRunAt: r?.last_run_at ? new Date(r.last_run_at as string).toISOString() : null, lastResult: (r?.last_result as Record<string, number> | null) ?? null, pending: (r?.pending as Pending | null) ?? null };
}

/** What a set of policies would delete on the next run, before it's saved (bounded counts). */
async function wouldDelete(db: Sql, w: string, p: Policies) {
  const count = async (sql: string, days: number | null) =>
    days ? Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM (${sql} LIMIT 10001) x`, [w, days])).rows[0].n) : 0;
  return {
    conversations: await count("SELECT 1 FROM conversations WHERE workspace_id=$1 AND status='closed' AND updated_at<now()-make_interval(days=>$2)", p.conversations),
    attachments: await count(`SELECT 1 FROM attachments a WHERE workspace_id=$1 AND status IN ('clean','rejected','failed') AND created_at<now()-make_interval(days=>$2) AND NOT ${RECORDING}`, p.attachments),
    recordings: await count(`SELECT 1 FROM attachments a WHERE workspace_id=$1 AND status IN ('clean','rejected','failed') AND created_at<now()-make_interval(days=>$2) AND ${RECORDING}`, p.recordings),
    events: await count("SELECT 1 FROM contact_events WHERE workspace_id=$1 AND occurred_at<now()-make_interval(days=>$2)", p.events),
  };
}
/** An attachment that is a call's recording (or a voicemail): written by the voice adapter's part. */
const RECORDING = `EXISTS (SELECT 1 FROM conversation_parts p WHERE p.workspace_id=a.workspace_id AND p.conversation_id=a.conversation_id AND p.data->>'attachmentId'=a.id AND p.data->'voice' ? 'recording')`;

export async function readRetention(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  const r = await policiesOf(db, w);
  return { kinds: RETENTION, periods: PERIODS, policies: r.policies, lastRunAt: r.lastRunAt, lastResult: r.lastResult };
}

function readPolicies(p: Record<string, unknown>): Policies {
  const out = {} as Policies;
  for (const { kind, label } of RETENTION) {
    const v = p[kind];
    if (v === null || v === undefined || v === "" || v === "keep") out[kind] = null;
    else {
      const days = Number(v);
      if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) throw new DomainError("INVALID_FIELD", `${label}: keep, or a period from 30 days to 7 years.`, 400, { field: kind });
      out[kind] = days;
    }
  }
  return out;
}

export async function changeRetention(db: Sql, w: string, principal: string, p: Record<string, unknown>) {
  const me = await authorize(db, w, principal, "security.manage");
  await securityOn(db, w);
  if (p.action === "preview") return { wouldDelete: await wouldDelete(db, w, readPolicies((p.policies ?? {}) as Record<string, unknown>)) };
  if (p.action === "policies") {
    const policies = readPolicies((p.policies ?? {}) as Record<string, unknown>);
    await db.query(
      `INSERT INTO retention_settings(workspace_id,conversations_days,attachments_days,recordings_days,events_days,logs_days,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(workspace_id) DO UPDATE SET conversations_days=EXCLUDED.conversations_days,attachments_days=EXCLUDED.attachments_days,recordings_days=EXCLUDED.recordings_days,
         events_days=EXCLUDED.events_days,logs_days=EXCLUDED.logs_days,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [w, policies.conversations, policies.attachments, policies.recordings, policies.events, policies.logs, me.id],
    );
    return readRetention(db, w, principal);
  }
  if (p.action === "run") {
    await enqueueJob(db, w, "retention.apply", { asked: me.id }, {});
    return { queued: true, ...(await readRetention(db, w, principal)) };
  }
  throw new DomainError("INVALID_RETENTION", "Choose preview, policies or run.");
}

/** From the sweep: a run queued at most hourly, for a workspace with a policy (or a run to finish). */
export async function scheduleRetention(connect: Connect, w: string) {
  return tenant(connect, w, async (db) => {
    const r = await policiesOf(db, w);
    const any = Object.values(r.policies).some((d) => d) || r.pending;
    if (!any || (r.lastRunAt && Date.now() - new Date(r.lastRunAt).getTime() < HOURLY)) return false;
    if ((await db.query("SELECT 1 FROM jobs WHERE workspace_id=$1 AND kind='retention.apply' AND state IN ('queued','running')", [w])).rows.length) return false;
    await enqueueJob(db, w, "retention.apply", {}, {});
    return true;
  });
}

/** A run's own transaction, with `relay.retention` set for the append-only logs. */
const run = <T>(connect: Connect, w: string, f: (db: Sql) => Promise<T>) =>
  tenant(connect, w, async (db) => {
    await db.query("SELECT set_config('relay.retention','on',true)");
    return f(db);
  });
const deleted = async (db: Sql, sql: string, values: unknown[]) => (await db.query(sql + " RETURNING 1", values)).rows.length;

export async function retentionJob(connect: Connect, env: DataRequestEnvironment, job: Job) {
  const w = job.workspace_id;
  const state = await tenant(connect, w, (db) => policiesOf(db, w));
  const p = state.policies;
  const counts: Record<string, number> = {};
  const add = (k: string, n: number) => {
    if (n) counts[k] = (counts[k] ?? 0) + n;
  };
  const persist = (pending: Pending | null) => tenant(connect, w, (db) => db.query("UPDATE retention_settings SET pending=$2 WHERE workspace_id=$1", [w, pending ? JSON.stringify(pending) : null]));
  // A previous run's files, report rows and Twilio records first.
  if (state.pending) {
    await outsideStores(connect, env, w, state.pending, persist);
    await persist(null);
  }
  // Conversations: C5's cascade with only those conversations; their files, report rows and Twilio records after.
  if (p.conversations) {
    const pending = await tenant(connect, w, async (db) => {
      const ids = (
        await db.query<{ id: string }>(
          "SELECT id FROM conversations WHERE workspace_id=$1 AND status='closed' AND updated_at<now()-make_interval(days=>$2) ORDER BY updated_at LIMIT $3",
          [w, p.conversations, CONVERSATION_BATCH],
        )
      ).rows.map((r) => r.id);
      if (!ids.length) return null;
      const s: Subject = { contacts: [], identities: [], conversations: ids, others: [], parts: [], addresses: [], externalIds: [] };
      const kept: Pending = { ...(await objectsOf(db, w, s)), analytics: { conversations: ids, contacts: [], identities: [] }, twilio: await twilioOf(db, w, s), done: {} };
      const rows = await erase(db, w, s);
      add("conversations", rows.conversations ?? 0);
      add("conversation records", Object.values(rows).reduce((a, b) => a + b, 0) - (rows.conversations ?? 0));
      await db.query("UPDATE retention_settings SET pending=$2 WHERE workspace_id=$1", [w, JSON.stringify(kept)]);
      return kept;
    });
    if (pending) {
      const done = await outsideStores(connect, env, w, pending, persist);
      add("files", done.files ?? 0);
      add("Twilio records", done.twilio ? done.twilio.recordings + done.twilio.messages : 0);
      await persist(null);
    }
  }
  // Attachments and recordings: the file deleted, the record kept as expired.
  for (const kind of ["attachments", "recordings"] as const) {
    const days = p[kind];
    if (!days) continue;
    const files = await tenant(connect, w, async (db) =>
      (
        await db.query<{ id: string; object_key: string | null; clean_key: string | null; preview_key: string | null }>(
          `SELECT id,object_key,clean_key,preview_key FROM attachments a WHERE workspace_id=$1 AND status IN ('clean','rejected','failed')
           AND created_at<now()-make_interval(days=>$2) AND ${kind === "recordings" ? "" : "NOT "}${RECORDING} ORDER BY created_at LIMIT $3`,
          [w, days, ROW_BATCH],
        )
      ).rows,
    );
    for (const f of files) {
      if (env.storage) {
        if (f.object_key) await env.storage.deleteQuarantine(f.object_key);
        for (const k of [f.clean_key, f.preview_key]) if (k && env.storage.deleteClean) await env.storage.deleteClean(k);
      }
      await tenant(connect, w, (db) => db.query("UPDATE attachments SET status='expired',clean_key=NULL,preview_key=NULL,version=version+1 WHERE workspace_id=$1 AND id=$2", [w, f.id]));
    }
    add(kind === "recordings" ? "recordings" : "attachments", files.length);
  }
  // Twilio's copies of recordings past the period (calls; voicemails' too), then forgotten so they aren't asked again.
  if (p.recordings && env.sms && env.key) {
    const due = await tenant(connect, w, async (db) => ({
      calls: (
        await db.query<{ id: string; sid: string }>(
          "SELECT id,recording_sid AS sid FROM voice_calls WHERE workspace_id=$1 AND recording_sid IS NOT NULL AND started_at<now()-make_interval(days=>$2) LIMIT $3",
          [w, p.recordings, ROW_BATCH],
        )
      ).rows,
      voicemails: (
        await db.query<{ id: string; sid: string }>(
          "SELECT id,payload->>'RecordingSid' AS sid FROM voice_inbound WHERE workspace_id=$1 AND payload ? 'RecordingSid' AND received_at<now()-make_interval(days=>$2) LIMIT $3",
          [w, p.recordings, ROW_BATCH],
        )
      ).rows,
      account: await smsCredentials(db, w, env.key!),
    }));
    if (due.account)
      for (const [table, list] of [["voice_calls", due.calls], ["voice_inbound", due.voicemails]] as const)
        for (const r of list) {
          try {
            await env.sms.deleteRecording(due.account, r.sid);
            add("Twilio recordings", 1);
          } catch (e) {
            if (!(e instanceof SmsRejected)) throw e;
            add("Twilio refused", 1);
          }
          await tenant(connect, w, (db) =>
            db.query(
              table === "voice_calls"
                ? "UPDATE voice_calls SET recording_sid=NULL WHERE workspace_id=$1 AND id=$2"
                : "UPDATE voice_inbound SET payload=payload-'RecordingSid'-'RecordingUrl' WHERE workspace_id=$1 AND id=$2",
              [w, r.id],
            ),
          );
        }
  }
  // Events.
  if (p.events)
    add(
      "events",
      await run(connect, w, (db) =>
        deleted(db, "DELETE FROM contact_events WHERE workspace_id=$1 AND id IN (SELECT id FROM contact_events WHERE workspace_id=$1 AND occurred_at<now()-make_interval(days=>$2) LIMIT $3)", [w, p.events, ROW_BATCH]),
      ),
    );
  // Logs.
  if (p.logs) {
    const days = p.logs;
    const older = (table: string, at: string, extra = "") =>
      `DELETE FROM ${table} WHERE workspace_id=$1 AND ctid IN (SELECT ctid FROM ${table} WHERE workspace_id=$1 AND ${at}<now()-make_interval(days=>$2) ${extra} LIMIT ${ROW_BATCH})`;
    const failedRaw = await tenant(connect, w, async (db) =>
      (await db.query<{ raw_key: string }>("SELECT raw_key FROM email_inbound WHERE workspace_id=$1 AND status<>'received' AND received_at<now()-make_interval(days=>$2) LIMIT $3", [w, days, ROW_BATCH]))
        .rows,
    );
    for (const r of failedRaw) if (env.storage && r.raw_key) await env.storage.deleteQuarantine(r.raw_key);
    await run(connect, w, async (db) => {
      add("model calls", await deleted(db, older("ai_model_calls", "created_at"), [w, days]));
      add("connector calls", await deleted(db, older("ai_connector_calls", "created_at"), [w, days]));
      add(
        "webhook attempts",
        await deleted(
          db,
          `DELETE FROM webhook_attempts WHERE workspace_id=$1 AND delivery_id IN (SELECT id FROM webhook_deliveries WHERE workspace_id=$1 AND status<>'pending' AND created_at<now()-make_interval(days=>$2) LIMIT ${ROW_BATCH})`,
          [w, days],
        ),
      );
      add("webhook deliveries", await deleted(db, older("webhook_deliveries", "created_at", "AND status<>'pending'"), [w, days]));
      for (const t of ["sms_inbound", "whatsapp_inbound", "meta_inbound", "community_inbound", "voice_inbound", "email_inbound"])
        add("incoming payloads", await deleted(db, older(t, "received_at", "AND status<>'received'"), [w, days]));
      add("email events", await deleted(db, older("email_events", "created_at"), [w, days]));
      const runs = `(SELECT id FROM workflow_runs WHERE workspace_id=$1 AND ended_at IS NOT NULL AND ended_at<now()-make_interval(days=>$2) LIMIT ${ROW_BATCH})`;
      await db.query(`UPDATE workflow_alerts SET last_run_id=NULL WHERE workspace_id=$1 AND last_run_id IN ${runs}`, [w, days]);
      await db.query(`DELETE FROM workflow_run_steps WHERE workspace_id=$1 AND run_id IN ${runs}`, [w, days]);
      add("workflow runs", await deleted(db, `DELETE FROM workflow_runs WHERE workspace_id=$1 AND id IN ${runs}`, [w, days]));
      const jobs = `(SELECT id FROM jobs WHERE workspace_id=$1 AND state NOT IN ('queued','running') AND updated_at<now()-make_interval(days=>$2) AND kind<>'retention.apply' LIMIT ${ROW_BATCH})`;
      await db.query(`UPDATE attachments SET job_id=NULL WHERE workspace_id=$1 AND job_id IN ${jobs}`, [w, days]);
      await db.query(`DELETE FROM job_events WHERE workspace_id=$1 AND job_id IN ${jobs}`, [w, days]);
      add("finished jobs", await deleted(db, `DELETE FROM jobs WHERE workspace_id=$1 AND id IN ${jobs}`, [w, days]));
      add("outbox entries", await deleted(db, older("outbox", "published_at", "AND published_at IS NOT NULL"), [w, days]));
    });
  }
  await tenant(connect, w, async (db) => {
    await db.query("UPDATE retention_settings SET last_run_at=now(),last_result=$2 WHERE workspace_id=$1", [w, JSON.stringify(counts)]);
    if (Object.keys(counts).length) await recordAudit(db, w, "data.retention_applied", { type: "workspace", id: w }, counts);
  });
  return { done: true, result: counts };
}
