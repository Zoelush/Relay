# Phase 16, step C3a: sign-in, sessions and invitations

Branch `security/c3a-accounts`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decisions 3, 11 and 12). C3 was split, as asked: this is C3a. C3b (two-factor and the IP allowlists) is next. Settings pages and invitations are behind `security_v1`.

## What it does

**Signing in to Relay** at `/signin`: an email and password.
- **No hints:** an unknown email and a wrong password get the same answer ("That email and password don't match an account here.").
- **Lockout:** ten wrong passwords lock the account for 15 minutes. Each address may try 20 times at once, then once every 3 seconds.
- **Passwords:** at least 12 characters, not containing the email's name, with some variety.

**Invitations** (Settings › Teammates, for who manages teammates):
- **What you give:** an email, an optional name, and a role within your own permissions.
- **The link** works once, for a week. It's shown to you once and emailed (through the alert email path, so a suppressed address gets nothing).
- **Withdrawing:** open invitations are listed, each can be withdrawn, and a new one to the same email replaces the old.
- **Accepting** (`/invite`): the person sees who invited them and as what, chooses their name and a password, and lands in the inbox.

**Password resets** (Settings › Teammates, "Reset password", for who manages teammates):
- **What it sends:** a single-use link (a week, shown once and emailed) for a teammate who signs in with a password, within your own permissions.
- **Using it** sets a new password for the same teammate and ends all their sessions. No new teammate is made.

**Your sign-in** (Settings › Your sign-in, every teammate):
- **Password:** set one (a teammate from the hosting platform chooses an email no one else uses) or change it (with the current one).
- **A new password** signs out every other device.
- **Devices:** the devices signed in (browser, system, when, from where), with "This device" marked. Sign any of them out, or all the others at once.

**Sessions** (Settings › Security › Sessions, for who manages security):
- **Sign out after this long without use:** 4 days by default, 15 minutes to 30 days.
- **Sign out after this long in all:** 30 days by default, 1 hour to 90 days. A shorter limit applies to sessions already open.
- **Every teammate's open sessions,** each of which can be ended at once.

**Signing out** from the account menu ends the session and goes to `/signin`. A session that ends anywhere else (a manager, a new password, the limits) takes the teammate to `/signin?next=…` at their next step.

**In the audit log:** sign-ins (and how: password or invitation, from where), failed attempts (and locks), sign-outs, ended sessions, passwords set or changed (as replaced), invitations made, withdrawn and accepted, and the session limits.

## How it works

**`server/passwords.ts`:** scrypt (N=2^15, r=8, p=1) from `@noble/hashes` (pinned 1.8.0).
- **Stored as** `scrypt$N$r$p$salt$hash`, compared in constant time.
- **Re-hashed** at sign-in if the cost rises.
- **A dummy hash** makes an unknown email cost the same as a wrong password.

**`server/accounts.ts`:** `signIn`, `resolveSession`, `sessionLive`, `signOut`, the account and session settings, invitations, `readInvitation` and `acceptInvitation`.
- **Tokens carry their workspace** (`relay_ses_…`, `relay_inv_…`) and are kept only as SHA-256 hashes.
- **Failed attempts and locks** are decided inside the transaction and refused after it commits, so they're kept.

**The bridge** (`server/agent-bridge.ts`):
- **`sessionCookie`** reads `relay_session`. **`bridgeAgentRequest`** passes it, with the client's address, browser and the host's origin, in the signed proof.
- **`bridgeAuthRequest`** forwards `/auth/signin`, `/auth/accept`, `/auth/signout` and `/auth/invitation` (same-origin POSTs only). It sets the cookie (HttpOnly, SameSite=Lax, Secure over https) and takes the token out of the response, or clears the cookie on sign-out.

**The API** (`server/api.ts`):
- **`/v1/auth/*`** (`handleAuth`) accepts only the host's signed requests.
- **Each agent request** with a session resolves it first: revoked, idle or over its limit means 401 `SIGNED_OUT`.
- **Sockets:** the realtime ticket carries the session, and sockets check it when they authenticate and each time they re-validate.
- **The inbox** reports `relaySession`, so the account menu signs out through Relay.

**Hosts:**
- **The local relay** serves `/signin`, `/invite` and `/auth/*`. Its development identity stays the default without a session.
- **The deployed app** gains `app/signin`, `app/invite` and `app/auth/[action]`. Its `/api/agent` and `/` accept a Relay session before the platform's sign-in.

**Migration `0083_teammate_accounts`:** `teammate_credentials`, `teammate_sessions`, `teammate_invitations` and `security_settings`, all under row-level security. Also email alerts' `invitation` kind (with the link sealed until sent) and audit triggers.
- **Its rollback** ends every password session, withdraws open invitations and clears sealed links. The tables stay.

**Seed data:** none. Locally, invite someone in Settings › Teammates and open the link it shows.

**Break-glass:** an owner's password always signs in. With C4's enforced SSO, owners keep it, and every use is in the audit log. If every owner is locked out, an operator signs in through the hosting platform (still a method) and resets from Settings.

## Checks

- **`tests/accounts.test.ts`:**
  - **Passwords:** hash format, verify, salting, rehash, rules.
  - **Invitations:** role limits; the link shown once and kept as a hash; emailed with the link and the sealed copy cleared; read; accepted into a teammate, a password and a session; not reusable; withdrawn and expired refused; not readable from another workspace.
  - **Password resets:** within the manager's permissions; the same teammate gets a new password, their old sessions end, the old password stops working, and no second teammate is made.
  - **Sign-in:** the same answer for unknown and wrong; ten failures lock, and the lock passes.
  - **Isolation:** sessions don't cross workspaces.
  - **Devices:** a password change keeps this device and ends the others; a platform teammate sets a password with an unused email.
  - **Limits:** refused out of range; a shorter absolute limit applies to open sessions; idle and over-limit sessions end with their reason; a manager ends a session; signing out.
  - **The audit log:** every action, and no hash or token in it.
  - **Through the bridge:** sign-in sets the HttpOnly cookie and the page never sees the token; the inbox opens as the teammate; sign-out clears the cookie and the API answers `SIGNED_OUT`; a wrong password, a forged call to the API, and a cross-origin post are each refused.
  - **Rollback.**
- **`tests/browser/accounts.spec.ts`:**
  - **Happy path:** invited in Settings, Ada joins through the link and lands in the inbox; sees her device; signs out and back in.
  - **Failure path:** a wrong password is refused plainly; the used link is refused; a manager ends her session and her next step goes to sign-in; a password reset the manager sends gets her back in.
- **`tests/permissions-matrix.test.ts`** covers the new routes (`account`, `invitations`, `security-sessions`).
