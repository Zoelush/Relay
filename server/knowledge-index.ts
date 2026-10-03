import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import { authorize } from "./policy";
import { manager, requireKnowledge } from "./knowledge";
import { plainText, type RichBlock, type RichDoc } from "../lib/rich-doc";

/**
 * The AI index (phase 07, step C2a; docs/KNOWLEDGE_STEP7.md).
 *
 * Published knowledge is split into chunks (`chunkLocale`), embedded by a model
 * (`EmbeddingPort`) and stored in a vector store (`VectorStorePort`), then searched by meaning
 * (`retrieveKnowledge`). Vectors never enter the primary database: PostgreSQL keeps the chunks'
 * text, which index version holds which chunk, and what still needs indexing.
 *
 * - **Triggered by content, not callers.** A trigger on knowledge_locales marks a record whenever
 *   what it publishes changes (manual publishing, file processing and website sync alike); the
 *   `knowledge.index` job works through marked records, a batch per step, and a scheduled check
 *   (`scheduleIndex`) starts it when there is work.
 * - **Idempotent and resumable.** A chunk's id is a hash of its record, locale, heading and text,
 *   so unchanged text keeps its vectors and a repeated step changes nothing; a rebuild records
 *   its cursor after every batch.
 * - **Index versions.** Each version records its model, model version and dimensions. Searches
 *   read only the active version; a re-embed builds a new one beside it (changes are written to
 *   both meanwhile), then switches in one update and removes the old vectors.
 * - **Access is checked in PostgreSQL at query time**, never taken from the vector store, so an
 *   internal, unpublished or switched-off record is never returned where it shouldn't be.
 */

/* ------------------------------------------------------------------------------------------ */
/* Ports                                                                                       */

export type EmbeddingPort = {
  /** Recorded on each index version, with `version`, so a change of either means a re-embed. */
  model: string;
  version: string;
  dimensions: number;
  /** The most texts one `embed` call accepts. */
  maxBatch: number;
  embed(texts: string[]): Promise<number[][]>;
};
export type VectorMatch = { id: string; score: number };
export type VectorStorePort = {
  /** Writes or replaces vectors by id, within a namespace (one per index version). */
  upsert(
    namespace: string,
    items: { id: string; values: number[] }[],
  ): Promise<void>;
  remove(namespace: string, ids: string[]): Promise<void>;
  /** The nearest vectors by cosine similarity, best first. */
  query(
    namespace: string,
    vector: number[],
    topK: number,
  ): Promise<VectorMatch[]>;
};
export type IndexEnvironment = {
  /** The models this deployment can run; the first is used for new index versions. */
  embedders: EmbeddingPort[];
  vectors: VectorStorePort;
};

/* ------------------------------------------------------------------------------------------ */
/* Local and test implementations                                                              */

const STOP = new Set(
  "a an and are as at be by for from has have how i in is it its of on or that the this to was what when where which who will with you your".split(
    " ",
  ),
);
/**
 * Words for the test embedder: lower case, accents removed, stop words dropped, and plain English
 * endings trimmed ("refunds", "refunded" and "refunding" all read "refund").
 */
