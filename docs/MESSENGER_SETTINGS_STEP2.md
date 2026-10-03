# Messenger settings, step M2: the look and the live preview

Branch `messenger/m2-look`. Plan: `docs/MESSENGER_SETTINGS_PLAN.md`. Behind `messenger_v3` (from M1), as drafts and published versions.

## What it does

**A live preview** beside the Messenger settings:
- **It's the real messenger,** running on the unsaved draft, so every change shows at once, before saving.
- **It follows the Visitors/Users switch:**
  - for a signed-in user it greets them by an example name (Alex) and shows their Tickets space
  - for a visitor the name is left out
- **Themes:** "As set", "Light" and "Dark" show it in either theme without changing the setting.
- **Safe to click around:** it fetches and sends nothing, and shows an example conversation.
- **The launcher** is drawn beneath it, with its side, spacing, shape, colour and logo.
- **Layout:** beside the fields on wide screens, below them on narrower ones.

**A new card, "Home background and launcher":**
- **Dark theme colour:** a different primary colour in the dark theme (otherwise the brand colour is used in both).
- **Home background** behind the welcome:
  - none, a colour, a gradient of two or three colours, or an image (https)
  - white or black text on it
  - "Fade the background into the page"
  - with a notice, the background starts below it
- **Teammates on Home:** up to three teammates' initials, active ones first, with their first names on hover. Only first names and initials leave the server.
- **Launcher logo:** an https image instead of the ✦. The site's content policy must allow its address.
- **Launcher spacing:** side and bottom, 0 to 120 pixels, on computers and tablets. Phones keep the bottom-right corner.

## How it works

**The preview:**
- the app loads its own copy of the messenger's page (`/messenger/frame.html?preview=1`, from `public/`) in an iframe
- the app sends it a boot built from the draft, the audience and the chosen theme, by `postMessage` on a per-page channel
- in preview mode the messenger's requests return an example conversation or nothing, and sending and the portal do nothing
- in the local relay, the host serves those three files, and the agent page's policy allows same-origin frames and https images

**The messenger:**
- **Colours:** it takes its colours from the boot (`--accent-light`, `--accent-dark`, used by the theme rules) instead of loading the brand stylesheet, so a draft's colours show at once.
- **The welcome** gets the background, text colour and fade from `look`, and the teammates' initials.
- **The loader** puts the launcher logo in the button and sets `--relay-side` and `--relay-bottom` on its host element. The launcher's styles read those variables for the button and the messenger's position.

**Server:**
- **`look`** joins the config (`server/messenger-config.ts`): `darkColor`, `header` (background, colours, image, text, fade), `launcherLogo`, `launcherSpacing` and `showTeammates`.
- **Validation:** hex colours, a gradient of two or three, https images, spacing 0 to 120, white or black text.
- **Older drafts:** drafts and versions from before M2 read with the default look (no background), so they aren't shown as changed.
- **The boot** (`bootBrand`) adds `team` (first name and initials of up to three teammates, active first) only when "Show teammates" is on.

No migration: the look is part of the draft and version configs.

## Not included yet

- **Teammates' photos:** initials only, until a profile photo store exists (S1).
- **M3:** inbound rules, interface languages, privacy notice, the incoming sound's default, install guides and status, guided identity set-up.

## Tests

**`tests/messenger-look.test.ts`:**
- a draft without `look` reads with the default and isn't "changed"
- six refusals, each with its reason
- a look saved (normalised) and published, and the messenger boots with it
- teammates in the boot: three, active first, first names and initials only, and none when switched off
- another workspace's messenger shows only its own teammates

**`tests/browser/messenger-look.spec.ts`** (ports 8982/8983):
- **Happy path:**
  - **Edits before saving:** the preview shows the greeting, a gradient with a fade, and three teammates.
  - **The dark colour:** the start button changes to it with the preview set to dark, and back in light.
  - **Users:** "Welcome Alex 👋" and Tickets.
  - **Publishing:** the launcher spacing set and published; the preview made no messenger API calls.
  - **The customer's messenger:** the welcome on its gradient, the team's initials and the launcher spacing.
- **Failure path:** an http launcher logo shows the ✦ in the preview and is refused with the reason, and nothing is published.

**Updated:** `agent/inbox.css` uses colour tokens only (`tests/agent-theme.test.ts`).

## Checks

Results on 3 October 2026:
- `npm test`: 102/102 pass.
- `npm run typecheck`: clean.
- Lint shows nothing new, apart from Next's advice to use its image component, which doesn't apply to an outside logo.
- `npm run test:e2e`: 86/86. The messenger specs were run again after the notice fix: 8/8.
- `npm run test:postgres`: passes.
- **Checked in screenshots:**
  - the editor with the preview, light and dark
  - the welcome with and without a notice; this found and fixed the notice overlapping the background
