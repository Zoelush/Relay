# Settings, step S2a: helpdesk (teams, office hours, SLAs)

Branch `settings/s2a-helpdesk`. Plan: `docs/SETTINGS_PLAN.md`. Approved on 3 October 2026 ("Yes, go ahead with all three"):
1. **S2 is split:** S2a (this step) is routing and time; S2b is tags, conversation attributes, then ticket types.
2. **Teams aren't deleted for now.** The server has no delete and conversations point at teams; archiving comes later.
3. **S2b preview:**
   - **Tags:** create, rename and archive, never hard-deleted.
   - **Attributes:** create with a fixed type, rename, add options, archive.

## What it does

A new **Helpdesk** group in Settings. Each page needs workspace management and its feature's flag:
- Teams & assignment needs `routing_v1`.
- Office hours and SLAs need `sla_v1`.

Each page edits through the API its feature already had, which checks permissions, versions and limits.

**Teams & assignment:**
- **Teams:** each with its method, member count, inbox limit and how many conversations wait.
  - **New team, or Edit:**
    - name
    - members, as a checklist of every teammate
    - the assignment method, each explained in plain words
    - inbox and ticket limits (blank for none)
    - whether tickets count toward conversation limits
    - whether round robin includes away teammates
    - whether a member going away returns their conversations to the inbox
  - **After saving:** it says how many waiting conversations the new settings assigned.
- **Teammate limits:** every teammate's own conversation and ticket limits, saved row by row. Raising one can assign waiting conversations, and the page says so.
- **The Workload panel's "Edit team settings"** now opens this page. Without Settings, it opens the panel's form as before.

**Office hours:**
- **Calendars:** each with its timezone, a short summary of its week ("Mon–Fri 09:00–17:00"), holidays and version.
- **New calendar, or Edit:**
  - name and timezone
  - each weekday open or closed, with one or more opening windows (a lunch break is two windows)
  - holidays
  - special days already on a calendar are kept
- **Publishing** adds a new version. Clocks already running keep the hours they started with, as the page says.
- **Times** are typed as HH:MM, 24:00 allowed for midnight, and checked before anything is sent.
- **Who uses which hours:** the workspace's default, then each brand and each team, each a choice of calendar. A conversation uses its team's hours, else its brand's, else the workspace's, else always open.

**SLAs:**
- **Policies,** in the order they're tried. Each shows its targets ("first response 15m"), the time counted (business or all hours), what it applies to, and whether it's on.
- **New SLA, or Edit:**
  - name and on/off
  - each target in minutes, hours or days (blank for none)
  - business or all hours
  - pausing while snoozed or waiting on the customer
  - every conversation, or only those matching conditions (the saved views' condition editor)
- **Ordering:** a new policy goes to the bottom. Move up and down reorder them.
- **Archive** removes a policy. Open conversations are re-checked after any change, as the page says.

**Refusals:** a save refused because something changed elsewhere ("This team changed elsewhere. Reload and try again.") or because a value is invalid shows the server's reason, and nothing is overwritten.

## Server

- **Idempotent saves:** posts to `teams`, `teammate-limits`, `calendars` and `sla-policies` now use the idempotency key (`once`). A retried save, such as creating a team, is applied once and answers the same. They were the last writes there without it.
- **`GET teams`** also returns every teammate's own limits, for those who can manage the workspace.
- **`GET calendars`** also returns the brands and teams a calendar can be assigned to.
- **`settingsOverview`** lists `teams`, `office-hours` and `slas` by permission and flag.

No migration.

## Also

- The building blocks of a Settings page (frame, card, field, form state) moved to `agent/settings-ui.tsx`, shared by `agent/settings.tsx` and `agent/settings-helpdesk.tsx`.
- `FilterEditor` (agent/views.tsx) is exported for the SLA conditions.

## Tests

**`tests/settings-helpdesk.test.ts`:**
- **Visibility:** the pages follow permission and flags.
- **Idempotency:** a team, teammate limit, calendar and SLA policy saved twice with the same key are each applied once.
- **List fields:** teammates' limits only for managers; the brands and teams a calendar can be assigned to.
- **Refusals:**
  - a stale team edit is refused with `TEAM_CONFLICT`
  - a calendar with no hours is refused
  - agents are refused every save
- **Cross-workspace:** another workspace has none of it.

**`tests/browser/settings-helpdesk.spec.ts`** (ports 8960/8961):
- **Happy path:**
  - a new team with a member, method and limit
  - a teammate's own limit
  - a weekend calendar with a holiday, assigned to the team
  - an SLA for matching conversations, created, moved to the top and archived
  - the Workload panel's "Edit team settings" opening this page
  - each checked in the database
- **Failure path:**
  - a calendar with "25:00" isn't published
  - a team changed elsewhere while open here isn't overwritten, and the page says why

**Updated:** `workload.spec.ts` runs with `settings: false`, so the panel's own team form stays tested.

## Checks

Results on 3 October 2026:
- `npm test`: 93/93 pass.
- `npm run typecheck`: clean.
- Lint shows nothing in the new files.
- `npm run test:e2e`: 72/72.
- `npm run test:postgres`: passes.
- **Checked in screenshots:** the three pages and their editors.
