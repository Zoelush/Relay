# The paired test workspace, T1b: what it is made of

Branch `feature/test-workspace-copy`. Plan: `docs/TEST_WORKSPACE_PLAN.md`. Follows T1a (`docs/TEST_WORKSPACE_STEP1.md`). No migration.

## What it does

Making a test workspace now fills it:

- **Your configuration comes with it:** teams and who is in them, calendars and office hours, SLA policies, ticket types with their states, transitions and attributes, custom attributes, tags, macros, workflows and their versions, events, segments, subscription types and outbound settings, Zoe (her agents, specialists, escalation rules, guidance, monitors, connectors and procedures — **without their secrets**), your knowledge and help centre, the live messenger and portal settings, and your security, retention, redaction, link and audit settings.
- **Made-up customers are waiting in its inbox:** three people with names that say so, at `example.invalid` — a name reserved so nothing could ever be delivered to it — each with a conversation they began, written through the same `command` the messenger uses, so they are ordinary conversations in every way except that nobody is on the other end.

## The registry

`server/test-copy.ts` holds, for **every table in the schema**, either a place in `COPIED` or a line in `NOT_COPIED` with the reason. `tests/test-workspace.test.ts` fails on a table in neither, so a new table is a decision somebody makes rather than something that quietly isn't there. The reasons are five:

- **customers** — a test workspace has made-up ones of its own, never the real people;
- **runtime** — what the workspace is doing, not how it is set up (jobs, projections, runs, indexes);
- **ledger** — a record of what happened in production, which never happened here;
- **secret / reaches** — a key, token, account or domain a test workspace is deliberately without, because it must not be able to reach anyone;
- **billing** — a test workspace is never billed.

**Nothing that could reach a person or sign someone in is copied:** no AI provider keys, API tokens, OAuth apps, webhooks, credentials, sessions, two-factor, single sign-on, email domains, phone numbers, Meta pages, custom domains or invoices. The test asserts that by name.

## How the copy works

One generic copier walks `COPIED` in order: each table is read in the production workspace's transaction and written in the test workspace's, with `workspace_id` replaced and the columns the database fills itself (identity and generated columns) left alone. There is no cross-tenant SQL anywhere, because there cannot be: row-level security hides the source rows from the other side.

**Order is the foreign keys' order** — `business_calendars` before `calendars`, `attribute_definitions` before the ticket types that ask for them. Both of those were found by the copy failing loudly against real data, which is how it should be.

## Checks

- **`tests/test-workspace.test.ts`:** a test of its own asserts every table is copied or says why, never both, and that nothing which could reach a person or sign someone in is on the copied side. The pair test then asserts the macros, teams and knowledge arrived; that no credential, token, domain, number or invoice did; that the customers are made up and each began a conversation; and that the test workspace's inbox shows them.
- **`tests/browser/test-workspace.spec.ts`:** making one from Settings now also checks the macros came over, the people are made up, and nothing reachable did.
- **Typecheck, eslint, `npm test`, `npm run test:postgres`, `npm run test:e2e`.**

## One rule refined

`tests/plans.test.ts` forbids reading `workspace_plans` outside `server/plans.ts`. The copy registry *names* the table — that is its job — without reading it, so the rule now allows a registry to name it while still flagging any SQL that touches it there.

## What's next

**T2:** promoting a change from test back to production, with rules per kind of object. **T3:** the developer sandbox (phase 15's D6) on the same pairing.
