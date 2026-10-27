# Relay

A customer communication and support platform — an alternative to Intercom.

## Build plan

The product is being built in 18 phases, numbered 00–17. The full plan and
the prompt for each phase is in `docs/BUILD_PHASES.md`. Read the relevant
phase before starting work. Phase 04 has its own detailed plan in
`docs/AGENT_INBOX_PLAN.md` (steps A–D); step A's handoff is
`docs/AGENT_INBOX_STEP1.md`. Verified progress is in `docs/STATUS.md`.
`docs/INTERCOM_GAP_AUDIT.md` compares Intercom with Relay (October 2026); its
additions are marked inside each phase of `docs/BUILD_PHASES.md`.

Current position: the messenger settings plan (`docs/MESSENGER_SETTINGS_PLAN.md`, asked for
before phase 08 A2) is complete locally (`docs/MESSENGER_SETTINGS_STEP1.md` to `STEP5.md`). Uploaded messenger images live in `brand_assets` (`server/brand-assets.ts`); the config
refers to one as `asset:<id>`, the boot turns it into Relay's address, and customers are served only
images their brand's live messenger uses. The messenger has no colour of its own: its surfaces are neutral,
and every colour comes from `palette()` in `lib/brand-colours.ts` (text on the brand colour, and the
brand colour as links, kept at 4.5:1); `tests/messenger-colours.test.ts` fails on a fixed colour on a
brand fill. Settings › Messenger follows Intercom's layout (tabs, one-at-a-time sections); browser
tests open sections with `tests/browser/messenger-sections.ts`. With `messenger_v3` on, a brand's messenger is a draft published as versions
(`server/messenger-config.ts`); publishing writes `brands.settings` (the `messenger3` key is only
booted while the flag is on). Its inbound rules are enforced in `server/conversations.ts`
(`inboundRules`), not only in the messenger. Settings' live preview loads the app's own copy of the
messenger page (`/messenger/frame.html?preview=1`); in preview mode it fetches and sends nothing.
Phase 08 (the AI agent, `docs/AI_PLAN.md`):
steps A1 (answering core), A2a (handover), A2b (escalation rules, topics, guidance), A3 (the
resolution ledger), Z1 (Zoe's home), Z2 (how Zoe answers), Z3a (specialists), Z3b (content
targeting), B2 (safety and privacy), C1 (the evaluation harness), C2a (the review queue) and C2b
(monitors and incidents) are done locally (`docs/AI_STEP1.md` to `AI_STEP12.md`): phase 08's plan is
complete, with the Claude evaluation baseline waiting for a key. Monitors (`server/zoe-monitors.ts`,
`zoe_monitors_v1`) are checked hourly by the sweep (`checkMonitors`); what trips one is
`tripped()` in `lib/zoe-monitors.ts`, shared with the pages. A notification is either a mention
(conversation, part, author) or a `zoe_incident` (incident only). Phase 10 (agent copilot) is skipped for now. Phase 12 (`docs/OMNICHANNEL_PLAN.md`):
E1, the channel contract (`server/channels.ts`, `channels_v1`), E2, email in (`server/email-in.ts`, `channel_email_v1`), E3, email
out (`server/email-out.ts`), and E4, email in the inbox, are done locally (`docs/OMNICHANNEL_STEP1.md` to `STEP4.md`): email is
complete. E5, WhatsApp (`server/whatsapp.ts`, `channel_whatsapp_v1`), and E6, SMS (`server/sms.ts`, `channel_sms_v1`), and E7,
Instagram and Facebook Messenger (`server/meta-messaging.ts`), are done locally (`docs/OMNICHANNEL_STEP5.md` to `STEP7.md`);
E8, Slack and Discord (`server/community.ts`), is done locally (`docs/OMNICHANNEL_STEP8.md`), and E9, voice (`server/voice.ts`,
`channel_voice_v1`), is done locally (`docs/OMNICHANNEL_STEP9.md`): phase 12's plan is complete. Phase 13 (`docs/OUTBOUND_PLAN.md`): O1,
events, subscription types and segments (`segments_v1`), and O2, the engine and in-app chats (`server/outbound.ts`, `outbound_v1`),
and O3, the Outbound area (`agent/outbound.tsx`, `#outbound`) and banners, are done locally (`docs/OUTBOUND_STEP1.md` to `STEP3.md`):
the scope (O1 to O3) is complete; O4 to O9 wait until asked. Phase 14 (`docs/REPORTING_PLAN.md`, scope R1 to R4): R1 (the store
and dictionary) and R2 (datasets, the query layer `server/reports.ts`, and the benchmark) and R3 (the Reports area, `agent/reports.tsx`,
`#reports`, in the strip before Outbound) and R4 (the live dashboard, `agent/live.tsx`, `#reports/live`, linked from the inbox menu) are done locally
(`docs/REPORTING_STEP1.md` to `STEP4.md`, `reports_v1`): the scope (R1 to R4) is complete; R5 to R7 wait until asked. The live dashboard
(`server/live.ts`) reads only the live set through 0076's partial indexes; keep `tests/live.test.ts`'s plan bound passing. The Reports page computes nothing: each chart is one `report-metric` call, and the overview's flow is `conversationFlow`. A metric is one definition in `server/reports.ts`'s `DEFS` (rows of the same
shape; `runMetric` filters, breaks down and aggregates) and one entry in `lib/metrics.ts`, and `tests/reports.test.ts` asserts it on its
scenario; rerun `scripts/reporting-benchmark.ts` when a definition's plan may change. Phase 15 (`docs/DEVELOPER_PLATFORM_PLAN.md`, scope D1 to D5):
D1, the API's foundation (`developer_api_v1`), and D2, coverage, search, export and the SDKs, and D3, webhooks, are
done locally, and D4, OAuth apps (`server/oauth.ts`, consent at `/oauth/authorize`), and D5, Canvas apps (`server/canvas.ts`,
`lib/canvas.ts`, `agent/canvas.tsx`; the example app `demo/order-lookup/`, `npm run example:orders`) are done locally
(`docs/DEVELOPER_PLATFORM_STEP1.md` to `STEP5.md`): the scope (D1 to D5) is complete; D6 and the messenger home wait until asked. Phase 16 (`docs/SECURITY_PLAN.md`, scope C1 to C10; Relay owns teammate
accounts; Stripe behind a port): C1, the audit log (`server/audit.ts`, `lib/audit-actions.ts`, `#settings/audit`, `security_v1`), is
and C2, roles and the permissions matrix (`lib/permissions.ts`, role `scope`), are done locally (`docs/SECURITY_STEP1.md`,
`STEP2.md`), and C3a, Relay's own sign-in (`server/accounts.ts`, `server/passwords.ts`, `/signin`, `/invite`, `/auth/*`), and C3b,
two-factor and IP allowlists (`server/totp.ts`, `server/two-factor.ts`, `server/allowlists.ts`, `#settings/access`), are done
locally (`docs/SECURITY_STEP3.md`, `STEP4.md`), and C4a, OIDC single sign-on (`server/sso.ts`, `#settings/sso`, `/auth/sso`,
the stand-in provider `scripts/local-idp.ts`), is done locally (`docs/SECURITY_STEP5.md`), and C4b, SAML 2.0 (`server/saml.ts`, the only user of
`@node-saml/node-saml`, checked on workerd), is done locally (`docs/SECURITY_STEP6.md`), and C5a, data subject requests (`server/erasure.ts`, `server/data-requests.ts`,
`#settings/data-requests`), is done locally (`docs/SECURITY_STEP7.md`); next is C5b (the analytical store, embeddings, processors,
backups). Every table is in `server/erasure.ts`'s `ERASURE` cascade or in `NO_PERSONAL_DATA` with why (`tests/erasure.test.ts` fails
otherwise): a new table that holds anything about a customer gets its step. Only `erase` sets `relay.erasure`, the one thing that lets
append-only tables lose a person's rows; ledgers and the audit log are scrubbed, never deleted. A deletion's certificate never names
the person, and a finished request keeps nothing about them. Both protocols end in
`admit`; never give one its own way into Relay. A SAML response is read only at `/auth/sso/callback` (the browser holding
the login's cookie), never at the ACS, which only parks it; signed assertions and InResponseTo are always required. An SSO identity is found only by connection and subject (`sso_identities`),
never by email after the first link; only verified emails at verified domains sign in; the role comes only from the first
mapped group, never the owner role, and an owner is never changed by groups. With SSO enforced, every way in other than SSO
is for owners only (`assertNotSsoOnly`, `assertPlatformAllowed`); a new way to sign in or join checks it. A Relay session's token lives only in the
HttpOnly `relay_session` cookie and is resolved by the API on every request (`resolveSession`, from the bridge's proof);
never trust a principal a host sends alongside it, and never put the token in a page or URL. A right password leads only
to `challengeOrSession`, so two-factor (and its requirement) can't be skipped by any path, resets included; a code is checked
only by `checkSecondFactor` (or `confirmSetup`), and wrong codes are kept (refused after the commit). The two-factor
challenge lives only in the HttpOnly `relay_2fa` cookie. The app's IP allowlist is checked on every agent request
(`assertNetwork`) and sign-in step (`signInAllowed`) against the address in the host's signed proof; the API's in
`handleRest` against `cf-connecting-ip` only (never `x-real-ip`, which a caller can set). A new surface for teammates or
tokens checks the matching list. Passwords are only `hashPassword`
(scrypt); sign-in answers the same for an unknown email and a wrong password. A conversation reaches a teammate only within their role's scope:
`visibleTo` (in `access`) for one, `scopeSql` for any list, count or search; a new query that lists conversations for a
teammate applies `scopeSql`, and `tests/restricted-roles.test.ts` sweeps every GET route for leaks. A new agent route gets
its line in `tests/fixtures/route-policy.ts` (the matrix fails without one); a new capability gets its plain words in
`lib/permissions.ts` (and whether a restricted role may have it, in migration 0082's `role_scope_allows` too). The audit log is append-only (a trigger
refuses changes; only `pruneAudit` deletes, past retention). Administrative tables are audited by migration 0081's `audit_row`
trigger in the change's own transaction: a new administrative table gets that trigger and a `TABLE_ACTIONS` entry (a test
compares them); anything that isn't a row change is `recordAudit` with an `EXPLICIT_ACTIONS` entry. The actor is the
transaction's (`authorize` sets `relay.actor_*`; the API sets `relay.actor_via`): never write audit rows with a hand-built actor.
Secrets never reach the log (the trigger skips secret-like columns; keep new secret columns named so).
A canvas reaches a browser only after `validateCanvas` (`lib/canvas.ts`, the one schema; a new component gets its checker,
its renderer in `agent/canvas.tsx` and its line in `COMPONENT_REFERENCE`); requests to apps go only through `canvasRequest`
(`safeRequest`, signed, time-limited, logged); requests carry ids, never customer data (apps read through the API within
their scopes); `stored_data` stays on the server; a composer app only adds to the draft. The reference's Canvas excerpts are
the example app's own lines (a test compares them). An app acts as its installer within the
granted scopes; its tokens are API tokens tied to the grant; codes and refresh tokens are single-use (reuse revokes). Webhook events are written only by
0078's triggers (`webhook_emit`); a new topic gets its trigger and an entry in `lib/webhook-topics.ts` (a test compares them). A
delivery's body is built once and kept; deliveries go only through `runWebhooks` (`safeRequest`, signed); never send an internal note. The SDKs (`sdk/`) are generated with the reference by
`npm run api:doc`, never edited by hand. Search fields live only in `lib/api-search.ts`'s registry. The spec (`lib/api-spec.ts`)
is the source: write an operation there first; the router (`server/rest.ts`), validation (`lib/api-validate.ts`) and the
reference (`npm run api:doc`, a test compares `docs/API.md`) follow from it. The public API calls the same domain functions
as the inbox (`command`, `authorize`), as the token's teammate, within its scopes; never give it its own path around them.
Tokens are kept only as hashes. Reports read only the analytical store
(`db/analytics`, a separate database), never the inbox's tables; it's written only by `analytics.project` (`server/analytics.ts`),
which is idempotent. Every metric is defined once in `lib/metrics.ts`; regenerate `docs/METRICS.md` with `npm run metrics:doc` (a test
compares them). Contact attributes in reports are the snapshot taken when the conversation started (`conversation_snapshots`); only
name and email are live. Durations use only phase 06's `businessMilliseconds`. A banner is drawn only by the loader (`showBanner`, its own shadow
root, brand colours from `theme.css`); clicks and closes are recorded only on the person's own entry (`outboundAction`). Every
outbound message to a person goes through `admit` (their lock row, re-entry, holdout, subscription, quiet hours, both caps, then the
type's delivery); never send outbound around it, and keep `tests/postgres/outbound.test.ts` (the burst) passing. A contact in a
message stays on the version they entered. A segment rule has one meaning: `lib/segments.ts` (`matches`) and its SQL
(`compileSegment`, `server/segments.ts`) must agree, and `tests/segments.test.ts`'s corpus holds them to it; a new rule gets both
and corpus cases. What a contact gets is only `effectiveSubscriptions` (`server/subscriptions.ts`), checked again by `mayDeliver`
for any delivery with a subscription type; there is no bypass. Events are kept only from a signed-in messenger user or a JWT
signed with the workspace's identity key (audience `relay-events`), once per sender's id. A call is steered only by
Twilio's signed steps (`voiceHook`); recording is allowed by the caller's calling code (none, announced, or press 1), and Zoe
and transcripts only ever hear a recorded call. Zoe on a call answers through her own `ai.reply` pipeline (each utterance is the
caller's message); never give a call its own model path. Recordings and transcripts are internal; a call is never answered in
writing (the adapter's `refuses`). Slack events are
taken only when signed, within 5 minutes, once per event id, for a connected Slack workspace's own team; Discord's gateway
protocol is `DiscordGatewaySession` (tested apart from any socket) and runs in the `DiscordGateway` Durable Object. Meta's windows are the adapters' `refuses`, told the part's author (a teammate may reply,
tagged HUMAN_AGENT, up to 7 days; automation only within 24 hours); inbound attachments come only from Meta's CDN, and
files go out by short-lived signed links. SMS segments are counted only by `lib/sms.ts`
(the composer and the 10-segment limit share it); an SMS opt-out is a suppression kept for good (START lifts it, recorded);
a teammate's text to an opted-out or unconsented number is refused when written; Twilio's calls are kept only when signed with
the account's token. WhatsApp's 24-hour window is its adapter's `refuses` (given the part: only an approved template, to an opted-in
number, passes once it's closed); its webhook is per workspace and kept only when signed with the workspace's app secret;
its credentials are sealed with the connector key and never returned. Side conversations (`server/email-side.ts`) are internal parts of their
conversation and never reach the customer; Zoe's replies on email are held deliveries until a teammate sends them (when the
setting asks), and she never answers unverified senders or list mail (`aiAnswers`, decided by the adapter). Email is
sent only by the email adapter's `send`, called only by `runDelivery` after `mayDeliver`; the provider's `sendRaw` is called only
by that `send` and the incident alert job (`sendAlert`), which checks `mayDeliver` itself, and `tests/email-out.test.ts` fails on
any other. Headers are written only by `server/email-mime.ts`. A brand sends from its
domain only when Relay's ownership record (this workspace's token) and DKIM are found; SES reports are believed only after
their SNS signature checks out, and find their workspace by the tags Relay set. Away emails read public parts only. Mail arrives only at a brand's inbound address
(`<workspace>+<token>@<domain>`, `acceptEmail`) and is read by the `email.receive` job; the inbox never renders raw email
HTML: it's made safe once on arrival (`server/email-html.ts`) and shown in the sandboxed frame (`agent/email-view.tsx`), with
remote images blocked until asked. A sender is verified only by a DMARC pass in a trusted receiver's Authentication-Results.
Automatic mail and bounces are never the customer's reply. A change to reading email gets a case in the corpus
(`scripts/email-corpus.py`, `tests/fixtures/email/expected.json`). No code outside an adapter asks which channel a conversation is on: it asks `capabilitiesOf` / the adapter. Every
outbound part on a non-messenger channel is a `channel_deliveries` row sent by `channel.deliver`, which checks
`mayDeliver` (the suppression list) right before sending; never send to a provider any other way. A channel
address joins an existing contact only when verified. Phase 11 (`docs/WORKFLOWS_PLAN.md`, behind `workflows_v1`):
W1 (the engine), W2 (the builder), W3 (customer-facing steps and simulation) and W4 (run log, alerts,
templates, more triggers, reusable workflows) are done locally (`docs/WORKFLOWS_STEP1.md` to `STEP4.md`;
acceptance demo `docs/WORKFLOWS_ACCEPTANCE.md`): phase 11 is complete locally. Time and page triggers fire once
per occurrence through `workflow_runs.trigger_key` (unique); a webhook's secret is kept only as a hash, never in an
idempotency record; every run's end goes through `finish`, which keeps the failing alert right. A workflow's
message to a customer is a `workflow_message` part, never a `teammate_reply`; Zoe is queued for a customer's
message only when `workflowHolds` is false; workflows call read connectors only, between transactions, under the
verification rules; simulation (`server/workflow-simulate.ts`) runs in a read-only transaction and must stay
that way. The builder (`agent/workflow-builder.tsx`, `#workflows/<id>`) checks drafts with
the definition's own `validate` and `problems`, and its live estimate (`server/workflow-estimate.ts`) judges with the
engine's `evaluate` on `buildFacts`; keep one definition of what a condition means. Card positions live in
`workflows.layout`, never in versions. Every timeline part
goes through `workflowEvent` (from `append`); workflow actions go through `command` as a `WorkflowActor`
(never write conversation state around it); a condition the engine can't evaluate is refused at
save or publish, never treated as no match. Phase 09 (`docs/ACTIONS_PLAN.md`, behind `ai_actions_v1`) is complete locally
(`docs/ACTIONS_STEP1.md` to `STEP4.md`): D1 data connectors (`server/connectors.ts`), D2 procedures
(`server/procedures.ts`, `lib/procedure-plan.ts`), D3 write actions, and D4 OAuth on the workspace's
behalf and each conversation's audit (`server/ai-audit.ts`). A write runs only for a signed-in customer, only with its
connector's writes on and the workspace not paused (`ai_agents.writes_paused`), after approval when
the connector asks (`ai_action_approvals`, resumed by `procedure.resume`), and is retried only with
an idempotency key; never weaken any of these. A procedure's control flow is its
compiled plan, never the model; `runAiReply` asks `procedureTurn` first, and `verified` (the
verification rules) gates every connector call in a conversation. A connector sends only declared inputs
and Zoe gets only mapped values; every call goes through `runConnector` (audit row, rate limit,
`safeRequest`), and tests use `tests/fixtures/connectors.ts`, never the network. Zoe's review
queue (`server/zoe-review.ts`, `zoe_review_v1`) is filled by the sweep (`sampleForReview`); a rating is
given once, and reviews and content gaps are internal, never written into a conversation. `npm test` runs the
evaluation (`eval/`, `tests/eval.test.ts`) and fails when a score falls below
`eval/baseline.stand-in.json`; a change that improves Zoe updates the baseline with
`npm run eval -- --update`, and a new behaviour gets golden cases in `eval/golden.ts`.
The AI agent is **Zoe**: her area is `agent/zoe.tsx`
(`#zoe/<page>`, in the strip between Inbox and Knowledge), her data `server/zoe.ts`; the reply job and
her Playground share `decide()` in `server/ai-agent.ts`, and the Playground must never write. Her voice
and answer guidance (`server/zoe-guidance.ts`, `lib/zoe-voice.ts`) reach the model as data under her
rules, never as powers; spam guidance can only make her leave a message alone. Guidance versions
(`ai_guidance_versions`) are append-only: restore by saving a new version. Her language is chosen in
code (`server/ai-language.ts`) from what the customer writes; a browser setting alone never hands over.
Locally, `.dev.vars` with `ANTHROPIC_API_KEY` makes `npm run dev:relay` answer with Claude; tests always
use the stand-ins. Specialists (`server/zoe-specialists.ts`) are picked at a conversation's first real
question (conditions and keywords in code, then the classifier) and kept (`conversations.ai_specialist_id`,
`ai_routed_at`); her knowledge is a `scope` in `server/ai-retrieval.ts`'s allowed set, never a filter
after ranking. Which specialist gave a reply lives in `ai_answers`, never in the reply's own data.
Content targeting (`server/ai-targeting.ts`) is Zoe's only: conditions are evaluated in code against the
facts escalation rules use, and the records a customer fails go into retrieval's allowed set as
`exclude`, before ranking; a website's targeting is copied onto its pages. Every model reply passes
`guardReply` (`server/ai-guard.ts`: canary, prompt, others' personal data, internal content) after
`checkReply`; the hostile corpus (`tests/fixtures/hostile.ts`) runs with a model that obeys every
injection, so a new attack belongs there. What's sent to a model provider goes through the answer's
redactor (`server/ai-privacy.ts`) and is recorded in `ai_model_calls` (90 days); never send customer text
to a model any other way.
`ai_resolutions` is append-only (a trigger refuses changes): correct it with a reversal row, never an
edit; billing (phase 16) reads the net. Escalation rules are
code (`server/ai-escalation.ts`, a closed list of conditions); topic keywords are checked in code
before the classifier, so they hold when the model is down. A handover's summary is an `internal_note` (never
delivered); `conversations.ai_state` (pending, escalated, needs_input) is set only by the agent and a
teammate's reply; the classifier (`ClassifierPort`) returns only "asks for a person" and sentiment,
so no message can grant the agent anything. The agent answers only from
passages `server/ai-retrieval.ts` allows, decided in PostgreSQL before ranking; the relevance gate
and the reply check in `server/ai-agent.ts` are code, not prompt text; `ai_reply` part data reaches
customers, so only sources and options go there (everything else in `ai_answers`). Models sit behind
`AnswerModel` and `RerankPort` (Claude and Workers AI deployed, stand-ins locally). Phase 07 (help
center and knowledge store, `docs/KNOWLEDGE_PLAN.md`) is complete locally (`docs/KNOWLEDGE_STEP1.md`
to `STEP8.md`). The public
help center is at `/help/demo/relay-help` locally. Phase 06 (routing, teams and workload) is complete locally, planned in
`docs/ROUTING_PLAN.md`; its step docs are `docs/ROUTING_STEP1.md` to `STEP3.md`. Phase 05
(tickets and SLAs; `docs/TICKETS_PLAN.md`, `TICKETS_STEP1.md` to `STEP5.md`) and phase 04
(agent inbox; `AGENT_INBOX_STEP1.md` to `STEP11.md`) are complete locally. Open items from phases 04–06 were cleared in
`docs/MAINTENANCE_2026-10.md`. Flags `tickets_v1`, `sla_v1`, `portal_v1`,
`routing_v1`, `knowledge_v1`, `help_center_v1`, `knowledge_sync_v1`, `knowledge_index_v1` and
`knowledge_health_v1`, `ai_agent_v1`, `messenger_v3`, `zoe_review_v1` and `zoe_monitors_v1` default off; the local relay turns them all on. The AI index (`server/knowledge-index.ts`) keeps vectors out
of PostgreSQL behind `EmbeddingPort` and `VectorStorePort`; retrieval re-checks access in PostgreSQL,
so never filter by vector-store metadata alone. Content health's near-duplicate check
(`server/knowledge-health.ts`) reads stored vectors back through `VectorStorePort.get`. Website sync fetches only public https addresses (`server/safe-fetch.ts`);
tests reach their local test site through `sync.policy.allowHosts`, never set when deployed.
Phases 01–03 are implemented locally but not complete
or hosted; see `docs/STATUS.md`. Locally, `/agent?as=grace` signs in as a second
teammate.

