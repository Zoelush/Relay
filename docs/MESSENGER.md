# Relay messenger integration

Status: local implementation behind default-off flags. The existing D1 widget and inbox remain the current application path. The v2 demo is a separate, persistent, loopback-only application. Hosted acceptance has not run.

## Run locally

```sh
npm ci
npm run dev:relay
```

Open `http://127.0.0.1:8789/` for the hostile-style customer page and `/agent` for the local support fixture. The latter is an intentionally unauthenticated **loopback fixture**, not a deployable agent interface. Its server signs requests for the seeded teammate; no signing key is sent to the browser. Customer data and generated development keys persist in ignored `work/local-relay/`. A browser refresh or server restart does not reset this database. Tests use separate databases.

The local fixture also runs persisted jobs, outbox recovery and due snooze wakeups. Job status reaches clients over WebSocket. Its server-side timer simulates cloud infrastructure; browser clients do not poll jobs.

The original application still uses `npm run dev`. Nothing has been deployed, and no existing D1 data has been changed.

## Embed

Use your own external boot file so the host needs neither inline script permission nor `unsafe-eval`:

```html
<script src="/support-boot.js" defer></script>
<script src="https://support.example.com/messenger/loader.js" async></script>
```

`support-boot.js`:

```js
window.Relay = window.Relay || function () {
  (window.Relay.q = window.Relay.q || []).push(arguments);
};
Relay('boot', {
  api: 'https://support.example.com',
  workspaceId: 'your-workspace-id',
  brandId: 'your-brand-id',
  locale: document.documentElement.lang,
  // Optional: selector of an accessible host-owned button.
  // launcherSelector: '#contact-support'
});
```

Public commands: `boot(options)`, `open()`, `close()`, `showSpace('home'|'messages'|'help')`, `update()`, `setUser(userWithProof)`, `logout()`, `enableNotifications()`, `destroy()`. Call through `Relay(command, value)`. Listen for `relay:ready`, `relay:error`, `relay:identityRequired`, `relay:unread`, `relay:open`, `relay:close`, and `relay:logout` on `window`.

Boot starts after the host load event. Only the dependency-free loader, launcher stylesheet, brand stylesheet and bootstrap API load initially. Opening creates the iframe and loads React. The launcher lives in a closed shadow root; the messenger has its own document. Launcher controls appear only after their styles load. Position is fixed, so insertion does not reserve or change host layout.

Device tokens are random, scoped by workspace and brand in local storage. Identity proofs, session tokens, signed cursors and transcript caches stay in memory. The parent and iframe pin both `event.origin` and `event.source`, plus a per-frame nonce. Credentials never appear in iframe URLs.

`pushState`, `replaceState` and `popstate` update context automatically. Call `update` for an integration that changes navigation through another mechanism. The server retains only origin and pathname; query strings and fragments are removed.

## Exact host CSP

Merge these sources into the host's policy, replacing the example origin. Preserve the site's other required sources:

```http
Content-Security-Policy:
  default-src 'self';
  script-src 'self' https://support.example.com;
  style-src 'self' https://support.example.com;
  frame-src https://support.example.com;
  connect-src 'self' https://support.example.com wss://support.example.com;
  object-src 'none';
  base-uri 'self';
```

If the site separately declares `script-src-elem` or `style-src-elem`, add the support origin there as well; those directives override the corresponding general directive. A nonce-based policy with `strict-dynamic` must authorize the integration's script elements with the site's nonce. No inline script/style permission is required by Relay. The host does not need R2 in its CSP: uploads occur in the iframe.

The frame receives its own HTTP CSP: scripts and styles from its own origin; `connect-src` limited to its API/WebSocket origin and the configured R2 account endpoint; `frame-ancestors` limited to the brand's exact `allowedOrigins`; no objects, fonts, base URL changes or form submissions. Logo/custom-card URLs are workspace configuration; frame image requests permit HTTPS. Customer websites must be registered as exact origins, not wildcards.

