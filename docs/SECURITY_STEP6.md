# Phase 16, step C4b: single sign-on with SAML 2.0

Branch `security/c4b-saml`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decisions 14 and 16). This finishes C4: C4a (`docs/SECURITY_STEP5.md`) was OpenID Connect, domains, roles from groups and enforcement; this adds SAML 2.0 on the same records. SCIM stays deferred. The settings page is behind `security_v1`.

**New dependencies:**
- **`@node-saml/node-saml`** (pinned 5.1.0; signatures by `xml-crypto` 6.4).
- **`xml-crypto`** (pinned 6.4.0, dev only, for the stand-in provider to sign with).

## The library check (before any code)

As agreed, C4b began by confirming the library runs on Cloudflare Workers. The check ran in an isolated folder, outside the repo:
- **Inputs:** a SAML response with a signed assertion, made in Node.
- **Where it ran:** inside workerd (`wrangler dev`, Relay's compatibility date `2026-05-15`, `nodejs_compat`), and in Node for comparison.
- **What it was asked:** to validate the response, then four attacks: tampered, signed with another key, unsigned, and a signature-wrapping attack (a forged assertion placed beside the signed one).

**Results:**
- **Workers matched Node exactly:** it accepted the valid response and refused all four attacks.
- **Bundle size:** the library adds about 200 KiB gzipped to the Worker (1.2 MiB uncompressed), within Workers' limits.
- **Where it's used:** only in `server/saml.ts`, so the app's host bundle doesn't carry it.

## What it does

**Settings › Security › Single sign-on** gains a protocol choice: OpenID Connect or SAML 2.0.
- **For SAML, you give:** the identity provider's SSO URL, its entity ID and its signing certificate (pasted as PEM, with or without its header lines), plus the groups attribute (`groups` by default).
- **The page shows what to give the identity provider:**
  - **Relay's entity ID** (the audience): `<host>/auth/saml/metadata`.
  - **Its assertion consumer service** (HTTP-POST): `<host>/auth/saml/acs`.
  - **Its metadata address,** to import.
- **Domains, groups and roles, the two switches, break-glass and the audit log** all work exactly as in C4a.
- **Re-proving:** changing the SSO URL, entity ID or certificate (or the protocol) clears "has worked". If single sign-on was enforced on that basis, enforcement turns off until someone signs in again.

**Signing in:**
- **The flow:** "Sign in with <name>" goes to the provider (HTTP-Redirect). The provider posts the response back to Relay's ACS, and the person lands in the inbox.
- **Who it is:**
  - **The person** is their NameID. A transient NameID is refused with the reason, because it would make a new person every time.
  - **Their email** is the NameID when it's an email, else the `email` or `mail` attribute.
  - **Their groups** come from the configured attribute.
- **Refused, with the reason on the sign-in page and in the audit log:** the provider declined, a group maps to nothing, a domain isn't verified, there's no email, a transient NameID, or a response that fails its checks.

## How it works

**`server/saml.ts`** wraps the library:
- **`samlAuthorize`:** the redirect, and the request's ID.
- **`samlProfile`:** the checked response.
- **`samlMetadata`:** Relay's metadata.
- **`readCertificate`:** tidies a pasted certificate.

**The checks:**
- **Signatures:** a signed assertion from the configured certificate is required.
- **The rest:** Relay's audience, the configured issuer, and `InResponseTo` equal to the login's own request ID (`validateInResponseTo: always`, through a one-entry cache built from the login), all within a minute's clock skew.
- **What the request leaves open:** it doesn't ask for a NameID format or a way of signing in, so the provider's own MFA and passkeys work.
- **Unsigned requests:** AuthnRequests aren't signed, because Relay holds no SAML key.
- **The provider's refusal** (a non-success status) is told as "didn't let you sign in".

**The browser binding:**
- **The problem:** the provider's form post is cross-site, so it can't carry the Lax `relay_sso` cookie.
- **The ACS:** `POST /auth/saml/acs`, through `samlAcs`, only parks the response on the open login whose RelayState it names (a random secret, used once, ten minutes). The response isn't read there.
- **Then:** the host sends the browser on with a 303 to `/auth/sso/callback?state=…`. That GET carries the cookie, so only the browser that started can finish.
- **At the callback:** the response is validated and cleared, then C4a's `admit` handles the domain, identity, role and session.

**Where the protocols meet** (`server/sso.ts`):
- **`startSso`:** for SAML, the request ID is kept on the login (`sso_logins.request_id`).
- **`finishSso`:** checks the SAML response, or swaps the OIDC code.
- **`admit`:** shared by both.

**The host** (`server/agent-bridge.ts`, `bridgeSsoRequest`):
- **New routes:** `POST /auth/saml/acs` and `GET /auth/saml/metadata` (served as `application/samlmetadata+xml`).
- **Size:** the API takes a SAML response up to about 300 KB, and the local relay's host allows it.
- **Deployed:** the app gains `app/auth/saml/acs` and `app/auth/saml/metadata`.

**The stand-in provider** (`scripts/local-idp.ts`):
- **`/saml/sso`** reads the AuthnRequest (HTTP-Redirect), lists the same test people, and posts back a response signed with a throwaway key in `tests/fixtures/saml/` (test only).
- **To try it locally:** choose SAML 2.0 with SSO URL `http://127.0.0.1:8790/saml/sso`, entity ID `http://127.0.0.1:8790/saml`, and the certificate in `tests/fixtures/saml/test-idp.crt`.

**Migration `0086_saml`:**
- **The connection:** its protocol may be `saml`, which adds `entry_point` and `idp_cert`. OIDC's columns become optional, with a check requiring each protocol's own.
- **Logins:** keep `request_id` and, briefly, `saml_response`.
- **The audit trigger** also follows the protocol, the SSO URL and the certificate.
- **Its rollback** turns a SAML connection off (the earlier code only speaks OIDC) and clears parked responses.

**Seed data:** none. Use the stand-in provider locally.

**Not in this step:**
- **Encrypted assertions:** Relay has no decryption key.
- **Signed requests.**
- **SAML single logout.** Sessions end in Relay.
- **SCIM** stays deferred.

## Checks

- **`tests/saml.test.ts`** (against the stand-in provider):
  - **The connection:** a bad certificate, or an SSO URL outside the fetch policy, is refused; a certificate pasted without its header is tidied.
  - **What's shown and served:** Relay's service provider values, and its metadata (entity ID, ACS by HTTP-POST). No metadata for a workspace without SAML.
  - **The redirect:** carries SAMLRequest and RelayState.
  - **Ada:** made just in time as an agent, with an `sso` session; the parked response is cleared.
  - **Refusals, each recorded:**
    - **Bad responses:** tampered; a genuine response replayed onto another login (InResponseTo).
    - **Parking and finishing:** a response parked twice; finishing without the login; parking across workspaces.
    - **The provider and the person:** cancelled at the provider; no mapped group; an unverified domain.
  - **A changed SSO URL** clears "has worked".
  - **Through the host:**
    - **Metadata** with its content type.
    - **The redirect and its cookie.**
    - **The provider's cross-site post:** a 303 to the callback.
    - **The callback:** refused without the cookie; a fresh login finished by the browser holding it.
  - **Rollback.**
- **`tests/browser/saml.spec.ts`:**
  - **Happy path:**
    - **Setup:** a manager picks SAML, pastes the provider's details, sees Relay's values, gets the metadata, verifies the domain, maps Support to Agent and turns it on.
    - **Ada:** signs in through the provider (its form posts back) to a live inbox.
  - **Failure path:** Sam (no mapped group) and a cancelled sign-in each come back with the reason.
- **`tests/sso.test.ts` and `tests/browser/sso.spec.ts`:** C4a's OIDC checks, unchanged and passing.
