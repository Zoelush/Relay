# Finishing phase 01, P1b: companies

Branch `feature/people-companies`. Plan: `docs/PEOPLE_PLAN.md` (decisions 5 to 8, of 25 November
2026). Migration `0108_companies.sql`.

## What changed

A workspace has **companies** now: a company has your id for it (`company_id`, unique per
workspace), a name, a plan, seats, monthly spend, a website, and typed custom data. Routing and
reports will segment on plan, seats and spend, so they are columns of their own. A company's custom
data is typed exactly as a contact's is since P1a: a row per company and attribute in
`company_attribute_values`, in the one column its definition (owner `company`) picks, indexed per
type. `server/contact-attributes.ts` writes both, so every typed value still has one writer.

A contact can be in **many companies, with a role in each** (`contact_companies`). Each membership
records who added it: the API, a teammate in the inbox, the messenger, or a merge.

## Who sets a person's companies (decisions 3 and 6)

- **The API**, always: `POST /companies` creates a company or, if one has that `company_id`,
  updates it, so retries and syncs are safe; `PATCH`, `GET` and `DELETE /companies/{id}`;
  `GET /companies/{id}/contacts`; and `GET`, `POST /contacts/{id}/companies` and
  `DELETE /contacts/{id}/companies/{company_id}` for memberships.
- **Teammates**, in the inbox's details panel: add the customer to a company (found by name, or
  made new), change their role there, or take them out. They need permission to see personal data,
  as for the rest of that panel.
- **The messenger, only for a verified user, only through the signed identity token, and only while
  the workspace allows it.** A JWT may carry a `companies` claim, up to 10 entries of
  `{company_id, name?, role?}`: each company is found by its id, or made with the name given, and
  the user joins those they aren't in. Nothing else about a company is set from the messenger, and
  nobody is taken out of one. A legacy HMAC proof doesn't sign such a claim, so it can never set
  companies, and nor can an unsigned field. The switch is Settings › Messenger › Security ›
  *Companies from the messenger*, off by default, saved at once and in the audit log.

## Merges

A merge gives the survivor the loser's companies it isn't in (marked as the merge's, or the
messenger's if the messenger added them) and records which. Reversing the merge takes exactly those
away again.

## Deleting a company (decision 8)

A company can be deleted: its memberships and custom data go with it, the people stay, and the
deletion is in the audit log (*Company deleted*, with how many people were in it). A company isn't
personal data, so erasing a person takes their memberships and leaves the companies.

## Webhooks

The database writes `company.created`, `company.updated` (any change, custom data included),
`company.deleted` (with only the id, `company_id` and name, since it's gone),
`company.contact_attached` (with `data.contact_id` and `data.role`) and `company.contact_detached`.
Deleting a company sends one `company.deleted`, not a detached event for each person.

## The portal's company visibility (decision 7)

The portal's "everyone at their company" setting (and a ticket type's own choice of it) works now.
A signed-in customer sees the requests of people who share a company with them, each marked with
whose it is, and can read them but not reply. A membership counts only if the portal can trust it:
one the API, a teammate or a merge added, or one the messenger added **while the workspace still
allows the messenger to set companies**. Turning that off stops the messenger's memberships
counting at once, both ways.

## Checks

- **`tests/companies.test.ts`:** the writer (by `company_id`, typed, refused in words); the API
  (create or update, list, page, patch, a taken `company_id` refused, memberships, deleting with
  its audit entry); the webhooks written (and none per person on deletion); a merge and its
  reversal; the messenger claim ignored while off, applied while on, a malformed entry skipped,
  never from HMAC, and the setting audited; the portal showing colleagues' requests only with
  company visibility and only through trusted memberships, read but never replied to; the sidebar
  showing companies and a teammate changing them, refused to a role that may not see personal data;
  erasure; another workspace seeing nothing; and nothing but the two writers writing companies,
  memberships or company values.
- **`tests/browser/companies.spec.ts`:** a company with its plan, seats, spend and custom data in
  the sidebar; a teammate making a new company from the picker, changing a role and taking the
  customer out of one; a company deleted while the picker shows it refused in words with nothing
  changed; and the messenger switch off by default, then on.
- **`tests/browser/portal.spec.ts`:** a colleague's request shown in the portal with whose it is,
  read without a reply box; with individual visibility, gone and its address showing nothing.
- **Updated:** `tests/webhooks.test.ts` (company topics), `tests/portal.test.ts` (the setting's
  notice), the route-policy table, the erasure and copy registries.
- **Typecheck, eslint, `npm test`, `npm run test:postgres`, `npm run test:e2e`.**

## What's next

**P1c:** tags on contacts and companies, in the same namespace as conversations', with
`contact.tagged`.
