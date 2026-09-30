# Agent inbox — step C1 handoff (timeline and fast actions)

Step C of `docs/AGENT_INBOX_PLAN.md` is split into three parts:

- **C1 (this document):** timeline rendering, snooze and keyboard control
- **C2:** the composer (rich text, inline images, server-backed drafts)
- **C3:** collaboration (mentions and notifications, the Mentions view, viewing and composing indicators)

## 1. What changed

**Timeline (`agent/timeline.tsx`).**

- **System parts:** each kind the conversation core writes now has readable text. Examples: "Ada assigned this to Grace and team Billing", "Ada snoozed this until Thu 1 Oct, 09:00 BST", "Unassigned when the snooze ended", "Another conversation was merged into this one", and ratings, tags, participants, titles, topics and channel handovers. Before, the timeline showed the raw kind name ("state change").
- **Event runs:** consecutive system events collapse into one keyboard-operable line, such as "Show 3 updates".
- **Edits:** replacement parts are marked "Edited", and deleted parts still say so.
- **Attachments:** internal attachments are labelled "Team only".
- **Message cards:** unchanged.
- **Directory:** names come from teammates, teams and tags, which the inbox snapshot now includes.

**Snooze (`server/snooze.ts`, migration 0016).**

- **Presets:** later today (+3 hours), tomorrow 09:00, and next week (the coming Monday, 09:00).
- **Where presets resolve:** on the server, in the IANA zone the browser reports. The client never sends a computed instant for a preset. Local 09:00 is resolved in two passes, so it is correct on daylight-saving days.
- **Custom times** must carry an explicit offset.
- **What is stored:** the zone used, plus an optional **unassign when it wakes** flag (off by default). The state-change part records the time, zone, preset and flag.
- **Wake:** a wake unassigns only if the flag belongs to the current snooze. Any transition clears it, and the existing version check ignores a replaced timer.
- **Bug fixed:** `wakeConversation` compared the snooze version as a string to a value PGlite returns as a number. On the local relay, snoozed conversations never woke.

**Fast actions (`agent/commands.tsx`, `components/relay/postgres-inbox.tsx`).**

- **Thread toolbar:** close or reopen, snooze, assign to me and priority, with the current state shown.
- **Optimistic updates:** each action applies at once and reverts with an error if the server rejects it.
- **Shortcuts:**

  | Key | Action |
  |---|---|
  | J / K | Next / previous conversation (views and plain list) |
  | R / N | Reply / note (focuses the composer) |
  | ⌘/Ctrl Enter | Send |
  | Esc | Leave the composer |
  | E / Shift E | Close / reopen |
  | S | Snooze |
  | A | Assign to me |
  | P | Toggle priority |
  | / | Search this view |
  | ? | Shortcut sheet |
  | ⌘/Ctrl K | Command palette |

  Shortcuts are ignored while typing or composing with an input method. Every action is also a visible button.
- **Command palette:** a searchable, keyboard-navigable list covering close and reopen, the snooze presets and a custom time, assign (me, any teammate, any team, unassign), tags, priority, reply and note, going to any view, search and help. Macros join it in step D (TODO in the code).

## 2. Files

| File | Change |
|---|---|
| `db/postgres/0016_snooze_options.sql`, `db/rollback/0016_snooze_options.sql` | `snooze_unassign` and `snooze_timezone` (additive; rollback keeps them) |
| `server/snooze.ts` | Preset and custom wake resolution, timezone validation |
| `server/conversations.ts` | Snooze options on the command, unassign-on-wake, version comparison fix, fields exposed to agents |
| `server/api.ts` | Snapshot adds teammates, teams, tags and the `manage` capability |
| `agent/timeline.tsx`, `agent/commands.tsx`, `agent/inbox.css` | Timeline text and grouping; palette, sheet and snooze menu |
| `components/relay/postgres-inbox.tsx`, `agent/views.tsx` | Toolbar, optimistic actions, shortcuts; J/K and view switching in the views list |
| `scripts/local-relay.ts` | Seeds a team and two tags per workspace |
| `tests/snooze.test.ts`, `tests/timeline.test.ts`, `tests/browser/triage.spec.ts` | Coverage below |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 30 September 2026:

- **Node:** 28/28 pass.
  - **Presets across daylight-saving and fixed-offset zones:** London and New York on their change days, Kolkata at +5:30, Auckland's Monday, Tokyo.
  - **Unassign-on-wake:** the current snooze only; a replaced or reopened snooze cannot unassign; another workspace gets 404; invalid input is refused.
  - **Timeline text:** every one of the 15 part kinds in the schema's `CHECK`.
- **Typecheck:** clean.
- **Browser:** 12/12 pass.
  - **Keyboard-only triage** in `Europe/London`: J to open, expand the event run, R and Ctrl Enter to reply, S then Tomorrow (checked against the server's resolution in London time), Shift E, E, then ⌘K "unassign", then ? and Esc.
  - **Rejected snooze:** shows "snoozed" optimistically, then reverts to "open" with the error.

## 4. Deferred and known gaps

- **Tag removal** is not in the palette yet. It needs the conversation's current tags in the snapshot. The timeline shows removals.
- **Palette search** is a word match, not fuzzy ranking.
- **Macros** are in step D. **Mentions** and the **Mentions** view are in step C3. **Rich text, inline images and drafts** are in step C2.
- **Lint:** the two `agent/views.tsx` findings from B1 remain. The new files are clean.
