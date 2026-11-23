# The paired test workspace, T3b: review, and the app directory

Branch `feature/app-directory`. Plan: `docs/TEST_WORKSPACE_PLAN.md`. Phase 15's D6
(`docs/DEVELOPER_PLATFORM_PLAN.md`), second half. Follows T3a (`docs/TEST_WORKSPACE_STEP5.md`).
Migration `0106_app_directory.sql`.

## Decisions (asked, 23 November 2026)

1. **Re-review only what widens an app's reach.** Once an app is listed, a version that asks for a
   new permission, shows in a new place, sends people or data to a new host (a redirect, its
   canvas or its install address), or changes its listing's name or description waits for an
   operator. Anything else is released as soon as its developer releases it.
2. **Uninstalling cleans up and tells the app.** Besides revoking the installation and its
   tokens, its open cards and the settings its configure step saved are deleted, and the app is
   sent a signed `uninstalled` notice so it can delete what it holds. A notice that fails is
   retried a few times and then given up; it never blocks the uninstall.
3. **Delisting keeps installations; suspending stops them.** Delisted: no new installs from the
   directory, existing ones keep working. Suspended (a harmful app): every token it holds stops at
   once, everywhere, and each workspace sees why.
4. **The directory is Settings › Apps › Directory,** beside the apps installed here.

Standing from T3a: review is by Relay's operators with a command (`npm run directory`), never a web
surface — Relay's support access stays read-only.

## Where the directory lives

In a tenant of its own, `__directory__`, the way `relay_schema_migrations` lives in `__schema__`:
row-level security like every table, but no `workspace` row, so nothing that walks workspaces
(sweeps, invoices, seats) ever finds it. Three tables:

- `app_submissions` — what an operator is asked to judge: the app, the version, the card the
  directory would show, and why it needed review, in words; then the decision and its reason.
- `app_listings` — what the directory shows: each listed app's card and version; delisting is
  recorded on the row.
- `app_suspensions` — apps stopped everywhere, with the reason each workspace is shown.

Every workspace reads the directory; only the developer's own submissions and the operators'
command write to it, each in its own transaction, one tenant at a time.

## The developer's side

- An app gains an **install address** (`install_url`): its own page that starts the consent flow,
  where the directory's Install button sends people. A version can't be listed without one.
- **Submit to the directory** asks for a version to be listed. Approval releases that version and
  lists the app.
- **Releasing** a version of a listed app compares it with the listed one (`widensReach`). If it
  widens the app's reach it is submitted instead of released, and the page says what needs review.
  Otherwise it is released at once and the listing's card follows it.
- A rejection comes back with the operator's reason, shown on the version.

## The operators' side

`npm run directory -- <command>` (`scripts/directory.ts`, over `server/directory-review.ts`):
`pending`, `approve <id>`, `reject <id> <reason>`, `delist <app> <reason>`, `relist <app>`,
`suspend <app> <reason>`, `lift <app>`, each with `--as <name>`. Every decision is recorded in the
developer's workspace's audit log, by the operator's name, and approving releases the version there
in its own transaction.

## Suspension, checked where an app acts

`suspensionOf` is asked when one of the app's tokens is used (`handleRest`), when consent is shown
or a token is issued (`appByClient`), and when a card would be drawn (`appCanvas`). A suspended app
does nothing anywhere; the installation's row says "Suspended by Relay" with the reason. Lifting it
needs nothing else: the same tokens work again.

## Uninstalling

`revokeGrant` now also deletes the installation's card sessions and clears its saved settings. An
uninstall by a teammate enqueues `app.uninstalled`, which posts a signed notice to the running
version's canvas address (`/uninstalled`), logged with the other canvas calls. An app without a
canvas address has nowhere to be told, and the job finishes with nothing sent.

## Checks

- **`tests/app-directory.test.ts`:** submitting (an install address required, one open submission
  at a time); approving (the version released, the app listed, the directory showing it, installing
  from another workspace); a release that doesn't widen reach going out at once with the card
  following; one that does waiting, rejected with a reason, then approved; delisting with an
  installation still working; suspending (its token refused with the reason, consent refused, its
  cards gone, the installation saying why) and lifting; uninstalling (cards and settings gone, the
  signed notice sent once); and the widening rule on its own.
- **`tests/browser/app-directory.spec.ts`:** an approved app found in Settings › Apps › Directory
  and installed through its own install page; suspended, it leaves the directory and its
  installation says why.
- **Typecheck, eslint, `npm test`, `npm run test:postgres`, `npm run test:e2e`.**
