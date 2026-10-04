import { assert, DomainError, once, type Sql } from "./db";
import { authorize } from "./policy";
import { zoeAccess } from "./zoe";
import {
  AUDIENCES,
  DEFAULT_VOICE,
  FORMALITIES,
  GUIDANCE_CATEGORIES,
  LENGTHS,
  MAX_GUIDELINES,
  MAX_GUIDELINE_TEXT,
  MAX_GUIDELINE_TITLE,
  TONES,
  guidanceWarnings,
  type Guideline,
  type Voice,
} from "../lib/zoe-voice";

/**
 * Zoe's voice and answer guidance (phase 08, step Z2; docs/AI_STEP6.md), on Train › Guidance.
 * Every save is a numbered version, kept unchanged in `ai_guidance_versions`; restoring one saves
 * it again as a new version, and every answer records the version it was given. Guidance shapes
 * how she answers: the model gets it as data under her rules, so it can't grant her anything, and
 * spam guidance can only make her leave a message alone.
 */
const invalid = (message: string): never => {
  throw new DomainError("INVALID_GUIDANCE", message, 400);
};

/** Her tone, length and formality, from a save or a Playground draft; unchanged when not sent. */
export function validVoice(p: Record<string, unknown>, current: Voice = DEFAULT_VOICE): Voice {
  const tone = p.tone ?? current.tone,
    length = p.length ?? current.length,
    formality = p.formality ?? current.formality;
  if (!TONES.some((t) => t.id === tone)) invalid("Choose one of her tones.");
  if (!LENGTHS.some((l) => l.id === length)) invalid("Choose an answer length.");
  if (!FORMALITIES.some((f) => f.id === formality)) invalid("Choose how formal she is.");
  return { tone, length, formality } as Voice;
}

/**
 * The guidelines, checked: a category, a title, the text, who and which brand each is for, and
 * (Z3a) whether it applies only when one specialist answers. Spam guidance always applies.
 */
export function validGuidelines(
  input: unknown,
  brands: string[],
  specialists: string[] = [],
): Guideline[] {
  if (!Array.isArray(input)) return invalid("Send the guidance as a list.");
  if (input.length > MAX_GUIDELINES)
    invalid(`Keep to ${MAX_GUIDELINES} guidelines.`);
  const ids = new Set<string>();
  return (input as unknown[]).map((raw, i) => {
    const g = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const title = typeof g.title === "string" ? g.title.trim().replace(/\s+/g, " ") : "";
    if (!title || title.length > MAX_GUIDELINE_TITLE)
      invalid(`Give guideline ${i + 1} a title of up to ${MAX_GUIDELINE_TITLE} characters.`);
    const text = typeof g.text === "string" ? g.text.trim() : "";
    if (!text || text.length > MAX_GUIDELINE_TEXT)
      invalid(`Write what “${title}” says in up to ${MAX_GUIDELINE_TEXT} characters.`);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(title + text))
      invalid(`“${title}” has characters that can't be saved.`);
    if (!GUIDANCE_CATEGORIES.some((c) => c.id === g.category))
      invalid(`Choose a category for “${title}”.`);
    const audience = g.audience ?? "everyone";
    if (!AUDIENCES.some((a) => a.id === audience)) invalid(`Choose who “${title}” is for.`);
    const brandId =
      g.brandId === null || g.brandId === undefined || g.brandId === ""
        ? null
        : String(g.brandId);
    if (brandId && !brands.includes(brandId))
      invalid(`Choose one of your brands for “${title}”, or all brands.`);
    const specialistId =
      g.category === "spam" ||
      g.specialistId === null ||
      g.specialistId === undefined ||
      g.specialistId === ""
        ? null
        : String(g.specialistId);
    if (specialistId && !specialists.includes(specialistId))
      invalid(`Choose one of her specialists for “${title}”, or always.`);
    const id =
      typeof g.id === "string" && /^[\w-]{1,64}$/.test(g.id) && !ids.has(g.id)
        ? g.id
        : crypto.randomUUID();
    ids.add(id);
    return {
      id,
      category: g.category,
      title,
      text,
      enabled: g.enabled !== false,
      audience,
      brandId,
      specialistId,
    } as Guideline;
  });
}

