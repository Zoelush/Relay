# Phase 16, step C4a: single sign-on (OIDC)

Branch `security/c4a-sso`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decisions 14 and 15). C4 was split, as asked: this is C4a (OpenID Connect, domains, enforced SSO, roles from groups). C4b adds SAML 2.0 on the same records. SCIM stays deferred. The settings page is behind `security_v1`. No new dependency (`jose` checks the ID tokens).

## What it does

**Settings › Security › Single sign-on** (for who manages security):
- **The connection:**
  - **The sign-in redirect address** to give the identity provider.
  - **Fields:** a name people see, the issuer URL, the client ID and the client secret. The secret is never shown again; leave it empty to keep it.
  - **Groups claim:** `groups` by default.
  - **Saving** reads the issuer's OpenID configuration, so a wrong issuer is caught then.
- **Status:** when someone last signed in this way, how many people have, and the last problem.
- **Two switches:**
  - **"Offer Sign in with <name>"** shows the button on the sign-in page.
  - **"Require single sign-on for everyone but owners"** turns on only once single sign-on is on, a domain is verified, and someone has signed in with it once.
- **Domains:** add one, publish the TXT record shown (`_relay-verification.<domain>`), then "Check now". Only people whose email is at a verified domain sign in this way. Another Relay workspace can't verify a domain that's already verified.
- **Groups and roles:** an ordered list. At every sign-in, the first group the person is in decides their role.
  - **Owner:** never offered; owners are chosen in Relay.
  - **Above your own:** a role with permissions you don't have can't be offered either.

**Signing in** (`/signin`):
- **"Sign in with <name>"** goes to the identity provider and back to the inbox, or to where the person was going.
- **The first time:** a teammate who already signs in with that email is linked; anyone else is made just in time, with the role from their groups.
- **Refused, with the reason on the sign-in page and in the audit log:** no group maps to a role (and no account is made), the provider doesn't say the email is verified, the email's domain isn't verified, or the person cancelled at the provider.
- **Each sign-in after:** the role follows the groups. If none maps any more, they're refused. An owner's role never changes.
- **Two-factor:** SSO sessions don't ask for Relay's; the identity provider's own MFA applies.

**While single sign-on is required:**
- **For everyone but owners, these stop:**
  - **Sign-in methods:** password sign-in, and the hosting platform's sign-in (locally, `?as=`). The browser is sent to sign in.
  - **Passwords:** password resets, invitations, and setting a password.
- **Turning it on** ends everyone else's password sessions.
- **Owners keep their password (and two-factor) as break-glass.** Each such sign-in is recorded as "Owner signed in with a password".
- **The sign-in page** says the workspace signs in with SSO.

**In the audit log:**
- **Settings:** the connection (its secret only as "replaced"), domains added, verified and removed, and group mappings.
- **Sign-ins:** SSO sign-ins (method `sso`), refusals and why, and break-glass sign-ins.
- **Role changes from groups**, as teammate changes.
- **Teammates made just in time.**

## How it works

**`server/sso.ts`:**
- **`readSso` and `changeSso`:** the settings.
- **`discover`:** the issuer's discovery document, read before the transaction through `safeFetch`. The issuer must match, and the endpoints must be public https.
- **`checkSsoDomainJob`:** the `sso.domain.check` job, through the DNS port.
- **`ssoInfo`, `startSso` and `finishSso`:** the sign-in flow.

