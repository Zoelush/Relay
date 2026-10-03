# Settings, step S3b: channels (brands, the messenger, the customer portal)

Branch `settings/s3b-channels`. Plan: `docs/SETTINGS_PLAN.md`. Approved on 3 October 2026 with the S3 split ("Yes, go ahead with all four"):
- the channel pages need `workspace.manage`
- identity verification shows enforcement and key status; creating and rotating keys stays an operator task until phase 16 security

This completes the Settings plan.

## What it does

A new **Channels** group in Settings, for workspace managers:
- **Brands:** always.
- **Messenger:** needs `messenger_v2`.
- **Customer portal:** needs `portal_v1`.

**Brands:**
- **The list:** each brand with its colour, its websites (or "No websites yet: its messenger loads nowhere") and its conversation count. The default brand is marked.
- **Rename** in place.
- **Messenger** opens that brand's messenger page.
- **New brand:** starts with the default look and no websites.
- **Never deleted,** because conversations remember the brand they came from.

**Messenger,** per brand (a brand menu shows when there's more than one):
- **Appearance:**
  - brand colour, with a picker and a hex field
  - a live preview of the launcher
  - theme: follow the visitor's device, light or dark
  - launcher side and shape
  - logo (an https:// image address)
- **Greeting:**
  - the greeting
  - the away message, shown outside office hours
  - the messenger's language
- **Conversations:**
  - visitors can start conversations
  - ask visitors to search help first
  - open straight to a new conversation
- **Websites:** the exact addresses the messenger loads on. Each subdomain is listed on its own, with no wildcards or paths.
- **Identity verification:**
  - require verified identities (recommended; turning it off is explained)
  - also accept the older HMAC signature
  - the workspace's signing keys by id, slot and date, never their secrets; with no key, the page says verification can't work until one is installed
- **Install:** the boot file and loader tags for this brand, with Copy.
- **One Save** for the page, lit only by a change and "Saved" after. A refusal shows the reason and keeps the changes. The messenger reads these settings on every boot, so the next page that opens it shows them.

**Customer portal:**
- **Who sees which requests:** only their own, or everyone at their company. Each ticket type can override this.
- **Each brand's portal address.**
- **Custom domains:** add a host name for a brand, or remove one. A host another workspace already uses is refused.

## Server

- **`server/channel-settings.ts`:** `listBrands` and `saveBrand`, behind `settings_v1` and `workspace.manage`. Route: `GET/POST /v1/agent/brands`, allowed through the agent bridge.
  - **`listBrands`** returns each brand's messenger settings (with defaults for anything missing), its identity settings and portal address, the API origin and workspace id for the snippet, and identity key ids.
  - **`saveBrand`** saves one of:
    - create or rename (names unique whatever their case, `BRAND_EXISTS`)
    - `section: "messenger"`, every messenger field, merged into `brands.settings` so office hours and home blocks are kept
    - `section: "identity"` (`identity_enforced`, `legacy_hmac_enabled`)
  - **Validation:**
    - colour `#rrggbb`, stored in lowercase
    - theme, side and shape from their lists
    - the logo must be https
    - language as a BCP 47 tag
    - greeting up to 200 characters, away message up to 500, both required
    - up to 50 websites; `websiteOrigin` accepts only an exact https origin (http for localhost), dropping a trailing slash and refusing paths, queries, credentials and wildcards
- **Idempotent saves:** brand saves and `POST /v1/agent/portal-settings` now use the idempotency key (`once`).
- **`settingsOverview`** lists `brands`, `messenger` and `portal`.

No migration: brand settings were already stored on brands.

No new seed data: the local relay's default brand covers it.

## Not included

- **Identity keys:** creating and rotating them from Settings, with an audit trail. TODO(phase 16) in `server/channel-settings.ts`; `docs/MESSENGER.md` describes the operator steps.
- **Home blocks:** editing the messenger's home screen cards.
- **Email and other channels:** phase 12.

## Tests

**`tests/settings-channels.test.ts`:**
- **Visibility:** the pages follow permission and flags.
- **The list:** carries the install details and portal address, and key ids without secrets.
- **Brands:** added once for a retried key; duplicate names refused; renamed; a new brand has no websites.
- **The messenger:**
  - saved and normalised (colour, language, trimmed greeting, origins)
  - other settings kept
  - the messenger's stylesheet showing the new colour at once
- **Refusals,** each with its reason and nothing stored:
  - a wildcard, path or plain-http website
  - a bad colour, an http logo, an unknown theme or an empty greeting
- **Identity:** settings saved per brand; invalid input refused.
- **Portal:** a domain add applied once for a retried key.
- **Agents** are refused.
- **Cross-workspace:** another workspace sees and changes none of it.
- **Flag:** closed without Settings.

**`tests/browser/settings-channels.spec.ts`** (ports 8966/8967):
- **Happy path:**
  - a brand added and its messenger opened from the list
  - the default brand restyled, with a new greeting and a second website, saved
  - the live messenger on the customer's site showing the new greeting and colour
  - the install snippet naming the brand and loader
  - the portal set to company-wide, with a custom domain for the new brand
  - each checked in the database
- **Failure path:** a wildcard website is refused with the reason, the change stays unsaved, and the stored websites are unchanged.

**Updated:** `tests/settings.test.ts` expects the new pages for an owner.

## Checks

Results on 3 October 2026:
- `npm test`: 96/96 pass.
- `npm run typecheck`: clean.
- Lint shows nothing in the new files.
- `npm run test:e2e`: 78/78.
- `npm run test:postgres`: passes.
- **Checked in screenshots, light and dark:** Messenger and Customer portal.
