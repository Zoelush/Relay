# Phase 15, step D4: OAuth apps

Branch `platform/d4-oauth`. Plan: `docs/DEVELOPER_PLATFORM_PLAN.md` (scope: D1 to D5). Behind `developer_api_v1`. Next: D5, Canvas apps and the order-lookup acceptance app.

## What it does

**Registering an app** (Settings › Developers › Apps, for who manages the workspace):
- **What you give:** its name and description (shown on the consent screen), its redirect addresses (https, or http on 127.0.0.1 or localhost for local tools), and the scopes it may ask for (the permission registry, named as on Roles).
- **What you get:** a client id, and a client secret shown once.
- **Later:** you can issue a new secret, or archive the app (no new installations or refreshes; tokens already issued expire within the hour).

**Installing an app** (the OAuth 2 authorization code flow, with PKCE S256 required):
1. **The app sends the person** to `<their Relay>/oauth/authorize?…`. Relay's consent screen names the app and its maker, lists exactly what it asks for in plain words, and marks anything the person doesn't have themselves as not granted.
   - **Who may allow it:** only who manages the workspace.
   - **What it gets:** the app gets what it asked for that they have, and acts as them.
   - **Shown, never redirected:** a problem (an unknown or archived app, an unregistered redirect, no PKCE, a scope the app didn't register) is shown on the page, and never sent anywhere.
2. **Allow** sends them back with a code (single use, 10 minutes). **Cancel** sends `error=access_denied`.
3. **`POST /oauth/token`** exchanges the code (with its verifier, the same redirect and the app's credentials, by HTTP Basic or in the body) for an access token (an hour, used on the API like any token) and a refresh token (60 days).
4. **Refreshing** rotates both. A refresh token or code used twice means it was copied, so the installation is revoked.
5. **`POST /oauth/revoke`** revokes an access token, or (given a refresh token) the installation.

**Installed here** (Settings › Developers › Apps): each installed app, what it may do, who allowed it and when, and when it was last used. Remove stops every one of its tokens at once.

## How it works

**Credentials carry their workspace:**
- **The forms:** `relay_app_<workspace>_<id>`, `relay_code_…`, `relay_rt_…`, and app access tokens are `relay_pat_…`.
- **Why:** an app is read in its developer's workspace and an installation in the installing one. Each lookup happens inside that workspace's row-level security, never by a search across workspaces.
- **What's stored:** secrets, codes and tokens are kept only as hashes.

**An app's access tokens are API tokens:**
- **Who they act as:** the installing teammate, with the installation's scopes, `grant_id` and `expires_at`.
- **What checks them:** the same router, scope checks, role checks and rate limits as personal tokens.
- **The router also refuses** an expired one, or one whose installation is revoked.
- **Personal tokens only:** the Developers page lists personal tokens alone.

**Code:**
- **`server/oauth.ts`:** registering, consent, and the token and revoke endpoints.
- **`agent/oauth-consent.tsx`:** the consent screen, served at `/oauth/authorize` by the local relay and by `app/oauth/authorize/page.tsx` when deployed. `agent/entry.tsx` picks it by path.
- **`agent/settings-apps.tsx`.**
- **Routes:**
  - `/oauth/token` and `/oauth/revoke` on the API server (`server/api.ts`, `workers/relay.ts`, the local relay)
  - `developer-apps`, `developer-app` and `oauth-consent` for the agent app
- **The reference** gains an "Apps and OAuth" section.

**Migration `0079_oauth_apps`:** `oauth_apps`, `oauth_grants`, `oauth_codes`, `oauth_refresh_tokens`, and `api_tokens.grant_id` and `expires_at`.
- **Its rollback** revokes every installation and app token, so no app can reach a workspace. The tables stay.

**Seed data:** none. An app needs your redirect.

## Checks

- **`tests/oauth.test.ts`:**
  - **Registration:** bad redirects (plain http, fragments, `javascript:`) and unknown scopes are refused, and the secret is shown once.
  - **Consent refusals:** an unknown app, an unregistered redirect, no PKCE, an unregistered scope, and a teammate who can't install.
  - **Cancelling** sends `access_denied` with the state.
  - **Code exchange:**
    - a wrong secret is refused (401)
    - a wrong verifier burns the code
    - the burnt code used again revokes the installation
  - **A real install:**
    - credentials by HTTP Basic
    - tokens act as the installer with only the granted scopes (contacts refused)
    - not listed as personal tokens
  - **Refresh:** it rotates, and the old one used again revokes everything.
  - **Ending access:** expiry, the revoke endpoint (access, then refresh) and uninstalling.
  - **Isolation:** another app can't use this app's code, and a token can't reach a workspace that didn't install it.
  - **Archiving:** no new consent or refresh.
- **`tests/browser/apps.spec.ts`,** with an app on this machine receiving the redirect:
  - **Happy path:** an app registered in Settings is allowed in, its code becomes tokens that call the API, and removing it in Settings stops its token.
  - **Failure path:** Cancel tells the app `access_denied`, and an unregistered redirect is refused on the page, with nothing sent anywhere.
