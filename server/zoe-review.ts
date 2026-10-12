import { assert, DomainError, once, tenant, type Connect, type Sql } from "./db";
import { authorize } from "./policy";
import { aiEnabled, agentRow } from "./ai-agent";
import { zoeAccess } from "./zoe";
import type { ContentGap, ContentGapsPort } from "./knowledge-health";

/**
 * Zoe's review queue (phase 08, step C2a; docs/AI_STEP11.md), behind `zoe_review_v1`, for those who
 * manage Zoe. Answers she gave from content reach the queue two ways:
 *
 * - **Sampled:** once a UTC day is over, a random handful of that day's answers (the agent's
 *   `review_sample`, 10 by default, 0 to stop). A marker row per day makes it happen once.
 * - **Pushed back on:** an answer the customer met straight away by asking for a person or seeming
 *   upset (her next decision in the conversation was a handover for that reason). Always added.
 *
 * A reviewer rates each answer once, good or bad; a bad rating says what was wrong. Bad because
 * content is missing or outdated, it becomes a content gap: listed in Zoe's Knowledge gaps and in
 * content health until it's fixed or dismissed. Reviews are internal and never reach a customer.
 */
export const PROBLEMS = [
  "wrong",
  "incomplete",
  "missing_content",
  "outdated_content",
  "tone",
  "should_not_answer",
] as const;
export type Problem = (typeof PROBLEMS)[number];
/** The problems that are the content's, not Zoe's: they become content gaps. */
const GAP_PROBLEMS: Problem[] = ["missing_content", "outdated_content"];
const PUSHBACK_TRIGGERS = ["asked_for_person", "negative_sentiment"];
const DAY = 86_400_000;
const DAYS = 30;
/** Pushbacks are looked for this far back on each sweep. */
const PUSHBACK_WINDOW = 2 * DAY;
const LIST_LIMIT = 50;

export async function reviewEnabled(db: Sql, w: string) {
  return (
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='zoe_review_v1' AND enabled",
        [w],
      )
    ).rows.length > 0
  );
}

/** Managers only, with the agent and the review queue on. */
async function reviewAccess(db: Sql, w: string, principal: string) {
  const agent = await zoeAccess(db, w, principal);
  assert(
    await reviewEnabled(db, w),
    "REVIEW_DISABLED",
    "Zoe's review queue is not enabled for this workspace.",
    404,
  );
  const teammate = await authorize(db, w, principal, "workspace.manage");
  return { agent, teammate };
}

/* ------------------------------------------------------------------------------------------ */
/* Filling the queue                                                                           */

/**
 * Adds pushbacks from the last two days, and samples the previous UTC day once it's over. Run by
 * the scheduled sweep (each pass; cheap when there's nothing to do). Safe to repeat.
 */
