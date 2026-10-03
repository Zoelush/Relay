import { tenant, type Connect, type Sql } from "./db";
import { append, conversation, type Conversation } from "./conversations";

/**
 * The resolution ledger (phase 08, step A3; docs/AI_STEP4.md). A conversation counts as resolved by
 * the AI agent in exactly two ways:
 *
 * - **confirmed:** the customer tapped "That helped" under an answer the agent gave from content;
 * - **quiet_window:** the agent's last reply was an answer from content, the customer didn't write
 *   again within the agent's resolution window, and the conversation was never handed over, nor
 *   replied to or assigned by a teammate.
 *
 * Each is one append-only row in `ai_resolutions` (the conversation, the answers it rests on and
 * their reply parts, the rule, the window and the time), so a person reading the thread can
 * reconcile it. A conversation has at most one standing resolution. If it's handed to the team
 * within the window after a resolution, a reversal row is added (`handed_over`); billing (phase
 * 16) reads the net. TODO(phase 16): billing reads `ai_resolutions`.
 */
export type Resolution = {
  id: string;
  rule: "confirmed" | "quiet_window";
  recorded_at: string;
  window_hours: number;
};

/** The conversation's resolution that hasn't been reversed, if any. */
export async function standing(
  db: Sql,
  w: string,
  conversationId: string,
): Promise<Resolution | null> {
  return (
    (
      await db.query<Resolution>(
        `SELECT r.id,r.rule,r.recorded_at,r.window_hours FROM ai_resolutions r
         WHERE r.workspace_id=$1 AND r.conversation_id=$2 AND r.kind='resolution'
           AND NOT EXISTS(SELECT 1 FROM ai_resolutions x WHERE x.workspace_id=r.workspace_id AND x.kind='reversal' AND x.resolution_id=r.id)
         ORDER BY r.recorded_at DESC LIMIT 1`,
        [w, conversationId],
      )
    ).rows[0] ?? null
  );
}

/** The answers from content the resolution rests on: every one in the conversation so far. */
async function answersOf(db: Sql, w: string, conversationId: string) {
  const rows = (
    await db.query<{ id: string; reply_part_id: string }>(
      "SELECT id,reply_part_id FROM ai_answers WHERE workspace_id=$1 AND conversation_id=$2 AND outcome='answered' AND reply_part_id IS NOT NULL ORDER BY created_at",
      [w, conversationId],
    )
  ).rows;
  return {
    answerIds: rows.map((r) => r.id),
    replyPartIds: rows.map((r) => r.reply_part_id),
  };
}

/**
 * Records a resolution (once per conversation while one stands), marks the conversation resolved
 * and tells teammates in the timeline. Returns the new row's id, or null if one already stands.
 */
export async function recordResolution(
  db: Sql,
  w: string,
  c: Conversation,
  r: {
    agentId: string;
    rule: Resolution["rule"];
    windowHours: number;
  },
) {
  if (await standing(db, w, c.id)) return null;
  const { answerIds, replyPartIds } = await answersOf(db, w, c.id);
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO ai_resolutions(workspace_id,id,kind,conversation_id,agent_id,rule,answer_ids,reply_part_ids,window_hours,detail)
     VALUES($1,$2,'resolution',$3,$4,$5,$6,$7,$8,$9)`,
    [
      w,
      id,
      c.id,
      r.agentId,
      r.rule,
      answerIds,
      replyPartIds,
      r.windowHours,
      r.rule === "confirmed"
        ? "The customer said the answer helped."
        : `No reply from the customer within ${r.windowHours} hours of the answer.`,
    ],
  );
  await db.query(
    "UPDATE conversations SET ai_state='resolved' WHERE workspace_id=$1 AND id=$2",
    [w, c.id],
  );
  // For teammates: the timeline says how it was resolved.
  await append(
    db,
    w,
    c,
    { type: "ai", id: r.agentId },
    "system_event",
    "",
    { event: "ai_resolved", rule: r.rule, windowHours: r.windowHours, resolutionId: id },
    "internal",
  );
  return id;
}

/**
 * At handover: a resolution recorded within its window is reversed (a new row; nothing is
 * changed). After the window, it stands.
 */
export async function reverseOnHandover(
  db: Sql,
  w: string,
  c: Conversation,
  agentId: string,
  now = Date.now(),
) {
  const r = await standing(db, w, c.id);
  if (!r) return null;
  if (now - new Date(r.recorded_at).getTime() > r.window_hours * 3_600_000)
    return null;
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO ai_resolutions(workspace_id,id,kind,resolution_id,conversation_id,agent_id,rule,window_hours,detail)
     VALUES($1,$2,'reversal',$3,$4,$5,'handed_over',$6,$7)`,
    [
      w,
      id,
      r.id,
      c.id,
      agentId,
      r.window_hours,
      `Handed to the team within ${r.window_hours} hours of the resolution.`,
    ],
  );
  await append(
    db,
    w,
    c,
    { type: "ai", id: agentId },
    "system_event",
    "",
    { event: "ai_resolution_reversed", resolutionId: r.id },
    "internal",
  );
  return id;
}

