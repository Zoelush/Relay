import {
  attachCompany,
  COMPANY_SELECT,
  companiesOf,
  companyOut,
  deleteCompany,
  detachCompany,
  readCompany,
  updateCompany,
  upsertCompany,
  type CompanyInput,
  type CompanyRow,
} from "./companies";
import { tagCompany, tagContact, untagCompany, untagContact } from "./people-tags";
import {
  contactOut,
  CONTACT_SELECT,
  cursor,
  invalid,
  listOf,
  readContact,
  type ContactRow,
  type Context,
} from "./rest";

/**
 * The public API's companies (docs/PEOPLE_STEP2.md, phase 01 P1b). Every write goes through
 * `server/companies.ts`; a membership the API adds is marked as the API's.
 */
export const COMPANY_HANDLERS: Record<
  string,
  (x: Context) => Promise<unknown>
> = {
  async listCompanies(x) {
    const after = cursor.read<[string, string]>(x.params.starting_after);
    if (
      x.params.starting_after !== undefined &&
      !(Array.isArray(after) && after.length === 2)
    )
      throw invalid("starting_after", "That cursor isn't one of ours.");
    const values: unknown[] = [x.w];
    const where = ["co.workspace_id=$1"];
    if (x.params.company_id) {
      values.push(x.params.company_id);
      where.push(`co.company_id=$${values.length}`);
    }
    if (after) {
      values.push(after[0], after[1]);
      where.push(
        `(lower(co.name),co.id)>($${values.length - 1},$${values.length})`,
      );
    }
    const n = Number(x.params.per_page);
    const rows = (
      await x.db.query<CompanyRow>(
        `${COMPANY_SELECT} WHERE ${where.join(" AND ")} ORDER BY lower(co.name),co.id LIMIT ${n + 1}`,
        values,
      )
    ).rows;
    const page = rows.slice(0, n);
    return listOf(
      page.map(companyOut),
      rows.length > n
        ? [page.at(-1)!.name.toLowerCase(), page.at(-1)!.id]
        : null,
    );
  },
  async createCompany(x) {
    const { id } = await upsertCompany(x.db, x.w, x.body as CompanyInput);
    return readCompany(x.db, x.w, id);
  },
  getCompany: (x) => readCompany(x.db, x.w, String(x.params.id)),
  async updateCompany(x) {
    await updateCompany(x.db, x.w, String(x.params.id), x.body as CompanyInput);
    return readCompany(x.db, x.w, String(x.params.id));
  },
  deleteCompany: (x) => deleteCompany(x.db, x.w, String(x.params.id)),
  async listCompanyContacts(x) {
    const company = (await readCompany(x.db, x.w, String(x.params.id))).id;
    const after = cursor.read<string>(x.params.starting_after);
    if (x.params.starting_after !== undefined && typeof after !== "string")
      throw invalid("starting_after", "That cursor isn't one of ours.");
    const values: unknown[] = [x.w, company];
    if (after) values.push(after);
    const n = Number(x.params.per_page);
    const rows = (
      await x.db.query<ContactRow>(
        `${CONTACT_SELECT} WHERE c.workspace_id=$1 AND EXISTS(SELECT 1 FROM contact_companies m WHERE m.workspace_id=c.workspace_id AND m.contact_id=c.id AND m.company_id=$2)${after ? " AND c.id>$3" : ""} ORDER BY c.id LIMIT ${n + 1}`,
        values,
      )
    ).rows;
    const page = rows.slice(0, n);
    return listOf(
      page.map(contactOut),
      rows.length > n ? page.at(-1)!.id : null,
    );
  },
  async listContactCompanies(x) {
    const contact = (await readContact(x.db, x.w, String(x.params.id))).id;
    return listOf(
      (await companiesOf(x.db, x.w, [contact]))[contact].map(membershipOut),
      null,
    );
  },
  async attachContactToCompany(x) {
    const contact = (await readContact(x.db, x.w, String(x.params.id))).id;
    const company = String(x.body.company_id);
    await attachCompany(x.db, x.w, contact, company, x.body.role, "api");
    return membershipOut(
      (await companiesOf(x.db, x.w, [contact]))[contact].find(
        (m) => m.id === company,
      )!,
    );
  },
  // P1c: tags on contacts and companies, answered with the contact or company as it now is.
  async tagContact(x) {
    const contact = (await readContact(x.db, x.w, String(x.params.id))).id;
    await tagContact(x.db, x.w, contact, String(x.body.tag_id), "api");
    return readContact(x.db, x.w, contact);
  },
  async untagContact(x) {
    const contact = (await readContact(x.db, x.w, String(x.params.id))).id;
    await untagContact(x.db, x.w, contact, String(x.params.tag_id));
    return readContact(x.db, x.w, contact);
  },
  async tagCompany(x) {
    const company = (await readCompany(x.db, x.w, String(x.params.id))).id;
    await tagCompany(x.db, x.w, company, String(x.body.tag_id), "api");
    return readCompany(x.db, x.w, company);
  },
  async untagCompany(x) {
    const company = (await readCompany(x.db, x.w, String(x.params.id))).id;
    await untagCompany(x.db, x.w, company, String(x.params.tag_id));
    return readCompany(x.db, x.w, company);
  },
  async detachContactFromCompany(x) {
    const contact = (await readContact(x.db, x.w, String(x.params.id))).id;
    await detachCompany(x.db, x.w, contact, String(x.params.company_id));
    return {
      id: contact,
      company_id: String(x.params.company_id),
      detached: true,
    };
  },
};

/** A membership in the API's shape: the company, and the contact's role there. (Whether the portal trusts it is Relay's business.) */
function membershipOut(
  m: Awaited<ReturnType<typeof companiesOf>>[string][number],
) {
  const rest: Partial<typeof m> = { ...m };
  delete rest.trusted;
  return rest;
}
