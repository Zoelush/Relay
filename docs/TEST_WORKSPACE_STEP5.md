# The paired test workspace, T3a: an app's versions, and its sandbox

Branch `feature/app-versions`. Plan: `docs/TEST_WORKSPACE_PLAN.md`. Phase 15's D6
(`docs/DEVELOPER_PLATFORM_PLAN.md`), first half. Follows T2b (`docs/TEST_WORKSPACE_STEP4.md`).
Migration `0105_app_versions.sql`.

## Decisions (asked, 17 November 2026)

1. **D6 in two steps.** T3a (this one): an app's manifest as published versions, installations
   pinned to a version, and the sandbox. T3b: review, and the directory with install and uninstall.
2. **The sandbox is the paired test workspace.** An app installs freely in the workspace that
   registered it and in that workspace's test pair — where nothing reaches a real person. Any other
   workspace may install only a version the developer has released.
3. **Review is Relay staff's, by an operator command** (T3b). Relay's support access stays
   read-only; no new way for staff to write through the web.
4. **Upgrades move by themselves when they ask for nothing new.** A version that asks for the same
   or fewer scopes than the one an installation runs reaches it automatically; one that asks for
   more waits until a manager of that workspace approves the new scopes, and the app keeps working
   on its version meanwhile.

## What an app is now

- **The draft** is the `oauth_apps` row, edited as before: name, description, redirects, scopes,
  canvas address and placements. Editing it changes nothing anyone runs.
- **A version** (`oauth_app_versions`) is the draft as published, numbered and kept exactly as it
  was: a trigger refuses any change but recording its release, once. Creating an app publishes
  version 1, so it can be tried in the sandbox straight away.
- **Releasing** a version makes it installable beyond the sandbox. Until the first release the
  app is in development: consent elsewhere is refused, in those words.
- Apps that existed before this step became version 1, released, with every installation pinned
  to it — nothing that worked stops working.

## What an installation runs

`server/app-versions.ts` decides it, once, for every reader — consent, tokens and Canvas:

- An installation is pinned to the version a manager consented to (`oauth_grants.app_version`).
- It runs the newest version it may see (any published one in the sandbox, released ones
  elsewhere) that asks for no scope its consented version didn't.
- A newer version that asks for more is **waiting**: Settings › Developers › Apps names the new
  scopes, and a manager's approval moves the installation, granting only what that manager has.
- Tokens carry the granted scopes **and** only those the running version asks for, so a version
  that asks for less gets less at once — never what it gave up.
- Canvas draws from the running version's address and placements, never the draft's.

Nothing is written when an installation moves by itself: what it runs is worked out each time
from the versions the app's workspace holds, read in that workspace's own transaction, so no
workspace ever writes another's rows.

## Checks

- **`tests/app-versions.test.ts`:** the developer's lifecycle (create is version 1, publish,
  release, a version kept exactly), the sandbox (a pair installs a development app, another
  workspace is refused until a release), pinning and moving (the same scopes move by themselves
  and Canvas follows; new scopes wait, named, and a manager's approval moves it), token scopes
  narrowed to the running version, and the version table's trigger.
- **Typecheck, eslint, `npm test`, `npm run test:postgres`, `npm run test:e2e`.**

## What's next

**T3b:** review by Relay's operators, and the directory with install and uninstall.
