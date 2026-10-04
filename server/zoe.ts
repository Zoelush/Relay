import { assert, DomainError, type Sql } from "./db";
import { authorize } from "./policy";
import { aiEnabled, agentRow } from "./ai-agent";
import { assetId, assetUrl } from "./brand-assets";
import { specialistsOf } from "./zoe-specialists";

/**
 * Zoe, Relay's AI agent, in the agent app (phase 08, step Z1; docs/AI_STEP5.md): her identity per
 * brand, and what her pages show (Overview, Performance, Knowledge gaps, Content, Deploy). All of it
 * is for workspace managers while `ai_agent_v1` is on. Numbers cover the last 30 days and are
 * computed here, never in the browser.
 */
const DAYS = 30;
const since = (now = Date.now()) =>
  new Date(now - DAYS * 86_400_000).toISOString();

/** Managers only, with the agent on. Returns the default agent. */
export async function zoeAccess(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "workspace.manage");
  assert(
    await aiEnabled(db, w),
    "AI_AGENT_DISABLED",
    "The AI agent is not enabled for this workspace.",
    404,
  );
  return agentRow(db, w);
}

/* ------------------------------------------------------------------------------------------ */
/* Identity per brand                                                                          */

export type Identity = {
  brandId: string;
  name: string;
  /** "asset:<id>" uploads, or "" for Zoe's own mark. */
  avatar: string;
  avatarDark: string;
  disclosure: string;
  greeting: string;
};

/** A brand's identity for Zoe, or the default: her workspace name and her own mark. */
export async function identityFor(
  db: Sql,
  w: string,
  agentId: string,
  brandId: string,
): Promise<Identity> {
  const row = (
    await db.query<{
      name: string;
      avatar: string;
      avatar_dark: string;
      disclosure: string;
      greeting: string;
    }>(
      "SELECT name,avatar,avatar_dark,disclosure,greeting FROM ai_agent_identities WHERE workspace_id=$1 AND agent_id=$2 AND brand_id=$3",
      [w, agentId, brandId],
    )
  ).rows[0];
  if (row)
    return {
      brandId,
      name: row.name,
      avatar: row.avatar,
      avatarDark: row.avatar_dark,
      disclosure: row.disclosure,
      greeting: row.greeting,
    };
  const agent = (
    await db.query<{ name: string }>(
      "SELECT name FROM ai_agents WHERE workspace_id=$1 AND id=$2",
      [w, agentId],
    )
  ).rows[0];
  return {
    brandId,
    name: agent?.name ?? "Zoe",
    avatar: "",
    avatarDark: "",
    disclosure: "",
    greeting: "",
  };
}

/**
 * The brand's own reply to a greeting, used when the customer reads the brand's language (other
 * languages get the built-in translation). Null when the brand has none.
 */
export async function greetingFor(
  db: Sql,
  w: string,
  agentId: string,
  brandId: string,
  locale: string,
) {
  const identity = await identityFor(db, w, agentId, brandId);
  if (!identity.greeting) return null;
  const brandLocale =
    (
      await db.query<{ locale: string | null }>(
        "SELECT settings->>'locale' AS locale FROM brands WHERE workspace_id=$1 AND id=$2",
        [w, brandId],
      )
    ).rows[0]?.locale ?? "en";
  return locale.split("-")[0].toLowerCase() ===
    brandLocale.split("-")[0].toLowerCase()
    ? identity.greeting
    : null;
}

/** Every brand with its identity for Zoe, for the Settings page. */
export async function listIdentities(db: Sql, w: string, agentId: string) {
  const brands = (
    await db.query<{ id: string; name: string }>(
      "SELECT id,name FROM brands WHERE workspace_id=$1 ORDER BY id='default' DESC,name,id",
      [w],
    )
  ).rows;
  const out: (Identity & { brandName: string })[] = [];
  for (const b of brands)
    out.push({ ...(await identityFor(db, w, agentId, b.id)), brandName: b.name });
  return out;
}

const invalid = (message: string): never => {
  throw new DomainError("INVALID_AI_SETTINGS", message, 400);
};
const line = (v: unknown, max: number, what: string, required = false) => {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if ((required && !s) || s.length > max || /[\x00-\x1f]/.test(s))
    invalid(`Keep ${what} to ${max} characters${required ? ", and give it one" : ""}.`);
  return s;
};

