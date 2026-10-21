# Phase 16, step C2: roles and the permissions matrix

Branch `security/c2-roles`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decisions 2 and 10). Next: C3, teammate accounts and sessions.

## What it does

**Restricted roles** (Settings › Roles › "Which conversations": "Only conversations assigned to them or their teams"):
- **What they see:** only the conversations assigned to the teammate, or to a team they're on.
- **Where it holds:**
  - the inbox list
  - views and counters (only Mine and their team inboxes)
  - search
  - a conversation's details and the customer's other conversations
  - the timeline and live updates
  - notifications (a mention in a conversation they can't see isn't shown)
  - Zoe's audit of a conversation
  - linking tickets
  - every conversation action
  - the API, with their own token: listing, search, reading, parts, replies and tickets
- **Anything else** answers "Conversation unavailable", as if it didn't exist.
- **What they may have:** see, reply, note, work on, assign and delete in conversations, and use macros.
- **What they never have:**
  - customers' personal details
  - reports
  - exports
  - shared macros
  - ticket types or knowledge
  - managing the workspace, teammates, security or billing
- **How that's held:**
  - **The editor** turns those off ("Not for restricted roles").
  - **The server** refuses them by name ("A restricted role can't have: See customers' personal details.").
  - **The database** refuses them however they arrive.
- **The owner role** always sees everything.
- **Restricted teammates** keep their built-in views and make no others.

**The permission editor:**
- **Every permission says what it lets someone do,** grouped: Conversations, Customers, Macros, Helpdesk and knowledge, Reports and data, Workspace, Security and billing.
- **A summary,** "Teammates with this role can't", lists everything the role is missing before it's saved.

**A new permission, Manage security,** covers the audit log (and C3's sign-in settings). Every role that managed the workspace has it.

## How it works

**`server/policy.ts` is the one definition:**
- **`authorize`** also returns `restricted` and, only when restricted, the teammate's teams, in the query it already runs.
- **`visibleTo(teammate, conversation)`:** one conversation. It's used by `access`, which every conversation route goes through, and by Zoe's audit.
- **`scopeSql(teammate, alias, values)`:** the same rule for a query ("true" when unrestricted). It's used by:
  - the inbox list
  - `viewPage`
  - search
  - recent conversations
  - notifications
  - the tracker list
  - the API's list, search, read and tickets (the API's context now carries `me`, the authorized teammate)

**`lib/permissions.ts`:**
- **What each capability means** (label, description and group), and whether a restricted role may have it. The editor, token pickers and the consent screen read it.
- **`macros.manage`** is marked old: nothing checks it, so it isn't offered.

**Migration `0082_role_scope`:**
- **`roles.scope`** (`all` or `assigned`).
- **`role_scope_allows` and the `role_scope_guard` trigger** on `role_capabilities` and `roles`.
- **`owner_sees_all`**, so the owner role is never restricted.
- **`security.manage`** for every role with `workspace.manage`.
- **Its rollback** drops the guard and makes every role see everything again. The column and grants stay.

**Saving a role** (`saveRole`):
- **Widening** sets the scope first.
- **Restricting** sets it last, once the role holds only what a restricted role may.

**Seed data:** none (a restricted role is made in Settings).

## Checks

- **`tests/permissions-matrix.test.ts`** (the acceptance matrix):
  - **Completeness:** every capability is explained, and every agent route has its line in `tests/fixtures/route-policy.ts`.
  - **The roles:** owner, admin, agent, a restricted role, a reading-only role, and roles with one permission each.
  - **Agent routes:** each role is refused (403) exactly when it lacks the route's permission.
  - **API operations:** each is held to its scope, and a token stops working when its teammate's role loses the permission.
- **`tests/restricted-roles.test.ts`:**
  - **Refusals:** the role's limits refused in words and by the database; the owner never restricted.
  - **Surfaces:** a restricted teammate's inbox, counters, views, search, details, recent conversations, notifications, actions and API are all limited to their own and their team's conversations.
  - **The sweep:** every GET route, asked about a conversation outside the scope, shows nothing of it.
  - **Widening and restricting again.**
  - **Rollback.**
- **`tests/browser/roles.spec.ts`:**
  - **Happy path:** a restricted role made in Settings, with its explanations, disabled permissions and summary, then given to Grace. Her inbox holds only her conversation.
  - **Failure path:** Grace can't open, read or reply to another conversation (404), and a restricted role with personal data is refused with the reason, with nothing saved.
- **The sweep found one gap,** which is fixed: Zoe's audit of a conversation didn't check who could see the conversation.
