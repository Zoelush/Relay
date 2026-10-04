import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { can } from "./policy";
import { enqueueJob, type Job } from "./jobs";
import { manager, requireKnowledge, validLocale } from "./knowledge";
import { indexRecord } from "./help-search";
import { targetingChoices, validTargeting } from "./ai-targeting";
import type { Condition } from "./ai-escalation";
import { tidy } from "./knowledge-extract";
import {
  checkAddress,
  FetchRefused,
  safeFetch,
  type FetchPolicy,
} from "./safe-fetch";
import {
  excluded,
  looksLikePage,
  normalizeUrl,
  parseRobots,
  parseSelector,
  parseSitemap,
  readPage,
  robotsAllow,
  validPattern,
  type Robots,
  type Selector,
} from "./web-crawl";

/**
 * Website sync (phase 07, step C1b): a source is a website, by its start address or a sitemap,
 * crawled on a schedule (weekly; every 14 days for large or JavaScript-heavy sites) or on demand.
 * Each page becomes an `external_page` knowledge record keyed by its normalised address, with the
 * fetch time and a hash of its text; a changed page republishes its record, a page gone (404 or
 * 410) or missing from two complete runs is archived, never deleted.
 *
 * A run is a resumable background job (`knowledge.sync.run`): it reads robots.txt once, seeds a
 * frontier from the start address and sitemaps, then fetches pages in batches, following links on
 * the same host. Fetching goes through `safeFetch` (public https only).
 *
 * Who can use the pages is set on the source and applies to all of them; a new source is
 * internal and for the inbox, like an uploaded file.
 * TODO(phase 07 C2): chunk and embed synced pages like other records.
 */

/** Renders a page that needs JavaScript. TODO(phase 17): Cloudflare Browser Rendering. */
export interface PageRenderer {
  render(url: string): Promise<{ status: number; url: string; html: string }>;
}
/**
 * Where synced knowledge comes from. The website is the first; outside tools follow the same
 * shape: where a run starts, and what one item is.
 * TODO(phase 07 follow-up): Zendesk (public articles), Notion, Confluence and Guru.
 */
export interface SourceAdapter {
  kind: SourceRow["kind"];
  /** The run's first items, and what the run needs to remember (robots rules), or a failure. */
  start(
    source: SourceRow,
  ): Promise<{ seeds: string[]; robots: string } | { failure: string }>;
  fetchItem(
    source: SourceRow,
    robots: Robots,
    url: string,
    previous: PageRow | undefined,
  ): Promise<ItemResult>;
}
export type ItemResult =
  | {
      kind: "document";
      url: string;
      title: string;
      text: string;
      lang: string | null;
      etag: string | null;
      lastModified: string | null;
      links: string[];
    }
  | { kind: "unchanged"; links: string[] }
  | { kind: "gone" }
  | { kind: "skipped"; reason: string; links?: string[] }
  | { kind: "failed"; reason: string };

export type SyncEnvironment = { policy?: FetchPolicy; renderer?: PageRenderer };

export const MAX_PAGES = 2000;
// Five pages a batch: even at the 15-second limit each, well inside the job's two-minute lease.
const BATCH = 5;
const LARGE_SITE = 1000;

type SourceRow = {
  id: string;
  kind: "website";
  name: string;
  start_url: string;
  sitemap_url: string | null;
  host: string;
  locale: string;
  exclude: string[];
  strip: string[];
  render_js: boolean;
  audience: "public" | "signed_in" | "internal";
  for_ai: boolean;
  for_inbox: boolean;
  status: "active" | "paused" | "removed";
  interval_days: number;
  next_run_at: string | null;
  page_count: number;
  created_by: string;
  version: string;
  /** Z3b: who Zoe uses its pages for (no conditions: everyone who may see them). */
  ai_match: "all" | "any";
  ai_conditions: Condition[];
};
type PageRow = {
  external_id: string;
  url: string;
  record_id: string | null;
  title: string | null;
  etag: string | null;
  last_modified: string | null;
  content_hash: string | null;
  fetched_at: string | null;
  status: string;
  failure_code: string | null;
  missed_runs: number;
};
const SOURCE =
  "SELECT id,kind,name,start_url,sitemap_url,host,locale,exclude,strip,render_js,audience,for_ai,for_inbox,status,interval_days,next_run_at,page_count,created_by,version::text AS version,ai_match,ai_conditions FROM knowledge_sources";

const invalid = (message: string): never => {
  throw new DomainError("INVALID_SOURCE", message, 400);
};
export async function syncEnabled(db: Sql, w: string) {
  return (
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='knowledge_sync_v1' AND enabled",
        [w],
      )
    ).rows.length > 0
  );
}
async function requireSync(db: Sql, w: string) {
  await requireKnowledge(db, w);
  assert(
    await syncEnabled(db, w),
    "SYNC_DISABLED",
    "Website sync is not enabled for this workspace.",
    404,
  );
}
async function source(db: Sql, w: string, id: unknown, lock = false) {
  const s = (
    await db.query<SourceRow>(
      `${SOURCE} WHERE workspace_id=$1 AND id=$2 AND status<>'removed'${lock ? " FOR UPDATE" : ""}`,
      [w, String(id ?? "")],
    )
  ).rows[0];
  assert(s, "SOURCE_NOT_FOUND", "Website unavailable.", 404);
  return s;
}

