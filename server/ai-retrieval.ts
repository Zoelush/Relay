import { tenant, type Connect } from "./db";
import { normalize } from "./help-search";
import type { IndexEnvironment } from "./knowledge-index";
import { contentWords, type Passage, type RerankPort } from "./ai-model";

/**
 * Hybrid retrieval for the AI agent (phase 08, step A1; docs/AI_STEP1.md).
 *
 * Candidates come from two searches over the AI index's passages: keyword (PostgreSQL full-text
 * search in each passage's language) and meaning (the vector store). Both draw only from passages
 * this customer may see, decided in PostgreSQL before any ranking:
 * - the record is switched on for the AI agent and published;
 * - its audience is public, or signed-in and the customer is verified;
 * - the passage is in the first language along the customer's chain the record is published in;
 * - the record isn't placed only in another brand's help centers;
 * - for a specialist with chosen knowledge (Z3a; docs/AI_STEP7.md): it's placed in one of her
 *   collections (or their sections), is a page of one of her websites, or is a snippet or file
 *   when she has those, so she can't cite content meant for another part of the business.
 * The vector store's nearest neighbours are checked against that set before they're ranked, so a
 * passage the customer may not see never influences the ranking or the confidence score.
 *
 * The two lists are fused by reciprocal rank, the best are reranked (`RerankPort`), and the agent
 * gates on the top rerank score. Each passage keeps its record id, so every sentence of an answer
 * can be traced to a record.
 */
/** A specialist's knowledge (Z3a): null for all of Zoe's. */
export type KnowledgeScope = {
  collections: string[];
  websites: string[];
  snippets: boolean;
  files: boolean;
} | null;
export type Retrieval = {
  passages: (Passage & { chunkId: string })[];
  /** For the answer's audit record: every candidate and how it scored. */
  candidates: {
    chunkId: string;
    recordId: string;
    keywordRank: number | null;
    vectorScore: number | null;
    fused: number;
    rerank: number | null;
  }[];
  topScore: number;
};
const CANDIDATES = 20;
const RERANKED = 12;
const PER_RECORD = 2;
const RRF_K = 60;

