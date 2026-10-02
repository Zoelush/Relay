import {
  assert,
  DomainError,
  once,
  tenant,
  type Connect,
  type Sql,
} from "./db";
import { authorize } from "./policy";
import { command, conversation, type Command } from "./conversations";
import { enqueueJob, type Job } from "./jobs";
import { checkTargets, validateActions, type MacroAction } from "./macros";
import { LIST_STATUSES, visibleView } from "./inbox-views";

/** Conversations in one operation, items per job step, and the undo window. */
export const BULK_LIMIT = 5000;
const STEP = 25;
export const UNDO_WINDOW_MS = 10_000;
/** A prepared operation must be committed within this time, or prepared again. */
const PREPARE_TTL_MS = 10 * 60_000;

type BulkAction = Exclude<MacroAction, { type: "attribute_set" }>;
type Operation = {
  id: string;
  teammate_id: string;
  action: BulkAction;
  status: string;
  total: number;
  created_at: string;
  undo_until: string | null;
};
/** The fields an action changes, captured before and after it runs on one conversation. */
type Fields = {
  status?: string;
  snooze_until?: string | null;
  snooze_unassign?: boolean;
  assigned?: string;
  team_id?: string | null;
  priority?: boolean;
  tag?: boolean;
  ticket_state?: string | null;
  linked?: boolean;
};

function bulkAction(input: unknown): BulkAction {
  const [action] = validateActions([input]);
  if (action.type === "attribute_set")
    throw new DomainError(
      "INVALID_BULK",
      "Choose assign, tag, priority, snooze, close or reopen.",
      400,
    );
  return action;
}

/** Reads the fields `action` changes on a conversation (resolved through merges). */
async function fields(
  db: Sql,
  w: string,
  id: string,
  action: BulkAction,
): Promise<Fields> {
  const c = await conversation(db, w, id);
  switch (action.type) {
    case "assign":
      return { assigned: c.assigned, team_id: c.team_id ?? null };
    case "priority":
      return { priority: !!c.priority };
    case "ticket_link":
      return {
        linked:
          (
            await db.query(
              "SELECT 1 FROM ticket_links WHERE workspace_id=$1 AND ticket_id=$2 AND conversation_id=$3",
              [w, action.trackerId, c.id],
            )
          ).rows.length > 0,
      };
    case "ticket_state":
      return {
        ticket_state:
          (
            await db.query<{ state_id: string }>(
              "SELECT state_id FROM tickets WHERE workspace_id=$1 AND conversation_id=$2",
              [w, c.id],
            )
          ).rows[0]?.state_id ?? null,
      };
    case "tag_add":
    case "tag_remove":
      return {
        tag:
          (
            await db.query(
              "SELECT 1 FROM conversation_tags WHERE workspace_id=$1 AND conversation_id=$2 AND tag_id=$3",
              [w, c.id, action.tagId],
            )
          ).rows.length > 0,
      };
    default:
      return {
        status: c.status,
        snooze_until: c.snooze_until
          ? new Date(c.snooze_until as string).toISOString()
          : null,
        snooze_unassign: !!(c as { snooze_unassign?: boolean }).snooze_unassign,
      };
  }
}

const toCommand = (action: BulkAction, timezone: string): Command => {
  switch (action.type) {
    case "assign":
      return {
        action: "assign",
        teammateId: action.teammateId,
        teamId: action.teamId,
      };
    case "tag_add":
    case "tag_remove":
      return { action: action.type, tagId: action.tagId };
    case "ticket_link":
      return { action: "ticket_link", trackerId: action.trackerId };
    case "ticket_state":
      return { action: "ticket_state", stateId: action.stateId };
    case "priority":
      return { action: "priority", value: action.value };
    case "snooze":
      return { action: "snooze", preset: action.preset, timezone };
    default:
      return { action: action.type };
  }
};

/**
 * The command that puts back `before`, or null when the action changed nothing. Status is
 * restored as it was: open, closed, or snoozed again until its original time if still ahead.
 */
