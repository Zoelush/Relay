# The help center's design

Branch `ui/help-center` (November 2026). After phase 16 C9d, the public help center (phase 07, step B1) and its editor were compared with Intercom's (a read-only look at a live account, 11 November 2026) and found flat. This is the first of two parts: the pages customers see. The editor's own redesign (a two-column page with a live preview) is the second.

## What Intercom's help center has

- **Public pages:**
  - **Home:** a tall hero in the brand colour (a colour, gradient or image) with the logo, a welcome line ("Advice and answers from the … team") and one large, centred search box. Under it, a grid of collection cards, each with an icon, a title, a description and an article count. A footer with the logo, links and social buttons.
  - **Collection page:** the hero with the search, a breadcrumb ("All collections › …"), the collection's icon, name, description and count, and its articles as rows in a card with chevrons.
  - **Article page:** a summary under the title, the date, the body, a "Related articles" card, and "Did this answer your question?" with three face reactions.
- **The editor:** "Configure and style" with a live preview beside folding sections (templates, header, hero, layout and sections, collection page, article page, footer) and a General tab (languages, domains, analytics, privacy, social images).

## Decisions

1. **Two parts:** the public pages first (this branch), then the editor.
2. **Collection icons** come from a fixed set of line icons (`lib/help-icons.ts`, about 70 of lucide's), drawn in the help center's colour, so they look the same on every device; a collection without one shows an open book. Uploaded images as icons wait for the editor's redesign. The name is kept on the collection (`help_nodes.icon`, which existed, unused) and checked against the set.
3. **Feedback is three reactions** (disappointed, neutral, happy), with "Did this answer your question?". Happy counts as helpful; the other two count as not helpful and open the comment box, as "No" did, so insights, reports and the messenger's own "Was this helpful?" are unchanged.
4. **The welcome line** is part of the theme (`theme.welcome`, one per language, up to 160 characters); empty, it reads "Advice and answers from the … team" in the page's language.
5. **The hero carries the search** on every page (as Intercom's does). The homepage's "search" block now means the hero has the box; without it, the header has a smaller one, so search is always reachable.
6. **Still server-rendered with no script**, and the stylesheet is still fixed text hashed into the CSP.

## What changed

- **`server/help-style.ts`:** the stylesheet, rewritten: the hero (the colour deepening to a darker shade, or the surface), the search box with its icon and button, cards with icon tiles and a hover lift, article rows with chevrons, the related card, the reactions, and the footer. The theme adds `--accent-soft`, `--on-accent`, `--hero-bg` and `--hero-text`; `--header-bg` and `--header-text` stay.
- **`server/help-site.tsx`:**
  - **The shell:** the header (logo, requests link, languages), the hero (the welcome line on the home page; the search box), the page head (a collection's icon, the title, its description or date), the body and the footer.
  - **Home:** cards with icons and counts; the contact block as a card with a button.
  - **Collection and section:** the icon, description and count in the page head; rows with chevrons; sections with their counts.
  - **Article:** related articles (the others where it's placed, then what a search for its title finds; up to five), then the reactions.
  - **Search:** results as rows with their excerpts; the query stays in the hero's box.
- **`server/help-strings.ts`:** the welcome line, "All collections", "Browse by topic", "Related articles", the question and the three reactions, in English, French, German, Spanish and Arabic.
- **`server/help-content.ts`:** `Node.icon`. **`server/help-centers.ts`:** the icon is checked against the set; the theme's welcome lines are checked.
- **`agent/help-centers.tsx`:** an icon picker on each collection, and the welcome line (in the editor's language) in the settings.

## Checks

- **`tests/help-site.test.ts`:** the home shows the welcome line (the theme's, else the default in each language) and each collection's icon; a collection page shows its icon and count; an article shows related articles and the three reactions, and the sad and neutral ones record "not helpful" while the happy one records "helpful".
- **`tests/help-centers.test.ts`:** an icon outside the set and a welcome line over 160 characters are refused; a welcome line is saved per language.
- **`tests/browser/help-search.spec.ts`:** the vote on the public page uses the happy reaction.
- **Preview:** the home, a collection and an article, screenshotted.

## Not done here

- **The editor's redesign** (part two): the two-column page with a live preview, uploaded images as collection icons, header and footer links, and the hero's background image or gradient choices.
- **The messenger's Help space** still shows collections without their icons.
