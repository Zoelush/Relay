# Phase 16, step C7c: the security health check, and subprocessors and encryption

Branch `security/c7c-health-check`. Plan: `docs/SECURITY_PLAN.md` (scope C1 to C10; decision 29). This is the last part of C7: C7a was link safety and risky merges, and C7b vendor support access. Both pages are behind `security_v1`. No new dependency, and no migration: nothing new is stored.

## What it does

**Settings › Security › Health check** (for who manages security) shows the workspace's security settings at a glance.
- **Needs attention:** listed first, most severe first, with a count ("1 critical · 3 recommended · 4 optional").
- **Then every check,** in three groups.
- **Each row** gives a severity (Critical, Recommended, Optional or Fine), what the setting is now in plain words, and a "Change" link to the setting.
- **Always current:** it's worked out from the settings on every visit.

| Group | Check | Fine when | Otherwise |
|---|---|---|---|
| Authentication and access | Two-factor for password sign-in | Required, or single sign-on is enforced | Critical |
| | Teammates without two-factor | Everyone with a password has it | Recommended |
| | Single sign-on | Enforced | Recommended when on but not enforced; optional when not set up |
| | Session limits | At most 4 days unused and 30 days in all (the defaults) | Recommended |
| | IP allowlist | The app is limited to listed ranges | Optional |
| | Relay support access | No grant is open | Recommended (review it) |
| Messenger security | Identity verification | Enforced on every brand | Recommended |
| | Legacy identity check | The older HMAC check is off | Recommended |
| | Allowed websites | Every brand lists its websites | Recommended |
| Data protection | Content redaction | A rule is on | Recommended |
| | Retention | A policy is set | Optional |
| | Link reputation lookup | The deployment has one | Optional |
| | Risky merges | Both are off | Recommended (review them) |

**Settings › Security › Subprocessors and encryption** shows three things:
- **The subprocessors:** every outside service that receives customer data, what it receives, when, what it keeps, and what deleting a person does there.
- **How data is protected:** in transit, at rest, sealed credentials, messenger identity keys, passwords, hashed tokens, and what Relay signs.
- **The keys:** what each protects, and how it's rotated, including what isn't automated yet (changing `RELAY_CONNECTOR_KEY` or `IDENTITY_MASTER`).

## How it works

**The health check:**
- **The checks:** `lib/health-check.ts` lists them (`CHECKS`: group, title, link) and how they're ranked (`ranked`).
- **The decisions:** `server/health-check.ts` (`readHealthCheck`) decides each check's severity and state from `security_settings`, `sso_connections`, `teammate_credentials` and `teammate_two_factor`, `support_grants`, `brands`, `redaction_rules`, `retention_settings`, and whether the deployment has a link reputation lookup.
- **The route:** `health-check` (GET, `security.manage`).

**Subprocessors and encryption:**
- **The registries:** the page reads `lib/processors.ts` (C5b's list) and `lib/encryption.ts` (`PROTECTIONS` and `KEYS`).
- **The document:** `npm run trust:doc` writes `docs/TRUST.md` from both.

**The pages:** `agent/settings-health.tsx` (`#settings/health-check` and `#settings/trust`), listed for `security.manage` with `security_v1`.

## Checks

- **`tests/health-check.test.ts`:**
  - **A new workspace:**
    - **Coverage:** every check is decided, once, in the registry's order.
    - **Severities:** two-factor not required is critical, a teammate with a password and no two-factor is recommended, no allowed websites or redaction rules are recommended, and SSO, the allowlist, retention and the lookup are optional.
    - **The count, the ranking, a state's wording and a link.**
  - **After changing every setting,** each check moves: two-factor, the allowlist, websites, redaction, retention and the lookup to fine; SSO on but not enforced, longer sessions, an open support grant, identity verification off, the legacy check on, and a risky merge on to recommended. Their wording is checked.
  - **SSO enforced** counts as two-factor's alternative.
  - **Access:** an agent gets 403, another workspace's check is its own, and a manager of another workspace can't read it.
  - **`docs/TRUST.md`** matches the registries.
  - **The figures are held to the code:**
    - **Passwords:** scrypt at N=2^15, r=8, p=1 with a 16-byte salt.
    - **Sealed values:** AES-GCM with a 96-bit nonce under a 32-byte key. They open only with their own workspace and purpose.
    - **Sessions** are kept only as their SHA-256 hash.
    - **Keys:** every key named is one the deployment reads.
- **`tests/browser/health-check.spec.ts`:**
  - **Happy path:** content redaction is in "Needs attention". Its link leads to Data protection, where card numbers are turned on, and back on the health check it's fine. The encryption page lists Twilio, AES-256-GCM and `RELAY_CONNECTOR_KEY`.
  - **Failure path:** an agent sees neither page, and the API answers 403.
- **`tests/permissions-matrix.test.ts`** covers the route.
