/**
 * SQL for a contact's or a company's tags (phase 01 P1c), as a JSON array of `{type, id, name}`.
 * Kept free of imports: `CONTACT_SELECT` and `COMPANY_SELECT` are built from it when their modules
 * load, and the people modules import one another.
 */
const tagsJson = (table: "contact_tags" | "company_tags", column: string, alias: string) => `COALESCE((SELECT jsonb_agg(jsonb_build_object('type','tag','id',t.id,'name',t.name) ORDER BY lower(t.name),t.id)
  FROM ${table} x JOIN tags t ON t.workspace_id=x.workspace_id AND t.id=x.tag_id
  WHERE x.workspace_id=${alias}.workspace_id AND x.${column}=${alias}.id),'[]'::jsonb)`;
export const contactTagsJson = (alias: string) => tagsJson("contact_tags", "contact_id", alias);
export const companyTagsJson = (alias: string) => tagsJson("company_tags", "company_id", alias);
