import { assert, DomainError, type Sql } from "./db";
import { authorize } from "./policy";
import { requireSettings } from "./settings";

/**
 * Settings (S2b; docs/SETTINGS_STEP3.md): the workspace's tags and conversation attributes, for
 * those who can manage the workspace. Neither is ever deleted, because conversations, history
 * and reports point at them: both are archived instead.
 *
 * - An archived tag stays on the conversations that have it and keeps its name in their history;
 *   it can't be added again (it can still be removed), and pickers leave it out.
 * - An attribute's type is fixed once created, because stored values depend on it. A list's
 *   values are stored as the option text, so options can be added but never renamed or removed.
 */
export type TagRow = {
  id: string;
  name: string;
  archived: boolean;
  conversations: number;
};
export type AttributeRow = {
  id: string;
  name: string;
  valueType: ValueType;
  options: string[];
  archived: boolean;
  /** Ticket types that use it as a field. */
  ticketTypes: string[];
};
export const VALUE_TYPES = [
  "string",
  "integer",
  "float",
  "boolean",
  "date",
  "options",
] as const;
type ValueType = (typeof VALUE_TYPES)[number];
const MAX_OPTIONS = 100;

const invalid = (message: string): never => {
  throw new DomainError("INVALID_WORKSPACE_DATA", message, 400);
};
const label = (value: unknown, what: string, max: number) => {
  const v = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!v || v.length > max)
    invalid(`Give ${what} a name of up to ${max} characters.`);
  return v;
};
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40) || "item";
/** An id from the name, made unique in its table. */
async function newId(
  db: Sql,
  w: string,
  table: "tags" | "attribute_definitions",
  name: string,
) {
  const base = slug(name);
  const taken = (
    await db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND id=$2`, [
      w,
      base,
    ])
  ).rows.length;
  return taken ? `${base}_${crypto.randomUUID().slice(0, 6)}` : base;
}

export async function listTags(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "workspace.manage");
  await requireSettings(db, w);
  const tags = (
    await db.query<{
      id: string;
      name: string;
      archived: boolean;
      conversations: number;
    }>(
      `SELECT t.id,t.name,t.archived_at IS NOT NULL AS archived,
        (SELECT count(*) FROM conversation_tags c WHERE c.workspace_id=t.workspace_id AND c.tag_id=t.id)::int AS conversations
       FROM tags t WHERE t.workspace_id=$1 ORDER BY t.archived_at IS NOT NULL,lower(t.name),t.id`,
      [w],
    )
  ).rows;
  return { tags: tags satisfies TagRow[] };
}

/** Creates, renames, archives or restores a tag. Names are unique, ignoring case. */
export async function saveTag(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  await authorize(db, w, principal, "workspace.manage");
  await requireSettings(db, w);
  const existing =
    p.id === undefined
      ? null
      : (
          await db.query<{ id: string; name: string }>(
            "SELECT id,name FROM tags WHERE workspace_id=$1 AND id=$2",
            [w, String(p.id)],
          )
        ).rows[0];
  assert(
    p.id === undefined || existing,
    "TAG_NOT_FOUND",
    "Tag unavailable.",
    404,
  );
  if (p.action === "archive" || p.action === "restore") {
    assert(existing, "TAG_NOT_FOUND", "Tag unavailable.", 404);
    await db.query(
      `UPDATE tags SET archived_at=${p.action === "archive" ? "COALESCE(archived_at,now())" : "NULL"} WHERE workspace_id=$1 AND id=$2`,
      [w, existing.id],
    );
    return { id: existing.id };
  }
  const name = label(p.name, "the tag", 60);
  const clash = (
    await db.query<{ name: string }>(
      "SELECT name FROM tags WHERE workspace_id=$1 AND lower(name)=lower($2) AND id<>$3",
      [w, name, existing?.id ?? ""],
    )
  ).rows[0];
  assert(
    !clash,
    "TAG_EXISTS",
    `There's already a tag called “${clash?.name}”.`,
    409,
  );
  if (existing) {
    await db.query("UPDATE tags SET name=$3 WHERE workspace_id=$1 AND id=$2", [
      w,
      existing.id,
      name,
    ]);
    return { id: existing.id };
  }
  const id = await newId(db, w, "tags", name);
  await db.query("INSERT INTO tags(workspace_id,id,name) VALUES($1,$2,$3)", [
    w,
    id,
    name,
  ]);
  return { id };
}