function inverse(
  action: BulkAction,
  before: Fields,
  after: Fields,
): Command | null {
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  switch (action.type) {
    case "assign":
      return {
        action: "assign",
        teammateId: before.assigned || undefined,
        teamId: before.team_id || undefined,
      };
    case "ticket_link":
      return { action: "ticket_unlink", trackerId: action.trackerId };
    case "ticket_state":
      // Back along the type's transitions; if the graph has no way back, undo reports it.
      return before.ticket_state
        ? { action: "ticket_state", stateId: before.ticket_state }
        : null;
    case "priority":
      return { action: "priority", value: !!before.priority };
    case "tag_add":
    case "tag_remove":
      return {
        action: before.tag ? "tag_add" : "tag_remove",
        tagId: action.tagId,
      };
    default:
      if (
        before.status === "snoozed" &&
        before.snooze_until &&
        Date.parse(before.snooze_until) > Date.now()
      )
        return {
          action: "snooze",
          wakeAt: before.snooze_until,
          unassignOnWake: !!before.snooze_unassign,
        };
      return { action: before.status === "closed" ? "close" : "reopen" };
  }
}

/** Whether the fields still hold what the action set (for status, `snooze_until` too). */
const unchanged = (current: Fields, after: Fields) =>
  JSON.stringify(current) === JSON.stringify(after);

async function operation(
  db: Sql,
  w: string,
  teammateId: string,
  id: unknown,
  lock = true,
) {
  const op = (
    await db.query<Operation>(
      "SELECT id,teammate_id,action,status,total,created_at,undo_until FROM bulk_operations WHERE workspace_id=$1 AND id=$2" +
        (lock ? " FOR UPDATE" : ""),
      [w, String(id ?? "")],
    )
  ).rows[0];
  // Operations belong to the teammate who prepared them.
  assert(
    op && op.teammate_id === teammateId,
    "BULK_NOT_FOUND",
    "Bulk action unavailable.",
    404,
  );
  return op;
}

/**
 * Resolves and counts a selection (picked conversation ids, or every conversation in a view)
 * and stores it as a snapshot. The count the teammate confirms is this server count.
 */
export async function prepareBulk(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const t = await authorize(db, w, principal, "conversations.read");
  const action = bulkAction(p.action);
  await checkTargets(db, w, [action]);
  let ids: string[];
  if (p.viewId !== undefined) {
    const view = await visibleView(db, w, t, String(p.viewId));
    // "Everything in this view" means what the list shows: the view in the status picked.
    const status = p.status === undefined ? "all" : String(p.status);
    assert(
      status === "all" || (LIST_STATUSES as readonly string[]).includes(status),
      "INVALID_STATUS",
      "Choose an available status.",
    );
    const column = ["open", "snoozed", "closed"].includes(status)
      ? "m.status"
      : "m.ticket_kind";
    ids = (
      await db.query<{ id: string }>(
        `SELECT m.conversation_id AS id FROM inbox_filter_members m JOIN conversations c ON c.workspace_id=m.workspace_id AND c.id=m.conversation_id
        WHERE m.workspace_id=$1 AND m.set_id=$2 AND c.merged_into_id IS NULL${status === "all" ? "" : ` AND ${column}=$4`}
        ORDER BY m.created_at DESC,m.conversation_id DESC LIMIT $3`,
        [w, view.set_id, BULK_LIMIT + 1, ...(status === "all" ? [] : [status])],
      )
    ).rows.map((r) => r.id);
  } else {
    assert(
      Array.isArray(p.conversationIds) &&
        p.conversationIds.every((x) => typeof x === "string"),
      "INVALID_BULK",
      "Choose conversations.",
    );
    const requested = [...new Set(p.conversationIds as string[])];
    assert(
      requested.length <= BULK_LIMIT,
      "BULK_TOO_LARGE",
      "Choose up to 5,000 conversations at a time.",
    );
    // Unknown ids, and conversations from other workspaces, are simply not counted.
    ids = (
      await db.query<{ id: string }>(
        "SELECT id FROM conversations WHERE workspace_id=$1 AND id=ANY($2::text[]) AND merged_into_id IS NULL",
        [w, requested],
      )
    ).rows
      .map((r) => r.id)
      .sort((a, b) => requested.indexOf(a) - requested.indexOf(b));
  }
  assert(
    ids.length > 0,
    "BULK_EMPTY",
    "None of the selected conversations are available.",
  );
  assert(
    ids.length <= BULK_LIMIT,
    "BULK_TOO_LARGE",
    "This view has more than 5,000 conversations. Narrow it first.",
  );
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO bulk_operations(workspace_id,id,teammate_id,action,selection,total) VALUES($1,$2,$3,$4,$5,$6)",
    [
      w,
      id,
      t.id,
      JSON.stringify(action),
      JSON.stringify(
        p.viewId !== undefined
          ? { viewId: p.viewId, status: p.status ?? "all" }
          : { picked: ids.length },
      ),
      ids.length,
    ],
  );
  await db.query(
    "INSERT INTO bulk_items(workspace_id,operation_id,conversation_id,position) SELECT $1,$2,x.id,x.n FROM unnest($3::text[]) WITH ORDINALITY AS x(id,n)",
    [w, id, ids],
  );
  return { operationId: id, total: ids.length, action };
}

