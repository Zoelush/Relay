# Messenger settings, step M5: logo uploads

Branch `messenger/m5-logos`. Plan: `docs/MESSENGER_SETTINGS_PLAN.md`. Behind `messenger_v3`, as drafts and published versions. This completes the messenger settings plan; next is phase 08 A2.

## What it does

Under Widget › Appearance › Messenger theme and branding, three images are uploaded, not typed as addresses:
- **Home screen logo:** at the top of the messenger.
- **Launcher logo:** in the launcher instead of ✦; 72 × 72 pixels with a transparent background is recommended.
- **Home background image:** when Home's background is "An image" (added on request beside the two logos).

**For each image:**
- **Controls:** Upload (or Change), Remove, and a small preview of the image.
- **Accepted files:** PNG, JPG or GIF up to 1 MB.
  - **SVG** is refused in the browser and by the server, because it can carry scripts.
  - **A file whose contents don't match its type** (a "PNG" that is really a web page) is refused by Relay's check.
  - **The virus scanner** can block a file too.
  - **The reason** is shown under the image.
- **When it shows:** a new image appears in the preview as soon as its check finishes. Customers see it only after "Save and set live".
- **Existing image addresses** keep working until replaced. Settings says when an image comes from an address.

**Content security policy:**
- **Beside the launcher logo:** the upload says a site with a content security policy must add Relay's address to `img-src`.
- **In the install guide:** a new line lists each directive that needs Relay's address.

## How it works

- **Storage** (`server/brand-assets.ts`, table `brand_assets`):
  - follows the attachment path: a signed upload into quarantine, then the job `messenger.asset.process` checks size and real type and scans the file, then a clean copy
  - managing the messenger (`workspace.manage`, Settings and `messenger_v3`) is required
  - `prepare` and `complete` go through `once()` with the request's idempotency key
- **The config:**
  - refers to a ready upload as `asset:<id>` in the field that took an address: `logo`, `look.launcherLogo`, `look.header.image`
  - validation accepts either form
  - saving and publishing check that each upload is this brand's, ready, and in the place it was uploaded for (`checkAssets`)
- **Serving:**
  - **Customers:** `GET /v1/messenger/brand-asset?w&id` serves an image only while its brand's live settings use it, with `nosniff`, a sandboxing content security policy and `cross-origin-resource-policy: cross-origin`, so a customer's site can show the launcher logo.
  - **Teammates:** `GET /api/agent/messenger-asset?id` serves any ready upload to managers, so the preview shows drafts.
  - **The boot** (`bootBrand`) turns `asset:<id>` into Relay's address.
  - **The messenger and loader** show an image from an https address or from Relay's own origin.
- **Tidying:**
  - when a brand uploads, its uploads that are over a day old and unused (not in the draft, the live messenger or any published version) are removed, rows and stored objects
  - earlier versions keep their images, so restoring one always works
  - stored keys never reach the browser
- **The local test site** allows images from the local API in its policy, as the install guide asks of customers.

## Migration

`db/postgres/0043_brand_assets.sql` is additive: `brand_assets`, with row-level security.

The rollback keeps the table, but the previous version can't show uploads. So live messengers that use one go back to no Home logo, the ✦, and no background. Drafts and versions keep their references; the previous version refuses to publish them until they are replaced with addresses.

## Not included

- **Image dimensions** aren't checked; the recommendation is shown and the messenger fits the image.
- **WebP** isn't accepted. Intercom takes PNG, JPG and GIF.
- **Seed data:** none. The demo brand starts without images, as a new brand does.

## Tests

**`tests/brand-assets.test.ts` (new):**
- **Five refusals before upload:** unknown purpose, SVG, WebP, over 1 MB, an unknown brand. A teammate without manage permission is refused.
- **The check rejects:**
  - a "PNG" that is HTML (`TYPE_MISMATCH`)
  - the test virus (`VIRUS_DETECTED`)
  - a rejected or misplaced upload is refused in a draft
- **Teammates and customers:** teammates see a draft's image; customers get a 404 until it is published. The boot then gives Relay's addresses, and the image is served with its headers.
- **Replacing and tidying:**
  - a replaced logo stops being served
  - two days later, tidying removes the rejected and abandoned uploads but keeps version 1's logo
  - restoring version 1 serves it again
- **Cross-workspace:** another workspace can't be served, preview, use or complete these images.

**`tests/browser/messenger-assets.spec.ts` (new; ports 8996/8997):**
- **Happy path:**
  - the three images uploaded, and shown in Settings and the preview at once
  - not served to customers before publishing
  - set live: the customer's launcher and messenger load the logos from Relay, and Home's background is the uploaded image
- **Failure path:**
  - an SVG is refused in the browser
  - a "PNG" that is a web page is refused by Relay's check with the reason
  - the field keeps what it had, and nothing is published

**Updated:** `tests/browser/messenger-look.spec.ts`. Its failure path used the launcher logo address field, so it now refuses launcher spacing beyond 120 pixels.

## Checks

Results on 3 October 2026:
- `npm test`: 107/107 pass.
- `npm run typecheck`: clean.
- Lint shows nothing new (one existing `<img>` warning).
- `npm run test:e2e`: 92/92.
- `npm run test:postgres`: passes.
- **Checked in the browser:** an uploaded logo in the preview, and the launcher on the test site showing the uploaded logo after it was set live.
