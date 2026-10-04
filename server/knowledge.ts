import { assert, DomainError, type Sql } from "./db";
import { SLUG, SLUG_MAX, slugify } from "../lib/help-paths";
import { feedbackSummary, indexRecord, normalize } from "./help-search";
import { authorize, can } from "./policy";
import { fileSummary, readyImages } from "./knowledge-files";
import { pageSummary, syncAvailable } from "./knowledge-sync";
import { indexEnabled } from "./knowledge-index";
import { recordTitles, targetingChoices, validTargeting } from "./ai-targeting";
import type { Condition } from "./ai-escalation";
import {
  imageIds,
  normalizeDoc,
  plainText,
  RichDocError,
  type RichDoc,
} from "../lib/rich-doc";

/**
 * The knowledge store (phase 07, step A1): one record type for the help center, the inbox and
 * the AI agent. Content is per locale; each locale has an autosaved draft and, once published, a
 * published version that only changes on the next publish. Every publish is kept as a revision.
 *
 * Audience and availability are independent switches, with one rule enforced here and in the
 * database: content whose audience is `internal` is never available to the help center or the
 * AI agent (which answers customers), so internal knowledge cannot reach a customer.
 * Uploaded files create `file` records (phase 07, C1a, in knowledge-files.ts): their content is
 * the text extracted from the file, so they are not edited here.
 * Synced websites create `external_page` records the same way (C1b, in knowledge-sync.ts).
 * TODO(phase 07 C2): publishing (re)chunks and (re)embeds the published version.
 */
export const SOURCES = [
  "article",
  "internal_article",
  "snippet",
  "file",
  "external_page",
] as const;
export type Source = (typeof SOURCES)[number];
const EDITABLE: Source[] = ["article", "internal_article", "snippet"];
const AUDIENCES = ["public", "signed_in", "internal"] as const;
type Audience = (typeof AUDIENCES)[number];

const invalid = (message: string): never => {
  throw new DomainError("INVALID_KNOWLEDGE", message, 400);
};
export async function requireKnowledge(db: Sql, w: string) {
  assert(
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='knowledge_v1' AND enabled",
        [w],
      )
    ).rows.length,
    "KNOWLEDGE_DISABLED",
    "The knowledge store is not enabled for this workspace.",
    404,
  );
}
export async function manager(db: Sql, w: string, principal: string) {
  const t = await authorize(db, w, principal, "knowledge.manage");
  await requireKnowledge(db, w);
  return t;
}

/** A BCP 47 language tag, canonicalised ("en-gb" becomes "en-GB"). */
export function validLocale(value: unknown) {
  if (typeof value !== "string" || value.length < 2 || value.length > 35)
    return invalid("Choose a language, such as en or fr-CA.");
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    if (!/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/.test(canonical))
      throw new Error();
    return canonical;
  } catch {
    return invalid("Choose a language, such as en or fr-CA.");
  }
}
/** An article body, validated against the article profile (headings, callouts, tables…). */
function articleBody(input: unknown): RichDoc | null {
  if (input === undefined || input === null) return null;
  try {
    return normalizeDoc(input, { article: true });
  } catch (e) {
    if (e instanceof RichDocError)
      throw new DomainError(e.code, e.message, 400);
    throw e;
  }
}
const title = (value: unknown) => {
  const t = typeof value === "string" ? value.trim() : "";
  if (t.length > 300) invalid("Keep the title under 300 characters.");
  return t;
};
/** Audience and switches, with internal content kept away from customer-facing surfaces. */
function access(
  source: Source,
  p: Record<string, unknown>,
  current?: {
    audience: Audience;
    for_ai: boolean;
    for_help_center: boolean;
    for_inbox: boolean;
  },
) {
  const audience = (p.audience ??
    current?.audience ??
    (source === "article" ? "public" : "internal")) as Audience;
  if (!AUDIENCES.includes(audience))
    invalid("Choose public, signed-in customers or internal.");
  const forAi =
    p.forAi === undefined ? (current?.for_ai ?? false) : p.forAi === true;
  const forHelpCenter =
    p.forHelpCenter === undefined
      ? (current?.for_help_center ?? false)
      : p.forHelpCenter === true;
  const forInbox =
    p.forInbox === undefined
      ? (current?.for_inbox ?? true)
      : p.forInbox === true;
  if (audience === "internal" && (forAi || forHelpCenter))
    invalid(
      "Internal content cannot be shown in the help center or used by the AI agent, which answer customers.",
    );
  if (forHelpCenter && source !== "article")
    invalid("Only public articles appear in the help center.");
  return { audience, forAi, forHelpCenter, forInbox };
}

