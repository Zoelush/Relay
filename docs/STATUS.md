# Status

Verified 29 September 2026 against commit `0bfdeb2`; phase 04 and 05 rows and checks updated through the October 2026 maintenance step (`docs/MAINTENANCE_2026-10.md`) by reading the code and
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
| 04 Agent inbox | Steps A, B (B1, B2), C (C1–C3b), D1, D2 and D3 done locally (phase 04 plan complete locally) | Handoffs: `docs/AGENT_INBOX_STEP1.md` (A), `STEP2` (B1 saved views), `STEP3` (B2 first screen; warm p95 15.6ms against 150ms), `STEP4` (C1 timeline, snooze, shortcuts), `STEP5` (C2a rich text, drafts), `STEP6` (C2b inline images), `STEP7` (C3a mentions, notifications), `STEP8` (C3b viewing and writing indicators), `STEP9` (D1 macros), `docs/AGENT_INBOX_STEP10.md` (D2 context sidebar and app-slot contract), `docs/AGENT_INBOX_STEP11.md` (D3 bulk actions with undo). Follow-up: `docs/AGENT_DARK_MODE.md` (System, Light and Dark themes for the whole agent app, with WCAG AA contrast tests, and the account menu: status, theme, workspace, profile, sign out), `docs/AGENT_LIST_AND_HEADER.md` (the list's status picker and sort menu, simpler built-in views, the conversation header), `docs/AGENT_APP_SHELL.md` (the icon strip, hideable inbox and knowledge side menus, team inboxes), `docs/AGENT_CARDS_AND_COMPOSER.md` (conversation cards with message previews, the header, the composer, the details card). |
| 05 Tickets and SLAs | Steps A1, A2, B1, B2 and C done locally (phase 05 plan complete locally) | Plan: `docs/TICKETS_PLAN.md`. Handoffs: `docs/TICKETS_STEP1.md` (A1 ticket types, states, transitions, required fields, conversion, type change), `docs/TICKETS_STEP2.md` (A2 customer status updates, back-office tickets, trackers, links, broadcasts), `docs/TICKETS_STEP3.md` (B1 business-time engine, calendars, SLA clock test matrix; flag `sla_v1` off by default), `docs/TICKETS_STEP4.md` (B2 SLA policies, clocks, breaches, countdowns, SLA sort and filters), `docs/TICKETS_STEP5.md` (C customer ticket portal; flag `portal_v1` off by default). Flag `tickets_v1` off by default. |
| 06 Routing, teams and workload | Steps A, B and C done locally (phase 06 plan complete locally) | Plan: `docs/ROUTING_PLAN.md`. Handoff: `docs/ROUTING_STEP1.md` (methods, limits, atomic claims, queue pick-up, 2,000-conversation simulation), `docs/ROUTING_STEP2.md` (away mode, paced return, Next conversation, workload UI), `docs/ROUTING_STEP3.md` (queue position, one office-hours source, reply time). Flag `routing_v1` off by default. |
| 07 Help center and knowledge store | Steps A1, A2, B1, B2, C1a and C1b done locally | Plan: `docs/KNOWLEDGE_PLAN.md` (A1, A2, B1, B2, C1a, C1b, C2). Handoff: `docs/KNOWLEDGE_STEP1.md` (one knowledge store, per-language drafts and publishing, autosave with conflict protection, versions and restore, the article editor, the Knowledge section), `docs/KNOWLEDGE_STEP2.md` (help centers per brand, collections and sections, placements, clean slugs with redirects, language fallback and path resolution), `docs/KNOWLEDGE_STEP3.md` (the public help center: server-rendered pages, SEO, signed-in access, custom domains, the portal as a section), `docs/KNOWLEDGE_STEP4.md` (search, feedback, the messenger's Help space, search-before-contacting receipts, the query log and reports), `docs/KNOWLEDGE_STEP5.md` (file uploads with text extraction, scanning and versions; article images; help center logo, favicon and social image), `docs/KNOWLEDGE_STEP6.md` (website sync: robots-respecting crawls on a schedule, pages as records, removals, safe fetching). Flags `knowledge_v1`, `help_center_v1` and `knowledge_sync_v1` off by default. |

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

On `maintenance/open-items`:

```text
npm test
ℹ tests 64
ℹ pass 64
ℹ fail 0
```

- `npm run test:postgres` (real PostgreSQL 17 concurrency): passes.
- `npm run typecheck`: passes.
- `npm run test:e2e` (Playwright, Chromium): 41/41 pass.
  - Office hours and queue position: 2/2 pass.
  - Workload and away mode: 2/2 pass.
  - Customer portal: 2/2 pass.
  - SLAs: 2/2 pass.
  - Ticket categories and linking: 2/2 pass.
  - Tickets: 3/3 pass.
  - Bulk actions: 3/3 pass.
  - Agent inbox: 2/2 pass.
  - Views: 2/2 pass.
  - Timeline: 3/3 pass.
  - Triage (keyboard and snooze): 2/2 pass.
  - Composer (rich text and drafts): 2/2 pass.
  - Inline images: 2/2 pass.
  - Mentions: 2/2 pass.
  - Collision indicators: 2/2 pass.
  - Macros: 2/2 pass.
  - Context sidebar: 2/2 pass.
  - Messenger: 4/4 pass. The "hostile CSS" test locator was fixed in #3.
- Views load harness, `scripts/load-views.ts 200 10000`: figures in `docs/AGENT_INBOX_STEP2.md` §3.
- First-screen and virtualization measurement, `scripts/measure-first-screen.ts`: figures in `docs/AGENT_INBOX_STEP3.md` §3.

## Gaps to decide on

- The live app depends on ChatGPT Sites hosting. Moving it to your own Cloudflare account needs its own plan.
- Git history has only two commits, so earlier work cannot be reconstructed from `git log`.
