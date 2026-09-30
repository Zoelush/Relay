# Tickets and SLAs — step C handoff (customer ticket portal)

Step C is the last step of phase 05 in `docs/TICKETS_PLAN.md`, so it completes the phase's plan locally. The B2 handoff (SLAs) is `docs/TICKETS_STEP4.md`.

Decisions approved on 30 September 2026:

- **Sign-in:** a signed identity token (the messenger's own) or a one-time hand-over from a verified messenger session.
- **Verified customers only.**
- **No ticket fields:** the portal shows only the number, type and customer label.
- **Plain-text replies only.**

Earlier phase decisions still apply: company visibility is an interface for phase 01, and the portal is served on the Relay host with a domain-to-brand table.

## 1. What changed

**Migration 0026 (`db/postgres/0026_portal.sql`):**

- **`portal_sessions`:** stores only a hash of each secret, with a 12-hour expiry and revocation.
- **`portal_handoffs`:** one-time codes, valid 60 seconds.
- **`portal_settings`:** visibility, `individual` or `company`.
- **Ticket types** gain `portal_visible` (on by default) and `portal_visibility`.
- **`portal_domains`:** routes a host to a workspace and brand. It keeps the tenant policy like every other table, plus a read-only `routing` policy that applies only when `relay.workspace_id='_routing'`, which the portal's host lookup sets. That lookup can read host, workspace and brand, nothing else.
- **The `portal_v1` flag,** off by default and on in the local relay.

The rollback turns the flag off, revokes sessions and drops nothing.

**Signing in (`server/portal.ts`):**

- **Signed link:** `/portal/{workspace}/{brand}#token=<identity JWT>&user=<id>&email=<email>` (or `/portal#…` on a mapped domain). The token is verified with the workspace's identity keys, exactly as the messenger does, always enforced. The format is in `docs/MESSENGER.md`.
- **From the messenger:** a verified session's "Your tickets and requests" button calls `POST /v1/messenger/portal-handoff`. That returns a URL with a one-time code, valid 60 seconds, in the fragment. The messenger opens the tab inside the click, so pop-up blockers allow it. Anonymous sessions are refused (`PORTAL_VERIFIED_ONLY`) and get no button.
- **The fragment** is never sent to a server or in a referrer. The page removes it from the address bar before doing anything else.
- **The session cookie** is `relay_portal=<id>.<secret>`: `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` over HTTPS, lasting 12 hours. Sign-out revokes it on the server.
- **Refusals:** forged, expired and other-workspace tokens, reused or expired codes, and missing credentials all get `PORTAL_SIGN_IN_FAILED`.

**Portal API (`/v1/portal/context`, `session`, `requests`, `request`, `reply`, `logout`):**

- **Scope:** the workspace and brand come from a mapped host, or else from the path; a session is valid only for its own.
- **Changes:** every `POST` must carry the page's own `Origin`, so cross-site and origin-less requests are refused. Replies also carry an idempotency key.
- **Requests** are the customer's own conversations and customer tickets, across their merged contact records and conversations they take part in.
  - Back-office and tracker tickets, merged conversations and ticket types hidden from the portal are never listed.
  - Opening one by id goes through the messenger's access check (404 for anyone else's, and for internal conversations) and a check that the ticket type is visible.
- **Parts** come through the same delivery policy as the messenger, so no internal notes and only `ticket_status` and "joined" system events. They're then reduced to explicit, safe fields.
- **Replies** use the ordinary customer reply command: they reopen a closed request, are idempotent, and appear in the inbox live.
- **Company visibility** is stored and reported with a notice, but behaves as "own requests" until phase 01 builds companies (TODO in `listRequests`).
- **Settings** (`/v1/agent/portal-settings`, needs `workspace.manage` to change): visibility, and adding or removing domains. A host already used by any workspace is refused (`PORTAL_DOMAIN_TAKEN`), decided by the database's unique key, since other workspaces' rows are invisible. Ticket types accept `portalVisible` and `portalVisibility`.

**The page (`portal/portal.tsx`, `portal/portal.css`, `portal/index.html`; built by `npm run portal:build` into `public/portal/`):**

- **Serving:** `server/assets.ts` serves it only while the portal is enabled for the brand. Its content security policy allows same-origin script, style and API only, with no inline code and no framing.
- **Screens:**
  - "Your requests": each request's title, its ticket line ("Ticket #12 (Refund request): Received") or open/closed state, and when it was last updated
  - a request's page: status, messages and event lines, and a reply box
  - sign-out