/* ------------------------------------------------------------------------------------------ */
/* Settings                                                                                    */

function lines(value: unknown, max: number, what: string) {
  const list = (
    Array.isArray(value) ? value : String(value ?? "").split(/[\n,]/)
  )
    .map((v) => String(v).trim())
    .filter(Boolean);
  if (list.length > max) invalid(`Use at most ${max} ${what}.`);
  return list;
}
function settings(
  p: Record<string, unknown>,
  env: SyncEnvironment,
  current?: SourceRow,
) {
  const exclude =
    p.exclude === undefined
      ? (current?.exclude ?? [])
      : lines(p.exclude, 50, "exclusion patterns");
  if (exclude.some((x) => !validPattern(x)))
    invalid("Write each exclusion as an address or path, like /blog/*.");
  const strip =
    p.strip === undefined
      ? (current?.strip ?? [])
      : lines(p.strip, 30, "selectors");
  if (strip.some((x) => !parseSelector(x)))
    invalid(
      "Use selectors like nav, #footer, .cookie-banner or div[role=dialog]; combinators such as > and spaces are not supported.",
    );
  const renderJs =
    p.renderJs === undefined
      ? (current?.render_js ?? false)
      : p.renderJs === true;
  if (renderJs && !env.renderer)
    throw new DomainError(
      "SYNC_RENDER_UNAVAILABLE",
      "Pages that need JavaScript can't be read yet. Turn this off; most help sites work without it.",
      409,
    );
  const audience = String(p.audience ?? current?.audience ?? "internal");
  if (!["public", "signed_in", "internal"].includes(audience))
    invalid("Choose public, signed-in customers or internal.");
  const forAi =
    p.forAi === undefined ? (current?.for_ai ?? false) : p.forAi === true;
  const forInbox =
    p.forInbox === undefined
      ? (current?.for_inbox ?? true)
      : p.forInbox === true;
  if (audience === "internal" && forAi)
    invalid(
      "Internal content cannot be used by the AI agent, which answers customers.",
    );
  const name =
    p.name === undefined ? current?.name : String(p.name ?? "").trim();
  if (name !== undefined && (!name || name.length > 200))
    invalid("Give the website a name under 200 characters.");
  return {
    exclude,
    strip,
    renderJs,
    audience,
    forAi,
    forInbox,
    name,
  };
}

/**
 * Changes to sources (needs `knowledge.manage`): create (and start the first run), update
 * settings, sync (start a run now), pause, resume and remove.
 */
