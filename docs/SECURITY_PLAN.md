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

11. **C3 choices** (21 October 2026, asked because C3 was larger than one step):
    - **Split:**
      - **C3a:** password sign-in, server-side sessions with idle and absolute limits, devices with remote sign-out, invitations and break-glass.
      - **C3b:** TOTP two-factor with recovery codes and a switch to require it, plus the two IP allowlists.
    - **Passwords** are hashed with scrypt from `@noble/hashes` (audited, no dependencies, the same on Workers and locally).
    - **Invitations:** the link is shown to the manager once and emailed through the alert email path (`sendAlert`, kind `invitation`).
    - **Two-factor setup** shows a QR code (`qrcode-generator`) with the key as text beside it.

12. **C3a decisions** (21 October 2026):
    - **Accounts are per workspace** (an email and password per teammate per workspace), because a host serves one workspace. Every table keeps its workspace id and row-level security.
    - **The API resolves the session on every request.** The host only passes the cookie's token along, signed in the bridge's proof, so a revoked session stops at once. Sockets check it again each time they re-validate, at least every 5 minutes.
    - **The token never reaches the page:** it lives in an HttpOnly, SameSite=Lax cookie (Secure over https). An invitation's token goes after `#`, so it never reaches a server's logs.
    - **Sign-in reveals nothing:** an unknown email and a wrong password get the same answer after the same work. Ten wrong passwords lock the account for 15 minutes, and each address may try 20 times at once, then once every 3 seconds.
    - **A new password signs out every other device.** Shortening the absolute limit applies to sessions already open.
    - **Platform sign-in stays as a method.** Its sessions aren't Relay's, so they aren't listed. A Relay session, when present, comes first.
    - **Break-glass:** an owner's password always signs in (C4's enforced SSO will keep it), and every sign-in, failure, sign-out and ended session is in the audit log.
    - **Locally,** `/agent` still signs in as the development owner (or `?as=grace`) unless a Relay session is present. Only the loopback fixture does that, never `app/` or `workers/`.

13. **C3b decisions** (21 October 2026):
    - **Two-factor is TOTP** (RFC 6238: SHA-1, six digits, 30 seconds, one step either side), from any authenticator app. The key is sealed with the connector key, like connector secrets. A code is used once: a code at or before the last one used is refused.
    - **Recovery codes:** ten, shown once when two-factor is turned on or the codes are replaced, kept only as hashes, each used once.
    - **Signing in with two-factor is two steps.** A right password gives a challenge, not a session: ten minutes, five wrong codes, then sign in again. The host keeps it in its own HttpOnly cookie (`relay_2fa`, on `/auth` only), so the page never holds it. Wrong codes also count toward the account's lock, and only a finished sign-in clears that count (a right password alone doesn't).
    - **A workspace can require it** (Security › Access, `security.manage`). Whoever turns it on must have it on themselves. Turning it on signs out password sessions without two-factor. Those teammates set it up at their next sign-in, as do new teammates accepting an invitation, before they get a session. While it's required, nobody can turn their own off.
    - **A password reset doesn't skip it.** Using the link sets the password, then asks for the code. A lost authenticator: a recovery code, or someone with `security.manage` (within their permissions) turns that teammate's two-factor off, which ends their sessions.
    - **Platform sign-in isn't Relay's to hold to two-factor.** Its two-factor is the platform's, until it's retired.
    - **Two IP allowlists** (Security › Access), each up to 100 addresses or CIDR ranges, IPv4 or IPv6. Empty means anywhere.
      - **The app's** covers the inbox, Settings and signing in, however a teammate signed in, so the hosting platform's sign-in too. It's checked on every agent request and every sign-in step, against the address the host signs into its proof. Saving a list that leaves out your own address is refused.
      - **The API's** covers the REST API (`/rest`), against the address Cloudflare sets (`cf-connecting-ip`, which a caller can't set). The local fixture sets it from the socket.
      - **Neither list is honored without an address:** if a list exists and the address is unknown, the request is refused.
      - **Allowlists stay enforced if `security_v1` is turned off,** so turning off the pages never opens access. Refused sign-ins are in the audit log; refused agent and API requests aren't, as there would be too many.
    - **Break-glass:** an owner's password plus two-factor (or a recovery code) always signs in from an allowed address. The rollback turns off the requirement and empties both lists.

14. **C4 choices** (22 October 2026, asked because C4 was larger than one step):
    - **Split:**
      - **C4a:** OIDC, domain verification, enforced SSO with owner break-glass, and just-in-time accounts with roles from groups.
      - **C4b:** SAML 2.0 on the same records.
    - **SAML** uses a maintained library, pinned. C4b starts by confirming it runs on Workers (`nodejs_compat`) and stops to ask if it doesn't. Signed XML isn't checked by hand-written code.
    - **No group maps to a role:** the sign-in is refused, says why, and is recorded. No account is made.

