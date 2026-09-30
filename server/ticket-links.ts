import {
  assert,
  once,
  tenant,
  DomainError,
  type Connect,
  type Sql,
} from "./db";
import { authorize } from "./policy";
import {
  append,
  command,
  conversation,
  syncUnread,
  type Conversation,
} from "./conversations";
import { enqueueJob, type Job } from "./jobs";
import { loadType, requireTickets, stateRef, ticketOf } from "./tickets";

/**
 * Back-office and tracker tickets (phase 05, step A2). Both are internal conversations: no
 * customer identity, `visibility='internal'`, so no messenger can list or open them. A
 * back-office ticket is linked to the conversation it came from; a tracker is linked to many
 * customer conversations and can broadcast one update to all of them.
 */
export const MAX_LINKS = 5000;
const STEP = 25;
const BROADCAST_TTL_MS = 10 * 60_000;

type Author = { type: string; id: string; name?: string };
const LABEL = { back_office: "Back-office", tracker: "Tracker" } as const;

async function teammate(db: Sql, w: string, principal: string) {
  const t = await authorize(db, w, principal, "conversations.manage");
  return { type: "teammate", id: t.id, name: t.name } as Author;
}

/**
 * Creates a back-office ticket (from a customer conversation, which it is linked to) or a
 * tracker (on its own, or from a conversation, which is then linked). Idempotent on the key.
 */
export async function createInternalTicket(
  db: Sql,
  w: string,
  principal: string,
  key: string,
  p: Record<string, unknown>,
) {
  return once(db, w, "ticket.create:" + principal, key, p, async () => {
    const who = await teammate(db, w, principal);
    await requireTickets(db, w);
    const type = await loadType(db, w, p.typeId);
    assert(
      !type.archived,
      "TICKET_TYPE_NOT_FOUND",
      "Ticket type unavailable.",
      404,
    );
    assert(
      type.category === "back_office" || type.category === "tracker",
      "TICKET_CATEGORY",
      "Convert the conversation to create a customer ticket.",
      409,
    );
    const title = typeof p.title === "string" ? p.title.trim() : "";
    assert(
      title && title.length <= 200,
      "INVALID_TITLE",
      "Give the ticket a title of up to 200 characters.",
    );
    const state =
      type.states.find((s) => s.id === p.stateId) ??
      type.states.find((s) => s.kind !== "resolved");
    assert(
      state && state.kind !== "resolved",
      "TICKET_STATE",
      "Choose a starting state that is not resolved.",
    );
    let origin: Conversation | null = null;
    if (p.conversationId !== undefined) {
      origin = await conversation(db, w, String(p.conversationId), true);
      assert(
        origin.visibility !== "internal",
        "TICKET_LINK",
        "Link tickets to customer conversations only.",
        409,
      );
    }
    assert(
      origin || type.category === "tracker",
      "TICKET_ORIGIN",
      "A back-office ticket is created from the conversation it serves.",
    );
    const brand =
      origin?.brand_id ??
      (
        await db.query<{ id: string }>(
          "SELECT id FROM brands WHERE workspace_id=$1 ORDER BY id LIMIT 1",
          [w],
        )
      ).rows[0]?.id;
    const id = crypto.randomUUID();
    const c = (
      await db.query<Conversation>(
        `INSERT INTO conversations(workspace_id,id,brand_id,primary_identity_id,token_hash,name,email,title,visibility,channel,title_source,created_at,updated_at)
        VALUES($1,$2,$3,NULL,'',$4,'',$5,'internal','internal','teammate',now(),now()) RETURNING *`,
        [w, id, brand, LABEL[type.category], title],
      )
    ).rows[0];
    const opened = await append(
      db,
      w,
      c,
      who,
      "state_change",
      "",
      { from: null, to: "open" },
      "internal",
    );
    await db.query(
      "INSERT INTO conversation_cycles(workspace_id,conversation_id,opened_seq,opened_at) VALUES($1,$2,$3,$4)",
      [w, id, opened.seq, opened.created_at],
    );
    const number = (
      await db.query<{ number: string }>(
        `INSERT INTO ticket_counters(workspace_id,next) VALUES($1,2)
        ON CONFLICT(workspace_id) DO UPDATE SET next=ticket_counters.next+1 RETURNING next-1 AS number`,
        [w],
      )
    ).rows[0].number;
    await db.query(
      "INSERT INTO tickets(workspace_id,conversation_id,number,type_id,state_id,created_by) VALUES($1,$2,$3,$4,$5,$6)",
      [w, id, number, type.id, state.id, who.id],
    );
    await append(
      db,
      w,
      c,
      who,
      "system_event",
      "",
      {
        event: "ticket_created",
        number: Number(number),
        type: { id: type.id, name: type.name },
        state: stateRef(state),
      },
      "internal",
    );
    await syncUnread(db, w, c);
    if (origin) await link(db, w, who, c, origin, Number(number), type);
    return { conversationId: id, number: Number(number) };
  });
}

