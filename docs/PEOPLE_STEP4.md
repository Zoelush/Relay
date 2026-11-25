# Finishing phase 01, P2a: segments with groups, tags and companies

Branch `feature/people-segments`. Plan: `docs/PEOPLE_PLAN.md` (decisions 11 to 14, of 25 November
2026). Migration `0110_segment_targets.sql`.

## What changed

Segments (`lib/segments.ts`, compiled to SQL by `server/segments.ts`; the two held to one meaning by
the corpus test) can now say much more:

- **Groups.** A definition's rules may be groups of their own, each matching all or any of its
  rules, 3 deep at most (counting the definition) and 20 conditions in all. Rules are numbered in
  reading order, however they're grouped, so "Rule 3" in an error is the third on the page. A group
  with no rules is refused in words.
- **Tags.** A person has a tag, or hasn't.
- **Companies on a person.** `company.<field>` — name, company ID, plan, seats, monthly spend,
  people, created, a company attribute, a company tag — matches when **any one** of their
  companies matches it, negative rules included (decision 12: someone at a Pro and a Free company
  matches "company plan is not Pro"). Someone in no company never matches a company rule; "Company
  membership: in no company" is its own rule.
- **Segments of companies** (decision 13). A segment is made of people or of companies (the new
  `segments.target`, people for every existing one). Company segments use the same company rules,
  on each company; there's a predefined *All companies*. A company's numbers (seats, spend, people)
  never match "greater/less than" when unset, as attributes don't.

## Where

- **People** has a People / Companies switch. Each shows its own segments; the rules editor nests
  groups (Add group, each with its own all/any and its own Add rule), offers tag and company rules,
  and Companies lists name, plan, seats, monthly spend and people.
- **Outbound audiences** use the same grouped editor, with tag and company rules. A company segment
  is never offered as an audience, and publishing with one is refused ("Its segment is of
  companies"). The editor's attribute list now comes from the defined attributes, no longer from
  the keys found in `contacts.profile`.
- **The API:** `GET /segments` says what each is of (`of`: contacts or companies);
  `GET /segments/{id}/companies` lists a company segment's companies; a people segment has no
  companies, and the reverse, each answered 404 in words.

## Membership for one person, cheaply

`inSegment` answers whether one person is in a segment with one indexed query (the brief's
"evaluate membership for a single contact cheaply", which targeting calls on every message), and
outbound's per-person check uses it now instead of loading every fact and evaluating in code. A
person merged into another is in no segment; the one they joined is.

## A count fixed on the way

A company's people count (in the API's `contact_count`, the sidebar and company rules) counted
contacts since merged into another, because a merge leaves the loser's memberships for its reversal
to find. It now counts live contacts only (`companyPeopleSql`).

## Checks

- **`tests/segments.test.ts`:** groups' limits and numbering, tag and company rules accepted, a
  person's rule refused on companies and the reverse; the corpus now has tags on people and six
  companies (typed data, tags, 0 to 2 per person), every new rule and 30 grouped definitions
  agreeing in SQL and in code for people, and 30 more for company segments; decision 12 shown on one
  person.
- **`tests/segments-companies.test.ts`:** a company segment listed, refused a person's rule, saved
  with its target (kept on re-save), counted with *All companies*; grouped tag-or-company rules on
  people; "in no company"; the single-person check agreeing and ignoring a merged-away person; the
  API's listings and its refusals; outbound not offering a company segment and refusing one, and
  publishing grouped tag and company rules; another workspace's segments.
- **`tests/browser/segments-groups.spec.ts`:** a group of a tag rule and a company rule counted
  live (any, then all, then any), saved; a segment of Pro companies saved under Companies and not
  under People; a group left empty refused in words and not saved.
- **Updated:** `tests/outbound.test.ts` (custom objects are what's still refused).
- **Typecheck, eslint, `npm test`, `npm run test:postgres`, `npm run test:e2e`.**

## What's next

**P2b:** 50,000 contacts, 5,000 companies, 20 attributes and 2 million events on real PostgreSQL
17, in `npm run test:postgres`: the brief's segment's plan printed and its time held under 500 ms,
with whatever index or compiler work that shows is needed.
