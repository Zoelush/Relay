import { assert, DomainError, once, type Sql } from "./db";
import { authorize } from "./policy";
import { zoeAccess } from "./zoe";
import {
  matchKeywords,
  matchRule,
  validRules,
  type Condition,
  type Facts,
} from "./ai-escalation";
import type { KnowledgeScope } from "./ai-retrieval";
import {
  MAX_SPECIALISTS,
  MAX_SPECIALIST_KEYWORDS,
  type Guideline,
} from "../lib/zoe-voice";

/**
 * Zoe's specialists (phase 08, step Z3a; docs/AI_STEP7.md), on Train › Specialists. A specialist
 * is a narrower Zoe for one job: what she handles (her instructions, and how the classifier picks
 * her), keywords checked in code (so routing holds when the model is down), optional conditions
 * on the customer and conversation (the escalation rules' closed list), her knowledge (all of
 * Zoe's, or chosen collections, websites, snippets and files, enforced in retrieval before
 * ranking), and the team she hands over to. Customers always see Zoe. Removing a specialist
 * archives her: answers and conversations keep her name.
 */
export type Specialist = {
  id: string;
  name: string;
  handles: string;
  keywords: string[];
  match: "all" | "any";
  conditions: Condition[];
  knowledge: {
    all: boolean;
    collections: string[];
    websites: string[];
    snippets: boolean;
    files: boolean;
  };
  handoverTeamId: string | null;
  enabled: boolean;
  version: string;
};
type Row = {
  id: string;
  name: string;
  handles: string;
  keywords: string[];
  match: "all" | "any";
  conditions: Condition[];
  knowledge_all: boolean;
  collections: string[];
  websites: string[];
  snippets: boolean;
  files: boolean;
  handover_team_id: string | null;
  enabled: boolean;
  version: string;
};
const fromRow = (r: Row): Specialist => ({
  id: r.id,
  name: r.name,
  handles: r.handles,
  keywords: r.keywords,
  match: r.match,
  conditions: r.conditions,
  knowledge: {
    all: r.knowledge_all,
    collections: r.collections,
    websites: r.websites,
    snippets: r.snippets,
    files: r.files,
  },
  handoverTeamId: r.handover_team_id,
  enabled: r.enabled,
  version: r.version,
});

/** The agent's specialists (not removed), in order; with `on`, only those switched on. */
export async function specialistsOf(db: Sql, w: string, agentId: string, on = false) {
  return (
    await db.query<Row>(
      `SELECT id,name,handles,keywords,match,conditions,knowledge_all,collections,websites,snippets,files,handover_team_id,enabled,version::text AS version
       FROM ai_specialists WHERE workspace_id=$1 AND agent_id=$2 AND NOT archived ${on ? "AND enabled" : ""}
       ORDER BY position,lower(name),id`,
      [w, agentId],
    )
  ).rows.map(fromRow);
}
/** Every specialist's name, removed ones too, for labels on old answers and conversations. */
export async function specialistNames(db: Sql, w: string) {
  return (
    await db.query<{ id: string; name: string }>(
      "SELECT id,name FROM ai_specialists WHERE workspace_id=$1 ORDER BY lower(name),id",
      [w],
    )
  ).rows;
}

/** Her knowledge, as retrieval filters it (null: all of Zoe's). */
export const scopeOf = (s: Specialist | null): KnowledgeScope =>
  !s || s.knowledge.all
    ? null
    : {
        collections: s.knowledge.collections,
        websites: s.knowledge.websites,
        snippets: s.knowledge.snippets,
        files: s.knowledge.files,
      };
/** The specialists this customer may reach: switched on, with no conditions or conditions that hold. */
export const candidatesFor = (list: Specialist[], f: Facts) =>
  list.filter(
    (s) =>
      s.enabled &&
      (!s.conditions.length ||
        !!matchRule(
          [{ id: s.id, name: s.name, enabled: true, match: s.match, conditions: s.conditions }],
          f,
        )),
  );
/** The first candidate one of whose keywords is in the message (whole words, accents ignored). */
export function byKeyword(candidates: Specialist[], message: string) {
  for (const s of candidates) {
    const keyword = s.keywords.find(
      (k) => !!matchKeywords([{ name: s.id, description: "", keywords: [k] }], message),
    );
    if (keyword) return { specialist: s, keyword };
  }
  return null;
}

const invalid = (message: string): never => {
  throw new DomainError("INVALID_SPECIALIST", message, 400);
};
const line = (v: unknown, max: number, what: string) => {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (!s || s.length > max) invalid(`Give ${what} of up to ${max} characters.`);
  return s;
};