/**
 * The guidelines that apply to this customer: switched on, for their audience and brand; answer
 * guidance also for the specialist answering (Z3a), when it names one.
 */
export function applicableGuidance(
  list: Guideline[],
  who: { signedIn: boolean; brandId: string; specialistId?: string | null },
) {
  const on = list.filter(
    (g) =>
      g.enabled &&
      (g.audience === "everyone" || (g.audience === "signed_in") === who.signedIn) &&
      (!g.brandId || g.brandId === who.brandId),
  );
  return {
    answer: on.filter(
      (g) =>
        g.category !== "spam" &&
        (!g.specialistId || g.specialistId === (who.specialistId ?? null)),
    ),
    spam: on.filter((g) => g.category === "spam"),
  };
}

/** Her specialists (not removed), to name in guidance (Z3a). */
async function specialistsOf(db: Sql, w: string) {
  return (
    await db.query<{ id: string; name: string }>(
      "SELECT id,name FROM ai_specialists WHERE workspace_id=$1 AND NOT archived ORDER BY position,lower(name),id",
      [w],
    )
  ).rows;
}
async function brandsOf(db: Sql, w: string) {
  return (
    await db.query<{ id: string; name: string }>(
      "SELECT id,name FROM brands WHERE workspace_id=$1 ORDER BY id='default' DESC,name,id",
      [w],
    )
  ).rows;
}

/** A Playground draft (unsaved changes on the Guidance page), checked like a save. */
export async function draftStyle(db: Sql, w: string, draft: unknown) {
  const d = (draft && typeof draft === "object" ? draft : {}) as Record<string, unknown>;
  return {
    voice: validVoice(d),
    guidance: validGuidelines(
      d.guidance ?? [],
      (await brandsOf(db, w)).map((b) => b.id),
      (await specialistsOf(db, w)).map((s) => s.id),
    ),
  };
}

/** Train › Guidance: her voice, the guidelines with their warnings, and the saved versions. */
export async function readGuidance(db: Sql, w: string, principal: string) {
  const agent = await zoeAccess(db, w, principal);
  const versions = (
    await db.query<{
      version: number;
      restored_from: number | null;
      saved_at: string;
      by: string | null;
      count: number;
      tone: string;
      answer_length: string;
      formality: string;
    }>(
      `SELECT v.version,v.restored_from,v.saved_at,t.name AS by,jsonb_array_length(v.guidance)::int AS count,v.tone,v.answer_length,v.formality
       FROM ai_guidance_versions v LEFT JOIN teammates t ON t.workspace_id=v.workspace_id AND t.id=v.saved_by
       WHERE v.workspace_id=$1 AND v.agent_id=$2 ORDER BY v.version DESC LIMIT 50`,
      [w, agent.id],
    )
  ).rows;
  return {
    voice: {
      tone: agent.tone,
      length: agent.answer_length,
      formality: agent.formality,
    } as Voice,
    guidance: agent.answer_guidance,
    warnings: Object.fromEntries(
      agent.answer_guidance.map((g) => [g.id, guidanceWarnings(g)]),
    ),
    version: agent.guidance_version,
    versions: versions.map((v) => ({
      version: v.version,
      restoredFrom: v.restored_from,
      savedAt: new Date(v.saved_at).toISOString(),
      by: v.by ?? "A teammate",
      guidelines: v.count,
      voice: { tone: v.tone, length: v.answer_length, formality: v.formality },
    })),
    brands: await brandsOf(db, w),
    specialists: await specialistsOf(db, w),
  };
}

/** One saved version, to look at before restoring it. */
export async function readGuidanceVersion(
  db: Sql,
  w: string,
  principal: string,
  version: number,
) {
  const agent = await zoeAccess(db, w, principal);
  const row = await versionRow(db, w, agent.id, version);
  assert(row, "GUIDANCE_VERSION_NOT_FOUND", "That version doesn't exist.", 404);
  return {
    version,
    voice: { tone: row.tone, length: row.answer_length, formality: row.formality },
    guidance: row.guidance,
    restoredFrom: row.restored_from,
    savedAt: new Date(row.saved_at).toISOString(),
  };
}