/** Starts a prepared operation. Undo is possible for ten seconds from now (server time). */
export async function commitBulk(
  db: Sql,
  w: string,
  principal: string,
  key: string,
  p: Record<string, unknown>,
) {
  return once(db, w, "bulk.commit:" + principal, key, p, async () => {
    const t = await authorize(db, w, principal, "conversations.read");
    const op = await operation(db, w, t.id, p.operationId);
    assert(
      op.status === "prepared",
      "BULK_STARTED",
      "This bulk action has already started.",
      409,
    );
    assert(
      Date.now() - Date.parse(op.created_at) < PREPARE_TTL_MS,
      "BULK_STALE",
      "This selection is out of date. Select the conversations again.",
      409,
    );
    const jobId = await enqueueJob(
      db,
      w,
      "bulk.apply",
      {
        operationId: op.id,
        timezone: typeof p.timezone === "string" ? p.timezone : "UTC",
      },
      { teammateId: t.id },
    );
    const undoUntil = (
      await db.query<{ undo_until: string }>(
        `UPDATE bulk_operations SET status='running',committed_at=now(),undo_until=now()+make_interval(secs=>$3),job_id=$4
        WHERE workspace_id=$1 AND id=$2 RETURNING undo_until`,
        [w, op.id, UNDO_WINDOW_MS / 1000, jobId],
      )
    ).rows[0].undo_until;
    return {
      jobId,
      undoUntil: new Date(undoUntil).toISOString(),
      // The browser counts down from this, so its own clock does not matter.
      undoMs: UNDO_WINDOW_MS,
    };
  });
}

async function principalOf(db: Sql, w: string, teammateId: string) {
  return (
    await db.query<{ principal_id: string }>(
      "SELECT principal_id FROM teammates WHERE workspace_id=$1 AND id=$2",
      [w, teammateId],
    )
  ).rows[0].principal_id;
}

/**
 * One step of an apply job: up to 25 pending conversations, each through the ordinary command
 * as the operation's teammate, in its own savepoint so a failure is recorded without undoing
 * the others. Idempotency keys per item make a retried step apply nothing twice.
 */
