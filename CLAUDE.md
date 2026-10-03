# Relay

A customer communication and support platform — an alternative to Intercom.

## Build plan

The product is being built in 18 phases, numbered 00–17. The full plan and
the prompt for each phase is in `docs/BUILD_PHASES.md`. Read the relevant
phase before starting work. Phase 04 has its own detailed plan in
`docs/AGENT_INBOX_PLAN.md` (steps A–D); step A's handoff is
`docs/AGENT_INBOX_STEP1.md`. Verified progress is in `docs/STATUS.md`.
`docs/INTERCOM_GAP_AUDIT.md` compares Intercom with Relay (October 2026); its
additions are marked inside each phase of `docs/BUILD_PHASES.md`.

Current position: phase 07 (help center and knowledge store, `docs/KNOWLEDGE_PLAN.md`) is complete
locally: steps A1, A2, B1, B2, C1a, C1b, C2a and C2b (`docs/KNOWLEDGE_STEP1.md` to `STEP8.md`). Next
is phase 08 (the AI agent), not yet planned. The public
help center is at `/help/demo/relay-help` locally. Phase 06 (routing, teams and workload) is complete locally, planned in
`docs/ROUTING_PLAN.md`; its step docs are `docs/ROUTING_STEP1.md` to `STEP3.md`. Phase 05
(tickets and SLAs; `docs/TICKETS_PLAN.md`, `TICKETS_STEP1.md` to `STEP5.md`) and phase 04
(agent inbox; `AGENT_INBOX_STEP1.md` to `STEP11.md`) are complete locally. Open items from phases 04–06 were cleared in
`docs/MAINTENANCE_2026-10.md`. Flags `tickets_v1`, `sla_v1`, `portal_v1`,
`routing_v1`, `knowledge_v1`, `help_center_v1`, `knowledge_sync_v1`, `knowledge_index_v1` and
`knowledge_health_v1` default off; the local relay turns them all on. The AI index (`server/knowledge-index.ts`) keeps vectors out
of PostgreSQL behind `EmbeddingPort` and `VectorStorePort`; retrieval re-checks access in PostgreSQL,
so never filter by vector-store metadata alone. Content health's near-duplicate check
(`server/knowledge-health.ts`) reads stored vectors back through `VectorStorePort.get`. Website sync fetches only public https addresses (`server/safe-fetch.ts`);
tests reach their local test site through `sync.policy.allowHosts`, never set when deployed.
Phases 01–03 are implemented locally but not complete
or hosted; see `docs/STATUS.md`. Locally, `/agent?as=grace` signs in as a second
teammate.

## Known state

- The app was built on ChatGPT Sites. The deployed app runs on that
  hosting with D1 bound as `DB` (`.openai/hosting.json`) and platform
  sign-in (`app/chatgpt-auth.ts`). There is no authored `wrangler.toml`;
  `vite.config.ts` and `scripts/worker-config.mjs` generate Worker config.
- The target transactional store is PostgreSQL (Neon, eu-west-2) reached
  from Workers via Hyperdrive (`server/postgres.ts`). Neon and Hyperdrive
  are not provisioned yet and no data has moved from D1; locally the
  Postgres path runs on embedded PGlite (`npm run dev:relay`).
  Migrations are in `db/postgres/`, rollbacks in `db/rollback/`.
- D1 is being retired but is still the live store. `db/index.ts`,
  `lib/relay-server.ts`, `app/api/inbox/route.ts` and
  `app/api/visitor/route.ts` still use it. Treat any new D1 usage as a bug.
- The inbox is chosen in `app/page.tsx`: `RELAY_AGENT_INBOX_V1=true`
  renders the Postgres/WebSocket inbox (`components/relay/postgres-inbox.tsx`),
  otherwise the legacy D1 inbox with 2-second polling
  (`components/relay/inbox.tsx`). The flag is unset in deployed config, so
  production is on D1 polling. The legacy path is single-tenant.
- Events, attachments and embeddings do not live in the primary
  database: events go to the analytical store, attachments to R2,
  embeddings to the vector store. None of these is provisioned; the
  analytical store and embeddings are not built.
