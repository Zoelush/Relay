import { assert, DomainError, once, type Sql } from "./db";
import { authorize } from "./policy";
import { resolveContact } from "./people";

/**
 * Tags on people (docs/PEOPLE_STEP3.md, phase 01 P1c): contacts and companies tagged from the same
 * tags as conversations, by the API and by teammates in the inbox.
 *
 * As on conversations, an archived tag stays where it is and can be taken off, but isn't put on
 * again. A merge gives the survivor the loser's tags (recorded, so its reversal takes exactly those
 * away). This module is the only writer of `contact_tags` and `company_tags`; a test fails on
 * another.
 */
export type TagSource = "api" | "inbox" | "merge";
export type PersonTag = { id: string; name: string; archived: boolean };


async function tagFor(db: Sql, w: string, tagId: string, adding: boolean) {
  const tag = (await db.query<{ id: string; archived: boolean }>("SELECT id,archived_at IS NOT NULL AS archived FROM tags WHERE workspace_id=$1 AND id=$2", [w, tagId])).rows[0];
  assert(tag, "NOT_FOUND", "No such tag.", 404);
  if (adding && tag.archived) throw new DomainError("TAG_ARCHIVED", "That tag is archived, so it isn't added any more.", 400, { field: "tag_id" });
  return tag;
}

/** A contact tagged (again is fine: who added it first stays). */
export async function tagContact(db: Sql, w: string, contactId: string, tagId: string, source: TagSource) {
  await tagFor(db, w, tagId, true);
  await db.query("INSERT INTO contact_tags(workspace_id,contact_id,tag_id,source) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [w, contactId, tagId, source]);
}
/** A tag taken off a contact. */
export async function untagContact(db: Sql, w: string, contactId: string, tagId: string) {
  await tagFor(db, w, tagId, false);
  const gone = (await db.query("DELETE FROM contact_tags WHERE workspace_id=$1 AND contact_id=$2 AND tag_id=$3 RETURNING tag_id", [w, contactId, tagId])).rows.length;
  assert(gone, "NOT_FOUND", "That contact doesn't have that tag.", 404);
}
/** A company tagged. */
export async function tagCompany(db: Sql, w: string, companyId: string, tagId: string, source: Exclude<TagSource, "merge">) {
  await tagFor(db, w, tagId, true);
  assert((await db.query("SELECT 1 FROM companies WHERE workspace_id=$1 AND id=$2", [w, companyId])).rows.length, "NOT_FOUND", "No such company.", 404);
  await db.query("INSERT INTO company_tags(workspace_id,company_id,tag_id,source) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [w, companyId, tagId, source]);
}
/** A tag taken off a company. */
export async function untagCompany(db: Sql, w: string, companyId: string, tagId: string) {
  await tagFor(db, w, tagId, false);
  const gone = (await db.query("DELETE FROM company_tags WHERE workspace_id=$1 AND company_id=$2 AND tag_id=$3 RETURNING tag_id", [w, companyId, tagId])).rows.length;
  assert(gone, "NOT_FOUND", "That company doesn't have that tag.", 404);
}
/** A company's tags go with it when it's deleted (`server/companies.ts`). */
export async function deleteCompanyTags(db: Sql, w: string, companyId: string) {
  await db.query("DELETE FROM company_tags WHERE workspace_id=$1 AND company_id=$2", [w, companyId]);
}

/** A merge's tags: the survivor gains the loser's; returns those added, for the reversal. */
export async function mergeTags(db: Sql, w: string, loserId: string, survivorId: string) {
  return (
    await db.query<{ tag_id: string }>(
      `INSERT INTO contact_tags(workspace_id,contact_id,tag_id,source) SELECT workspace_id,$3,tag_id,'merge' FROM contact_tags WHERE workspace_id=$1 AND contact_id=$2
       ON CONFLICT DO NOTHING RETURNING tag_id`,
      [w, loserId, survivorId],
    )
  ).rows.map((r) => r.tag_id);
}
/** A merge reversed: the tags it gave the survivor taken off again. */
export async function unmergeTags(db: Sql, w: string, survivorId: string, added: string[] | undefined) {
  if (added?.length) await db.query("DELETE FROM contact_tags WHERE workspace_id=$1 AND contact_id=$2 AND tag_id=ANY($3::text[])", [w, survivorId, added]);
}

/** Each contact's (or company's) tags, archived ones marked, for several at once. */
async function tagsOf(db: Sql, w: string, table: "contact_tags" | "company_tags", column: string, ids: string[]) {
  const rows = (
    await db.query<{ owner: string } & PersonTag>(
      `SELECT x.${column} AS owner,t.id,t.name,t.archived_at IS NOT NULL AS archived FROM ${table} x JOIN tags t ON t.workspace_id=x.workspace_id AND t.id=x.tag_id
       WHERE x.workspace_id=$1 AND x.${column}=ANY($2::text[]) ORDER BY lower(t.name),t.id`,
      [w, ids],
    )
  ).rows;
  const out: Record<string, PersonTag[]> = Object.fromEntries(ids.map((id) => [id, []]));
  for (const r of rows) out[r.owner].push({ id: r.id, name: r.name, archived: r.archived });
  return out;
}
export const contactTagsOf = (db: Sql, w: string, ids: string[]) => tagsOf(db, w, "contact_tags", "contact_id", ids);
export const companyTagsOf = (db: Sql, w: string, ids: string[]) => tagsOf(db, w, "company_tags", "company_id", ids);

/* ------------------------------------------------------------------------------------------ */
/* The inbox                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** The tags a teammate can put on a person or company (archived ones left out). */
export async function readPeopleTags(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "contacts.personal_data");
  return {
    tags: (await db.query<{ id: string; name: string }>("SELECT id,name FROM tags WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY lower(name),id", [w])).rows,
  };
}

/** A teammate tags a customer or one of their companies, or takes a tag off; returns that one's tags. */
export async function changePeopleTags(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>) {
  await authorize(db, w, principal, "contacts.personal_data");
  return once(db, w, "people-tags:" + principal, key, p, async () => {
    const tagId = String(p.tagId ?? "");
    if (p.companyId) {
      const companyId = String(p.companyId);
      if (p.action === "add") await tagCompany(db, w, companyId, tagId, "inbox");
      else if (p.action === "remove") await untagCompany(db, w, companyId, tagId);
      else throw new DomainError("INVALID_REQUEST", "Choose add or remove.", 400);
      return { tags: (await companyTagsOf(db, w, [companyId]))[companyId] };
    }
    const contactId = await resolveContact(db, w, String(p.contactId ?? ""));
    if (p.action === "add") await tagContact(db, w, contactId, tagId, "inbox");
    else if (p.action === "remove") await untagContact(db, w, contactId, tagId);
    else throw new DomainError("INVALID_REQUEST", "Choose add or remove.", 400);
    return { tags: (await contactTagsOf(db, w, [contactId]))[contactId] };
  });
}