export async function sampleForReview(connect: Connect, w: string, now = Date.now()) {
  return tenant(connect, w, async (db) => {
    if (!(await aiEnabled(db, w)) || !(await reviewEnabled(db, w)))
      return { pushbacks: 0, sampled: 0 };
    const pushbacks = (
      await db.query(
        `INSERT INTO ai_reviews(workspace_id,id,answer_id,conversation_id,source,pushback,created_at)
         SELECT $1,'review_'||prev.id,prev.id,prev.conversation_id,'pushback',e.trigger,e.created_at
         FROM ai_answers e
         CROSS JOIN LATERAL (
           SELECT p.id,p.conversation_id,p.outcome,p.reply_part_id FROM ai_answers p
           WHERE p.workspace_id=e.workspace_id AND p.conversation_id=e.conversation_id AND p.created_at<e.created_at AND p.outcome<>'skipped'
           ORDER BY p.created_at DESC LIMIT 1) prev
         WHERE e.workspace_id=$1 AND e.outcome='escalated' AND e.trigger=ANY($2::text[]) AND e.created_at>=$3
           AND prev.outcome='answered' AND prev.reply_part_id IS NOT NULL
         ON CONFLICT DO NOTHING RETURNING id`,
        [w, PUSHBACK_TRIGGERS, new Date(now - PUSHBACK_WINDOW).toISOString()],
      )
    ).rows.length;

    // The previous UTC day, once.
    const start = new Date(Math.floor(now / DAY) * DAY - DAY);
    const size = (await db.query<{ review_sample: number }>(
      "SELECT review_sample FROM ai_agents WHERE workspace_id=$1 AND id=$2",
      [w, (await agentRow(db, w)).id],
    )).rows[0].review_sample;
    const marked = (
      await db.query(
        "INSERT INTO ai_review_days(workspace_id,day,sample) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING day",
        [w, start.toISOString().slice(0, 10), size],
      )
    ).rows.length;
    let sampled = 0;
    if (marked && size > 0) {
      sampled = (
        await db.query(
          `INSERT INTO ai_reviews(workspace_id,id,answer_id,conversation_id,source,created_at)
           SELECT $1,'review_'||a.id,a.id,a.conversation_id,'sample',a.created_at FROM ai_answers a
           WHERE a.workspace_id=$1 AND a.outcome='answered' AND a.reply_part_id IS NOT NULL
             AND a.created_at>=$2 AND a.created_at<$3
             AND NOT EXISTS(SELECT 1 FROM ai_reviews r WHERE r.workspace_id=a.workspace_id AND r.answer_id=a.id)
           ORDER BY random() LIMIT $4
           ON CONFLICT DO NOTHING RETURNING id`,
          [w, start.toISOString(), new Date(start.getTime() + DAY).toISOString(), size],
        )
      ).rows.length;
      await db.query(
        "UPDATE ai_review_days SET picked=$3 WHERE workspace_id=$1 AND day=$2",
        [w, start.toISOString().slice(0, 10), sampled],
      );
    }
    return { pushbacks, sampled };
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Reading                                                                                     */

type ReviewRow = {
  id: string;
  answer_id: string;
  conversation_id: string;
  source: "sample" | "pushback";
  pushback: string | null;
  rating: "good" | "bad" | null;
  problem: Problem | null;
  note: string;
  rated_by_name: string | null;
  rated_at: string | null;
  answered_at: string;
  question: string;
  answer: string;
  cited: string[];
  language: string | null;
  specialist: string | null;
  gap_id: string | null;
};
const REVIEW_FIELDS = `r.id,r.answer_id,r.conversation_id,r.source,r.pushback,r.rating,r.problem,r.note,r.rated_at,
  t.name AS rated_by_name,a.created_at AS answered_at,q.body AS question,COALESCE(p.body,'') AS answer,a.cited,a.language,
  s.name AS specialist,g.id AS gap_id
  FROM ai_reviews r
  JOIN ai_answers a ON a.workspace_id=r.workspace_id AND a.id=r.answer_id
  JOIN conversation_parts q ON q.workspace_id=a.workspace_id AND q.id=a.question_part_id
  LEFT JOIN conversation_parts p ON p.workspace_id=a.workspace_id AND p.id=a.reply_part_id
  LEFT JOIN teammates t ON t.workspace_id=r.workspace_id AND t.id=r.rated_by
  LEFT JOIN ai_specialists s ON s.workspace_id=a.workspace_id AND s.id=a.specialist_id
  LEFT JOIN ai_content_gaps g ON g.workspace_id=r.workspace_id AND g.review_id=r.id`;

/** Titles for cited records (published, in any locale). */
async function titles(db: Sql, w: string, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  return new Map(
    (
      await db.query<{ id: string; title: string | null }>(
        `SELECT r.id,(SELECT l.published_title FROM knowledge_locales l WHERE l.workspace_id=r.workspace_id AND l.record_id=r.id AND l.status='published' ORDER BY l.locale LIMIT 1) AS title
         FROM knowledge_records r WHERE r.workspace_id=$1 AND r.id=ANY($2::text[])`,
        [w, ids],
      )
    ).rows.map((r) => [r.id, r.title ?? "Untitled"]),
  );
}

async function views(db: Sql, w: string, rows: ReviewRow[]) {
  const names = await titles(db, w, [...new Set(rows.flatMap((r) => r.cited))]);
  return rows.map((r) => ({
    id: r.id,
    answerId: r.answer_id,
    conversationId: r.conversation_id,
    source: r.source,
    pushback: r.pushback,
    answeredAt: new Date(r.answered_at).toISOString(),
    question: r.question,
    answer: r.answer,
    sources: r.cited.map((id) => ({ id, title: names.get(id) ?? "A removed record" })),
    language: r.language,
    specialist: r.specialist,
    rating: r.rating,
    problem: r.problem,
    note: r.note,
    ratedBy: r.rated_by_name,
    ratedAt: r.rated_at ? new Date(r.rated_at).toISOString() : null,
    gapId: r.gap_id,
  }));
}

/** Analyze › Review: the queue, recent ratings, and how answers rated over 30 days. */
export async function readReview(db: Sql, w: string, principal: string) {
  const { agent } = await reviewAccess(db, w, principal);
  const from = new Date(Date.now() - DAYS * DAY).toISOString();
  const pending = (
    await db.query<ReviewRow>(
      `SELECT ${REVIEW_FIELDS} WHERE r.workspace_id=$1 AND r.rating IS NULL
       ORDER BY r.source='pushback' DESC,r.created_at,r.id LIMIT $2`,
      [w, LIST_LIMIT],
    )
  ).rows;
  const rated = (
    await db.query<ReviewRow>(
      `SELECT ${REVIEW_FIELDS} WHERE r.workspace_id=$1 AND r.rating IS NOT NULL
       ORDER BY r.rated_at DESC,r.id LIMIT $2`,
      [w, LIST_LIMIT],
    )
  ).rows;
  const counts = (
    await db.query<{ waiting: number; good: number; bad: number }>(
      `SELECT count(*) FILTER (WHERE rating IS NULL)::int AS waiting,
         count(*) FILTER (WHERE rating='good' AND rated_at>=$2)::int AS good,
         count(*) FILTER (WHERE rating='bad' AND rated_at>=$2)::int AS bad
       FROM ai_reviews WHERE workspace_id=$1`,
      [w, from],
    )
  ).rows[0];
  const problems = (
    await db.query<{ problem: Problem; n: number }>(
      `SELECT problem,count(*)::int AS n FROM ai_reviews WHERE workspace_id=$1 AND rating='bad' AND rated_at>=$2
       GROUP BY problem ORDER BY count(*) DESC,problem`,
      [w, from],
    )
  ).rows.map((r) => ({ problem: r.problem, count: r.n }));
  const sample = (
    await db.query<{ review_sample: number }>(
      "SELECT review_sample FROM ai_agents WHERE workspace_id=$1 AND id=$2",
      [w, agent.id],
    )
  ).rows[0].review_sample;
  const rate = counts.good + counts.bad;
  return {
    days: DAYS,
    sample,
    stats: {
      waiting: counts.waiting,
      rated: rate,
      good: counts.good,
      bad: counts.bad,
      goodRate: rate ? Math.round((counts.good / rate) * 1000) / 10 : null,
      problems,
    },
    pending: await views(db, w, pending),
    rated: await views(db, w, rated),
  };
}

type GapRow = {
  id: string;
  version: string;
  review_id: string;
  conversation_id: string;
  question: string;
  answer: string;
  problem: "missing_content" | "outdated_content";
  note: string;
  status: "open" | "fixed" | "dismissed";
  record_id: string | null;
  created_by_name: string | null;
  created_at: string;
};

/** The content gaps reviewers found: the open ones, and how many were fixed in 30 days. */
export async function reviewedGaps(db: Sql, w: string) {
  if (!(await reviewEnabled(db, w))) return null;
  const open = (
    await db.query<GapRow>(
      `SELECT g.id,g.version::text AS version,g.review_id,g.conversation_id,g.question,g.answer,g.problem,g.note,g.status,g.record_id,
         t.name AS created_by_name,g.created_at
       FROM ai_content_gaps g LEFT JOIN teammates t ON t.workspace_id=g.workspace_id AND t.id=g.created_by
       WHERE g.workspace_id=$1 AND g.status='open' ORDER BY g.created_at DESC,g.id LIMIT 100`,
      [w],
    )
  ).rows;
  const fixed = (
    await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ai_content_gaps WHERE workspace_id=$1 AND status='fixed' AND resolved_at>=$2",
      [w, new Date(Date.now() - DAYS * DAY).toISOString()],
    )
  ).rows[0].n;
  return {
    open: open.map((g) => ({
      id: g.id,
      version: g.version,
      conversationId: g.conversation_id,
      question: g.question,
      answer: g.answer,
      problem: g.problem,
      note: g.note,
      createdBy: g.created_by_name,
      createdAt: new Date(g.created_at).toISOString(),
    })),
    fixed,
  };
}

/**
 * Content health's "Topics with no content", from reviews: open gaps grouped by the same question,
 * with reviewers' notes as examples. TODO(phase 14): topics found by clustering customer questions.
 */
export function reviewedGapsPort(db: Sql): ContentGapsPort {
  return {
    async gaps(w: string, since: Date): Promise<ContentGap[]> {
      return (
        await db.query<{ topic: string; n: number; notes: string[] }>(
          `SELECT (array_agg(left(question,300) ORDER BY created_at DESC))[1] AS topic,count(*)::int AS n,
             (array_remove(array_agg(NULLIF(note,'') ORDER BY created_at DESC),NULL))[1:3] AS notes
           FROM ai_content_gaps WHERE workspace_id=$1 AND status='open' AND created_at>=$2
           GROUP BY regexp_replace(lower(btrim(question)),'[[:space:]]+',' ','g')
           ORDER BY count(*) DESC,max(created_at) DESC LIMIT 50`,
          [w, since.toISOString()],
        )
      ).rows.map((r) => ({ topic: r.topic, conversations: r.n, examples: r.notes ?? [] }));
    },
  };
}

/** Whether content health should list reviewed gaps: the review queue and the agent are on. */
export async function gapsForHealth(db: Sql, w: string) {
  return (await aiEnabled(db, w)) && (await reviewEnabled(db, w))
    ? reviewedGapsPort(db)
    : undefined;
}

/* ------------------------------------------------------------------------------------------ */
/* Changes                                                                                     */

const invalid = (message: string): never => {
  throw new DomainError("INVALID_REVIEW", message, 400);
};

/**
 * One change, idempotent by key: `rate` an answer (once), set the daily `sample`, or move a
 * content `gap` to fixed (optionally naming the record that fixed it), dismissed, or back to open.
 */
export async function changeReview(
  db: Sql,
  w: string,
  principal: string,
  key: string,
  p: Record<string, unknown>,
) {
  const { agent, teammate } = await reviewAccess(db, w, principal);
  return once(db, w, "zoe-review:" + principal, key, p, async () => {
    if (p.action === "sample") {
      const size = Number(p.size);
      if (!Number.isInteger(size) || size < 0 || size > 50)
        invalid("Sample between 0 and 50 answers a day.");
      await db.query(
        "UPDATE ai_agents SET review_sample=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [w, agent.id, size],
      );
      return readReview(db, w, principal);
    }
    if (p.action === "rate") {
      const rating = p.rating;
      if (rating !== "good" && rating !== "bad") invalid("Rate the answer good or bad.");
      const problem =
        rating === "bad"
          ? PROBLEMS.includes(p.problem as Problem)
            ? (p.problem as Problem)
            : invalid("Say what was wrong with the answer.")
          : null;
      const note = typeof p.note === "string" ? p.note.trim() : "";
      if (note.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(note))
        invalid("Keep the note to 1,000 characters.");
      const id = String(p.reviewId ?? "");
      const updated = (
        await db.query<{ id: string }>(
          `UPDATE ai_reviews SET rating=$3,problem=$4,note=$5,rated_by=$6,rated_at=now()
           WHERE workspace_id=$1 AND id=$2 AND rating IS NULL RETURNING id`,
          [w, id, rating, problem, note, teammate.id],
        )
      ).rows[0];
      if (!updated) {
        const exists = (
          await db.query("SELECT 1 FROM ai_reviews WHERE workspace_id=$1 AND id=$2", [w, id])
        ).rows.length;
        assert(exists, "REVIEW_NOT_FOUND", "That answer isn't in the review queue.", 404);
        throw new DomainError("ALREADY_RATED", "Someone has already rated this answer.", 409);
      }
      if (problem && GAP_PROBLEMS.includes(problem))
        await db.query(
          `INSERT INTO ai_content_gaps(workspace_id,id,review_id,conversation_id,question,answer,problem,note,created_by)
           SELECT r.workspace_id,'gap_'||r.id,r.id,r.conversation_id,q.body,COALESCE(p.body,''),$3,$4,$5
           FROM ai_reviews r JOIN ai_answers a ON a.workspace_id=r.workspace_id AND a.id=r.answer_id
           JOIN conversation_parts q ON q.workspace_id=a.workspace_id AND q.id=a.question_part_id
           LEFT JOIN conversation_parts p ON p.workspace_id=a.workspace_id AND p.id=a.reply_part_id
           WHERE r.workspace_id=$1 AND r.id=$2 ON CONFLICT DO NOTHING`,
          [w, id, problem, note, teammate.id],
        );
      return readReview(db, w, principal);
    }
    if (p.action === "gap") {
      const status = p.status;
      if (status !== "fixed" && status !== "dismissed" && status !== "open")
        invalid("Mark the gap fixed, dismissed or open.");
      const recordId =
        status === "fixed" && typeof p.recordId === "string" && p.recordId ? p.recordId : null;
      if (recordId)
        assert(
          (
            await db.query("SELECT 1 FROM knowledge_records WHERE workspace_id=$1 AND id=$2", [
              w,
              recordId,
            ])
          ).rows.length,
          "RECORD_NOT_FOUND",
          "That content isn't available.",
          404,
        );
      const id = String(p.gapId ?? "");
      const changed = (
        await db.query(
          `UPDATE ai_content_gaps SET status=$3,record_id=$4,
             resolved_by=CASE WHEN $3='open' THEN NULL ELSE $5 END,resolved_at=CASE WHEN $3='open' THEN NULL ELSE now() END,
             version=version+1
           WHERE workspace_id=$1 AND id=$2 AND version::text=$6 RETURNING id`,
          [w, id, status, recordId, teammate.id, String(p.version ?? "")],
        )
      ).rows.length;
      if (!changed) {
        const exists = (
          await db.query("SELECT 1 FROM ai_content_gaps WHERE workspace_id=$1 AND id=$2", [w, id])
        ).rows.length;
        assert(exists, "GAP_NOT_FOUND", "That content gap isn't available.", 404);
        throw new DomainError("GAP_CHANGED", "Someone else changed this gap. Reload to see it.", 409);
      }
      return { gaps: await reviewedGaps(db, w) };
    }
    return invalid("Unknown review change.");
  });
}
