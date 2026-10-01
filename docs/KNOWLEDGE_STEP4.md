# Phase 07, step B2: search and feedback

Branch `phase-07/step-b2`. Plan: `docs/KNOWLEDGE_PLAN.md`. Approved on 1 October 2026:
- PostgreSQL full-text search with trigram matching (vector search joins in C2)
- the query log and feedback in the primary database, with searches kept for 180 days and personal details removed
- "Talk to us" from the messenger, and from the public help center for signed-in customers
- signed receipts for "search before contacting"

## What it does

**Search** (`server/help-search.ts`). A `knowledge_search` row per published record and language, updated when a language is published, unpublished or archived:
- **Language:** each language uses its own PostgreSQL stemming (29 languages; anything else uses a plain configuration).
- **Accents:** removed before indexing and before searching, so "reinitialiser" finds "Réinitialiser".
- **Typos:** trigram matching on words of four letters or more, so "pasword" finds "password" and "geting startd" finds "Getting started".
- **Ranking:** title matches first, then text matches, then typo closeness.
- **Visibility:** only articles placed in the help center's live collections and sections, with the help center switch on and published. Articles for signed-in customers are included only for a signed-in customer.
- **Language chain:** matches in any language along the visitor's chain count, and each article appears once, in the first language along the chain (a French visitor who types an English word still gets the French article).
- **Personal details:** email addresses and long numbers in a query are not searched for.

**The public help center** (`server/help-site.tsx`):
- **Search pages:**
  - a search box in every header and in the homepage "search" block
  - a server-rendered results page at `{center}/{locale}/search?q=` that works without JavaScript
  - result links go through `…/search/open`, which records which result the search led to
  - search pages are `noindex` and never cached, and switching language keeps the search
- **Feedback:** "Was this helpful? Yes / No" under every article, as plain forms (a POST to `…/articles/{slug}/feedback`, then a `303` back to `#feedback`).
- **After "No":** an optional comment, then "Send" or "Send and talk to us".
- **"Talk to us":**
  - **signed-in customer** (the portal session): starts a conversation with their comment, or "I read … and still need help", and lands on it in the portal; a repeated post doesn't start a second one
  - **anyone else:** told to use the chat on the brand's site or sign in
- **Protection:** cross-site posts are refused (`Origin` / `Sec-Fetch-Site`), and the CSP now allows forms to this help center only (`form-action 'self'`).

**The messenger's Help space** (`messenger/help.tsx`, `server/help-messenger.ts`), shown when the brand has a help center:
- **Browse and search:** collections, search, and articles. Videos open in a new tab, because the messenger frame allows no third-party frames.
- **Feedback and "Talk to us":** a vote, the comment after "No", and "Talk to us", which opens a new conversation with the comment already in the message box.
- **Signed in:** a verified customer counts as signed in.
- **API routes:** `GET /v1/messenger/help`, `/help/collection`, `/help/article` and `/help/search`, and `POST /v1/messenger/help/feedback`.

**What the teammate sees.**
- A conversation started after searching, or from "Talk to us", begins with a teammate-only event: "Customer searched the help center for “…”" or "Customer read “…” and said it didn't help".
- It's an internal `system_event` (`help_context`), never delivered to the customer.
- The help context is rebuilt by the server from a verified receipt and an article the customer may read. Anything a client sends as `helpContext` is ignored.

**"Search before contacting"** (the brand's `requireSearch`, which until now blocked starting outright):
- **Receipts:** each messenger search returns a receipt, signed with HMAC-SHA256 from the session secret and bound to the workspace, brand, customer and query, valid for 30 minutes.
- **Starting a conversation** needs a valid receipt, or coming from an article through "Talk to us". Someone else's receipt, an expired one or a forged one is refused (`HELP_SEARCH_REQUIRED`).
- The messenger enables "Start a conversation" once the customer has searched.

**The query log** (`help_search_queries`):
- **What's kept:** the query with email addresses and long numbers replaced (`[email]`, `[number]`), the language, the surface, the number of results and the result opened.
- **Retention:** deleted after 180 days by the daily clean-up that also handles drafts.

**Reports for the content team:**
- In Knowledge, the **Help centers tab** has "Search and feedback, last 30 days": totals, searches with no results, searches where no result was opened, and the articles most often marked "not helpful" (`GET /v1/agent/help-insights`).
- **Each article's editor** shows its votes and latest comments.

## Migration

`db/postgres/0032_help_search.sql` is additive:
- the `pg_trgm` extension (the embedded test database loads it; hosted PostgreSQL has it built in)
- the tables `knowledge_search`, `help_search_queries` and `knowledge_feedback`, with row-level security
- GIN indexes for text search and trigrams

The rollback is a no-op. The local relay re-indexes its seeded articles on start, because they're inserted without publishing.

## Tests

**`tests/help-search.test.ts`:**
- normalising, redaction, language configurations, and receipts (valid, another customer, brand or workspace, another key, expired, forged, malformed)
- ranking, typos, stemming (English, French, German), accents, the language chain, and visibility (not placed, switched off, signed-in only, archived, unpublished and republished)
- personal details left out of searches and the log
- the public search page, the result-opened redirect, the no-results page and the search box
- feedback: votes, a comment after "No" only once, "Talk to us" with and without a portal session, a repeated post, and cross-site posts refused
- the editor's feedback summary and the report, including other workspaces refused
- 180-day retention
- the messenger: browse, search with receipt, read and signed-in articles, feedback, and "search before contacting" (refused without a receipt, with someone else's, or with client-supplied context; allowed after searching or from an article)
- the internal help event, never in the customer's history
- linking only your own feedback
- cross-workspace isolation

**`tests/browser/help-search.spec.ts`:**
- **Happy path:**
  - in the messenger: browse, search with a typo, read, "No" with a comment, "Talk to us" (prefilled), send
  - the inbox shows "Customer read … and said it didn't help"
  - the search is logged and the editor shows the comment
  - on the public help center with scripts off: search with a typo, open the result, vote
- **Failure path:**
  - with "search before contacting" on, there's no way to start until the customer searches
  - a search with no results still counts; the teammate sees what was searched; the report lists the search

`npm run test:postgres` also passes, so the extension works on real PostgreSQL 17.

## Found while checking in the browser

- **Messenger contrast and layout:**
  - result titles were dark green on the dark theme
  - "Back" fell back to the browser's default button
  - the article title was smaller than its own section headings
  - "Talk to us" picked up the full-width start button style
  - the start button touched the Help space content

  All were fixed, using the messenger's own theme variables.
- **Messenger behaviour:** "Talk to us" now prefills the message with what the customer said they were looking for.
- **Public search page:** the language switcher dropped the query; it now keeps it.

## Notes

- **Deferred:**
  - **Search in the messenger and help center is a single list of up to 20 (help center) or 10 (messenger) results.** Paging can come with C2's ranking work.
  - **Links between articles** read as plain text inside the messenger (they work on the public help center).
  - **The messenger's search receipt lives only in the open messenger.** Reloading the page means searching again before starting.
- **Abuse:** votes on the public help center aren't limited per visitor. A rate limit can come with phase 14's analytics if needed.
- **Preview port clash:** the preview relay was briefly on ports 8798/8799, which the messenger browser test uses, and one suite run failed to start that test. It now runs on 8828/8829, and the rerun passed 49/49.

## Checks

Results on 1 October 2026:
- `npm test`: 73/73 pass.
- `npm run typecheck`: clean.
- Lint shows nothing new (only the older `isAgent` warning in `workers/relay.ts`).
- `npm run test:e2e`: 49/49, with no "Relay API failed".
- `npm run test:postgres`: passes.
