# Messenger settings, step M1: content and audiences, as drafts

Branch `messenger/m1-content`. Plan: `docs/MESSENGER_SETTINGS_PLAN.md`. Behind the new `messenger_v3` flag, off by default; the local relay turns it on.

## What it does

**Settings › Messenger with drafts:**
- **Saving and publishing:**
  - **Save draft** keeps changes without touching the live messenger.
  - **Publish** puts them live as a new version, saving first if needed. The messenger shows a version the next time it opens.
  - **Discard draft** goes back to what's live.
  - **Earlier versions** can be restored into the draft, then published.
- **Status:** a line says where things stand: unsaved changes, a saved but unpublished draft, the live version, or (before the first publish) the settings from before drafts.
- **Conflicts:** a draft saved by someone else since the page loaded is refused ("The draft changed elsewhere…"), and nothing is overwritten.

**For visitors and for users** (signed-in customers whose identity is verified), chosen with a Visitors/Users switch:
- **Spaces:** which tabs show, in order. Messages is always shown. Tickets (their requests) is for users only.
- **Opening:**
  - open straight into a conversation
  - where the launcher shows: on every page, only on matching pages, on every page except matching ones, or never
  - page rules match the full address ("contains", "starts with", "is exactly")
  - the site's own code can still open the messenger when the launcher is hidden
- **Start button:** six wordings, from "Send us a message" to "Contact support".

**For everyone:**
- **Home cards,** in order, each shown to everyone, visitors only or users only:
  - start a conversation
  - search help
  - recent conversations
  - a link (https)
  - an announcement
  - your tickets (users only)
- **Welcome:**
  - a greeting and introduction per language
  - `{first_name}` becomes a verified customer's first name and is left out for visitors ("Hello {first_name} 👋" shows "Hello 👋")
  - languages can be added and removed, but not the messenger's own
- **Special notice:** on or off, with its text per language. It shows at the top of Home and Messages.
- **The earlier settings:** look (colour, theme, launcher side and shape, logo), conversations (visitors may start one, search help first, team introduction, away message, language) and websites. These are part of the draft too.
- **Identity verification** is saved at once, not drafted, because it protects customers' conversations.

**In the messenger** (when a version is published):
- the customer's audience decides their spaces, opening, start button and Home cards
- the welcome uses their language (theirs, its base, the brand's, then any)
- the Tickets space opens their requests in the portal
- the loader hides or shows the launcher per page and audience, and re-checks when a single-page site navigates
- the host element carries `data-launcher="shown|hidden"`

## Server

**`server/messenger-config.ts`:**
- **The config:** the S3b fields plus `audiences`, `home`, `welcome` and `notice`.
- **`validConfig`** checks it all:
  - Messages always on; Tickets and the tickets card for users only
  - links https only
  - page rules required when the launcher depends on them
  - a welcome, and a notice when it's on, in the messenger's own language
  - limits: 12 cards, 20 rules, 30 languages
- **`readMessenger` and `changeMessenger`:** save, publish, discard and restore, behind `settings_v1`, `messenger_v3` and `workspace.manage`.
- **Routes:** `GET/POST /v1/agent/messenger`, allowed through the agent bridge, with POSTs idempotent on the key.

**Publishing:**
- copies the draft into `messenger_versions` (which can't be changed afterwards)
- writes the live settings the messenger already reads: the S3b fields at the top level of `brands.settings`, the rest under `messenger3`
- the earlier single "open straight into a conversation" follows visitors

**Booting the messenger** (`bootBrand` in `server/api.ts`):
- includes `messenger3` only while `messenger_v3` is on, so switching it off falls back to the earlier messenger
- adds a verified customer's first name (`profile.firstName`)

**The earlier page:** with drafts on, the S3b Messenger save is refused (`MESSENGER_DRAFTS`). `validMessenger` (the S3b checks) is shared by both.

Comparing a draft with what's live ignores key order (PostgreSQL's `jsonb` doesn't keep it).

## Migration

`db/postgres/0041_messenger_settings.sql` is additive:
- **Tables:** `messenger_drafts` and `messenger_versions` (with a trigger that keeps versions unchanged), with row-level security.
- **The flag:** `messenger_v3`, off. New workspaces get it from `seedFoundation`.

The rollback switches the flag off; the earlier messenger and Settings page return.

## Strings

The messenger's new words are in English and Arabic:
- the six start-button wordings
- "Tickets"
- "Notice"

The Arabic is mine and wants a native speaker's check, as do the M3 languages.

## Not included yet

- **M2:** colours per scheme, header background, launcher logo and spacing, teammate faces, the live preview.
- **M3:** inbound rules, more interface languages, the privacy notice, install guides and status, guided identity set-up.
- **Audience conditions beyond "visitor or user"** (company or attributes): they wait for companies (phase 01).

## Tests

**`tests/messenger-config.test.ts`:**
- **Visibility:** off by default; with drafts on, the earlier save is refused; agents are refused.
- **The first draft** comes from the current settings.
- **Saving:** a retried save is applied once; a stale save is refused (`MESSENGER_CONFLICT`).
- **Eight refusals,** each with its reason.
- **Publishing:**
  - the messenger boots without the draft before publishing and with it after
  - versions can't be changed
  - a second version, then discard, restore and a third version
  - an unknown version is refused
- **The flag off:** the messenger falls back.
- **Cross-workspace:** another workspace's brand isn't found, its versions are its own, and another workspace's owner is refused.
- **Page rules** match as described.

**`tests/browser/messenger-settings.spec.ts`** (ports 8978/8979):
- **Happy path:**
  - **The draft:** for visitors, "Ask a question" and no launcher on checkout pages; for users, Tickets and "Contact support". A status link card, the welcome and a notice. Saved, then published.
  - **Before publishing,** the customer sees the old messenger.
  - **A visitor** sees "Hello 👋", the introduction, the notice, the link and their start button, with Home, Messages and Help.
  - **On a checkout page** the visitor's launcher is hidden.
  - **A signed-in user** gets Tickets as a fourth space, their start button, and their requests.
- **Failure path:**
  - an http link is refused with the reason, and nothing new goes live
  - fixed, then two versions published and the earlier one restored into the draft

**Updated:** `settings-channels.spec.ts` runs with drafts off, to keep testing the earlier page.

## Checks

Results on 3 October 2026:
- `npm test`: 101/101 pass.
- `npm run typecheck`: clean.
- Lint shows nothing in the changed files.
- `npm run test:e2e`: 84/84.
- `npm run test:postgres`: passes.
- **Checked in screenshots:** the draft editor, and the published messenger for a visitor.