async function versionRow(db: Sql, w: string, agentId: string, version: number) {
  if (!Number.isInteger(version) || version < 1) return undefined;
  return (
    await db.query<{
      tone: Voice["tone"];
      answer_length: Voice["length"];
      formality: Voice["formality"];
      guidance: Guideline[];
      restored_from: number | null;
      saved_at: string;
    }>(
      "SELECT tone,answer_length,formality,guidance,restored_from,saved_at FROM ai_guidance_versions WHERE workspace_id=$1 AND agent_id=$2 AND version=$3",
      [w, agentId, version],
    )
  ).rows[0];
}

/** The voice and guideline titles an answer was given (its version), for "Why this reply". */
export async function guidanceAt(db: Sql, w: string, agentId: string, version: number) {
  const row = await versionRow(db, w, agentId, version);
  return row
    ? {
        voice: { tone: row.tone, length: row.answer_length, formality: row.formality } as Voice,
        titles: new Map(row.guidance.map((g) => [g.id, g.title])),
      }
    : { voice: DEFAULT_VOICE, titles: new Map<string, string>() };
}

/**
 * Saves the Guidance page as the next version, from the version the page loaded (or refused as
 * changed elsewhere). With `restore`, an earlier version is saved again as the next one.
 */
export async function saveGuidance(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const agent = await zoeAccess(db, w, principal);
  const teammate = await authorize(db, w, principal, "workspace.manage");
  if (Number(p.version) !== agent.guidance_version)
    throw new DomainError(
      "GUIDANCE_CONFLICT",
      "Her guidance changed elsewhere. Reload to see the latest, then try again.",
      409,
    );
  const brands = (await brandsOf(db, w)).map((b) => b.id);
  const specialists = (await specialistsOf(db, w)).map((s) => s.id);
  let voice: Voice;
  let guidance: Guideline[];
  let restoredFrom: number | null = null;
  if (p.restore !== undefined && p.restore !== null) {
    const row = await versionRow(db, w, agent.id, Number(p.restore));
    assert(row, "GUIDANCE_VERSION_NOT_FOUND", "That version doesn't exist.", 404);
    voice = validVoice({ tone: row.tone, length: row.answer_length, formality: row.formality });
    // Guidance for a specialist removed since comes back switched off, for always.
    guidance = validGuidelines(
      row.guidance.map((g) =>
        g.specialistId && !specialists.includes(g.specialistId)
          ? { ...g, specialistId: null, enabled: false }
          : g,
      ),
      brands,
      specialists,
    );
    restoredFrom = Number(p.restore);
  } else {
    voice = validVoice(p, {
      tone: agent.tone,
      length: agent.answer_length,
      formality: agent.formality,
    });
    guidance = validGuidelines(p.guidance ?? agent.answer_guidance, brands, specialists);
  }
  const next = agent.guidance_version + 1;
  const updated = await db.query(
    `UPDATE ai_agents SET tone=$3,answer_length=$4,formality=$5,answer_guidance=$6,guidance_version=$7,updated_at=now()
     WHERE workspace_id=$1 AND id=$2 AND guidance_version=$8 RETURNING guidance_version`,
    [
      w,
      agent.id,
      voice.tone,
      voice.length,
      voice.formality,
      JSON.stringify(guidance),
      next,
      agent.guidance_version,
    ],
  );
  if (!updated.rows.length)
    throw new DomainError(
      "GUIDANCE_CONFLICT",
      "Her guidance changed elsewhere. Reload to see the latest, then try again.",
      409,
    );
  await db.query(
    `INSERT INTO ai_guidance_versions(workspace_id,agent_id,version,tone,answer_length,formality,guidance,restored_from,saved_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      w,
      agent.id,
      next,
      voice.tone,
      voice.length,
      voice.formality,
      JSON.stringify(guidance),
      restoredFrom,
      teammate.id,
    ],
  );
  return readGuidance(db, w, principal);
}
/** The Guidance route: saves are idempotent on the request's key. */
export const changeGuidance = (
  db: Sql,
  w: string,
  principal: string,
  key: string,
  p: Record<string, unknown>,
) =>
  once(db, w, "zoe-guidance:" + principal, key, p, () =>
    saveGuidance(db, w, principal, p),
  );