/** A specialist from a save or a Playground draft, checked against this workspace's data. */
export async function validSpecialist(db: Sql, w: string, p: Record<string, unknown>) {
  const name = line(p.name, 60, "her a name");
  const handles = line(p.handles, 500, `“${name}” a description of what she handles`);
  const raw = Array.isArray(p.keywords) ? p.keywords : [];
  // Each keyword once, as first written.
  const keywords: string[] = [];
  for (const k of raw) {
    const word = typeof k === "string" ? k.trim().replace(/\s+/g, " ") : "";
    if (word && !keywords.some((x) => x.toLowerCase() === word.toLowerCase())) keywords.push(word);
  }
  if (keywords.length > MAX_SPECIALIST_KEYWORDS || keywords.some((k) => k.length > 40))
    invalid(`Keep “${name}” to ${MAX_SPECIALIST_KEYWORDS} keywords of up to 40 characters.`);
  const match = p.match === "any" ? "any" : "all";
  const listed = Array.isArray(p.conditions) ? p.conditions : [];
  // The escalation rules' conditions, checked the same way (a rule named after her).
  const conditions = listed.length
    ? (await validRules(db, w, [{ name, match, conditions: listed, enabled: true }]))[0].conditions
    : [];
  const k = (p.knowledge && typeof p.knowledge === "object" ? p.knowledge : { all: true }) as Record<
    string,
    unknown
  >;
  const all = k.all !== false;
  const ids = async (sql: string, values: unknown[]) =>
    (await db.query<{ id: string }>(sql, values)).rows.map((r) => r.id);
  const wanted = (v: unknown) =>
    Array.isArray(v) ? [...new Set(v.map(String))] : [];
  const collections = all ? [] : wanted(k.collections);
  const websites = all ? [] : wanted(k.websites);
  if (collections.length) {
    const known = await ids(
      "SELECT id FROM help_nodes WHERE workspace_id=$1 AND kind='collection' AND NOT archived AND id=ANY($2::text[])",
      [w, collections],
    );
    if (known.length !== collections.length)
      invalid(`Choose “${name}”'s collections from your help centers.`);
  }
  if (websites.length) {
    const known = await ids(
      "SELECT id FROM knowledge_sources WHERE workspace_id=$1 AND status<>'removed' AND id=ANY($2::text[])",
      [w, websites],
    );
    if (known.length !== websites.length) invalid(`Choose “${name}”'s websites from your sources.`);
  }
  const snippets = !all && k.snippets === true;
  const files = !all && k.files === true;
  if (!all && !collections.length && !websites.length && !snippets && !files)
    invalid(`Choose what “${name}” may answer from, or all of Zoe's content.`);
  const team =
    p.handoverTeamId === null || p.handoverTeamId === undefined || p.handoverTeamId === ""
      ? null
      : String(p.handoverTeamId);
  if (team && !(await ids("SELECT id FROM teams WHERE workspace_id=$1 AND id=$2", [w, team])).length)
    invalid(`Choose one of your teams for “${name}”'s handovers, or Zoe's.`);
  return {
    name,
    handles,
    keywords,
    match,
    conditions,
    knowledge: { all, collections, websites, snippets, files },
    handoverTeamId: team,
    enabled: p.enabled !== false,
  } as Omit<Specialist, "id" | "version">;
}

/** A Playground draft: the specialist being edited, unsaved, checked like a save. */
export async function draftSpecialist(db: Sql, w: string, p: unknown): Promise<Specialist> {
  const d = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
  return {
    ...(await validSpecialist(db, w, d)),
    id: typeof d.id === "string" && d.id ? d.id : "draft",
    version: "0",
  };
}

/** Train › Specialists: each specialist with the guidance attached to her, and what to choose from. */
export async function readSpecialists(db: Sql, w: string, principal: string) {
  const agent = await zoeAccess(db, w, principal);
  const list = await specialistsOf(db, w, agent.id);
  const guidance = agent.answer_guidance as Guideline[];
  const rows = async (sql: string) =>
    (await db.query<{ id: string; name: string; center?: string }>(sql, [w])).rows;
  return {
    specialists: list.map((s) => ({
      ...s,
      // The guidelines that apply only when she answers (Z3a), by title.
      guidance: guidance.filter((g) => g.specialistId === s.id).map((g) => g.title),
    })),
    choices: {
      collections: await rows(
        `SELECT n.id,h.name AS center,COALESCE(
           (SELECT l.name FROM help_node_locales l WHERE l.workspace_id=n.workspace_id AND l.node_id=n.id AND l.locale=h.default_locale),
           (SELECT l.name FROM help_node_locales l WHERE l.workspace_id=n.workspace_id AND l.node_id=n.id ORDER BY l.locale LIMIT 1),'Untitled') AS name
         FROM help_nodes n JOIN help_centers h ON h.workspace_id=n.workspace_id AND h.id=n.center_id
         WHERE n.workspace_id=$1 AND n.kind='collection' AND NOT n.archived ORDER BY h.name,n.position,n.id`,
      ),
      websites: await rows(
        "SELECT id,name FROM knowledge_sources WHERE workspace_id=$1 AND status<>'removed' ORDER BY lower(name),id",
      ),
      teams: await rows("SELECT id,name FROM teams WHERE workspace_id=$1 ORDER BY name,id"),
      brands: await rows("SELECT id,name FROM brands WHERE workspace_id=$1 ORDER BY name,id"),
      tags: await rows(
        "SELECT id,name FROM tags WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY lower(name),id",
      ),
      attributes: await rows(
        "SELECT id,name FROM attribute_definitions WHERE workspace_id=$1 AND owner_type='conversation' AND archived_at IS NULL ORDER BY lower(name),id",
      ),
    },
    max: MAX_SPECIALISTS,
  };
}