/** Saves a brand's identity for Zoe. Avatars must be this brand's ready uploads. */
export async function saveIdentity(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const agent = await zoeAccess(db, w, principal);
  const t = await authorize(db, w, principal, "workspace.manage");
  const brand = (
    await db.query<{ id: string }>(
      "SELECT id FROM brands WHERE workspace_id=$1 AND id=$2",
      [w, String(p.brandId ?? "")],
    )
  ).rows[0];
  assert(brand, "BRAND_NOT_FOUND", "Brand unavailable.", 404);
  const name = line(p.name, 40, "the name", true);
  const disclosure = line(p.disclosure, 200, "the AI disclosure");
  const greeting = line(p.greeting, 300, "the greeting");
  const avatar = async (value: unknown, purpose: string, what: string) => {
    const v = typeof value === "string" ? value : "";
    if (!v) return "";
    const id = assetId(v);
    if (!id) return invalid(`Upload the ${what} as an image.`);
    const ok = (
      await db.query(
        "SELECT 1 FROM brand_assets WHERE workspace_id=$1 AND id=$2 AND brand_id=$3 AND purpose=$4 AND status='ready'",
        [w, id, brand.id, purpose],
      )
    ).rows.length;
    if (!ok) invalid(`The ${what} isn't available. Upload it again.`);
    return v;
  };
  const light = await avatar(p.avatar, "agent_avatar", "avatar");
  const dark = await avatar(p.avatarDark, "agent_avatar_dark", "dark-theme avatar");
  await db.query(
    `INSERT INTO ai_agent_identities(workspace_id,agent_id,brand_id,name,avatar,avatar_dark,disclosure,greeting,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(workspace_id,agent_id,brand_id) DO UPDATE SET name=EXCLUDED.name,avatar=EXCLUDED.avatar,avatar_dark=EXCLUDED.avatar_dark,
       disclosure=EXCLUDED.disclosure,greeting=EXCLUDED.greeting,updated_at=now(),updated_by=EXCLUDED.updated_by`,
    [w, agent.id, brand.id, name, light, dark, disclosure, greeting, t.id],
  );
  // The default brand's name is the agent's own (in the prompt, the inbox and its views).
  if (brand.id === "default")
    await db.query(
      "UPDATE ai_agents SET name=$3,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
      [w, agent.id, name],
    );
  return identityFor(db, w, agent.id, brand.id);
}

