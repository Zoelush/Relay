import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { manager } from "./knowledge";

/**
 * Help center search and feedback (phase 07, step B2).
 *
 * Search is PostgreSQL full-text search with each language's own stemming, plus trigram matching
 * so a typo still finds the article ("pasword" finds "password"). Accents are removed before
 * indexing and before searching, so "reinitialiser" finds "Réinitialiser". Ranking: matches in
 * the title, then in the text, then by typo closeness. Only what the visitor may read is searched,
 * in the languages of their fallback chain; each article appears once, in the first language
 * along the chain.
 *
 * What customers search for is logged, without email addresses or long numbers, for 180 days,
 * so the content team can see what people cannot find. Feedback is a helpful/not-helpful vote
 * with an optional comment.
 *
 * TODO(phase 07 C2): blend in vector similarity once articles are embedded.
 */
export const QUERY_RETENTION_DAYS = 180;
const RECEIPT_MS = 30 * 60_000;

/** PostgreSQL text search configurations by base language; anything else is "simple". */
const CONFIGS: Record<string, string> = {
  ar: "arabic",
  hy: "armenian",
  eu: "basque",
  ca: "catalan",
  da: "danish",
  nl: "dutch",
  en: "english",
  et: "estonian",
  fi: "finnish",
  fr: "french",
  de: "german",
  el: "greek",
  hi: "hindi",
  hu: "hungarian",
  id: "indonesian",
  ga: "irish",
  it: "italian",
  lt: "lithuanian",
  ne: "nepali",
  nb: "norwegian",
  nn: "norwegian",
  no: "norwegian",
  pt: "portuguese",
  ro: "romanian",
  ru: "russian",
  sr: "serbian",
  es: "spanish",
  sv: "swedish",
  ta: "tamil",
  tr: "turkish",
  yi: "yiddish",
};
export const searchConfig = (locale: string) =>
  CONFIGS[locale.split("-")[0].toLowerCase()] ?? "simple";

/** Lower case without accents: what is indexed and what is searched. */
export function normalize(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
/**
 * The words of a query worth matching for typos: at most eight, of four letters or more (shorter
 * fragments match too much by trigram similarity; full-text search still matches them exactly).
 */
const words = (q: string) =>
  [...new Set(q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4))].slice(
    0,
    8,
  );

/**
 * A query as it is kept in the log: email addresses and long numbers (phone, card, order and
 * account numbers) are removed first, so the log does not collect customers' details.
 */
