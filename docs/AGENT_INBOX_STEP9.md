# Agent inbox — step D1 handoff (macros)

Step D of `docs/AGENT_INBOX_PLAN.md` is split into three parts:

- **D1 (this document):** macros
- **D2:** the context sidebar and the phase-15 app-slot contract
- **D3:** bulk actions with undo

## 1. What changed

**Storage and permissions (migration 0020).**

- **The `macros` table** holds, for each macro:
  - its owner and whether it is personal or shared
  - a name, and whether it inserts a reply or a note
  - a rich-text body with variables
  - a list of actions
  - a version, and an archived flag
  
  It uses row-level security.
- **Permissions:**

  | Permission | Allows | Who has it |
  |---|---|---|
  | `macros.use` | Applying macros; creating, editing and archiving one's **own personal** macros | The default roles |
  | `macros.create` / `macros.edit` / `macros.delete` | The same for **shared** macros | Only roles that already hold `macros.manage`; owner and admin receive every capability |

  No role gains anything it could not do before. A shared macro stays shared (`MACRO_SHARING`); duplicate it to make a personal copy.

**Variables (`lib/rich-doc.ts`).**

- **The node:** `{ type: "variable", attrs: { name, fallback } }`. It is accepted **only** in macro bodies (`normalizeDoc(…, { variables: true })`), so a message still containing an unfilled variable cannot be sent.
- **Allowed names:** `contact.name`, `contact.first_name`, `contact.email`, `conversation.title`, `teammate.name` and `brand.name`. Anything else, including `company.*` until phase 1 adds companies, is rejected.
- **Filling (`fillVariables`):** each variable becomes a plain text node, so values can never add formatting, links or mentions (tested with `**Bold** <b>x</b> [link](…)`). An empty value, or a teammate without `contacts.personal_data`, gets the fallback.

**Actions (`server/macros.ts`).**

- **Allowed:** assign (teammate, team or unassign), add or remove a tag, priority, snooze (preset), close, reopen, and set a conversation attribute.
- **Limits:** up to 10 actions, and at most one of close, reopen or snooze.
- **Tickets:** `ticket_state` is part of the format but rejected with `TICKETS_UNAVAILABLE` until phase 5. The whole list is refused, never partly applied.
- **Checked when saving and again when applying:** each teammate, team, tag and attribute must exist, otherwise `MACRO_TARGET_MISSING`.

**Applying.**

- **How:** press M (search and Enter), or choose "Apply macro: …" in the command palette.
- **Idempotent:** a repeated request key changes nothing.
- **All or nothing:** the whole list is validated first, then each action runs through the existing conversation commands **as the applying teammate, with that teammate's own permissions**, in one transaction. If anything fails, even the last action, every earlier action is rolled back. A permission failure says "You don't have permission for one of this macro's actions." Updates are published only after the transaction commits.
- **The text:** the macro's text, with variables filled, is added to the composer in the macro's mode (after any existing draft text) for review before sending. A confirmation such as "Applied “Refund approved” · 2 actions · review the text, then send" is shown.

**Managing (`agent/macros.tsx`).**

- **Manager:** "Manage macros" in the palette or picker lists personal and shared macros.
- **Editor:** name, reply or note, "Shared with the workspace" (only for people allowed to share), the rich composer with a variable picker, and an actions editor limited to the allowed actions and the workspace's own teammates, teams and tags.
- **Conflicts:** saving checks the version (`MACRO_CONFLICT`).
- **Bundles:** the agent bundle grows by 3 KB gzip (226 to 229 KB); the messenger by 0.15 KB.

**Keyboard bugs found by the browser tests and fixed.**

- **Insert variable:** clicking it left focus on the button, so the next space pressed it again. It inserted a second chip and swallowed the typing in between. The button no longer takes focus on mouse-down.
- **Escape after saving:** Escape did not close the manager, because the Save button that had focus was removed. The macro dialogs now listen for Escape wherever focus is, but ignore an Escape the editor has already handled, so leaving the editor never closes the dialog and loses unsaved text.

**Seed data.** Each local workspace gets a shared "Refund approved" macro (a variable, the Refund tag and close) and the owner's personal "Ask for order number".

## 2. Files

| File | Change |
|---|---|
| `db/postgres/0020_macros.sql`, `db/rollback/0020_macros.sql` | `macros` table and capability grants (additive; rollback keeps them) |
| `server/policy.ts`, `server/people.ts` | New capabilities; `macros.use` for agents |
| `server/macros.ts`, `server/api.ts`, `server/agent-bridge.ts` | List, save, archive and apply; `GET`/`POST /v1/agent/macros`; snapshot capability |
| `lib/rich-doc.ts`, `lib/rich-view.tsx` | Variable node, `fillVariables`, rendering |
| `agent/macros.tsx`, `agent/variables.ts`, `agent/composer.tsx`, `agent/commands.tsx`, `agent/inbox.css`, `components/relay/postgres-inbox.tsx` | Picker, manager, editor, variable node, M shortcut, palette, apply flow |
| `scripts/local-relay.ts` | Sample macros |
| `tests/macros.test.ts`, `tests/rich-doc.test.ts`, `tests/browser/macros.spec.ts` | Coverage below |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 30 September 2026:

- **Node:** 39/39 pass.
  - **Saving:** each rejection (unknown variable, ticket action, two state actions, missing target, unknown action, empty macro).
  - **Permissions:** personal privacy between teammates; shared create, edit and archive need their permissions; no switching a shared macro to personal; version conflicts; other workspaces.
  - **Refused apply:** an agent without `conversations.assign` is refused whole, and the tag added before the refused assignment is rolled back.
  - **Full apply:** by the owner, with three actions and filled variables.
  - **Idempotency:** a retried apply changes nothing.
  - **Literal values:** formatting characters in a customer's name stay plain text.
  - **Personal-data fallback** for a role without access.
  - **Atomicity:** a deleted assignee refuses the whole macro, and a failure in the second action rolls back the first.
  - **Archiving.**
  - **Document rules:** variables are refused in messages and fill as text only.
- **Typecheck:** clean.
- **Browser:** 22/22 pass, and the macro tests passed three consecutive runs.
  - **Happy path:** create a shared macro with a first-name variable and two actions (a tag and priority) in the manager. Escape in its text keeps the dialog. Apply it with M and a search: the confirmation shows, the priority and tag are set, and the composer holds "Hi Jo, this is sorted.", which is then sent.
  - **Failure path:** a macro whose assignee was removed is refused with "Something this macro uses no longer exists"; the conversation stays open, and no tag is added.

## 4. Deferred and known gaps

- **Attribute actions:** setting a conversation attribute works through the API, but the actions editor does not offer it yet (it needs attribute definitions in the snapshot).
- **Tag removal** needs the conversation's tags for a useful editor; the editor offers all workspace tags.
- **Images:** macro bodies cannot contain images or mentions yet.
- **Applying to many conversations at once** is part of D3 (bulk actions).
