# Phase 16: Security, compliance, admin and billing (plan)

Brief: `docs/BUILD_PHASES.md` phase 16 ("needs all prior"). Phases 02 to 15 are done locally to their agreed scopes; 01 is partial (no companies, custom objects or tags on people). Drafted on 20 October 2026, after "go ahead with phase 16", and approved that day:
- **Scope:** C1 to C10, without SCIM, the stricter regulated mode (and data region) or the paired test workspace, which wait until asked.
- **Sign-in:** Relay owns teammate accounts.
- **Payments:** Stripe behind a port, with a local stand-in.
- **Before C1:** a read-only look at Intercom's security, roles and audit settings.

The brief's point: every item has blocked a deal for someone. The permission layer stays one policy module. On billing, the hard part is a ledger a customer can audit when they dispute an invoice. The cut list keeps **SSO, the audit log and data deletion** and lets **HIPAA mode, data residency and SCIM** wait a year.

**Acceptance:**
- **A deletion test:** no trace of a contact remains in any store, the search index and embeddings included.
- **An invoice reconciliation test:** every metered unit resolves to a source record.
- **A permissions test matrix** over every role and every sensitive route.

## Where Relay is today

**Already there:**
- **One policy module** (`server/policy.ts`): 21 capabilities, `authorize` and `can`. Every route checks it, and API scopes and OAuth scopes map onto it.
- **Roles:** custom roles in Settings › Roles, with permissions named in plain words (`agent/settings-people.tsx`). A role changes only within the acting manager's own permissions, always leaving an owner.
- **Personal data by permission:** `contacts.personal_data` hides names, emails and phones in the inbox, the sidebar and the API.
- **Zoe's resolution ledger** (`ai_resolutions`, append-only, reversals not edits). Phase 08 built it for billing.
- **What left for a model** (`ai_model_calls`, 90 days) and the answer's redactor (`server/ai-privacy.ts`).
- **Audits in some places:** merges, Zoe's actions (`server/ai-audit.ts`), webhook deliveries, connector calls and canvas calls. Each is its own log, though; there's no workspace-wide audit log.
- **Deletion in some places:** suppression lists, and attachments' scanning and expiry. There's no deletion of a contact across stores.
- **Encryption:** secrets are sealed with the connector key, and tokens and secrets are kept only as hashes.

**Missing:**
- **Relay's own teammate accounts.** Teammates sign in through the hosting platform when deployed (`app/chatgpt-auth.ts`), and as `?as=` locally. So there are no passwords, 2FA, sessions, devices, session policy or SSO.
- An audit log, retention policies, data subject requests, content redaction, link safety and IP allowlists.
- Plans, seats, metering, limits, invoices and payments.

## What Intercom does (a read-only look, 20 October 2026)

Settings › Security and Settings › Teammates on a live workspace, and the personal security pages. Nothing was changed, and the billing and usage pages weren't opened.