## Known state

- The app was built on ChatGPT Sites. The deployed app runs on that
  hosting with D1 bound as `DB` (`.openai/hosting.json`) and platform
  sign-in (`app/chatgpt-auth.ts`). There is no authored `wrangler.toml`;
  `vite.config.ts` and `scripts/worker-config.mjs` generate Worker config.
- The target transactional store is PostgreSQL (Neon, eu-west-2) reached
  from Workers via Hyperdrive (`server/postgres.ts`). Neon and Hyperdrive
  are not provisioned yet and no data has moved from D1; locally the
  Postgres path runs on embedded PGlite (`npm run dev:relay`).
  Migrations are in `db/postgres/`, rollbacks in `db/rollback/`.
- D1 is being retired but is still the live store. `db/index.ts`,
  `lib/relay-server.ts`, `app/api/inbox/route.ts` and
  `app/api/visitor/route.ts` still use it. Treat any new D1 usage as a bug.
- The inbox is chosen in `app/page.tsx`: `RELAY_AGENT_INBOX_V1=true`
  renders the Postgres/WebSocket inbox (`components/relay/postgres-inbox.tsx`),
  otherwise the legacy D1 inbox with 2-second polling
  (`components/relay/inbox.tsx`). The flag is unset in deployed config, so
  production is on D1 polling. The legacy path is single-tenant.