export async function runBulkApply(connect: Connect, job: Job) {
  return tenant(connect, job.workspace_id, async (db) => {
    const w = job.workspace_id;
    const op = (
      await db.query<Operation>(
        "SELECT id,teammate_id,action,status FROM bulk_operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [w, job.payload.operationId],
      )
    ).rows[0];
    if (!op || op.status !== "running")
      return { done: true, result: { stopped: op?.status ?? "missing" } };
    const principal = await principalOf(db, w, op.teammate_id);
    const items = (
      await db.query<{ conversation_id: string }>(
        "SELECT conversation_id FROM bulk_items WHERE workspace_id=$1 AND operation_id=$2 AND state='pending' ORDER BY position LIMIT $3",
        [w, op.id, STEP],
      )
    ).rows;
    for (const { conversation_id: id } of items) {
      await db.query("SAVEPOINT bulk_item");
      try {
        const before = await fields(db, w, id, op.action);
        await command(
          db,
          w,
          { type: "teammate", principal },
          `bulk:${op.id}:${id}`,
          {
            ...toCommand(op.action, String(job.payload.timezone ?? "UTC")),
            conversationId: id,
          },
        );
        const after = await fields(db, w, id, op.action);
        await db.query("RELEASE SAVEPOINT bulk_item");
        await db.query(
          "UPDATE bulk_items SET state='applied',before=$4,after=$5 WHERE workspace_id=$1 AND operation_id=$2 AND conversation_id=$3",
          [w, op.id, id, JSON.stringify(before), JSON.stringify(after)],
        );
      } catch (e) {
        await db.query("ROLLBACK TO SAVEPOINT bulk_item");
        await db.query(
          "UPDATE bulk_items SET state='failed',error=$4 WHERE workspace_id=$1 AND operation_id=$2 AND conversation_id=$3",
          [
            w,
            op.id,
            id,
            e instanceof DomainError
              ? e.message
              : "This conversation could not be changed.",
          ],
        );
      }
    }
    if (items.length < STEP)
      await db.query(
        "UPDATE bulk_operations SET status='done',completed_at=now() WHERE workspace_id=$1 AND id=$2 AND status='running'",
        [w, op.id],
      );
    return { done: items.length < STEP, result: await counts(db, w, op.id) };
  });
}

/**
 * Undoes an operation within ten seconds of its commit (server time): conversations not yet
 * reached are cancelled, and a job reverses the rest, skipping any someone else has changed.
 */
export async function undoBulk(
  db: Sql,
  w: string,
  principal: string,
  key: string,
  p: Record<string, unknown>,
) {
  return once(db, w, "bulk.undo:" + principal, key, p, async () => {
    const t = await authorize(db, w, principal, "conversations.read");
    const op = await operation(db, w, t.id, p.operationId);
    assert(
      op.status === "running" || op.status === "done",
      "BULK_UNDONE",
      "This bulk action cannot be undone now.",
      409,
    );
    const open = (
      await db.query<{ open: boolean }>(
        "SELECT now()<=undo_until AS open FROM bulk_operations WHERE workspace_id=$1 AND id=$2",
        [w, op.id],
      )
    ).rows[0].open;
    assert(
      open,
      "UNDO_EXPIRED",
      "The undo window for this bulk action has passed.",
      409,
    );
    await db.query(
      "UPDATE bulk_items SET state='cancelled' WHERE workspace_id=$1 AND operation_id=$2 AND state='pending'",
      [w, op.id],
    );
    const jobId = await enqueueJob(
      db,
      w,
      "bulk.undo",
      { operationId: op.id },
      { teammateId: t.id },
    );
    await db.query(
      "UPDATE bulk_operations SET status='undoing',undo_requested_at=now(),undo_job_id=$3 WHERE workspace_id=$1 AND id=$2",
      [w, op.id, jobId],
    );
    return { jobId };
  });
}

/**
 * One step of an undo job: for each applied conversation, the reversing command runs only if the
 * changed field still holds what the bulk action set; otherwise it is left alone as a conflict.
 */