export async function retrieveForAgent(
  connect: Connect,
  env: { index: IndexEnvironment; rerank: RerankPort },
  w: string,
  options: {
    query: string;
    chain: string[];
    brandId: string;
    signedIn: boolean;
    limit?: number;
    scope?: KnowledgeScope;
  },
): Promise<Retrieval> {
  const limit = options.limit ?? 6;
  const query = options.query.trim().slice(0, 1000);
  const empty: Retrieval = { passages: [], candidates: [], topScore: 0 };
  if (!query) return empty;
  // Which passages may be used, decided before anything is ranked.
  const ALLOWED = `allowed AS (
    SELECT c.chunk_id,c.record_id,c.locale,c.heading,c.text,c.document,l.published_title AS title
    FROM knowledge_records r
    JOIN LATERAL (SELECT l.locale FROM knowledge_locales l WHERE l.workspace_id=r.workspace_id AND l.record_id=r.id
      AND l.status='published' AND l.locale=ANY($2::text[]) ORDER BY array_position($2::text[],l.locale) LIMIT 1) pick ON true
    JOIN knowledge_locales l ON l.workspace_id=r.workspace_id AND l.record_id=r.id AND l.locale=pick.locale
    JOIN knowledge_chunks c ON c.workspace_id=r.workspace_id AND c.record_id=r.id AND c.locale=pick.locale
    WHERE r.workspace_id=$1 AND r.for_ai AND (r.audience='public' OR (r.audience='signed_in' AND $3::boolean))
      AND (NOT EXISTS(SELECT 1 FROM help_placements p WHERE p.workspace_id=r.workspace_id AND p.record_id=r.id)
        OR EXISTS(SELECT 1 FROM help_placements p JOIN help_nodes n ON n.workspace_id=p.workspace_id AND n.id=p.node_id
          JOIN help_centers h ON h.workspace_id=n.workspace_id AND h.id=n.center_id
          WHERE p.workspace_id=r.workspace_id AND p.record_id=r.id AND h.brand_id=$4))
      AND ($5::boolean
        OR EXISTS(SELECT 1 FROM help_placements p JOIN help_nodes n ON n.workspace_id=p.workspace_id AND n.id=p.node_id
          WHERE p.workspace_id=r.workspace_id AND p.record_id=r.id AND NOT n.archived
            AND (n.id=ANY($6::text[]) OR n.parent_id=ANY($6::text[])))
        OR EXISTS(SELECT 1 FROM knowledge_source_pages s
          WHERE s.workspace_id=r.workspace_id AND s.record_id=r.id AND s.source_id=ANY($7::text[]))
        OR (r.source='snippet' AND $8::boolean)
        OR (r.source='file' AND $9::boolean)))`;
  const scope = options.scope ?? null;
  const base = [
    w,
    options.chain,
    options.signedIn,
    options.brandId,
    !scope,
    scope?.collections ?? [],
    scope?.websites ?? [],
    scope?.snippets ?? false,
    scope?.files ?? false,
  ];
  const terms = [
    ...new Set(
      normalize(query)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 2),
    ),
  ].slice(0, 16);
  const { generation, keyword } = await tenant(connect, w, async (db) => {
    const generation = (
      await db.query<{ id: string; model: string; model_version: string }>(
        "SELECT id,model,model_version FROM knowledge_index_generations WHERE workspace_id=$1 AND status='active'",
        [w],
      )
    ).rows[0];
    const keyword = terms.length
      ? (
          await db.query<{ chunk_id: string }>(
            `WITH ${ALLOWED}, q AS (SELECT a.*,to_tsquery(relay_text_config(a.locale),$10) AS tsq FROM allowed a)
             SELECT chunk_id FROM q WHERE document @@ tsq
             ORDER BY ts_rank_cd(document,tsq,32) DESC,chunk_id LIMIT ${CANDIDATES}`,
            [...base, terms.map((t) => `'${t}'`).join(" | ")],
          )
        ).rows.map((r) => r.chunk_id)
      : [];
    return { generation, keyword };
  });

  // Meaning: the vector store's nearest, kept only if allowed.
  let vector: { chunkId: string; score: number }[] = [];
  const embedder =
    generation &&
    env.index.embedders.find(
      (e) =>
        e.model === generation.model && e.version === generation.model_version,
    );
  if (generation && embedder) {
    const [v] = await embedder.embed([query]);
    const matches = await env.index.vectors.query(generation.id, v, 60);
    if (matches.length) {
      const score = new Map(matches.map((m) => [m.id, m.score]));
      const rows = await tenant(
        connect,
        w,
        async (db) =>
          (
            await db.query<{ chunk_id: string; vector_id: string }>(
              `WITH ${ALLOWED}
               SELECT a.chunk_id,v.vector_id FROM allowed a JOIN knowledge_chunk_vectors v
                 ON v.workspace_id=$1 AND v.generation_id=$10 AND v.chunk_id=a.chunk_id
               WHERE v.vector_id=ANY($11::text[])`,
              [...base, generation.id, matches.map((m) => m.id)],
            )
          ).rows,
      );
      vector = rows
        .map((r) => ({ chunkId: r.chunk_id, score: score.get(r.vector_id)! }))
        .sort((a, b) => b.score - a.score)
        .slice(0, CANDIDATES);
    }
  }

  // Reciprocal rank fusion.
  const fused = new Map<string, number>();
  keyword.forEach((id, i) =>
    fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + i + 1)),
  );
  vector.forEach((v, i) =>
    fused.set(v.chunkId, (fused.get(v.chunkId) ?? 0) + 1 / (RRF_K + i + 1)),
  );
  if (!fused.size) return empty;
  const ranked = [...fused].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  );
  const top = ranked.slice(0, RERANKED).map(([id]) => id);
  const rows = await tenant(
    connect,
    w,
    async (db) =>
      (
        await db.query<{
          chunk_id: string;
          record_id: string;
          locale: string;
          heading: string;
          text: string;
          title: string | null;
        }>(
          `WITH ${ALLOWED} SELECT chunk_id,record_id,locale,heading,text,title FROM allowed WHERE chunk_id=ANY($10::text[])`,
          [...base, top],
        )
      ).rows,
  );
  const byId = new Map(rows.map((r) => [r.chunk_id, r]));
  const present = top.filter((id) => byId.has(id));
  const scores = await env.rerank.score(
    query,
    present.map((id) => {
      const r = byId.get(id)!;
      return `${r.title ?? ""}${r.heading ? ` › ${r.heading}` : ""}\n${r.text}`;
    }),
  );
  const rerank = new Map(present.map((id, i) => [id, scores[i]]));
  const order = [...present].sort(
    (a, b) => rerank.get(b)! - rerank.get(a)! || fused.get(b)! - fused.get(a)!,
  );
  const perRecord = new Map<string, number>();
  const chosen: string[] = [];
  for (const id of order) {
    const record = byId.get(id)!.record_id;
    if ((perRecord.get(record) ?? 0) >= PER_RECORD) continue;
    perRecord.set(record, (perRecord.get(record) ?? 0) + 1);
    chosen.push(id);
    if (chosen.length >= limit) break;
  }
  const keywordRank = new Map(keyword.map((id, i) => [id, i + 1]));
  const vectorScore = new Map(vector.map((v) => [v.chunkId, v.score]));
  return {
    passages: chosen.map((id, i) => {
      const r = byId.get(id)!;
      return {
        id: `p${i + 1}`,
        chunkId: id,
        recordId: r.record_id,
        title: r.title ?? "",
        heading: r.heading,
        text: r.text,
        locale: r.locale,
      };
    }),
    candidates: ranked.slice(0, CANDIDATES).map(([id, score]) => ({
      chunkId: id,
      recordId: byId.get(id)?.record_id ?? "",
      keywordRank: keywordRank.get(id) ?? null,
      vectorScore: vectorScore.has(id)
        ? Math.round(vectorScore.get(id)! * 1000) / 1000
        : null,
      fused: Math.round(score * 10000) / 10000,
      rerank: rerank.has(id) ? Math.round(rerank.get(id)! * 1000) / 1000 : null,
    })),
    topScore: chosen.length ? rerank.get(chosen[0])! : 0,
  };
}

/** Whether a question has anything to search for (used to skip greetings). */
export const searchable = (text: string) => contentWords(text).length > 0;
