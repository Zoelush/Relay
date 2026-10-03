# Messenger settings, step M4: Intercom's layout and the brand's colours

Branch `messenger/m4-layout`. Plan: `docs/MESSENGER_SETTINGS_PLAN.md` (M4 and M5 were added after M3, on request). Behind `messenger_v3`, as drafts and published versions. Next: M5, logo uploads.

## What it does

**Intercom's layout** (checked read-only against Intercom's messenger settings, October 2026):
- **Tabs:** Widget, Conversations, General, Install, Security. Widget has a Content / Appearance switch.
- **Sections that open one at a time.** Closed, each says what's set, such as "Home, Messages, Help" or "On every page".
- **A Visitors / Users switch inside each section that differs by audience:** Spaces, Launch directly into a conversation, Show the Messenger launcher, Start conversation button text, and the conversation rules.
- **The preview beside the sections:**
  - controls for which space it shows, visitors or users, and as set, light or dark
  - opening a section shows its space; Configure privacy settings, for example, shows Messages
  - choosing the dark theme's colours shows the preview dark
- **The buttons:** "Save and set live" (Intercom's wording) beside "Save draft". Drafts, discarding, and restoring an earlier version stay, in a bar above the tabs.

**Where everything is now:**

| Tab | Sections |
|---|---|
| Widget › Content | Spaces · Launch directly into a conversation · Set your welcome message · Customize Home with cards · Show the Messenger launcher |
| Widget › Appearance | Brand · Messenger theme and branding (colour scheme, light and dark primary colours, Home screen logo, launcher logo, Home background, header text colour, fade) · Teammate avatars · Launcher position (side, shape, spacing) |
| Conversations | Start conversation button text · Reply expectations (reply times, away message) · Team introduction · Special notice |
| General | Control inbound volume (who can start, search first, the conversation rules) · Supported languages · Keep your Messenger secure (websites) · Configure privacy settings · Other preferences (reply sound) |
| Install | The install snippets and where the messenger has run |
| Security | Identity verification, and the guided set-up with its failure log |

**The brand's colours, everywhere:**
- **No colour of Relay's own.** The messenger's backgrounds, text and borders are neutral greys in both themes. Before, they were tinted green, and the dark theme was dark green.
- **Everything coloured comes from the brand's primary colour** (a separate one for the dark theme if chosen): buttons, the customer's messages, the send button, teammates' initials, links, and the launcher.
- **Text on the brand colour** is black or white, whichever reads better. A pale yellow gets black text. Either way, it is at least 4.5:1.
- **The brand colour as text** (links, the active space) is darkened in the light theme, or lightened in the dark one, just enough to read at 4.5:1. Settings says when it does, for example "Links use #806910".
- **The launcher and the notification prompt** take the brand colour and its readable text from the brand's stylesheet. Before, the stylesheet coloured the background only, and the text was always white.
- **Relay's green** stays only as a new brand's starting colour (`DEFAULT_COLOR`). Nothing falls back to it any more.

## How it works

- **`lib/brand-colours.ts`:** `palette(color, darkColor)` gives each theme's `accent`, `onAccent` and `accentText`, using WCAG contrast. Three places share it, so they agree:
  - the server, for the launcher's `theme.css` (`server/assets.ts`)
  - the messenger (`messenger/frame.tsx`, as CSS variables)
  - Settings' sample swatch and launcher preview
- **The messenger's CSS** (`messenger/frame.css`):
  - neutral tokens, plus `--accent`, `--on-accent` and `--accent-text`, from the boot's `--accent-light`, `--on-accent-light` and so on
  - fills use `--on-accent`, and coloured text uses `--accent-text`
  - the fallback before boot is a neutral grey
- **The launcher's stylesheet** sets `--relay-accent` and `--relay-on-accent` on the shadow host. `public/messenger/launcher.css` reads them.
- **Settings** (`agent/settings-messenger.tsx`):
  - `MessengerView` holds the tab, the open sections, the audience, the preview's space and theme, and the theme being edited
  - it's kept by `useMessengerDrafts`, so it survives the editor starting afresh after each save
  - the preview asks the messenger for a space with `page` in its `initialize` message (`messenger/frame.tsx`; ignored outside the preview)
- **Validation:** a primary colour that isn't six-digit hex is refused: "Choose the primary colour as six-digit hex, such as #1d4ed8." The examples no longer suggest green.

## Migration

None: no stored data changed shape. Drafts and versions read as before.

## Not included

- **Uploading logos:** that's M5. The Home screen and launcher logos are still https addresses.
- **Intercom's "With Fin" settings** under Conversations: they wait for the AI agent's settings (phase 08 B1), and a TODO marks the place.
- **Spotlight, mobile SDKs, phone calls and "Import your style":** out of scope, as in the plan.
- **The customer portal and help center** keep their own colour settings. The portal's page still has a green-tinted fallback (`portal/portal.css`), outside the messenger.

## Tests

**`tests/messenger-colours.test.ts` (new):**
- **Readable on any colour:** for 405 colours, text on the colour, and the colour as links, reach 4.5:1 on both themes' backgrounds.
- **Specific colours:**
  - pale yellow gets black text and darker links
  - dark blue keeps white text and its own colour
  - an unusable dark colour falls back to the light one
- **No colour of its own:**
  - `frame.css` and `launcher.css` contain no Relay green
  - every brand-coloured fill takes its text from the palette
  - the backgrounds checked are the ones the messenger uses
- **The launcher's stylesheet** per workspace: yellow with black, blue with white. An unknown workspace gets a 404.

**`tests/browser/messenger-layout.spec.ts` (new; ports 8994/8995):**
- **Happy path:**
  - the tabs and each tab's sections in Intercom's order; closed sections' summaries; one section open at a time
  - opening privacy shows Messages in the preview
  - a pale yellow in the light scheme: Settings explains black text and darker links, and the preview shows black on yellow on a neutral background
  - set live: the customer's launcher is yellow with black, the messenger's button is yellow with black, its brand mark is the darker yellow, and nothing in the messenger is Relay's green
  - Install and Security have their tabs
- **Failure path:** a primary colour of `#ffd2` is explained in Settings, refused with the reason, and nothing goes live.

**Updated for the new layout:**
- `tests/browser/messenger-settings.spec.ts`, `messenger-look.spec.ts` and `messenger-rules.spec.ts` open their sections through `tests/browser/messenger-sections.ts`, and press "Save and set live".
- `tests/settings-channels.test.ts`: the new colour message.

## Checks

Results on 3 October 2026:
- `npm test`: 106/106 pass.
- `npm run typecheck`: clean.
- Lint shows nothing new (one existing `<img>` warning).
- `npm run test:e2e`: 90/90.
- `npm run test:postgres`: passes.
- **Checked in screenshots:**
  - the Content and Appearance tabs at desktop width, with the preview beside them
  - a pale yellow brand with black text on its buttons and launcher
  - the stacked layout at a narrow width