- **Security is one page with tabs:**
  - **Workspace:**
    - **Authentication methods:** email and password (with a switch to require 2FA, which the admin must have turned on for themselves first), Google sign-in, and SAML SSO.
    - **A security contact address.**
    - **Two IP allowlists:** one for the app, one for the REST API (IPs or CIDR ranges).
    - **A custom session length** (the default: re-authenticate after 4 days without activity).
    - **AI switches:** memory, and model training on customer data.
  - **Data:**
    - **Content redaction** (built-in and custom rules; matches become asterisks).
    - **Conversation text in notification emails.**
    - **Risky merges:** two separate switches, one for merging conversations across different people (with a warning) and one for merging unverified leads into users by email.
  - **Attachments:** which file types customers may send, plus any others listed (some always forbidden), and which messenger inputs are allowed.
  - **Links:**
    - **Two warnings:** "untrusted" (review before opening) and "malicious" (acknowledge the risk before opening).
    - **Trusted and blocked policies** by domain, with defaults (the vendor's own domains) shown apart from the workspace's own. A blocked link can't be opened.
  - **Customer authentication:** verification rules per channel and audience before data connectors run. Relay has this as phase 09's verification rules.
  - **Health Check:**
    - **Recommended actions,** ranked Critical or Pending.
    - **Three groups:** Authentication and access (secure login required, session length), Messenger security (trusted domains, the end user's session length, the secure messenger) and Data protection (link warnings, data attributes sent securely).
    - **Each row** shows its state and links to its setting.
- **Teammates has five tabs:** Teammates, Invited, Roles, SCIM provisioning and Activity logs.
  - **The teammate list:** status, seat (Full shown), Copilot access, permission, teams and alias, with filters and CSV export.
  - **Roles:** a list, with "New role" (unavailable on this plan).
  - **Activity logs:** filtered by date and time range, teammate and activity type (about 300 types, grouped by area, such as AI agent settings changes, action publishes, and admin impersonation sessions starting and ending), with a download.
- **Personal security:**
  - **Account security:** change email (confirmed by link) and password, 2FA, and active sessions (login time, IP, browser, operating system and approximate location), each of which can be ended.
  - **Account access:** grant the vendor's support team access to all your workspaces for 14 days. It expires automatically, can be revoked earlier, and keeps a history.

**What Relay takes from this:**
- **The audit log's activity types are many and specific,** grouped by area. C1's are a registry, as webhook topics are, so filters and exports name them.
- **Settings › Security as one page with tabs** (Sign-in, Data, Attachments, Links, Health check). The audit log and sessions live beside it.
- **Health check rows** are each a state plus a link to the setting, ranked by severity.
- **Vendor access** is per person, time-limited (14 days), revocable and recorded.

## Steps

| Step | Scope |
|---|---|
| **C1: The audit log** | **Append-only:** a trigger refuses any change, and nothing in the product can edit it. It's written in the same transaction as the action.<br>**What's recorded:** sign-ins, permission and role changes, data exports, deletions, settings changes, API token, OAuth app and webhook changes, connector changes, workflow publishes, and a teammate opening a customer record.<br>**Settings › Security › Audit log:** search and filter, with CSV and JSON export (a job).<br>**Retention:** configurable, at least a year by default, pruned by the sweep and never from the UI. |
| **C2: Roles and the permissions matrix** | **The permission editor:** explains every capability in plain words, grouped, and shows what a role can and can't do.<br>**Restricted roles** (for outsourced teams) gain a **scope**: only conversations assigned to them or their teams, and no personal data. The scope is enforced in one place: lists, search, counts, realtime, the API, exports and reports.<br>**Limited seats' capability limits** (no inbox search, open by link) are written into the seat policy, which C8 reads.<br>**The acceptance matrix:** every role against every sensitive route, generated from the route table, so a new route without a row fails the test. |
| **C3: Teammate accounts and sessions** | **Relay's own sign-in:** email and password (Argon2id or scrypt), TOTP two-factor (which a workspace can require), recovery codes, and invitations.<br>**Sessions** are kept on the server, under a session length policy (inactivity and absolute limits). A device list shows each session, with remote sign-out.<br>**IP allowlists,** separate for the app and the API.<br>**The break-glass path,** documented: an owner's password plus 2FA always works, and is always audited.<br>**Platform sign-in** stays as a method until it's retired. |
| **C4: SSO** | **OIDC and SAML 2.0** per workspace, with domain verification. **Enforced SSO** keeps break-glass for owners only.<br>**Just-in-time accounts** take their role from the identity provider's groups.<br>**SCIM 2.0** (users and groups, deprovisioning, role mapping from groups) is deferrable. |
| **C5: Data subject requests** | **Export:** everything about one contact, as machine-readable JSON plus files (a job, with a signed link).<br>**Delete:** everything about one contact, with a documented cascade: conversations and parts, attachments (R2), events, the analytical store, the search index, embeddings (the vector store), Zoe's records, channel records, connector and webhook logs, and the third-party processors (a list, with what's sent to each).<br>**Backups:** expire within their window, which is documented.<br>**A deletion certificate** (signed, with counts per store), which the workspace keeps.<br>**The acceptance test:** no trace remains in any store. |
| **C6: Retention and redaction** | **Retention policies** per data class (conversations, attachments, call recordings, events, logs), including automatically deleting conversations after a period. It's a job using C5's cascade, audited.<br>**Content redaction rules:** built-in (cards, IBANs, national ids) and custom (a pattern), applied to conversation text when stored, with the original never kept.<br>**Personal-data redaction** in logs and error reports. Per-workspace controls over what's sent to a model provider, which `ai_model_calls` records. |
| **C7: Security posture** | **Link safety:** trusted and blocked domains, a warning on untrusted links, and malicious links a teammate must acknowledge.<br>**Risky merges:** switches for merging conversations across different people, and for merging unverified leads into users by email.<br>**Vendor support access:** time-limited and audited.<br>**A security health check** summarising the workspace's settings.<br>**In the product:** the subprocessor list, plus encryption and key management, documented.<br>*Deferrable:* the stricter regulated mode (no third-party model training, restricted attachment types, mandatory audit review, data region), and a test workspace paired with production (it also serves phase 15's D6 sandbox). |
| **C8: Plans and seats** | **One plan policy document** (`lib/plans.ts`) maps features and limits to tiers. **One gating module** reads it, and a test fails on a feature check outside it.<br>**Seats:** full and limited, with prorated changes and a view of who occupies each. |
| **C9: Metering, limits and the spend cap** | **Every billable unit is metered from its source record:** AI outcomes (the phase 08 ledger), SMS segments, email, WhatsApp, phone minutes, outbound messages by type, and connector calls. A usage page traces each unit back to its conversation or message.<br>**Alerts** (notify only) and **limits** that pause a feature, never the product. A full limit on Zoe sends conversations to people.<br>**A spend cap** the customer controls. |
| **C10: Invoices and the billing lifecycle** | **Invoices** are computed from the meters, with each line tracing to its units. The reconciliation test covers them.<br>**A payment provider port:** Stripe deployed, a stand-in locally, and no real charges from tests.<br>**The lifecycle:** trials, upgrades, and downgrades with a defined behaviour for data over the lower plan's limits. Also dunning, and invoices in Settings › Billing. |