type LocaleRow = {
  locale: string;
  status: string;
  draft_title: string;
  draft_body: RichDoc | null;
  draft_version: string;
  draft_updated_at: string;
  published_title: string | null;
  published_body: RichDoc | null;
  published_revision: number | null;
  published_at: string | null;
  slug: string | null;
};
const localeView = (l: LocaleRow) => ({
  locale: l.locale,
  status: l.status,
  slug: l.slug,
  draft: {
    title: l.draft_title,
    body: l.draft_body,
    version: String(l.draft_version),
    updatedAt: new Date(l.draft_updated_at).toISOString(),
  },
  published:
    l.published_revision === null
      ? null
      : {
          title: l.published_title,
          body: l.published_body,
          revision: l.published_revision,
          publishedAt: new Date(l.published_at!).toISOString(),
        },
  // Unpublished changes: the draft differs from what is live.
  changed:
    l.published_revision === null ||
    l.draft_title !== l.published_title ||
    JSON.stringify(l.draft_body) !== JSON.stringify(l.published_body),
});

export async function record(db: Sql, w: string, id: unknown, lock = false) {
  const r = (
    await db.query<{
      id: string;
      source: Source;
      owner_id: string;
      audience: Audience;
      for_ai: boolean;
      for_help_center: boolean;
      for_inbox: boolean;
      last_reviewed_at: string | null;
      version: string;
      faq: boolean;
      ai_match: "all" | "any";
      ai_conditions: Condition[];
    }>(
      `SELECT id,source,owner_id,audience,for_ai,for_help_center,for_inbox,last_reviewed_at,version::text AS version,faq,ai_match,ai_conditions
      FROM knowledge_records WHERE workspace_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
      [w, String(id ?? "")],
    )
  ).rows[0];
  assert(r, "KNOWLEDGE_NOT_FOUND", "Knowledge record unavailable.", 404);
  return r;
}

/** A slug typed by a teammate. */
export function validSlug(value: unknown) {
  const slug = typeof value === "string" ? value.trim() : "";
  if (!SLUG.test(slug) || slug.length > SLUG_MAX)
    invalid(
      "Use lower-case letters, digits and single hyphens, at most 80 characters.",
    );
  return slug;
}
/** The first free slug from a title: the slug itself, then -2, -3… */
export async function freeSlug(
  base: string,
  fallback: string,
  taken: (slug: string) => Promise<boolean>,
) {
  const root = base || fallback;
  for (let n = 1; n < 100; n++) {
    const suffix = n === 1 ? "" : "-" + n;
    const slug =
      root.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "") + suffix;
    if (!(await taken(slug))) return slug;
  }
  return `${root.slice(0, 60)}-${crypto.randomUUID().slice(0, 8)}`;
}
const freeArticleSlug = (db: Sql, w: string, locale: string, title: string) =>
  freeSlug(
    slugify(title),
    "article-" + crypto.randomUUID().slice(0, 6),
    async (slug) =>
      (
        await db.query(
          "SELECT 1 FROM knowledge_locales WHERE workspace_id=$1 AND locale=$2 AND slug=$3",
          [w, locale, slug],
        )
      ).rows.length > 0,
  );
/**
 * Records a slug change: the old slug redirects to the object, and the new one, now live, stops
 * being a redirect (a live slug always wins, so renaming back and forth never loops).
 */
export async function moveSlug(
  db: Sql,
  w: string,
  kind: "center" | "collection" | "section" | "article",
  scope: string,
  locale: string,
  from: string | null,
  to: string,
  target: string,
) {
  await db.query(
    "DELETE FROM help_redirects WHERE workspace_id=$1 AND kind=$2 AND scope=$3 AND locale=$4 AND slug=$5",
    [w, kind, scope, locale, to],
  );
  if (from && from !== to)
    await db.query(
      `INSERT INTO help_redirects(workspace_id,kind,scope,locale,slug,target_id) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(workspace_id,kind,scope,locale,slug) DO UPDATE SET target_id=$6,created_at=now()`,
      [w, kind, scope, locale, from, target],
    );
}

/**
 * Records for the Knowledge section. Managers see everything; other teammates see records
 * available to the inbox.
 */
export async function listKnowledge(
  db: Sql,
  w: string,
  principal: string,
  q: URLSearchParams,
) {
  await authorize(db, w, principal, "conversations.read");
  await requireKnowledge(db, w);
  const manage = await can(db, w, principal, "knowledge.manage");
  const values: unknown[] = [w];
  const where = ["r.workspace_id=$1"];
  const bind = (v: unknown) => {
    values.push(v);
    return "$" + values.length;
  };
  if (!manage) where.push("r.for_inbox");
  const source = q.get("source");
  if (source) {
    if (!SOURCES.includes(source as Source)) invalid("Unknown source.");
    where.push("r.source=" + bind(source));
  }
  const text = (q.get("q") ?? "").trim().slice(0, 200);
  // A title match, or the published content (so an uploaded file is found by what is inside it).
  if (text) {
    const like = bind("%" + text.replace(/[%_\\]/g, "\\$&") + "%"),
      words = bind(normalize(text));
    where.push(
      `(EXISTS(SELECT 1 FROM knowledge_locales x WHERE x.workspace_id=r.workspace_id AND x.record_id=r.id AND x.draft_title ILIKE ${like})
      OR EXISTS(SELECT 1 FROM knowledge_search k WHERE k.workspace_id=r.workspace_id AND k.record_id=r.id AND k.document @@ websearch_to_tsquery(k.config,${words})))`,
    );
  }
  const rows = (
    await db.query<{
      id: string;
      source: Source;
      audience: Audience;
      for_ai: boolean;
      for_help_center: boolean;
      for_inbox: boolean;
      owner_id: string;
      owner_name: string;
      last_reviewed_at: string | null;
      updated_at: string;
      locales: { locale: string; status: string; title: string }[];
    }>(
      `SELECT r.id,r.source,r.audience,r.for_ai,r.for_help_center,r.for_inbox,r.owner_id,t.name AS owner_name,r.last_reviewed_at,r.updated_at,
        COALESCE((SELECT json_agg(json_build_object('locale',l.locale,'status',l.status,'title',COALESCE(NULLIF(l.draft_title,''),l.published_title,'')) ORDER BY l.locale)
          FROM knowledge_locales l WHERE l.workspace_id=r.workspace_id AND l.record_id=r.id),'[]') AS locales
      FROM knowledge_records r JOIN teammates t ON t.workspace_id=r.workspace_id AND t.id=r.owner_id
      WHERE ${where.join(" AND ")} ORDER BY r.updated_at DESC,r.id LIMIT 200`,
      values,
    )
  ).rows;
  return {
    records: rows.map((r) => ({
      id: r.id,
      source: r.source,
      audience: r.audience,
      forAi: r.for_ai,
      forHelpCenter: r.for_help_center,
      forInbox: r.for_inbox,
      owner: { id: r.owner_id, name: r.owner_name },
      lastReviewedAt: r.last_reviewed_at
        ? new Date(r.last_reviewed_at).toISOString()
        : null,
      updatedAt: new Date(r.updated_at).toISOString(),
      locales: r.locales,
    })),
    canManage: manage,
    // Phase 07 C1b: whether to offer the Websites tab.
    sync: manage && (await syncAvailable(db, w, principal)),
    // The AI index page (phase 07, C2a) is for managers.
    index: manage && (await indexEnabled(db, w)),
    // The content health report (phase 07, C2b) is for managers too.
    health:
      manage &&
      (
        await db.query(
          "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='knowledge_health_v1' AND enabled",
          [w],
        )
      ).rows.length > 0,
  };
}

/** One record: settings, each locale's draft and published version, and its revision history. */
export async function readKnowledge(
  db: Sql,
  w: string,
  principal: string,
  id: string,
) {
  await authorize(db, w, principal, "conversations.read");
  await requireKnowledge(db, w);
  const r = await record(db, w, id);
  const manage = await can(db, w, principal, "knowledge.manage");
  assert(
    manage || r.for_inbox,
    "KNOWLEDGE_NOT_FOUND",
    "Knowledge record unavailable.",
    404,
  );
  const locales = (
    await db.query<LocaleRow>(
      `SELECT locale,status,draft_title,draft_body,draft_version::text AS draft_version,draft_updated_at,published_title,published_body,published_revision,published_at,slug
      FROM knowledge_locales WHERE workspace_id=$1 AND record_id=$2 ORDER BY locale`,
      [w, r.id],
    )
  ).rows;
  const revisions = (
    await db.query<{
      locale: string;
      revision: number;
      title: string;
      created_at: string;
      name: string | null;
    }>(
      `SELECT v.locale,v.revision,v.title,v.created_at,t.name FROM knowledge_revisions v LEFT JOIN teammates t ON t.workspace_id=v.workspace_id AND t.id=v.created_by
      WHERE v.workspace_id=$1 AND v.record_id=$2 ORDER BY v.locale,v.revision DESC`,
      [w, r.id],
    )
  ).rows;
  return {
    id: r.id,
    source: r.source,
    ownerId: r.owner_id,
    audience: r.audience,
    forAi: r.for_ai,
    forHelpCenter: r.for_help_center,
    forInbox: r.for_inbox,
    // Phase 07 B1: FAQ structured data on the help center page.
    faq: r.faq,
    // Phase 08 Z3b: who Zoe uses it for (no conditions: everyone who may see it).
    aiMatch: r.ai_match,
    aiConditions: r.ai_conditions,
    targetingChoices: manage ? await targetingChoices(db, w) : null,
    lastReviewedAt: r.last_reviewed_at
      ? new Date(r.last_reviewed_at).toISOString()
      : null,
    version: r.version,
    // Teammates without knowledge.manage read only what is live.
    locales: manage
      ? locales.map(localeView)
      : locales
          .filter((l) => l.status === "published")
          .map((l) => ({ ...localeView(l), draft: null })),
    revisions: manage
      ? revisions.map((v) => ({
          locale: v.locale,
          revision: v.revision,
          title: v.title,
          createdAt: new Date(v.created_at).toISOString(),
          by: v.name,
        }))
      : [],
    // Phase 07 B2: what readers said, for the people who write it.
    feedback: manage ? await feedbackSummary(db, w, r.id) : null,
    // Phase 07 C1a: the uploaded file behind a file record.
    file: r.source === "file" ? await fileSummary(db, w, r.id) : null,
    // Phase 07 C1b: the website a synced page comes from.
    page: r.source === "external_page" ? await pageSummary(db, w, r.id) : null,
    canManage: manage,
  };
}

/**
 * Changes to knowledge (needs `knowledge.manage`):
 * create, settings, save (autosave of a locale's draft, from the draft version the editor
 * started from), add_locale, publish, unpublish, archive, restore (a revision into the draft)
 * and review (marks it reviewed now).
 */
export async function changeKnowledge(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const t = await manager(db, w, principal);
  switch (p.op) {
    case "create": {
      const source = p.source as Source;
      if (!SOURCES.includes(source)) invalid("Choose a kind of content.");
      // Files are created by upload (C1a) and synced pages by website sync (C1b), not by hand.
      assert(
        EDITABLE.includes(source),
        "KNOWLEDGE_SOURCE",
        "Files and synced pages are added by upload and sync.",
        409,
      );
      const locale = validLocale(p.locale ?? "en");
      const a = access(source, p);
      const owner = p.ownerId === undefined ? t.id : String(p.ownerId);
      assert(
        (
          await db.query(
            "SELECT 1 FROM teammates WHERE workspace_id=$1 AND id=$2",
            [w, owner],
          )
        ).rows.length,
        "INVALID_KNOWLEDGE",
        "Choose an owner from this workspace.",
      );
      const id = crypto.randomUUID();
      await db.query(
        `INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_help_center,for_inbox) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          w,
          id,
          source,
          owner,
          a.audience,
          a.forAi,
          a.forHelpCenter,
          a.forInbox,
        ],
      );
      await db.query(
        "INSERT INTO knowledge_locales(workspace_id,record_id,locale,draft_title,draft_body,draft_updated_by) VALUES($1,$2,$3,$4,$5,$6)",
        [
          w,
          id,
          locale,
          title(p.title),
          JSON.stringify(articleBody(p.body)),
          t.id,
        ],
      );
      return { id, locale };
    }
    case "settings": {
      const r = await record(db, w, p.id, true);
      assert(
        String(p.version) === r.version,
        "KNOWLEDGE_CONFLICT",
        "These settings changed elsewhere. Reload and try again.",
        409,
      );
      const a = access(r.source, p, r);
      // Z3b: who Zoe uses it for, checked like an escalation rule's conditions.
      const targeting =
        p.aiConditions === undefined
          ? { match: r.ai_match, conditions: r.ai_conditions }
          : await validTargeting(
              db,
              w,
              (await recordTitles(db, w, [r.id])).get(r.id) ?? "This item",
              { match: p.aiMatch, conditions: p.aiConditions },
            );
      const owner = p.ownerId === undefined ? r.owner_id : String(p.ownerId);
      // An FAQ article's question headings become FAQ structured data in the help center.
      const faq = p.faq === undefined ? r.faq : p.faq === true;
      if (faq && r.source !== "article")
        invalid("Only articles can be marked as FAQs.");
      assert(
        (
          await db.query(
            "SELECT 1 FROM teammates WHERE workspace_id=$1 AND id=$2",
            [w, owner],
          )
        ).rows.length,
        "INVALID_KNOWLEDGE",
        "Choose an owner from this workspace.",
      );
      await db.query(
        `UPDATE knowledge_records SET audience=$3,for_ai=$4,for_help_center=$5,for_inbox=$6,owner_id=$7,faq=$8,ai_match=$9,ai_conditions=$10,
        version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
        [
          w,
          r.id,
          a.audience,
          a.forAi,
          a.forHelpCenter,
          a.forInbox,
          owner,
          faq,
          targeting.match,
          JSON.stringify(targeting.conditions),
        ],
      );
      return { id: r.id, version: String(Number(r.version) + 1) };
    }
    case "review": {
      const r = await record(db, w, p.id, true);
      await db.query(
        "UPDATE knowledge_records SET last_reviewed_at=now(),reviewed_by=$3 WHERE workspace_id=$1 AND id=$2",
        [w, r.id, t.id],
      );
      return { id: r.id };
    }
  }
  // Locale operations.
  const r = await record(db, w, p.id, true);
  const locale = validLocale(p.locale);
  // A file's content is its extracted text: replacing the file changes it, not editing.
  assert(
    EDITABLE.includes(r.source) ||
      ["publish", "unpublish", "archive"].includes(String(p.op)),
    "KNOWLEDGE_SOURCE",
    "This content comes from a file or a synced page. Replace the source to change it.",
    409,
  );
  if (p.op === "add_locale") {
    const from = p.fromLocale === undefined ? null : validLocale(p.fromLocale);
    const copy = from
      ? (
          await db.query<{ draft_title: string; draft_body: unknown }>(
            "SELECT draft_title,draft_body FROM knowledge_locales WHERE workspace_id=$1 AND record_id=$2 AND locale=$3",
            [w, r.id, from],
          )
        ).rows[0]
      : null;
    assert(
      !from || copy,
      "KNOWLEDGE_NOT_FOUND",
      "That language is not on this record.",
      404,
    );
    const added = (
      await db.query(
        "INSERT INTO knowledge_locales(workspace_id,record_id,locale,draft_title,draft_body,draft_updated_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING locale",
        [
          w,
          r.id,
          locale,
          copy?.draft_title ?? "",
          JSON.stringify(copy?.draft_body ?? null),
          t.id,
        ],
      )
    ).rows.length;
    assert(
      added,
      "KNOWLEDGE_LOCALE_EXISTS",
      "This language is already on the record.",
      409,
    );
    await touch(db, w, r.id);
    return { id: r.id, locale };
  }
  const l = (
    await db.query<LocaleRow>(
      `SELECT locale,status,draft_title,draft_body,draft_version::text AS draft_version,draft_updated_at,published_title,published_body,published_revision,published_at,slug
      FROM knowledge_locales WHERE workspace_id=$1 AND record_id=$2 AND locale=$3 FOR UPDATE`,
      [w, r.id, locale],
    )
  ).rows[0];
  assert(l, "KNOWLEDGE_NOT_FOUND", "That language is not on this record.", 404);
  const expectDraft = () =>
    assert(
      String(p.draftVersion) === String(l.draft_version),
      "DRAFT_CONFLICT",
      "This draft changed in another tab or by another teammate. Reload to see the latest.",
      409,
    );
  // Publishing a file record again (after unpublishing) brings back its latest extracted text.
  if (p.op === "publish" && !EDITABLE.includes(r.source)) {
    assert(
      l.published_revision !== null,
      "KNOWLEDGE_SOURCE",
      "This file has no text yet. Wait for it to finish processing, or replace it.",
      409,
    );
    await db.query(
      "UPDATE knowledge_locales SET status='published' WHERE workspace_id=$1 AND record_id=$2 AND locale=$3",
      [w, r.id, locale],
    );
    await indexRecord(db, w, r.id);
    await touch(db, w, r.id);
    return { id: r.id, locale, revision: l.published_revision };
  }
  switch (p.op) {
    case "slug": {
      // A new public address; the old one keeps working as a redirect.
      assert(
        r.source === "article",
        "INVALID_KNOWLEDGE",
        "Only articles have a public address.",
      );
      const slug = validSlug(p.slug);
      if (slug === l.slug) return { id: r.id, locale, slug };
      const taken = (
        await db.query(
          "SELECT 1 FROM knowledge_locales WHERE workspace_id=$1 AND locale=$2 AND slug=$3",
          [w, locale, slug],
        )
      ).rows.length;
      assert(
        !taken,
        "SLUG_TAKEN",
        "Another article in this language already uses that address.",
        409,
      );
      await db.query(
        "UPDATE knowledge_locales SET slug=$4 WHERE workspace_id=$1 AND record_id=$2 AND locale=$3",
        [w, r.id, locale, slug],
      );
      await moveSlug(db, w, "article", "", locale, l.slug, slug, r.id);
      await touch(db, w, r.id);
      return { id: r.id, locale, slug };
    }
    case "save": {
      // Autosave: the draft only; the published version is untouched until the next publish.
      expectDraft();
      const body = articleBody(p.body);
      const saved = (
        await db.query<{ draft_version: string }>(
          `UPDATE knowledge_locales SET draft_title=$4,draft_body=$5,draft_version=draft_version+1,draft_updated_at=now(),draft_updated_by=$6
          WHERE workspace_id=$1 AND record_id=$2 AND locale=$3 RETURNING draft_version::text AS draft_version`,
          [w, r.id, locale, title(p.title), JSON.stringify(body), t.id],
        )
      ).rows[0];
      await touch(db, w, r.id);
      return { id: r.id, locale, draftVersion: saved.draft_version };
    }
    case "publish": {
      expectDraft();
      assert(
        l.draft_title.trim(),
        "INVALID_KNOWLEDGE",
        "Give it a title before publishing.",
      );
      assert(
        l.draft_body,
        "INVALID_KNOWLEDGE",
        "Write something before publishing.",
      );
      const revision = (l.published_revision ?? 0) + 1;
      // The draft was validated when saved; it is checked again in case the rules have changed.
      const body = articleBody(l.draft_body)!;
      // Images must be uploaded and scanned before they can go live.
      const images = imageIds(body);
      const ready = await readyImages(db, w, r.id, images);
      assert(
        images.every((id) => ready.has(id)),
        "IMAGE_NOT_READY",
        "An image is still uploading or was rejected. Wait for it, or remove it, then publish.",
        409,
      );
      await db.query(
        "INSERT INTO knowledge_revisions(workspace_id,record_id,locale,revision,title,body,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [w, r.id, locale, revision, l.draft_title, JSON.stringify(body), t.id],
      );
      await db.query(
        `UPDATE knowledge_locales SET status='published',published_title=draft_title,published_body=$4,published_text=$5,published_revision=$6,published_at=now(),published_by=$7
        WHERE workspace_id=$1 AND record_id=$2 AND locale=$3`,
        [
          w,
          r.id,
          locale,
          JSON.stringify(body),
          plainText(body),
          revision,
          t.id,
        ],
      );
      // An article gets its public slug on first publish; it then stays put unless edited.
      if (r.source === "article" && !l.slug) {
        const slug = await freeArticleSlug(db, w, locale, l.draft_title);
        await db.query(
          "UPDATE knowledge_locales SET slug=$4 WHERE workspace_id=$1 AND record_id=$2 AND locale=$3",
          [w, r.id, locale, slug],
        );
        // A live slug replaces any old redirect with the same address.
        await moveSlug(db, w, "article", "", locale, null, slug, r.id);
      }
      // Searchable from now (phase 07, B2). TODO(phase 07 C2): chunk and embed here too.
      await indexRecord(db, w, r.id);
      await touch(db, w, r.id);
      return { id: r.id, locale, revision };
    }
    case "unpublish":
    case "archive": {
      // Unpublished content keeps its published version (for history and restore) but is not live.
      await db.query(
        "UPDATE knowledge_locales SET status=$4 WHERE workspace_id=$1 AND record_id=$2 AND locale=$3",
        [w, r.id, locale, p.op === "archive" ? "archived" : "draft"],
      );
      await indexRecord(db, w, r.id);
      await touch(db, w, r.id);
      return {
        id: r.id,
        locale,
        status: p.op === "archive" ? "archived" : "draft",
      };
    }
    case "restore": {
      // A revision becomes the draft; publishing it makes it live again (as a new revision).
      expectDraft();
      const v = (
        await db.query<{ title: string; body: unknown }>(
          "SELECT title,body FROM knowledge_revisions WHERE workspace_id=$1 AND record_id=$2 AND locale=$3 AND revision=$4",
          [w, r.id, locale, Number(p.revision)],
        )
      ).rows[0];
      assert(
        v,
        "KNOWLEDGE_NOT_FOUND",
        "That version is not on this record.",
        404,
      );
      const saved = (
        await db.query<{ draft_version: string }>(
          `UPDATE knowledge_locales SET draft_title=$4,draft_body=$5,draft_version=draft_version+1,draft_updated_at=now(),draft_updated_by=$6
          WHERE workspace_id=$1 AND record_id=$2 AND locale=$3 RETURNING draft_version::text AS draft_version`,
          [w, r.id, locale, v.title, JSON.stringify(v.body), t.id],
        )
      ).rows[0];
      await touch(db, w, r.id);
      return { id: r.id, locale, draftVersion: saved.draft_version };
    }
  }
  return invalid(
    "Choose create, settings, save, add_locale, publish, unpublish, archive, restore or review.",
  );
}
const touch = (db: Sql, w: string, id: string) =>
  db.query(
    "UPDATE knowledge_records SET updated_at=now() WHERE workspace_id=$1 AND id=$2",
    [w, id],
  );
