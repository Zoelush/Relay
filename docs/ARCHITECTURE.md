# Relay architecture audit

**Current status:** Read the [implementation addendum](#implementation-addendum--21-september-2026) before the historical audit.

**Contents:** [Inventory](#1-inventory) · [Message trace](#2-trace-customer-message--agent--reply--customer) · [Gap analysis](#3-gap-analysis-against-the-target-surface) · [Load-bearing decisions](#4-load-bearing-decisions) · [Required refactors](#5-refactors-required-before-phase-1-in-order)

**Audit date:** 15 September 2026. **Scope:** read-only application audit; this report is the only requested deliverable. No feature implementation or refactor was performed.

**Code baseline:** local commit `37e7a8e` and its working tree. The connected private GitHub repository, [Zoelush/Relay](https://github.com/Zoelush/Relay), was empty when inspected. There is no local Git remote. Consequently, this report describes the local Relay implementation, not code fetched from GitHub. The pre-existing working tree changes are a modified `.gitignore` and deletions of `public/file.svg`, `public/globe.svg`, `public/window.svg`, and `tsconfig.tsbuildinfo`; this audit preserves them. No deployment was verified.

**Reading of the code, in under 200 words:** Relay is a TypeScript/React 19 application using Next-compatible app routes through Vinext/Vite, Tailwind 4, and a generated shadcn/Radix component catalog. Cloudflare Workers serves it; one D1 SQLite binding stores data. `app/` contains three pages, layout, authentication helpers, and two API route files; `components/relay/` contains the inbox, messenger, and shared client utilities; `components/ui/` contains the UI catalog; `db/` and `drizzle/` define schema and migration; `build/` and `scripts/` support Sites development/builds. Runtime queries use raw prepared D1 SQL; the Drizzle runtime wrapper is unused. Agent access trusts platform-forwarded ChatGPT identity and checks one hardcoded workspace owner. Visitors use a browser-held bearer token whose hash belongs to one conversation. Realtime is two-second HTTP polling, not push. There is no background job runner. Testing consists of an ignored ad hoc HTTP assertion script, plus available lint/type/build checks; there is no committed unit-test suite, browser E2E runner, CI pipeline, tenant-isolation test, or migration rollback.

**Principal finding:** this is a useful single-owner chat prototype, not yet a multi-tenant platform foundation. The shortest safe next step is to establish tenancy, durable retry semantics, bounded reads, and repeatable validation around the existing chat flow. Building the wider product surface first would multiply migrations and authorization fixes.

**Method and limits:** inspected authored source, schema/migration, configuration, scripts, import graph, and GitHub repository state. Runtime trace below is derived from code. The existing HTTP test script was read, not rerun, because it writes chat data. No new load test, restart experiment, browser E2E, or production security assessment was performed. Scale judgments are architectural estimates, not benchmark results. Generated build output, dependencies, and local database contents are not additional application services. Paths below are relative to the repository root so this document remains portable.

## Implementation addendum — 21 September 2026

**Read this addendum first in future sessions.** The audit below remains a dated description of the original D1 path. The user subsequently authorized the dependency chain and local implementation while deferring cloud access. The new path is implemented locally, defaulted off in production, and has not been cut over. [LOCAL_READINESS.md](LOCAL_READINESS.md) is the current file/route inventory and acceptance ledger; [MESSENGER.md](MESSENGER.md) is the integration contract; [MOBILE_SDK.md](MOBILE_SDK.md) is interface-only.

**22 September inbox update:** [AGENT_INBOX_STEP1.md](AGENT_INBOX_STEP1.md) supersedes the earlier bridge status below. The authenticated app now has a default-off PostgreSQL/WebSocket inbox, request-bound signing, note/attachment audience enforcement and authenticated internal-file downloads. D1 polling remains available with explicit writer guards. All 21 Node tests pass; app/type/lint/bundle checks pass. New inbox browser acceptance is pending due host browser-launch restrictions; manual inspection verified connection/storage indicators and isolated widget rendering only. No later inbox step or hosted cutover was performed.

- **Stack/layout:** the original React/Vinext app remains. New PostgreSQL SQL migrations are in `db/postgres/`; services in `server/`; native Cloudflare entry points in `workers/`; the lazy iframe in `messenger/`; launcher assets in `public/messenger/`; local fixture/migration/load scripts in `scripts/`; tests in `tests/`.
- **Data/access:** workspace-scoped transactions, composite tenant foreign keys and forced RLS; Hyperdrive is mandatory in the Worker. Runtime roles that own tables or bypass RLS are rejected. No production Neon connection has been tested.
- **Identity/policy:** named capabilities, roles, brands, contacts and stable identities are minimum foundations. Verified JWT/HMAC sessions and signed agent requests authorize the new route surface. Retained contact redirects/mapping changes replace destructive history rewrites. Anonymous credentials remain narrower than verified account credentials.
- **Message trace:** host loader → authenticated bootstrap HTTP → lazy iframe → idempotent command HTTP → atomic PostgreSQL part/sequence/projections/outbox → workspace Durable Object WebSocket → client cursor replay and part-ID deduplication → React render. Agent commands take the same durable path through the app's authenticated signed bridge. A flag selects the new inbox or retained D1 polling UI; local tests and the loopback fixture exercise the new path.
- **Restart behaviour:** a committed part/outbox survives process loss; notification replay may duplicate delivery but must not duplicate rendering. Clients reconnect using signed revision/position cursors. Repeated conversation merges resolve both original IDs and trigger revision reset. Uncommitted work rolls back and external retries use the same receipt key. Ephemeral typing/presence disappears on restart. The local 60-second disconnect test includes an actual server restart using persisted PostgreSQL data and signing keys; native Durable Object eviction remains unverified.
- **Read models:** append-only parts and cycles coexist with mutable, rebuildable counters/search/read projections. Anonymous unread totals are keyed by identity; verified totals by resolved contact and canonical conversation. Read acknowledgements update original timeline positions; merges do not duplicate badge totals. A job backfills the new counter generation before exposing an existing workspace.
- **Jobs/storage:** Queues with retries/DLQ, Cron recovery, DO snooze alarms, persisted job state/events and pushed status. Local development substitutes a server-side recovery loop. Attachments use R2 metadata/quarantine/scan/clean adapters, with Cloudflare Images previews and a fail-closed private ClamAV service. These hosted services are unprovisioned. Events/Iceberg and embeddings/Vectorize remain contracts; no raw event/vector payload was put in PostgreSQL.
- **Tests/limits:** 19 SQL/HTTP/regression tests pass; the browser acceptance suite covers CSP, hostile CSS, lazy loading, identity failure, RTL and restart/replay. The local 200-agent load rendered all 3,000 messages, with processing p95 149ms after index, transaction and outbox acknowledgement fixes (isolated baseline: 720ms). Delivery p50/p99 are 68/1,082ms. Cold managed-database acceptance remains unverified. The query plan and limitations are in `LOCAL_READINESS.md`. Repository-wide lint still fails in the unchanged legacy UI; the new implementation passes its lint check.

**Still incomplete:** production D1 migration/backfill/compatibility, hosted inbox authentication/cutover and browser acceptance, hosted storage/queue/DO tests, the full people model (companies/custom objects/events/subscriptions/segments), the 2-million-event cold-cache benchmark, and later Help/ticket/routing providers. Do not describe the entire Phase 1 or messenger acceptance as finished. Do not enable production flags based on local tests alone. Stop after the authorized inbox step 1; future scope requires user direction. Cold hosted performance must be verified once access is configured.

---

## 1. Inventory

### 1.1 Routes and exposed endpoints

These are all authored application routes and public assets with application behavior. Query branches and mutation actions are enumerated because there are only two API route files.

| Method and path | Source | One-line purpose and access |
|---|---|---|
| `GET /` | `app/page.tsx` | Requires platform identity, then renders the agent inbox; ownership is enforced by its API requests. |
| `GET /messenger` | `app/messenger/page.tsx` | Renders the full-page visitor messenger demo; no application-level agent authentication. |
| `GET /embed` | `app/embed/page.tsx` | Renders the compact messenger used inside the loader's iframe; no application-level agent authentication. |
| `GET /api/inbox` | `app/api/inbox/route.ts` | Owner-only full conversation list, last-message previews, branding, and owner display name. |
| `GET /api/inbox?conversation=:id` | Same | Owner-only conversation record and its entire message history, including private notes. |
| `POST /api/inbox`, `action=send` | Same | Persists an agent reply or private note and clears the conversation's shared unread flag. |
| `POST /api/inbox`, `action=update` | Same | Sets open/closed status, owner/unassigned assignment, priority, or read state. |
| `POST /api/inbox`, `action=settings` | Same | Updates the singleton workspace's public messenger branding and availability copy. |
| `GET /api/visitor?config=1` | `app/api/visitor/route.ts` | Returns public branding without a visitor token; any `config` query parameter selects this branch. |
| `GET /api/visitor` | Same | Validates conversation ID/token and returns all public messages, conversation status, and branding. |
| `POST /api/visitor`, `action=start` | Same | Accepts visitor identity text, token, first message, and client UUID; creates a conversation and first message. |
| `POST /api/visitor`, `action=send` | Same | Validates the visitor session, stores another message, marks unread, and reopens the conversation. |
| `GET /widget.js` | `public/widget.js` | Serves the host-page script that creates a launcher and an iframe pointing at `/embed`. |
| `GET /favicon.svg` | `public/favicon.svg` | Serves Relay's browser icon. |

The deployment's audience gate can additionally restrict these paths; code alone does not prove external visitors can load the messenger. The UI explicitly says public visitor access must be enabled before external installation.

**Platform-owned paths, not application route files:** `/signin-with-chatgpt` starts sign-in, `/signout-with-chatgpt` ends it, and `/callback` completes platform authentication. The portable local plugin implements sign-in GET and sign-out GET/POST; its callback returns 501. Hosted handling belongs to the platform dispatcher. Framework-generated asset paths such as `/_next/static/*` are build artifacts, not domain APIs. No webhook, upload, health, job-status, billing, public versioned API, or channel-ingestion routes exist.

### 1.2 Persistent models: every existing table

| Table / model | Fields | Purpose and limitations |
|---|---|---|
| `workspace` / `workspace` | `id`, `owner_id`, `brand`, `greeting`, `color`, `availability` | One settings/ownership record, always `id='main'`; no workspace lifecycle, membership, plan, calendar, or timestamps. |
| `conversations` / `conversations` | `id`, `token_hash`, `name`, `email`, `title`, `status`, `assigned`, `priority`, `unread`, `sample`, `tag`, `created_at`, `updated_at` | Stores conversation identity, denormalized visitor details, current state, and one visitor credential hash; no `workspace_id` or contact/teammate foreign keys. |
| `messages` / `messages` | `id`, `conversation_id`, `kind`, `body`, `sender`, `created_at` | Stores text replies and private notes; only `conversation_id` has a foreign key; no `workspace_id`, actor identity, sequence, attachment, or delivery state. |

Schema authority is `db/schema.ts`; `drizzle/0000_daily_jane_foster.sql` creates the three tables. Indexes are `idx_conversations_updated(updated_at)` and `idx_messages_conversation_created(conversation_id, created_at)`, in addition to primary keys. No composite tenant constraints or database enum/check constraints enforce the application's status/kind vocabulary. `priority`, `unread`, and `sample` are integer flags, not counters. `workspace.id` identifies the root workspace but there is no literal `workspace_id` column anywhere.

**Other model/contract definitions, including duplicated shapes:**

| Definition | Location | One-line purpose |
|---|---|---|
| `Workspace` | `lib/relay-server.ts` | Handwritten snake_case query-result shape duplicating the workspace schema. |
| `Conversation` | `components/relay/shared.tsx` | Handwritten client conversation DTO, with optional preview and two-state status union. |
| `Message` | Same | Client text-part DTO with `agent`, `visitor`, or `note` kind. |
| `Settings` and `defaults` | Same | Public branding DTO and initial browser defaults, duplicating server seed defaults. |
| `InboxData` | `components/relay/inbox.tsx` | List-response envelope containing conversations, settings, and owner name. |
| `DetailData` | Same | Detail-response envelope containing one conversation and all messages. |
| `Session` | `components/relay/messenger.tsx` | Browser-only conversation ID and plaintext token; not a database session entity. |
| Inbox `actions` | `app/api/inbox/route.ts` | Zod discriminated validation schemas for send, update, and settings. |
| Visitor `schema` | `app/api/visitor/route.ts` | Zod discriminated validation schemas for start and send. |
| `ChatGPTUser` | `app/chatgpt-auth.ts` | Trusted-platform identity DTO, with ID, display name, email, and full name. |
| Local `Tool` | `components/relay/inbox.tsx` | Browser WebMCP registration contract, not a stored integration or app model. |
| `Cloudflare.Env` | `cloudflare-env.d.ts` | Optional DB/BUCKET binding declarations; BUCKET is not configured. |

There are no contact, teammate, membership, job, event, ticket, billing, audit, attachment, or search-index models hidden behind the UI. Vendor UI configuration types are inventoried with their components below and are not business models.

### 1.3 Runtime services, helpers, and browser behaviors

There is no separate service layer: API handlers contain SQL and business rules.

| Service / helper | Location | One-line purpose and status |
|---|---|---|
| `database()` | `lib/relay-server.ts` | Retrieves the raw D1 binding; active runtime data access. |
| `ApiError` | Same | Carries a user-facing HTTP error status. |
| `response()` | Same | Returns JSON with `Cache-Control: no-store`. |
| `failure()` | Same | Maps known errors to status responses and logs unexpected failures before a generic 503. |
| `body()` | Same | Parses JSON with nominal 15,000 size limits; reads the full body first when length is absent and measures JavaScript characters after decoding. |
| `sameOrigin()` | Same | Rejects a mismatched supplied Origin; accepts missing Origin, so it is not authentication or a host-installation allowlist. |
| `hash()` | Same | SHA-256 hashes a visitor bearer token before lookup/storage. |
| `admin()` | Same | Checks platform identity and singleton owner, initializing sample data on first authenticated access. |
| `publicSettings()` | Same | Projects workspace settings safe for visitor responses. |
| `seed()` | Same | Inserts the `main` workspace, five fixed-ID sample conversations, and ten messages in a D1 batch. |
| Visitor `session()` | `app/api/visitor/route.ts` | Checks conversation ID, hashed token, and `sample=0`; does not verify the supplied email or a customer account. |
| Visitor `settings()` | Same | Loads `main` branding or returns 503 until the owner initializes the workspace. |
| `getDb()` | `db/index.ts` | Wraps D1 in Drizzle; **unused by the live application**, parallel to raw SQL access. |
| `getChatGPTUser()` | `app/chatgpt-auth.ts` | Reads platform-forwarded identity headers and decodes the supported full-name encoding. |
| `requireChatGPTUser()` | Same | Redirects unauthenticated page requests to sign-in. |
| `chatGPTSignInPath()` | Same | Creates a sign-in path with a validated relative return path. |
| `chatGPTSignOutPath()` | Same | Creates a sign-out path; **exported but unused in the product**. |
| `safeRelativeReturnPath()` | Same | Rejects unsafe or recursive authentication return paths. |
| `isReservedAuthPath()` | Same | Recognizes reserved sign-in/sign-out/callback paths. |
| `safeDecodeURIComponent()` | Same | Safely decodes identity/return-path text without throwing. |
| `api<T>()` | `components/relay/shared.tsx` | Shared fetch/JSON client with no timeout, cancellation, retry scheduler, or persisted retry record. |
| `usePoll<T>()` | Same | Generic two-second polling hook; **unused**, while three equivalent loops live in components. |
| `initials()` | Same | Creates display initials from name tokens. |
| `shade()` | Same | Chooses an avatar color from the name's first character. |
| `since()` | Same | Computes relative minutes/hours/days using the browser clock. |
| `timeOf()` | Same | Formats time using the browser's implicit locale/timezone. |
| `useMessageScroll()` | Same | Keeps selected threads near the latest messages; its computed `last` value is discarded. |
| `useIsMobile()` | `hooks/use-mobile.ts` | Tracks the 768px media breakpoint for shared sidebar behavior. |
| `cn()` | `lib/utils.ts` | Combines class names and resolves Tailwind class conflicts. |
| Inbox list/detail polling effects | `components/relay/inbox.tsx` | Independently reload the entire list and selected history after each two-second delay. |
| Inbox `pick()` / `choose()` | Same | Select and mark a thread read, or change client-side inbox filters. |
| Inbox `update()` | Same | Sends state mutations and patches detail locally; an in-flight response can patch a newly selected conversation because the callback does not check its ID. |
| Inbox `send()` | Same | Sends a reply/note using an in-memory UUID and refreshes queries after acknowledgement. |
| Inbox `saveSettings()` | Same | Saves branding and refreshes the inbox's settings snapshot. |
| `list_conversations` browser tool | Same | Read-only WebMCP tool fetching the current inbox, registered only when supported. |
| `open_conversation` browser tool | Same | WebMCP tool fetching/selecting a thread without sending a message or marking it read. |
| Messenger configuration/session effect | `components/relay/messenger.tsx` | Loads branding and restores `relay-visitor-session` from localStorage. |
| Messenger polling effect | Same | Repeatedly fetches complete public history/status using the conversation token. |
| Messenger `send()` | Same | Starts a conversation or sends a message; saves the first session only after server acknowledgement. |
| Widget loader IIFE | `public/widget.js` | Creates one host-page button/iframe, derives Relay origin from its script URL, and toggles visibility. |

The two WebMCP tools expose existing UI operations. They are not an AI answering service, copilot, public API, or app framework.

### 1.4 Background jobs, infrastructure, and test assets

**Background jobs: none.** No queue binding, consumer, cron handler, transactional outbox, retry policy, dead-letter queue, or readable job status exists. Browser polling timers and build/install scripts are not background jobs. Every request-side SQL operation, seeding included, runs synchronously; no 200ms measurement or routing policy is implemented.

| File / subsystem | One-line purpose and status |
|---|---|
| `vite.config.ts` | Assembles Vinext, Cloudflare, and local Sites auth plugins; configures one D1 binding and the generated Worker handler. |
| `.openai/hosting.json` | Sites project configuration with DB enabled and R2 unset; no verified deployed environment. |
| `build/sites-vite-plugin.ts` / `sites()` | Local authentication middleware plus build-time copying of the manifest and migration directory. |
| Plugin `exists`, `removeHeader`, `setHeader`, `respond`, `safeReturn` | Internal filesystem/header/HTTP/redirect helpers supporting that plugin. |
| `scripts/run-framework.mjs` | Launches portable Vinext or managed Vite/build execution. |
| `scripts/execution-profile.mjs` | Chooses the configured execution profile, defaulting to portable when absent. |
| `scripts/sites-env.mjs` | Prepares project-local runtime environment paths for installation and serving. |
| `scripts/sites-env.sh` | Shell counterpart supporting the managed environment. |
| `scripts/install-ci.mjs` | Selects the locked dependency-installation path used by `npm run install:ci`. |
| `scripts/install-ci.sh` | Managed-profile npm installation support. |
| `scripts/build-verified.sh` | Managed-profile bounded build wrapper. |
| `scripts/install-pnpm.sh` | **Dormant generated alternative** installer; this checkout uses npm and has no pnpm lockfile. |
| `scripts/pnpm-install.mjs` | **Dormant generated alternative** with install progress/cache coordination; `InstallProgress` is build tooling, not a domain model. |
| `drizzle.config.ts` | Configures schema-to-SQL generation; does not make runtime queries use Drizzle. |
| `drizzle/0000_daily_jane_foster.sql` | Initial forward schema creation; no corresponding rollback. |
| `drizzle/meta/_journal.json`, `0000_snapshot.json` | Generated, used migration metadata; not unused application models. |
| `package.json`, `package-lock.json` | Runtime/tool dependencies and commands; package name still says `site-creator-vinext-starter`. |
| `tsconfig.json`, `cloudflare-env.d.ts` | Type checking and binding declarations. |
| `eslint.config.mjs` | Lint configuration, including generated/vendor exceptions. |
| `next.config.ts` | Empty Next-compatible configuration shell. |
| `postcss.config.mjs`, `components.json` | Tailwind processing and generated UI catalog settings. |
| `app/globals.css` | Relay visual styling and responsive layout; includes legacy selectors alongside active styles. |
| `vendor/shadcn-tailwind-4.13.0.css` and license files | Imported vendor styling and attribution; generated but used. |
| `README.md` | Local instructions and MVP description; retry guarantees and “published” wording overstate what this audit can verify. |
| `work/test-chat.mjs` | Ignored, ad hoc Node/HTTP assertion script covering 17 checks; not a committed test suite or browser E2E. |
| `.wrangler/state` | Local development database state; durable across process restarts only while that directory is retained. |

The portable auth plugin strips incoming identity headers, restricts mock sign-in to loopback, and supplies a local user/cookie. Hosted authentication depends on the dispatcher supplying trustworthy headers and preventing direct spoofed-header access; this deployment boundary was not penetration-tested. The mock is not the production identity provider.

The ad hoc test script covers message creation, sequential retries, reply/note visibility, invalid visitor credentials, validation, reopen behavior, assignment/priority, and Origin rejection. It does **not** prove multi-tenant isolation, concurrent idempotency, browser restoration, restart safety, or throughput. There is no `test` npm command, committed unit/browser suite, CI workflow, `CHANGELOG`, seed command, default-off feature flag, or migration rollback. Runtime `seed()` is the only seed mechanism.

### 1.5 Product UI components

| Component / UI section | Location | One-line purpose |
|---|---|---|
| `RootLayout` | `app/layout.tsx` | Sets document metadata, fixed English language, and global CSS. |
| Root `Page` | `app/page.tsx` | Authenticated server entry point for the inbox. |
| Messenger `Page` | `app/messenger/page.tsx` | Server entry point for the visitor demo. |
| Embed `Page` | `app/embed/page.tsx` | Server entry point for the compact messenger. |
| `Inbox` | `components/relay/inbox.tsx` | Monolithic client component coordinating list, thread, mutations, settings, and preview. |
| Inbox sidebar | Inside `Inbox` | Fixed views and client-computed counts plus settings/messenger entry points. |
| Conversation list/search | Inside `Inbox` | Filters downloaded conversations and latest previews in browser memory. |
| Thread/composer | Inside `Inbox` | Renders all parts and accepts agent replies or private notes. |
| `detailPanel` | Inside `Inbox` | Customer/assignment/status content rendered in both desktop aside and mobile Sheet. |
| Messenger preview dialog | Inside `Inbox` | Mounts `Messenger` directly; does not exercise the public script or a cross-origin iframe. |
| Settings/install dialog | Inside `Inbox` | Edits branding and copies a script snippet without tenant identification. |
| `Messenger` | `components/relay/messenger.tsx` | Customer home, identity form, conversation, composer, launcher, and session state. |
| `Avatar` | `components/relay/shared.tsx` | Product initials avatar; separate from the unused vendor avatar module. |
| Host-page launcher/iframe | `public/widget.js` | Imperative DOM UI outside React, with hardcoded English text and green button. |

Static R/S/J support avatars are decoration, not teammate presence. Visitor double-check icons are decoration, not delivery/read acknowledgements. “Live updates,” “MVP,” and “Private workspace preview” are labels, not transport, entitlement, or access-control mechanisms. `selectedRef` in Inbox is written but never read; the API's owner display name is returned but the UI uses hardcoded “You.”

### 1.6 Complete shared UI catalog

The repository contains **61 UI modules and 347 exported symbols** under `components/ui/`. The following lists every export individually, plus three internal UI components. **Reachable** means reachable in the static import graph from app entry points, not proof that every export is rendered or included in the production bundle. Twelve modules are reachable; 49 are unreferenced by the running product. All are generated/shared catalog implementations; availability of a chart, attachment, form, or message component does not establish the corresponding product capability. Types, hooks, and style factories are explicitly distinguished from rendered components.

#### `components/ui/accordion.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Accordion` | Groups expandable disclosure sections. |
| `AccordionItem` | Renders one item in the accordion. |
| `AccordionTrigger` | Renders the control that opens or selects the accordion. |
| `AccordionContent` | Wraps the content region of the accordion. |

#### `components/ui/alert-dialog.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `AlertDialog` | Coordinates a modal confirmation interaction. |
| `AlertDialogAction` | Renders the confirmation action in an alert dialog. |
| `AlertDialogCancel` | Renders the cancel action in an alert dialog. |
| `AlertDialogContent` | Wraps the content region of the confirmation dialog. |
| `AlertDialogDescription` | Renders supporting descriptive text for the confirmation dialog. |
| `AlertDialogFooter` | Groups footer content in the confirmation dialog. |
| `AlertDialogHeader` | Groups heading content in the confirmation dialog. |
| `AlertDialogMedia` | Wraps an icon, image, or preview in the confirmation dialog. |
| `AlertDialogOverlay` | Renders the backdrop behind the confirmation dialog. |
| `AlertDialogPortal` | Renders confirmation dialog content outside the parent DOM subtree. |
| `AlertDialogTitle` | Renders the title of the confirmation dialog. |
| `AlertDialogTrigger` | Renders the control that opens or selects the confirmation dialog. |

#### `components/ui/alert.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Alert` | Displays an inline status or warning message. |
| `AlertTitle` | Renders the title of the alert. |
| `AlertDescription` | Renders supporting descriptive text for the alert. |

#### `components/ui/aspect-ratio.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `AspectRatio` | Maintains the aspect ratio of contained content. |

#### `components/ui/attachment.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Attachment` | Presents a file or media attachment without upload/storage behavior. |
| `AttachmentGroup` | Groups related items in the attachment display. |
| `AttachmentMedia` | Wraps an icon, image, or preview in the attachment display. |
| `AttachmentContent` | Wraps the content region of the attachment display. |
| `AttachmentTitle` | Renders the title of the attachment display. |
| `AttachmentDescription` | Renders supporting descriptive text for the attachment display. |
| `AttachmentActions` | Groups action controls in the attachment display. |
| `AttachmentAction` | Positions an action control in the attachment display. |
| `AttachmentTrigger` | Renders the control associated with an attachment interaction. |

#### `components/ui/avatar.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Avatar` | Displays an image or fallback identity marker. |
| `AvatarImage` | Renders the avatar image. |
| `AvatarFallback` | Displays fallback identity content when no image is available. |
| `AvatarBadge` | Overlays a small visual badge on an avatar. |
| `AvatarGroup` | Groups multiple avatar displays. |
| `AvatarGroupCount` | Displays an overflow count for grouped avatars. |

#### `components/ui/badge.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Badge` | Displays a compact status/category label. |
| `badgeVariants` | Style factory: produces badge variant classes. |

#### `components/ui/breadcrumb.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Breadcrumb` | Provides a navigation trail container. |
| `BreadcrumbList` | Groups entries in the breadcrumb. |
| `BreadcrumbItem` | Renders one item in the breadcrumb. |
| `BreadcrumbLink` | Renders a navigation link in the breadcrumb. |
| `BreadcrumbPage` | Marks the current location in the breadcrumb trail. |
| `BreadcrumbSeparator` | Renders a boundary between items in the breadcrumb. |
| `BreadcrumbEllipsis` | Indicates collapsed breadcrumb levels. |

#### `components/ui/bubble.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `BubbleGroup` | Groups related items in the chat bubble. |
| `Bubble` | Displays styled conversation content without messaging behavior. |
| `BubbleContent` | Wraps the content region of the chat bubble. |
| `BubbleReactions` | Groups visual reactions associated with a chat bubble. |

#### `components/ui/button-group.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `ButtonGroup` | Groups related buttons with shared visual boundaries. |
| `ButtonGroupSeparator` | Renders a boundary between items in the button group. |
| `ButtonGroupText` | Renders supporting inline text in the button group. |
| `buttonGroupVariants` | Style factory: produces button-group orientation classes. |

#### `components/ui/button.tsx` — Reachable module

| Symbol | One-line purpose |
|---|---|
| `Button` | Renders a styled action button. |
| `buttonVariants` | Style factory: produces button classes for variant and size. |

#### `components/ui/calendar.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Calendar` | Renders the reusable date-picker calendar. |
| `CalendarDayButton` | Renders one calendar day button and selection styling. |

#### `components/ui/card.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Card` | Groups related content in a bordered surface. |
| `CardHeader` | Groups heading content in the card. |
| `CardFooter` | Groups footer content in the card. |
| `CardTitle` | Renders the title of the card. |
| `CardAction` | Positions an action control in the card. |
| `CardDescription` | Renders supporting descriptive text for the card. |
| `CardContent` | Wraps the content region of the card. |

#### `components/ui/carousel.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `CarouselApi` | Type: exposes the underlying Embla carousel API shape. |
| `Carousel` | Coordinates a scrollable sequence of slides. |
| `CarouselContent` | Wraps the content region of the carousel. |
| `CarouselItem` | Renders one item in the carousel. |
| `CarouselPrevious` | Moves the carousel to the previous slide. |
| `CarouselNext` | Moves the carousel to the next slide. |

#### `components/ui/chart.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `ChartConfig` | Type: maps chart series keys to labels, icons, and colors. |
| `ChartContainer` | Provides chart context and a responsive Recharts container. |
| `ChartTooltip` | Re-exports the chart tooltip primitive. |
| `ChartTooltipContent` | Formats chart tooltip labels, values, and indicators. |
| `ChartLegend` | Re-exports the chart legend primitive. |
| `ChartLegendContent` | Formats chart legend entries and markers. |
| `ChartStyle` | Injects chart-series CSS variables for configured themes. |

#### `components/ui/checkbox.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Checkbox` | Renders a boolean or indeterminate selection control. |

#### `components/ui/collapsible.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Collapsible` | Coordinates a single expandable content region. |
| `CollapsibleTrigger` | Renders the control that opens or selects the collapsible section. |
| `CollapsibleContent` | Wraps the content region of the collapsible section. |

#### `components/ui/combobox.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Combobox` | Coordinates searchable option selection. |
| `ComboboxInput` | Renders the editable text control in the combobox. |
| `ComboboxContent` | Wraps the content region of the combobox. |
| `ComboboxList` | Groups entries in the combobox. |
| `ComboboxItem` | Renders one item in the combobox. |
| `ComboboxGroup` | Groups related items in the combobox. |
| `ComboboxLabel` | Renders a label within the combobox. |
| `ComboboxCollection` | Renders the combobox collection using its collection primitive. |
| `ComboboxEmpty` | Displays the no-results state for the combobox. |
| `ComboboxSeparator` | Renders a boundary between items in the combobox. |
| `ComboboxChips` | Groups selected combobox values as chips. |
| `ComboboxChip` | Displays one selected combobox value with removal behavior. |
| `ComboboxChipsInput` | Accepts typed input alongside selected chips. |
| `ComboboxTrigger` | Renders the control that opens or selects the combobox. |
| `ComboboxValue` | Displays the selected value in the combobox. |
| `useComboboxAnchor` | Hook: provides an anchor ref for positioning the combobox. |
| `ComboboxClear` | Internal component: clears the combobox selection. |

#### `components/ui/command.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Command` | Provides searchable command selection. |
| `CommandDialog` | Hosts the command palette inside a dialog. |
| `CommandInput` | Renders the editable text control in the command palette. |
| `CommandList` | Groups entries in the command palette. |
| `CommandEmpty` | Displays the no-results state for the command palette. |
| `CommandGroup` | Groups related items in the command palette. |
| `CommandItem` | Renders one item in the command palette. |
| `CommandShortcut` | Displays a keyboard shortcut for an action in the command palette. |
| `CommandSeparator` | Renders a boundary between items in the command palette. |

#### `components/ui/context-menu.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `ContextMenu` | Coordinates actions opened from a context-menu gesture. |
| `ContextMenuTrigger` | Renders the control that opens or selects the context menu. |
| `ContextMenuContent` | Wraps the content region of the context menu. |
| `ContextMenuItem` | Renders one item in the context menu. |
| `ContextMenuCheckboxItem` | Renders a checkable item in the context menu. |
| `ContextMenuRadioItem` | Renders a radio-selectable item in the context menu. |
| `ContextMenuLabel` | Renders a label within the context menu. |
| `ContextMenuSeparator` | Renders a boundary between items in the context menu. |
| `ContextMenuShortcut` | Displays a keyboard shortcut for an action in the context menu. |
| `ContextMenuGroup` | Groups related items in the context menu. |
| `ContextMenuPortal` | Renders context menu content outside the parent DOM subtree. |
| `ContextMenuSub` | Coordinates a nested submenu in the context menu. |
| `ContextMenuSubContent` | Renders nested submenu content in the context menu. |
| `ContextMenuSubTrigger` | Opens a nested submenu in the context menu. |
| `ContextMenuRadioGroup` | Groups mutually exclusive options in the context menu. |

#### `components/ui/dialog.tsx` — Reachable module

| Symbol | One-line purpose |
|---|---|
| `Dialog` | Coordinates a modal content surface. |
| `DialogClose` | Renders the control that closes the dialog. |
| `DialogContent` | Wraps the content region of the dialog. |
| `DialogDescription` | Renders supporting descriptive text for the dialog. |
| `DialogFooter` | Groups footer content in the dialog. |
| `DialogHeader` | Groups heading content in the dialog. |
| `DialogOverlay` | Renders the backdrop behind the dialog. |
| `DialogPortal` | Renders dialog content outside the parent DOM subtree. |
| `DialogTitle` | Renders the title of the dialog. |
| `DialogTrigger` | Renders the control that opens or selects the dialog. |

#### `components/ui/direction.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `DirectionProvider` | Provider: supplies text direction to compatible primitives. |
| `useDirection` | Hook: reads the current direction context. |

#### `components/ui/drawer.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Drawer` | Coordinates a sliding drawer interaction. |
| `DrawerPortal` | Renders drawer content outside the parent DOM subtree. |
| `DrawerOverlay` | Renders the backdrop behind the drawer. |
| `DrawerTrigger` | Renders the control that opens or selects the drawer. |
| `DrawerClose` | Renders the control that closes the drawer. |
| `DrawerContent` | Wraps the content region of the drawer. |
| `DrawerHeader` | Groups heading content in the drawer. |
| `DrawerFooter` | Groups footer content in the drawer. |
| `DrawerTitle` | Renders the title of the drawer. |
| `DrawerDescription` | Renders supporting descriptive text for the drawer. |

#### `components/ui/dropdown-menu.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `DropdownMenu` | Coordinates an anchored menu of actions. |
| `DropdownMenuPortal` | Renders dropdown menu content outside the parent DOM subtree. |
| `DropdownMenuTrigger` | Renders the control that opens or selects the dropdown menu. |
| `DropdownMenuContent` | Wraps the content region of the dropdown menu. |
| `DropdownMenuGroup` | Groups related items in the dropdown menu. |
| `DropdownMenuLabel` | Renders a label within the dropdown menu. |
| `DropdownMenuItem` | Renders one item in the dropdown menu. |
| `DropdownMenuCheckboxItem` | Renders a checkable item in the dropdown menu. |
| `DropdownMenuRadioGroup` | Groups mutually exclusive options in the dropdown menu. |
| `DropdownMenuRadioItem` | Renders a radio-selectable item in the dropdown menu. |
| `DropdownMenuSeparator` | Renders a boundary between items in the dropdown menu. |
| `DropdownMenuShortcut` | Displays a keyboard shortcut for an action in the dropdown menu. |
| `DropdownMenuSub` | Coordinates a nested submenu in the dropdown menu. |
| `DropdownMenuSubTrigger` | Opens a nested submenu in the dropdown menu. |
| `DropdownMenuSubContent` | Renders nested submenu content in the dropdown menu. |

#### `components/ui/empty.tsx` — Reachable module

| Symbol | One-line purpose |
|---|---|
| `Empty` | Presents an empty-content placeholder. |
| `EmptyHeader` | Groups heading content in the empty state. |
| `EmptyTitle` | Renders the title of the empty state. |
| `EmptyDescription` | Renders supporting descriptive text for the empty state. |
| `EmptyContent` | Wraps the content region of the empty state. |
| `EmptyMedia` | Wraps an icon, image, or preview in the empty state. |

#### `components/ui/field.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Field` | Groups form controls and their accessible text. |
| `FieldLabel` | Renders a label within the form field. |
| `FieldDescription` | Renders supporting descriptive text for the form field. |
| `FieldError` | Displays supplied form errors or validation messages. |
| `FieldGroup` | Groups related items in the form field. |
| `FieldLegend` | Labels a semantic group of fields. |
| `FieldSeparator` | Renders a boundary between items in the form field. |
| `FieldSet` | Groups related fields with semantic fieldset markup. |
| `FieldContent` | Wraps the content region of the form field. |
| `FieldTitle` | Renders the title of the form field. |

#### `components/ui/form.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `useFormField` | Hook: reads field identity, accessibility IDs, and validation state. |
| `Form` | Supplies React Hook Form integration context. |
| `FormItem` | Renders one item in the form. |
| `FormLabel` | Renders a label within the form. |
| `FormControl` | Connects control accessibility attributes to field state. |
| `FormDescription` | Renders supporting descriptive text for the form. |
| `FormMessage` | Displays a field validation error or supplied message. |
| `FormField` | Binds a React Hook Form controller to field context. |

#### `components/ui/hover-card.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `HoverCard` | Coordinates contextual content shown on hover. |
| `HoverCardTrigger` | Renders the control that opens or selects the hover card. |
| `HoverCardContent` | Wraps the content region of the hover card. |

#### `components/ui/input-group.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `InputGroup` | Groups a text control with adornments or actions. |
| `InputGroupAddon` | Positions an adornment beside the input control. |
| `InputGroupButton` | Renders an action button inside the input group. |
| `InputGroupText` | Renders supporting inline text in the input group. |
| `InputGroupInput` | Renders the editable text control in the input group. |
| `InputGroupTextarea` | Renders a multiline text control in the input group. |

#### `components/ui/input-otp.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `InputOTP` | Renders the segmented one-time-code entry control. |
| `InputOTPGroup` | Groups adjacent one-time-code positions. |
| `InputOTPSlot` | Displays one digit position and caret state. |
| `InputOTPSeparator` | Visually separates groups of one-time-code positions. |

#### `components/ui/input.tsx` — Reachable module

| Symbol | One-line purpose |
|---|---|
| `Input` | Renders a styled native text input. |

#### `components/ui/item.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Item` | Presents a generic content row. |
| `ItemMedia` | Wraps an icon, image, or preview in the list item. |
| `ItemContent` | Wraps the content region of the list item. |
| `ItemActions` | Groups action controls in the list item. |
| `ItemGroup` | Groups related items in the list item. |
| `ItemSeparator` | Renders a boundary between items in the list item. |
| `ItemTitle` | Renders the title of the list item. |
| `ItemDescription` | Renders supporting descriptive text for the list item. |
| `ItemHeader` | Groups heading content in the list item. |
| `ItemFooter` | Groups footer content in the list item. |

#### `components/ui/kbd.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Kbd` | Displays a keyboard key or shortcut token. |
| `KbdGroup` | Groups related items in the keyboard hint. |

#### `components/ui/label.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Label` | Renders an accessible form-control label. |

#### `components/ui/marker.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Marker` | Displays an icon/text annotation marker. |
| `MarkerIcon` | Renders the icon region of the marker. |
| `MarkerContent` | Wraps the content region of the marker. |
| `markerVariants` | Style factory: produces marker variant classes. |

#### `components/ui/menubar.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Menubar` | Coordinates a horizontal collection of action menus. |
| `MenubarPortal` | Renders menu bar content outside the parent DOM subtree. |
| `MenubarMenu` | Groups menu entries within the menu bar. |
| `MenubarTrigger` | Renders the control that opens or selects the menu bar. |
| `MenubarContent` | Wraps the content region of the menu bar. |
| `MenubarGroup` | Groups related items in the menu bar. |
| `MenubarSeparator` | Renders a boundary between items in the menu bar. |
| `MenubarLabel` | Renders a label within the menu bar. |
| `MenubarItem` | Renders one item in the menu bar. |
| `MenubarShortcut` | Displays a keyboard shortcut for an action in the menu bar. |
| `MenubarCheckboxItem` | Renders a checkable item in the menu bar. |
| `MenubarRadioGroup` | Groups mutually exclusive options in the menu bar. |
| `MenubarRadioItem` | Renders a radio-selectable item in the menu bar. |
| `MenubarSub` | Coordinates a nested submenu in the menu bar. |
| `MenubarSubTrigger` | Opens a nested submenu in the menu bar. |
| `MenubarSubContent` | Renders nested submenu content in the menu bar. |

#### `components/ui/message-scroller.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `MessageScrollerProvider` | Provider: holds message-scroller state and controls. |
| `MessageScroller` | Coordinates a scrollable message presentation region. |
| `MessageScrollerViewport` | Provides the scrollable message viewport. |
| `MessageScrollerContent` | Wraps the content measured by the message scroller. |
| `MessageScrollerItem` | Wraps one item tracked by the message scroller. |
| `MessageScrollerButton` | Offers a control for moving through message-scroller content. |
| `useMessageScroller` | Hook: reads message-scroller controls and context. |
| `useMessageScrollerScrollable` | Hook: exposes whether the message region is scrollable. |
| `useMessageScrollerVisibility` | Hook: exposes message-scroller visibility state. |

#### `components/ui/message.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `MessageGroup` | Groups related items in the message display. |
| `Message` | Presents a message layout without persistence or transport. |
| `MessageAvatar` | Displays sender identity beside the message display. |
| `MessageContent` | Wraps the content region of the message display. |
| `MessageFooter` | Groups footer content in the message display. |
| `MessageHeader` | Groups heading content in the message display. |

#### `components/ui/native-select.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `NativeSelect` | Renders a styled native select control. |
| `NativeSelectOptGroup` | Groups native select options under a label. |
| `NativeSelectOption` | Renders one native select option. |

#### `components/ui/navigation-menu.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `NavigationMenu` | Coordinates structured navigation links and panels. |
| `NavigationMenuList` | Groups entries in the navigation menu. |
| `NavigationMenuItem` | Renders one item in the navigation menu. |
| `NavigationMenuContent` | Wraps the content region of the navigation menu. |
| `NavigationMenuTrigger` | Renders the control that opens or selects the navigation menu. |
| `NavigationMenuLink` | Renders a navigation link in the navigation menu. |
| `NavigationMenuIndicator` | Shows which navigation menu entry is active. |
| `NavigationMenuViewport` | Hosts active navigation-menu panel content. |
| `navigationMenuTriggerStyle` | Style factory: produces navigation-trigger classes. |

#### `components/ui/pagination.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Pagination` | Provides navigation between result pages without fetching them. |
| `PaginationContent` | Wraps the content region of the pagination. |
| `PaginationLink` | Renders a navigation link in the pagination. |
| `PaginationItem` | Renders one item in the pagination. |
| `PaginationPrevious` | Renders navigation to the previous page. |
| `PaginationNext` | Renders navigation to the next page. |
| `PaginationEllipsis` | Indicates omitted pages in pagination. |

#### `components/ui/popover.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Popover` | Coordinates a floating anchored content surface. |
| `PopoverTrigger` | Renders the control that opens or selects the popover. |
| `PopoverContent` | Wraps the content region of the popover. |
| `PopoverAnchor` | Provides the positioning anchor for the popover. |
| `PopoverHeader` | Groups heading content in the popover. |
| `PopoverTitle` | Renders the title of the popover. |
| `PopoverDescription` | Renders supporting descriptive text for the popover. |

#### `components/ui/progress.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Progress` | Displays a supplied completion value. |

#### `components/ui/radio-group.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `RadioGroup` | Coordinates selection of one option from a set. |
| `RadioGroupItem` | Renders one mutually exclusive radio option. |

#### `components/ui/resizable.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `ResizableHandle` | Renders a drag handle between resizable panels. |
| `ResizablePanel` | Wraps one resizable panel. |
| `ResizablePanelGroup` | Coordinates the layout of resizable panels. |

#### `components/ui/scroll-area.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `ScrollArea` | Wraps content with custom scrollbars. |
| `ScrollBar` | Renders a scrollbar for the scroll-area primitive. |

#### `components/ui/select.tsx` — Reachable module

| Symbol | One-line purpose |
|---|---|
| `Select` | Coordinates styled single-option selection. |
| `SelectContent` | Wraps the content region of the select. |
| `SelectGroup` | Groups related items in the select. |
| `SelectItem` | Renders one item in the select. |
| `SelectLabel` | Renders a label within the select. |
| `SelectScrollDownButton` | Scrolls an overflowing select menu downward. |
| `SelectScrollUpButton` | Scrolls an overflowing select menu upward. |
| `SelectSeparator` | Renders a boundary between items in the select. |
| `SelectTrigger` | Renders the control that opens or selects the select. |
| `SelectValue` | Displays the selected value in the select. |

#### `components/ui/separator.tsx` — Reachable module

| Symbol | One-line purpose |
|---|---|
| `Separator` | Displays a visual or semantic boundary. |

#### `components/ui/sheet.tsx` — Reachable module

| Symbol | One-line purpose |
|---|---|
| `Sheet` | Coordinates an edge-mounted modal panel. |
| `SheetTrigger` | Renders the control that opens or selects the sheet. |
| `SheetClose` | Renders the control that closes the sheet. |
| `SheetContent` | Wraps the content region of the sheet. |
| `SheetHeader` | Groups heading content in the sheet. |
| `SheetFooter` | Groups footer content in the sheet. |
| `SheetTitle` | Renders the title of the sheet. |
| `SheetDescription` | Renders supporting descriptive text for the sheet. |
| `SheetPortal` | Internal component: portals sheet content outside its parent layout. |
| `SheetOverlay` | Internal component: renders the sheet backdrop. |

#### `components/ui/sidebar.tsx` — Reachable module

| Symbol | One-line purpose |
|---|---|
| `Sidebar` | Provides the responsive application sidebar surface. |
| `SidebarContent` | Wraps the content region of the sidebar. |
| `SidebarFooter` | Groups footer content in the sidebar. |
| `SidebarGroup` | Groups related items in the sidebar. |
| `SidebarGroupAction` | Positions an action control in the sidebar. |
| `SidebarGroupContent` | Wraps the content region of the sidebar. |
| `SidebarGroupLabel` | Renders a label within the sidebar. |
| `SidebarHeader` | Groups heading content in the sidebar. |
| `SidebarInput` | Renders the editable text control in the sidebar. |
| `SidebarInset` | Wraps main content positioned alongside the sidebar. |
| `SidebarMenu` | Groups menu entries within the sidebar. |
| `SidebarMenuAction` | Positions an action control in the sidebar. |
| `SidebarMenuBadge` | Displays a compact value/status beside the sidebar entry. |
| `SidebarMenuButton` | Renders an action button inside the sidebar. |
| `SidebarMenuItem` | Renders one item in the sidebar. |
| `SidebarMenuSkeleton` | Displays a sidebar menu loading row. |
| `SidebarMenuSub` | Groups nested sidebar menu entries. |
| `SidebarMenuSubButton` | Renders an action/link inside a nested sidebar menu. |
| `SidebarMenuSubItem` | Wraps one nested sidebar menu entry. |
| `SidebarProvider` | Provider: owns desktop/mobile sidebar state and keyboard toggling. |
| `SidebarRail` | Provides the sidebar edge control for toggling its state. |
| `SidebarSeparator` | Renders a boundary between items in the sidebar. |
| `SidebarTrigger` | Renders the responsive sidebar toggle button. |
| `useSidebar` | Hook: reads responsive sidebar state and toggle controls. |

#### `components/ui/skeleton.tsx` — Reachable module

| Symbol | One-line purpose |
|---|---|
| `Skeleton` | Displays a loading placeholder. |

#### `components/ui/slider.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Slider` | Selects numeric values on a track. |

#### `components/ui/sonner.tsx` — Reachable module

| Symbol | One-line purpose |
|---|---|
| `Toaster` | Renders the application toast host with theme-aware styling. |

#### `components/ui/spinner.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Spinner` | Displays an animated busy indicator. |

#### `components/ui/switch.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Switch` | Renders a binary on/off control. |

#### `components/ui/table.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Table` | Provides a styled semantic data table. |
| `TableHeader` | Groups heading content in the table. |
| `TableBody` | Groups body rows in the table. |
| `TableFooter` | Groups footer content in the table. |
| `TableHead` | Renders a header cell in the table. |
| `TableRow` | Renders a row in the table. |
| `TableCell` | Renders a data cell in the table. |
| `TableCaption` | Renders the caption for the table. |

#### `components/ui/tabs.tsx` — Reachable module

| Symbol | One-line purpose |
|---|---|
| `Tabs` | Coordinates selection between tabbed views. |
| `TabsList` | Groups entries in the tabs. |
| `TabsTrigger` | Renders the control that opens or selects the tabs. |
| `TabsContent` | Wraps the content region of the tabs. |
| `tabsListVariants` | Style factory: produces tab-list variant classes. |

#### `components/ui/textarea.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Textarea` | Renders a styled multiline text input. |

#### `components/ui/toggle-group.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `ToggleGroup` | Coordinates a group of toggle buttons. |
| `ToggleGroupItem` | Renders one item in the toggle group. |

#### `components/ui/toggle.tsx` — **Unused module**

| Symbol | One-line purpose |
|---|---|
| `Toggle` | Renders a pressed/unpressed action control. |
| `toggleVariants` | Style factory: produces toggle variant classes. |

#### `components/ui/tooltip.tsx` — Reachable module

| Symbol | One-line purpose |
|---|---|
| `Tooltip` | Coordinates a short contextual hint. |
| `TooltipTrigger` | Renders the control that opens or selects the tooltip. |
| `TooltipContent` | Wraps the content region of the tooltip. |
| `TooltipProvider` | Provider: supplies shared state for the tooltip. |

### 1.7 Dead code and duplication summary

- **Unused:** 49 UI modules above; `getDb()`, `usePoll()`, product sign-out helper, `selectedRef`, discarded scroll `last`, and the returned-but-unrendered owner name.
- **Dormant generated tooling:** pnpm installation path; npm is the active lockfile/workflow. Do not delete generic tooling solely because one execution profile does not use it.
- **Duplicated contracts/behavior:** Drizzle schema versus handwritten result/client types; branding defaults in browser and seed; raw DB versus unused ORM wrapper; three polling loops beside an unused shared hook; shared response data repeatedly fetched by independent requests.
- **Intentional UI reuse:** desktop/mobile details render the same JSX; public demo, embed, and preview reuse `Messenger`. These are not duplicate backend services.
- **Potentially stale presentation:** old CSS selectors, generic package name, decorative presence/read indicators, and README deployment/retry claims. Static import reachability is stronger evidence for unused modules than CSS-name inspection is for safe selector deletion.

## 2. Trace: customer message → agent → reply → customer

### 2.1 Every hop and transport

Assumptions: local DB has the initial migration; the owner has initialized `main`; the deployment allows visitors to reach `/embed` and `/api/visitor`. None of these prerequisites is automatically ensured by the install snippet.

| Hop | Code / operation | Transport | State and durability |
|---|---|---|---|
| 1. Host installs messenger | Host loads `/widget.js`; loader appends button and iframe with `/embed` URL. | HTTP(S) script request, then HTTP(S) iframe document/assets. | Button visibility lives in host DOM; no durable state or ready handshake. The iframe loads even while hidden. |
| 2. Messenger boots | `Messenger` requests `/api/visitor?config=1`, reads `relay-visitor-session`. | Same-origin fetch from iframe to Relay; browser localStorage access. | Branding goes into React state; previously acknowledged visitor ID/token may survive in localStorage. |
| 3. Customer types | Name, email, and text are collected by React controls. | Browser events only. | Unsaved input is RAM only; email is syntactically checked, not verified. |
| 4. First send builds request | `Messenger.send()` creates UUID and a token made from two UUIDs; retains them in `pending.current`. | In-process function call. | Retry key/token/text are RAM only; no durable outbox before network send. |
| 5. First send crosses API boundary | `api()` sends `action=start`, name/email/text/messageId/token to `/api/visitor`. | HTTP(S) POST JSON; Origin is checked if supplied. | Server validates Zod schema/settings and hashes token. This first call has no pre-existing visitor authentication. |
| 6. Server creates chat | Visitor POST derives `chat-<messageId>`, checks existing token, then D1-batches conversation and first-message inserts. | Worker → D1 binding SQL API. | Conversation, credential hash, and message become authoritative DB state together. No outbox/event is written. |
| 7. Customer receives start acknowledgement | API returns HTTP 201 `{id}`; client writes ID/token to localStorage, sets session, clears input, starts polling. | HTTP response, then browser storage/state operations. | Plain token becomes locally durable only after response; there is a commit-to-localStorage failure window. |
| 8. Agent polls inbox | `Inbox` list effect issues `GET /api/inbox`; `admin()` checks identity/owner; SQL reads every conversation and a latest-body preview. | HTTP(S) GET JSON → Worker → D1 SQL → JSON. | Whole list/settings copied into agent React state; no push notification or persisted delivery acknowledgement. |
| 9. Agent opens thread | `pick()` selects ID and asynchronously POSTs `action=update, read=true`; detail effect GETs `?conversation=id`. | Separate HTTP POST and GET, with independent SQL operations. | Shared `unread=0` persists; full part history becomes another client snapshot. These requests are not one transaction. |
| 10. Agent composes reply | Inbox draft map records text under conversation/mode; send creates/reuses pending UUID. | Browser events and in-process state. | Draft and key exist only in that tab's RAM. `kind=note` uses the same flow but remains private. |
| 11. Agent sends reply | Inbox POST validates owner and conversation, then batches `INSERT OR IGNORE messages` and `UPDATE conversations`. | HTTP(S) POST JSON → D1 SQL batch. | Reply body/kind/sender=`You`/server timestamp persist; updated time and unread flag also change. |
| 12. Agent sees acknowledgement | API returns `{ok:true}`; client clears the draft and restarts list/detail polls. | HTTP response, then new GETs. | Toast is acknowledgement of the API response; it is not proof the customer received the reply. |
| 13. Customer polls for reply | Messenger sends `GET /api/visitor` with `x-conversation-id` and bearer token. | HTTP(S) GET → token hash lookup → D1 history query. | Query selects only `agent`/`visitor` parts; all public history/status/settings returned again. |
| 14. Customer renders reply | Poll replaces React messages/status; `timeOf()` formats the stored timestamp. | JSON parsing and React render. | Server remains authoritative; there is no customer read receipt written back. |
| 15. Customer sends subsequent text | `action=send` validates session; existing message ID is checked; batch inserts and sets open/unread/updated time. | HTTP(S) POST JSON → D1 SQL batch. | After acknowledgement, client adds an optimistic copy with browser `Date.now()`; a later poll replaces it with the server record. |

Both inbox loops and the visitor loop schedule the next request **two seconds after the previous request finishes**. They do not guarantee a two-second delivery bound: response latency, throttled background tabs, outages, and suspended devices add delay. No WebSocket, SSE, broker, service worker, server subscription, or delivery worker participates.

D1 documents `batch()` as transactional: failure of a statement rolls the batch back. This protects conversation/message updates within each batch, but does not include the earlier existence checks or later HTTP acknowledgement. A network timeout still leaves the caller unsure whether the transaction committed. [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

### 2.2 Where state is duplicated

| State | Copies and implications |
|---|---|
| Customer identity | Name/email stored on each conversation, name copied into each visitor message's `sender`, name/email also held in the form; no shared contact identity or merge behavior. |
| Conversation metadata | Authoritative row, agent list snapshot, agent detail snapshot, visitor status snapshot, and optimistic detail patches; independently refreshed copies can disagree temporarily. |
| Message body | Authoritative message row, computed latest preview, agent detail array, visitor array, draft/pending objects, and occasional optimistic visitor record. |
| Branding | Workspace row, seed defaults, browser defaults, inbox/config form state, visitor config response, and every visitor poll response. |
| Credentials | Plain token in pending ref and later localStorage/session; only its hash in D1. The hash cannot recover a lost plaintext token. |
| Read/delivery state | One global unread flag; visual checkmarks have no corresponding per-user delivery/read state. |

The admin detail row and message list are separate reads, so a concurrent mutation can yield snapshots from different moments. An older visitor poll can briefly replace an acknowledged optimistic message before the next poll restores it. Switching threads during `update()` can apply the local optimistic patch to the wrong visible detail until refresh. These are client consistency issues, not evidence that D1 loses the committed message.

### 2.3 Restart and failure matrix

| Interruption point | Current result | Missing protection |
|---|---|---|
| Owner absent / DB uninitialized | Visitor config/start return 503; visiting a page alone does not install schema. | Explicit provisioning and readiness; seeding should not be a side effect of an authenticated read. |
| Browser/iframe reload while typing | Name/email/text, inbox drafts, selected view, and pending UUIDs disappear. | Durable drafts/pending operations where required. |
| First request never reaches server | No message exists; same-tab retry can reuse pending key; reload loses it. | Persist request identity before sending. |
| Worker restarts before/during DB request | Request may fail or its outcome may be unknown; a failed D1 batch does not leave half that batch committed. | Durable idempotency result and reconciliation for unknown outcomes. |
| First send commits, response is lost, then visitor reloads | Row remains in D1, but no localStorage session was saved; lost token makes that conversation inaccessible to this visitor. Retyping may create a second chat. | Persist first token/key before sending and recover the operation result. |
| First send commits, localStorage write throws | `setSession()` is skipped; same tab retains pending key but reload can orphan access. | Storage-failure handling and an explicit supported session/recovery strategy. |
| Agent reply commits, response is lost | Reply exists; retry with the same in-memory UUID avoids another row but still updates time/unread. Reload loses the key, so manual resend may duplicate. | Idempotency for the whole mutation and durable client pending identity. |
| Subsequent visitor send commits, response is lost | Sequential same-key retry returns success without another insert; reload loses the pending key although an existing saved session can recover history. | Stable pending-operation recovery and payload equality checks. |
| Concurrent duplicate requests | Prechecks are outside the batch; both can pass. `INSERT OR IGNORE` suppresses a row but associated metadata writes can still repeat. | Transactional operation claim, payload fingerprint, stable response, and race tests. |
| Process restarts after successful commit/ack | D1 rows survive; future polls can recover them. Browser state survives only if stored or if the tab remains alive. | No special server-RAM replay exists or is needed for committed rows; transient delivery still needs replay/cursors. |
| Agent browser restarts | Authentication may recover through platform flow; saved history returns; drafts and retry keys do not. | Draft/outbox persistence and canonical mutation responses. |
| Host page reloads or browser partitions storage | Loader state resets; existing visitor identity depends on that embedding context's storage access/partition. | Real cross-origin installation tests and documented session lifecycle. |
| Poll or mutation hangs | Shared fetch has no timeout/abort; the loop waits and send can remain busy until fetch settles. | Timeouts, cancellation, backoff, and explicit recoverable pending status. |
| Local runtime state directory removed | Local database data disappears; this is storage loss, not an ordinary Worker restart. | Reproducible migrations/seeds and a separate backup/restore policy for deployed data. |

There is no enqueue-to-consumer restart window because no queue exists. There is also no notification guarantee beyond a future successful poll. Hiding the external iframe does not unmount its app, so its polling can continue while closed.

### 2.4 Retry correctness and privacy boundaries

- `messageId` is a useful partial deduplication mechanism, but not a complete idempotency contract. Same-key requests with changed text are not rejected consistently, no response/result is stored, and keys are not scoped by workspace/operation.
- Agent send always updates conversation metadata even when insertion is ignored. A message UUID belonging to another conversation can cause a success response and update the requested conversation without inserting its reply.
- Sequential visitor-send retries short-circuit; concurrent retries can both pass the precheck and repeat reopen/unread/time updates. Two start requests using the same ID but different tokens can both pass the precheck before one wins insertion; the losing token can receive a success response it cannot subsequently use.
- State/settings writes have no client idempotency key or concurrency version. Even an assignment that appears naturally idempotent can replay after a newer agent change and overwrite it.
- Private notes are filtered on the server in visitor history. The current SQL `A AND kind='agent' OR A AND kind='visitor'` works for the repeated conversation predicate. Adding a tenant condition to only one side would be unsafe; use a grouped predicate or `kind IN (...)` when that refactor is authorized.
- Agent access is a singleton owner check. There is no supported second workspace to isolate today; this must not be mistaken for a proven cross-workspace authorization boundary.

## 3. Gap analysis against the target surface

**Definitions:** Present = the named narrow capability works in the prototype; Partial = a subset or UI approximation exists; Absent = no domain implementation. Present does not mean production-ready or scalable. **Engineer-days** estimate incremental work to ship a small, tested, operable version of each capability **after the shared foundations in section 5**. They include normal implementation/tests, but exclude vendor approval delays, major design research, migration of unknown production datasets, and proving the entire platform at target scale. Ranges overlap and must not be summed into a delivery promise. They are engineering judgment, not a vendor quote.

| Capability | Status | One-line gap / existing behavior | Engineer-days |
|---|---|---|---:|
| Workspaces | Partial | One hardcoded settings/owner row; no tenant creation, switching, membership scope, or lifecycle. | 8–15 |
| Teammates | Absent | Owner-only access and literal `owner` assignment; no invitations or teammate records. | 8–15 |
| Contacts | Partial | Name/email repeated on conversations; no stable contact record, identity resolution, or merge. | 8–15 |
| Companies | Absent | No organization entity or contact/company relationships. | 4–8 |
| Custom attributes | Absent | Fixed fields and one tag; no typed definitions, values, validation, or indexing. | 6–12 |
| Custom objects | Absent | No tenant-defined schemas, records, relationships, or permissions. | 15–30 |
| Events | Absent | No product-event ingestion or immutable conversation lifecycle stream. | 8–15 |
| Segments | Absent | No saved customer predicates, audience evaluation, or refresh jobs. | 12–25 |
| Conversations with typed parts | Partial | Three text kinds exist; no structured events, attachments, typed payload versions, or stable actors. | 8–15 |
| Conversation states | Partial | Open/closed and reopen-on-visitor-send; no transition ledger, pending/snoozed semantics, or concurrency control. | 5–10 |
| Realtime delivery | Partial | Full-history polling works; no push, cursor replay, delivery receipts, or durable event fanout. | 15–30 |
| Embeddable messenger | Partial | Script/iframe works structurally; missing tenant boot configuration, signed identity, domain/session policy, and external-browser tests. | 10–20 |
| Agent inbox | Partial | Working single-agent list/thread/resolve/priority UI; lacks pagination and multi-agent consistency. | 10–20 |
| Inbox views | Partial | Fixed browser-side filters only; no saved/shared views, server predicates, or counts. | 8–15 |
| Macros | Absent | No reusable reply/action templates or permissions. | 5–10 |
| Internal notes | Present | Text notes persist and are excluded from visitor reads; actor identity, mentions, and multi-agent behavior remain. | 3–6 |
| Tickets | Absent | No ticket types, fields, lifecycle, ownership, or conversation links. | 15–25 |
| SLAs | Absent | No policies, due-time calculation, business calendars, pauses, breach jobs, or history. | 15–30 |
| Routing | Partial | Manual owner/unassigned toggle only; no team queues, rules, or fair assignment. | 10–20 |
| Workload management | Absent | No capacity, agent availability, load counters, or rebalancing. | 12–25 |
| Help center | Absent | No article authoring, publication, locales, navigation, or public search. | 15–30 |
| Knowledge store for AI | Absent | No source ingestion, chunking, versioning, retrieval ACLs, or vector index. | 15–30 |
| AI answering agent | Absent | No retrieval/generation orchestration, grounding, escalation, evaluation, or cost tracking. | 25–50 |
| AI actions against external systems | Absent | No connector credentials, scoped tools, authorization, execution receipts, or replay controls. | 20–40 |
| Agent copilot | Absent | Browser WebMCP tools are not suggestions, summaries, drafting, or an in-product assistant. | 15–30 |
| Visual workflow builder | Absent | No graph model/editor, versioned execution, timers, or resume semantics. | 35–70 |
| Email channel | Absent | Visitor email is metadata only; no inbound threading, outbound provider, bounce, or delivery processing. | 20–40 |
| WhatsApp channel | Absent | No provider integration, approved templates, consent, or message-status ingestion. | 15–30 |
| SMS channel | Absent | No sending/receiving provider, number management, consent, or delivery events. | 8–15 |
| Social channels | Absent | No provider adapters or identity mapping; estimate is for one network, not every network. | 20–35 |
| Voice channel | Absent | No telephony, calls, recording consent, media, transcription, or agent controls. | 35–70 |
| Outbound messaging | Absent | No campaigns, audience snapshots, scheduling, throttling, unsubscribe, or outcome tracking. | 20–40 |
| Proactive messaging | Absent | No page/event triggers, frequency caps, targeting, or experiment controls. | 10–20 |
| Reporting | Absent | Sidebar counts are client-derived operational UI, not historical reporting or trusted metrics. | 20–40 |
| Public API | Absent | Private UI endpoints have no versioning, scoped API keys, public contract, quotas, or pagination. | 15–25 |
| Webhooks | Absent | No signed subscriptions, event delivery, retries, DLQ, or replay UI. | 10–20 |
| App framework | Absent | No install model, OAuth scopes, extension lifecycle, SDK, or marketplace; two browser tools are insufficient. | 30–60 |
| SSO | Absent | ChatGPT login is platform auth, not tenant-configurable enterprise SAML/OIDC SSO. | 10–20 |
| Roles | Absent | Owner check only; no membership roles or capability permissions. | 8–15 |
| Audit log | Absent | Console error output is not an append-only actor/action/resource audit history. | 8–15 |
| Data deletion | Absent | No deletion API/job, retention, export inventory, or propagation to downstream stores. | 12–25 |
| Seat billing | Absent | No subscription, billable seat definition, entitlement sync, or payment-provider integration. | 10–20 |
| Usage billing | Absent | No authoritative usage events, deduplication, aggregation, pricing versions, or reconciliation. | 15–30 |

## 4. Load-bearing decisions

### 4.1 Scale assumptions and capacity limits

The target is **10,000 workspaces and 50 million conversation parts**, not a measured concurrent-user requirement. Retention, body-size distribution, hot-tenant skew, concurrent agents/visitors, regional needs, and latency objectives still need explicit decisions.

Even an illustrative average of **500 bytes per part** yields **25GB** for 50 million parts before indexes and other data. Cloudflare documents a maximum **10GB per paid D1 database**, with an individual database processing queries one at a time. The current single binding is therefore not a credible long-term store for that assumed dataset. D1 can scale through multiple databases, but that is a different architecture with placement/routing and migration coordination. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

For a separate illustrative concurrency case, 10,000 active agents each polling a list and detail every two seconds generate roughly 10,000 GETs/second; 10,000 active visitors add roughly 5,000. Actual cadence includes request time. This is not a traffic forecast, but it shows why downloading all rows on each poll is untenable even before choosing a push transport.

### 4.2 Decision register

| Decision | What the code does now | Survives target? | Change now while inexpensive |
|---|---|---|---|
| Primary keys | Text PKs; client UUID message IDs; conversation ID derived from first message UUID; `main` workspace and fixed sample IDs. | UUID space itself is adequate; coupling resource identity to retry keys and globally fixed seed IDs is not. There is no stable per-conversation ordering beyond timestamp/ID. | Keep existing opaque IDs; separate resource IDs from workspace/operation-scoped idempotency keys, store request fingerprints/results, add tenant-composite constraints and a conversation sequence. Evaluate time-ordered IDs for new records only if useful; a wholesale UUID rewrite has little immediate value. |
| Tenancy model | One database, global tables, singleton owner; conversations/messages have no tenant column and SQL is globally scoped. | **No.** There is no multi-tenant boundary or storage placement strategy. | Establish shared-table workspace context, scoped repositories, composite references, and isolation tests first. Decide a managed shared-schema PostgreSQL target versus deliberately sharded D1 before accumulating production tenants; see the smaller/larger path below. |
| Realtime transport | Independent two-second HTTP full-list/full-history polls. | **No at the illustrative active load**, and no bounded recovery/delivery contract. | First add pagination, delta cursors, server filters/counts, timeouts, and backoff. Then add authorized WS/SSE subscriptions backed by durable event cursors/outbox and replay; transient fanout must never be the sole record. |
| Full-text search | Browser substring matching on downloaded name/email/title/latest preview; no history search. | **No.** Client scanning is unbounded and incomplete. | Define tenant/visibility-scoped search contracts and stable indexed resource IDs. Start with bounded database search where adequate; choose native FTS or an external search projection using measured corpus/query needs. Make projections rebuildable and deletions explicit. |
| Vector search | No embeddings, vectors, model versions, or retrieval pipeline. | **Absent.** | Reserve a retrieval interface requiring workspace and visibility context; defer implementation to the knowledge/AI phase. Plan versioned embeddings, source references, reindexing, and deletion propagation; filter by authorization before retrieval results reach a model. |
| Analytics store | No analytics database; current counts/filtering derive in the browser from application reads. | **No historical analytics capability.** Heavy future reports must not scan hot message tables synchronously. | Establish durable event IDs/time semantics and server-owned operational counters. Later project events to a separate analytical store; keep financial/usage truth in authoritative server records and reconcile projections. Do not build a warehouse during chat foundations. |
| Files and scanning | Text only; R2 unset, BUCKET declaration unused, no upload/attachment metadata or scanner. | **Absent.** | Define attachment IDs, tenant ownership, quarantine/scan states, and authorized download contracts. In the attachment phase use private object storage plus scan jobs; only release clean objects, with limits and cleanup/deletion. Do not embed files in message rows. |
| Job queue and guarantees | No runner/queue/outbox; all server work is synchronous. | **No.** Slow work, retries, and delivery recovery have no durable owner. | Choose a supported durable queue and atomic DB outbox; consumers need idempotency, bounded retries/backoff, dead letters, readable status, and per-resource ordering where needed. Classify slow operations before execution rather than trying to undo a write once 200ms elapses. |
| Internationalisation | Fixed `lang=en`, hardcoded English strings, implicit browser locales/timezones, and physical right-positioning in loader. | Workspace count alone is not the issue; **not suitable for a multilingual product**. | Add locale/timezone settings and a message-catalog boundary before copy spreads; use locale-aware display and RTL-capable layout, stable machine enums, and Unicode-aware validation. Never translate stored customer content implicitly. |
| Timestamps/timezones | Server epoch milliseconds for DB writes; no originating timezone; browser-relative labels and optimistic visitor timestamp; no immutable transition history. | Numeric instants scale, but **business-hour/human-performance calculations cannot be reconstructed correctly**. | Store authoritative UTC instants plus validated IANA origin timezone; distinguish occurrence/receipt times where needed. Define versioned calendars, holidays, pauses, and event history before introducing evaluated durations. Mark historic unknown zones as unknown, not guessed. |
| Plan-based feature gating | No rollout flags, plans, entitlements, quotas, or metering; UI visibility is unconditional. | **No.** | Separate tenant authorization, default-off rollout flags, plan entitlements, and usage limits; enforce all decisions server-side and return display capabilities to UI. Defer billing integration, but reserve stable capability keys and authoritative usage-event IDs. |

#### Smaller change before a database/platform replacement

1. Keep the current UI and HTTP routes while introducing an explicit workspace context, scoped data-access boundary, bounded queries, and correct idempotent transactions. Retain existing IDs and data; add fields, backfill, and move reads/writes in stages.
2. Make the storage/hosting decision against actual capacity and operational requirements **before** the first multi-tenant production rollout. For the stated broad product target, shared-schema PostgreSQL with tenant constraints, optional row-level security as defense in depth, and a measured indexing/partitioning plan is the simpler default to evaluate. It is a proposal, not an authorized stack change or a guarantee that one database meets all load goals. PostgreSQL row policies require careful runtime-role configuration: table owners and privileged roles can bypass them. [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
3. If retaining D1, explicitly design a workspace-to-database registry, placement and hot-tenant policy, shard-aware IDs/routing, migrations/backups across shards, and analytics/search projections. Do not assume one static binding per workspace scales indefinitely: the platform's documented binding constraints also need to be included in the design. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

The existing Sites configuration exposes only the current D1 setup; it does not provision queues, Durable Objects, R2, or PostgreSQL. Confirm deployment support and service integration before selecting an implementation. A transport/storage interface is useful now; speculative adapters for every future backend are not.

Candidate indexes should lead with the actual authorization boundary: for example, `(workspace_id, status, updated_at, id)` for a status-filtered inbox cursor and `(workspace_id, conversation_id, sequence)` for ordered part retrieval. Confirm these against the chosen filters and query plans; adding indexes blindly increases write and storage costs. The current `(conversation_id, created_at)` index helps history lookup but does not bound the returned history.

#### Queue, ordering, and external side effects

If Cloudflare Queues is selected, its documented contract is **at-least-once**, and ordering is not guaranteed. A queue choice cannot itself provide exactly-once external actions. Use a stable event/operation ID, idempotent consumers/provider keys, receipts, and recovery/reconciliation; use conversation sequence numbers where ordering matters. Persist the outbox and domain change together, then let delivery retry independently. [Queue delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/), [how Queues works](https://developers.cloudflare.com/queues/reference/how-queues-works/)

An honest UI status distinguishes accepted, pending, delivered, failed, and retryable outcomes according to evidence. The existing double-check icon must not be treated as proof of any of these states.

### 4.3 Conflicts with the standing phase rules

| Rule | Current conflict | Smallest corrective direction |
|---|---|---|
| Every table/query is workspace-scoped; cross-workspace read must fail | No child table has workspace ownership; owner guard is global; no isolation test. | Add tenant ownership/backfill plus scoped access and composite references; test two workspaces, agent and visitor paths, notes, and attempted cross-tenant references. Clarify root-workspace/system-table convention. |
| Additive migrations and rollback | One initial forward migration; no rollback or staged cutover process. | Document expand/backfill/switch phases and a data-preserving application rollback; postpone constraint/removal steps until compatibility is proven. |
| Retriable writes use client idempotency keys | Only message UUID deduplication, with incomplete side-effect coverage; updates/settings have none. | Persist operation key, normalized request fingerprint, canonical response, and transaction result; reject mismatched replay. |
| Work over 200ms is a retried observable background job | No timing, queue, retries, DLQ, or status endpoint. | Clarify measurement and response expectation; classify known slow work, instrument request latency, then add the smallest durable job path actually needed. |
| Money, time, counts computed server-side | Browser computes inbox counts and relative times; optimistic timestamps use browser clock; money is not implemented. | Return canonical mutation timestamps/counts and server-owned timing metrics; decide whether locale formatting/relative display is included in the prohibition. |
| UTC plus originating timezone; business-hour duration support | Epoch timestamps lack originating timezone; availability is free text; state changes have no history. | Record origin and immutable transitions now; confirm calendars before calculating judged durations. |
| Feature flag defaults off | No feature flag or server capability evaluation. | Add one server-enforced phase flag per workspace and a gated UI capability response. |
| Migration/rollback, seed, unit, happy/failure E2E, CHANGELOG each phase | Only migration plus runtime samples and ignored HTTP assertions exist. | Make those artifacts committed release acceptance criteria; move samples to explicit, reproducible seeds. |
| No later-phase scaffolding | Broad catalog exists, but most target features do not. | Do not count catalog modules as features; keep future boundaries as documented interfaces/TODOs with an owner phase. |

**Decisions requiring clarification before implementation:** what “phase 1” contains; whether every-table tenancy includes a self-referencing `workspace_id` on the root workspace and operational metadata; whether 200ms means server processing, a percentile budget, or end-to-end latency; permitted browser time formatting; workspace versus customer origin timezone; calendar/holiday/pause rules for judged durations; data-preserving rollback expectations; production identity and hosting choice. The audit does not silently choose product answers to these questions.

## 5. Refactors required before phase 1, in order

This is a recommended foundation sequence for a multi-tenant chat phase, **not an implementation plan already authorized**. Phase 1 has not yet been defined. No refactors below have been started. Larger product capabilities in section 3 retain their own later phases.

| Order | Refactor / exit condition | Why postponing increases cost |
|---:|---|---|
| 1 | **Make the baseline reproducible and reviewable.** When authorized, establish the repository source of truth, document local setup, commit a test runner, migration/rollback conventions, explicit seed fixtures, and CHANGELOG. Preserve current behavior with focused API tests and one real browser chat happy path/failure path. | Every later change otherwise relies on an unshared checkout and manual knowledge; regressions and migration drift compound before there is a reliable baseline. |
| 2 | **Decide storage/hosting fit and isolate data access.** Retain the UI; move raw handler SQL behind a small workspace-requiring boundary, choose one schema/DTO authority, and document the D1-sharding versus relational-store decision. | Tables, integrations, query dialects, and operational tooling spread database assumptions; switching after large message volume adds data migration and dual-write risk. |
| 3 | **Add tenancy and explicit provisioning.** Add/backfill workspace ownership, tenant indexes/composite references, workspace-aware admin/visitor resolution, and two-workspace isolation tests. Replace first-GET ownership claim/sample insertion with explicit initialization. | Missing ownership on historical rows makes later backfills ambiguous; every new endpoint and index otherwise repeats an unsafe global-query pattern. |
| 4 | **Separate authentication, authorization, and visitor lifecycle.** Define membership/actor references, minimum capabilities for the chat phase, short/scoped visitor boot/session contracts, revocation and domain policy; verify trusted-header deployment boundary. | Literal `owner`, `You`, and unverified email get baked into messages and integrations, making actors, permissions, and customer identity hard to reconstruct. |
| 5 | **Make retryable writes transactional and fully idempotent.** Require scoped client keys for all retryable mutations, compare request fingerprints, store canonical outcomes, handle concurrent claims, and protect updates with versions where needed. Add duplicate/conflict/commit-before-ack tests. | Downstream jobs, billing, webhooks, and AI actions amplify duplicate effects; repairing historical wrong state is harder than preventing a second effect at ingress. |
| 6 | **Persist pending client operations safely.** Save the first token/key before the first send, recover acknowledged/unknown outcomes, handle storage denial, and retain drafts according to an explicit policy. Guard optimistic updates by conversation ID. | More clients/channels multiply orphaned sessions and duplicate resend behavior; a later protocol change requires coordinated client upgrades. |
| 7 | **Stabilize the conversation contract.** Add typed-part version/visibility/actor boundaries, stable ordering and transition events without implementing every future subtype. Preserve current agent/visitor/note behavior and old IDs. | Tickets, SLAs, AI, channels, and reporting would otherwise infer history from mutable state and free-text senders, losing facts that cannot be backfilled reliably. |
| 8 | **Bound reads and centralize computation.** Add tenant-scoped cursor pagination, delta reads, server filters/counts, canonical timestamps and mutation responses; consolidate polling with timeout/backoff/cancellation. | Unbounded endpoints become client contracts, memory/latency costs rise with every part, and later pagination breaks multiple consumers. |
| 9 | **Establish the minimum durable work/delivery boundary.** Select a supported queue and transactional outbox for actual slow operations/event delivery; require retry, DLQ, job status, observability, and idempotent consumers. Only introduce push if phase 1 requires it, after replay semantics exist. | Fire-and-forget side effects lose work on restarts and force bespoke recovery logic into every integration; switching transports alone would hide the same durability problem. |
| 10 | **Define time, locale, and calendar foundations.** Persist UTC/origin zones and versioned transition facts; externalize UI strings and configure display locale. Define business-calendar interfaces now, implement SLA arithmetic only in its phase. | Historical timezone/calendar facts cannot be inferred accurately; distributed hardcoded strings and browser-clock calculations make reliable metrics and translation increasingly expensive. |
| 11 | **Add default-off rollout and server capability evaluation.** Gate the phase per workspace; separate authorization from rollout and eventual plan/usage limits. Test disabled-feature reads/writes and tenant differences. | UI-only feature switches and scattered plan checks become inconsistent security/charging decisions once more surfaces and channels exist. |
| 12 | **Close the release loop and trim confirmed dead code.** Run tenant isolation, concurrent retry, note privacy, true external embed happy path, and a lost-ack/recovery failure test; validate migrate/rollback/reapply and seed repeatability. Remove only confirmed unused helpers/catalog/dependencies, split the monolithic Inbox, and correct README claims. | Unused code and inaccurate docs confuse future audits; missing failure/rollback coverage grows risk with each schema and integration change. Cosmetic extraction should not displace the earlier correctness work. |

### Migration and rollback constraints for this sequence

Propose additive columns/tables first, backfill the singleton's rows to a real workspace deterministically, dual-write where necessary, verify counts/ownership, then switch reads behind the default-off flag. Do not drop or rename the old fields in the same deploy. A rollback should disable the new path and restore the previous compatible application behavior while **preserving newly written data**; any later schema contraction is a separate, reviewed release. For tenant rollout, rollback must never re-enable globally unscoped reads against multi-tenant data. SQLite constraint changes and any cross-database cutover need an explicit migration design, not an assumption that a destructive reverse SQL file is acceptable.

The audit creates no schema migration: it changes no schema. Each subsequent implementation phase must supply its actual forward/rollback procedure, deterministic two-workspace seeds, unit tests, happy-path E2E, main failure-path test, and CHANGELOG entry. An isolation test must demonstrate that an authenticated workspace A principal cannot retrieve a workspace B conversation/part even when it knows the ID, and must cover visitor tokens and private-note visibility separately.

### Boundaries to document now; implementations owned by later phases

| Boundary / TODO | Later owning phase |
|---|---|
| `Search` contract with workspace, visibility, pagination, stable source IDs, and deletion semantics | Search/knowledge phase; no vector adapter yet. |
| `AttachmentStore` contract with tenant ownership, quarantine, scan status, and authorized download | Attachments/channel phase; no unused scanner scaffold. |
| Business-calendar contract for wall-clock/business-hour intervals and policy versions | Tickets/SLA phase; record required timestamp facts in foundations. |
| Usage-event and entitlement contracts with immutable IDs and server evaluation | Billing phase; no payment provider integration yet. |
| Channel adapter contract for provider IDs, retries, typed parts, and delivery receipts | Omnichannel phase; no speculative email/WhatsApp/SMS implementations. |
| Knowledge retrieval/action authorization boundaries | AI phases; no model integration, external action executor, or workflow engine yet. |

**Handoff:** first confirm phase-1 scope and the unresolved decisions in section 4.3. Then implement the smallest approved foundation slice with its release artifacts. This session ends with this report; it does not begin that work.
