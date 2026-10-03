# Messenger settings, step M3: rules, languages, privacy, install

Branch `messenger/m3-rules`. Plan: `docs/MESSENGER_SETTINGS_PLAN.md`. Behind `messenger_v3`, as drafts and published versions. This completes the messenger settings plan.

## What it does

**Conversation rules,** for visitors and for users separately, enforced by Relay's server (not just the messenger):
- **One open conversation at a time:**
  - the start button becomes "Continue your conversation" and opens the open one
  - Messages offers it instead of a new message
  - the server refuses a second start (`CONVERSATION_OPEN`, with the open conversation's id)
- **Offer a conversation after an article didn't help:** when off, "Talk to us" isn't offered after a "No" on a help article.
- **No replies to closed conversations:** the composer gives way to "This conversation is closed. Start a new one if you need more help." and a start button. The server refuses the reply (`CONVERSATION_CLOSED`).
- **No replies to closed tickets:** the server refuses (`TICKET_CLOSED`), and the messenger shows the reason.

**For everyone:**
- **Interface languages:** the messenger's own words now come in French, Spanish, German, Portuguese, Brazilian Portuguese, Italian and Dutch, besides English and Arabic.
  - A visitor whose language is offered reads it; anyone else gets the messenger's own language.
  - This is decided when the messenger starts, so the AI agent answers in the same language.
  - The new translations were written by Relay, not by native speakers, and want a native speaker's check.
- **Reply times and office hours on Home:** always, or only once a team has the conversation. A conversation's own reply times already wait for its team.
- **Reply sound:** on by default, or off by default; customers can still change it.
- **Privacy notice:** a short notice with a link to the policy (https), shown when a conversation is started, per language.

**Install:**
- **Where the messenger ran in the last seven days:** each website, its visits, and how many were by verified signed-in customers.
- **Snippets** for HTML, React, Vue, Angular, WordPress and Google Tag Manager, each for visitors or for signed-in customers (with the identity token), with Copy.

**Set up identity verification:**
- **Four steps:**
  1. keep the secret on the server
  2. sign a token per signed-in customer
  3. pass it to the messenger
  4. check it works
- **Server examples** for Node, Python, PHP, Ruby, Go and Java, filled in with this workspace's issuer and key id.
- **Verification failures in the last seven days,** with their reasons and counts.

## How it works

**Config** (`server/messenger-config.ts`):
- `audiences.{visitors,users}.inbound` holds the four rules.
- `general` holds `replyTimes`, `soundDefault`, `languages` (from `lib/messenger-languages.ts`) and `privacy` (`enabled`, `url`, `text` per language).
- **Validation:**
  - only languages the messenger has words for (its own language is never listed)
  - an https policy address, and the notice in the messenger's own language before it's switched on
- **Older drafts and versions** read with the defaults: rules off, except "Talk to us", which stays offered as before.

**Enforcement:**
- **`inboundRules`** reads the published rules for a customer's audience, while `messenger_v3` is on.
- **`server/conversations.ts`** applies them when a customer starts a conversation or replies to a closed one (ticket or not).
- **`generalOf`** reads the published general settings. At boot, the messenger's language is matched to an offered one (exact, base, or same base); Home's availability and reply time are left out under "after_team".

**The identity failure log:**
- **What's recorded:** a boot that fails verification adds to `identity_failures` (brand, the generic reason the messenger was given, the hour, a count), in its own transaction since the boot's rolls back.
- **What's kept:** no user ids, emails or tokens; rows older than seven days are removed.
- **Where it shows:** `readMessenger` returns `install` (websites seen, verified visits, failures).

**The messenger** (`messenger/frame.tsx`, `messenger/help.tsx`, `messenger/strings-more.ts`):
- continues an open conversation, shows the closed note and the privacy notice
- starts the sound from its default
- hides "Talk to us" when the rule is off
- shows the new languages

## Migration

`db/postgres/0042_identity_failures.sql` is additive: `identity_failures`, with row-level security. The rollback empties it; the previous version never uses it.

## Not included

- **Session length and secure cookies:** Intercom offers them. Relay's sessions are already short (15 minutes verified, 24 hours anonymous) and its tokens aren't cookies; changing either belongs with security (phase 16).
- **Phone calls, Spotlight and mobile SDKs:** out of scope (plan).
- **"Import your style from a website":** left out (plan).

## Tests

**`tests/messenger-rules.test.ts`:**
- **Older drafts** read with the defaults.
- **Six refusals,** each with its reason.
- **Publishing** with French offered (the own language dropped), "after_team", a sound default and a privacy notice.
- **Enforcement:**
  - a visitor's second start refused with the open conversation's id
  - a reply to a closed conversation refused, then a new start allowed
  - a signed-in user's reply reopening a closed conversation, but refused on a closed ticket
  - with drafts off, the rules don't apply
- **Boot:**
  - `fr-CA` becomes French and `de-DE` the own English
  - no availability or reply time on Home
  - the sound default
- **Failures:** two failed verifications counted once with their reason and nothing personal, shown under install with the website seen.
- **Cross-workspace:** another workspace has none of it.

**`tests/browser/messenger-rules.spec.ts`** (ports 8990/8991):
- **Happy path:**
  - the rules, French and a privacy notice published
  - **A visitor** sees the notice and its link when starting, writes, and from Home continues the same conversation.
  - **Once the team closes it,** the visitor can't reply and is told why.
  - **A French visitor** gets "Accueil" and "Démarrer une conversation".
  - **Settings** shows the website seen, the React snippet for signed-in customers, and the Python example with this workspace's issuer.
- **Failure path:** an http privacy policy address is refused with the reason, and nothing is published.

**Updated:** `tests/messenger-config.test.ts` (an audience's default now includes its rules) and `messenger-settings.spec.ts` (an exact label beside the new privacy notice field).

## Checks

Results on 3 October 2026:
- `npm test`: 103/103 pass.
- `npm run typecheck`: clean.
- Lint shows nothing new.
- `npm run test:e2e`: 88/88.
- `npm run test:postgres`: passes.
- **Checked in screenshots:** the rules and languages cards with the preview continuing its example conversation, and the identity guide.
