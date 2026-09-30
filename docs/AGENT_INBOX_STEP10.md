# Agent inbox — step D2 handoff (context sidebar and app slot)

Step D2 is the second part of step D in `docs/AGENT_INBOX_PLAN.md`. The D1 handoff (macros) is `docs/AGENT_INBOX_STEP9.md`. Step D3, bulk actions with undo, is next.

## 1. What changed

**Context route (`server/context.ts`, `GET /v1/agent/context?conversation=`).** It returns:

- **The customer:** resolved from the conversation's identity through contact merges to the surviving record. It includes customer type, first and last seen, sign-up, time zone and unsubscribed status.
  - **Personal data:** name, emails and phones (from the whole merged family, verified first) and the external id are included **only** for teammates with `contacts.personal_data`. Without it, the response says so, and the sidebar shows "Your role cannot see personal details".
  - **Left out:** the free-form, untyped profile.
- **Participants.**
- **Up to five of the customer's other conversations,** covering the whole merged family, the same workspace only, and excluding merged conversations and the open one.
- **Conversation attributes:** active definitions (archived ones hidden) with current values, and whether the teammate may edit them (`conversations.manage`).
- **App cards:** an empty list until phase 15.
- **Company and custom-object cards** are marked as phase 1 TODOs; nothing is invented for them.

**Attribute editing** reuses the existing `attribute_set` command, so the type checks, permission and timeline event come for free. There is no migration.

**App-slot contract (`lib/app-slots.ts`, phase 15).**

- **Version 1:** a `conversation.sidebar` slot, and a context limited to the workspace, conversation and customer.
- **Capabilities** an app declares: `conversation.read`, `conversation.note` and `conversation.attributes.write`.
- **Card states:** loading, error and ready (text and heading blocks only).
- **A host-mediated action API:** `createAppHost` refuses undeclared capabilities, other conversations and unknown versions before anything runs; the teammate's own permissions still apply behind it.
- **Nothing is loaded:** no app code runs, and the sidebar renders an Apps section only when the server returns cards, which it does not until phase 15.

**Sidebar (`agent/sidebar.tsx`).**

- **Sections:** Customer (including their live local time, such as "14:03 local · Europe/London"), Conversation attributes, Recent conversations, Participants and, from phase 15, Apps.
- **Attribute editors** suit each type: text, number, on/off, date, and a set of choices. A change applies at once; a rejected value reverts and shows the server's reason. Read-only teammates see disabled fields.
- **Opening:** open by default on screens 1,200px or wider, and hidden below 1,000px. It is toggled with a "Details" toolbar button, the I shortcut or the palette. The choice is remembered in this browser as a UI preference only, with fallbacks when storage is unavailable.
- **Refreshing:** it reloads when the conversation's attribute-change events arrive.
- **Bundle:** the agent bundle grows by 2 KB gzip (229 to 231 KB).

**Seed data.** Every local workspace gets three conversation attributes: order number (text), plan (Free, Pro or Enterprise) and refund approved (on/off). In development, the long-history customer becomes Jo Bloggs with an email, time zone and two earlier conversations.

## 2. Files

| File | Change |
|---|---|
| `server/context.ts`, `server/api.ts`, `server/agent-bridge.ts` | Context route |
| `lib/app-slots.ts` | Phase-15 app-slot contract and host |
| `agent/sidebar.tsx`, `agent/inbox.css`, `agent/commands.tsx`, `components/relay/postgres-inbox.tsx` | Sidebar, toggle, I shortcut, palette |
| `scripts/local-relay.ts` | Attribute definitions; customer details and history in development |
| `tests/context.test.ts`, `tests/browser/sidebar.spec.ts` | Coverage below |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 30 September 2026:

- **Node:** 41/41 pass.
  - **Merges:** a merged contact's conversation resolves to the survivor.
  - **Merged family:** emails from both contacts, verified first; recent conversations include the merged contact's and exclude the open one and another customer's.
  - **Personal-data gating:** a role without access gets no names, emails, phones or ids, anywhere in the response.
  - **Attributes:** archived and non-conversation attributes hidden; a wrong type refused (`ATTRIBUTE_TYPE`); editing refused without `conversations.manage`.
  - **Workspaces:** another workspace gets 404.
  - **App-slot host:** frozen context; undeclared capability, other conversation and unknown version refused before reaching the host.
- **Typecheck:** clean.
- **Browser:** 24/24 pass, with the sidebar open by default at the test viewport. The sidebar tests passed three consecutive runs.
  - **Happy path:** name, verified email and local time shown. An order number is saved inline and recorded in the timeline. Recent conversations open from the sidebar. I hides it, the choice survives a reload, and "Details" brings it back.
  - **Failure path:** 12.5 in an integer attribute is refused with "Value does not match the attribute definition.", and the field reverts to empty.

## 4. Deferred and known gaps

- **Customer details are read-only.** Editing them needs the typed people model from phase 1, which also brings companies and custom objects.
- **App cards** are phase 15.
- **Date and multi-choice fields** have no browser test yet; the server checks them (unit tested in D1 and here).
- **Next:** step D3, bulk actions with undo.