export function redactQuery(text: string) {
  return text
    .replace(/[^\s@]+@[^\s@]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{4,}\d/g, (m) =>
      m.replace(/\D/g, "").length >= 6 ? "[number]" : m,
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Keeps one record's search rows in step with its published languages. Called when a language is
 * published, unpublished or archived. Only published versions are searchable.
 */
export async function indexRecord(db: Sql, w: string, recordId: string) {
  await db.query(
    "DELETE FROM knowledge_search WHERE workspace_id=$1 AND record_id=$2",
    [w, recordId],
  );
  const rows = (
    await db.query<{ locale: string; title: string; text: string }>(
      `SELECT locale,published_title AS title,COALESCE(published_text,'') AS text FROM knowledge_locales
      WHERE workspace_id=$1 AND record_id=$2 AND status='published' AND published_title IS NOT NULL`,
      [w, recordId],
    )
  ).rows;
  for (const r of rows) {
    const config = searchConfig(r.locale);
    const title = normalize(r.title),
      body = normalize(r.text).slice(0, 50_000);
    await db.query(
      `INSERT INTO knowledge_search(workspace_id,record_id,locale,config,title,title_norm,body_norm,document)
      VALUES($1,$2,$3,$4::regconfig,$5,$6,$7,setweight(to_tsvector($4::regconfig,$6),'A') || setweight(to_tsvector($4::regconfig,$7),'B'))`,
      [w, recordId, r.locale, config, r.title, title, body],
    );
  }
}
/** Rebuilds the index for a workspace (seed data, or after a change to the rules). */
export async function reindexKnowledge(db: Sql, w: string) {
  const ids = (
    await db.query<{ id: string }>(
      "SELECT id FROM knowledge_records WHERE workspace_id=$1",
      [w],
    )
  ).rows;
  for (const { id } of ids) await indexRecord(db, w, id);
  return ids.length;
}

export type SearchResult = {
  id: string;
  locale: string;
  title: string;
  excerpt: string;
};

/**
 * Searches a help center: articles placed in its live collections and sections, switched on for
 * the help center, published in one of `chain`'s languages, and public unless `signedIn`.
 */
export async function searchHelp(
  db: Sql,
  w: string,
  centerId: string,
  chain: string[],
  query: string,
  signedIn: boolean,
  limit = 20,
): Promise<SearchResult[]> {
  // Email addresses and long numbers are never searched for (nor kept in the log).
  const q = normalize(redactQuery(query).replace(/\[(email|number)\]/g, " "));
  const terms = words(q);
  if (!q.replace(/[^\p{L}\p{N}]/gu, "")) return [];
  // A typo-tolerant word match needs at least this trigram word similarity.
  await db.query("SET LOCAL pg_trgm.word_similarity_threshold = 0.5");
  return (
    await db.query<SearchResult>(
      `WITH visible AS (
        SELECT DISTINCT p.record_id FROM help_placements p
        JOIN help_nodes n ON n.workspace_id=p.workspace_id AND n.id=p.node_id
        LEFT JOIN help_nodes parent ON parent.workspace_id=n.workspace_id AND parent.id=n.parent_id
        JOIN knowledge_records r ON r.workspace_id=p.workspace_id AND r.id=p.record_id
        WHERE p.workspace_id=$1 AND n.center_id=$2 AND NOT n.archived AND NOT COALESCE(parent.archived,false)
          AND r.source='article' AND r.for_help_center AND (r.audience='public' OR ($6 AND r.audience='signed_in'))
      ), matched AS (
        -- Matches in any language along the chain count; the best one ranks the article.
        SELECT k.record_id,max(
          ts_rank_cd(k.document,websearch_to_tsquery(k.config,$4),32)*10
          + (SELECT COALESCE(avg(GREATEST(word_similarity(t,k.title_norm)*2,word_similarity(t,k.body_norm))),0) FROM unnest($5::text[]) t)
        ) AS score
        FROM knowledge_search k JOIN visible v ON v.record_id=k.record_id
        WHERE k.workspace_id=$1 AND k.locale=ANY($3::text[])
          AND (k.document @@ websearch_to_tsquery(k.config,$4)
            OR EXISTS(SELECT 1 FROM unnest($5::text[]) t WHERE t <% k.title_norm OR t <% k.body_norm))
        GROUP BY k.record_id
      ), shown AS (
        -- Each article is shown in the first language along the chain it is published in.
        SELECT DISTINCT ON (k.record_id) k.record_id,k.locale,k.title,l.published_text
        FROM knowledge_search k JOIN matched m ON m.record_id=k.record_id
        JOIN knowledge_locales l ON l.workspace_id=k.workspace_id AND l.record_id=k.record_id AND l.locale=k.locale AND l.status='published'
        WHERE k.workspace_id=$1 AND k.locale=ANY($3::text[])
        ORDER BY k.record_id,array_position($3::text[],k.locale)
      )
      SELECT s.record_id AS id,s.locale,s.title,left(COALESCE(s.published_text,''),400) AS excerpt
      FROM shown s JOIN matched m ON m.record_id=s.record_id ORDER BY m.score DESC,s.title LIMIT $7`,
      [w, centerId, chain, q, terms, signedIn, limit],
    )
  ).rows.map((r) => ({ ...r, excerpt: excerpt(r.excerpt) }));
}
const excerpt = (text: string) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= 160
    ? t
    : t.slice(0, Math.max(t.slice(0, 157).lastIndexOf(" "), 120)) + "…";
};

/** Logs a search; returns its id, used when a result is opened. */
export async function logSearch(
  db: Sql,
  w: string,
  entry: {
    centerId: string;
    locale: string;
    surface: "help_center" | "messenger";
    query: string;
    results: number;
  },
) {
  const query = redactQuery(entry.query);
  if (!query) return null;
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO help_search_queries(workspace_id,id,center_id,locale,surface,query,normalized,results)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      w,
      id,
      entry.centerId,
      entry.locale,
      entry.surface,
      query,
      normalize(query),
      entry.results,
    ],
  );
  return id;
}
/** Records which result a search led to (the first one opened). */
export async function openedResult(
  db: Sql,
  w: string,
  queryId: string,
  recordId: string,
) {
  if (!/^[0-9a-f-]{36}$/.test(queryId)) return;
  await db.query(
    `UPDATE help_search_queries SET opened_record_id=$3,opened_at=now()
    WHERE workspace_id=$1 AND id=$2 AND opened_record_id IS NULL AND created_at>now()-interval '1 day'`,
    [w, queryId, recordId],
  );
}
/** Removes searches older than the retention period, up to 5,000 per run. */
export async function purgeHelpSearches(connect: Connect, w: string) {
  return tenant(
    connect,
    w,
    async (db) =>
      (
        await db.query(
          `DELETE FROM help_search_queries WHERE workspace_id=$1 AND id IN (
          SELECT id FROM help_search_queries WHERE workspace_id=$1 AND created_at<now()-make_interval(days=>$2) ORDER BY created_at LIMIT 5000)
          RETURNING 1`,
          [w, QUERY_RETENTION_DAYS],
        )
      ).rows.length,
  );
}

