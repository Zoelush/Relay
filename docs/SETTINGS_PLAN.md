# Settings: plan

A Settings area for everything built so far, after Beacon's (`app.beacon.com.ng`) and Intercom's. The user asked for it before phase 07 step C2b ("build a proper settings that everything that has been built so far links to and build mine"). Both products' settings were read in the browser, read-only: pages opened, nothing changed or saved.

- **From Beacon:**
  - a gear in the icon strip
  - a side menu grouped Personal, Workspace, Inbox and Platform
  - each page a title, one line on what it's for, a Save button, and cards of explained fields
- **From Intercom:** a home page of cards in groups, each a title and a line.

Approved on 3 October 2026 ("Yes, go ahead with all four"):
1. **Three steps,** S1, S2, S3, in that order.
2. **Who sees what:** everyone sees Personal; each workspace page shows only to those with its permission.
3. **Where things live:**
   - Macros, and later team settings, move into Settings, with their old buttons opening the Settings page.
   - Knowledge's pages stay in Knowledge, and Settings links to them.
4. **A `settings_v1` flag,** off by default and on for the local relay.

| Step | Scope |
|---|---|
| **S1: Frame and personal** | The gear, side menu, home of cards, page frame and addresses (`#settings/<page>`). Your profile (name, timezone, reply signature), Notifications (desktop and sound), Appearance (theme). Workspace › General (name, timezone, team language). Macros moved in. Links to saved views, help centers, websites and the AI index. |
| **S2a: Helpdesk, routing and time** | Teams and assignment (members, routing method, limits; moved from the Workload panel), office hours, SLAs |
| **S2b: Helpdesk, data** | Tags and conversation attributes (new server code), then ticket types (states, transitions and fields) |
| **S3: People and channels** | Teammates (a list with roles to change), roles and permissions, brands, messenger (appearance, greeting, identity verification, allowed websites, install snippet), customer portal |

**Left out until their phase**, with TODOs in `server/settings.ts`:

| Item | Phase |
|---|---|
| Inviting teammates, security, audit log, usage and billing | 16 |
| API keys and webhooks | 15 |
| Email and other channels | 12 |
| AI agent settings | 08 |

S2 was split on 3 October 2026 ("Yes, go ahead with all three"):
- **Teams aren't deleted** until a later step adds archiving.
- **Tags** are archived, never hard-deleted.
- **An attribute's type** is fixed once created.

Handoffs: `docs/SETTINGS_STEP1.md` (S1), `docs/SETTINGS_STEP2.md` (S2a).
