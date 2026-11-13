# The paired test workspace, T1a: the pair, the boundary and the safety

Branch `feature/test-workspace`. Plan: `docs/TEST_WORKSPACE_PLAN.md`. Migration 0102.

## What it does

**Settings › General › Test workspace** makes one, for `workspace.manage`. A test workspace is a workspace of its own, owned by a production one:

- **It starts as production does:** the same brands, roles and their permissions, the same teammates with the same roles, the same feature flags, and **the same plan** — so the features and limits a test proves are the ones production has.
- **Switching takes one click,** in that card or in the account menu. It is the session you already have: no second password, no second two-factor.
- **Every page says which workspace you are in.** A band sits above the icon strip while you are in the test workspace, and the account menu marks it.
- **Nothing it does reaches a real person.** Every outbound channel delivery is recorded in `test_deliveries` and goes no further — Settings › General lists what it would have sent, with a link back to the conversation. No email is sent on its behalf either, not even to its own teammates.
- **Nothing is billed.** No invoice is issued for it, ever.

## The boundary

A session's token stays bound to the workspace it was issued for and is resolved there, on every request, exactly as before. What is new is that a request may *name* a workspace to work in (`x-relay-workspace`, carried in the bridge's signed proof as `actAs`), and the API checks, before any route runs:

1. the named workspace's own row says it is the test workspace of the session's workspace (`test_of`), and
2. this teammate exists there, with a role of their own.

Relay support never switches: it reads the workspace it was granted. A teammate removed from the test workspace cannot reach it, even from a session in the workspace it belongs to.

## How it is put together

- **Migration `0102_test_workspace.sql`:** the pair is written on **both** rows — `test_of` on the test workspace, `test_workspace_id` on the production one — because row-level security means a workspace can only read its own row, and each side must be able to answer "which pair am I in?" without reading the other's. `test_deliveries` holds what a test workspace would have sent.
- **`server/test-workspace.ts`:** `createTestWorkspace`, `pairOf`, `mayActIn`, `isTest`, `recordTestDelivery`, `readTestDeliveries`.
- **Safety is enforced where sending and billing already funnel:** `runDelivery` for every channel, `sendAlert` for Relay's own emails, `issueDueInvoices` for billing. One place each, so a new channel or a new alert is safe without being asked to be.
- **The registries were updated, not worked around:** the new audit action and the `workspace` table's trigger (`lib/audit-actions.ts`), the erasure cascade (`test_deliveries` goes with its conversation), the route policy matrix, and the plan — which is still read and written only by `server/plans.ts` (`copyPlanInto`).

## Decisions worth knowing

- **Copying is by value, never by SQL across tenants.** Everything the test workspace starts from is read in the production workspace's own transaction and written in the test workspace's; a cross-tenant `INSERT … SELECT` silently copies nothing, because the source rows aren't visible.
- **Brands come with it in this step,** though the rest of the configuration is T1b's: without a brand there is nowhere for a conversation, a messenger or a help centre to live, so a test workspace without one could not be used at all.
- **The counterpart's name is not copied.** Each side knows the other's id; names change, and a stale copy would be worse than none.

## Checks

- **`tests/test-workspace.test.ts`:** only a manager makes one, one per workspace, and never from inside one; it carries the plan, features, roles, brands and teammates; the pair reads the same from both sides; a production session works in the pair and nowhere else (another workspace, and a teammate removed from the test workspace, are both refused); **a delivery in the test workspace is recorded and the provider is never asked, while the same reply in production is sent**; it is never invoiced; the two workspaces see only their own rows; and the rollback leaves it an ordinary workspace nobody can switch into.
- **`tests/browser/test-workspace.spec.ts`:** a manager makes one from Settings, switches into it, the band appears on every page, and they switch back; an agent is refused the API, and a workspace that isn't the pair is refused however it is asked for.
- **Typecheck, eslint, `npm test`, `npm run test:postgres`, `npm run test:e2e`.**

## What's next

- **T1b:** the configuration copy (teams, ticket types, SLAs, calendars, macros, tags, attributes, workflows, Zoe's agents and guidance, the help centre and its published articles, the messenger's settings) and made-up customers, with a registry that fails when a new table is neither copied nor deliberately left out.
- **T2:** promoting a change from test back to production.
- **T3:** the developer sandbox (phase 15's D6) on the same pairing.
