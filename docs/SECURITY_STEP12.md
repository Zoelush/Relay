# Phase 16, step C7b: vendor support access

Branch `security/c7b-support-health`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decisions 27 and 28). C7b was split again, as asked: this is support access. C7c is the security health check, and the subprocessor and encryption pages. The page is behind `security_v1`. No new dependency.

## What it does

**Settings › Security › Support access** (for who manages security):
- **Granting:** "Grant access" for 1 day, 7 days or 14 days. One grant is open at a time.
- **Revoking:** "Revoke access" ends the grant and signs out anyone from Relay at once.
- **History:** each grant (who granted it, until when, who revoked it) and who from Relay signed in under it.

**Relay's support staff sign in** at the workspace's own address, `/auth/support`, with Relay's own identity provider (OIDC).
- **Who's let in:** only a verified email on the deployment's staff list, and only while a grant is open.
- **Errors:** otherwise they're sent to the sign-in page with the reason, such as "This workspace hasn't given Relay support access." or "That account isn't on Relay's support staff list."
- **The workspace's IP allowlist** applies to them too.

**Signed in, they see the workspace as an owner does, read-only.**
- **The banner:** "Relay support · read-only access, granted by this workspace. Every page you open is recorded."
- **Blocked:** every change, send or delete is refused ("Relay support has read-only access to this workspace.").
- **The inbox** loads without live updates, and offers no composer.
- **Session length:** at most 8 hours, and never beyond the grant.

**In the audit log:**
- **The grant:** granted and revoked.
- **Sign-ins:** each staff sign-in and each refused one.
- **Pages:** each page staff open. The record holds the page and the names of its query, never the values. It's kept at most once per session and page every 10 minutes.
- **Customer records** they open are recorded too, as for anyone.
- **The actor** is "Relay support (their email)", via support.

## How it works

**`server/support.ts`:**
- **The page:** `readSupport` and `changeSupport` (`grant` and `revoke`). A new grant first closes whatever is open; a lapsed grant closes at its own expiry.
- **Signing in:** `startSupport` and `finishSupport` follow the same OIDC checks as single sign-on:
  - PKCE, a nonce, and a state bound to the browser by the `relay_support` cookie.
  - The ID token, checked by `exchangeCode`, which was extracted from `server/sso.ts` and is now shared.
- **Admitting:** `admitSupport` is staff's only way in. It checks the staff list and an open grant, and makes a support session (`relay_sup_…`, kept only as a hash). It never makes a teammate.
- **Resolving:** `resolveSupportSession` turns the session cookie into the principal `relay-support:<session>`.
- **Audited views:** `recordSupportView`.

**`server/policy.ts`:**
- **`authorize`** treats a support principal, while its session and grant are open, as a teammate "Relay support (email)" with every capability and no restricted scope. It also sets the audit actor.
- **`can`** says no to writing (replying, notes, assigning, macros, exporting), so the inbox offers none of it.
- **No teammate row:** staff never appear in assignment, routing, mentions, workload or seats. A page that looks a teammate up directly doesn't load for them.

**Read-only, in one place:** the agent API refuses every request from a support principal that isn't a GET (`SUPPORT_READ_ONLY`, 403), before any route runs.
- **The inbox** reads without a live-updates ticket, since a ticket is a POST.
- **Background writes:** marking a conversation read and saving a draft are refused quietly, under the banner.

**Wiring:**
- **The host:** `/auth/support` and `/auth/support/callback` (`bridgeSsoRequest`: the app routes and the local relay). Sign-out ends a support session too.
- **The auth API:** the actions `support-start` and `support-finish`.
- **The agent route:** `support-access` (GET and POST, `security.manage`).
- **The page:** `agent/settings-support.tsx` (`#settings/support-access`).
- **The inbox:** a `readOnly` flag in its snapshot, and the banner.

**Deployment** (`workers/relay.ts`):
- **Settings:** `RELAY_SUPPORT_OIDC_ISSUER`, `RELAY_SUPPORT_OIDC_CLIENT_ID`, `RELAY_SUPPORT_OIDC_CLIENT_SECRET` (a secret) and `RELAY_SUPPORT_STAFF` (comma-separated emails).
- **Without them,** the page says support sign-in isn't set up, and a grant can't be used.
- **Locally:** the stand-in identity provider, with Rae Support (`rae@relay-staff.test`) on the staff list.

**Migration `0091_support_access`:**
- **`support_grants`,** audited, with one open at a time and at most 14 days.
- **`support_logins`** and **`support_sessions`.**
- **Its rollback** revokes every open grant and ends every staff session; the history stays.
- **Erasure:** none of these tables hold customer data. They're listed in `NO_PERSONAL_DATA`.

**Seed data:** none. No grant is open.

## Checks

- **`tests/support-access.test.ts`:**
  - **Off by default:** no grant, so no sign-in starts, and an unset deployment says so.
  - **Granting:** `security.manage` only, and only 1, 7 or 14 days.
  - **Signing in:**
    - **Refused** (and audited): an email off the staff list (from either side), a wrong state, and a login used twice.
    - **Rae** signs in with a session of at most 8 hours, valid only in this workspace.
    - **No teammate** is made.
  - **Reading:**
    - **The inbox** loads as "Relay support (email)", read-only, with no composer, and the audit log is readable.
    - **Writes are refused:** every change (support access itself, links, data protection) gets `SUPPORT_READ_ONLY`, and nothing changes.
    - **Policy directly:** `authorize` and `can`, and nothing in another workspace.
  - **Audited views:** path and query names, never values; actor, name and via; the 10-minute window.
  - **The page:** it lists the session, and another workspace sees nothing.
  - **Ending access:**
    - **Revoking** ends the grant and the session at once, and there's nothing left to revoke.
    - **A lapsed grant** lets no one in, and a new grant closes it at its expiry.
  - **Through the host:** the login cookie, the provider's return, and the session cookie. A forged return is refused, and a workspace that never granted access turns staff away.
  - **Rollback.**
- **`tests/browser/support-access.spec.ts`:**
  - **Happy path:**
    - **Rae signs in:** a manager grants a day. Rae signs in through the stand-in provider and lands in the inbox under the banner.
    - **Read-only:** she opens settings, and a change is refused with the reason. Her views are audited.
    - **Revoking:** the manager sees her session and revokes, and her next request is signed out.
  - **Failure path:** with no grant, staff are sent back with the reason. Ada, off the staff list, is refused with the reason. An agent doesn't see the page, and the API answers 403.
- **`tests/permissions-matrix.test.ts`** covers the route. **`tests/sso.test.ts`** passes with `exchangeCode` extracted. **`tests/erasure.test.ts`** passes.
