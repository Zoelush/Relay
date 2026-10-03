# Settings, step S3a: people (teammates, roles and permissions)

Branch `settings/s3a-people`. Plan: `docs/SETTINGS_PLAN.md`. Approved on 3 October 2026 ("Yes, go ahead with all four"):
1. **S3 is split:** S3a (this step) is people; S3b is brands, the messenger and the customer portal.
2. **Inviting and removing teammates wait for phase 16,** with sign-in and administration.
3. **Who opens what:** the people pages need `teammates.manage`; the channel pages (S3b) need `workspace.manage`.
4. **Identity verification keys:** S3b shows enforcement and key status; creating and rotating keys stays an operator task until phase 16 security.

## What it does

Two pages in Settings' **Workspace** group, for teammates who can manage teammates (owner and admin by default).

**Teammates:**
- **The list:** everyone with:
  - their status (active, away)
  - their seat
  - their teams
  - a role menu, with Save showing once a different role is chosen
- **Your own row** is marked "You", and its role can't be changed there.
- **Saving** says what happened ("Grace is now a team lead."). A refusal shows the reason and keeps the choice.
- A search box appears past ten teammates.

**Roles & permissions:**
- **The list:** each role, how many permissions it has and how many teammates hold it. Built-in roles (owner, admin, agent) are marked. Role names are shown capitalised; built-in ones are stored in lowercase.
- **New role, or Edit:**
  - a name (built-in roles keep theirs)
  - every permission as a checkbox, grouped and explained: conversations, macros, helpdesk and knowledge, workspace, and "coming later"
  - "See conversations" is always on, because it's what lets a teammate open Relay
  - permissions you don't hold are shown but can't be ticked
  - a new role starts as a basic agent: see, reply, note, work on conversations, use macros
- **Delete:** only custom roles nobody holds.
- **The owner role** always has every permission, so it can't be edited. Roles you can't edit say so.

**The rules,** enforced by the server and explained on refusal:
- **Nothing above your own permissions:** you can't give or take away a role that has permissions you lack, or give a role a permission you lack (`ROLE_ABOVE_YOURS`).
- **Not your own:** you can't change your own role, or edit the role you hold (`OWN_ROLE`). Nobody locks themselves out.
- **Always an owner:** the workspace's only owner can't be moved to another role (`LAST_OWNER`). The owners are locked while this is checked, so two managers can't each move the other at once. This keeps someone who can manage teammates.
- **Built-in roles:** they keep their names, and none can be deleted (`ROLE_FIXED`). A role someone holds can't be deleted (`ROLE_IN_USE`). Role names are unique whatever their case (`ROLE_EXISTS`).

**Changes take effect** on the teammate's next request. Their open Settings menu updates when their page reloads; until then the server refuses anything they no longer may do.

## Server

- **`server/people-settings.ts`:** `listTeammates`, `setTeammateRole`, `listRoles` and `saveRole`, behind `settings_v1` and `teammates.manage`.
  - routes: `GET/POST /v1/agent/teammates` and `/v1/agent/roles`, allowed through the agent bridge
  - writes are idempotent on the key (`once`), and signal open inboxes to refresh
- **`settingsOverview`** lists `teammates` and `roles`.

No migration: roles and their permissions were already tables.

**Seed:** the local relay adds a custom "Team lead" role, held by nobody.

## Not included

- **Seats:** shown but not changeable. Nothing in Relay acts on a seat yet, so changing one would do nothing; seats belong with billing in phase 16 (TODO in `server/people-settings.ts`). This differs from the plan, which said seats could be changed.
- **Inviting, removing or deactivating teammates:** phase 16.
- **Setting another teammate's status:** the server already allows it with `teammates.manage` (phase 06); this page only shows status.
- **The permission `macros.manage`:** not offered, because nothing checks it. A role keeps it if it has it.
- **S3b:** brands, the messenger and the customer portal.

## Tests

**`tests/settings-people.test.ts`:**
- **Visibility:** the pages are offered only with `teammates.manage`; agents are refused.
- **The list:** roles, seats, and which roles you may edit.
- **Moves:** applied once for a retried key.
- **Refusals:**
  - your own role (`OWN_ROLE`)
  - the last owner (`LAST_OWNER`)
  - a manager with few permissions handing out, taking away or creating anything above them, or editing their own role
  - a role without "see conversations", an unknown permission, a duplicate name, editing the owner role
- **Edits take effect:** a role's edit is enforced at once; built-in roles keep their names.
- **Deleting:** refused for built-in roles and roles in use; allowed once a role is empty.
- **A second owner** lets the first be moved.
- **Cross-workspace:** another workspace lists only its own, and A's roles don't exist in B.
- **Flag:** closed without Settings.

**`tests/browser/settings-people.spec.ts`** (ports 8964/8965):
- **Happy path:**
  - Grace moved to Team lead, then shown Ticket types in her own Settings
  - a new role created
  - Team lead's ticket permission removed, after which Grace's Settings drops Ticket types on reload
  - an unused role deleted
  - each checked in the database
- **Failure path:**
  - deleting a role someone holds is refused
  - Grace, made an admin, is refused moving the only owner, with the reason shown, nothing changed, and her choice kept

**Updated:** `tests/settings.test.ts` expects the new pages for an owner.

## Checks

Results on 3 October 2026:
- `npm test`: 95/95 pass.
- `npm run typecheck`: clean.
- Lint shows nothing in the new files.
- `npm run test:e2e`: 76/76.
- `npm run test:postgres`: passes.
- **Checked in screenshots, light and dark:** Teammates, and editing a role.