/** A vote, or the comment that follows a "No" (by the vote's id, within the hour). */
export async function recordFeedback(
  db: Sql,
  w: string,
  entry: {
    recordId: string;
    locale: string;
    surface: "help_center" | "messenger";
    helpful?: boolean;
    comment?: string;
    feedbackId?: string;
    identityId?: string | null;
  },
) {
  const comment = (entry.comment ?? "").trim();
  if (comment.length > 1000)
    throw new DomainError(
      "INVALID_FEEDBACK",
      "Keep your comment under 1,000 characters.",
      400,
    );
  if (entry.feedbackId) {
    const updated = await db.query<{ id: string }>(
      `UPDATE knowledge_feedback SET comment=$4 WHERE workspace_id=$1 AND id=$2 AND record_id=$3
      AND comment IS NULL AND NOT helpful AND created_at>now()-interval '1 hour' RETURNING id`,
      [w, entry.feedbackId, entry.recordId, comment || null],
    );
    assert(
      updated.rows.length,
      "FEEDBACK_EXPIRED",
      "That feedback can no longer be changed.",
      409,
    );
    return { id: entry.feedbackId };
  }
  assert(
    typeof entry.helpful === "boolean",
    "INVALID_FEEDBACK",
    "Say whether it helped.",
  );
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO knowledge_feedback(workspace_id,id,record_id,locale,surface,helpful,comment,identity_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      w,
      id,
      entry.recordId,
      entry.locale,
      entry.surface,
      entry.helpful,
      comment || null,
      entry.identityId ?? null,
    ],
  );
  return { id };
}
/** Links a customer's own "not helpful" vote to the conversation it led to. */
export async function linkFeedback(
  db: Sql,
  w: string,
  feedbackId: string,
  conversationId: string,
  identityId: string,
) {
  await db.query(
    "UPDATE knowledge_feedback SET conversation_id=$3 WHERE workspace_id=$1 AND id=$2 AND identity_id=$4 AND conversation_id IS NULL",
    [w, feedbackId, conversationId, identityId],
  );
}

/** One record's feedback for the editor: counts and the latest comments. */
export async function feedbackSummary(db: Sql, w: string, recordId: string) {
  const [counts] = (
    await db.query<{ helpful: number; unhelpful: number }>(
      `SELECT count(*) FILTER (WHERE helpful)::int AS helpful,count(*) FILTER (WHERE NOT helpful)::int AS unhelpful
      FROM knowledge_feedback WHERE workspace_id=$1 AND record_id=$2`,
      [w, recordId],
    )
  ).rows;
  const comments = (
    await db.query<{
      comment: string;
      locale: string;
      created_at: string;
      conversation_id: string | null;
    }>(
      `SELECT comment,locale,created_at,conversation_id FROM knowledge_feedback
      WHERE workspace_id=$1 AND record_id=$2 AND comment IS NOT NULL ORDER BY created_at DESC LIMIT 5`,
      [w, recordId],
    )
  ).rows;
  return {
    ...counts,
    comments: comments.map((c) => ({
      comment: c.comment,
      locale: c.locale,
      createdAt: new Date(c.created_at).toISOString(),
      conversationId: c.conversation_id,
    })),
  };
}

/**
 * The content team's view (`knowledge.manage`): searches with no results, searches whose results
 * nobody opened, and the articles with the most "not helpful" votes, over the last `days`.
 */