/** Records a link, with an internal event on both conversations. */
async function link(
  db: Sql,
  w: string,
  who: Author,
  ticket: Conversation,
  target: Conversation,
  number: number,
  type: { id: string; name: string; category: string },
) {
  const inserted = (
    await db.query(
      "INSERT INTO ticket_links(workspace_id,ticket_id,conversation_id,kind,created_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING 1",
      [w, ticket.id, target.id, type.category, who.id],
    )
  ).rows.length;
  if (!inserted) return false;
  await append(
    db,
    w,
    target,
    who,
    "system_event",
    "",
    {
      event: "ticket_linked",
      ticketId: ticket.id,
      number,
      type: { id: type.id, name: type.name },
      category: type.category,
    },
    "internal",
  );
  await append(
    db,
    w,
    ticket,
    who,
    "system_event",
    "",
    {
      event: "conversation_linked",
      conversationId: target.id,
      title: target.title,
    },
    "internal",
  );
  return true;
}

async function trackerOf(db: Sql, w: string, id: unknown) {
  const ticket =
    typeof id === "string" && id ? await ticketOf(db, w, id) : undefined;
  assert(ticket, "TRACKER_NOT_FOUND", "Tracker unavailable.", 404);
  const type = await loadType(db, w, ticket.type_id);
  assert(
    type.category === "tracker",
    "TRACKER_NOT_FOUND",
    "Tracker unavailable.",
    404,
  );
  return { ticket, type };
}

/** The `ticket_link` command: links a customer conversation to a tracker (no-op if linked). */
export async function linkToTracker(
  db: Sql,
  w: string,
  c: Conversation,
  who: Author,
  p: { trackerId?: unknown },
) {
  await requireTickets(db, w);
  assert(
    c.visibility !== "internal",
    "TICKET_LINK",
    "Link tickets to customer conversations only.",
    409,
  );
  const { ticket, type } = await trackerOf(db, w, p.trackerId);
  const count = Number(
    (
      await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM ticket_links WHERE workspace_id=$1 AND ticket_id=$2",
        [w, ticket.conversation_id],
      )
    ).rows[0].n,
  );
  assert(
    count < MAX_LINKS,
    "TRACKER_FULL",
    "A tracker can link up to 5,000 conversations.",
    409,
  );
  await link(
    db,
    w,
    who,
    await conversation(db, w, ticket.conversation_id, true),
    c,
    Number(ticket.number),
    type,
  );
}

/** The `ticket_unlink` command: removes a conversation's link to a tracker (no-op if absent). */
export async function unlinkFromTracker(
  db: Sql,
  w: string,
  c: Conversation,
  who: Author,
  p: { trackerId?: unknown },
) {
  await requireTickets(db, w);
  const { ticket, type } = await trackerOf(db, w, p.trackerId);
  const removed = (
    await db.query(
      "DELETE FROM ticket_links WHERE workspace_id=$1 AND ticket_id=$2 AND conversation_id=$3 RETURNING 1",
      [w, ticket.conversation_id, c.id],
    )
  ).rows.length;
  if (!removed) return;
  await append(
    db,
    w,
    c,
    who,
    "system_event",
    "",
    {
      event: "ticket_unlinked",
      ticketId: ticket.conversation_id,
      number: Number(ticket.number),
      type: { id: type.id, name: type.name },
    },
    "internal",
  );
  await append(
    db,
    w,
    await conversation(db, w, ticket.conversation_id, true),
    who,
    "system_event",
    "",
    { event: "conversation_unlinked", conversationId: c.id, title: c.title },
    "internal",
  );
}