The demo serves a stricter `default-src 'none'` policy, with no `unsafe-inline` or `unsafe-eval`, alongside an aggressive host stylesheet. Browser tests assert no CSP violations and no host layout movement. A hostile **script** can remove its own widget; CSS isolation does not attempt to protect against the owner of the host document.

## Verified identities

The customer's authenticated server signs an HS256 JWT with a workspace key. Required claims:

| Field | Value |
| --- | --- |
| Header `alg` | `HS256` only |
| Header `kid` | One of the workspace's two live key IDs |
| `iss` | `relay-customer:<workspaceId>` |
| `aud` | `relay-messenger` |
| `sub` | Customer application's stable user ID |
| `email` | The same email supplied in boot |
| `workspace_id` | The requested workspace |
| `iat`, `exp` | Numeric UTC epoch seconds; lifetime at most one hour |

Pass `{userId, email, jwt, name?}` as `user` in boot or `setUser`. Signing secrets belong only on the customer's server. The server rejects an unknown key, wrong algorithm, bad signature, expired token, mismatched workspace/user/email or unsigned identified request when enforcement is enabled. Disabling enforcement permits an unverified lead profile; it does **not** authorize that profile to read an existing user's history.

`identity_keys` permits two slots. To rotate: install the new wrapped key in the empty slot, start issuing its `kid`, wait for the old proof lifetime and refresh clients, then retire the old slot. Keys are encrypted with a separate deployment master key and authenticated to workspace and key ID. Key administration is currently an operator/database task; an admin configuration UI is not implemented. Do not put raw keys into brand settings or source control.

Legacy HMAC is off by default. Its explicit envelope is `{kid, expiresAt, signature}` with a lowercase hex SHA-256 HMAC over UTF-8 `JSON.stringify(['relay-identity-v1', workspaceId, userId, email, expiresAt])`. It binds expiry and workspace as well as identity. This is **not** the permanent Intercom-style hash of a user ID alone; an integration using that older format must adapt its server or use JWT.

Verified messenger sessions last at most 15 minutes and never outlive the customer proof. Handle `relay:identityRequired` by obtaining a fresh proof from the customer's server. There is no silent downgrade to anonymous access. Anonymous sessions last at most 24 hours. Logout immediately discards the presentation and local identity, rotates the device token, and attempts remote revocation. `relay:logout.remoteRevoked` reports whether that remote request completed; loss of network can prevent revocation until expiry.

## Configuration and later providers

Brand settings drive color, HTTPS logo URL, light/dark/system theme, launcher position/shape, exact host origins, team introduction, office hours, out-of-hours text, visitor policy, required-search policy, direct-conversation opening and Home blocks. Blocks support start, recent conversations, plain-text announcements, HTTPS custom cards and a Help entry. Locale strings use exact locale → language → brand locale → brand language → English; English and Arabic are supplied, with RTL layout.

Office-hour availability and the next opening time are calculated on the server using the configured IANA timezone. Conversation times are rendered from server-formatted values. Human first-response metrics retain wall-clock duration and a reference to an immutable business-calendar version; business-time computation is a job. Unknown legacy timezone/calendar provenance remains unknown.

Help articles, ticket history/conversion, and queue position need their owning services. They are advertised as unavailable until providers exist. `server/ports.ts` defines Help-center, phase-5 ticket, routing and event-store interfaces. Required-search brands cannot start a conversation while no Help provider can verify a search. No fabricated articles, tickets, surveys, queue positions or AI responses are supplied.

Unread badges count canonical conversations. Verified users aggregate their retained identity mappings; an old anonymous device token only sees its own authorized threads. Reading an imported conversation from a verified session acknowledges its linked identity positions. A conversation must be visible in Messages in a visible browser document before the widget acknowledges it; a background Home/Help subscription does not clear its unread state. Merge/reversal changes counters without rewriting parts.

Reply labels distinguish customers, named teammates, AI and automation. Assignment to the first human appends an explicit join marker. Internal notes never enter customer timelines. Note/reply edits append superseding records, and the UI renders the latest record while the server retains the audit history.