- Events, attachments and embeddings do not live in the primary
  database: events go to the analytical store, attachments to R2,
  embeddings to the vector store. None of these is provisioned; the
  analytical store and embeddings are not built.
- Background work: Cloudflare Queues for jobs, Cron Triggers for
  schedules, Durable Object alarms for per-entity timers (snooze
  wake-ups, SLA clocks). Implemented in `workers/relay.ts`, not deployed.
- The agent app's colours are named tokens at the top of `agent/inbox.css`, with light and dark
  values (`docs/AGENT_DARK_MODE.md`). Use a token for any new colour; `tests/agent-theme.test.ts`
  fails on a written-in colour or a text pairing below WCAG AA. Colour marks meaning (Z1): eight
  tints (`--pg-tint-*`, applied with `data-hue`, `hueOf` in `agent/colour.tsx`) and Zoe's
  teal-to-emerald (`--pg-zoe-*`); neutrals stay neutral.
- Saved views (`agent_inbox_views_v1`) are on for the local dev relay; built-in views are Mine,
  Mentions, Unassigned and All, and the list's status picker chooses the status
  (`docs/AGENT_LIST_AND_HEADER.md`). Tests opt in with `inboxViews: true`.
- The agent app's frame is `agent/shell.tsx` (`docs/AGENT_APP_SHELL.md`): an icon strip that
  slides out on hover and can be pinned, and per-area side menus (`SideMenu`) that hide and peek
  back. New areas join the strip; their navigation goes in their own side menu. Team inboxes are
  built-in views named `team:<team id>`, kept in step with membership by initialize.
