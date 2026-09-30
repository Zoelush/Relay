import { assert, type Sql } from "./db";
import { authorize } from "./policy";
import {
  mentions,
  plainText,
  relabelMentions,
  type RichDoc,
} from "../lib/rich-doc";

/** Characters of the note kept as a notification excerpt (teammates only). */
export const EXCERPT_LENGTH = 140;

/**
 * Checks each mention against the workspace directory, rewrites its label from the directory
 * (so a label cannot be spoofed) and expands teams to their current members. Returns the
 * relabelled document and the teammate ids to notify, before excluding the author.
 */
export async function resolveMentions(db: Sql, w: string, doc: RichDoc) {
  const found = mentions(doc);
  if (!found.length) return { doc, recipients: [] as string[] };
  const names = new Map<string, string>();
  const recipients = new Set<string>();
  for (const m of found) {
    const key = m.attrs.kind + ":" + m.attrs.id;
    if (names.has(key)) continue;
    const row = (
      await db.query<{ name: string }>(
        m.attrs.kind === "teammate"
          ? "SELECT name FROM teammates WHERE workspace_id=$1 AND id=$2"
          : "SELECT name FROM teams WHERE workspace_id=$1 AND id=$2",
        [w, m.attrs.id],
      )
    ).rows[0];
    assert(
      row,
      "MENTION_NOT_FOUND",
      "Someone you mentioned is not in this workspace. Remove the mention and try again.",
      404,
    );
    names.set(key, row.name);
    if (m.attrs.kind === "teammate") recipients.add(m.attrs.id);
    else
      for (const member of (
        await db.query<{ teammate_id: string }>(
          "SELECT teammate_id FROM teammate_teams WHERE workspace_id=$1 AND team_id=$2",
          [w, m.attrs.id],
        )
      ).rows)
        recipients.add(member.teammate_id);
  }
  return {
    doc: relabelMentions(doc, (m) =>
      names.get(m.attrs.kind + ":" + m.attrs.id)!,
    ),
    recipients: [...recipients],
  };
}

/**
 * Records a note part's mentions (for the Mentions view) and notifies each recipient who was
 * not already notified for an earlier version of the same note. The author is never notified.
 */
export async function recordMentions(
  db: Sql,
  w: string,
  conversationId: string,
  part: { id: string; supersedes_id?: string | null },
  authorId: string,
  recipients: string[],
  doc: RichDoc,
) {
  const targets = recipients.filter((id) => id !== authorId);
  if (!targets.length) return [];
  await db.query(
    "INSERT INTO conversation_mentions(workspace_id,conversation_id,part_id,teammate_id) SELECT $1,$2,$3,unnest($4::text[]) ON CONFLICT DO NOTHING",
    [w, conversationId, part.id, targets],
  );
  // Recipients of any earlier version of this note were notified already.
  const earlier = part.supersedes_id
    ? (
        await db.query<{ teammate_id: string }>(
          `WITH RECURSIVE chain AS (SELECT id,supersedes_id FROM conversation_parts WHERE workspace_id=$1 AND id=$2
          UNION ALL SELECT p.id,p.supersedes_id FROM conversation_parts p JOIN chain ON p.id=chain.supersedes_id WHERE p.workspace_id=$1)
          SELECT DISTINCT teammate_id FROM notifications WHERE workspace_id=$1 AND part_id IN (SELECT id FROM chain)`,
          [w, part.supersedes_id],
        )
      ).rows.map((r) => r.teammate_id)
    : [];
  const fresh = targets.filter((id) => !earlier.includes(id));
  if (fresh.length)
    await db.query(
      `INSERT INTO notifications(workspace_id,id,teammate_id,kind,conversation_id,part_id,actor_teammate_id,excerpt)
      SELECT $1,gen_random_uuid()::text,t,'mention',$2,$3,$4,$5 FROM unnest($6::text[]) AS t ON CONFLICT DO NOTHING`,
      [
        w,
        conversationId,
        part.id,
        authorId,
        plainText(doc).slice(0, EXCERPT_LENGTH),
        fresh,
      ],
    );
  return fresh;
}

/** The signed-in teammate's own notifications, newest first, with the unread count. */
export async function listNotifications(db: Sql, w: string, principal: string) {
  const t = await authorize(db, w, principal, "conversations.read");
  const items = (
    await db.query(
      `SELECT n.id,n.kind,n.conversation_id AS "conversationId",c.title AS "conversationTitle",a.name AS "actorName",
      n.excerpt,n.created_at AS "createdAt",n.read_at AS "readAt"
      FROM notifications n JOIN conversations c ON c.workspace_id=n.workspace_id AND c.id=n.conversation_id
      JOIN teammates a ON a.workspace_id=n.workspace_id AND a.id=n.actor_teammate_id
      WHERE n.workspace_id=$1 AND n.teammate_id=$2 ORDER BY n.created_at DESC,n.id DESC LIMIT 50`,
      [w, t.id],
    )
  ).rows;
  return { unread: await unreadNotifications(db, w, t.id), items };
}

/** Marks the teammate's notifications read: given ids, or all of them. */
export async function markNotifications(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const t = await authorize(db, w, principal, "conversations.read");
  const all = p.all === true;
  const ids = p.ids;
  assert(
    all ||
      (Array.isArray(ids) &&
        ids.length > 0 &&
        ids.length <= 100 &&
        ids.every((x) => typeof x === "string")),
    "INVALID_NOTIFICATIONS",
    "Choose notifications to mark as read.",
  );
  await db.query(
    `UPDATE notifications SET read_at=now() WHERE workspace_id=$1 AND teammate_id=$2 AND read_at IS NULL${all ? "" : " AND id=ANY($3::text[])"}`,
    all ? [w, t.id] : [w, t.id, ids],
  );
  return { unread: await unreadNotifications(db, w, t.id) };
}

export async function unreadNotifications(
  db: Sql,
  w: string,
  teammateId: string,
) {
  return Number(
    (
      await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM notifications WHERE workspace_id=$1 AND teammate_id=$2 AND read_at IS NULL",
        [w, teammateId],
      )
    ).rows[0].n,
  );
}

/** Unread counts for several teammates at once, for batched socket updates. */
export async function unreadNotificationCounts(
  db: Sql,
  w: string,
  teammateIds: string[],
) {
  const rows = (
    await db.query<{ teammate_id: string; n: string }>(
      "SELECT teammate_id,count(*) AS n FROM notifications WHERE workspace_id=$1 AND teammate_id=ANY($2::text[]) AND read_at IS NULL GROUP BY teammate_id",
      [w, teammateIds],
    )
  ).rows;
  return new Map(rows.map((r) => [r.teammate_id, Number(r.n)]));
}