/** Open trackers, for "Link to tracker" and the bulk bar. */
export async function listTrackers(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "conversations.read");
  await requireTickets(db, w);
  return {
    trackers: (
      await db.query<{
        id: string;
        number: string;
        title: string;
        state: string;
      }>(
        `SELECT c.id,t.number,c.title,s.name AS state FROM tickets t
        JOIN ticket_types y ON y.workspace_id=t.workspace_id AND y.id=t.type_id AND y.category='tracker'
        JOIN ticket_states s ON s.workspace_id=t.workspace_id AND s.id=t.state_id AND s.kind<>'resolved'
        JOIN conversations c ON c.workspace_id=t.workspace_id AND c.id=t.conversation_id
        WHERE t.workspace_id=$1 ORDER BY t.number DESC LIMIT 200`,
        [w],
      )
    ).rows.map((r) => ({ ...r, number: Number(r.number) })),
  };
}

type LinkedTicket = {
  id: string;
  number: number;
  title: string;
  category: string;
  type: string;
  state: string;
  resolved: boolean;
};
/**
 * The sidebar's view of links. A customer conversation lists the back-office tickets and
 * trackers linked to it; a back-office ticket or tracker lists its linked conversations (up to
 * 50, with the total) and a tracker its recent broadcasts.
 */
export async function ticketLinks(db: Sql, w: string, c: Conversation) {
  const tickets = (
    await db.query<LinkedTicket & { number: string }>(
      `SELECT l.ticket_id AS id,t.number,c.title,y.category,y.name AS type,s.name AS state,s.kind='resolved' AS resolved
      FROM ticket_links l JOIN tickets t ON t.workspace_id=l.workspace_id AND t.conversation_id=l.ticket_id
      JOIN ticket_types y ON y.workspace_id=t.workspace_id AND y.id=t.type_id
      JOIN ticket_states s ON s.workspace_id=t.workspace_id AND s.id=t.state_id
      JOIN conversations c ON c.workspace_id=l.workspace_id AND c.id=l.ticket_id
      WHERE l.workspace_id=$1 AND l.conversation_id=$2 ORDER BY t.number`,
      [w, c.id],
    )
  ).rows.map((r) => ({ ...r, number: Number(r.number) }));
  if (c.visibility !== "internal")
    return {
      internal: false,
      tickets,
      conversations: [],
      total: 0,
      broadcasts: [],
    };
  const conversations = (
    await db.query<{ id: string; title: string; status: string }>(
      `SELECT c.id,c.title,c.status FROM ticket_links l JOIN conversations c ON c.workspace_id=l.workspace_id AND c.id=l.conversation_id
      WHERE l.workspace_id=$1 AND l.ticket_id=$2 ORDER BY l.created_at DESC,c.id LIMIT 50`,
      [w, c.id],
    )
  ).rows;
  const total = Number(
    (
      await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM ticket_links WHERE workspace_id=$1 AND ticket_id=$2",
        [w, c.id],
      )
    ).rows[0].n,
  );
  const broadcasts = (
    await db.query<{
      id: string;
      status: string;
      body: string;
      created_at: string;
    }>(
      "SELECT id,status,body,created_at FROM ticket_broadcasts WHERE workspace_id=$1 AND tracker_id=$2 AND status<>'prepared' ORDER BY created_at DESC LIMIT 5",
      [w, c.id],
    )
  ).rows;
  return { internal: true, tickets, conversations, total, broadcasts };
}

/**
 * Prepares a tracker broadcast: the server snapshots the linked conversations, marking open and
 * snoozed ones to receive it and closed ones as skipped. The teammate confirms these counts.
 */