/** For the messenger's boot: Zoe's name, avatars (Relay's addresses) and disclosure. */
export async function bootIdentity(
  db: Sql,
  w: string,
  brandId: string,
  apiOrigin: string,
) {
  if (!(await aiEnabled(db, w))) return null;
  const agent = await agentRow(db, w);
  if (!agent.enabled) return null;
  const i = await identityFor(db, w, agent.id, brandId);
  const url = (v: string) => {
    const id = assetId(v);
    return id ? assetUrl(apiOrigin, w, id) : "";
  };
  return {
    name: i.name,
    avatar: url(i.avatar),
    avatarDark: url(i.avatarDark),
    disclosure: i.disclosure,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Overview, Performance, Knowledge gaps, Content, Deploy                                       */

/** The question's text, normalised to group the same question asked twice. */
const GAP_KEY =
  "regexp_replace(lower(btrim(p.body)),'[[:space:]]+',' ','g')";

async function gaps(db: Sql, w: string, limit: number) {
  return (
    await db.query<{
      question: string;
      count: number;
      last_at: string;
      conversation_id: string;
    }>(
      `SELECT (array_agg(left(p.body,300) ORDER BY a.created_at DESC))[1] AS question,count(*)::int AS count,
         max(a.created_at) AS last_at,(array_agg(a.conversation_id ORDER BY a.created_at DESC))[1] AS conversation_id
       FROM ai_answers a JOIN conversation_parts p ON p.workspace_id=a.workspace_id AND p.id=a.question_part_id
       WHERE a.workspace_id=$1 AND a.outcome IN ('unknown','failed') AND a.created_at>=$2
       GROUP BY ${GAP_KEY} ORDER BY count(*) DESC,max(a.created_at) DESC LIMIT $3`,
      [w, since(), limit],
    )
  ).rows.map((g) => ({
    question: g.question,
    count: g.count,
    lastAt: new Date(g.last_at).toISOString(),
    conversationId: g.conversation_id,
  }));
}

async function mostUsed(db: Sql, w: string, limit: number) {
  return (
    await db.query<{ id: string; title: string | null; count: number; source: string }>(
      `SELECT x.id,r.source,(SELECT l.published_title FROM knowledge_locales l WHERE l.workspace_id=r.workspace_id AND l.record_id=r.id AND l.status='published' ORDER BY l.locale LIMIT 1) AS title,count(*)::int AS count
       FROM ai_answers a CROSS JOIN LATERAL unnest(a.cited) AS x(id)
       JOIN knowledge_records r ON r.workspace_id=a.workspace_id AND r.id=x.id
       WHERE a.workspace_id=$1 AND a.outcome='answered' AND a.created_at>=$2
       GROUP BY x.id,r.workspace_id,r.id,r.source ORDER BY count(*) DESC,x.id LIMIT $3`,
      [w, since(), limit],
    )
  ).rows.map((r) => ({
    recordId: r.id,
    title: r.title ?? "Untitled",
    source: r.source,
    count: r.count,
  }));
}

/** The Overview: the headline numbers, what needs attention, and what Zoe leans on. */
export async function zoeOverview(db: Sql, w: string, principal: string) {
  const agent = await zoeAccess(db, w, principal);
  const from = since();
  const n = (
    await db.query<{
      involved: number;
      answers: number;
      handovers: number;
      confidence: number | null;
    }>(
      `SELECT count(DISTINCT conversation_id) FILTER (WHERE outcome<>'skipped')::int AS involved,
         count(*) FILTER (WHERE outcome IN ('answered','clarified','unknown','failed'))::int AS answers,
         count(*) FILTER (WHERE outcome='escalated')::int AS handovers,
         avg(top_score) FILTER (WHERE outcome IN ('answered','clarified','unknown') AND top_score IS NOT NULL) AS confidence
       FROM ai_answers WHERE workspace_id=$1 AND created_at>=$2`,
      [w, from],
    )
  ).rows[0];
  const ledger = (
    await db.query<{ resolutions: number; reversals: number }>(
      `SELECT count(*) FILTER (WHERE kind='resolution')::int AS resolutions,count(*) FILTER (WHERE kind='reversal')::int AS reversals
       FROM ai_resolutions WHERE workspace_id=$1 AND recorded_at>=$2`,
      [w, from],
    )
  ).rows[0];
  const resolved = ledger.resolutions - ledger.reversals;
  const counts = (
    await db.query<{ rules: number; content: number }>(
      `SELECT (SELECT count(*) FROM ai_escalation_rules WHERE workspace_id=$1 AND enabled)::int AS rules,
         (SELECT count(*) FROM knowledge_records r WHERE r.workspace_id=$1 AND r.for_ai AND r.audience<>'internal'
            AND EXISTS(SELECT 1 FROM knowledge_locales l WHERE l.workspace_id=r.workspace_id AND l.record_id=r.id AND l.status='published'))::int AS content`,
      [w],
    )
  ).rows[0];
  return {
    agent: { name: agent.name, enabled: agent.enabled },
    days: DAYS,
    stats: {
      resolutionRate: n.involved ? Math.round((resolved / n.involved) * 1000) / 10 : null,
      resolutions: resolved,
      involved: n.involved,
      answers: n.answers,
      handovers: n.handovers,
      confidence:
        n.confidence === null ? null : Math.round(Number(n.confidence) * 100),
    },
    escalation: {
      rules: counts.rules,
      topics: agent.never_handle.length,
      guidance: agent.escalation_guidance.length,
    },
    // Z2: how she sounds, and how much answer guidance is on.
    voice: {
      tone: agent.tone,
      length: agent.answer_length,
      formality: agent.formality,
      guidelines: agent.answer_guidance.filter((g) => g.enabled).length,
      version: agent.guidance_version,
      languages: agent.languages.length,
    },
    // Z3a: her specialists that are on.
    specialists: (await specialistsOf(db, w, agent.id, true)).map((s) => s.name),
    content: counts.content,
    gaps: await gaps(db, w, 6),
    articles: await mostUsed(db, w, 6),
  };
}

/** Performance: what Zoe did and why, over the last 30 days. */
export async function zoePerformance(db: Sql, w: string, principal: string) {
  const agent = await zoeAccess(db, w, principal);
  const from = since();
  // Spam she left alone (Z2) is a skipped answer with the trigger "spam": counted on its own.
  const outcomes = Object.fromEntries(
    (
      await db.query<{ outcome: string; n: number }>(
        `SELECT CASE WHEN outcome='skipped' AND trigger='spam' THEN 'spam' ELSE outcome END AS outcome,count(*)::int AS n
         FROM ai_answers WHERE workspace_id=$1 AND created_at>=$2 GROUP BY 1`,
        [w, from],
      )
    ).rows.map((r) => [r.outcome, r.n]),
  );
  // The languages she replied in (Z2).
  const languages = (
    await db.query<{ language: string; n: number }>(
      `SELECT language,count(*)::int AS n FROM ai_answers
       WHERE workspace_id=$1 AND created_at>=$2 AND language IS NOT NULL AND outcome<>'skipped'
       GROUP BY language ORDER BY count(*) DESC,language`,
      [w, from],
    )
  ).rows.map((r) => ({ language: r.language, count: r.n }));
  // Who answered (Z3a): each specialist, and Zoe herself.
  const names = new Map(
    (await specialistsOf(db, w, agent.id)).map((s) => [s.id, s.name]),
  );
  const bySpecialist = (
    await db.query<{ id: string | null; name: string | null; answers: number; handovers: number }>(
      `SELECT a.specialist_id AS id,s.name,
         count(*) FILTER (WHERE a.outcome IN ('answered','clarified','unknown','failed'))::int AS answers,
         count(*) FILTER (WHERE a.outcome='escalated')::int AS handovers
       FROM ai_answers a LEFT JOIN ai_specialists s ON s.workspace_id=a.workspace_id AND s.id=a.specialist_id
       WHERE a.workspace_id=$1 AND a.created_at>=$2 AND a.outcome<>'skipped'
       GROUP BY a.specialist_id,s.name ORDER BY count(*) DESC,s.name`,
      [w, from],
    )
  ).rows.map((r) => ({
    id: r.id,
    name: r.id ? (names.get(r.id) ?? r.name ?? "A removed specialist") : null,
    answers: r.answers,
    handovers: r.handovers,
  }));
  const triggers = (
    await db.query<{ trigger: string; n: number }>(
      "SELECT trigger,count(*)::int AS n FROM ai_answers WHERE workspace_id=$1 AND created_at>=$2 AND outcome='escalated' AND trigger IS NOT NULL GROUP BY trigger ORDER BY count(*) DESC,trigger",
      [w, from],
    )
  ).rows.map((r) => ({ trigger: r.trigger, count: r.n }));
  const ledger = (
    await db.query<{ confirmed: number; quiet: number; reversals: number }>(
      `SELECT count(*) FILTER (WHERE kind='resolution' AND rule='confirmed')::int AS confirmed,
         count(*) FILTER (WHERE kind='resolution' AND rule='quiet_window')::int AS quiet,
         count(*) FILTER (WHERE kind='reversal')::int AS reversals
       FROM ai_resolutions WHERE workspace_id=$1 AND recorded_at>=$2`,
      [w, from],
    )
  ).rows[0];
  const timing = (
    await db.query<{ median: number | null; confidence: number | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS median,
         avg(top_score) FILTER (WHERE top_score IS NOT NULL AND outcome IN ('answered','clarified','unknown')) AS confidence
       FROM ai_answers WHERE workspace_id=$1 AND created_at>=$2 AND latency_ms IS NOT NULL`,
      [w, from],
    )
  ).rows[0];
  return {
    days: DAYS,
    outcomes: {
      answered: outcomes.answered ?? 0,
      clarified: outcomes.clarified ?? 0,
      unknown: outcomes.unknown ?? 0,
      failed: outcomes.failed ?? 0,
      escalated: outcomes.escalated ?? 0,
      skipped: outcomes.skipped ?? 0,
      spam: outcomes.spam ?? 0,
    },
    triggers,
    languages,
    specialists: bySpecialist,
    resolutions: {
      confirmed: ledger.confirmed,
      quiet: ledger.quiet,
      reversals: ledger.reversals,
      net: ledger.confirmed + ledger.quiet - ledger.reversals,
    },
    medianLatencyMs: timing.median === null ? null : Math.round(Number(timing.median)),
    confidence:
      timing.confidence === null ? null : Math.round(Number(timing.confidence) * 100),
  };
}

/** Knowledge gaps: the questions Zoe couldn't answer, most asked first. */
export async function zoeGaps(db: Sql, w: string, principal: string) {
  await zoeAccess(db, w, principal);
  return { days: DAYS, gaps: await gaps(db, w, 50) };
}

/** Content: what Zoe may use (switched on for the AI agent, published, not internal). */
export async function zoeContent(db: Sql, w: string, principal: string) {
  await zoeAccess(db, w, principal);
  const used = new Map(
    (await mostUsed(db, w, 500)).map((r) => [r.recordId, r.count]),
  );
  const records = (
    await db.query<{
      id: string;
      source: string;
      audience: string;
      title: string | null;
      locales: string[];
    }>(
      `SELECT r.id,r.source,r.audience,
         (SELECT l.published_title FROM knowledge_locales l WHERE l.workspace_id=r.workspace_id AND l.record_id=r.id AND l.status='published' ORDER BY l.locale LIMIT 1) AS title,
         ARRAY(SELECT l.locale FROM knowledge_locales l WHERE l.workspace_id=r.workspace_id AND l.record_id=r.id AND l.status='published' ORDER BY l.locale) AS locales
       FROM knowledge_records r
       WHERE r.workspace_id=$1 AND r.for_ai AND r.audience<>'internal'
         AND EXISTS(SELECT 1 FROM knowledge_locales l WHERE l.workspace_id=r.workspace_id AND l.record_id=r.id AND l.status='published')
       ORDER BY r.id LIMIT 1000`,
      [w],
    )
  ).rows;
  const excluded = (
    await db.query<{ off: number; internal: number }>(
      `SELECT count(*) FILTER (WHERE NOT for_ai)::int AS off,count(*) FILTER (WHERE audience='internal')::int AS internal
       FROM knowledge_records WHERE workspace_id=$1`,
      [w],
    )
  ).rows[0];
  const list = records
    .map((r) => ({
      recordId: r.id,
      title: r.title ?? "Untitled",
      source: r.source,
      audience: r.audience,
      locales: r.locales,
      used: used.get(r.id) ?? 0,
    }))
    .sort((a, b) => b.used - a.used || a.title.localeCompare(b.title));
  const bySource: Record<string, number> = {};
  for (const r of list) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
  return {
    days: DAYS,
    total: list.length,
    bySource,
    signedInOnly: list.filter((r) => r.audience === "signed_in").length,
    excluded: { switchedOff: excluded.off, internal: excluded.internal },
    records: list,
  };
}

/** Deploy: where Zoe answers (each brand's messenger) and as whom. */
export async function zoeDeploy(db: Sql, w: string, principal: string) {
  const agent = await zoeAccess(db, w, principal);
  const brands = (
    await db.query<{
      id: string;
      name: string;
      live: number | null;
      seen: number;
    }>(
      `SELECT b.id,b.name,
         (SELECT max(v.version) FROM messenger_versions v WHERE v.workspace_id=b.workspace_id AND v.brand_id=b.id) AS live,
         (SELECT count(DISTINCT substring(s.page_url from '^[a-z]+://[^/]+')) FROM messenger_sessions s
            WHERE s.workspace_id=b.workspace_id AND s.brand_id=b.id AND s.expires_at>now()-interval '7 days')::int AS seen
       FROM brands b WHERE b.workspace_id=$1 ORDER BY b.id='default' DESC,b.name,b.id`,
      [w],
    )
  ).rows;
  const out = [];
  for (const b of brands)
    out.push({
      brandId: b.id,
      brandName: b.name,
      liveVersion: b.live,
      websitesSeen: b.seen,
      identity: (await identityFor(db, w, agent.id, b.id)).name,
    });
  return { enabled: agent.enabled, brands: out };
}
