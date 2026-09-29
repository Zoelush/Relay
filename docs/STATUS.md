# Status

Verified 29 September 2026 against commit `0bfdeb2`; phase 04 row and checks updated for step B1 on branch `phase-04/step-b1` by reading the code and
running the checks below. Claims copied from earlier docs but not
re-verified are marked as such.

## Summary

Nothing beyond the original D1 MVP is live. Phases 00–03 and phase 04
step A are implemented and tested locally on embedded PostgreSQL, behind
flags that are off. Neon, Hyperdrive, Queues, R2 and the storage Worker
have not been provisioned, and no data has moved from D1.

## Phases

| Phase | State | Evidence |
|---|---|---|
| 00 Audit | Done | `docs/ARCHITECTURE.md` (inventory, trace, gap analysis, decisions, refactors). |
| 01 Tenancy, identity, people | Partial | Workspaces, teammates, roles, contacts, identities and merge audit exist (`db/postgres/0002_people.sql`, `server/people.ts`, `server/identity.ts`). Companies, custom objects, typed contact/company values, events, subscriptions and segments are missing, and the 50,000-contact acceptance workload has not been run (`docs/LOCAL_READINESS.md` §2). |
| 02 Conversation core and realtime | Done locally, not hosted | Typed parts, cycles, merges, search, jobs, outbox and WebSocket replay (`server/conversations.ts`, `server/realtime.ts`, `workers/relay.ts`); covered by the Node tests. Hosted acceptance not run. |
| 03 Messenger | Done locally, not hosted | Iframe messenger and loader (`messenger/`, `docs/MESSENGER.md`). The production messenger is still the D1 one in `components/relay/messenger.tsx`. Its Playwright tests are not verified. |
| 04 Agent inbox | Step A done locally; step B1 done locally; B2, C, D not started | Step A: `components/relay/postgres-inbox.tsx`, `server/agent-bridge.ts`, migration 0013, `tests/agent-inbox.test.ts`. Step B1 (saved views, shared lists, live counts, paging): migrations 0014–0015, `server/inbox-views.ts`, `agent/views.tsx`, `tests/inbox-views.test.ts`, `tests/browser/inbox-views.spec.ts`; see `docs/AGENT_INBOX_STEP2.md`. B2 (first screen, 150ms) not started. |

## Inbox: storage and transport

- The choice is made in `app/page.tsx:9`: `postgresInboxEnabled(env) ? <PostgresInbox /> : <Inbox />`.
- `server/agent-bridge.ts:11` reads `RELAY_AGENT_INBOX_V1 === "true"`. No deployed config sets it. Only `scripts/local-relay.ts:355` turns it on, for local development.
- The production inbox therefore reads D1 and polls every 2 seconds (`components/relay/inbox.tsx:19`). The new inbox uses a WebSocket (`components/relay/postgres-inbox.tsx:129`).
- There is a second, per-workspace flag: `workspace_features.agent_inbox_v1` (`server/api.ts:251`).
- Legacy D1 writes are refused when PostgreSQL has write authority (`legacyWritesEnabled`, `server/agent-bridge.ts:13`).

## Remaining D1 references

Runtime:

- `db/index.ts`: Drizzle D1 client.
- `lib/relay-server.ts:5`: `database()` returns `env.DB`.
- `app/api/inbox/route.ts`: legacy inbox API. Single-tenant: no workspace id on conversations, and settings update the fixed workspace row `'main'`.
- `app/api/visitor/route.ts`: legacy messenger API.
- `vite.config.ts:19-23`, `cloudflare-env.d.ts:3`, `.openai/hosting.json`: the `DB` binding.
- `drizzle/0000_daily_jane_foster.sql`, `db/schema.ts`: the D1 (SQLite) schema.

Migration tooling (intended to stay until cutover): `db/d1-cutover/*`, `server/migration.ts` (D1 snapshot copy and verification), `scripts/postgres-migrate.ts`, `db/postgres/0001_chat.sql`, `db/rollback/0001_storage.sql`, `tests/fence.test.ts`, `tests/storage.test.ts`.

## Checks run

On `phase-04/step-b1`:

```text
npm test
ℹ tests 23
ℹ pass 23
ℹ fail 0
```

- `npm run typecheck`: passes.
- `npm run test:e2e` (Playwright, Chromium): 7 of 8 pass.
  - Agent inbox: 2/2 pass.
  - Views: 2/2 pass.
  - Messenger: 3 of 4 pass. "Hostile CSS and strict CSP" times out focusing the launcher, on this branch and on `main` alike.
- Views load harness, `scripts/load-views.ts 200 10000`: figures in `docs/AGENT_INBOX_STEP2.md` §3.

## Gaps to decide on

- The messenger hostile-CSS browser test fails on `main` (phase 03).
- The live app depends on ChatGPT Sites hosting. Moving it to your own Cloudflare account needs its own plan.
- Git history has only two commits, so earlier work cannot be reconstructed from `git log`.
