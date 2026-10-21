# Phase 16, step C1: the audit log

Branch `security/c1-audit`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decisions 1 and 9). Settings › Security is behind `security_v1`; recording is always on. Next: C2, roles and the permissions matrix.

## What it does

**What's recorded,** with who did it, when, and to what:
- **People and roles:** roles created, changed and deleted; permissions granted and removed; teammates added, removed, and their role, seat, schedule and limits changed; teams and their members.
- **Workspace:** features switched, brand and messenger settings, office hours, SLA policies, the portal, help centers.
- **Channels:** email settings and sending domains, SMS, WhatsApp, Facebook and Instagram, Slack and Discord connections, voice settings, the messenger's identity keys.
- **Zoe and AI:** Zoe's settings and identity, escalation rules, specialists, monitors, knowledge sources, data connectors and their credentials (as "replaced", never the value), procedures and their publishes.
- **Automation:** workflow publishes and changes, outbound messages, outbound limits.
- **Developers:** API tokens (made, renamed, revoked), apps, app installations, webhooks.
- **Data:** attributes, tags, ticket types, subscription types, segments; data exports asked for.
- **Customer records:** a customer's record opened (in a conversation's details, in People, or through the API), once an hour per teammate and customer, with whether personal data was visible. Contacts merged. Replies and notes deleted.
- **Security:** the audit log's own retention changes and exports.

**How it's shown:**
- **By the change's source:** a teammate's change is theirs; one through the API says "via an API token" or "via an app"; automatic changes are "Relay".
- **Details:**
  - **A short value:** from and to.
  - **A settings object:** which keys changed.
  - **Anything long:** only that it changed.

**Settings › Security › Audit log** (for who manages the workspace):
- **Filters:** time, area, teammate (or Relay) and a search over names and ids. Newest first, 50 at a time.
- **Export:** CSV or JSON of everything that matches, prepared in the background, with a download link. The export is itself recorded, and CSV cells starting with a formula character are neutralised.
- **Retention:** 90 days to 7 years (a year by default). Changing it is recorded.
- **Nothing on the page** can change or remove an event.

## How it works

**Migration `0081_audit_log`:**
- **`audit_events`:** append-only. A trigger refuses any update and any delete, except retention's pruning under a transaction flag. It has row-level security and indexes by time, action, actor and target.
- **`audit_settings`** (retention).
- **`audit_change` and `audit_row`:** one generic trigger, configured per table (its action prefix, target type, id and name columns, ignored columns, and its insert and delete verbs). It's on 45 administrative tables.
- **Hot tables list their columns** (`UPDATE OF`), so routing's and presence's frequent writes never reach it. Personal API tokens only: an app's hourly tokens are audited as its installation.
- **The `security_v1` flag.**

**The actor:**
- **`authorize`** (`server/policy.ts`) sets `relay.actor_id` and `relay.actor_name` in its own query.
- **The API** (`server/rest.ts`) sets `relay.actor_via` before authorizing.
- **Both are transaction-local,** so every audit row in that transaction, from triggers or `recordAudit`, names them.

**Secrets:**
- Columns named like secrets, hashes, sealed values, tokens, wrapped keys or verification tokens are never copied.
- A change to one adds `"secret": "replaced"`.

**Code:**
- **`server/audit.ts`:** `recordAudit`, `recordContactView`, `actingVia`, `readAudit`, `changeAudit`, `auditExportJob` (the `audit.export` job) and `pruneAudit` (in the sweep, a thousand at a time).
- **`lib/audit-actions.ts`:** the registry: areas, verbs, `TABLE_ACTIONS` and `EXPLICIT_ACTIONS`.
- **`agent/settings-audit.tsx`:** `#settings/audit`, in a new Settings group, Security.
- **Explicit records:** `server/context.ts`, `server/segments.ts` and the API's `getContact` record views. `createExport` records an export. `command`'s delete records a deleted part.

**The rollback** drops the 45 recording triggers and turns `security_v1` off. The log and its settings stay, still append-only.

**Seed data:** none. The log fills as the workspace is used (on a fresh local relay, the seed's own setup is recorded as Relay).

## Checks

- **`tests/audit.test.ts`:**
  - **Changes:** a role made and a teammate moved to it, by the owner with from and to. Permissions granted. A token made and an app's secret replaced, with no secret or hash anywhere in the log.
  - **The API:** the same teammate, via the token. A contact read twice is recorded once. An export is recorded.
  - **The inbox:** Grace opening a conversation's details is recorded once, with no personal data visible to her.
  - **Append-only:** update and delete refused.
  - **Reading:** managers only; newest first by number; filters by area, teammate and text; bad dates refused; paging; another workspace sees none of it; off means not found.
  - **Export:** recorded; bad filters refused up front; the CSV's header and rows, with a formula neutralised.
  - **Retention:** limits enforced, the change recorded, and only older events pruned.
  - **The registry:** it matches the triggers both ways, and every verb has words.
  - **Rollback.**
- **`tests/browser/audit.spec.ts`:**
  - **Happy path:** a tag added in Settings is in the log as the teammate's. Filtered to Data, its details open, an export downloads as CSV with it, and changing retention and exporting are both recorded.
  - **Failure path:** an agent sees no Audit log in Settings, and reading or exporting it is refused (403).
