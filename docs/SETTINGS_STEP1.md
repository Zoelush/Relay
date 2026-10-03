# Settings, step S1: the frame and personal settings

Branch `settings/s1-frame`. Plan: `docs/SETTINGS_PLAN.md`. Approved on 3 October 2026 ("Yes, go ahead with all four"). Behind the new `settings_v1` flag, off by default; the local relay turns it on.

## What it does

**Opening Settings.** A gear at the bottom of the icon strip opens it.
- **Side menu:** grouped Personal, Workspace, Inbox and Knowledge & AI. It hides and peeks like the inbox and Knowledge menus.
- **Home:** the Overview page, with a card for each page in the same groups.
- **Addresses:** every page has one (`/agent#settings/profile`). It opens directly, a changed address in the same tab moves to it, and other parts of the app link to it.

**Who sees what.** The server lists the pages a teammate may open (`settingsOverview`), so nothing is offered that would be refused. An address for a page you can't use lands on the overview.
- **Personal pages:** everyone's.
- **General:** needs `workspace.manage`.
- **Macros:** needs `macros.use`.
- **Saved views:** needs saved views on.
- **Help centers, Websites and AI index:** need `knowledge.manage` and each feature's flag.

**Each page:**
- a title and one line on what it's for
- cards of fields, each explained
- a Save button that lights up only when something changed, and says "Saved" after
- Enter saves
- a refused save shows why and keeps your changes to try again

**Personal:**
- **Your profile:**
  - your name, shown in the account menu at once
  - your timezone (or your device's), kept for working hours
  - a reply signature of up to 1,000 characters
- **The signature** is added to the end of every reply you send from the inbox, never to internal notes. It's added as the reply is sent, so your draft (and a failed send's restored text) stays without it and it's never added twice.
- **Notifications:** desktop notifications while Relay is in a background tab (permission asked when you turn them on, with a note if the browser blocks them), and a short soft chime, with a button to hear it. Both follow your account, not the browser.
- **Appearance:** System, Light or Dark, applied at once and kept in this browser, as in the account menu.

**Workspace › General:**
- the workspace's name (shown in the account menu)
- its ID (fixed)
- its timezone
- the team's language
- counts of teammates, contacts and conversations

The timezone list always includes UTC and the saved value, since some browsers leave UTC out.

**Inbox:**
- **Macros** moved into Settings: the same manager, inside the page. "Manage macros" in the command palette and "Manage" in the macro picker open it there. Without Settings, they open the dialog as before.
- **Saved views** is a link: it opens the inbox with its menu shown.

**Knowledge & AI:** Help centers, Websites and AI index link to Knowledge, opened on that page.

**Also:** the account menu's "Your profile" opens Settings › Your profile. Without Settings, the read-only dialog opens as before.

## Server

`server/settings.ts`, with `GET /v1/agent/settings?section=overview|profile|general` and `POST /v1/agent/settings`.
- **Sections:** `profile`, `notifications` or `general`.
- **Idempotency:** each POST is idempotent on its key (`once`).
- **Validation:**
  - names: 1 to 80 characters, spaces folded
  - timezones: IANA
  - language: a BCP 47 tag, canonicalised
  - signature: up to 1,000 characters
  - notification preferences: only `true` counts as on
- **The inbox snapshot** now carries `capabilities.settings` and `profile` (your signature and notification preferences).

## Migration

`db/postgres/0037_settings.sql` is additive:
- **Teammate columns:** `timezone`, `signature` and `notification_prefs`.
- **The flag:** `settings_v1`, off by default. New workspaces get it from `seedFoundation`.

The rollback switches the flag off; the columns stay.

## Not included yet

**S2 and S3:**
- teams and assignment, office hours, SLAs, ticket types, tags and attributes
- teammates, roles, brands, the messenger and the portal

**Later phases** (TODOs in `server/settings.ts`):

| Item | Phase |
|---|---|
| Security, audit log, usage and billing | 16 |
| API keys and webhooks | 15 |
| Email and other channels | 12 |
| The AI agent | 08 |

**Profile photos:** an avatar photo upload (Beacon has one) waits for a profile image store. Initials are shown meanwhile.

## Tests

**`tests/settings.test.ts`:**
- **Visibility:**
  - off by default
  - the snapshot's flag and profile
  - the pages each role is offered, including knowledge pages following permission and flags
- **Your profile:** read, save, normalisation and every refusal.
- **Notifications** following the account.
- **General:**
  - refused for agents
  - saved by the owner, with a retried save applied once and answered the same
  - an invalid timezone refused
  - the account menu's new name
- **Cross-workspace:** another workspace's General is its own, and a principal from another workspace is refused.

**`tests/browser/settings.spec.ts`** (ports 8922/8923):
- **Happy path:**
  - the gear and the home's groups
  - Your profile: Save lighting up, the account menu updating, the address reopening the saved page
  - the signature on a reply and not on a note (checked in the database)
  - General and the account menu
  - notifications saved to the account
  - the theme switching
  - "Manage macros" opening Settings › Macros
  - the AI index link landing on Knowledge's page
  - Saved views opening the inbox menu
  - the account menu's "Your profile" opening Settings
- **Failure path:**
  - a teammate without workspace rights sees no General, and its address lands on the overview
  - a refused save shows the reason, keeps the typed change and leaves Save on, with nothing saved

**Updated:** `macros.spec.ts` and `account-menu.spec.ts` run with `settings: false`, so the dialog paths (still used when Settings is off) stay tested.

## Checks

Results on 3 October 2026:
- `npm test`: 92/92 pass.
- `npm run typecheck`: clean.
- Lint shows nothing in the new files.
- `npm run test:e2e`: 70/70.
- `npm run test:postgres`: passes.
- **Checked in screenshots, light and dark:** the home, Your profile, General, Notifications and Macros.