## Decisions (proposed)

1. **One audit log, written by the action's own transaction** (not after the fact), append-only by trigger, like `ai_resolutions`. The existing narrow logs stay, and the audit log points to them.
2. **Restricted scope is part of the policy module,** not a filter in each query. `access` and a single `visibleConversations` predicate are used by every list, search, count, realtime fan-out, export and API read. The matrix test enforces it.
3. **Teammates' passwords use a memory-hard KDF.** Sessions are opaque tokens kept as hashes on the server, so they can be listed and revoked. A signed cookie alone couldn't be revoked.
4. **SSO and SCIM map onto the same teammate and role records:** no second identity table. Deprovisioning ends sessions and tokens at once.
5. **Deletion has one cascade** (`eraseContact`), used by data subject requests and by retention. Each store has an eraser and a "find any trace" probe. The acceptance test runs every probe.
6. **Plans are data, gates are code in one place:** `gate(workspace, feature)` and `limit(workspace, meter)`. The existing feature flags stay as rollout switches, separate from plan gating.
7. **Meters never count:** they read their source records (the ledger, deliveries, calls). An invoice line is a query over those records for a period, frozen with its record ids when issued, so a dispute can be checked line by line.
8. **No real money moves locally or in tests.** The payment provider sits behind a port; Stripe's test mode only deployed until launch.

9. **C1 decisions** (21 October 2026):
    - **Triggers write the log, in the change's own transaction:** one generic `audit_row` trigger on each of 45 administrative tables, so a new code path can't skip it. `recordAudit` covers what isn't a row change (a customer record opened, an export asked for, a reply or note deleted).
    - **The actor comes from the transaction:** `authorize` sets `relay.actor_*` in its own query (no extra round trip). The API adds `relay.actor_via` (the token, or the app's installation). Anything without an actor is "Relay" (the system).
    - **Never a secret:** columns named like secrets, hashes, sealed values or tokens are never copied. Changing one is recorded only as "a secret was replaced". Long values are recorded as changed, objects as which keys changed.
    - **Noise is left out by the trigger:** hot tables list only the columns that matter (`UPDATE OF`), and last-used times, presence and check times are ignored. An app's hourly access tokens aren't audited; its installation is.
    - **Opening a customer's record** (inbox details, People, the API) is recorded once an hour per teammate and customer, with whether they could see personal data.
    - **Recording is always on.** `security_v1` gates Settings › Security only. Retention is 365 days by default (90 days to 7 years), pruned by the sweep under a transaction flag the append-only trigger checks.
    - **Who reads it:** who manages the workspace (`workspace.manage`) until C2's permission editor gives it a capability of its own.

10. **C2 decisions** (21 October 2026):
    - **A role has a scope:** every conversation, or only those assigned to its teammate or their teams. The rule is written once in `server/policy.ts`: `visibleTo` for one conversation (in `access`, which every conversation route uses), and `scopeSql` for every list, count and search. `authorize` loads the role's scope (and the teammate's teams, only when restricted) in the query it already runs.
    - **A restricted role holds only conversation work:** read, reply, note, work on, assign, delete, and use macros. Never personal data, reports, exports, shared macros, or anything that manages the workspace. The editor says so, the server refuses it in words, and migration 0082's trigger refuses it whatever the code does. The owner role is never restricted.
    - **Restricted teammates work from Mine and their team inboxes only.** All, Unassigned, Mentions and custom views count across the workspace, so they aren't listed or opened, and the inbox's counters drop workspace-wide totals. Notifications from conversations they can't see aren't shown.
    - **A new permission, `security.manage`,** for the audit log (and C3's sign-in settings), given by the migration to every role that managed the workspace. `macros.manage` is marked old (nothing checks it) and isn't offered.
    - **The matrix is a reviewed table** (`tests/fixtures/route-policy.ts`): every agent route and the one permission it needs, written from probing each route with single-permission roles. The test holds every kind of role to it, and fails on a route that isn't listed. The public API's operations are held to their scopes the same way.
    - **Limited seats' limits** (no inbox search, open by link) move to C8, with seats.

## Approved choices

- **Scope:** C1 to C10, without what the cut list defers (SCIM, the stricter regulated mode and data region, and the paired test workspace).
- **Teammate sign-in:** Relay owns teammate accounts. Platform sign-in stays as a method until it's retired.
- **Payments:** Stripe behind a port, with a local stand-in. No real charges.
- **Intercom:** a read-only look at its security, roles and audit settings before C1. The billing pages are left alone.