**The flow is OIDC's authorization code flow with PKCE (S256), a nonce and a state:**
- **The login row** (`sso_logins`, ten minutes) holds the state, the nonce, the verifier and where to go next. The host keeps its token in `relay_sso` (HttpOnly, `Path=/auth`, SameSite=Lax so the provider's redirect carries it).
- **Any return uses the login up,** a wrong state included.
- **The code is swapped** at the token endpoint (`safeRequest`, client secret by HTTP Basic, 10 seconds).
- **The ID token is checked** with `jose` against the provider's keys: the issuer, audience and algorithm, issued within ten minutes, and the nonce.
- **The swap happens in the callback, not a job.** A browser redirect can't wait for one.

**Who signs in:**
- **Identities** (`sso_identities`) are keyed by the connection and the provider's subject, never by email.
- **The decision is made in one transaction** (refusals recorded, then refused after it commits): the domain, the identity (or the email link, or the just-in-time teammate), the role, `last_success_at`, then `startSession(..., "sso")`.

**Enforced SSO:**
- **The check:** `ssoEnforced` and `assertNotSsoOnly` (`server/two-factor.ts`).
- **Where it's applied:** `signIn` (refusing non-owners and recording owners as break-glass), invitations, resets, accepting, and setting a password.
- **Platform sign-in:** `assertPlatformAllowed` refuses it for non-owners on every agent request without a Relay session and on sockets, as `SIGNED_OUT`, so the page goes to sign in.

**The host** (`server/agent-bridge.ts`):
- **`bridgeSsoRequest`** handles `GET /auth/sso` (from this site only) and `GET /auth/sso/callback`. It sets the session cookie and clears `relay_sso`.
- **On failure** it sends the browser to `/signin?sso=<code>`. The page explains a fixed set of codes in its own words and never shows text from the address.
- **`/auth/sso-info`** tells the sign-in page whether to show the button (the provider's name and whether it's required). It's read on every page view, so it isn't counted toward the sign-in rate limit or checked against the IP allowlist. Starting and finishing a sign-in are both.
- **Routes:** the deployed app gains `app/auth/sso` and `app/auth/sso/callback`. The local relay serves both.

**The stand-in provider** (`scripts/local-idp.ts`):
- **Endpoints:** discovery, an authorize page listing test people (choose one, or cancel), a token endpoint that checks the client secret, the redirect address and PKCE, and its keys.
- **Where it runs:** the local relay starts it with `idpPort`, one port above the host by default (8790), and allows only it.
- **To try it locally:** in Settings › Single sign-on, use issuer `http://127.0.0.1:8790`, client `relay-local`, secret `local-idp-client-secret`. Then add `example.test` and publish its TXT record with `POST /dev/dns`.

**Migration `0085_sso`:**
- **New tables:** `sso_connections` (one per workspace; the secret sealed), `sso_domains` (a domain verified by one workspace at a time), `sso_role_mappings` (never the owner role), `sso_identities` and `sso_logins`, all under row-level security, with audit triggers.
- **Sessions:** `teammate_sessions.method` gains `sso`.
- **Its rollback** turns SSO and its enforcement off, ends SSO sessions and open logins. Teammates made by SSO stay; a manager can send them a password reset.

**Seed data:** none. The stand-in provider is the local way to try it.

**Not yet:**
- **SAML 2.0** is C4b.
- **SCIM** is deferred, so someone removed at the provider is stopped at their next sign-in, or sooner if a manager ends their sessions.
- **API tokens** aren't affected by enforcement. They're separate credentials, managed in Settings › Developers.

## Checks

- **`tests/sso.test.ts`** (against the stand-in provider):
  - **Settings:** for who manages security, not across workspaces.
  - **The connection:** discovery under the fetch policy; the secret sealed and never returned.
  - **Mappings:** never the owner role, and not above the manager's own.
  - **Domains:** the TXT record (not found, then found); a domain already verified elsewhere is refused.
  - **Enforcing:** waits for it to be on, a verified domain and one sign-in.
  - **The authorize request:** PKCE, the scope and the redirect address.
  - **Sign-ins:**
    - **Ada:** made just in time as an agent; signing in again is the same Ada; an `sso` session.
    - **Logins:** a wrong state uses the login up; a login works once; not across workspaces.
    - **Refusals, each recorded with its reason:** no mapped group (no account), an unverified email, an unverified domain, cancelled at the provider.
    - **Lin:** linked to her password account by email, and made an admin by her group (in the audit log).
  - **Groups at every sign-in:** an unmapped teammate is refused; an owner keeps their role.
  - **Enforced:**
    - **Sessions:** password sessions end; SSO sessions stay.
    - **Owners:** a non-owner's password is refused; an owner's works (recorded as break-glass).
    - **Refused for non-owners:** invitations, resets and a new password.
    - **Settings:** the last verified domain can't be removed.
  - **Through the host:** the login cookie (HttpOnly, `/auth`, Lax); the return sets the session and clears it; a return without the cookie, or a start from another site, is refused; platform sign-in works for the owner, not for Grace; a session works.
  - **The audit log:** every action, never the secret.
  - **Rollback.**
- **`tests/browser/sso.spec.ts`:**
  - **Happy path:**
    - **The manager** connects the provider, publishes and verifies the domain, maps Support to Agent, and turns it on.
    - **Ada** signs in through the provider to a live inbox.
    - **The manager** then requires it.
  - **Failure path:**
    - **Sam:** sent back with the reason, and no account made.
    - **Cancelling at the provider** says so.
    - **The sign-in page** says SSO is required.
    - **Grace,** signed in by the platform, is sent to sign in; the owner keeps working.
- **`tests/permissions-matrix.test.ts`** covers `sso-settings`. **`tests/audit.test.ts`** compares the new triggers with `TABLE_ACTIONS`.