- Background work: Cloudflare Queues for jobs, Cron Triggers for
  schedules, Durable Object alarms for per-entity timers (snooze
  wake-ups, SLA clocks). Implemented in `workers/relay.ts`, not deployed.
- The agent app's colours are named tokens at the top of `agent/inbox.css`, with light and dark
  values (`docs/AGENT_DARK_MODE.md`). Use a token for any new colour; `tests/agent-theme.test.ts`
  fails on a written-in colour or a text pairing below WCAG AA.
- Saved views (`agent_inbox_views_v1`) are on for the local dev relay; built-in views are Mine,
  Mentions, Unassigned and All, and the list's status picker chooses the status
  (`docs/AGENT_LIST_AND_HEADER.md`). Tests opt in with `inboxViews: true`.
- The agent app's frame is `agent/shell.tsx` (`docs/AGENT_APP_SHELL.md`): an icon strip that
  slides out on hover and can be pinned, and per-area side menus (`SideMenu`) that hide and peek
  back. New areas join the strip; their navigation goes in their own side menu. Team inboxes are
  built-in views named `team:<team id>`, kept in step with membership by initialize.
- Settings (`agent/settings.tsx`, `server/settings.ts`; `docs/SETTINGS_PLAN.md`) is one area behind
  `settings_v1`, with pages at `#settings/<page>`. A new configurable feature gets a page there (or a
  link card, if it's managed where the work happens), listed by `settingsOverview` with the
  permission it needs. The plan (S1–S3b) is complete. A brand's messenger settings live in
  `brands.settings` and are edited through `server/channel-settings.ts`, which keeps keys it doesn't
  own; allowed websites must be exact origins (`websiteOrigin`). Roles change only within the acting manager's own permissions, never their own, and always
  leaving an owner (`server/people-settings.ts`). Page
  building blocks are in `agent/settings-ui.tsx`. Tags and attributes are archived, never deleted
  (`server/workspace-data.ts`); pickers that add a tag use `activeTags` from `agent/timeline.tsx`.
- List rows are cards (`agent/card.tsx`, fixed `CARD_HEIGHT` for the virtual list). Their preview
  line comes from `listPreviews` in `server/conversations.ts`, read after the page is chosen; never
  join it into a page query (`docs/AGENT_CARDS_AND_COMPOSER.md` has the measurements).
- The local relay uses in-memory loopback attachment storage
  (`scripts/local-storage.ts`); its scanner flags the EICAR test file.
- Frontend is React 19 + TypeScript on Vinext/Vite. Tests:
  `npm test` (Node), `npm run test:e2e` (Playwright; builds the messenger, agent
  and portal bundles first, so do not call `npx playwright test` directly),
  `npm run typecheck`, and `npm run test:postgres` (assignment under real
  concurrency on a throwaway PostgreSQL 17; about a minute, so not part of
  `npm test`).

## Rules

- Multi-tenant by default. Every table carries a workspace id, every
  query is scoped to it. New routes need a test proving a
  cross-workspace read fails.
- Additive migrations only. Never drop or rename a column in the same
  deploy that stops writing to it. Always supply the rollback.
- Any write path an external system can retry must be idempotent on a
  client-supplied idempotency key.
- Work longer than 200ms (p95) goes to a background job with retries, a
  dead-letter queue, and a status the UI can read.
- Money, time and counts are computed server-side. The client renders.
- Timestamps are UTC with the originating timezone stored alongside.
  Durations that a human is judged on must also be computable in
  business hours.
- Ship behind a feature flag, defaulted off.
- Every phase ends with: migration plus rollback, seed data, unit tests,
  one end-to-end test of the happy path, one of the main failure path,
  and a CHANGELOG entry.
- Do not scaffold features from later phases. Define the interface,
  leave a TODO, and say which phase owns it.
- Secrets live in `.dev.vars` locally and `wrangler secret put` for
  deployed. Never in `wrangler.toml`, never committed, never printed.
- Internal notes must never be deliverable to a customer through any
  path, including email notifications and the messenger. Live signals
  follow `fanOutSignal` in `server/realtime.ts`; note typing and
  viewing are teammate-only.

## Working style

- One phase per branch, one step per session.
- Plan before code. If the plan is larger than expected, stop and ask.
- If a requirement is ambiguous, ask. Do not choose silently.
- Commit at the end of each step.
