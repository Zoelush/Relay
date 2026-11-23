import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { recordAudit } from "./audit";
import { DIRECTORY, inDirectory, listingOf, SUBMISSION, submissionOut, type SubmissionRow } from "./directory";
import { parseClientId, releaseVersion } from "./oauth";

/**
 * Relay's operators review apps for the directory (docs/TEST_WORKSPACE_STEP6.md, T3b), through
 * `npm run directory` (scripts/directory.ts) and nothing else: there is no web surface for staff
 * to write through, so Relay's support access stays read-only.
 *
 * Every decision is written one tenant at a time — the directory's, then the developer's — and
 * recorded in the developer's workspace's audit log by the operator's name. Approving twice, or
 * after a crash between the two, finishes what the first began.
 */
const reviewer = (name: unknown) => {
  const s = typeof name === "string" ? name.trim() : "";
  if (!s || s.length > 80) throw new DomainError("INVALID_FIELD", "Say who you are (--as <name>).", 400);
  return s;
};
const reasonOf = (raw: unknown) => {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.length > 500) throw new DomainError("INVALID_FIELD", "Give the reason, in up to 500 characters: the developer and the workspaces see it.", 400);
  return s;
};
/** The operator, as this transaction's actor: the audit log names them, as it names a teammate. */
async function asOperator(db: Sql, name: string) {
  await db.query("SELECT set_config('relay.actor_name',$1,true), set_config('relay.actor_via','operator',true)", [`Relay review: ${name}`]);
}
/** In the developer's workspace, as the operator. */
const inApp = <T>(connect: Connect, appW: string, name: string, work: (db: Sql) => Promise<T>) =>
  tenant(connect, appW, async (db) => {
    await asOperator(db, name);
    return work(db);
  });
const appRef = (clientId: unknown) => {
  const ref = parseClientId(clientId);
  assert(ref, "INVALID_FIELD", "Name the app by its client id (relay_app_…).", 400);
  return ref!;
};
async function appName(connect: Connect, appW: string, appId: string) {
  const name = await tenant(connect, appW, async (db) => (await db.query<{ name: string }>("SELECT name FROM oauth_apps WHERE workspace_id=$1 AND id=$2", [appW, appId])).rows[0]?.name);
  assert(name !== undefined, "NOT_FOUND", "No such app.", 404);
  return name!;
}

/** What waits for an operator, oldest first. */
export async function pendingReviews(connect: Connect) {
  return inDirectory(connect, async (db) => (await db.query<SubmissionRow>(`${SUBMISSION} WHERE workspace_id=$1 AND state='pending' ORDER BY submitted_at`, [DIRECTORY])).rows.map(submissionOut));
}

/**
 * Approved: the version is released in the developer's workspace, the card becomes the reach later
 * versions are compared with, and the app is listed (or its listing follows the version).
 */
export async function approveSubmission(connect: Connect, id: unknown, by: unknown) {
  const name = reviewer(by);
  const sub = await inDirectory(connect, async (db) => (await db.query<SubmissionRow>(`${SUBMISSION} WHERE workspace_id=$1 AND id=$2`, [DIRECTORY, String(id ?? "")])).rows[0]);
  assert(sub, "NOT_FOUND", "No such submission.", 404);
  assert(sub!.state === "pending" || sub!.state === "approved", "NOT_PENDING", `That submission was ${sub!.state}.`, 409);
  const s = submissionOut(sub!);
  await inApp(connect, s.appW, name, async (db) => {
    const v = (await db.query<{ released_at: Date | null }>("SELECT released_at FROM oauth_app_versions WHERE workspace_id=$1 AND app_id=$2 AND version=$3", [s.appW, s.appId, s.version])).rows[0];
    assert(v, "NOT_FOUND", "That version no longer exists.", 404);
    if (!v.released_at) await releaseVersion(db, s.appW, s.appId, s.version, null, s.card.name);
    await db.query("UPDATE oauth_apps SET listed_card=$3 WHERE workspace_id=$1 AND id=$2", [s.appW, s.appId, JSON.stringify(s.card)]);
    if (s.state === "pending") await recordAudit(db, s.appW, "app_review.approved", { type: "app", id: `${s.appId}:${s.version}`, name: s.card.name }, { kind: s.kind, version: s.version });
  });
  await inDirectory(connect, async (db) => {
    await db.query("UPDATE app_submissions SET state='approved',decided_at=now(),decided_by=$3 WHERE workspace_id=$1 AND id=$2 AND state='pending'", [DIRECTORY, s.id, name]);
    await db.query(
      `INSERT INTO app_listings(workspace_id,app_workspace_id,app_id,card,version) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(workspace_id,app_workspace_id,app_id) DO UPDATE SET card=excluded.card,version=excluded.version`,
      [DIRECTORY, s.appW, s.appId, JSON.stringify(s.card), s.version],
    );
  });
  return { approved: s.id, app: s.card.name, version: s.version };
}

