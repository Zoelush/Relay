# Phase 07 — Help center and knowledge store: plan

Branch per step, behind `knowledge_v1` (off by default). Approved on 1 October 2026 ("Yes to all four").

| Step | Scope |
|---|---|
| **A1: Knowledge store core** | One content record with a source (public article, internal article, snippet, file, synced page); per-locale versions drafted and published independently; owner, review date and audience; independent availability switches (AI agent, help center, inbox); autosave, version history and restore; a Knowledge section in the inbox with the article editor |
| **A2: Help center structure** | Help centers per brand (theme, homepage layout, default language), collections, sections, articles in several places, slugs with redirects on change, locale fallback |
| **B1: Public help center** | Server-rendered pages; SEO (canonical, hreflang, sitemap, meta and Open Graph, article and FAQ structured data, exclude from indexing); public or signed-in access; the portal mounted as a section; domains |
| **B2: Search and feedback** | Typo-tolerant, language-aware, ranked search with query logging; helpful/not helpful with a comment and a path into a conversation; the messenger's Help space switched on |
| **C1: Files and external sync** | PDF, document and text upload with text extraction (through the attachment scan); crawling a URL or sitemap on a schedule with robots rules, stable ids, content hashes and removal detection |
| **C2: Chunking, embeddings and health** | Idempotent, resumable chunking and embedding on publish and change, recording the model and version per embedding; re-embedding 10,000 records without search going offline; the content health report (gaps interface for phase 14) |

Acceptance criteria: three locales rendered by the server with correct metadata (B1); a working redirect after a slug change (A2 and B1); re-embedding 10,000 records without search going offline (C2).

## Decisions

1. **Step order:** A1 → A2 → B1 → B2 → C1 → C2.
2. **Embeddings:** behind `EmbeddingPort` and `VectorStorePort`, implemented with Cloudflare Workers AI (`bge-m3`, multilingual) and Cloudflare Vectorize; locally a deterministic test embedder and a local index. Embeddings stay out of the primary database (CLAUDE.md).
3. **Help center hosting:** like the portal: server-rendered by the Relay Worker at `/help/{workspace}/{center}`, custom domains through the domain table, certificates deferred to phase 17. React-rendered HTML with small scripts for search and feedback, working without JavaScript.
4. **Article editor:** the existing TipTap and `rich-doc` format with an article profile (headings, images with alt text, YouTube and Vimeo videos, callouts, code blocks with a language, tables, links to other records by id so they survive slug changes), validated on the server. No second format.