Sound is opt-in. Browser alert permission is requested from a host-owned control after an explicit user click; the iframe asks the loader to show that control. Alerts contain generic support text rather than message contents. Browser/OS permission rules still apply. Keyboard navigation, Escape-to-close with focus restoration, form labels, live message announcements and RTL are covered by the browser checks.

## Attachments

Files use signed, five-minute PUT URLs directly to a private R2 quarantine bucket. Supported types are PNG, JPEG, PDF and plain text, up to 10 MB. Finalization returns HTTP 202 and a job ID. The widget subscribes to that job over the same WebSocket; it does not poll job status.

The worker verifies actual size, declared MIME type, magic bytes and scanner verdict. It copies the exact approved bytes into a content-addressed key in the separate clean bucket and only then appends an attachment part. A still-live quarantine upload URL cannot replace the clean object. Images pass through a private Cloudflare Images service to produce PNG previews. Download/preview requests recheck conversation access and return expiring private URLs.

R2 quarantine CORS must allow the **messenger origin** to PUT with `Content-Type`. Clean URLs use the R2 S3 endpoint. Configure lifecycle cleanup for abandoned quarantine objects; never expose either bucket publicly. Scanner errors, missing definitions or stale definitions fail closed. The supplied private ClamAV adapter requires current signature files and a service token. Docker/ClamAV and hosted R2 were unavailable here; local tests use an explicit scanner double, not a claimed live antivirus test. Upload capability remains off without the scanner and preview bindings.

## Verification

```sh
npm run typecheck
npm test
PLAYWRIGHT_CHANNEL=chrome npm run test:e2e
PLAYWRIGHT_CHANNEL=chrome node --import tsx scripts/load-realtime.ts
```

Omit `PLAYWRIGHT_CHANNEL=chrome` when Playwright Chromium is installed. Browser tests use fresh profiles and loopback ports 8798/8799. The load harness uses 8808/8809, 200 agent connections, 5,000 open conversations, and 50 writes/second for 60 seconds. It records DOM-render latency, HTTP round trips, server processing and exact delivery counts in ignored `work/benchmarks/`.

The load fixture is embedded PostgreSQL plus Node and minimal DOM clients. It does not certify Neon/Hyperdrive, Cloudflare Durable Objects/Queues, cross-region networking, 200 complete inbox UIs, or a cold managed-database cache. Hosted measurements remain an acceptance gate. See `LOCAL_READINESS.md` for the measured results and unfinished work.

The mobile SDK remains a specification only: `MOBILE_SDK.md`.

Sources: [JWT security practices](https://www.rfc-editor.org/rfc/rfc8725), [CSP specification](https://www.w3.org/TR/CSP3/), [cross-document messaging](https://html.spec.whatwg.org/multipage/web-messaging.html), [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [Queues retries](https://developers.cloudflare.com/queues/configuration/batching-retries/).

## Customer portal link (phase 05)

Verified customers can open their requests in the customer portal. The messenger shows a "Your tickets and requests" button to verified sessions while the portal is enabled (`portal_v1`), using a one-time, 60-second hand-over code. Your site can also link to the portal directly with the same signed identity token the messenger accepts:

```text
https://support.example.com/portal/{workspaceId}/{brandId}#token={identity JWT}&user={userId}&email={email}
```

On a domain mapped to a brand (`/v1/agent/portal-settings`), use `https://help.example.com/portal#token=…`. The token and code travel in the fragment, which is never sent to a server or in a referrer; the portal removes it from the address bar at once and holds its session in an HttpOnly cookie. Anonymous visitors cannot use the portal.

## Office hours, reply time and queue position (phase 06)

The messenger's "online / away" line and next opening come from the business calendar that applies (team, then brand, then workspace; `/v1/agent/calendars`), so holidays and special days count. With no calendar, no hours line is shown. While open, it shows the expected reply time: the brand's measured median first response (last 14 days, at least 20 conversations) as a band, or the brand's own phrase in `settings.replyTime` (up to 80 characters). A customer waiting in a team inbox that assigns automatically sees their place in line ("You're 2nd in line"), updated live; set `settings.showQueuePosition` to `false` on a brand to hide it.
