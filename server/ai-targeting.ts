import type { Sql } from "./db";
import { matchRule, validRules, type Condition, type Facts } from "./ai-escalation";

/**
 * Content targeting (phase 08, step Z3b; docs/AI_STEP8.md): who Zoe uses an article, snippet,
 * file or website for. No conditions: everyone who may see it. Otherwise only customers and
 * conversations matching them (the escalation rules' closed list, all or any). Zoe only: the help
 * center and the messenger's Help space keep their own visibility. Conditions are evaluated in
 * code against the same facts escalation rules use, and the items that fail are taken out of
 * retrieval's allowed set in PostgreSQL, before anything is ranked.
 */
export type Targeting = { match: "all" | "any"; conditions: Condition[] };
export const EVERYONE: Targeting = { match: "all", conditions: [] };

/** Targeting from a save, checked against this workspace's brands, tags and attributes. */
export async function validTargeting(
  db: Sql,
  w: string,
  /** The item's name, for the reason when a condition is refused. */
  name: string,
  p: { match?: unknown; conditions?: unknown },
): Promise<Targeting> {
  const match = p.match === "any" ? "any" : "all";
  const listed = Array.isArray(p.conditions) ? p.conditions : [];
  if (!listed.length) return { match, conditions: [] };
  // The escalation rules' conditions, checked the same way (a rule named after the item).
  const [rule] = await validRules(db, w, [
    { name: name.slice(0, 120) || "This item", match, conditions: listed, enabled: true },
  ]);
  return { match, conditions: rule.conditions };
}

/** Whether a customer passes an item's targeting. */
export const passes = (t: Targeting, f: Facts) =>
  !t.conditions.length ||
  !!matchRule([{ id: "t", name: "", enabled: true, match: t.match, conditions: t.conditions }], f);

/**
 * The targeted records Zoe may not use for this customer (their conditions don't hold), for
 * retrieval to leave out before ranking. Only switched-on records with conditions are read.
 */
export async function targetedOut(db: Sql, w: string, f: Facts) {
  const rows = (
    await db.query<{ id: string; ai_match: "all" | "any"; ai_conditions: Condition[] }>(
      "SELECT id,ai_match,ai_conditions FROM knowledge_records WHERE workspace_id=$1 AND for_ai AND ai_conditions <> '[]'::jsonb",
      [w],
    )
  ).rows;
  return rows
    .filter((r) => !passes({ match: r.ai_match, conditions: r.ai_conditions }, f))
    .map((r) => r.id)
    .sort();
}

/** The names a condition can refer to, for editors and for describing targeting in words. */
export async function targetingChoices(db: Sql, w: string) {
  const rows = async (sql: string) =>
    (await db.query<{ id: string; name: string }>(sql, [w])).rows;
  return {
    brands: await rows("SELECT id,name FROM brands WHERE workspace_id=$1 ORDER BY name,id"),
    tags: await rows(
      "SELECT id,name FROM tags WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY lower(name),id",
    ),
    attributes: await rows(
      "SELECT id,name FROM attribute_definitions WHERE workspace_id=$1 AND owner_type='conversation' AND archived_at IS NULL ORDER BY lower(name),id",
    ),
  };
}

/** Records' titles, for teammates (the first published title, else the draft's). */
export async function recordTitles(db: Sql, w: string, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  return new Map(
    (
      await db.query<{ id: string; title: string }>(
        `SELECT r.id,COALESCE(
           (SELECT l.published_title FROM knowledge_locales l WHERE l.workspace_id=r.workspace_id AND l.record_id=r.id AND l.status='published' ORDER BY l.locale LIMIT 1),
           (SELECT NULLIF(l.draft_title,'') FROM knowledge_locales l WHERE l.workspace_id=r.workspace_id AND l.record_id=r.id ORDER BY l.locale LIMIT 1),
           'Untitled') AS title
         FROM knowledge_records r WHERE r.workspace_id=$1 AND r.id=ANY($2::text[])`,
        [w, ids],
      )
    ).rows.map((r) => [r.id, r.title]),
  );
}