export async function runBulkUndo(connect: Connect, job: Job) {
  return tenant(connect, job.workspace_id, async (db) => {
    const w = job.workspace_id;
    const op = (
      await db.query<Operation>(
        "SELECT id,teammate_id,action,status FROM bulk_operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [w, job.payload.operationId],
      )
    ).rows[0];
    if (!op || op.status !== "undoing")
      return { done: true, result: { stopped: op?.status ?? "missing" } };
    const principal = await principalOf(db, w, op.teammate_id);
    const items = (
      await db.query<{
        conversation_id: string;
        before: Fields;
        after: Fields;
      }>(
        "SELECT conversation_id,before,after FROM bulk_items WHERE workspace_id=$1 AND operation_id=$2 AND state='applied' ORDER BY position LIMIT $3",
        [w, op.id, STEP],
      )
    ).rows;
    for (const item of items) {
      const id = item.conversation_id;
      await db.query("SAVEPOINT bulk_undo");
      try {
        const current = await fields(db, w, id, op.action);
        if (!unchanged(current, item.after)) {
          await db.query("RELEASE SAVEPOINT bulk_undo");
          await db.query(
            "UPDATE bulk_items SET state='conflict' WHERE workspace_id=$1 AND operation_id=$2 AND conversation_id=$3",
            [w, op.id, id],
          );
          continue;
        }
        const reverse = inverse(op.action, item.before, item.after);
        if (reverse)
          await command(
            db,
            w,
            { type: "teammate", principal },
            `bulk-undo:${op.id}:${id}`,
            {
              ...reverse,
              conversationId: id,
            },
          );
        await db.query("RELEASE SAVEPOINT bulk_undo");
        await db.query(
          "UPDATE bulk_items SET state='undone' WHERE workspace_id=$1 AND operation_id=$2 AND conversation_id=$3",
          [w, op.id, id],
        );
      } catch (e) {
        await db.query("ROLLBACK TO SAVEPOINT bulk_undo");
        await db.query(
          "UPDATE bulk_items SET state='conflict',undo_error=$4 WHERE workspace_id=$1 AND operation_id=$2 AND conversation_id=$3",
          [
            w,
            op.id,
            id,
            e instanceof DomainError
              ? e.message
              : "This conversation could not be restored.",
          ],
        );
      }
    }
    if (items.length < STEP)
      await db.query(
        "UPDATE bulk_operations SET status='undone',undone_at=now() WHERE workspace_id=$1 AND id=$2",
        [w, op.id],
      );
    return { done: items.length < STEP, result: await counts(db, w, op.id) };
  });
}

async function counts(db: Sql, w: string, id: string) {
  const rows = (
    await db.query<{ state: string; n: string }>(
      "SELECT state,count(*) AS n FROM bulk_items WHERE workspace_id=$1 AND operation_id=$2 GROUP BY state",
      [w, id],
    )
  ).rows;
  return Object.fromEntries(rows.map((r) => [r.state, Number(r.n)])) as Record<
    string,
    number
  >;
}

/** An operation's progress for its teammate: status, counts by item state, and the undo deadline. */
export async function readBulk(
  db: Sql,
  w: string,
  principal: string,
  id: string,
) {
  const t = await authorize(db, w, principal, "conversations.read");
  const op = await operation(db, w, t.id, id, false);
  const undoMs = (
    await db.query<{ ms: string | null }>(
      "SELECT greatest(0,extract(epoch FROM undo_until-now())*1000)::int AS ms FROM bulk_operations WHERE workspace_id=$1 AND id=$2",
      [w, op.id],
    )
  ).rows[0].ms;
  const conflicts = (
    await db.query<{ id: string; title: string }>(
      `SELECT c.id,c.title FROM bulk_items i JOIN conversations c ON c.workspace_id=i.workspace_id AND c.id=i.conversation_id
      WHERE i.workspace_id=$1 AND i.operation_id=$2 AND i.state='conflict' AND i.undo_error IS NULL ORDER BY i.position LIMIT 20`,
      [w, op.id],
    )
  ).rows;
  return {
    id: op.id,
    status: op.status,
    total: op.total,
    action: op.action,
    undoUntil: op.undo_until ? new Date(op.undo_until).toISOString() : null,
    undoMs: undoMs === null ? null : Number(undoMs),
    counts: await undoCounts(db, w, op.id),
    conflicts,
  };
}

/**
 * Counts with undo refusals apart: `conflict` is "changed since and left alone", while
 * `unreversed` is "could not be put back" (for example, a ticket state with no way back).
 */
async function undoCounts(db: Sql, w: string, id: string) {
  const all = await counts(db, w, id);
  const unreversed = Number(
    (
      await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM bulk_items WHERE workspace_id=$1 AND operation_id=$2 AND state='conflict' AND undo_error IS NOT NULL",
        [w, id],
      )
    ).rows[0].n,
  );
  if (unreversed) {
    all.unreversed = unreversed;
    all.conflict -= unreversed;
    if (!all.conflict) delete all.conflict;
  }
  return all;
}