export async function helpInsights(
  db: Sql,
  w: string,
  principal: string,
  centerId: string,
  days = 30,
) {
  await manager(db, w, principal);
  assert(
    (
      await db.query(
        "SELECT 1 FROM help_centers WHERE workspace_id=$1 AND id=$2",
        [w, centerId],
      )
    ).rows.length,
    "HELP_CENTER_NOT_FOUND",
    "Help center unavailable.",
    404,
  );
  const span = Math.min(
    Math.max(Math.floor(days) || 30, 1),
    QUERY_RETENTION_DAYS,
  );
  const group = (where: string) =>
    db
      .query<{ query: string; searches: number; last: string }>(
        `SELECT (array_agg(query ORDER BY created_at DESC))[1] AS query,count(*)::int AS searches,max(created_at) AS last
        FROM help_search_queries WHERE workspace_id=$1 AND center_id=$2 AND created_at>now()-make_interval(days=>$3) AND ${where}
        GROUP BY normalized ORDER BY count(*) DESC,max(created_at) DESC LIMIT 20`,
        [w, centerId, span],
      )
      .then((r) =>
        r.rows.map((x) => ({
          query: x.query,
          searches: x.searches,
          last: new Date(x.last).toISOString(),
        })),
      );
  const [totals] = (
    await db.query<{ searches: number; empty: number; opened: number }>(
      `SELECT count(*)::int AS searches,count(*) FILTER (WHERE results=0)::int AS empty,count(*) FILTER (WHERE opened_record_id IS NOT NULL)::int AS opened
      FROM help_search_queries WHERE workspace_id=$1 AND center_id=$2 AND created_at>now()-make_interval(days=>$3)`,
      [w, centerId, span],
    )
  ).rows;
  const articles = (
    await db.query<{
      id: string;
      title: string;
      helpful: number;
      unhelpful: number;
    }>(
      `SELECT f.record_id AS id,
        COALESCE((SELECT published_title FROM knowledge_locales l WHERE l.workspace_id=f.workspace_id AND l.record_id=f.record_id AND l.published_title IS NOT NULL ORDER BY l.locale LIMIT 1),'') AS title,
        count(*) FILTER (WHERE f.helpful)::int AS helpful,count(*) FILTER (WHERE NOT f.helpful)::int AS unhelpful
      FROM knowledge_feedback f WHERE f.workspace_id=$1 AND f.created_at>now()-make_interval(days=>$2)
        AND f.record_id IN (SELECT p.record_id FROM help_placements p JOIN help_nodes n ON n.workspace_id=p.workspace_id AND n.id=p.node_id WHERE p.workspace_id=$1 AND n.center_id=$3)
      GROUP BY f.workspace_id,f.record_id HAVING count(*) FILTER (WHERE NOT f.helpful)>0
      ORDER BY count(*) FILTER (WHERE NOT f.helpful) DESC LIMIT 10`,
      [w, span, centerId],
    )
  ).rows;
  return {
    days: span,
    totals,
    noResults: await group("results=0"),
    noClicks: await group("results>0 AND opened_record_id IS NULL"),
    unhelpful: articles,
  };
}

/** A short-lived proof that a customer searched the help center ("search before contacting"). */
export type SearchReceipt = {
  workspace: string;
  brand: string;
  identity: string;
  query: string;
};
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
async function receiptKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("relay-search-receipt:" + secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
/** Signs a receipt bound to the workspace, brand, customer and (redacted) query, for 30 minutes. */
export async function issueReceipt(
  secret: string,
  r: SearchReceipt,
  now = Date.now(),
) {
  const payload = new TextEncoder().encode(
    JSON.stringify({
      w: r.workspace,
      b: r.brand,
      i: r.identity,
      q: redactQuery(r.query),
      e: now + RECEIPT_MS,
    }),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await receiptKey(secret), payload),
  );
  return `${b64url(payload)}.${b64url(signature)}`;
}
/** The searched query if the receipt is genuine, unexpired and this customer's; otherwise null. */
export async function verifyReceipt(
  secret: string,
  receipt: unknown,
  scope: { workspace: string; brand: string; identity: string },
  now = Date.now(),
): Promise<string | null> {
  if (typeof receipt !== "string" || receipt.length > 2000) return null;
  const [body, signature] = receipt.split(".");
  if (!body || !signature) return null;
  try {
    const payload = fromB64url(body);
    const valid = await crypto.subtle.verify(
      "HMAC",
      await receiptKey(secret),
      fromB64url(signature),
      payload,
    );
    if (!valid) return null;
    const r = JSON.parse(new TextDecoder().decode(payload)) as {
      w: string;
      b: string;
      i: string;
      q: string;
      e: number;
    };
    if (
      r.w !== scope.workspace ||
      r.b !== scope.brand ||
      r.i !== scope.identity ||
      !(r.e > now)
    )
      return null;
    return r.q;
  } catch {
    return null;
  }
}
