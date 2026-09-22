import { tenant, type Connect } from "./db";

/** Mark only after dispatch. A crash between dispatch and marking deliberately redelivers. */
export async function drainConversationOutbox(
  connect: Connect,
  workspace: string,
  dispatch: (ids: string[]) => Promise<void>,
  hints: string[] = [],
) {
  const rows = await tenant(
    connect,
    workspace,
    async (db) =>
      (
        await db.query<{ id: string; resource_id: string }>(
          "SELECT id,resource_id FROM outbox WHERE workspace_id=$1 AND published_at IS NULL AND kind='conversation' ORDER BY created_at,id LIMIT 500",
          [workspace],
        )
      ).rows,
  );
  if (!rows.length && !hints.length) return 0;
  await dispatch([...new Set([...hints, ...rows.map((r) => r.resource_id)])]);
  if (rows.length)
    await tenant(connect, workspace, (db) =>
      db.query(
        "UPDATE outbox SET published_at=now() WHERE workspace_id=$1 AND id=ANY($2::text[])",
        [workspace, rows.map((r) => r.id)],
      ),
    );
  return rows.length;
}

export async function drainJobStatusOutbox(
  connect: Connect,
  w: string,
  dispatch: (id: string) => Promise<void>,
) {
  const rows = await tenant(
    connect,
    w,
    async (db) =>
      (
        await db.query<{ id: string; resource_id: string }>(
          "SELECT id,resource_id FROM outbox WHERE workspace_id=$1 AND published_at IS NULL AND kind='job_status' ORDER BY created_at,id LIMIT 500",
          [w],
        )
      ).rows,
  );
  for (const id of new Set(rows.map((r) => r.resource_id))) await dispatch(id);
  if (rows.length)
    await tenant(connect, w, (db) =>
      db.query(
        "UPDATE outbox SET published_at=now() WHERE workspace_id=$1 AND id=ANY($2::text[])",
        [w, rows.map((r) => r.id)],
      ),
    );
  return rows.length;
}
