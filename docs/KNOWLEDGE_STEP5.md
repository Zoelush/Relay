# Phase 07, step C1a: files and images

Branch `phase-07/step-c1a`. Plan: `docs/KNOWLEDGE_PLAN.md`. Approved on 1 October 2026 ("Yes to all"):
- step C1 split in two: C1a (files and images, this step) and C1b (website sync)
- text extraction with `unpdf` (pdf.js, which runs in Workers and Node) and HTML with `htmlparser2`
- C1b renders pages through a `PageRenderer` interface (Cloudflare Browser Rendering later, a fake in tests)
- C1b defines only the source-adapter interface; Zendesk, Notion, Confluence and Guru each come later

## What it does

**File records.** A teammate with `knowledge.manage` uploads a document in Knowledge ("Upload file", with the file's language):
- **Accepted:** PDF, Word (.docx), HTML, Markdown and plain text, up to 20 MB.
- **The record:** a new `file` record titled from the file name, internal and available to the inbox. The AI agent switch starts off: a teammate makes the file customer-facing in its settings first, because internal content never reaches the AI agent (A1's rule). Files never appear in the help center.
- **The check:** the upload goes to quarantine through a signed URL, like attachments. A background job (`knowledge.file.process`) then:
  1. checks the size and that the bytes really are the declared type
  2. scans for viruses
  3. copies the file to a clean key
  4. extracts the text, tidies it and keeps up to 2,000,000 characters (longer files say they were cut)
  5. publishes the text as the record's content and indexes it for search
- **Failures, each explained in the file panel:**
  - a virus: the upload is deleted
  - contents that don't match the type
  - a password-protected PDF
  - a scan with no text layer ("run text recognition (OCR) on it first")
  - a damaged file

  A file that couldn't be read is kept so it can be downloaded and fixed.
- **Replacing a file** uploads version 2. The old version stays live until the new one is read, then its row is kept as history and its bytes are deleted. If two versions finish out of order, the newer one wins.
- **Removing a file** archives the record, which takes it out of search and every surface, and deletes every stored version. The record and its history stay.
- **Editing is refused:** a file's content is the text read from it. Save, add language, restore and address changes are refused (`KNOWLEDGE_SOURCE`). Settings, unpublish, archive and publish-again still work.
- **Searching:** the Knowledge list's search now matches published content as well as titles, so a file is found by what's inside it.

**Article images.** In the article editor, "Image" uploads a PNG, JPEG, GIF or WebP up to 5 MB (no SVG, which can carry script):
- **Description required:** the image goes into the article once it has passed the scan, with its description (alt text).
- **Publishing:** refused while any image in the article is still uploading or was blocked (`IMAGE_NOT_READY`).
- **The public help center** serves images at `{center}/files/{id}`, only for an article the visitor may read and only if its published version uses that image. Images of signed-in articles need the session.
- **The messenger** gets one-hour signed addresses for an article's images (an `<img>` can't send the session token). The address is HMAC-signed and bound to the workspace and file.

**Help center theme.** Settings now take a logo (shown in the header), a favicon and a social image (`og:image`, with a large Twitter card). Each must be a ready upload of that help center for that purpose.

**Serving files.** Every file response sends `nosniff`, a `default-src 'none'; sandbox` CSP, and an explicit type:
- Documents download as attachments.
- Teammates reach files through `GET /v1/agent/knowledge-file`. Non-managers only reach records available to the inbox.

**API routes:**
- `POST /v1/agent/knowledge-files`: `prepare`, `complete` and `remove`, idempotent on the request key.
- `GET /v1/agent/knowledge-file?id=` (`&download=1`).
- `GET /v1/messenger/help/file` (signed).
- `help/article` in the messenger now returns `images`.

## Migration

`db/postgres/0033_knowledge_files.sql` is additive: the `knowledge_files` table (purpose, record or help center, version, size, type, keys, status, failure, pages, characters) with row-level security. The rollback is a no-op, like earlier knowledge migrations.

The local relay seeds a file record ("Shipping and returns", Markdown) and puts its bytes back in the in-memory storage on every start.

## Tests

**`tests/knowledge-files.test.ts`:**
- **Extraction:**
  - a two-page PDF
  - encrypted, image-only and damaged PDFs
  - Word with tabs and entities
  - HTML without scripts, styles or `noscript`, with the title and table cells
  - Markdown with a BOM and blank lines
  - empty text
  - type checks
  - truncation
- **Signed addresses:** valid; expired; another workspace, file, expiry or signature; another secret.
- **The full flow through the agent bridge with local storage:**
  - only managers upload; size and type limits
  - a PDF is published and found by its contents (managers and inbox teammates); download headers
  - editing operations are refused; settings follow the internal rule; unpublish and publish again
  - replacing with a Word file: the old version is replaced and its bytes deleted
  - a virus, a mislabelled file and an encrypted PDF are each explained
  - completing twice
  - another workspace can't download, complete, remove or search
  - removing
  - images: publishing is refused until they're ready; the public page shows them; an unused image, a document and another workspace are refused; a signed-in article's image is hidden from visitors
  - messenger signed addresses: valid, a forged file and another workspace
  - theme images: the wrong purpose and an article image are refused; the logo, `og:image` and large card appear

**`tests/browser/knowledge-files.spec.ts`** (ports 8948/8949):
- **Happy path:**
  - upload a PDF, see "Ready" with pages and an excerpt, find it by a word inside it
  - add an image with a required description to the seeded article and publish
  - a visitor with no session sees the image on the public page
- **Failure path:**
  - an EICAR file is blocked, with the reason and no download
  - a password-protected PDF is explained, and its original can still be downloaded

## Fixed along the way

- **Local relay body limit:** the local relay capped every agent request at 24 KB, so saving an article over that size failed in the browser (the Worker already allowed 1 MB). It now uses each route's own limit.
- **Image ids in callouts and tables:** `imageIds` (`lib/rich-doc.ts`) didn't look inside callouts or table cells, so an image there would have escaped the publish check.

## Notes

- **Deferred:**
  - **Unused images:** images uploaded to an article but never published, or later taken out of it, stay in storage. A clean-up job can come with C2's content health work.
  - **Replaced theme images:** the previous logo, favicon or social image stays in storage when replaced.
  - **Search length:** search indexes the first 50,000 characters of each language (B2's limit). C2's chunking covers whole documents.
  - **Job that exhausts its retries:** the file stays "Checking and reading…". The panel stops refreshing after two minutes. A dead-letter handler that marks it failed can come with phase 17's operations work.
  - **Not supported:** OCR for scanned PDFs, the older `.doc` format, and SVG.
- **Worker size and limits:**
  - pdf.js takes the Worker bundle from about 300 KB to about 830 KB gzipped (measured with esbuild), within Cloudflare's limits.
  - A very large PDF may need more CPU time than a queue consumer's default. Set the consumer's CPU limit when the Worker is deployed (phase 17).
- **Seed data:** the local relay's seeded file has no original upload behind it; its bytes are the Markdown text itself.

## Checks

Results on 1 October 2026:
- `npm test`: 76/76 pass.
- `npm run typecheck`: clean.
- Lint shows nothing new (the existing findings in `agent/views.tsx` and `server/sla.ts` are unchanged).
- `npm run test:e2e`: 51/51, with no "Relay API failed".
- `npm run test:postgres`: passes.
- The messenger, agent and portal bundles build.
- **Checked in the browser pane (preview relay):**
  - the seeded file record and its panel
  - the header's upload control, which matches the other buttons
  - a logo uploaded in help center settings, saved, shown on the public page, then removed again