/**
 * The sweep: conversations whose last public message is an AI answer from content older than the
 * agent's window, still pending (never handed over), with no teammate reply or assignee. Each is
 * re-checked under a lock in its own transaction. Returns how many were resolved.
 */
export async function resolveQuiet(
  connect: Connect,
  w: string,
  now = Date.now(),
) {
  const due = await tenant(connect, w, async (db) =>
    (
      await db.query<{ id: string }>(
        `SELECT c.id FROM conversations c
         JOIN ai_agents g ON g.workspace_id=c.workspace_id AND g.id='default'
         WHERE c.workspace_id=$1 AND c.ai_state='pending' AND c.assigned='' AND c.merged_into_id IS NULL
           AND EXISTS(SELECT 1 FROM workspace_features f WHERE f.workspace_id=c.workspace_id AND f.name='ai_agent_v1' AND f.enabled)
           AND c.updated_at < $2::timestamptz - make_interval(hours => g.resolution_window_hours)
         ORDER BY c.updated_at LIMIT 100`,
        [w, new Date(now).toISOString()],
      )
    ).rows,
  );
  let resolved = 0;
  for (const { id } of due)
    if (await tenant(connect, w, (db) => resolveIfQuiet(db, w, id, now)))
      resolved++;
  return resolved;
}
async function resolveIfQuiet(db: Sql, w: string, id: string, now: number) {
  const c = await conversation(db, w, id, true);
  if (c.ai_state !== "pending" || c.assigned) return false;
  const agent = (
    await db.query<{ id: string; resolution_window_hours: number }>(
      "SELECT id,resolution_window_hours FROM ai_agents WHERE workspace_id=$1 AND id='default'",
      [w],
    )
  ).rows[0];
  if (!agent) return false;
  // The last public message must be an AI answer from content, old enough.
  const last = (
    await db.query<{ kind: string; created_at: string; outcome: string | null }>(
      `SELECT p.kind,p.created_at,a.outcome FROM conversation_parts p
       LEFT JOIN ai_answers a ON a.workspace_id=p.workspace_id AND a.reply_part_id=p.id
       WHERE p.workspace_id=$1 AND p.conversation_id=$2 AND p.audience='public'
         AND p.kind IN ('customer_message','teammate_reply','ai_reply')
       ORDER BY p.seq DESC LIMIT 1`,
      [w, c.id],
    )
  ).rows[0];
  if (!last || last.kind !== "ai_reply" || last.outcome !== "answered")
    return false;
  if (now - new Date(last.created_at).getTime() < agent.resolution_window_hours * 3_600_000)
    return false;
  const teammate = (
    await db.query(
      "SELECT 1 FROM conversation_parts WHERE workspace_id=$1 AND conversation_id=$2 AND kind='teammate_reply' LIMIT 1",
      [w, c.id],
    )
  ).rows.length;
  const escalated = (
    await db.query(
      "SELECT 1 FROM ai_answers WHERE workspace_id=$1 AND conversation_id=$2 AND outcome='escalated' LIMIT 1",
      [w, c.id],
    )
  ).rows.length;
  if (teammate || escalated) return false;
  return !!(await recordResolution(db, w, c, {
    agentId: agent.id,
    rule: "quiet_window",
    windowHours: agent.resolution_window_hours,
  }));
}

/** For Settings › AI agent: the last 30 days, net of reversals, and the latest rows. */
export async function resolutionSummary(db: Sql, w: string) {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const counts = (
    await db.query<{ resolutions: number; reversals: number }>(
      `SELECT count(*) FILTER (WHERE kind='resolution')::int AS resolutions,count(*) FILTER (WHERE kind='reversal')::int AS reversals
       FROM ai_resolutions WHERE workspace_id=$1 AND recorded_at>=$2`,
      [w, since],
    )
  ).rows[0];
  const recent = (
    await db.query<{
      id: string;
      kind: string;
      rule: string;
      conversation_id: string;
      title: string;
      recorded_at: string;
      detail: string;
      answers: number;
    }>(
      `SELECT r.id,r.kind,r.rule,r.conversation_id,c.title,r.recorded_at,r.detail,cardinality(r.answer_ids) AS answers
       FROM ai_resolutions r JOIN conversations c ON c.workspace_id=r.workspace_id AND c.id=r.conversation_id
       WHERE r.workspace_id=$1 ORDER BY r.recorded_at DESC,r.id LIMIT 20`,
      [w],
    )
  ).rows;
  return {
    last30Days: {
      resolutions: counts.resolutions,
      reversals: counts.reversals,
      net: counts.resolutions - counts.reversals,
    },
    recent: recent.map((r) => ({
      id: r.id,
      kind: r.kind,
      rule: r.rule,
      conversationId: r.conversation_id,
      title: r.title,
      at: new Date(r.recorded_at).toISOString(),
      detail: r.detail,
      answers: r.answers,
    })),
  };
}
