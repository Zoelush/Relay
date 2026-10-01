# Phase 07, step C1b: website sync

Branch `phase-07/step-c1b`. Plan: `docs/KNOWLEDGE_PLAN.md`. Approved on 1 October 2026 ("Yes, go ahead with all four"):
1. **Fetching safety:** public `https://` addresses only, checked again after every redirect. Limits: 5 redirects, 5 MB a page, 15 seconds, 2,000 pages a source, the start address's host only. Tests reach their own site through an explicit allowance.
2. **Stripping page parts:** a small selector syntax of our own, with no new dependency.
3. **Who can use the pages:** set per source, applied to every page. A new source starts internal and for the inbox.
4. **JavaScript rendering:** behind a `PageRenderer` interface and refused until a renderer exists (TODO phase 17). Outside tools get a `SourceAdapter` interface, with the website as its first implementation.

## What it does

**Websites in Knowledge.** For `knowledge.manage`, a new **Websites** tab, behind the new `knowledge_sync_v1` flag (off by default; the local relay turns it on).
- **Adding a site:** by its start address or a sitemap address, with:
  - a language
  - addresses to leave out (`/blog/*`, or `help.example.com/fr/*`; `*` matches anything)
  - page parts to leave out (`nav`, `#footer`, `.cookie-banner`, `div[role=dialog]`)
  - whether it needs JavaScript
  - who can use its pages
- **Per site:** its state and its pages, each with a reason when it wasn't synced. You can sync now, pause and resume, change settings, or remove it.

**A sync** (`server/knowledge-sync.ts`) is a resumable background job (`knowledge.sync.run`):
1. **Robots rules:** it reads `robots.txt` once per run (RFC 9309).
   - It follows the RelayBot group, or `*`; the longest rule wins, with Allow winning ties.
   - A missing `robots.txt` allows everything; a server error fails the run, so nothing is fetched.
2. **Seeding:** it starts from the start address plus the sitemap's pages. The sitemap is the one given, else those `robots.txt` names, else `/sitemap.xml`; sitemap indexes are followed one level.
3. **Batches:** it fetches five pages a batch, well inside the job's lease. Each batch continues as the same job, which survives restarts.
4. **Links:** it follows links on the same host. It never queues files that aren't pages, excluded addresses, or other sites.
5. **Re-reading pages:** it asks only for changed pages (`If-None-Match` / `If-Modified-Since`). It skips a page whose text hash hasn't changed, and respects `noindex` and `nofollow`.

**Pages become records** of the existing synced-page kind (`external_page`):
- **Identity:** keyed by the cleaned-up address (fragment and tracking parameters removed, parameters sorted).
- **Content:** the text without scripts, styles, navigation from the selectors you give, and so on, with the page's title and language.
- **Search:** pages are indexed for search, so Knowledge search finds them by their content.
- **Changes:** a changed page publishes a new revision; an unchanged page isn't touched.
- **Read-only:** the record view shows the page's address, its website, when it was last read and an excerpt. There's no editor, and no per-page settings: settings belong to the website.
- **A teammate's own unpublish or archive stands.** The sync only brings back what it removed itself.

**Removals:**
- A page answering 404 or 410 is archived at once.
- A page missing from two complete runs (no longer linked or in the sitemap) is archived. A run that hits the 2,000-page limit doesn't count missing pages.
- Removing a source archives all its pages. Records are never deleted.

**Schedule:**
- **When:** the existing sweep (Worker cron, and the local relay once a minute) starts runs for sources that are due, one run per source at a time.
- **How often:** weekly; every 14 days for sites over 1,000 pages or needing JavaScript. A failed run tries again in a day.

**Fetching safety** (`server/safe-fetch.ts`):
- **Refused addresses:** credentials; IP literals (v4 and v6); single-label names and private-use names (`localhost`, `.local`, `.internal`, `.home.arpa`…); non-default ports; `http:`.
- **Redirects:** followed by hand and each one checked again (so a redirect to `169.254.169.254` is refused), up to 5.
- **Size and time:** bodies over 5 MB are cut off and the page fails; a fetch has 15 seconds.
- **User agent:** `RelayBot/1.0 (Relay knowledge sync)`.
- **The test allowance:** `allowHosts` (exact `host:port`, tests and local only) is the only way to reach loopback.

