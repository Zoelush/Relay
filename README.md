# Relay live chat MVP

An original Intercom-inspired live chat application with a private team inbox and embeddable visitor messenger.

## Features

- D1-persisted conversations, messages, internal notes, and branding.
- Agent inbox with search, open/closed filters, assignment to self, priority, resolve/reopen, and customer details.
- Visitor messenger at `/messenger`, compact version at `/embed`, and installable `/widget.js` launcher.
- Live updates through non-overlapping two-second polling.
- Visitor credentials scoped to one conversation; only a hash is stored in D1. Private notes are filtered on the server.
- Authenticated owner-only agent APIs. Workspace ownership is bound on first authenticated initialization, while the Site is owner-private.
- Idempotent visitor message retries and preserved drafts on failed sends.
- Five clearly marked sample conversations initialized once. Local testing data does not deploy.

## Local development

Use Node 22.13 or later. Install the lockfile dependencies with `npm run install:ci`, then run `npm run dev`.

The Sites starter's portable preview supplies a local sign-in at `/signin-with-chatgpt?return_to=/`. It is not included in the production build.

Generate schema migrations with `npm run db:generate`; build with `npm run build`. Apply each new local migration once using Wrangler's D1 execute command with `--local --config dist/server/wrangler.json --persist-to .wrangler/state --file <migration>`.

Production schema migrations are included in the deployment archive and applied by Sites. Run `npx tsc --noEmit` to check types.

## Scope

The published MVP is private to its owner. Test the messenger in the inbox or a separate tab. Installing on a public customer website requires enabling public visitor access while retaining the server-side owner restriction on the inbox. Initialize and verify the owner before any audience change.

This is a single-agent MVP: assignment supports You and Unassigned. It does not include teammate invitations, AI replies, email delivery, attachments, multi-workspace tenancy, or omnichannel support. Public rollout should add abuse throttling and visitor-session lifecycle management. Visitor session credentials currently persist in the browser, while authoritative chat data stays in D1.

## Research

The product takes its core workflow from Intercom's public Messenger, Inbox, and conversation-management documentation, with original Relay branding and layout.
