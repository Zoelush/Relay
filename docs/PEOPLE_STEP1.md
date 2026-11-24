# Finishing phase 01, P1a: a contact's custom data as typed values

Branch `feature/people-values`. Plan: `docs/PEOPLE_PLAN.md` (decisions of 24 November 2026).
Migration `0107_contact_values.sql`.

## What changed

A contact's custom data used to be an untyped JSON object, `contacts.profile`. It is now a row per
contact and attribute in `contact_attribute_values`, apart from its definition in
`attribute_definitions` (owner `contact`), in the one typed column the definition picks — text for
string and options, number for integer and float, then boolean and date — and indexed per type so
P2's segments can filter at scale. A definition's name is the value's key in the API, the messenger
and workflows, unique per workspace whatever its case.

## The migration

Every key that was in `profile` became a defined attribute, its type inferred from what it held:
all booleans → boolean, all whole numbers → integer, all numbers → float, anything else (mixed
types included) → text. Keys differing only in case became one attribute. Every value was copied
into its typed column. The backfill is a function, `relay_backfill_contact_values()`, so it can be
run again; `tests/segments.test.ts` runs it over a deliberately messy corpus written the old way.

The API only ever accepted strings (up to 255), numbers, booleans and null, so nothing it wrote is
lost. A key that mixed numbers and text (`seats: 12` on one person, `"many"` on another) is text
now, so a "greater than" rule on it no longer matches — the decided price of typing mixed data.

## One writer

`server/contact-attributes.ts` is the only thing that writes custom data, for every source:

- **the API** (`POST` and `PATCH /contacts`): a key with no definition is defined by its first
  value; a value that doesn't fit its type is refused, naming the attribute
  (`custom_attributes.seats`); `null` clears one;
- **workflows** (the set-attribute step), the same way;
- **merges:** the survivor keeps its own values — false, 0 and empty text included — and gains the
  loser's where it has none; the loser keeps its rows;
- **a merge's reversal** puts the survivor's values back exactly as they were.

It keeps `contacts.profile` in step as a plain object of the same values, for one release, for what
still reads it: the analytical snapshots, reports, workflow facts and exports. Segments, the inbox
sidebar and the API read the typed store (`contactAttributesJson`). An archived attribute is neither
written nor read. `tests/contact-attributes.test.ts` fails if anything else writes `profile`; it
found the local demo's seed, which now writes through the writer too.

## The sidebar

The inbox sidebar fetched a customer's custom data and never showed it. Its Customer section now
lists each attribute with its value (a yes-or-no as Yes or No), for teammates who may see personal
data, as with their name and email.

## Checks

- **`tests/contact-attributes.test.ts`:** each type's fit and refusal; defining by a first value;
  a refusal naming the field; a key in another case being the same attribute; null clearing;
  `profile` kept in step; archived neither written nor read; the API writing and reading typed
  values; the sidebar showing them; another workspace seeing none; and nothing else writing
  `profile`.
- **`tests/segments.test.ts`:** the backfill run over the corpus, the inferred types asserted, and
  every rule — a numeric range and text matching on former numbers included — agreeing in SQL and
  in code.
- **`tests/people.test.ts`:** the merge precedence and its reversal, through the writer.
- **`tests/browser/contact-attributes.spec.ts`:** a customer's typed attributes in the sidebar; a
  mistyped update refused with the attribute named, and the sidebar unchanged.
- **Typecheck, eslint, `npm test`, `npm run test:postgres`, `npm run test:e2e`.**

## What's next

**P1b:** companies, with typed attributes from the start, and tags on contacts and companies.
