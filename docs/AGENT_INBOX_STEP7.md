# Agent inbox — step C3a handoff (mentions and notifications)

Step C3 of `docs/AGENT_INBOX_PLAN.md` is split into two parts:

- **C3a (this document):** mentions, in-app notifications and the Mentions view
- **C3b:** viewing and composing indicators, plus private routing of typing signals

## 1. What changed

**Mention node (`lib/rich-doc.ts`).**

- **Shape:** an inline node, `{ type: "mention", attrs: { kind: "teammate" | "team", id, label } }`.
- **Limits:** a directory-style id, a label up to 100 characters, and at most 20 per message.
- **Plain text:** a mention appears as `@label`.

**Sending (`server/mentions.ts`, `server/conversations.ts`).**

- **Notes only:** a reply containing a mention is refused with `MENTION_IN_REPLY` (400), so teammate names never reach customers.
- **Checked against the directory:** every mention must name a teammate or team in this workspace, otherwise `MENTION_NOT_FOUND` (404). The server rewrites each label from the directory, so a spoofed label ("The CEO") is stored as the real name, and the plain text is derived again.
- **Who is notified:** teams expand to their members **at send time**. Duplicates are removed, and the author is never notified, even through a team they belong to.
- **Edits:** an edited note notifies only people who were not notified for an earlier version.

**Storage (migration 0019).**

- **`conversation_mentions`:** one row per note part and mentioned teammate. A trigger re-evaluates the conversation for the Mentions view.
- **`notifications`:** belong to one teammate, with a 140-character plain-text excerpt, a read time and indexes for unread counts. Both tables use row-level security.
- **Reading them:** every query filters on the signed-in teammate. Nobody can list or mark another teammate's notifications, including in the same workspace.

**Notifications.**

- **Routes:** `GET /v1/agent/notifications` returns the latest 50 plus the unread count; `POST` marks listed ids, or all, read.
- **Live count:** the unread count is part of each agent's batched socket update.
- **Bell:** a bell in the navigation shows the count; its accessible name is "Notifications, N unread".
- **Panel:** lists who mentioned you, where, the excerpt and when. Opening one goes to the conversation and marks it read. "Mark all as read" and a palette command are also there.
- **In-app only:** email and push remain with the channels phase.

**Mentions view.**

- **Filter:** a new `mentioned` filter field, equality only and bound as a parameter.
- **Default view:** each teammate now gets **Mentions** (closing the B1 TODO), in the order Mine, Mentions, Unassigned, All open, Snoozed, Closed.
- **Existing teammates:** they get it through the idempotent `initialize` action, which the views list now runs once when any default view is missing.

**Composer (`agent/mentions.tsx`, `agent/composer.tsx`).**

- **Picker:** in note mode, `@` opens a keyboard-navigable list of teammates and teams, using `@tiptap/extension-mention` and `@tiptap/suggestion` 3.31.3. Arrow keys move, Enter or Tab chooses, Escape closes.
- **Reply mode** has no mention node at all, so `@` is plain text there.
- **Directory freshness:** the picker uses the directory from when the editor was created (per conversation and mode). The server checks every mention again at send.

**Bundles.** The agent bundle grows by 13 KB gzip (212 to 225 KB). The messenger frame grows by 0.2 KB, for mention styling in the shared renderer.

**Local development.**

- **Grace:** the seed adds a second teammate, Grace, to the Billing team.
- **Signing in as Grace:** the loopback-only `/agent?as=grace` page does it, so two people can try mentions on one machine. The deployed Worker has no equivalent.

## 2. Files

| File | Change |
|---|---|
| `db/postgres/0019_mentions_notifications.sql`, `db/rollback/0019_mentions_notifications.sql` | Mentions, notifications, view trigger (additive; rollback keeps them) |
| `lib/rich-doc.ts`, `lib/rich-view.tsx` | Mention node, `mentions`, `relabelMentions`, rendering |
| `server/mentions.ts`, `server/conversations.ts` | Resolve, relabel, expand, record and notify; notes only; edits notify new people only |
| `server/api.ts`, `server/agent-bridge.ts`, `server/realtime-batch.ts` | Notification routes; unread count in socket updates |
| `server/inbox-views.ts`, `agent/views.tsx` | `mentioned` filter, Mentions default view, automatic top-up |
| `agent/mentions.tsx`, `agent/notifications.tsx`, `agent/composer.tsx`, `agent/inbox.css`, `components/relay/postgres-inbox.tsx` | Picker, bell, panel, palette command |
| `scripts/local-relay.ts` | Grace, Billing membership, `?as=grace` |
| `package.json` | `@tiptap/extension-mention` and `@tiptap/suggestion` 3.31.3, exact versions |
| `tests/mentions.test.ts`, `tests/rich-doc.test.ts`, `tests/inbox-views.test.ts`, `tests/browser/mentions.spec.ts` | Coverage below; the views test now expects six default views |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 30 September 2026:

- **Node:** 36/36 pass.
  - **Labels:** a spoofed label is rewritten from the directory.
  - **Recipients:** Grace, mentioned directly and through Billing, is notified once; the author, although in Billing, is not.
  - **Refusals:** mentions in replies and unknown or malformed ids.
  - **Edits:** only the newly mentioned teammate is notified.
  - **Privacy:** notifications are per teammate and per workspace; a teammate cannot mark another's read.
  - **Live count:** the unread count reaches the socket and drops when read.
  - **Mentions view:** holds the conversation and follows a new mention live.
  - **Customer:** sees no mention.
  - **Document rules:** the mention node's rules.
- **Typecheck:** clean.
- **Browser:** 18/18 pass.
  - **Happy path:** the owner mentions Grace in a note with the keyboard. Grace's bell goes to 1 without a refresh, the notification opens the conversation and returns the bell to 0, and her default views (added automatically) include Mentions with that conversation.
  - **Failure path:** in a reply, `@` offers no picker. A note mentioning a teammate removed before sending is refused with a clear error, and the note, including its mention, stays in the composer.
  - **Stability:** the mention tests passed three consecutive runs.
- **Unexplained log lines:** one full browser run logged two unexpected server errors (`Relay API failed`, type `Error`), with all tests passing. They did not recur in five further runs, including full-suite runs with detailed logging, so the cause is unknown and recorded here.

## 4. Deferred and known gaps

- **Removed teammates:** mentioning someone deleted after the page loaded is refused at send. The picker does not refresh the directory mid-session.
- **Custom views** can filter on `mentioned` through the API, but the filter editor does not offer it yet.
- **Notification lifetime:** notifications are never deleted. Retention is for the admin phase.
- **Step C3b** covers "who is viewing" and "who is writing", and stops note typing reaching customers.
