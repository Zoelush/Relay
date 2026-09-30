# Agent inbox — step C2b handoff (inline images)

Step C2b completes step C2 of `docs/AGENT_INBOX_PLAN.md`. Rich text and drafts were step C2a (`docs/AGENT_INBOX_STEP5.md`). Step C3, collaboration, is next.

## 1. What changed

**Uploads (`server/attachments.ts`, migration 0018).**

- **`purpose`:** attachments have `part` (as before) or `inline`. Inline uploads are PNG or JPEG only, up to 10 MB, and teammates only.
- **Scanning:** inline uploads go through the same prepare, direct upload, byte-type check and scan as any file. A clean inline scan does **not** publish a separate attachment part.
- **Audience:** a reply's images upload as `customer_visible`, a note's as `internal`.

**Document format (`lib/rich-doc.ts`).**

- **The image node** is `{ type: "image", attrs: { attachmentId, alt? } }`. The id must be a UUID. The node never carries a URL, and `src`, `title` and other attributes are dropped.
- **Limits:** alt text up to 200 characters, and at most 10 images per message.
- **Plain text:** an image appears as `[Image: alt]`.

**Send-time checks (`verifyInlineImages`).** Each image in a reply, note or edit must meet every rule, and each failure has its own error:

| Rule | Error |
|---|---|
| The sender's own inline upload, in this conversation or one merged into it | `IMAGE_NOT_FOUND` (404) |
| The scan has finished | `IMAGE_NOT_READY` (409) |
| The scan did not block it | `IMAGE_BLOCKED` (409) |
| A reply only uses `customer_visible` uploads | `IMAGE_AUDIENCE` (400) |

Sent parts record their images in `conversation_part_images`.

**Customer access.**

- **Which images:** a customer can fetch an inline image only when a sent, public part references it. An image pasted into a reply and then removed or never sent is not reachable, even with its id.
- **Notes:** a note's internal images never reach the customer. That holds for history, live replay and the download routes, even with the id copied.

**Rendering.**

- **One renderer:** `lib/rich-view.tsx` takes an image hook, so no surface ever loads a URL from a message.
- **Inbox:** previews load through the authenticated agent route.
- **Messenger:** each image gets a short-lived link from the customer attachment route. The frame grows from 68.4 to 68.8 KB gzip; the loader is unchanged.

**Composer (`agent/images.tsx`, `agent/composer.tsx`, `components/relay/postgres-inbox.tsx`).**

- **Adding images:** an "Insert image" button, paste or drag-and-drop. Type and size are checked first.
- **In the message:** the image appears at once and shows "Uploading…", "Checking…", the preview, or "Blocked by the scanner" / "Upload failed", each with Remove.
- **Scan results:** they arrive by pushed job updates, with polling as a fallback.
- **Send:** stays disabled, including ⌘/Ctrl Enter, with a reason, until every image is clean.
- **Pasted HTML images** without an attachment id are dropped rather than hot-linked.
- **Bundle:** the agent bundle grows by 8 KB gzip (204 to 212 KB).

**Retention.** Inline uploads older than 30 days that no sent part and no draft references are deleted from storage (quarantine, clean object and preview) and then from the database. Up to 100 go per pass, in the Worker's 03:00 UTC sweep and the local relay's daily loop. Storage gains an optional `deleteClean`, implemented for R2.

**Local storage (`scripts/local-storage.ts`, loopback only).**

- **Where:** used by default in the local relay and browser tests, never by the Worker.
- **How:** objects live in memory, behind one-time relative upload and download paths served by both local servers, so the agent page and the messenger frame stay within their content security policies.
- **Scanner:** it flags the EICAR test string.
- **Fix:** the local request helper now keeps binary request bodies, up to 10 MB on the storage path only.

## 2. Files

| File | Change |
|---|---|
| `db/postgres/0018_inline_images.sql`, `db/rollback/0018_inline_images.sql` | `attachments.purpose`, `conversation_part_images` (additive; rollback keeps both) |
| `server/attachments.ts`, `server/conversations.ts` | Inline purpose, no part for inline scans, send checks, image references, customer access check, purge |
| `lib/rich-doc.ts`, `lib/rich-view.tsx` | Image node, `imageIds`, render hook |
| `agent/images.tsx`, `agent/composer.tsx`, `agent/timeline.tsx`, `agent/inbox.css`, `components/relay/postgres-inbox.tsx` | Upload flow, image node view, send gating, timeline images |
| `messenger/frame.tsx`, `messenger/frame.css` | Customer inline images |
| `workers/relay.ts`, `workers/storage.ts` | Retention in the sweep; `deleteClean` for R2 |
| `scripts/local-storage.ts`, `scripts/local-relay.ts` | Loopback storage, binary bodies, local retention |
| `tests/inline-images.test.ts`, `tests/rich-doc.test.ts`, `tests/browser/inline-images.spec.ts` | Coverage below |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 30 September 2026:

- **Node:** 34/34 pass.
  - **Uploads:** inline uploads accept images from teammates only and create no part.
  - **Send checks:** each rejection (still checking, blocked, note image in a reply, another teammate's, another conversation's, unknown, malformed).
  - **Recording:** a sent reply records its image reference and body.
  - **Customer access:** blocked before sending, allowed after.
  - **Notes:** a note's image is absent from customer downloads, history and live replay, but available to teammates.
  - **Retention:** only unreferenced uploads go; drafted and sent ones stay.
  - **Document rules:** the image node (URL and id rejections, the 10-image limit, the plain-text form).
- **Typecheck:** clean.
- **Browser:** 16/16 pass.
  - **Happy path:** a real PNG is inserted into a reply, checked, sent, and decoded (`naturalWidth` 1) in both the inbox and the customer's messenger.
  - **Failure path:** an EICAR image is blocked; Send and ⌘/Ctrl Enter stay disabled with a reason; after Remove the message sends without it.
  - **Stability:** image and composer tests passed three consecutive runs.

## 4. Deferred and known gaps

- **GIF, WebP and other image types:** they need byte detection and preview support.
- **Not previewed:** an image restored from a draft in a new tab has no known status there. It loads its preview, and the server still checks it at send.
- **Hosted uploads:** the production app's content security policy must allow `connect-src` to the R2 upload origin. The local relay proves the flow; hosted R2 is not provisioned.
- **Alt text** is the file name; there is no editing interface for it yet.
- **Customer uploads** still create separate attachment messages, as before.