**Interfaces for later:**
- **`PageRenderer`:** used when a source needs JavaScript; refused with an explanation until one is configured.
- **`SourceAdapter`:** where a run starts, and what one item is. The website is the first implementation; Zendesk, Notion, Confluence and Guru are TODOs.

**API:**
- `GET /v1/agent/knowledge-sources`
- `GET /v1/agent/knowledge-source?id=`
- `POST /v1/agent/knowledge-sources`: `create`, `update`, `sync`, `pause`, `resume`, `remove`, idempotent on the request key, needing `knowledge.manage`

The Knowledge list returns `sync` (whether to offer the tab), and a synced page's record returns `page`.

## Migration

`db/postgres/0034_knowledge_sync.sql` is additive, with row-level security on each table:
- the `knowledge_sync_v1` flag row for existing workspaces
- `knowledge_sources`
- `knowledge_sync_runs` (one running run per source; the run keeps the `robots.txt` it read)
- `knowledge_sync_frontier` (ordered by when each address was found, since the runtime role can't use sequences)
- `knowledge_source_pages` (address, record, ETag, Last-Modified, text hash, last read, missed runs, state and reason)

The rollback is a no-op: synced pages stay as published records.

## Tests

**`tests/knowledge-sync.test.ts`:**
- **Fetch safety:**
  - 14 refused addresses; the test allowance, exact port only
  - a redirect to a metadata address refused; a redirect loop stopped
  - the size cap; the time limit; a good redirect followed
- **Reading the web:**
  - address cleaning
  - exclusion patterns
  - `robots.txt` (group choice, longest match, Allow on ties, `*` and `$`, empty Disallow)
  - sitemap indexes, unsupported selectors refused
  - page text with stripped parts, title, language, canonical address and `nofollow` links
- **The full flow** through the agent bridge against a local test site:
  - off by default; managers only; private addresses, JavaScript without a renderer, bad selectors and internal content for the AI agent all refused
  - the first run: sitemap-only page found; `robots.txt`-disallowed and `noindex` pages skipped and never fetched; excluded, non-page and other-site links never fetched; tracking parameters dropped; navigation and cookie banner stripped
  - records found by content, read-only, and access changed for every page at once
  - a second run: a changed page republished (revision 2), a 404 archived, the unchanged home page not republished, a missing page kept
  - a third run: the missing page archived, and the unchanged page answered with 304
  - pause and resume; the schedule starts a due source once, and the next run is 7 days out
  - a `robots.txt` server error fails the run with only `robots.txt` fetched, keeping the pages, next try in a day
  - another workspace can't list, read, sync or remove
  - removing archives every page and keeps the records
  - with a renderer, a JavaScript site is read through it and refreshed every 14 days

**`tests/browser/knowledge-sync.spec.ts`** (ports 8950/8951):
- **Happy path:**
  - add a site with an exclusion and stripped parts, and watch the list follow the sync to "4 pages"
  - every page's state and reason
  - find a page by a word inside it, open it read-only with its address and no editor or settings
  - change the site, Sync now, and the new text is found while the old isn't
- **Failure path:**
  - `robots.txt` answering 503: the run fails with the reason shown and only `robots.txt` fetched
  - a `localhost` address is refused with an explanation

## Notes

- **Deferred:**
  - **JavaScript rendering** needs Cloudflare Browser Rendering (TODO phase 17).
  - **Outside tools** are TODOs for phase 07 follow-ups.
  - **Chunking and embedding** synced pages comes with C2.
- **Not supported yet:**
  - gzipped sitemaps (`.xml.gz`)
  - `Crawl-delay` (one fetch at a time per run already keeps the load low)
  - subdomains of the start host (add them as separate sources)
  - changing a source's start address (create a new source; page ids stay stable)
- **Selectors to strip** cover tag, `#id`, `.class` and `[attribute]` / `[attribute=value]`, combined. Combinators (`nav a`, `>`) and pseudo-classes are refused with an explanation.
- **A page's language** is taken from its `lang` attribute when the first sync creates the record, and kept after that.
- **Search** covers the first 50,000 characters of each page (B2's limit), as for files.

## Checks

Results on 1 October 2026:
- `npm test`: 83/83 pass.
- `npm run typecheck`: clean.
- Lint shows nothing new.
- `npm run test:e2e`: 58/58, with no "Relay API failed".
- `npm run test:postgres`: passes.
- **Checked in screenshots:** the add form, a synced site's pages with reasons, in light and dark.
