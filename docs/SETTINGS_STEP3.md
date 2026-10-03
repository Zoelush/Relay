# Settings, step S2b: helpdesk data (tags, attributes, ticket types)

Branch `settings/s2b-data`. Plan: `docs/SETTINGS_PLAN.md`. Scope approved on 3 October 2026 with the S2 split ("Yes, go ahead with all three"):
- **Tags:** create, rename and archive, never hard-deleted. An archived tag stays on its old conversations for history and reports, and disappears from pickers.
- **Attributes:** create with a type, rename, add options, archive. The type is fixed once created, because stored values depend on it.
- **Ticket types:** built on the attributes.

## What it does

Three more pages in Settings' **Helpdesk** group:
- **Tags** and **Attributes** need workspace management.
- **Ticket types** needs `tickets.manage` and the `tickets_v1` flag.

**Tags:**
- **Adding:** a name, unique whatever its case. A clash says which tag already has it.
- **The list:** each tag with how many conversations have it. A search box appears past ten tags.
- **Rename:** in place. The new name shows everywhere, history included.
- **Archive:** the tag stays on the conversations that have it and keeps its name in their history. It can still be removed from a conversation, but not added again. It's left out of every "add tag" picker:
  - the command palette
  - bulk actions
  - macros
- **Restore:** archived tags are listed apart, and each can be restored.
- **Live updates:** after any change the app reloads its directory, so pickers follow at once. Saving a team on Teams & assignment now does the same.

**Attributes** (conversation attributes):
- **The list:** each with its type, a list's options, and the ticket types that use it as a field.
- **New attribute:** a name and a type, each explained:
  - text, number, decimal, yes or no, date, or list
  - a list gets its options as it's made
- **Edit:**
  - rename it
  - the type shows but can't be changed
  - a list's saved options show without a remove button; new ones can be added, and removed again before saving
- **Archive:** conversations keep their values, but the attribute is no longer shown or filled in, ticket fields included; the page names the affected ticket types. Archived attributes are listed apart and can be restored.

**Ticket types:**
- **The list:** each type with its category, its states in order, field count and whether it shows in the portal.
- **New ticket type, or Edit:**
  - name and description
  - **Category:** customer, back-office or tracker, each explained; fixed once created
  - **Customer portal,** for customer types: shown or not, and who sees them (the portal's default, only the person who raised it, or everyone at their company)
  - **States:** in order, each with:
    - a name for teammates
    - what customers see
    - a kind (submitted, in progress, waiting on customer, resolved)
    - controls to move it up or down, or remove it
  - **Moves between states:** for each state, a checklist of where a ticket can go next
  - **Fields:** a checklist of active attributes, each optionally required to resolve
- **Defaults:**
  - a new type starts with Submitted, In progress and Resolved, with every move allowed
  - a new state can move to and from every other state; untick what shouldn't be allowed
- **Renaming a state** keeps its key, so tickets in it stay where they are.
- **Archive** a type: its tickets keep it, and new tickets can't use it.
- **The server checks the whole type,** and a refusal shows its reason, with the form kept. It refuses:
  - a type without a resolved state, or with only resolved ones
  - a state with no way to a resolved one
  - removing a state that has tickets
  - an edit made elsewhere since the page loaded

## Server

- **`server/workspace-data.ts`:** `listTags`, `saveTag`, `listAttributes` and `saveAttribute`, behind `settings_v1` and `workspace.manage`.
  - routes: `GET/POST /v1/agent/tags` and `/v1/agent/attributes`, allowed through the agent bridge
  - writes are idempotent on the key (`once`)
  - ids are made from the name, unique in the workspace
  - **Attribute edits:**
    - the type can't change
    - every saved option must still be there in the same words (`ATTRIBUTE_OPTION_REMOVED`)
    - saved options keep their order, and new ones follow
- **Ticket types:** `POST /v1/agent/ticket-types` now uses the idempotency key too.
- **Archived tags:**
  - `tag_add` refuses one (`TAG_ARCHIVED`); `tag_remove` still works
  - macros refuse an archived tag to add or an archived attribute to set (`MACRO_TARGET_MISSING`), though removing an archived tag is still allowed
- **The inbox snapshot** lists archived tags with `archived: true` (for names in history). `activeTags` and `tagLabel` in `agent/timeline.tsx` give pickers the active ones.
- **`settingsOverview`** lists `tags`, `attributes` and `ticket-types`.

## Migration

`db/postgres/0038_workspace_data.sql` is additive:
- `tags.archived_at`
- a trigger refusing to delete a tag (attributes already had one)

The rollback leaves both: the previous version ignores the column, so archived tags would show in its pickers again, and no previous version deletes tags.

**Seed:** the local relay adds an archived tag, Legacy.

## Not included

- **Contact and company attributes:** this page manages conversation attributes only. TODO(phase 1) stays with the people service.
- **Ticket type icons:** an existing type keeps its icon, and new ones get the default.
- **Bulk undo:** undoing a bulk tag removal after the tag was archived is refused for those conversations, like any other add of an archived tag.
- **S3:** people and channels.

## Tests

**`tests/settings-data.test.ts`:**
- **Visibility:** pages by permission and flag, including a lead who manages tickets but not the workspace.
- **Tags:**
  - created once for a retried key
  - names unique whatever their case
  - renamed
  - archived: counted, kept on the conversation, removable but not addable, marked in the snapshot, refused in a macro that adds it
  - never deleted, even by SQL
  - restored and usable again
- **Attributes:**
  - created once for a retried key
  - invalid types and duplicate options refused
  - options only added, in order
  - the type fixed
  - archived: can't be set, leaves the ticket type's fields, never deleted
- **Ticket types:** saved once for a retried key; a stale edit refused.
- **Cross-workspace:** another workspace sees and changes none of it.
- **Flag:** without Settings, the endpoints are closed.

**`tests/browser/settings-data.spec.ts`** (ports 8962/8963):
- **Happy path:**
  - **Tags:** added, renamed and archived, then gone from the macro picker
  - **Attributes:**
    - a list attribute created
    - given a new option, with its type locked and saved options unremovable
    - an attribute archived
  - **Ticket types:**
    - one built with a fourth state, a removed move and a required field
    - then a state renamed in place
  - each checked in the database
- **Failure path:**
  - a duplicate tag refused with the reason and the typed name kept
  - a ticket type with no way to resolve refused, with nothing saved

**Updated:** `tests/settings.test.ts` expects the two new pages for an owner.

## Checks

Results on 3 October 2026:
- `npm test`: 94/94 pass.
- `npm run typecheck`: clean.
- Lint shows nothing in the changed files.
- `npm run test:e2e`: 74/74.
- `npm run test:postgres`: passes.
- **Checked in screenshots, light and dark:** Tags, editing an attribute, editing a ticket type.
