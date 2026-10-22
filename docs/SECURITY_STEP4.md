# Phase 16, step C3b: two-factor and IP allowlists

Branch `security/c3b-two-factor`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decisions 11 and 13). C3 was split, as asked: C3a (`docs/SECURITY_STEP3.md`) was password sign-in, sessions and invitations; this is C3b. Settings pages are behind `security_v1`. One new dependency, `qrcode-generator` (pinned 2.0.4), draws the setup QR code in the browser.

## What it does

**Two-factor** (Settings › Your sign-in, for anyone who signs in with a password):
- **Setting it up:** scan a QR code with an authenticator app (1Password, Google Authenticator, Microsoft Authenticator and others), or type the key shown beside it. Then enter the first code.
- **Recovery codes:** ten, shown once with a copy button. Each signs you in once if the phone is lost.
- **Your settings:** new recovery codes (the old ones stop working) and turning two-factor off. Each takes a code from the app or a recovery code.
- **Your devices** say which sessions signed in with two-factor.

**Signing in with two-factor** (`/signin`):
- **Two steps:** a right password, then "Two-factor sign-in" asks for the six-digit code. "Use a recovery code instead" switches to a recovery code.
- **Limits:**
  - **The second step** lasts ten minutes and allows five wrong codes. After that, sign in again.
  - **Wrong codes** count toward the account's lock (ten wrong passwords or codes, 15 minutes). The count clears only when signing in finishes, so signing in again with the password doesn't bring more guesses.
  - **A code works once,** and a code from the app works one step either side of now.

**Requiring it** (Settings › Security › Access, for who manages security):
- **The switch:** "Require two-factor for everyone who signs in with a password". You can only turn it on once you have two-factor yourself.
- **Turning it on** signs out every password session without two-factor. Those teammates set it up when they next sign in, before they reach the inbox. So do new teammates accepting an invitation.
- **While it's required,** nobody can turn their own two-factor off.
- **The table** lists every teammate who signs in with a password: whether they have two-factor, and how many recovery codes they have left.

**A lost authenticator:**
- **With recovery codes left:** use one.
- **Otherwise:** someone who manages security turns that teammate's two-factor off from the Access table, within their own permissions and never for themselves. That ends their sessions. If two-factor is required, they set it up again at sign-in.
- **A password reset doesn't skip it:** the link sets the new password, then asks for the code.

**IP allowlists** (Settings › Security › Access):
- **Two lists,** one for the app and one for the REST API. Each holds addresses or ranges (IPv4 or IPv6, like `203.0.113.0/24`), one per line, up to 100. An empty list allows anywhere.
- **The page** shows your own address.
- **The app's list** covers the inbox, Settings and every sign-in step, however a teammate signed in, so the hosting platform's sign-in too. A request from elsewhere gets "Relay isn't available from this network".
- **No shutting yourself out:** saving an app list that leaves out your own address is refused.
- **The API's list** covers `/rest`. A call from elsewhere gets 403 `network_not_allowed`.

**In the audit log:**
- **Two-factor:** turned on, off, or off for a teammate; recovery codes replaced or used (with how many are left); wrong codes (and whether they locked the account).
- **Refused sign-ins:** sign-ins from an address the app's list doesn't allow.
- **The settings:** the switch and both lists, as "Sign-in and access settings" changes.
- **Never recorded:** no key or recovery code.

## How it works

**`server/totp.ts`:** RFC 6238 with WebCrypto (HMAC-SHA-1, six digits, 30 seconds), so it's the same on Workers and locally. Also base32, the `otpauth://` address and the recovery codes' shape. `matchStep` checks one step either side and never a step at or before the last one used.

**`server/two-factor.ts`:**
- **The key** is sealed with the connector key (`seal`, bound to the workspace and teammate). It's pending until the first code confirms it.
- **Recovery codes** are kept only as SHA-256 hashes.
- **`checkSecondFactor`** takes a code from the app (it records the step it used) or an unused recovery code.
- **`countWrongCode`** counts toward the account's lock.
- **`changeTwoFactor`** handles Your sign-in's actions. A wrong code is returned as `refused`, and the API throws it after the commit, so the count is kept.
- **`readAccess` and `changeAccess`** are Security › Access.

**`server/accounts.ts`:**
- **`challengeOrSession`** follows a right password (sign-in, accepting an invitation, a reset). It returns a session, or a challenge to verify a code, or to set two-factor up first when it's required.
- **The challenge** is `relay_chl_<workspace>_<40>`, kept only as a hash, for ten minutes with five tries.
- **`twoFactorSetup` and `completeTwoFactor`** finish signing in. Wrong codes are decided inside the transaction and refused after it commits.
- **Sessions record `two_factor`** (`totp` or `recovery`).