function words(text: string) {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) =>
      w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w.replace(/s$/, ""),
    );
}
function fnv(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
/**
 * A deterministic stand-in for a real model, used locally and in tests: words (and, more
 * lightly, word pairs) counted into a fixed number of dimensions by hashing, then normalised.
 * Texts sharing words land near each other, which is enough to test retrieval, ranking and
 * re-embedding; it knows nothing of meaning beyond shared words.
 */
export function testEmbedder(
  options: { version?: string; dimensions?: number; fail?: () => boolean } = {},
): EmbeddingPort {
  const dimensions = options.dimensions ?? 512;
  return {
    model: "relay-test-hash",
    version: options.version ?? "1",
    dimensions,
    maxBatch: 64,
    async embed(texts) {
      if (options.fail?.())
        throw new DomainError(
          "EMBEDDING_UNAVAILABLE",
          "The embedding model did not answer.",
          503,
        );
      return texts.map((text) => {
        const v = new Array<number>(dimensions).fill(0);
        const ws = words(text);
        for (const w of ws) v[fnv(w) % dimensions] += 1;
        for (let i = 1; i < ws.length; i++)
          v[fnv(ws[i - 1] + " " + ws[i]) % dimensions] += 0.5;
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
}
/** A vector store held in memory (tests), optionally saved after every change (the local relay). */
export function memoryVectorStore(
  options: {
    initial?: Record<string, Record<string, number[]>>;
    save?: (data: Record<string, Record<string, number[]>>) => void;
  } = {},
): VectorStorePort & { size(namespace?: string): number } {
  const spaces = new Map<string, Map<string, number[]>>(
    Object.entries(options.initial ?? {}).map(([ns, items]) => [
      ns,
      new Map(Object.entries(items)),
    ]),
  );
  const save = () =>
    options.save?.(
      Object.fromEntries(
        [...spaces].map(([ns, items]) => [ns, Object.fromEntries(items)]),
      ),
    );
  const space = (ns: string) => {
    let s = spaces.get(ns);
    if (!s) spaces.set(ns, (s = new Map()));
    return s;
  };
  return {
    async upsert(ns, items) {
      const s = space(ns);
      for (const item of items) s.set(item.id, item.values);
      save();
    },
    async remove(ns, ids) {
      const s = space(ns);
      for (const id of ids) s.delete(id);
      if (!s.size) spaces.delete(ns);
      save();
    },
    async query(ns, vector, topK) {
      const s = spaces.get(ns);
      if (!s) return [];
      const qn = Math.hypot(...vector) || 1;
      const scored: VectorMatch[] = [];
      for (const [id, values] of s) {
        let dot = 0,
          vn = 0;
        for (let i = 0; i < values.length; i++) {
          dot += values[i] * (vector[i] ?? 0);
          vn += values[i] * values[i];
        }
        scored.push({ id, score: dot / (qn * (Math.sqrt(vn) || 1)) });
      }
      return scored.sort((a, b) => b.score - a.score).slice(0, topK);
    },
    size(ns) {
      return ns
        ? (spaces.get(ns)?.size ?? 0)
        : [...spaces.values()].reduce((n, s) => n + s.size, 0);
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Cloudflare implementations (bound when deployed; not provisioned yet)                       */

/** The part of the Workers AI binding the embedder uses. */
export type WorkersAi = {
  run(model: string, input: { text: string[] }): Promise<unknown>;
};
/**
 * Workers AI `bge-m3`: multilingual, 1,024 dimensions. Cloudflare doesn't version the model, so
 * `version` is ours: raise it when the model's output changes, and the workspace re-embeds.
 */
export function workersAiEmbedder(ai: WorkersAi, version = "1"): EmbeddingPort {
  const model = "@cf/baai/bge-m3";
  return {
    model,
    version,
    dimensions: 1024,
    maxBatch: 100,
    async embed(texts) {
      const out = (await ai.run(model, { text: texts })) as {
        data?: number[][];
      };
      assert(
        Array.isArray(out.data) && out.data.length === texts.length,
        "EMBEDDING_UNAVAILABLE",
        "The embedding model returned an unexpected answer.",
        503,
      );
      return out.data;
    },
  };
}
/** The part of a Vectorize index binding the store uses. */
export type VectorizeIndex = {
  upsert(
    vectors: { id: string; values: number[]; namespace?: string }[],
  ): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
  query(
    vector: number[],
    options: { topK: number; namespace?: string; returnValues?: boolean },
  ): Promise<{ matches: { id: string; score: number }[] }>;
};
/**
 * Cloudflare Vectorize, cosine metric. Vector ids are unique across namespaces (each includes its
 * index version), so removing by id is safe. One Vectorize index has one dimension count: a model
 * with different dimensions needs its own index binding (TODO(phase 17): provisioning).
 */
export function vectorizeStore(index: VectorizeIndex): VectorStorePort {
  const inBatches = async <T>(
    items: T[],
    size: number,
    f: (b: T[]) => Promise<unknown>,
  ) => {
    for (let i = 0; i < items.length; i += size)
      await f(items.slice(i, i + size));
  };
  return {
    upsert: (namespace, items) =>
      inBatches(items, 1000, (b) =>
        index.upsert(b.map((item) => ({ ...item, namespace }))),
      ),
    remove: (_namespace, ids) =>
      inBatches(ids, 1000, (b) => index.deleteByIds(b)),
    async query(namespace, vector, topK) {
      const result = await index.query(vector, {
        topK: Math.min(topK, 100),
        namespace,
        returnValues: false,
      });
      return result.matches.map((m) => ({ id: m.id, score: m.score }));
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Chunking                                                                                    */

/** About 300 tokens a chunk: long enough to answer from, short enough to rank precisely. */
export const CHUNK_TARGET = 1200;
const CHUNK_MAX = 1600;
const CHUNK_MIN = 200;
export type Chunk = { heading: string; text: string };

/** Splits a passage that is longer than a chunk at sentence ends, or hard at worst. */
function splitLong(text: string): string[] {
  if (text.length <= CHUNK_MAX) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > CHUNK_MAX) {
    const window = rest.slice(0, CHUNK_TARGET + 200);
    const cut = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("? "),
      window.lastIndexOf("! "),
      window.lastIndexOf("\n"),
    );
    const at = cut > CHUNK_MIN ? cut + 1 : CHUNK_TARGET;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}
/** Packs a section's passages into chunks near the target size, never splitting a passage. */
function pack(heading: string, passages: string[]): Chunk[] {
  const chunks: Chunk[] = [];
  let current = "";
  for (const passage of passages.flatMap(splitLong)) {
    if (current && current.length + passage.length + 2 > CHUNK_TARGET) {
      chunks.push({ heading, text: current });
      current = "";
    }
    current = current ? current + "\n\n" + passage : passage;
  }
  if (current) {
    const last = chunks.at(-1);
    // A short tail joins the chunk before it when that stays under the maximum.
    if (
      last &&
      current.length < CHUNK_MIN &&
      last.text.length + current.length + 2 <= CHUNK_MAX
    )
      last.text += "\n\n" + current;
    else chunks.push({ heading, text: current });
  }
  return chunks;
}
/**
 * One locale's chunks, in order. Articles split at their headings, each chunk carrying its
 * heading path ("Refunds › Card payments"); files and synced pages (text only) split into
 * paragraphs. Repeated text within a locale is kept once.
 */
export function chunkLocale(body: RichDoc | null, text: string): Chunk[] {
  const sections: { heading: string; passages: string[] }[] = [];
  if (body?.content?.length) {
    const path: string[] = [];
    let current = { heading: "", passages: [] as string[] };
    sections.push(current);
    for (const block of body.content as RichBlock[]) {
      if (block.type === "heading") {
        const title = plainText({ type: "doc", content: [block] });
        const depth = block.attrs.level - 2;
        path.length = Math.min(path.length, depth);
        path[depth] = title;
        current = { heading: path.filter(Boolean).join(" › "), passages: [] };
        sections.push(current);
        continue;
      }
      const passage = plainText({ type: "doc", content: [block] }).trim();
      if (passage && !/^\[(Image|Video)[^\]]*\]$/.test(passage))
        current.passages.push(passage);
    }
  } else {
    sections.push({
      heading: "",
      passages: text
        .split(/\n\s*\n/)
        .map((p) => p.replace(/[ \t]+/g, " ").trim())
        .filter(Boolean),
    });
  }
  const seen = new Set<string>();
  return sections
    .flatMap((s) => pack(s.heading, s.passages))
    .filter((c) => {
      const key = c.heading + "\n" + c.text;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
/** What the model reads for a chunk: the title and heading give it context on its own. */
export const embeddingText = (title: string, chunk: Chunk) =>
  [title, chunk.heading, chunk.text].filter(Boolean).join("\n");

const sha256 = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
/** A chunk's id: stable while its record, locale, heading and text are. */
export const chunkId = (record: string, locale: string, c: Chunk) =>
  sha256([record, locale, c.heading, c.text].join("\u0000"));
/** A vector's id in the store: unique across index versions, at most 64 characters. */
const vectorId = (generation: string, chunk: string) =>
  sha256(generation + ":" + chunk);

/* ------------------------------------------------------------------------------------------ */
/* Index versions and the indexing job                                                         */

type Generation = {
  id: string;
  model: string;
  model_version: string;
  dimensions: number;
  status: "building" | "active" | "retired";
  total_records: number;
  done_records: number;
  build_cursor: string | null;
  created_at: string;
  activated_at: string | null;
};
const GENERATION =
  "SELECT id,model,model_version,dimensions,status,total_records,done_records,build_cursor,created_at,activated_at FROM knowledge_index_generations";
/** Marked records indexed per job step, and records built per step of a rebuild. */
const DIRTY_BATCH = 10;
const BUILD_BATCH = 25;
/** Old vectors removed per step once a version is retired. */
const CLEANUP_BATCH = 500;

export async function indexEnabled(db: Sql, w: string) {
  return (
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='knowledge_index_v1' AND enabled",
        [w],
      )
    ).rows.length > 0
  );
}
async function requireIndex(db: Sql, w: string) {
  await requireKnowledge(db, w);
  assert(
    await indexEnabled(db, w),
    "INDEX_DISABLED",
    "The AI index is not enabled for this workspace.",
    404,
  );
}
const embedderFor = (env: IndexEnvironment, g: Generation) =>
  env.embedders.find(
    (e) => e.model === g.model && e.version === g.model_version,
  );
/** Records with at least one published locale: what an index version covers. */
const PUBLISHED_RECORDS =
  "SELECT DISTINCT record_id FROM knowledge_locales WHERE workspace_id=$1 AND status='published'";

async function newGeneration(
  db: Sql,
  w: string,
  e: EmbeddingPort,
  by: string | null,
) {
  const id = crypto.randomUUID();
  const total = Number(
    (
      await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM (${PUBLISHED_RECORDS}) p`,
        [w],
      )
    ).rows[0].n,
  );
  await db.query(
    "INSERT INTO knowledge_index_generations(workspace_id,id,model,model_version,dimensions,status,total_records,created_by) VALUES($1,$2,$3,$4,$5,'building',$6,$7)",
    [w, id, e.model, e.version, e.dimensions, total, by],
  );
  return id;
}

/**
 * Brings one record up to date in the given index versions: re-chunks its published locales,
 * embeds chunks a version doesn't have yet, and removes vectors for chunks that are gone. A
 * vector is written before the row that records it, and removed before that row, so a failure
 * at any point is repaired by the retry: no vector is ever left without a row to find it by.
 */
async function indexRecord(
  connect: Connect,
  env: IndexEnvironment,
  w: string,
  recordId: string,
  generations: Generation[],
) {
  const { plans: work, marked } = await tenant(connect, w, async (db) => {
    const marked = (
      await db.query<{ marked_at: string }>(
        "SELECT marked_at::text FROM knowledge_index_dirty WHERE workspace_id=$1 AND record_id=$2",
        [w, recordId],
      )
    ).rows[0]?.marked_at;
    const locales = (
      await db.query<{
        locale: string;
        published_title: string | null;
        published_body: RichDoc | null;
        published_text: string | null;
      }>(
        "SELECT locale,published_title,published_body,published_text FROM knowledge_locales WHERE workspace_id=$1 AND record_id=$2 AND status='published' ORDER BY locale",
        [w, recordId],
      )
    ).rows;
    const chunks: {
      id: string;
      locale: string;
      position: number;
      heading: string;
      text: string;
      input: string;
    }[] = [];
    for (const l of locales) {
      const title = l.published_title ?? "";
      for (const [position, c] of chunkLocale(
        l.published_body,
        l.published_text ?? "",
      ).entries())
        chunks.push({
          id: await chunkId(recordId, l.locale, c),
          locale: l.locale,
          position,
          heading: c.heading,
          text: c.text,
          input: embeddingText(title, c),
        });
    }
    await db.query(
      "DELETE FROM knowledge_chunks WHERE workspace_id=$1 AND record_id=$2",
      [w, recordId],
    );
    if (chunks.length)
      await db.query(
        `INSERT INTO knowledge_chunks(workspace_id,record_id,locale,position,chunk_id,heading,text)
         SELECT $1,$2,x.locale,x.position,x.chunk_id,x.heading,x.text
         FROM unnest($3::text[],$4::int[],$5::text[],$6::text[],$7::text[]) AS x(locale,position,chunk_id,heading,text)`,
        [
          w,
          recordId,
          chunks.map((c) => c.locale),
          chunks.map((c) => c.position),
          chunks.map((c) => c.id),
          chunks.map((c) => c.heading),
          chunks.map((c) => c.text),
        ],
      );
    const current = new Set(chunks.map((c) => c.id));
    const plans = [];
    for (const g of generations) {
      const have = (
        await db.query<{ chunk_id: string; vector_id: string }>(
          "SELECT chunk_id,vector_id FROM knowledge_chunk_vectors WHERE workspace_id=$1 AND generation_id=$2 AND record_id=$3",
          [w, g.id, recordId],
        )
      ).rows;
      const stale = have.filter((h) => !current.has(h.chunk_id));
      const held = new Set(have.map((h) => h.chunk_id));
      plans.push({
        g,
        missing: chunks.filter((c) => !held.has(c.id)),
        stale,
      });
    }
    return { plans, marked };
  });
  for (const { g, missing, stale } of work) {
    const embedder = embedderFor(env, g)!;
    for (let i = 0; i < missing.length; i += embedder.maxBatch) {
      const batch = missing.slice(i, i + embedder.maxBatch);
      const vectors = await embedder.embed(batch.map((c) => c.input));
      const ids = await Promise.all(batch.map((c) => vectorId(g.id, c.id)));
      await env.vectors.upsert(
        g.id,
        batch.map((_, j) => ({ id: ids[j], values: vectors[j] })),
      );
      await tenant(connect, w, (db) =>
        db.query(
          `INSERT INTO knowledge_chunk_vectors(workspace_id,generation_id,chunk_id,record_id,vector_id)
           SELECT $1,$2,x.chunk_id,$3,x.vector_id FROM unnest($4::text[],$5::text[]) AS x(chunk_id,vector_id)
           WHERE EXISTS(SELECT 1 FROM knowledge_index_generations g WHERE g.workspace_id=$1 AND g.id=$2 AND g.status<>'retired')
           ON CONFLICT DO NOTHING`,
          [w, g.id, recordId, batch.map((c) => c.id), ids],
        ),
      );
    }
    // Gone chunks: their rows match no chunk any more, so they're never served; the vector goes
    // first and the row after, so a failure leaves the row to try again, never a lost vector.
    if (stale.length) {
      await env.vectors.remove(
        g.id,
        stale.map((x) => x.vector_id),
      );
      await tenant(connect, w, (db) =>
        db.query(
          "DELETE FROM knowledge_chunk_vectors WHERE workspace_id=$1 AND generation_id=$2 AND chunk_id=ANY($3::text[])",
          [w, g.id, stale.map((x) => x.chunk_id)],
        ),
      );
    }
  }
  // Cleared only once indexed (a failed embedding leaves it for the retry), and only if no change
  // arrived meanwhile (that change moved `marked_at`, and is indexed next).
  if (marked)
    await tenant(connect, w, (db) =>
      db.query(
        "DELETE FROM knowledge_index_dirty WHERE workspace_id=$1 AND record_id=$2 AND marked_at::text=$3",
        [w, recordId, marked],
      ),
    );
}

/**
 * The `knowledge.index` job. Each step does one of these, in order, and asks to run again while
 * work remains: index a batch of marked records into every live version; build a batch of a new
 * version (switching to it when complete); remove a batch of a retired version's vectors.
 */
export async function runIndex(
  connect: Connect,
  env: IndexEnvironment,
  job: Job,
): Promise<{ done: boolean; result: Record<string, unknown> }> {
  const w = job.workspace_id;
  const state = await tenant(connect, w, async (db) => {
    if (!(await indexEnabled(db, w))) return null;
    let live = (
      await db.query<Generation>(
        `${GENERATION} WHERE workspace_id=$1 AND status<>'retired' ORDER BY created_at`,
        [w],
      )
    ).rows;
    // The first run creates the first version with the default model.
    if (!live.length) {
      await newGeneration(db, w, env.embedders[0], null);
      live = (
        await db.query<Generation>(
          `${GENERATION} WHERE workspace_id=$1 AND status<>'retired'`,
          [w],
        )
      ).rows;
    }
    const dirty = (
      await db.query<{ record_id: string }>(
        "SELECT record_id FROM knowledge_index_dirty WHERE workspace_id=$1 ORDER BY marked_at,record_id LIMIT $2",
        [w, DIRTY_BATCH],
      )
    ).rows.map((r) => r.record_id);
    const retired = (
      await db.query<{ generation_id: string }>(
        `SELECT v.generation_id FROM knowledge_chunk_vectors v JOIN knowledge_index_generations g ON g.workspace_id=v.workspace_id AND g.id=v.generation_id
         WHERE v.workspace_id=$1 AND g.status='retired' LIMIT 1`,
        [w],
      )
    ).rows[0]?.generation_id;
    return { live, dirty, retired };
  });
  if (!state) return { done: true, result: { skipped: "disabled" } };
  const usable = state.live.filter((g) => embedderFor(env, g));
  assert(
    usable.length === state.live.length,
    "INDEX_MODEL_UNAVAILABLE",
    "An index version uses a model this deployment cannot run.",
    503,
  );

  // 1. Changed records, into every live version (so a rebuild never misses an edit).
  if (state.dirty.length) {
    for (const id of state.dirty)
      await indexRecord(connect, env, w, id, usable);
    return { done: false, result: { indexed: state.dirty.length } };
  }

  // 2. A version being built: the next batch of records, then the switch.
  const building = usable.find((g) => g.status === "building");
  if (building) {
    const next = await tenant(connect, w, async (db) =>
      (
        await db.query<{ record_id: string }>(
          `SELECT record_id FROM (${PUBLISHED_RECORDS}) p WHERE $2::text IS NULL OR record_id>$2 ORDER BY record_id LIMIT $3`,
          [w, building.build_cursor, BUILD_BATCH],
        )
      ).rows.map((r) => r.record_id),
    );
    for (const id of next) await indexRecord(connect, env, w, id, [building]);
    if (next.length) {
      await tenant(connect, w, (db) =>
        db.query(
          "UPDATE knowledge_index_generations SET build_cursor=$3,done_records=done_records+$4 WHERE workspace_id=$1 AND id=$2 AND status='building'",
          [w, building.id, next.at(-1), next.length],
        ),
      );
      return { done: false, result: { built: next.length } };
    }
    // Complete: one transaction retires the old version and activates the new one, so every
    // search reads exactly one complete version.
    await tenant(connect, w, async (db) => {
      await db.query(
        "UPDATE knowledge_index_generations SET status='retired',retired_at=now() WHERE workspace_id=$1 AND status='active'",
        [w],
      );
      await db.query(
        "UPDATE knowledge_index_generations SET status='active',activated_at=now() WHERE workspace_id=$1 AND id=$2 AND status='building'",
        [w, building.id],
      );
    });
    return { done: false, result: { activated: building.id } };
  }

  // 3. A retired version's vectors, removed in batches.
  if (state.retired) {
    const rows = await tenant(
      connect,
      w,
      async (db) =>
        (
          await db.query<{ chunk_id: string; vector_id: string }>(
            "DELETE FROM knowledge_chunk_vectors WHERE workspace_id=$1 AND generation_id=$2 AND chunk_id IN (SELECT chunk_id FROM knowledge_chunk_vectors WHERE workspace_id=$1 AND generation_id=$2 LIMIT $3) RETURNING chunk_id,vector_id",
            [w, state.retired, CLEANUP_BATCH],
          )
        ).rows,
    );
    await env.vectors.remove(
      state.retired!,
      rows.map((r) => r.vector_id),
    );
    return { done: false, result: { removed: rows.length } };
  }
  return { done: true, result: { idle: true } };
}

/**
 * Starts the indexing job when there is work and none is queued or running: records marked
 * since the last run, a version being built, a retired version's vectors, or a workspace with
 * published content and no index yet. Run by the scheduled sweep; safe to call often.
 */
export async function scheduleIndex(connect: Connect, w: string) {
  return tenant(connect, w, async (db) => {
    if (!(await indexEnabled(db, w))) return null;
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "knowledge.index:" + w,
    ]);
    const { work, running } = (
      await db.query<{ work: boolean; running: boolean }>(
        `SELECT (EXISTS(SELECT 1 FROM knowledge_index_dirty WHERE workspace_id=$1)
           OR EXISTS(SELECT 1 FROM knowledge_index_generations WHERE workspace_id=$1 AND status='building')
           OR EXISTS(SELECT 1 FROM knowledge_chunk_vectors v JOIN knowledge_index_generations g ON g.workspace_id=v.workspace_id AND g.id=v.generation_id WHERE v.workspace_id=$1 AND g.status='retired')
           OR (NOT EXISTS(SELECT 1 FROM knowledge_index_generations WHERE workspace_id=$1) AND EXISTS(${PUBLISHED_RECORDS})))
          AS work,
          EXISTS(SELECT 1 FROM jobs WHERE workspace_id=$1 AND kind='knowledge.index' AND state IN ('queued','running')) AS running`,
        [w],
      )
    ).rows[0];
    if (!work || running) return null;
    return enqueueJob(db, w, "knowledge.index", {}, {});
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Status, rebuild and retrieval                                                               */

/** The AI index page: the active version, a rebuild in progress, and what waits. */
export async function indexStatus(
  db: Sql,
  w: string,
  principal: string,
  env: IndexEnvironment | undefined,
) {
  await manager(db, w, principal);
  await requireIndex(db, w);
  const generations = (
    await db.query<Generation & { chunks: string; records: string }>(
      `SELECT g.id,g.model,g.model_version,g.dimensions,g.status,g.total_records,g.done_records,g.created_at,g.activated_at,
        (SELECT count(*) FROM knowledge_chunk_vectors v WHERE v.workspace_id=g.workspace_id AND v.generation_id=g.id)::text AS chunks,
        (SELECT count(DISTINCT record_id) FROM knowledge_chunk_vectors v WHERE v.workspace_id=g.workspace_id AND v.generation_id=g.id)::text AS records
       FROM knowledge_index_generations g WHERE g.workspace_id=$1 AND g.status<>'retired'`,
      [w],
    )
  ).rows;
  const view = (g: (typeof generations)[number] | undefined) =>
    g && {
      id: g.id,
      model: g.model,
      version: g.model_version,
      dimensions: g.dimensions,
      chunks: Number(g.chunks),
      records: Number(g.records),
      done: g.done_records,
      total: Math.max(g.total_records, g.done_records),
      startedAt: g.created_at,
      activatedAt: g.activated_at,
    };
  const pending = Number(
    (
      await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM knowledge_index_dirty WHERE workspace_id=$1",
        [w],
      )
    ).rows[0].n,
  );
  const job = (
    await db.query<{ state: string; last_error: string | null }>(
      "SELECT state,last_error FROM jobs WHERE workspace_id=$1 AND kind='knowledge.index' ORDER BY created_at DESC LIMIT 1",
      [w],
    )
  ).rows[0];
  const latest = env?.embedders[0];
  return {
    available: !!env,
    active: view(generations.find((g) => g.status === "active")) ?? null,
    building: view(generations.find((g) => g.status === "building")) ?? null,
    pending,
    job: job ? { state: job.state, error: job.last_error } : null,
    model: latest
      ? {
          model: latest.model,
          version: latest.version,
          dimensions: latest.dimensions,
        }
      : null,
  };
}

/** Re-embeds everything with the current model, beside the active version (no downtime). */
export async function rebuildIndex(
  db: Sql,
  w: string,
  principal: string,
  env: IndexEnvironment | undefined,
) {
  const t = await manager(db, w, principal);
  await requireIndex(db, w);
  assert(env, "INDEX_UNAVAILABLE", "The AI index is unavailable here.", 503);
  assert(
    !(
      await db.query(
        "SELECT 1 FROM knowledge_index_generations WHERE workspace_id=$1 AND status='building'",
        [w],
      )
    ).rows.length,
    "INDEX_BUILDING",
    "A re-embed is already running. It switches over when it finishes.",
    409,
  );
  const generationId = await newGeneration(db, w, env.embedders[0], t.id);
  const queued = (
    await db.query<{ id: string }>(
      "SELECT id FROM jobs WHERE workspace_id=$1 AND kind='knowledge.index' AND state IN ('queued','running') LIMIT 1",
      [w],
    )
  ).rows[0]?.id;
  const jobId =
    queued ??
    (await enqueueJob(db, w, "knowledge.index", {}, { teammateId: t.id }));
  return { generationId, jobId };
}

export type RetrievalPurpose = "ai" | "inbox";
export type Retrieved = {
  recordId: string;
  title: string;
  locale: string;
  source: string;
  heading: string;
  text: string;
  score: number;
};
/** At most this many passages from one record, so one long article can't crowd out the rest. */
const PER_RECORD = 2;

/**
 * Searches the active index version by meaning. `ai` sees what is switched on for the AI agent
 * with a customer-facing audience (signed-in only content when the customer is signed in);
 * `inbox` sees what is available in the inbox, internal content included. Access comes from
 * PostgreSQL at query time. Each record found is counted for the health report unless `log` is
 * false (a teammate trying a question).
 */
export async function retrieveKnowledge(
  connect: Connect,
  env: IndexEnvironment,
  w: string,
  options: {
    query: string;
    purpose: RetrievalPurpose;
    signedIn?: boolean;
    limit?: number;
    log?: boolean;
  },
): Promise<{ ready: boolean; model?: string; results: Retrieved[] }> {
  const query = options.query.trim().slice(0, 1000);
  const limit = Math.min(Math.max(options.limit ?? 5, 1), 20);
  const active = await tenant(connect, w, async (db) => {
    await requireIndex(db, w);
    return (
      await db.query<Generation>(
        `${GENERATION} WHERE workspace_id=$1 AND status='active'`,
        [w],
      )
    ).rows[0];
  });
  if (!active || !query) return { ready: !!active, results: [] };
  const embedder = embedderFor(env, active);
  assert(
    embedder,
    "INDEX_MODEL_UNAVAILABLE",
    "The AI index's model is unavailable here.",
    503,
  );
  const [vector] = await embedder.embed([query]);
  const matches = await env.vectors.query(active.id, vector, limit * 6);
  if (!matches.length) return { ready: true, model: active.model, results: [] };
  const score = new Map(matches.map((m) => [m.id, m.score]));
  const rows = await tenant(connect, w, async (db) => {
    const found = (
      await db.query<{
        vector_id: string;
        record_id: string;
        locale: string;
        heading: string;
        text: string;
        title: string | null;
        source: string;
      }>(
        `SELECT v.vector_id,c.record_id,c.locale,c.heading,c.text,l.published_title AS title,r.source
         FROM knowledge_chunk_vectors v
         JOIN knowledge_chunks c ON c.workspace_id=v.workspace_id AND c.chunk_id=v.chunk_id
         JOIN knowledge_locales l ON l.workspace_id=c.workspace_id AND l.record_id=c.record_id AND l.locale=c.locale AND l.status='published'
         JOIN knowledge_records r ON r.workspace_id=c.workspace_id AND r.id=c.record_id
         WHERE v.workspace_id=$1 AND v.generation_id=$2 AND v.vector_id=ANY($3::text[])
           AND CASE WHEN $4='ai' THEN r.for_ai AND (r.audience='public' OR (r.audience='signed_in' AND $5::boolean))
                    ELSE r.for_inbox END`,
        [
          w,
          active.id,
          matches.map((m) => m.id),
          options.purpose,
          !!options.signedIn,
        ],
      )
    ).rows;
    return found;
  });
  const perRecord = new Map<string, number>();
  const results: Retrieved[] = [];
  for (const r of rows.sort(
    (a, b) => (score.get(b.vector_id) ?? 0) - (score.get(a.vector_id) ?? 0),
  )) {
    const n = perRecord.get(r.record_id) ?? 0;
    if (n >= PER_RECORD) continue;
    perRecord.set(r.record_id, n + 1);
    results.push({
      recordId: r.record_id,
      title: r.title ?? "",
      locale: r.locale,
      source: r.source,
      heading: r.heading,
      text: r.text,
      score: Math.round((score.get(r.vector_id) ?? 0) * 1000) / 1000,
    });
    if (results.length >= limit) break;
  }
  if (options.log !== false && results.length)
    await tenant(connect, w, (db) =>
      db.query(
        `INSERT INTO knowledge_retrievals(workspace_id,record_id,day,purpose,count)
         SELECT $1,x,(now() AT TIME ZONE 'UTC')::date,$3,1 FROM unnest($2::text[]) x
         ON CONFLICT(workspace_id,record_id,day,purpose) DO UPDATE SET count=knowledge_retrievals.count+1`,
        [w, [...new Set(results.map((r) => r.recordId))], options.purpose],
      ),
    );
  return { ready: true, model: active.model, results };
}

/** "Try a question" in the AI index page: what the AI agent or the inbox would find. */
export async function tryRetrieval(
  connect: Connect,
  env: IndexEnvironment | undefined,
  w: string,
  principal: string,
  query: string,
  purpose: string,
) {
  await tenant(connect, w, async (db) => {
    await authorize(db, w, principal, "conversations.read");
    await requireIndex(db, w);
  });
  assert(env, "INDEX_UNAVAILABLE", "The AI index is unavailable here.", 503);
  assert(
    purpose === "ai" || purpose === "inbox",
    "INVALID_PURPOSE",
    "Choose the AI agent or the inbox.",
  );
  return retrieveKnowledge(connect, env, w, {
    query,
    purpose,
    // Shown as for a signed-in customer, so nothing the AI agent might use is hidden.
    signedIn: true,
    limit: 8,
    log: false,
  });
}
