# Relay

A customer communication and support platform — an alternative to Intercom.

## Build plan

The product is being built in 18 phases, numbered 00–17. The full plan and
the prompt for each phase is in `docs/BUILD_PHASES.md`. Read the relevant
phase before starting work. Phase 04 has its own detailed plan in
`docs/AGENT_INBOX_PLAN.md` (steps A–D); step A's handoff is
`docs/AGENT_INBOX_STEP1.md`. Verified progress is in `docs/STATUS.md`.

Current position: phase 05 (tickets and SLAs), planned in `docs/TICKETS_PLAN.md`
(steps A1, A2, B1, B2, C). Steps A1 (ticket core, `docs/TICKETS_STEP1.md`) and A2
(categories, linking and tracker broadcasts, `docs/TICKETS_STEP2.md`) and B1 (business-time
engine, calendars and the SLA clock matrix, `docs/TICKETS_STEP3.md`) are implemented
locally; next is step B2: SLA policies, clocks on conversations and breach handling. Phase 04
(agent inbox) is complete locally; its step docs are `docs/AGENT_INBOX_STEP1.md` to
`STEP11.md`. Phases 01–03 are implemented locally but not complete
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
- The local relay uses in-memory loopback attachment storage
  (`scripts/local-storage.ts`); its scanner flags the EICAR test file.
- Frontend is React 19 + TypeScript on Vinext/Vite. Tests:
  `npm test` (Node), `npm run test:e2e` (Playwright; builds the bundles
  first, so do not call `npx playwright test` directly), `npm run typecheck`.

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