export async function prepareBroadcast(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const t = await authorize(db, w, principal, "conversations.reply");
  await requireTickets(db, w);
  const { ticket } = await trackerOf(db, w, p.trackerId);
  const body = typeof p.text === "string" ? p.text.trim() : "";
  assert(
    body && body.length <= 5000,
    "INVALID_MESSAGE",
    "Write a message of up to 5,000 characters.",
  );
  const targets = (
    await db.query<{ id: string; status: string }>(
      `SELECT c.id,c.status FROM ticket_links l JOIN conversations c ON c.workspace_id=l.workspace_id AND c.id=l.conversation_id
      WHERE l.workspace_id=$1 AND l.ticket_id=$2 AND c.merged_into_id IS NULL ORDER BY l.created_at,c.id`,
      [w, ticket.conversation_id],
    )
  ).rows;
  const sending = targets.filter((x) => x.status !== "closed").length;
  assert(
    sending > 0,
    "BROADCAST_EMPTY",
    "No open or snoozed conversations are linked to this tracker.",
    409,
  );
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO ticket_broadcasts(workspace_id,id,tracker_id,teammate_id,body,close_after,total) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      w,
      id,
      ticket.conversation_id,
      t.id,
      body,
      p.closeAfter === true,
      targets.length,
    ],
  );
  await db.query(
    `INSERT INTO broadcast_items(workspace_id,broadcast_id,conversation_id,position,state)
    SELECT $1,$2,x.id,x.n,CASE WHEN x.status='closed' THEN 'skipped' ELSE 'pending' END FROM unnest($3::text[],$4::text[]) WITH ORDINALITY AS x(id,status,n)`,
    [w, id, targets.map((x) => x.id), targets.map((x) => x.status)],
  );
  return { broadcastId: id, sending, skipped: targets.length - sending };
}

/** Starts a prepared broadcast as a background job. Idempotent on the key. */
export async function commitBroadcast(
  db: Sql,
  w: string,
  principal: string,
  key: string,
  p: Record<string, unknown>,
) {
  return once(db, w, "ticket.broadcast:" + principal, key, p, async () => {
    const t = await authorize(db, w, principal, "conversations.reply");
    const b = (
      await db.query<{
        id: string;
        teammate_id: string;
        tracker_id: string;
        status: string;
        created_at: string;
        body: string;
      }>(
        "SELECT id,teammate_id,tracker_id,status,created_at,body FROM ticket_broadcasts WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [w, String(p.broadcastId ?? "")],
      )
    ).rows[0];
    assert(
      b && b.teammate_id === t.id,
      "BROADCAST_NOT_FOUND",
      "Broadcast unavailable.",
      404,
    );
    assert(
      b.status === "prepared",
      "BROADCAST_STARTED",
      "This broadcast has already been sent.",
      409,
    );
    assert(
      Date.now() - Date.parse(b.created_at) < BROADCAST_TTL_MS,
      "BROADCAST_STALE",
      "The linked conversations may have changed. Prepare the broadcast again.",
      409,
    );
    const jobId = await enqueueJob(
      db,
      w,
      "ticket.broadcast",
      { broadcastId: b.id },
      { teammateId: t.id },
    );
    await db.query(
      "UPDATE ticket_broadcasts SET status='running',committed_at=now(),job_id=$3 WHERE workspace_id=$1 AND id=$2",
      [w, b.id, jobId],
    );
    await append(
      db,
      w,
      await conversation(db, w, b.tracker_id, true),
      { type: "teammate", id: t.id, name: t.name },
      "system_event",
      "",
      { event: "tracker_broadcast", broadcastId: b.id },
      "internal",
    );
    return { jobId };
  });
}

/**
 * One step of a broadcast job: up to 25 conversations each get the update as a public reply
 * from the teammate (then, if asked, are closed), each in its own savepoint with its own
 * idempotency key, so a retried step sends nothing twice and one failure stops nothing else.
 */
