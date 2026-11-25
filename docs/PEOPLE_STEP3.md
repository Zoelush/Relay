# Finishing phase 01, P1c: tags on people

Branch `feature/people-tags`. Plan: `docs/PEOPLE_PLAN.md` (decisions 9 and 10). Migration
`0109_people_tags.sql`.

## What changed

Contacts and companies can be **tagged**, from the same tags as conversations (Settings › Tags):
one namespace, so "VIP" means the same on a person, their company and their conversations.
`contact_tags` and `company_tags` link them, each indexed by tag for P2's segments. A contact's tag
records who added it: the API, a teammate in the inbox, or a merge.

`server/people-tags.ts` is the only writer; a test fails on another.

## Defaults (decisions 9 and 10, taken as the obvious ones)

9. **Tags on people come from the API and teammates,** not from the messenger, as with companies'
   attributes.
10. **An archived tag behaves as it does on conversations:** it stays where it is and can be taken
    off, but isn't put on again, and the pickers leave it out.

## Where

- **The API:** `POST /contacts/{id}/tags` and `DELETE /contacts/{id}/tags/{tag_id}`, and the same
  for `/companies/{id}/tags`, answered with the contact or company as it now is. Contacts and
  companies carry a `tags` array now, everywhere the API shows them (webhooks included). The scope
  is `contacts.personal_data`, as for the rest of a person's data.
- **The inbox:** the details panel shows the customer's tags under their details, and each
  company's on its card, with a button to take one off and a picker to put one on, for teammates who
  may see personal data.
- **Webhooks:** `contact.tagged`, `contact.untagged`, `company.tagged` and `company.untagged`, each
  with `data.tag`. Deleting a company sends its one `company.deleted`, not an untagged per tag.

## Merges, deletion, erasure

A merge gives the survivor the loser's tags (marked as the merge's) and records which; its reversal
takes exactly those off. A deleted company's tags go with it. Erasing a person takes their tags;
the tags themselves stay.

## A bug the test found

The first run showed a deleted company sending an untagged event per tag: P1b's delete cleared its
"being deleted" marker before the tags went. The tags now go while the marker is set.

## Checks

- **`tests/people-tags.test.ts`:** the API tagging contacts and companies (again changes nothing;
  archived refused; unknown is 404; an archived tag already on someone taken off); the webhooks; the
  inbox's picker leaving archived tags out, a teammate tagging a customer and their company, the
  sidebar showing both, refused to and hidden from a role that may not see personal data; a deleted
  company's tags going without an event each; a merge and its reversal; erasure; another workspace
  seeing none; one writer.
- **`tests/browser/people-tags.spec.ts`:** a tag from the API in the sidebar; a teammate tagging
  the customer and their company and taking a tag off; a tag archived while the picker shows it
  refused in words, with nothing changed.
- **Updated:** `tests/webhooks.test.ts` (the new topics), the route-policy table, and the erasure
  and copy registries.
- **Typecheck, eslint, `npm test`, `npm run test:postgres`, `npm run test:e2e`.**

## What's next

**P2:** nested and/or segments with tags and company filters on people, segments over companies,
and the 50,000-contact acceptance run.