15. **C4a decisions** (22 October 2026):
    - **One connection per workspace** (a host serves one workspace). It's OIDC now, with SAML beside it in C4b, so both keep the same domains, role mappings and identities.
    - **OIDC is the authorization code flow with PKCE, a nonce and a state:**
      - **Saving:** the issuer's discovery document is read and its endpoints kept. The client secret is sealed with the connector key and never returned.
      - **Each sign-in:** the ID token is checked with `jose` against the issuer's keys (issuer, audience, nonce, expiry).
      - **Every call to the provider** goes through `safeFetch`/`safeRequest` (public https only; tests allow their loopback provider).
      - **In the request:** the token exchange happens in the sign-in callback, not a job, because a browser redirect can't wait for one. It has a 10-second limit.
    - **The flow runs through the host:**
      - **`/auth/sso`** starts the flow. A login row holds the state, the nonce and the PKCE verifier, and the host keeps its token in an HttpOnly cookie (`relay_sso`, `/auth` only, ten minutes, SameSite=Lax so the provider's redirect carries it).
      - **`/auth/sso/callback`** finishes it: it sets the session cookie and redirects to the inbox.
      - **Never in a URL:** the session never appears in one, and a state matches only the browser that started it.
    - **Domains are verified by a DNS TXT record** (`_relay-verification.<domain>`), checked by a job (`sso.domain.check`) through the DNS port.
      - **Only emails at verified domains** sign in through SSO, and the provider must say the email is verified.
      - **A domain is verified by one workspace at a time** (a unique index across workspaces).
    - **Identities** (`sso_identities`) are keyed by the connection and the provider's subject, never by email, so a renamed email still finds its teammate.
      - **First sign-in:** an existing teammate with that email (a password teammate) is linked; otherwise a teammate is made just in time.
    - **Roles come from groups at every sign-in:**
      - **Mappings** are an ordered list of group → role; the first match wins. No match refuses the sign-in.
      - **Owners:** the owner role can't be mapped, and an owner's role is never changed by SSO, so a workspace always keeps its owner.
      - **Role changes:** a change from the provider is recorded as a role change in the audit log.
    - **Two-factor:** SSO sessions don't ask for Relay's two-factor. The identity provider's own MFA applies; the requirement covers password sign-in.
    - **Enforced SSO:**
      - **Before it can be turned on:** it needs an enabled connection, a verified domain and one successful SSO sign-in.
      - **While it's on, for everyone but owners:** password sign-in, password resets, invitations and platform sign-in (including the local development identity) are refused, and their password sessions end when it's turned on.
      - **Break-glass:** owners keep their password (and two-factor), and each such sign-in is recorded as break-glass.
    - **Deprovisioning without SCIM** happens at the next sign-in (groups are checked each time), or when a manager ends the sessions. SCIM stays deferred.

16. **C4b decisions** (23 October 2026):
    - **The library, checked first:** `@node-saml/node-saml` 5.1.0 (pinned; signatures by `xml-crypto` 6.4).
      - **How it was checked:** in workerd through `wrangler dev`, with Relay's compatibility date and `nodejs_compat`. It validated a signed response and refused tampered, wrong-key, unsigned and signature-wrapping responses, exactly as in Node.
      - **Cost:** about 200 KiB gzipped in the Worker.
      - **Where it lives:** only in `server/saml.ts`, so the app's host bundle doesn't carry it.
    - **One connection per workspace, OIDC or SAML,** keeping C4a's domains, group mappings, identities, enforcement and break-glass. Only the protocol's step (proving who the person is) differs.
    - **Relay as the service provider:**
      - **Its values:** the entity ID is its metadata address (`/auth/saml/metadata`, served as XML); the ACS is `/auth/saml/acs` (HTTP-POST). Requests go by HTTP-Redirect.
      - **Unsigned requests:** AuthnRequests aren't signed (Relay holds no SAML key), which identity providers accept by default.
      - **What's required:** signed assertions; the response, the audience, the issuer, `InResponseTo` (the request's ID, kept on the login) and the time limits are all checked.
    - **The browser binding survives the cross-site POST:**
      - **Why it's needed:** the provider's POST can't carry the Lax login cookie.
      - **How:** the ACS parks the response on the login found by its RelayState (a random secret, used once), then sends the browser on with a 303 to `/auth/sso/callback`. That GET carries the cookie, and only that browser can finish.
      - **Unread until then:** the parked response is validated only at that step, then cleared.
    - **Who it is:** the subject is the NameID, refused when it's transient (it would make a new person each time). The email is the NameID when it's one, else the `email`/`mail` attribute. Groups come from the named attribute.
    - **Verified email:** SAML has no "email verified" flag. The verified domain stands for it: only emails at domains the workspace proved it owns sign in.
    - **Settings:**
      - **Fields:** the provider's SSO URL, entity ID and signing certificate (PEM, public, kept as text).
      - **Shown for the provider:** Relay's entity ID, ACS and metadata address.
      - **Re-proving:** changing the provider or its certificate clears "has worked", so enforcement waits for a new sign-in.
    - **The stand-in provider gains SAML,** with a fixed test key and certificate in `tests/fixtures/saml/` (test only, clearly marked).