/**
 * Saves one specialist: a new one (no id), a change from the version the page loaded (or refused
 * as changed elsewhere), or `remove`, which archives her.
 */
export async function saveSpecialist(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const agent = await zoeAccess(db, w, principal);
  const teammate = await authorize(db, w, principal, "workspace.manage");
  const id = typeof p.id === "string" && p.id ? p.id : null;
  const current = id
    ? (
        await db.query<{ version: string }>(
          "SELECT version::text AS version FROM ai_specialists WHERE workspace_id=$1 AND agent_id=$2 AND id=$3 AND NOT archived",
          [w, agent.id, id],
        )
      ).rows[0]
    : undefined;
  if (id) {
    assert(current, "SPECIALIST_NOT_FOUND", "That specialist doesn't exist.", 404);
    if (String(p.version ?? "") !== current.version)
      throw new DomainError(
        "SPECIALIST_CONFLICT",
        "This specialist changed elsewhere. Reload to see the latest, then try again.",
        409,
      );
  }
  if (id && p.remove === true) {
    // Guidance that applies only when she answers would never apply again: changed first.
    const attached = (agent.answer_guidance as Guideline[]).filter((g) => g.specialistId === id);
    if (attached.length)
      invalid(
        `Before removing her, change the guidance that applies only when she answers: ${attached
          .map((g) => `“${g.title}”`)
          .join(", ")}.`,
      );
    await db.query(
      "UPDATE ai_specialists SET archived=true,enabled=false,version=version+1,updated_at=now(),updated_by=$3 WHERE workspace_id=$1 AND id=$2",
      [w, id, teammate.id],
    );
    return readSpecialists(db, w, principal);
  }
  const s = await validSpecialist(db, w, p);
  const others = (await specialistsOf(db, w, agent.id)).filter((x) => x.id !== id);
  if (others.some((x) => x.name.toLowerCase() === s.name.toLowerCase()))
    invalid(`Another specialist is called “${s.name}”.`);
  if (!id && others.length >= MAX_SPECIALISTS)
    invalid(`Keep to ${MAX_SPECIALISTS} specialists.`);
  const values = [
    s.name,
    s.handles,
    s.keywords,
    s.match,
    JSON.stringify(s.conditions),
    s.knowledge.all,
    s.knowledge.collections,
    s.knowledge.websites,
    s.knowledge.snippets,
    s.knowledge.files,
    s.handoverTeamId,
    s.enabled,
    teammate.id,
  ];
  if (id)
    await db.query(
      `UPDATE ai_specialists SET name=$3,handles=$4,keywords=$5,match=$6,conditions=$7,knowledge_all=$8,collections=$9,websites=$10,
         snippets=$11,files=$12,handover_team_id=$13,enabled=$14,updated_by=$15,version=version+1,updated_at=now()
       WHERE workspace_id=$1 AND id=$2`,
      [w, id, ...values],
    );
  else
    await db.query(
      `INSERT INTO ai_specialists(workspace_id,id,agent_id,name,handles,keywords,match,conditions,knowledge_all,collections,websites,snippets,files,handover_team_id,enabled,updated_by,position)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
         (SELECT COALESCE(max(position)+1,0) FROM ai_specialists WHERE workspace_id=$1))`,
      [w, crypto.randomUUID(), agent.id, ...values],
    );
  return readSpecialists(db, w, principal);
}
/** The Specialists route: saves are idempotent on the request's key. */
export const changeSpecialist = (
  db: Sql,
  w: string,
  principal: string,
  key: string,
  p: Record<string, unknown>,
) =>
  once(db, w, "zoe-specialist:" + principal, key, p, () =>
    saveSpecialist(db, w, principal, p),
  );
