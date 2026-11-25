# Finishing phase 01: the people model

Asked for on 24 November 2026, after the paired test workspace plan ("Finish phase 01"). Phase 01's
brief is in `docs/BUILD_PHASES.md`; what was missing is in `docs/STATUS.md` and
`docs/LOCAL_READINESS.md` §2. Phase 13 (`docs/OUTBOUND_STEP1.md`) already added events, the
event-name registry, subscription types and flat segments.

## Decisions (asked, 24 November 2026)

1. **Foundations first.** Typed values and companies, then segments and the acceptance run, then
   custom objects, then the rest of the brief's audit items.
2. **Custom contact data moves into typed values.** Every key in `contacts.profile` becomes a
   defined attribute, its type inferred from the values (mixed types become text), copied into the
   typed store by a migration. `profile` stays readable for one release, kept in step by the one
   writer, then is no longer written. Segments, the inbox sidebar and the API read only the typed
   store.
3. **A contact's companies are set by the API and teammates; the messenger only for verified
   users, and only when the workspace allows it** — off by default, so nobody can claim a company
   by typing into the messenger.
4. **Blocking refuses and keeps out of sight.** A blocked person can't start or reply in the
   messenger; what they send on other channels is kept but filed away — no inbox, no notification,
   no Zoe, no SLA. Audited and reversible, and unblocking loses nothing.

## The steps

- **P1a (done) — typed values for contacts** (`docs/PEOPLE_STEP1.md`): a value table apart from the
  definitions, indexed per type; `profile` migrated into it; one writer for every source (API,
  workflows, merges); segments, the sidebar and the API reading it.
- **P1b — companies and tags on people:** companies with their plan, seats, monthly spend and typed
  attributes; contacts in many companies, with a role on each; tags on contacts and companies, in
  the same namespace as conversations'.
- **P2 — segments and the acceptance run:** nested and/or groups, tags, company filters on people
  (any one company matching), segments over companies; then 50,000 contacts, 5,000 companies, 20
  attributes and 2 million events, with the plan and timing of the brief's segment under 500 ms.
- **P3 — custom objects:** object types with typed attributes, instances, references from contacts,
  companies and conversations, lookup by external id, in the API and the sidebar.
- **P4 — the rest of the audit items:** blocked contacts, attribute write sources, the teammate
  attribute type, tags on articles and outbound messages, and the merge and isolation proofs the
  brief asks for.