- **Look and language:** the brand's name and colour; English and Arabic (right-to-left) through the messenger's strings; light and dark themes.
- **Bundle:** 64 KB gzip.

**Messenger.** Verified sessions get `capabilities.tickets` and the "Your tickets and requests" button on the home screen.

**Local fixture.** On the loopback demo page, `/?user=jo` boots the messenger as a verified customer, and `/demo/portal-link?user=sam` is a signed link into the portal. Both are signed with the demo workspace's stored key, as a customer's site would do it. This is development only, like the local agent sign-in.

## 2. Files

| File | Change |
|---|---|
| `db/postgres/0026_portal.sql`, `db/rollback/0026_portal.sql` | Sessions, hand-over codes, settings, domains, ticket-type switches, flag |
| `server/portal.ts` | Scope, sign-in, sessions, requests, reply, hand-over, settings |
| `server/api.ts`, `server/agent-bridge.ts`, `server/assets.ts` | Portal routes, hand-over route, capability, settings route, page serving |
| `server/tickets.ts`, `server/people.ts` | Ticket-type portal switches; flag seed |
| `portal/*`, `scripts/build-portal.mjs`, `package.json`, `.gitignore` | The page and its build |
| `messenger/frame.tsx`, `messenger/strings.ts` | Portal button; English and Arabic strings |
| `scripts/local-relay.ts`, `workers/relay.ts` | Page serving; local flag, signed demo customer and portal link |
| `docs/MESSENGER.md` | Signed portal link format |
| `tests/portal.test.ts`, `tests/browser/portal.spec.ts` | Coverage below |

## 3. Run and verify

```bash
npm test
npm run typecheck
npm run test:e2e
```

Results on 30 September 2026:

- **Node:** 56/56 pass. `tests/portal.test.ts` covers:
  - **Flag:** off by default.
  - **Sign-in:** the brand context; the messenger offering the portal to verified customers only (anonymous refused, no capability); a hand-over code used once and refused when expired; signed-token sign-in, with forged, expired, other-workspace and missing credentials refused; only a hash stored; the cookie's exact attributes.
  - **What's listed:** own requests only, with the customer label; a hidden ticket type and a back-office ticket absent.
  - **What's shown:** no internal notes, internal state names or back-office titles in a request; another customer's, hidden and internal requests all 404 by id; no replying to someone else's.
  - **Replies:** cross-site and origin-less changes refused; a retried reply sent once; a closed request reopened.
  - **Sessions:** signed-out and cross-workspace access refused; sign-out revokes.
  - **Domains:** a domain taken by another workspace refused; domain routing for context, hand-over URLs and sessions; company visibility still showing only the customer's own requests.
- **Typecheck and lint:** clean on the new and changed files. The isolation test's rule that every table has forced row-level security still passes, `portal_domains` included.
- **Browser:** 36/36 pass. `tests/browser/portal.spec.ts` passed 4 out of 4 on repeat.
  - **Happy path:** a verified messenger customer's conversation is made a Refund request. "Your tickets and requests" opens the portal signed in, with the code gone from the address bar. The request shows "Ticket #N (Refund request): Submitted". The customer replies, and the teammate sees the reply in the inbox. Sign-out works.
  - **Failure path:** another customer signed in with a site link sees no requests, and typing Jo's request address shows "Conversation unavailable." and nothing of it. An anonymous visitor gets no portal button.

## 4. Deferred and known gaps

- **No company visibility** until phase 01 builds companies (interface and TODO in place).
- **No certificates or DNS verification** for custom domains (phase 17). Hosts are recorded and routed only.
- **No email sign-in links** until the email channel (phase 12).
- **No attachments** in portal replies, and **no customer-visible ticket fields** yet (a per-field switch could follow).
- **The portal doesn't update live.** It reloads after a reply; there's no realtime connection.
- **One portal cookie per host.** Signing into a second workspace's portal on the same Relay host replaces the first session.
- **No rate limiting** on the portal sign-in route beyond what the platform provides. Codes are 256-bit and single-use, and tokens are signed.
- **Still open from earlier steps:**
  - A new teammate's first list stays empty until the page reloads (phase 04).
  - The first-screen timing hasn't been re-measured with SLAs on (B2).