**`server/allowlists.ts`:**
- **Storage:** lists are PostgreSQL `cidr[]`, matched there (`inet <<= ANY`).
- **Normalising:** entries are checked in code (naming the bad one), then tidied by PostgreSQL (host bits cleared, duplicates dropped).
- **Addresses:** an IPv4-mapped IPv6 address (a Node socket's `::ffff:…`) counts as IPv4.
- **No address:** a list with no address to check refuses.

**Where the lists are checked:**
- **The app's list:**
  - **Every agent request** (`assertNetwork`, in the transaction that already checks the flags), against the address the host signs into its proof.
  - **Every `/v1/auth/*` step except signing out** (`signInAllowed`, which also writes the audit row).
- **The API's list:** `/rest` (`handleRest`, beside the token lookup), against `cf-connecting-ip`. Cloudflare sets that header and a caller can't. The local relay sets it from the socket and drops any `x-real-ip` a caller sends.
- **Not covered:** OAuth's token endpoint and realtime sockets. A socket's ticket comes from an agent request, which is checked.
- **The lists stay enforced if `security_v1` is turned off,** so hiding the pages never opens access.

**The bridge** (`server/agent-bridge.ts`):
- **`/auth/two-factor` and `/auth/two-factor-setup`** join the auth actions.
- **The challenge cookie:** when the API returns a challenge, the bridge moves it into `relay_2fa` (HttpOnly, SameSite=Strict, `Path=/auth`, ten minutes) and takes it out of the response. It adds the cookie back to the two-factor calls, and clears it once a session starts.
- **The local relay** now keeps each `Set-Cookie` header apart (it used to keep only the last).

**The pages:**
- **`agent/two-factor.tsx`:** the QR code (drawn as SVG from `qrcode-generator`'s modules, dark on light in both themes: `--pg-qr-*`), the setup steps, the code field and the recovery codes.
- **`agent/signin.tsx`:** the second step.
- **`agent/settings-signin.tsx`:** the Two-factor card.
- **`agent/settings-access.tsx`:** `#settings/access`.

**The API:** a new agent route, `security-access` (GET and POST, `security.manage`). `account` gains the two-factor actions.

**Migration `0084_two_factor`:**
- **New tables:** `teammate_two_factor`, `teammate_recovery_codes` and `teammate_challenges`, all under row-level security.
- **New columns:** `teammate_sessions.two_factor`, and `security_settings.require_two_factor`, `app_allowlist` and `api_allowlist`.
- **Its rollback** turns the requirement off, empties both lists and ends open challenges, so the earlier code can't leave anyone locked out by settings it doesn't read. The tables, sealed keys and audit rows stay.

**Seed data:** none. Locally, set a password and then two-factor in Settings › Your sign-in, and use Settings › Security › Access.

**Break-glass:** an owner's password plus a code or a recovery code always signs in from an allowed address. If every owner has lost both, or an allowlist shuts everyone out, an operator runs the rollback's `UPDATE security_settings …` line for that workspace, or signs in through the hosting platform from an allowed address and uses the Access page.

## Checks

- **`tests/two-factor.test.ts`:**
  - **TOTP:** RFC 6238's SHA-1 vectors, base32 both ways, one step either side, a code used once, spaces allowed, the `otpauth://` address, the recovery codes' shape, and what counts as an address or range.
  - **Your sign-in:**
    - **Setup:** two-factor needs a password; the key is sealed; a wrong first code is refused; ten recovery codes, kept only as hashes.
    - **Codes in settings:** a wrong code is refused and kept; new codes replace the old; turning it off with a recovery code.
  - **Signing in:**
    - **The challenge:** a challenge, not a session.
    - **Codes:** a wrong code, and the setup code reused, are refused; a challenge doesn't work in another workspace; the next code signs in (`two_factor` = `totp`); a challenge is used once; a recovery code signs in once.
    - **Limits:** five wrong codes end the challenge; signing in again with the password doesn't clear them; a wrong code at the lock's edge locks the account.
  - **Requiring it:**
    - **Turning it on:** refused until the manager has it; it ends Ada's session (she has no two-factor) and keeps Grace's.
    - **After:** Ada sets it up at sign-in and gets her recovery codes; a new invitation asks for setup; nobody can turn their own off.
    - **Resets:** a password reset asks for the code; a manager turns off a teammate's two-factor, within their permissions and not their own, and that ends the teammate's sessions.
  - **Allowlists:**
    - **Saving:** a list that shuts out its maker, an unknown address, and a bad entry are refused; entries are tidied.
    - **Matching:** IPv4, IPv4-mapped and IPv6 match; a missing address doesn't; another workspace isn't affected; a sign-in refused by address is audited.
  - **Through the bridge:**
    - **The challenge cookie:** HttpOnly, `Path=/auth`, Strict, and never in the page.
    - **A wrong code:** `WRONG_CODE`.
    - **The right code:** sets the session cookie and clears the challenge.
    - **The app's list:** the inbox from outside it is 403 `NETWORK_NOT_ALLOWED`, for a Relay session and for platform sign-in alike; signing in from outside is refused; the Access page shows the caller's address.
  - **The REST API's list:** a listed address answers (IPv4 and IPv6), another is 403 `network_not_allowed`, and no address is refused.
  - **The audit log:** every new action, and no key or code.
  - **Rollback.**
- **`tests/accounts.test.ts`:** C3a's checks, with sign-in now able to return a challenge.
- **`tests/browser/two-factor.spec.ts`:**
  - **Happy path:**
    - **Ada:** invited, turns on two-factor in Your sign-in (the QR code, the key, the first code, ten recovery codes), signs out, and signs back in with a code to a live inbox.
    - **The manager:** can't require it until they set a password and two-factor of their own, then requires it.
    - **Lin:** invited after, sets two-factor up before reaching the inbox.
  - **Failure path:**
    - **Codes:** a wrong code is refused; a recovery code signs in once and is refused the second time.
    - **The app's list:** a list leaving out the manager's address (127.0.0.1) is refused.
    - **The API's list:** a token works, is refused once the list leaves out its address, and works again once it's added.
    - **Turning off Ada's two-factor:** the manager turns it off and her next step goes to sign-in.
- **`tests/permissions-matrix.test.ts`** covers `security-access` (GET and POST, `security.manage`).
