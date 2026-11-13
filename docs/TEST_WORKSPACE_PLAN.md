# The paired test workspace

Asked for after phase 16 (13 November 2026). It was on phase 16's cut list — "a test workspace paired with production (it also serves phase 15's D6 sandbox)" — and is now being built.

A test workspace is **a workspace of its own, owned by a production one**: same configuration, made-up customers, and nothing it does can reach a real person. A team can try a workflow, an escalation rule, a messenger change or Zoe's guidance against their own setup without a customer ever seeing it.

## Decisions (asked, 13 November 2026)

1. **One sign-in.** A teammate's production session may act in its test workspace, because the pair belongs to it. No second password and no second two-factor. The API checks on every request that the workspace being acted in is the session's own or its test pair, and that the teammate exists there with a role; the session's token stays bound to the workspace it was issued for.
2. **Zoe answers for real,** with the workspace's own AI provider or Relay's, so what is tested is what will ship. Her usage is metered so it can be seen, and a test workspace is never invoiced.
3. **Created with your configuration and made-up customers:** brands, teams, roles, ticket types, SLAs, calendars, macros, tags, attributes, workflows, Zoe's agents and guidance, the help centre's structure and published articles, and the messenger's settings — then invented contacts and conversations to work with.
4. **This step is the pair itself, safe by construction.** Promoting a change from test back to production is the next step, with its own rules per kind of object (T2a: `docs/TEST_WORKSPACE_STEP3.md`).

## What makes it safe

- **Nothing reaches a real person.** In a test workspace every outbound channel is a stand-in: email, WhatsApp, SMS, Meta and voice deliveries are recorded as sent and go nowhere. The messenger works, because its customers are the made-up ones.
- **Nothing is billed.** No invoice is issued for a test workspace, its seats are not charged, and its meters are recorded but never invoiced. It carries its production workspace's plan, so the features and limits are the same — a test that passes there means something.
- **It is obvious.** Every page of the app says which workspace you are in, and a test workspace is marked wherever it appears.
- **It is a tenant like any other.** Row-level security, its own ids, its own data. Production never reads it and it never reads production; the only link is the pair, used to decide who may switch.

## The split

- **T1 (this step):** the pair — creating it, the boundary and the switcher, safety by construction, and the configuration copy with made-up customers.
  - **T1a (done, `docs/TEST_WORKSPACE_STEP1.md`):** the pairing, the boundary (one session acting in the pair), the switcher and the marker, the safety rules, and a test workspace created with its brands, roles and teammates.
  - **T1b (done, `docs/TEST_WORKSPACE_STEP2.md`):** the configuration copy and the made-up customers, with a registry saying, for every table, whether it is copied — and a test that fails when a new table is neither copied nor deliberately left out.
- **T2:** promoting a change back to production.
  - **T2a (done, `docs/TEST_WORKSPACE_STEP3.md`):** workflows and Zoe's guidance, promoted as a new
    version in production — refused when production has moved on since the pair was last in step,
    or when it is missing something the change needs — with a ledger of what arrived and the audit
    log. Decisions of 14 November 2026.
  - **T2b:** the messenger and a help centre's look, with the uploaded images they refer to
    (`brand_assets`, which the copy leaves behind today).
- **T3:** the developer sandbox (phase 15's D6) on top of the same pairing.

## How it is put together

- **`workspace.test_of`** (migration 0102) names the production workspace a test workspace belongs to; one test workspace per production one. Null everywhere else.
- **`server/test-workspace.ts`** owns it: creating the pair, reading it, and the one question the rest of the code asks — `isTest(db, w)`.
- **The boundary** lives in `server/api.ts` and `server/agent-bridge.ts`: the bridge may carry the workspace a teammate chose, and the API resolves the session in its own workspace before checking the pair and the teammate's role in it.
- **Safety** is enforced where sending and billing already funnel: `mayDeliver` for every channel delivery, the email adapter's `send`, and `issueDueInvoices` for billing. Each refuses in a test workspace, in one place, rather than being asked for at each call site.
