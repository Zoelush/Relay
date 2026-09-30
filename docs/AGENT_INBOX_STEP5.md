# Agent inbox — step C2a handoff (rich text and drafts)

Step C2 of `docs/AGENT_INBOX_PLAN.md` is split into two parts:

- **C2a (this document):** rich text and server-backed drafts
- **C2b:** inline images, meaning composer uploads, scan state, images placed inside messages, and customer rendering

Step C3 then covers mentions, notifications and viewing and composing indicators.

## 1. What changed

**Document format (`lib/rich-doc.ts`, shared by server, inbox, messenger and tests).**

- **Allowed:** paragraphs, bullet and numbered lists, quotes, code blocks, line breaks, and bold, italic, inline code and links.
- **Links:** absolute `https:`, `http:` or `mailto:` only. `javascript:`, `data:`, relative and other schemes are rejected.
- **Limits:** 5,000 characters of text, four levels of nesting and 2,000 nodes.
- **Rebuilding:** `normalizeDoc` rebuilds the document from allowed content only. Unknown attributes (`onclick`, `class`, `target`, languages) are dropped, and unknown nodes or marks are rejected.
- **Plain-text fallback:** `plainText` derives `body`, which search, notifications and future plain channels use. Lists become `- ` and `1. `, quotes become `> `, and a link keeps its destination as `text (url)` unless the text already is the URL.
- **Storage:** rich replies, notes and edits store `data.doc` (the rebuilt document) and `body` (the fallback). A document with no formatting is stored as plain text only. Customers cannot send documents (403).

**Rendering (`lib/rich-view.tsx`).**

- **How:** React elements only, never HTML strings. Each document is validated again before rendering and falls back to `body` if invalid.
- **Links** open in a new tab with `rel="noopener noreferrer nofollow ugc"`.
- **Where:** used in the inbox timeline and, for customer-visible replies, in the messenger. This grows the messenger frame from 67.0 to 68.4 KB gzip; the loader is unchanged at 4,282 bytes.
- **Privacy:** notes stay internal through the existing delivery policy. The test puts a secret in a note's text, link text, link URL and code block, and it never reaches the customer.

**Composer (`agent/composer.tsx`).**

- **Editor:** TipTap 3.31.3 (ProseMirror) with StarterKit limited to the format above. Headings, strike, underline and rules are off, and pasted content is reduced to the same schema.
- **Toolbar:** accessible, with an inline link field that validates addresses. There is no browser prompt.
- **Keys:** ⌘/Ctrl Enter sends and Esc leaves the editor.
- **Accessible name:** "Reply message" or "Internal note", as before, so the C1 shortcuts and existing tests still work.
- **Reloading content:** the editor is recreated when the conversation, mode or a restored draft changes. Setting content on a just-created editor, before its view mounts, was found to drop it.
- **Bundle:** the editor adds about 130 KB gzip. It is loaded with `React.lazy` so the app's bundler can split it; the local test bundle (esbuild, no splitting) stays one file, 204 KB gzip against 74 KB before.

**Drafts (migration 0017, `server/drafts.ts`, `agent/use-drafts.ts`).**

- **Storage:** one draft per conversation, teammate and mode, with a version number and row-level security. Queries always filter by the signed-in teammate, so nobody else, including an owner, can read them.
- **Autosave:** 800ms after typing stops, carrying the version it started from.
- **Conflicts:** a newer save from another tab or device returns `409 DRAFT_CONFLICT` with the other version. The teammate chooses "Keep mine" or "Use the other version".
- **Leaving the page:** hiding or refreshing the page sends pending saves at once using `keepalive`.
- **Offline:** unsaved text stays in the tab's memory, never browser storage, and retries every 5 seconds and on reconnect.
- **Sending** deletes that mode's draft in the same transaction.
- **Retention:** drafts untouched for 30 days are purged. The Worker's per-minute workspace sweep deletes up to 500 per pass during the 03:00 UTC hour, and the local relay does it once a day.
- **Bugs found while testing and fixed:**
  - A phantom empty edit, caused by the editor's trailing paragraph, could block the restore.
  - Server drafts compared unequal because `jsonb` reorders keys, which caused needless saves and conflicts.
  - Reloading within the autosave pause lost the last edits.

## 2. Files

| File | Change |
|---|---|
| `lib/rich-doc.ts`, `lib/rich-view.tsx` | Document rules, fallback text, safe renderer |
| `server/conversations.ts` | `doc` on reply, note and edit; sending deletes the draft |
| `db/postgres/0017_conversation_drafts.sql`, `db/rollback/0017_conversation_drafts.sql` | Drafts table (additive; rollback keeps it) |
| `server/drafts.ts`, `server/api.ts`, `server/agent-bridge.ts` | `GET` and `POST /v1/agent/drafts`, conflicts, purge |
| `workers/relay.ts`, `scripts/local-relay.ts` | Draft retention in the sweep and the local loop |
| `agent/composer.tsx`, `agent/use-drafts.ts`, `agent/api.ts`, `agent/timeline.tsx`, `agent/inbox.css`, `components/relay/postgres-inbox.tsx` | Editor, autosave, conflict UI, rich timeline |
| `messenger/frame.tsx`, `messenger/frame.css` | Rich replies for customers |
| `package.json` | `@tiptap/react`, `@tiptap/pm`, `@tiptap/core` and `@tiptap/starter-kit` at 3.31.3, exact versions |
| `tests/rich-doc.test.ts`, `tests/drafts.test.ts`, `tests/browser/composer.spec.ts` | Coverage below; `tests/browser/agent-inbox.spec.ts` now reads the editor's text instead of a textarea value |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 30 September 2026:

- **Node:** 32/32 pass.
  - **Document rules:** 17 rejection cases, including `javascript:`, `data:`, relative and uppercase-scheme links, unknown nodes and marks, and limits. Attribute stripping and the fallback text are also checked.
  - **Drafts and rich messages:** author-only across teammates and workspaces; conflicts for stale and missing base versions; stored body and rebuilt doc; draft consumed on send; customers refused; note secret absent from customer history and live replay; 30-day purge.
- **Typecheck:** clean.
- **Browser:** 14/14 pass.
  - **Happy path:** format a list and a link, confirm the server draft, refresh and see the formatting restored, send with ⌘/Ctrl Enter, then see the list and a safe link in the inbox and in the customer's messenger.
  - **Failure path:** two tabs edit one draft. Tab B keeps its text; tab A, now behind, conflicts and takes the other version, so no text is lost.
  - **Stability:** the composer tests passed five consecutive runs after the fixes above.

## 4. Deferred and known gaps

- **Images:** inline images and composer uploads are step C2b.
- **Rich customer messages:** customers still send plain text.
- **Draft conflicts** are resolved by choosing a whole version; there is no merge.
- **Undo history** does not survive a conversation switch or restore, because the editor is recreated.
