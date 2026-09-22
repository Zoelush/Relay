import { tenant, assert, type Connect, type Sql, DomainError } from "./db";

export type Job = {
  workspace_id: string;
  id: string;
  kind: string;
  state: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  attempts: number;
  version: string;
  lease_token: string;
  owner_identity_id: string | null;
  owner_teammate_id: string | null;
  last_error: string | null;
};
export type JobHandler = (
  job: Job,
) => Promise<{ done: boolean; result: Record<string, unknown> }>;
export type WorkMessage =
  { workspace: string; jobId: string } | { workspace: string; sweep: true };
export async function enqueueJob(
  db: Sql,
  w: string,
  kind: string,
  payload: Record<string, unknown>,
  owner: { identityId?: string; teammateId?: string },
) {
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO jobs(workspace_id,id,kind,state,payload,owner_identity_id,owner_teammate_id) VALUES($1,$2,$3,'queued',$4,$5,$6)",
    [
      w,
      id,
      kind,
      JSON.stringify(payload),
      owner.identityId ?? null,
      owner.teammateId ?? null,
    ],
  );
  await db.query(
    "INSERT INTO outbox(workspace_id,id,kind,resource_id,payload) VALUES($1,$2,'job',$2,$3)",
    [w, id, JSON.stringify({ jobId: id })],
  );
  return id;
}
export function jobStatus(job: Job) {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    result: job.result,
    attempts: job.attempts,
    version: job.version,
    error: job.last_error,
  };
}
export async function readJob(
  db: Sql,
  w: string,
  id: string,
  owner: { identityId?: string; teammateId?: string },
) {
  const job = (
    await db.query<Job>(
      "SELECT * FROM jobs WHERE workspace_id=$1 AND id=$2 AND (owner_identity_id=$3 OR owner_teammate_id=$4)",
      [w, id, owner.identityId ?? null, owner.teammateId ?? null],
    )
  ).rows[0];
  assert(job, "JOB_NOT_FOUND", "Job unavailable.", 404);
  return jobStatus(job);
}
export async function dispatchJobs(
  connect: Connect,
  w: string,
  send: (message: WorkMessage) => Promise<void>,
) {
  const jobs = await tenant(
    connect,
    w,
    async (db) =>
      (
        await db.query<{ id: string; resource_id: string }>(
          "SELECT id,resource_id FROM outbox WHERE workspace_id=$1 AND kind='job' AND published_at IS NULL ORDER BY created_at,id LIMIT 100",
          [w],
        )
      ).rows,
  );
  for (const job of jobs) {
    await send({ workspace: w, jobId: job.resource_id });
    await tenant(connect, w, (db) =>
      db.query(
        "UPDATE outbox SET published_at=now() WHERE workspace_id=$1 AND id=$2",
        [w, job.id],
      ),
    );
  }
  // A process may crash after a checkpoint or while holding a lease. Recovery reuses the same job ID.
  const recover = await tenant(
    connect,
    w,
    async (db) =>
      (
        await db.query<{ id: string }>(
          "SELECT id FROM jobs WHERE workspace_id=$1 AND state IN ('queued','running') AND (lease_until IS NULL OR lease_until<now()) ORDER BY created_at,id LIMIT 100",
          [w],
        )
      ).rows,
  );
  for (const job of recover) await send({ workspace: w, jobId: job.id });
}
export async function runJob(
  connect: Connect,
  w: string,
  id: string,
  handlers: Record<string, JobHandler>,
) {
  const lease = crypto.randomUUID();
  const job = await tenant(
    connect,
    w,
    async (db) =>
      (
        await db.query<Job>(
          "UPDATE jobs SET state='running',attempts=attempts+1,version=version+1,lease_token=$3,lease_until=now()+interval '2 minutes',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state IN ('queued','running') AND (lease_until IS NULL OR lease_until<now()) RETURNING *",
          [w, id, lease],
        )
      ).rows[0],
  );
  if (!job) {
    const row = await tenant(
      connect,
      w,
      async (db) =>
        (
          await db.query<{ state: string }>(
            "SELECT state FROM jobs WHERE workspace_id=$1 AND id=$2",
            [w, id],
          )
        ).rows[0],
    );
    return { state: row?.state ?? "missing", retry: row?.state === "running" };
  }
  try {
    assert(
      handlers[job.kind],
      "JOB_HANDLER_UNAVAILABLE",
      "Job handler unavailable.",
      503,
    );
    const outcome = await handlers[job.kind](job);
    const state = outcome.done ? "succeeded" : "queued";
    await tenant(connect, w, (db) =>
      db.query(
        "UPDATE jobs SET state=$4,result=$5,lease_until=NULL,lease_token=NULL,attempts=CASE WHEN $4='queued' THEN 0 ELSE attempts END,version=version+1,updated_at=now(),completed_at=CASE WHEN $4='succeeded' THEN now() ELSE NULL END,last_error=NULL WHERE workspace_id=$1 AND id=$2 AND lease_token=$3",
        [w, id, lease, state, JSON.stringify(outcome.result)],
      ),
    );
    return { state, retry: !outcome.done, continued: !outcome.done };
  } catch (error) {
    const state = job.attempts >= 5 ? "dead_letter" : "queued";
    await tenant(connect, w, (db) =>
      db.query(
        "UPDATE jobs SET state=$4,last_error=$5,lease_until=NULL,lease_token=NULL,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND lease_token=$3",
        [
          w,
          id,
          lease,
          state,
          error instanceof DomainError ? error.code : "JOB_EXECUTION_FAILED",
        ],
      ),
    );
    return { state, retry: state === "queued" };
  }
}