export async function listAttributes(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "workspace.manage");
  await requireSettings(db, w);
  const rows = (
    await db.query<{
      id: string;
      name: string;
      value_type: ValueType;
      options: string[] | null;
      archived: boolean;
      ticket_types: string[];
    }>(
      `SELECT a.id,a.name,a.value_type,a.options,a.archived_at IS NOT NULL AS archived,
        COALESCE((SELECT array_agg(y.name ORDER BY y.name) FROM ticket_type_attributes f
          JOIN ticket_types y ON y.workspace_id=f.workspace_id AND y.id=f.type_id AND NOT y.archived
          WHERE f.workspace_id=a.workspace_id AND f.attribute_id=a.id),'{}') AS ticket_types
       FROM attribute_definitions a WHERE a.workspace_id=$1 AND a.owner_type='conversation'
       ORDER BY a.archived_at IS NOT NULL,lower(a.name),a.id`,
      [w],
    )
  ).rows;
  return {
    attributes: rows.map((a): AttributeRow => ({
      id: a.id,
      name: a.name,
      valueType: a.value_type,
      options: a.options ?? [],
      archived: a.archived,
      ticketTypes: a.ticket_types,
    })),
  };
}

const optionList = (value: unknown) => {
  if (!Array.isArray(value)) return invalid("Give the list its options.");
  const options = value.map((o) =>
    typeof o === "string" ? o.trim().replace(/\s+/g, " ") : "",
  );
  if (options.some((o) => !o || o.length > 100))
    invalid("Each option needs a name of up to 100 characters.");
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length)
    invalid("Each option can be listed once.");
  if (!options.length || options.length > MAX_OPTIONS)
    invalid(`Give the list between 1 and ${MAX_OPTIONS} options.`);
  return options;
};

/**
 * Creates, edits, archives or restores a conversation attribute. The type is set once, at
 * creation. Editing renames it and, for a list, adds options: every existing option must still
 * be there, in the same words, because conversations store the option's text.
 */
export async function saveAttribute(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  await authorize(db, w, principal, "workspace.manage");
  await requireSettings(db, w);
  const existing =
    p.id === undefined
      ? null
      : (
          await db.query<{
            id: string;
            value_type: ValueType;
            options: string[] | null;
          }>(
            "SELECT id,value_type,options FROM attribute_definitions WHERE workspace_id=$1 AND id=$2 AND owner_type='conversation'",
            [w, String(p.id)],
          )
        ).rows[0];
  assert(
    p.id === undefined || existing,
    "ATTRIBUTE_NOT_FOUND",
    "Attribute unavailable.",
    404,
  );
  if (p.action === "archive" || p.action === "restore") {
    assert(existing, "ATTRIBUTE_NOT_FOUND", "Attribute unavailable.", 404);
    await db.query(
      `UPDATE attribute_definitions SET archived_at=${p.action === "archive" ? "COALESCE(archived_at,now())" : "NULL"} WHERE workspace_id=$1 AND id=$2`,
      [w, existing.id],
    );
    return { id: existing.id };
  }
  const name = label(p.name, "the attribute", 80);
  const clash = (
    await db.query<{ name: string }>(
      "SELECT name FROM attribute_definitions WHERE workspace_id=$1 AND owner_type='conversation' AND lower(name)=lower($2) AND id<>$3",
      [w, name, existing?.id ?? ""],
    )
  ).rows[0];
  assert(
    !clash,
    "ATTRIBUTE_EXISTS",
    `There's already an attribute called “${clash?.name}”.`,
    409,
  );
  if (existing) {
    if (p.valueType !== undefined && p.valueType !== existing.value_type)
      invalid("An attribute's type can't change once it's created.");
    let options: string[] | null = null;
    if (existing.value_type === "options") {
      options = optionList(p.options);
      const kept = existing.options ?? [];
      assert(
        kept.every((o) => options!.includes(o)),
        "ATTRIBUTE_OPTION_REMOVED",
        "Options can be added, but not renamed or removed: conversations keep the option they were given.",
        409,
      );
      // The existing options keep their order; new ones follow.
      options = [...kept, ...options.filter((o) => !kept.includes(o))];
    }
    await db.query(
      "UPDATE attribute_definitions SET name=$3,options=$4 WHERE workspace_id=$1 AND id=$2",
      [w, existing.id, name, options === null ? null : JSON.stringify(options)],
    );
    return { id: existing.id };
  }
  if (!VALUE_TYPES.includes(p.valueType as ValueType))
    invalid("Choose the attribute's type.");
  const options = p.valueType === "options" ? optionList(p.options) : null;
  const id = await newId(db, w, "attribute_definitions", name);
  await db.query(
    "INSERT INTO attribute_definitions(workspace_id,id,name,owner_type,value_type,options) VALUES($1,$2,$3,'conversation',$4,$5)",
    [
      w,
      id,
      name,
      p.valueType,
      options === null ? null : JSON.stringify(options),
    ],
  );
  return { id };
}
