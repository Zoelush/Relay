# Phase 15, step D5: Canvas apps, and the order-lookup acceptance app

Branch `platform/d5-canvas`. Plan: `docs/DEVELOPER_PLATFORM_PLAN.md` (scope: D1 to D5; decision 11). Behind `developer_api_v1`. With this step the scope is complete. D6 (sandbox, review, directory) and the messenger home placement wait until asked.

## What it does

**Giving an app a canvas** (Settings › Developers › Apps, on registering or with "Canvas…" later):
- **What you give:** a canvas address and its placements:
  - the inbox sidebar (`conversation.sidebar`)
  - the composer (`composer`)
  - settings (`settings`: the app's set-up step, after install)
- **What you get:** a canvas signing secret, shown once. "New signing secret" replaces it, and the old one keeps signing for 24 hours.
- **Error rate:** each app shows its requests and failures over 7 days, across every workspace that installed it.

**Where an installed app shows:**
- **The inbox sidebar:** under "Apps", one card per app for the open conversation.
- **The composer:** an "Apps" button (for teammates who can reply). The app's card floats above the composer; an answer of text goes into the reply draft, with "Added from <app> · review the text, then send". Nothing is sent by the app.
- **Settings (Installed here):**
  - **Shows in:** where each app shows, with its error rate here and "Needs setting up" until its set-up is done.
  - **Configure:** draws the app's set-up card. What it returns is kept with the installation and sent with every request.

**When something goes wrong:** a failure card with Try again, for each of these:
- the app didn't answer in 5 seconds
- it couldn't be reached
- it answered with an error status
- its answer was over 64 KB
- it sent a card Relay can't show, with the problem's path, as `canvas.content.components[0].type: must be one of …`

## How it works

**The schema (`lib/canvas.ts`):**
- **The 12 components:** text, image, button, link, input, textarea, dropdown, checkbox, list, data table, divider and spacer.
- **Checked strictly:** an unknown type or property is refused. Addresses are https. Text is plain. Ids are unique (list items included).
- **What each request may answer** (`parseAnswer`):
  - a canvas, always
  - `insert_text`, only to a composer submit
  - `results`, only to configure
- **What a teammate may press** (`submittable`), and which entered values are kept (`inputValues`: only the canvas's own fields, checked against their options).
- **The reference's table** of components comes from here (`COMPONENT_REFERENCE`).

**Requests (`server/canvas.ts`, `canvasRequest`):**
- **The call:** `POST <canvas address>/initialize | /submit | /configure` through `safeRequest`, signed with `Relay-Signature` (the webhooks' format, so the SDKs' `verifyWebhook` checks it).
- **The body:**
  - `type`, `placement`, `request_id`, `workspace_id`, `installation_id`
  - `teammate`
  - `conversation` (`id`, `contact_id`)
  - `settings`
  - on a submit: `component_id`, `input_values`, `stored_data` and `current_canvas`
- **No customer data is sent:** the app reads it through the API with its own token, within its scopes.
- **Who may ask:** teammates who can read the conversation (sidebar, composer), or who manage the workspace (settings).

**Sessions (`canvas_sessions`, an hour):** the canvas on screen and its `stored_data` are kept on the server.
- **A submit must name** something pressable on that canvas, by the teammate who opened it, in the same placement and conversation.
- **`stored_data` never reaches a browser.**

**Logs and rates:**
- **This workspace:** every request is a `canvas_calls` row (outcome, status, time, error), kept 30 days.
- **The developer:** daily counts go to `canvas_app_daily` in the app's own workspace. Only counts cross workspaces.

**Reading an app from where it's installed:** inside the developer's workspace's tenant (`appCanvas`), as D4 reads apps, never by a search across workspaces.

**Code:**
- **The inbox:** `agent/canvas.tsx` (`CanvasView`, `CanvasApp`, `CanvasCards`, `ComposerApps`), mounted in `agent/sidebar.tsx` and the composer (`components/relay/postgres-inbox.tsx`, `insertFromApp`).
- **Settings:** `agent/settings-apps.tsx`.
- **Routes:** `canvas-apps` (GET) and `canvas` (POST) for the agent app. `developer-apps` gains `canvas` (placements and rates).
- **Environment:** `ApiEnvironment.canvas` (the connector key, fetch policy and time limit). The local relay allows the example app's `127.0.0.1:8830`.
- **Phase 04's placeholder app-slot contract** (`lib/app-slots.ts`, `context.apps`) is removed. Apps act through the API, never by asking the host.

**Migration `0080_canvas_apps`:** `oauth_apps` canvas columns, `oauth_grants.canvas_settings` and `configured_at`, and `canvas_sessions`, `canvas_calls` and `canvas_app_daily`, all under row-level security.
- **Its rollback** removes every placement and forgets the cards on screen. Columns, tables and logs stay.

## The acceptance app: order lookup (`demo/order-lookup/`)

Built only on what any developer has: OAuth, the REST API through the generated JavaScript SDK, and Canvas.
- **`orders.ts`:** the demo order service (two shops, orders made up from the customer's email, the same every time).
- **`app.ts`:** the app.
  - **Installing:** `/install` (PKCE) and `/oauth/callback` (tokens kept per workspace, refreshed).
  - **Every canvas request is verified** before anything else.
  - **Sidebar:** the customer's orders, with details per order.
  - **Composer:** an order's status, plus an optional line, into the reply.
  - **Configure:** choose a shop, and whether to show refunded orders.
- **`serve.ts`:** `npm run example:orders` runs both on this machine (the steps are at its top).
- **The reference's "Canvas apps" section** quotes the app's own lines, and `tests/canvas.test.ts` fails if they drift.

**Seed data:** none in Relay. An app needs your credentials. The example app is the seed for trying it.

## Checks

- **`tests/canvas.test.ts`:**
  - **The schema:** every component; refusals with paths (unknown type and property, http and `javascript:` addresses, missing alt, duplicate ids, a url action on an input, a dropdown value not in its options, too many components, over-long text and stored data); what each request may answer; what can be pressed; which values are kept.
  - **The reference's excerpts** are the app's own code.
  - **End to end, in process,** with the real example app:
    - registration refuses a private address, placements without an address, and an unknown placement
    - installed through consent, it reads the customer through the API
    - requests are signed, carry no customer data, and `stored_data` stays server-side
    - only what's on the card can be pressed, by the teammate who opened it
    - configure is for managers only, and its results are sent from then on
    - the composer returns text
    - the app's own error card is drawn
    - the rotated secret still signs, and a wrong one is refused by the app
  - **Failures:** time out, unreachable, invalid, too large.
  - **Rates:** for both sides.
  - **Isolation:** another workspace is refused.
  - **API off:** no apps shown.
  - **Archived:** no longer shown.
  - **Rollback.**
- **`tests/browser/canvas.spec.ts`,** with the example app and order service on this machine:
  - **Happy path:** registered with a canvas in Settings, installed from its install page, set up in Settings (the app's own form), the sidebar lists the customer's orders and opens one, and the composer puts an order's status and a line into the reply.
  - **Failure path:** the app stopped gives a failure card ("couldn't be reached") with Try again, which draws it once it's back, and the failures show in Settings for the workspace and the developer.
