# Phase 07 — Help center and knowledge store: plan

Branch per step, behind `knowledge_v1` (off by default). Approved on 1 October 2026 ("Yes to all four").

| Step | Scope |
|---|---|
| **A1: Knowledge store core** | One content record with a source (public article, internal article, snippet, file, synced page); per-locale versions drafted and published independently; owner, review date and audience; independent availability switches (AI agent, help center, inbox); autosave, version history and restore; a Knowledge section in the inbox with the article editor |
| **A2: Help center structure** | Help centers per brand (theme, homepage layout, default language), collections, sections, articles in several places, slugs with redirects on change, locale fallback |
| **B1: Public help center** | Server-rendered pages; SEO (canonical, hreflang, sitemap, meta and Open Graph, article and FAQ structured data, exclude from indexing); public or signed-in access; the portal mounted as a section; domains |
| **B2: Search and feedback** | Typo-tolerant, language-aware, ranked search with query logging; helpful/not helpful with a comment and a path into a conversation; the messenger's Help space switched on |
| **C1a: Files and images** | PDF, document and text upload with text extraction (through the attachment scan), versions and removal; article images; the help center's logo, favicon and social image |
| **C1b: Website sync** | Crawling a URL or sitemap on a schedule with robots rules, stable ids, content hashes and removal detection, behind `knowledge_sync_v1`; pages rendered through a `PageRenderer` interface; a source-adapter interface for other tools (Zendesk, Notion, Confluence and Guru each later) |
| **C2a: The AI index** | Idempotent, resumable chunking and embedding on publish and change, recording the model and version per embedding; re-embedding 10,000 records without search going offline; retrieval for phase 08 with access checked at query time; the AI index page with "Try a question" |
| **C2b: Content health** | The content health report: never reviewed, not retrieved in 90 days, near-duplicates (gaps interface for phase 14) |

Acceptance criteria: three locales rendered by the server with correct metadata (B1); a working redirect after a slug change (A2 and B1); re-embedding 10,000 records without search going offline (C2).

## Decisions

1. **Step order:** A1 → A2 → B1 → B2 → C1 (C1a, then C1b) → C2.
2. **Embeddings:** behind `EmbeddingPort` and `VectorStorePort`, implemented with Cloudflare Workers AI (`bge-m3`, multilingual) and Cloudflare Vectorize; locally a deterministic test embedder and a local index. Embeddings stay out of the primary database (CLAUDE.md).
3. **Help center hosting:** like the portal: server-rendered by the Relay Worker at `/help/{workspace}/{center}`, custom domains through the domain table, certificates deferred to phase 17. React-rendered HTML with small scripts for search and feedback, working without JavaScript.
4. **Article editor:** the existing TipTap and `rich-doc` format with an article profile (headings, images with alt text, YouTube and Vimeo videos, callouts, code blocks with a language, tables, links to other records by id so they survive slug changes), validated on the server. No second format.
5. **Step C1** (approved on 1 October 2026, "Yes to all"): split into C1a (files and images) and C1b (website sync). Text extraction uses `unpdf` (pdf.js, which runs in Workers and Node) and `htmlparser2`. C1b renders pages through a `PageRenderer` interface (Cloudflare Browser Rendering when deployed, a fake in tests) and defines only the source-adapter interface; each outside tool is its own later step.
6. **Step C1b** (approved on 1 October 2026, "Yes, go ahead with all four"):
   - public https fetching only, with redirects re-checked; limits of 5 MB, 15 seconds and 2,000 pages, on the start host only
   - our own small selector syntax for stripping page parts
   - who can use the pages set per source
   - JavaScript rendering and outside tools as interfaces only (`PageRenderer`, `SourceAdapter`)

   Handoff: `docs/KNOWLEDGE_STEP6.md`.
7. **Step C2** (approved on 3 October 2026, "Yes, go ahead with all four"): split into C2a (the AI index) and C2b (content health). Internal content is indexed too, for the inbox and the phase 10 copilot, with access checked in PostgreSQL at query time. The index page has a "Try a question" box. Near-duplicates in C2b are vector neighbours at a cosine similarity of 0.92 or more, checked nightly and on demand. Handoff for C2a: `docs/KNOWLEDGE_STEP7.md`.
8. **Step C2b** (approved on 3 October 2026, "Yes, go ahead with all four"):
   - "not retrieved in 90 days" counts from the first AI index
   - near-duplicates come from stored vectors (`VectorStorePort.get`), in a job that can resume
   - behind `knowledge_health_v1`
   - "never reviewed" only

   Handoff: `docs/KNOWLEDGE_STEP8.md`. The phase 07 plan is complete.
