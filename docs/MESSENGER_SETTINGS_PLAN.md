# Messenger settings: plan

A deeper set of messenger settings, after Intercom's (Settings › Channels › Messenger). The user asked for it before phase 08 step A2, on 3 October 2026, so the messenger can be shaped like Intercom's. Intercom's settings were read in the browser, read-only: sections and menus were opened, and nothing was changed, saved or published.

Every Intercom messenger setting, grouped by what the customer experiences:
- **Audiences** (visitors and signed-in users)
- **Spaces**
- **Home cards**
- **Welcome per language**
- **Launch into a conversation, and launcher visibility**
- **Appearance:** themes per scheme, header background, logos, launcher spacing
- **Conversation wording and a notice**
- **Inbound controls**
- **Languages**
- **Privacy**
- **Install guides**
- **A guided identity set-up**
- **A live preview**

Spotlight (a sales AI bar), mobile SDKs and phone calls are out of scope.

Approved on 3 October 2026 ("Yes, go ahead"):
1. **Three steps,** behind a new `messenger_v3` flag (off by default; on for the local relay).
2. **Drafts.** Changes are drafts that a preview can show, and **Publish** puts them live as a version; earlier versions can be restored.
3. **Allowed websites stay exact origins.** Wildcards are refused, unlike Intercom's `*.example.com`.
4. **Languages:** M3 adds French, Spanish, German, Portuguese (European and Brazilian), Italian and Dutch interface text, to be checked by native speakers. "Import your style from a website" is left out for now.

| Step | Scope |
|---|---|
| **M1: Content and audiences** | Visitor and user settings. Spaces chosen and ordered (Tickets included). A Home card builder with each card's audience. Welcome per language with `{first_name}`. Launch into a conversation, and launcher visibility by page address. Start-button wording. A special notice. Drafts, publishing and versions. |
| **M2: Look and preview** | Light and dark colours, header background (solid, gradient or image) with text colour and fade, home and launcher logos, launcher spacing, teammate faces on Home. A live preview in Settings that runs the real messenger on the draft. |
| **M3: Rules, languages, install** | One open conversation at a time; a conversation after a 😞 on an article; blocking replies to closed conversations and tickets; reply times only after team assignment. Interface languages, with a default and an allowlist. A privacy notice. The default for the incoming sound. Install guides per framework and an install status. A guided identity set-up with a verification-error log. |

| **M4: Intercom's layout and the brand's colours** (added 3 October 2026, on request) | The page laid out as Intercom's: Widget (Content, Appearance), Conversations, General, Install and Security tabs; sections that open one at a time, with Visitors/Users inside the ones that differ; the preview with its space, audience and theme beside them; "Save and set live". The messenger and launcher with no colour of their own: neutral surfaces, the brand's light and dark primary colours, readable text on them and readable links in them. |
| **M5: Logo uploads** (added 3 October 2026, on request) | Upload the Home screen logo and the launcher logo (PNG, JPG or GIF up to 1 MB; no SVG) through the scanned upload path, served to the messenger from Relay. Logos set as addresses keep working until replaced. |

**Decisions for M4 and M5** (agreed 3 October 2026):
- two steps, layout and colours first
- "Save draft" stays beside "Save and set live", so drafts and versions stay
- uploads replace the logo address fields
- a site with a strict content security policy must allow images from Relay's address for an uploaded launcher logo, said beside the upload and in the install guide

Handoffs: `docs/MESSENGER_SETTINGS_STEP1.md` (M1), `docs/MESSENGER_SETTINGS_STEP2.md` (M2), `docs/MESSENGER_SETTINGS_STEP3.md` (M3), `docs/MESSENGER_SETTINGS_STEP4.md` (M4). Next: M5.