export async function runBroadcast(connect: Connect, job: Job) {
  return tenant(connect, job.workspace_id, async (db) => {
    const w = job.workspace_id;
    const b = (
      await db.query<{
        id: string;
        teammate_id: string;
        body: string;
        close_after: boolean;
        status: string;
      }>(
        "SELECT id,teammate_id,body,close_after,status FROM ticket_broadcasts WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [w, job.payload.broadcastId],
      )
    ).rows[0];
    if (!b || b.status !== "running")
      return { done: true, result: { stopped: b?.status ?? "missing" } };
    const principal = (
      await db.query<{ principal_id: string }>(
        "SELECT principal_id FROM teammates WHERE workspace_id=$1 AND id=$2",
        [w, b.teammate_id],
      )
    ).rows[0].principal_id;
    const actor = { type: "teammate" as const, principal };
    const items = (
      await db.query<{ conversation_id: string }>(
        "SELECT conversation_id FROM broadcast_items WHERE workspace_id=$1 AND broadcast_id=$2 AND state='pending' ORDER BY position LIMIT $3",
        [w, b.id, STEP],
      )
    ).rows;
    for (const { conversation_id: id } of items) {
      await db.query("SAVEPOINT broadcast_item");
      try {
        await command(db, w, actor, `broadcast:${b.id}:${id}`, {
          action: "reply",
          conversationId: id,
          text: b.body,
        });
        let closed = false,
          note: string | null = null;
        if (b.close_after) {
          await db.query("SAVEPOINT broadcast_close");
          try {
            await command(db, w, actor, `broadcast-close:${b.id}:${id}`, {
              action: "close",
              conversationId: id,
            });
            await db.query("RELEASE SAVEPOINT broadcast_close");
            closed = true;
          } catch (e) {
            await db.query("ROLLBACK TO SAVEPOINT broadcast_close");
            note =
              e instanceof DomainError
                ? e.message
                : "This conversation could not be closed.";
          }
        }
        await db.query("RELEASE SAVEPOINT broadcast_item");
        await db.query(
          "UPDATE broadcast_items SET state='sent',closed=$4,error=$5 WHERE workspace_id=$1 AND broadcast_id=$2 AND conversation_id=$3",
          [w, b.id, id, closed, note],
        );
      } catch (e) {
        await db.query("ROLLBACK TO SAVEPOINT broadcast_item");
        await db.query(
          "UPDATE broadcast_items SET state='failed',error=$4 WHERE workspace_id=$1 AND broadcast_id=$2 AND conversation_id=$3",
          [
            w,
            b.id,
            id,
            e instanceof DomainError
              ? e.message
              : "The update could not be sent.",
          ],
        );
      }
    }
    if (items.length < STEP)
      await db.query(
        "UPDATE ticket_broadcasts SET status='done',completed_at=now() WHERE workspace_id=$1 AND id=$2",
        [w, b.id],
      );
    return {
      done: items.length < STEP,
      result: await broadcastCounts(db, w, b.id),
    };
  });
}

async function broadcastCounts(db: Sql, w: string, id: string) {
  const rows = (
    await db.query<{ state: string; closed: boolean; n: string }>(
      "SELECT state,closed,count(*) AS n FROM broadcast_items WHERE workspace_id=$1 AND broadcast_id=$2 GROUP BY state,closed",
      [w, id],
    )
  ).rows;
  const counts: Record<string, number> = {};
  for (const r of rows) {
    counts[r.state] = (counts[r.state] ?? 0) + Number(r.n);
    if (r.closed) counts.closed = (counts.closed ?? 0) + Number(r.n);
  }
  return counts;
}

/** A broadcast's progress: status, counts, and conversations that failed or stayed open. */
export async function readBroadcast(
  db: Sql,
  w: string,
  principal: string,
  id: string,
) {
  await authorize(db, w, principal, "conversations.read");
  const b = (
    await db.query<{
      id: string;
      status: string;
      close_after: boolean;
      total: number;
    }>(
      "SELECT id,status,close_after,total FROM ticket_broadcasts WHERE workspace_id=$1 AND id=$2",
      [w, id],
    )
  ).rows[0];
  assert(b, "BROADCAST_NOT_FOUND", "Broadcast unavailable.", 404);
  const problems = (
    await db.query<{ id: string; title: string; state: string; error: string }>(
      `SELECT c.id,c.title,i.state,i.error FROM broadcast_items i JOIN conversations c ON c.workspace_id=i.workspace_id AND c.id=i.conversation_id
      WHERE i.workspace_id=$1 AND i.broadcast_id=$2 AND i.error IS NOT NULL ORDER BY i.position LIMIT 20`,
      [w, id],
    )
  ).rows;
  return {
    id: b.id,
    status: b.status,
    closeAfter: b.close_after,
    total: b.total,
    counts: await broadcastCounts(db, w, id),
    problems,
  };
}