17. **C5 choices** (27 October 2026, asked because C5 was larger than one step):
    - **Before C5:** C4b and the settings-data fix were merged first, so C5 starts from `main`.
    - **Split:**
      - **C5a:** the request workflow, the export, the deletion cascade across PostgreSQL, the deletion certificate, and an acceptance test over PostgreSQL.
      - **C5b:** the analytical store, embeddings, the third-party processor list, the backup window, and the acceptance test over every store.
    - **Records built to be permanent:** the person is erased, the counts are kept.
      - **Deleted:** their messages and conversations.
      - **Kept, stripped of anything that identifies them:** ledger and audit rows that others rely on (Zoe's resolution ledger, the connector call log, the audit log).
      - **Only during a recorded deletion:** the append-only rules allow either, never otherwise.

18. **C5a decisions** (27 October 2026):
    - **Settings › Security › Data requests** (`security.manage`, behind `security_v1`):
      - **Finding the person:** by email, phone, external ID or contact ID.
      - **Export,** or **delete** after typing their email (or "delete") to confirm.
      - **Each request** is a row (`data_requests`) and a job, with a status the page reads, and it's in the audit log by its request ID only.
    - **The export** (`dsr.export` job) is a zip: one `person.json` (their profile, emails, phones, identities, subscriptions, events, conversations and tickets with every customer-visible message) plus their files.
      - **Left out:** internal notes, teammates' private data and Zoe's internal records. They aren't the person's own data, so the zip doesn't include them.
      - **Download:** a signed link, valid for seven days, after which the sweep deletes the file.
      - **Large files:** beyond 50 MB of files, the rest are listed by name rather than included.
      - **One new dependency,** `fflate` (pinned 0.8.3, no dependencies, works on Workers), builds the zip.
    - **The deletion** (`dsr.delete` job) works from one catalog, `server/erasure.ts`. Every table in the schema is listed with what happens to it: deleted by contact, identity, conversation, ticket or address; scrubbed; or "holds no one's data", with why.
      - **Kept honest by a test:** a table missing from the catalog fails it, as `TABLE_ACTIONS` does for the audit log.
      - **Who the person is:** the contact, contacts merged into it, their identities, conversations where they are the customer, those conversations' tickets, and every email address, phone and external ID they have.
      - **Conversations someone else leads,** where they only took part (an email copy): their participation, their own messages and their addresses are removed, and the rest stays.
      - **Opt-outs and consents** for their addresses go too: nothing about them remains. If they write again, they're someone new.
      - **Files** (attachments, inline images, raw emails) are deleted from storage in the same job. A row going would otherwise lose the key to its file, so this can't wait for C5b.
    - **Append-only records under a recorded deletion** (`relay.erasure`, set only by the deletion, in its own transaction): the triggers allow:
      - **Deleting rows:** messages, delivery events, snapshots, subscription changes, job events and workflow run steps.
      - **Scrubbing only:** the resolution ledger (the conversation link and text cleared; its kind, agent and time kept, so billing's counts hold), the connector call log (conversation, inputs and outputs cleared), and the audit log (target and details cleared from rows about the person; actors kept).
      - **Anything else is still refused.**
    - **The deletion certificate:**
      - **Contents:** the request ID, the workspace, when it was asked and finished, counts per table and store, and a SHA-256 digest of the identifiers erased (never the identifiers themselves).
      - **Signature:** HMAC-SHA-256 with a key derived from the connector key, so Relay can confirm a certificate it issued (`verifyCertificate`).
      - **Where it's kept:** in the workspace, downloadable as JSON.
    - **After the deletion,** the request keeps no personal data: only its ID, its kind, its counts and the certificate.
    - **The acceptance test** seeds one person across every feature that stores customer data, deletes them, then scans every column of every table for their identifiers and a marker in their messages. Nothing may remain, except the stripped ledger and audit rows with their counts. Another customer's data is untouched.
    - **Not in C5a:** the analytical store, embeddings, the processors and backups (C5b), and the REST API (asked for later if wanted).

## Approved choices

- **Scope:** C1 to C10, without what the cut list defers (SCIM, the stricter regulated mode and data region, and the paired test workspace).
- **Teammate sign-in:** Relay owns teammate accounts. Platform sign-in stays as a method until it's retired.
- **Payments:** Stripe behind a port, with a local stand-in. No real charges.
- **Intercom:** a read-only look at its security, roles and audit settings before C1. The billing pages are left alone.
