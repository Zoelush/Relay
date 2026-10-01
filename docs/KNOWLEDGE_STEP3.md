# Phase 07, step B1: the public help center

Branch `phase-07/step-b1`. Plan: `docs/KNOWLEDGE_PLAN.md`. Approved on 1 October 2026:
- hosted at `/help/{workspace}/{center}/…`, or at the root of a mapped custom domain, with the hosted subdomain and certificates in phase 17
- privacy-respecting video iframes
- signed-in access through the portal's customer session, with a sign-in page that reveals nothing
- an explicit "FAQ article" switch for FAQ structured data

## What it does

**Pages.** `server/help-site.tsx` renders the help center on the server with React's `renderToStaticMarkup`. It sends no client JavaScript.
- **Home:** the homepage blocks in the help center's order: collections with article counts, featured articles, and "Still need help?" linking to the portal.
- **Collection:** its sections and articles.
- **Section:** its articles.
- **Article:** breadcrumbs, "Updated {date}" in the page's language, and the full article format: headings, callouts, tables (with merged cells), code with a language, YouTube and Vimeo players, and internal links pointing to the target's current address in the page's language. A link to something not visible is shown as plain text.
- **Themed 404 page** and **sign-in page.**
- **Everywhere:** a language switcher and "Your requests" (the portal).

Empty collections and sections are left out. Page furniture is translated into English, French, German, Spanish and Arabic; other languages use their base language, then English. Arabic and other right-to-left languages get `dir="rtl"`.

**Addresses.**
- **Hosted:** `/help/{workspace}/{center}/{locale}/articles|collections|sections/{slug}`.
- **Custom domain:** a host in `portal_domains` serves its brand's help center at the root (`/{locale}/…`, `/sitemap.xml`, `/robots.txt`), while `/portal` and `/v1/…` keep going to the portal. Only that brand's help center can be reached on that domain.
- **The help center root** (`/help/{workspace}/{center}`, or `/` on a custom domain) gives a `302` to the visitor's best language from `Accept-Language`, with `Vary: Accept-Language`.
- **Old slugs, old help center addresses and unsupported languages** (`fr-BE` → `fr`) give a `301`, using A2's resolver.

**SEO.**
- `<html lang>` and `Content-Language`
- a title, and a meta description taken from the article's first paragraph
- a canonical tag: a page shown in a fallback language points at that language's page
- `hreflang` tags only for the languages the page really exists in, plus `x-default` (the default language)
- Open Graph and Twitter tags
- JSON-LD: `Article`, `BreadcrumbList` and `WebSite`
- `FAQPage` for articles switched on as FAQs: each level-2 heading ending in "?" (also "？" and "؟"), with the content up to the next level-2 heading as its answer
- `sitemap.xml` per help center, with every public page in each language it exists in, its alternates and `lastmod`
- `robots.txt` on custom domains

**Hidden from search engines and restricted pages.** A help center hidden from search engines, signed-in content, and error pages all get:
- `noindex, nofollow` in a meta tag and in `X-Robots-Tag`
- no `hreflang` or JSON-LD
- no place in the sitemap

`robots.txt` disallows everything for a hidden or signed-in-only help center.