/** Rejected, with the reason the developer is shown. Nothing is released. */
export async function rejectSubmission(connect: Connect, id: unknown, by: unknown, why: unknown) {
  const name = reviewer(by);
  const reason = reasonOf(why);
  const s = await inDirectory(connect, async (db) => {
    const r = (
      await db.query<SubmissionRow>(
        `UPDATE app_submissions SET state='rejected',decided_at=now(),decided_by=$3,reason=$4 WHERE workspace_id=$1 AND id=$2 AND state='pending'
         RETURNING id,app_workspace_id,app_id,version,kind,card,widens,submitted_at,submitted_by_name,state,decided_at,decided_by,reason`,
        [DIRECTORY, String(id ?? ""), name, reason],
      )
    ).rows[0];
    assert(r, "NOT_PENDING", "No pending submission by that id.", 409);
    return submissionOut(r!);
  });
  await inApp(connect, s.appW, name, (db) => recordAudit(db, s.appW, "app_review.rejected", { type: "app", id: `${s.appId}:${s.version}`, name: s.card.name }, { kind: s.kind, version: s.version, reason }));
  return { rejected: s.id, app: s.card.name, version: s.version, reason };
}

/** Out of the directory: no new installs from it. Installations keep working. */
export async function delistApp(connect: Connect, clientId: unknown, by: unknown, why: unknown) {
  const name = reviewer(by);
  const reason = reasonOf(why);
  const { w, id } = appRef(clientId);
  await inDirectory(connect, async (db) => {
    const l = await listingOf(db, w, id);
    assert(l && !l.delistedAt, "NOT_LISTED", "That app isn't listed.", 409);
    await db.query("UPDATE app_listings SET delisted_at=now(),delisted_by=$4,delisted_reason=$5 WHERE workspace_id=$1 AND app_workspace_id=$2 AND app_id=$3", [DIRECTORY, w, id, name, reason]);
  });
  const app = await appName(connect, w, id);
  await inApp(connect, w, name, (db) => recordAudit(db, w, "app.delisted", { type: "app", id, name: app }, { reason }));
  return { delisted: app };
}

/** Back in the directory, as it was approved: no new review. */
export async function relistApp(connect: Connect, clientId: unknown, by: unknown) {
  const name = reviewer(by);
  const { w, id } = appRef(clientId);
  await inDirectory(connect, async (db) => {
    const l = await listingOf(db, w, id);
    assert(l?.delistedAt, "NOT_DELISTED", "That app isn't delisted.", 409);
    await db.query("UPDATE app_listings SET delisted_at=NULL,delisted_by=NULL,delisted_reason=NULL WHERE workspace_id=$1 AND app_workspace_id=$2 AND app_id=$3", [DIRECTORY, w, id]);
  });
  const app = await appName(connect, w, id);
  await inApp(connect, w, name, (db) => recordAudit(db, w, "app.relisted", { type: "app", id, name: app }));
  return { relisted: app };
}

/** Stopped everywhere: its tokens, its consent screen and its cards, with the reason shown. */
export async function suspendApp(connect: Connect, clientId: unknown, by: unknown, why: unknown) {
  const name = reviewer(by);
  const reason = reasonOf(why);
  const { w, id } = appRef(clientId);
  const app = await appName(connect, w, id);
  await inDirectory(connect, (db) =>
    db.query(
      `INSERT INTO app_suspensions(workspace_id,app_workspace_id,app_id,reason,suspended_by) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(workspace_id,app_workspace_id,app_id) DO UPDATE SET reason=excluded.reason,suspended_by=excluded.suspended_by,suspended_at=now(),lifted_at=NULL,lifted_by=NULL`,
      [DIRECTORY, w, id, reason, name],
    ),
  );
  await inApp(connect, w, name, (db) => recordAudit(db, w, "app.suspended", { type: "app", id, name: app }, { reason }));
  return { suspended: app, reason };
}

/** Lifted: the same tokens work again, and the app draws where it did. */
export async function liftSuspension(connect: Connect, clientId: unknown, by: unknown) {
  const name = reviewer(by);
  const { w, id } = appRef(clientId);
  const lifted = await inDirectory(connect, async (db) =>
    (await db.query("UPDATE app_suspensions SET lifted_at=now(),lifted_by=$4 WHERE workspace_id=$1 AND app_workspace_id=$2 AND app_id=$3 AND lifted_at IS NULL RETURNING app_id", [DIRECTORY, w, id, name])).rows.length,
  );
  assert(lifted > 0, "NOT_SUSPENDED", "That app isn't suspended.", 409);
  const app = await appName(connect, w, id);
  await inApp(connect, w, name, (db) => recordAudit(db, w, "app.suspension_lifted", { type: "app", id, name: app }));
  return { lifted: app };
}