export async function changeSource(
  db: Sql,
  w: string,
  principal: string,
  env: SyncEnvironment,
  p: Record<string, unknown>,
) {
  const t = await manager(db, w, principal);
  await requireSync(db, w);
  switch (p.op) {
    case "create": {
      const address = String(p.url ?? "").trim();
      const normalized = normalizeUrl(address);
      if (!normalized)
        invalid("Enter the website's address, starting with https://.");
      try {
        checkAddress(normalized!, env.policy);
      } catch {
        throw new DomainError(
          "SYNC_ADDRESS",
          "Use a public https:// address. Private, local and IP addresses can't be synced.",
          400,
        );
      }
      const url = new URL(normalized!);
      // A sitemap address starts from its pages; any other address from that page.
      const sitemap = /\.xml$/i.test(url.pathname) ? normalized : null;
      const s = settings(p, env);
      const locale = validLocale(p.locale ?? "en");
      // Z3b: who Zoe uses its pages for.
      const targeting = await validTargeting(db, w, s.name ?? url.host, {
        match: p.aiMatch,
        conditions: p.aiConditions,
      });
      const id = crypto.randomUUID();
      await db.query(
        `INSERT INTO knowledge_sources(workspace_id,id,name,start_url,sitemap_url,host,locale,exclude,strip,render_js,audience,for_ai,for_inbox,created_by,next_run_at,interval_days,ai_match,ai_conditions)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15,$16,$17)`,
        [
          w,
          id,
          s.name ?? url.host,
          sitemap ? url.origin + "/" : normalized,
          sitemap,
          url.host,
          locale,
          s.exclude,
          s.strip,
          s.renderJs,
          s.audience,
          s.forAi,
          s.forInbox,
          t.id,
          s.renderJs ? 14 : 7,
          targeting.match,
          JSON.stringify(targeting.conditions),
        ],
      );
      const run = await startRun(db, w, id, "manual", t.id);
      return { id, runId: run.runId, jobId: run.jobId };
    }
    case "update": {
      const src = await source(db, w, p.id, true);
      assert(
        String(p.version) === src.version,
        "SOURCE_CONFLICT",
        "These settings changed elsewhere. Reload and try again.",
        409,
      );
      const s = settings(p, env, src);
      const targeting =
        p.aiConditions === undefined
          ? { match: src.ai_match, conditions: src.ai_conditions }
          : await validTargeting(db, w, s.name ?? src.name, {
              match: p.aiMatch,
              conditions: p.aiConditions,
            });
      await db.query(
        `UPDATE knowledge_sources SET name=$3,exclude=$4,strip=$5,render_js=$6,audience=$7,for_ai=$8,for_inbox=$9,ai_match=$10,ai_conditions=$11,
        version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
        [
          w,
          src.id,
          s.name,
          s.exclude,
          s.strip,
          s.renderJs,
          s.audience,
          s.forAi,
          s.forInbox,
          targeting.match,
          JSON.stringify(targeting.conditions),
        ],
      );
      // Who can use the pages applies to every page of the source (Z3b: Zoe's targeting too).
      const records = (
        await db.query<{ record_id: string }>(
          `UPDATE knowledge_records r SET audience=$3,for_ai=$4,for_inbox=$5,ai_match=$6,ai_conditions=$7,version=r.version+1,updated_at=now()
          FROM knowledge_source_pages g WHERE g.workspace_id=$1 AND g.source_id=$2 AND r.workspace_id=g.workspace_id AND r.id=g.record_id
          RETURNING r.id AS record_id`,
          [
            w,
            src.id,
            s.audience,
            s.forAi,
            s.forInbox,
            targeting.match,
            JSON.stringify(targeting.conditions),
          ],
        )
      ).rows;
      for (const r of records) await indexRecord(db, w, r.record_id);
      return { id: src.id, version: String(Number(src.version) + 1) };
    }
    case "sync": {
      const src = await source(db, w, p.id, true);
      assert(
        src.status === "active",
        "SOURCE_PAUSED",
        "This website is paused. Resume it to sync.",
        409,
      );
      return { id: src.id, ...(await startRun(db, w, src.id, "manual", t.id)) };
    }
    case "pause":
    case "resume": {
      const src = await source(db, w, p.id, true);
      await db.query(
        "UPDATE knowledge_sources SET status=$3,next_run_at=CASE WHEN $3='active' THEN now() ELSE next_run_at END,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [w, src.id, p.op === "pause" ? "paused" : "active"],
      );
      if (p.op === "pause") await cancelRuns(db, w, src.id);
      return { id: src.id, status: p.op === "pause" ? "paused" : "active" };
    }
    case "remove": {
      const src = await source(db, w, p.id, true);
      await cancelRuns(db, w, src.id);
      await db.query(
        "UPDATE knowledge_sources SET status='removed',version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [w, src.id],
      );
      // Its pages leave every surface; the records and their history remain.
      const records = (
        await db.query<{ record_id: string }>(
          "UPDATE knowledge_source_pages SET status='removed' WHERE workspace_id=$1 AND source_id=$2 AND record_id IS NOT NULL RETURNING record_id",
          [w, src.id],
        )
      ).rows;
      for (const r of records) await archive(db, w, r.record_id);
      return { id: src.id, removed: records.length };
    }
  }
  return invalid("Choose create, update, sync, pause, resume or remove.");
}

async function startRun(
  db: Sql,
  w: string,
  sourceId: string,
  trigger: "manual" | "schedule",
  teammateId: string,
) {
  const running = (
    await db.query<{ id: string; job_id: string }>(
      "SELECT id,job_id FROM knowledge_sync_runs WHERE workspace_id=$1 AND source_id=$2 AND status='running'",
      [w, sourceId],
    )
  ).rows[0];
  if (running) return { runId: running.id, jobId: running.job_id };
  const runId = crypto.randomUUID();
  await db.query(
    "INSERT INTO knowledge_sync_runs(workspace_id,id,source_id,trigger) VALUES($1,$2,$3,$4)",
    [w, runId, sourceId, trigger],
  );
  const jobId = await enqueueJob(
    db,
    w,
    "knowledge.sync.run",
    { runId },
    { teammateId },
  );
  await db.query(
    "UPDATE knowledge_sync_runs SET job_id=$3 WHERE workspace_id=$1 AND id=$2",
    [w, runId, jobId],
  );
  return { runId, jobId };
}
async function cancelRuns(db: Sql, w: string, sourceId: string) {
  await db.query(
    "UPDATE knowledge_sync_runs SET status='cancelled',finished_at=now() WHERE workspace_id=$1 AND source_id=$2 AND status='running'",
    [w, sourceId],
  );
}
async function archive(db: Sql, w: string, recordId: string) {
  await db.query(
    "UPDATE knowledge_locales SET status='archived' WHERE workspace_id=$1 AND record_id=$2",
    [w, recordId],
  );
  await db.query(
    "UPDATE knowledge_records SET updated_at=now() WHERE workspace_id=$1 AND id=$2",
    [w, recordId],
  );
  await indexRecord(db, w, recordId);
}

/** Starts runs for active sources that are due (the scheduled sweep calls this). */
export async function scheduleDueSyncs(connect: Connect, w: string) {
  return tenant(connect, w, async (db) => {
    if (!(await syncEnabled(db, w))) return 0;
    const due = (
      await db.query<{ id: string; created_by: string }>(
        `SELECT s.id,s.created_by FROM knowledge_sources s WHERE s.workspace_id=$1 AND s.status='active' AND s.next_run_at<=now()
        AND NOT EXISTS(SELECT 1 FROM knowledge_sync_runs r WHERE r.workspace_id=s.workspace_id AND r.source_id=s.id AND r.status='running')
        ORDER BY s.next_run_at LIMIT 20 FOR UPDATE OF s SKIP LOCKED`,
        [w],
      )
    ).rows;
    for (const s of due) await startRun(db, w, s.id, "schedule", s.created_by);
    return due.length;
  });
}

/* ------------------------------------------------------------------------------------------ */
/* The website adapter                                                                         */

const sha256 = async (text: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

export function websiteAdapter(env: SyncEnvironment): SourceAdapter {
  const policy = env.policy ?? {};
  const sameHost = (s: SourceRow, url: string) => new URL(url).host === s.host;
  return {
    kind: "website",
    async start(s) {
      const origin = new URL(s.start_url).origin;
      let robots = "";
      try {
        const r = await safeFetch(
          origin + "/robots.txt",
          policy,
          {},
          { maxBytes: 500_000 },
        );
        // RFC 9309: a missing robots.txt (4xx) allows everything; a server error, nothing.
        if (r.status === 200) robots = r.body;
        else if (r.status >= 500) return { failure: "ROBOTS_UNAVAILABLE" };
      } catch (e) {
        return {
          failure:
            e instanceof FetchRefused && e.code === "ADDRESS_NOT_ALLOWED"
              ? "ADDRESS_NOT_ALLOWED"
              : "ROBOTS_UNAVAILABLE",
        };
      }
      const rules = parseRobots(robots);
      const seeds = s.sitemap_url ? [] : [s.start_url];
      // Sitemaps: the one given, else those robots.txt names, else /sitemap.xml if there is one.
      let maps = s.sitemap_url
        ? [s.sitemap_url]
        : rules.sitemaps.length
          ? rules.sitemaps
          : [origin + "/sitemap.xml"];
      for (let depth = 0; depth < 2 && maps.length; depth++) {
        const next: string[] = [];
        for (const map of maps.slice(0, 20)) {
          const url = normalizeUrl(map);
          if (!url || !sameHost(s, url)) continue;
          try {
            const r = await safeFetch(url, policy);
            if (r.status !== 200) continue;
            const found = parseSitemap(r.body);
            seeds.push(...found.urls);
            next.push(...found.sitemaps);
          } catch {
            // A missing or unreadable sitemap leaves the crawl to follow links.
          }
        }
        maps = next;
      }
      if (s.sitemap_url && !seeds.length) return { failure: "SITEMAP_EMPTY" };
      return { seeds, robots };
    },
    async fetchItem(s, robots, url, previous) {
      if (!sameHost(s, url)) return { kind: "skipped", reason: "OTHER_SITE" };
      if (excluded(url, s.exclude))
        return { kind: "skipped", reason: "EXCLUDED" };
      if (!robotsAllow(robots, url))
        return { kind: "skipped", reason: "ROBOTS_DISALLOWED" };
      let status: number,
        finalUrl: string,
        html: string,
        headers: Headers | null = null;
      try {
        if (s.render_js && env.renderer) {
          const r = await env.renderer.render(url);
          ({ status, html } = r);
          finalUrl = r.url;
        } else {
          const r = await safeFetch(url, policy, {
            accept: "text/html,application/xhtml+xml",
            ...(previous?.etag ? { "if-none-match": previous.etag } : {}),
            ...(previous?.last_modified
              ? { "if-modified-since": previous.last_modified }
              : {}),
          });
          ({ status, body: html, headers } = r);
          finalUrl = r.url;
        }
      } catch (e) {
        return {
          kind: "failed",
          reason: e instanceof FetchRefused ? e.code : "UNREACHABLE",
        };
      }
      if (status === 304) return { kind: "unchanged", links: [] };
      if (status === 404 || status === 410) return { kind: "gone" };
      if (status !== 200) return { kind: "failed", reason: `HTTP_${status}` };
      if (!sameHost(s, finalUrl))
        return { kind: "skipped", reason: "REDIRECTED_AWAY" };
      const type = headers?.get("content-type") ?? "text/html";
      if (!/text\/html|application\/xhtml\+xml/i.test(type))
        return { kind: "skipped", reason: "NOT_HTML" };
      const strip = s.strip
        .map(parseSelector)
        .filter((x): x is Selector => !!x);
      const page = readPage(html, strip);
      const links = page.nofollow
        ? []
        : page.links
            .map((l) => normalizeUrl(l, finalUrl))
            .filter((l): l is string => !!l);
      if (page.noindex) return { kind: "skipped", reason: "NOINDEX", links };
      const { text } = tidy(page.text);
      if (!text) return { kind: "skipped", reason: "NO_TEXT", links };
      return {
        kind: "document",
        url: finalUrl,
        title: (page.title ?? new URL(finalUrl).pathname).slice(0, 300),
        text,
        lang: page.lang,
        etag: headers?.get("etag") ?? null,
        lastModified: headers?.get("last-modified") ?? null,
        links,
      };
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* The run                                                                                     */

/** One batch of a run: seeds it first, then fetches up to five pages; done when nothing is left. */
export async function runSync(
  connect: Connect,
  env: SyncEnvironment,
  job: Job,
): Promise<{ done: boolean; result: Record<string, unknown> }> {
  const w = job.workspace_id,
    runId = String(job.payload.runId);
  const adapter = websiteAdapter(env);
  const state = await tenant(connect, w, async (db) => {
    const run = (
      await db.query<{
        source_id: string;
        status: string;
        robots: string | null;
        seeded: boolean;
      }>(
        "SELECT source_id,status,robots,seeded FROM knowledge_sync_runs WHERE workspace_id=$1 AND id=$2",
        [w, runId],
      )
    ).rows[0];
    if (!run || run.status !== "running") return null;
    const src = (
      await db.query<SourceRow>(`${SOURCE} WHERE workspace_id=$1 AND id=$2`, [
        w,
        run.source_id,
      ])
    ).rows[0];
    return { run, src };
  });
  if (!state) return { done: true, result: { runId, status: "stopped" } };
  const { run, src } = state;

  if (!run.seeded) {
    const started = await adapter.start(src);
    if ("failure" in started) {
      await finish(connect, w, job, runId, src, "failed", started.failure);
      return {
        done: true,
        result: { runId, status: "failed", reason: started.failure },
      };
    }
    await withLease(connect, w, job, async (db) => {
      const seeds = [
        ...new Set(
          started.seeds
            .map((u) => normalizeUrl(u))
            .filter((u): u is string => !!u),
        ),
      ];
      await queue(db, w, runId, seeds);
      await db.query(
        "UPDATE knowledge_sync_runs SET seeded=true,robots=$3 WHERE workspace_id=$1 AND id=$2",
        [w, runId, started.robots],
      );
    });
    return { done: false, result: { runId, status: "seeded" } };
  }

  const robots = parseRobots(run.robots ?? "");
  const batch = await tenant(
    connect,
    w,
    async (db) =>
      (
        await db.query<{ url: string; page: PageRow | null }>(
          `SELECT f.url,(SELECT row_to_json(g) FROM knowledge_source_pages g WHERE g.workspace_id=f.workspace_id AND g.source_id=$3 AND g.external_id=f.url) AS page
          FROM knowledge_sync_frontier f WHERE f.workspace_id=$1 AND f.run_id=$2 AND NOT f.done ORDER BY f.added_at,f.url LIMIT ${BATCH}`,
          [w, runId, src.id],
        )
      ).rows,
  );
  if (!batch.length) {
    await finish(connect, w, job, runId, src, "succeeded", null);
    return { done: true, result: { runId, status: "succeeded" } };
  }
  for (const item of batch) {
    const result = looksLikePage(item.url)
      ? await adapter.fetchItem(src, robots, item.url, item.page ?? undefined)
      : ({ kind: "skipped", reason: "NOT_HTML" } as ItemResult);
    await withLease(connect, w, job, (db) =>
      apply(db, w, runId, src, item.url, item.page, result),
    );
  }
  return { done: false, result: { runId, status: "running" } };
}

/** Adds addresses to the run's frontier, up to the page limit. */
async function queue(db: Sql, w: string, runId: string, urls: string[]) {
  if (!urls.length) return;
  const count = Number(
    (
      await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM knowledge_sync_frontier WHERE workspace_id=$1 AND run_id=$2",
        [w, runId],
      )
    ).rows[0].n,
  );
  const room = MAX_PAGES - count;
  if (room <= 0) {
    await db.query(
      "UPDATE knowledge_sync_runs SET page_limit_reached=true WHERE workspace_id=$1 AND id=$2",
      [w, runId],
    );
    return;
  }
  const added = (
    await db.query(
      `INSERT INTO knowledge_sync_frontier(workspace_id,run_id,url) SELECT $1,$2,u FROM unnest($3::text[]) AS u
      ON CONFLICT DO NOTHING RETURNING url`,
      [w, runId, urls.slice(0, room)],
    )
  ).rows.length;
  if (urls.length > room && added)
    await db.query(
      "UPDATE knowledge_sync_runs SET page_limit_reached=true WHERE workspace_id=$1 AND id=$2",
      [w, runId],
    );
}

/** Records what one fetch found: the page row, its record, and the links to follow. */
async function apply(
  db: Sql,
  w: string,
  runId: string,
  src: SourceRow,
  url: string,
  page: PageRow | null,
  result: ItemResult,
) {
  await db.query(
    "UPDATE knowledge_sync_frontier SET done=true WHERE workspace_id=$1 AND run_id=$2 AND url=$3",
    [w, runId, url],
  );
  const links = "links" in result ? (result.links ?? []) : [];
  const follow = links.filter(
    (l) =>
      new URL(l).host === src.host &&
      looksLikePage(l) &&
      !excluded(l, src.exclude),
  );
  await queue(db, w, runId, follow);
  const count = (column: string) =>
    db.query(
      `UPDATE knowledge_sync_runs SET ${column}=${column}+1 WHERE workspace_id=$1 AND id=$2`,
      [w, runId],
    );
  const upsertPage = (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    return db.query(
      `INSERT INTO knowledge_source_pages(workspace_id,source_id,external_id,url,${keys.join(",")})
      VALUES($1,$2,$3,$4,${keys.map((_, i) => "$" + (i + 5)).join(",")})
      ON CONFLICT(workspace_id,source_id,external_id) DO UPDATE SET ${keys.map((k) => `${k}=EXCLUDED.${k}`).join(",")}`,
      [w, src.id, url, url, ...keys.map((k) => fields[k])],
    );
  };
  await count("pages_seen");
  switch (result.kind) {
    case "unchanged":
      await upsertPage({
        last_seen_run_id: runId,
        missed_runs: 0,
        fetched_at: new Date().toISOString(),
      });
      return;
    case "gone":
      if (page?.record_id && page.status === "active") {
        await archive(db, w, page.record_id);
        await count("pages_removed");
      }
      if (page)
        await upsertPage({
          status: "removed",
          failure_code: "GONE",
          last_seen_run_id: runId,
        });
      return;
    case "skipped":
    case "failed": {
      // A page that used to be synced and is now skipped (robots, noindex…) leaves too.
      if (
        result.kind === "skipped" &&
        page?.record_id &&
        page.status === "active"
      ) {
        await archive(db, w, page.record_id);
        await count("pages_removed");
      }
      if (result.kind === "failed") await count("pages_failed");
      // Failures keep a synced page as it was; it is retried next run.
      await upsertPage({
        status:
          result.kind === "failed" && page?.status === "active"
            ? "active"
            : result.kind === "failed"
              ? "failed"
              : "skipped",
        failure_code: result.reason,
        last_seen_run_id: result.kind === "failed" ? runId : null,
        ...(result.kind === "failed" ? { missed_runs: 0 } : {}),
      });
      return;
    }
    case "document": {
      const hash = await sha256(result.title + "\n" + result.text);
      const fields = {
        title: result.title,
        etag: result.etag,
        last_modified: result.lastModified,
        content_hash: hash,
        fetched_at: new Date().toISOString(),
        last_seen_run_id: runId,
        missed_runs: 0,
        status: "active",
        failure_code: null,
      };
      if (
        page?.record_id &&
        page.content_hash === hash &&
        page.status === "active"
      ) {
        await upsertPage(fields);
        return;
      }
      const recordId = page?.record_id ?? null;
      const id = await publishPage(db, w, src, recordId, result);
      await upsertPage({ ...fields, record_id: id });
      await count("pages_changed");
      return;
    }
  }
}

/** Creates or updates a page's record and publishes its text (unless a teammate archived it). */
async function publishPage(
  db: Sql,
  w: string,
  src: SourceRow,
  recordId: string | null,
  doc: Extract<ItemResult, { kind: "document" }>,
) {
  if (recordId) {
    const l = (
      await db.query<{
        locale: string;
        status: string;
        published_revision: number | null;
        archived_by_sync: boolean;
      }>(
        `SELECT l.locale,l.status,l.published_revision,
          (SELECT g.status='removed' FROM knowledge_source_pages g WHERE g.workspace_id=l.workspace_id AND g.source_id=$3 AND g.record_id=l.record_id LIMIT 1) AS archived_by_sync
        FROM knowledge_locales l WHERE l.workspace_id=$1 AND l.record_id=$2 ORDER BY l.locale LIMIT 1`,
        [w, recordId, src.id],
      )
    ).rows[0];
    // A teammate's own unpublish or archive stands; the sync only brings back what it removed.
    if (l && (l.status === "published" || l.archived_by_sync)) {
      await db.query(
        `UPDATE knowledge_locales SET status='published',draft_title=$4,published_title=$4,published_text=$5,published_body=NULL,
        published_revision=COALESCE(published_revision,0)+1,published_at=now(),published_by=$6
        WHERE workspace_id=$1 AND record_id=$2 AND locale=$3`,
        [w, recordId, l.locale, doc.title, doc.text, src.created_by],
      );
    } else if (l) {
      await db.query(
        "UPDATE knowledge_locales SET draft_title=$4,published_title=$4,published_text=$5 WHERE workspace_id=$1 AND record_id=$2 AND locale=$3",
        [w, recordId, l.locale, doc.title, doc.text],
      );
    }
    await db.query(
      "UPDATE knowledge_records SET updated_at=now() WHERE workspace_id=$1 AND id=$2",
      [w, recordId],
    );
    await indexRecord(db, w, recordId);
    return recordId;
  }
  let locale = src.locale;
  try {
    if (doc.lang) locale = validLocale(doc.lang);
  } catch {
    // An unusual lang attribute: the source's language.
  }
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO knowledge_records(workspace_id,id,source,owner_id,audience,for_ai,for_help_center,for_inbox,ai_match,ai_conditions)
    VALUES($1,$2,'external_page',$3,$4,$5,false,$6,$7,$8)`,
    [
      w,
      id,
      src.created_by,
      src.audience,
      src.for_ai,
      src.for_inbox,
      src.ai_match,
      JSON.stringify(src.ai_conditions),
    ],
  );
  await db.query(
    `INSERT INTO knowledge_locales(workspace_id,record_id,locale,status,draft_title,draft_updated_by,published_title,published_text,published_revision,published_at,published_by)
    VALUES($1,$2,$3,'published',$4,$5,$4,$6,1,now(),$5)`,
    [w, id, locale, doc.title, src.created_by, doc.text],
  );
  await indexRecord(db, w, id);
  return id;
}

/** Ends a run: removal detection (after a complete run only), the source's next run and counts. */
async function finish(
  connect: Connect,
  w: string,
  job: Job,
  runId: string,
  src: SourceRow,
  status: "succeeded" | "failed",
  failure: string | null,
) {
  await withLease(connect, w, job, async (db) => {
    const run = (
      await db.query<{ page_limit_reached: boolean }>(
        "SELECT page_limit_reached FROM knowledge_sync_runs WHERE workspace_id=$1 AND id=$2",
        [w, runId],
      )
    ).rows[0];
    if (status === "succeeded" && !run.page_limit_reached) {
      // Pages this run did not reach: archived after two complete runs without them.
      await db.query(
        `UPDATE knowledge_source_pages SET missed_runs=missed_runs+1 WHERE workspace_id=$1 AND source_id=$2 AND status='active'
        AND last_seen_run_id IS DISTINCT FROM $3`,
        [w, src.id, runId],
      );
      const gone = (
        await db.query<{ record_id: string }>(
          `UPDATE knowledge_source_pages SET status='removed',failure_code='MISSING' WHERE workspace_id=$1 AND source_id=$2 AND status='active' AND missed_runs>=2
          RETURNING record_id`,
          [w, src.id],
        )
      ).rows;
      for (const g of gone) if (g.record_id) await archive(db, w, g.record_id);
      if (gone.length)
        await db.query(
          "UPDATE knowledge_sync_runs SET pages_removed=pages_removed+$3 WHERE workspace_id=$1 AND id=$2",
          [w, runId, gone.length],
        );
    }
    const pages = Number(
      (
        await db.query<{ n: string }>(
          "SELECT count(*) AS n FROM knowledge_source_pages WHERE workspace_id=$1 AND source_id=$2 AND status='active'",
          [w, src.id],
        )
      ).rows[0].n,
    );
    await db.query(
      "UPDATE knowledge_sync_runs SET status=$3,failure_code=$4,finished_at=now() WHERE workspace_id=$1 AND id=$2 AND status='running'",
      [w, runId, status, failure],
    );
    // Weekly; every 14 days for large or JavaScript-heavy sites. A failed run tries again in a day.
    const interval = src.render_js || pages > LARGE_SITE ? 14 : 7;
    await db.query(
      `UPDATE knowledge_sources SET page_count=$3,interval_days=$4,
      next_run_at=now()+CASE WHEN $5 THEN interval '1 day' ELSE make_interval(days=>$4) END WHERE workspace_id=$1 AND id=$2`,
      [w, src.id, pages, interval, status === "failed"],
    );
    await db.query(
      "DELETE FROM knowledge_sync_frontier WHERE workspace_id=$1 AND run_id=$2",
      [w, runId],
    );
  });
}

/** Writes only while this worker still holds the job (a retried job may have moved on). */
function withLease<T>(
  connect: Connect,
  w: string,
  job: Job,
  work: (db: Sql) => Promise<T>,
) {
  return tenant(connect, w, async (db) => {
    const current = (
      await db.query<{ lease_token: string }>(
        "SELECT lease_token FROM jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [w, job.id],
      )
    ).rows[0];
    assert(
      current?.lease_token === job.lease_token,
      "STALE_JOB",
      "A newer worker owns this sync.",
      409,
    );
    return work(db);
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Reading                                                                                     */

/** The workspace's websites with their latest run (needs `knowledge.manage`). */
export async function listSources(db: Sql, w: string, principal: string) {
  await manager(db, w, principal);
  await requireSync(db, w);
  const rows = (
    await db.query<SourceRow & { run: Record<string, unknown> | null }>(
      `${SOURCE.replace("FROM knowledge_sources", ",(SELECT row_to_json(r) FROM (SELECT id,status,trigger,started_at,finished_at,pages_seen,pages_changed,pages_failed,pages_removed,failure_code,page_limit_reached FROM knowledge_sync_runs r WHERE r.workspace_id=s.workspace_id AND r.source_id=s.id ORDER BY started_at DESC LIMIT 1) r) AS run FROM knowledge_sources s")}
      WHERE workspace_id=$1 AND status<>'removed' ORDER BY name,id`,
      [w],
    )
  ).rows;
  return { sources: rows.map(view) };
}
const view = (s: SourceRow & { run?: Record<string, unknown> | null }) => ({
  id: s.id,
  name: s.name,
  url: s.sitemap_url ?? s.start_url,
  sitemap: !!s.sitemap_url,
  locale: s.locale,
  exclude: s.exclude,
  strip: s.strip,
  renderJs: s.render_js,
  audience: s.audience,
  forAi: s.for_ai,
  forInbox: s.for_inbox,
  // Z3b: who Zoe uses its pages for.
  aiMatch: s.ai_match,
  aiConditions: s.ai_conditions,
  status: s.status,
  intervalDays: s.interval_days,
  nextRunAt: s.next_run_at ? new Date(s.next_run_at).toISOString() : null,
  pageCount: s.page_count,
  version: s.version,
  run: s.run
    ? {
        id: s.run.id,
        status: s.run.status,
        trigger: s.run.trigger,
        startedAt: s.run.started_at,
        finishedAt: s.run.finished_at,
        seen: s.run.pages_seen,
        changed: s.run.pages_changed,
        failed: s.run.pages_failed,
        removed: s.run.pages_removed,
        failure: s.run.failure_code,
        pageLimitReached: s.run.page_limit_reached,
      }
    : null,
});

/** One website: settings, recent runs and its pages (the first 500, problems first). */
export async function readSource(
  db: Sql,
  w: string,
  principal: string,
  id: string,
) {
  await manager(db, w, principal);
  await requireSync(db, w);
  const s = (
    await db.query<SourceRow & { run: Record<string, unknown> | null }>(
      `${SOURCE.replace("FROM knowledge_sources", ",(SELECT row_to_json(r) FROM (SELECT id,status,trigger,started_at,finished_at,pages_seen,pages_changed,pages_failed,pages_removed,failure_code,page_limit_reached FROM knowledge_sync_runs r WHERE r.workspace_id=s.workspace_id AND r.source_id=s.id ORDER BY started_at DESC LIMIT 1) r) AS run FROM knowledge_sources s")}
      WHERE workspace_id=$1 AND id=$2 AND status<>'removed'`,
      [w, id],
    )
  ).rows[0];
  assert(s, "SOURCE_NOT_FOUND", "Website unavailable.", 404);
  const pages = (
    await db.query<{
      url: string;
      record_id: string | null;
      title: string | null;
      status: string;
      failure_code: string | null;
      fetched_at: string | null;
    }>(
      `SELECT url,record_id,title,status,failure_code,fetched_at FROM knowledge_source_pages WHERE workspace_id=$1 AND source_id=$2
      ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'skipped' THEN 1 WHEN 'removed' THEN 2 ELSE 3 END,url LIMIT 500`,
      [w, s.id],
    )
  ).rows;
  return {
    ...view(s),
    // Z3b: the names targeting conditions can refer to.
    targetingChoices: await targetingChoices(db, w),
    pages: pages.map((p) => ({
      url: p.url,
      recordId: p.record_id,
      title: p.title,
      status: p.status,
      reason: p.failure_code,
      fetchedAt: p.fetched_at ? new Date(p.fetched_at).toISOString() : null,
    })),
  };
}

/** A synced page's record: where it comes from, for the Knowledge record view. */
export async function pageSummary(db: Sql, w: string, recordId: string) {
  const p = (
    await db.query<{
      url: string;
      source_id: string;
      name: string;
      fetched_at: string | null;
      status: string;
      failure_code: string | null;
      text: string | null;
    }>(
      `SELECT g.url,g.source_id,s.name,g.fetched_at,g.status,g.failure_code,
        (SELECT left(published_text,1200) FROM knowledge_locales l WHERE l.workspace_id=g.workspace_id AND l.record_id=g.record_id ORDER BY locale LIMIT 1) AS text
      FROM knowledge_source_pages g JOIN knowledge_sources s ON s.workspace_id=g.workspace_id AND s.id=g.source_id
      WHERE g.workspace_id=$1 AND g.record_id=$2 LIMIT 1`,
      [w, recordId],
    )
  ).rows[0];
  if (!p) return null;
  return {
    url: p.url,
    sourceId: p.source_id,
    sourceName: p.name,
    fetchedAt: p.fetched_at ? new Date(p.fetched_at).toISOString() : null,
    status: p.status,
    reason: p.failure_code,
    excerpt: p.text,
  };
}
/** Whether to offer the Websites tab: the flag, and knowledge.manage. */
export async function syncAvailable(db: Sql, w: string, principal: string) {
  return (
    (await syncEnabled(db, w)) &&
    (await can(db, w, principal, "knowledge.manage"))
  );
}