**Access.**
- A help center is for everyone or for signed-in customers (a new setting). An article can be for signed-in customers (the A1 audience).
- **Signed in** means a valid portal session for the brand: the same HttpOnly cookie, and the same sign-in methods (a signed link from the customer's site, or a hand-over from the messenger).
- **Without a session:**
  - a restricted page answers `401` with a sign-in page that names nothing about what was asked for
  - signed-in articles aren't listed at all
- Restricted pages, and any page seen with a session, are `private, no-store`.

**Caching and security.**
- **Public pages:** `public, max-age=60, stale-while-revalidate=300`, an `ETag`, and `304` on a match. `HEAD` is supported.
- **CSP:**
  - `default-src 'none'`
  - styles allowed only by their SHA-256 hashes: a fixed stylesheet, plus a small block of theme variables per help center, so pages stay cacheable
  - `frame-src` limited to `www.youtube-nocookie.com` and `player.vimeo.com`
  - no script source at all
- **Referrer policy:** `strict-origin-when-cross-origin`, because YouTube's player needs the page's origin.

**Theme.**
- The header uses the help center's colour, with black or white text, whichever contrasts better.
- Links use the colour only where it reaches 4.5:1 contrast, otherwise a dark green. In dark mode they use a lightened version.
- System, serif or rounded fonts; light and dark follow the visitor's setting.

**The portal as a section.** "Your requests" opens the phase 05 portal on the same host. The portal takes the help center's colour and links back with "Help center".

**Editor.**
- Help center settings gain "Who can read it" (everyone or signed-in customers).
- Article settings gain "FAQ article".
- Titles in the Knowledge list now use the teammate's language, and the help center's article picker uses the help center's default language. Before, both showed the alphabetically first language.
- "Settings saved." and "Address saved." no longer vanish when the record reloads after a save (an A1 bug).

## Flag, migration, seed

- **New flag `help_center_v1`**, off by default. The pages need both it and `knowledge_v1`.
- **Migration `db/postgres/0031_help_center_public.sql`** adds `help_centers.access` and `knowledge_records.faq`, and the flag. The rollback turns the flag off.
- **Local relay:** the flag is on, so the seeded help center is at `/help/demo/relay-help`.

## Tests

**`tests/help-site.test.ts`:**
- FAQ pairs, summaries and `Accept-Language` negotiation
- the acceptance criterion: an article published in English, French and German, each rendered with the right language, canonical, `hreflang` (including `x-default`), Open Graph and JSON-LD
- every article node in the renderer, with text escaped and the CSP hashes matching the styles
- the theme's contrast
- language fallback with canonical and notice, root negotiation, and the home page in French
- `301`s for a slug change and an unsupported region
- internal links by id
- FAQ structured data
- signed-in articles, without, with and with a wrong session
- the sitemap; `404`s, including archived collections; `405`; `ETag`, `304` and `HEAD`
- hidden from search engines; signed-in-only help centers
- custom domain: root, redirects, `robots.txt`, sitemap, the portal passing through, and no reaching another workspace
- portal theming and cross-workspace isolation

**`tests/browser/help-site.spec.ts`:**
- **Happy path (acceptance):**
  - in the editor: add German to the help center, write and publish an article in English, French and German, and place it in Billing
  - in a browser with scripts off: each language is rendered by the server with its own `lang`, title, canonical, `hreflang` and JSON-LD, and the language switcher works
  - a changed address gives a `301` to the new page
- **Failure path:**
  - a signed-in article gives a `401` sign-in page that doesn't name it, isn't listed, and an unknown page is a themed `404`
  - signing in through the portal (a signed link) opens it, `private, no-store`, and the portal links back to the help center

`tests/portal.test.ts` now expects the portal context's new `helpCenter` field.

## Notes

- **Playwright and `.tsx`.** Playwright compiles every `.tsx` file its test process loads with its own JSX runtime (for component tests), which React's server renderer rejects. `server/help-site.tsx` and `lib/rich-view.tsx` pin React's runtime with `/** @jsxImportSource react */`. Production and the Node tests weren't affected.
- **Worker bundle.** Bundling `workers/relay.ts` for Workers picks React's edge server build, with no Node-only modules. The unminified bundle is about 2 MB, including React's development builds, which a production build drops.
- **Browser caching after a slug change.** Someone who opened a page in the last minute may still see it at its old address until their cached copy expires. New visitors get the `301` straight away.
- **Deferred:**
  - search, feedback and the messenger's Help space: step B2
  - article images: step C1
  - the hosted subdomain and certificates: phase 17

## The one-off "Relay API failed", found

The full browser run logged "Relay API failed" three times, and the error diagnostics added in October pointed at `scripts/local-db.ts:91` (`SET ROLE`). All three came between one spec file's last test and the next file's first test. A request still being handled when the local relay shut down reached the embedded database after it closed. The local relay now refuses new requests once closing (`503`) and waits for in-flight ones before closing the database. Production isn't affected. Two full runs after the fix logged none.

## The scroll-back flake (phase 04 test)

One run after the teardown fix failed once in phase 04's scroll-back test (`agent-timeline.spec.ts`: "a failed older page shows an error…"): the older page wasn't requested after the test scrolled to the top.

**A real race, fixed.** The inbox decided whether to follow the newest message from a flag that changes only on scroll events, and browsers deliver those a frame late. A live update landing in that frame pulled a teammate who had just scrolled up back to the bottom. The timeline now also checks the reader's actual position against the content's previous height before following (`components/relay/postgres-inbox.tsx`).

**Not fully explained.**
- Stress runs after the fix: 119 of 120, then 60 of 60 for the test alone, then 120 of 120 with diagnostics that record the scroll position and older-history requests on failure.
- The rare remaining failure didn't happen while the diagnostics were in place, so its cause is unknown.
- The next full run passed 47/47.
- It's left open, with the diagnostic approach noted here.

## Checks

Results on 1 October 2026:
- `npm test`: 71/71 pass.
- `npm run typecheck`: clean.
- Lint shows nothing new on the changed files (only the older `isAgent` warning in `workers/relay.ts`).
- `npm run test:e2e`:
  - 47/47 before the teardown fix
  - 47/47 with no "Relay API failed" after it
  - then 46/47, with the scroll-back flake above
  - 47/47 again after the timeline fix, with no "Relay API failed"