- Settings (`agent/settings.tsx`, `server/settings.ts`; `docs/SETTINGS_PLAN.md`) is one area behind
  `settings_v1`, with pages at `#settings/<page>`. A new configurable feature gets a page there (or a
  link card, if it's managed where the work happens), listed by `settingsOverview` with the
  permission it needs. The plan (S1–S3b) is complete. A brand's messenger settings live in
  `brands.settings` and are edited through `server/channel-settings.ts`, which keeps keys it doesn't
  own; allowed websites must be exact origins (`websiteOrigin`). Roles change only within the acting manager's own permissions, never their own, and always
  leaving an owner (`server/people-settings.ts`). Page
  building blocks are in `agent/settings-ui.tsx`. Tags and attributes are archived, never deleted
  (`server/workspace-data.ts`); pickers that add a tag use `activeTags` from `agent/timeline.tsx`.
- List rows are cards (`agent/card.tsx`, fixed `CARD_HEIGHT` for the virtual list). Their preview
  line comes from `listPreviews` in `server/conversations.ts`, read after the page is chosen; never
  join it into a page query (`docs/AGENT_CARDS_AND_COMPOSER.md` has the measurements).
- The local relay uses in-memory loopback attachment storage
  (`scripts/local-storage.ts`); its scanner flags the EICAR test file.
- Frontend is React 19 + TypeScript on Vinext/Vite. Tests:
  `npm test` (Node), `npm run test:e2e` (Playwright; builds the messenger, agent
  and portal bundles first, so do not call `npx playwright test` directly),
  `npm run typecheck`, and `npm run test:postgres` (assignment under real
  concurrency on a throwaway PostgreSQL 17; about a minute, so not part of
  `npm test`).

## Rules

- Multi-tenant by default. Every table carries a workspace id, every
  query is scoped to it. New routes need a test proving a
  cross-workspace read fails.
- Additive migrations only. Never drop or rename a column in the same
  deploy that stops writing to it. Always supply the rollback.
- Any write path an external system can retry must be idempotent on a
  client-supplied idempotency key.
- Work longer than 200ms (p95) goes to a background job with retries, a
  dead-letter queue, and a status the UI can read.
- Money, time and counts are computed server-side. The client renders.
- Timestamps are UTC with the originating timezone stored alongside.
  Durations that a human is judged on must also be computable in
  business hours.
- Ship behind a feature flag, defaulted off.
- Every phase ends with: migration plus rollback, seed data, unit tests,
  one end-to-end test of the happy path, one of the main failure path,
  and a CHANGELOG entry.
- Do not scaffold features from later phases. Define the interface,
  leave a TODO, and say which phase owns it.
- Secrets live in `.dev.vars` locally and `wrangler secret put` for
  deployed. Never in `wrangler.toml`, never committed, never printed.
- Internal notes must never be deliverable to a customer through any
  path, including email notifications and the messenger. Live signals
  follow `fanOutSignal` in `server/realtime.ts`; note typing and
  viewing are teammate-only.

## Working style

- One phase per branch, one step per session.
- Plan before code. If the plan is larger than expected, stop and ask.
- If a requirement is ambiguous, ask. Do not choose silently.
- Commit at the end of each step.
