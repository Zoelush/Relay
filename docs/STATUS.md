# Status

Verified 29 September 2026 against commit `0bfdeb2`; phase 04 row and checks updated through step C2b by reading the code and
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
| 04 Agent inbox | Steps A, B1, B2, C1, C2a and C2b done locally; C3 and D not started | Step A: `docs/AGENT_INBOX_STEP1.md`. B1 (saved views): `docs/AGENT_INBOX_STEP2.md`. B2 (first screen; warm p95 15.6ms against 150ms): `docs/AGENT_INBOX_STEP3.md`. C1 (timeline text, snooze presets, shortcuts, palette): `docs/AGENT_INBOX_STEP4.md`. C2a (rich text, author-only drafts): `docs/AGENT_INBOX_STEP5.md`. C2b (scanned inline images): `docs/AGENT_INBOX_STEP6.md`. |

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

On `phase-04/step-c2b`:

```text
npm test
ℹ tests 34
ℹ pass 34
ℹ fail 0
```

- `npm run typecheck`: passes.
- `npm run test:e2e` (Playwright, Chromium): 16/16 pass.
  - Agent inbox: 2/2 pass.
  - Views: 2/2 pass.
  - Timeline: 2/2 pass.
  - Triage (keyboard and snooze): 2/2 pass.
  - Composer (rich text and drafts): 2/2 pass.
  - Inline images: 2/2 pass.
  - Messenger: 4/4 pass. The "hostile CSS" test locator was fixed in #3.
- Views load harness, `scripts/load-views.ts 200 10000`: figures in `docs/AGENT_INBOX_STEP2.md` §3.
- First-screen and virtualization measurement, `scripts/measure-first-screen.ts`: figures in `docs/AGENT_INBOX_STEP3.md` §3.

## Gaps to decide on

- The live app depends on ChatGPT Sites hosting. Moving it to your own Cloudflare account needs its own plan.
- Git history has only two commits, so earlier work cannot be reconstructed from `git log`.
