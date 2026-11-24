import { DomainError, type Sql } from "./db";

/**
 * A contact's custom data, as typed values (docs/PEOPLE_STEP1.md, phase 01 P1a).
 *
 * Each value is a row in `contact_attribute_values`, apart from its definition in
 * `attribute_definitions` (owner `contact`), in the one typed column the definition's type picks,
 * and indexed per type so segments can filter at scale. A definition's name is the value's key in
 * the API, the messenger and workflows.
 *
 * **This module is the only writer.** Every source — the API, workflows, merges and their
 * reversal — writes through `setContactAttributes` or `replaceContactAttributes`, which keep
 * `contacts.profile` in step as a plain object of the same values. `profile` stays readable for
 * one release, for what still reads it (the analytical snapshots, reports, workflow facts and
 * exports); segments, the inbox sidebar and the API read the typed store
 * (`contactAttributesJson`). A test fails if anything else writes `profile`.
 */
export type ValueType = "string" | "integer" | "float" | "boolean" | "date" | "options";
type Definition = { id: string; name: string; value_type: ValueType; options: string[] | null; archived_at: Date | null };
type Typed = { text_value: string | null; number_value: string | null; bool_value: boolean | null; date_value: string | null };

const KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const refuse = (key: string, message: string): never => {
  throw new DomainError("INVALID_FIELD", message, 400, { field: `custom_attributes.${key}` });
};

/** A value as JSON, from its typed columns `v` — the one place a typed value becomes its JSON form. */
const VALUE_JSON = `CASE WHEN v.text_value IS NOT NULL THEN to_jsonb(v.text_value)
  WHEN v.number_value IS NOT NULL THEN to_jsonb(trim_scale(v.number_value))
  WHEN v.bool_value IS NOT NULL THEN to_jsonb(v.bool_value)
  ELSE to_jsonb(to_char(v.date_value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END`;
/** A value as text, the way segments' text rules read it: a number as JavaScript writes it, a boolean as true or false. */
export const VALUE_TEXT = `COALESCE(v.text_value, trim_scale(v.number_value)::text, v.bool_value::text,
  to_char(v.date_value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;

/**
 * SQL for a contact's values as one object (`{name: value}`), for a contact row aliased `alias`.
 * Archived attributes are left out, as they are everywhere a value is read.
 */
export const contactAttributesJson = (alias: string) => `COALESCE((SELECT jsonb_object_agg(d.name, ${VALUE_JSON})
  FROM contact_attribute_values v JOIN attribute_definitions d ON d.workspace_id=v.workspace_id AND d.id=v.attribute_id
  WHERE v.workspace_id=${alias}.workspace_id AND v.contact_id=${alias}.id AND d.archived_at IS NULL),'{}'::jsonb)`;

/** The type a first value implies, for an attribute defined by being written (as the API and workflows may). */
function inferred(value: unknown): ValueType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "float";
  return "string";
}

/** A value checked and put in its typed column, or refused in words that name what was wrong. */
export function typedValue(def: Pick<Definition, "name" | "value_type" | "options">, value: unknown): Typed {
  const none: Typed = { text_value: null, number_value: null, bool_value: null, date_value: null };
  const key = def.name;
  switch (def.value_type) {
    case "string": {
      if (!["string", "number", "boolean"].includes(typeof value)) return refuse(key, `${key} is text: give a string, number or boolean.`);
      const s = String(value);
      if (s.length > 255) return refuse(key, `${key} is up to 255 characters.`);
      return { ...none, text_value: s };
    }
    case "options": {
      const s = typeof value === "string" ? value : "";
      if (!(def.options ?? []).includes(s)) return refuse(key, `${key} is one of: ${(def.options ?? []).join(", ")}.`);
      return { ...none, text_value: s };
    }
    case "integer":
    case "float": {
      const n = typeof value === "number" ? value : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
      if (!Number.isFinite(n)) return refuse(key, `${key} is a number.`);
      if (def.value_type === "integer" && !Number.isInteger(n)) return refuse(key, `${key} is a whole number.`);
      return { ...none, number_value: String(n) };
    }
    case "boolean": {
      const b = value === true || value === "true" ? true : value === false || value === "false" ? false : null;
      if (b === null) return refuse(key, `${key} is true or false.`);
      return { ...none, bool_value: b };
    }
    case "date": {
      // An ISO date or date-time, or Unix seconds (as Intercom's API sends dates).
      const t = typeof value === "number" ? value * 1000 : typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : NaN;
      if (!Number.isFinite(t)) return refuse(key, `${key} is a date (ISO 8601, or Unix seconds).`);
      return { ...none, date_value: new Date(t).toISOString() };
    }
  }
  return refuse(key, `${key} has a type Relay doesn't know.`);
}

async function definitionOf(db: Sql, w: string, key: string) {
  return (
    await db.query<Definition>(
      "SELECT id,name,value_type,options,archived_at FROM attribute_definitions WHERE workspace_id=$1 AND owner_type='contact' AND lower(name)=lower($2)",
      [w, key],
    )
  ).rows[0];
}

/**
 * Sets some of a contact's values; `null` clears one. A key with no definition is defined by its
 * first value when `define` is on (the API and workflows), and refused otherwise. An archived
 * attribute is refused: archived means nothing writes it any more.
 */
export async function setContactAttributes(db: Sql, w: string, contactId: string, values: Record<string, unknown>, opts: { define: boolean }) {
  for (const [key, raw] of Object.entries(values)) {
    if (!KEY.test(key)) refuse(key, "Names are letters, digits, dots, dashes and underscores, up to 64.");
    let def = await definitionOf(db, w, key);
    if (def?.archived_at) refuse(key, `${def.name} is archived, so nothing writes it any more.`);
    if (raw === null || raw === undefined) {
      if (def) await db.query("DELETE FROM contact_attribute_values WHERE workspace_id=$1 AND contact_id=$2 AND attribute_id=$3", [w, contactId, def.id]);
      continue;
    }
    if (!def) {
      if (!opts.define) refuse(key, `There's no customer attribute called ${key}.`);
      const id = crypto.randomUUID();
      await db.query("INSERT INTO attribute_definitions(workspace_id,id,name,owner_type,value_type) VALUES($1,$2,$3,'contact',$4)", [w, id, key, inferred(raw)]);
      def = (await definitionOf(db, w, key))!;
    }
    const t = typedValue(def, raw);
    await db.query(
      `INSERT INTO contact_attribute_values(workspace_id,contact_id,attribute_id,text_value,number_value,bool_value,date_value) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(workspace_id,contact_id,attribute_id) DO UPDATE SET text_value=excluded.text_value,number_value=excluded.number_value,
         bool_value=excluded.bool_value,date_value=excluded.date_value,updated_at=now()`,
      [w, contactId, def.id, t.text_value, t.number_value, t.bool_value, t.date_value],
    );
  }
  await syncProfile(db, w, contactId);
}

/** All of a contact's values replaced by `values` (a merge's reversal puts back what was there). */
export async function replaceContactAttributes(db: Sql, w: string, contactId: string, values: Record<string, unknown>) {
  await db.query("DELETE FROM contact_attribute_values WHERE workspace_id=$1 AND contact_id=$2", [w, contactId]);
  const scalars = Object.fromEntries(Object.entries(values ?? {}).filter(([k, v]) => KEY.test(k) && ["string", "number", "boolean"].includes(typeof v)));
  await setContactAttributes(db, w, contactId, scalars, { define: true });
}

/**
 * A merge's values: the survivor keeps its own, and gains the loser's where it has none (the
 * survivor's always win, false and 0 and empty text included). The loser keeps its rows, so a
 * reversal finds them as they were.
 */
export async function mergeContactAttributes(db: Sql, w: string, loserId: string, survivorId: string) {
  await db.query(
    `INSERT INTO contact_attribute_values(workspace_id,contact_id,attribute_id,text_value,number_value,bool_value,date_value)
     SELECT workspace_id,$3,attribute_id,text_value,number_value,bool_value,date_value FROM contact_attribute_values
     WHERE workspace_id=$1 AND contact_id=$2 ON CONFLICT DO NOTHING`,
    [w, loserId, survivorId],
  );
  await syncProfile(db, w, survivorId);
}

/** `contacts.profile` rewritten from the typed values: kept readable for one release (see above). */
async function syncProfile(db: Sql, w: string, contactId: string) {
  await db.query(`UPDATE contacts c SET profile=${contactAttributesJson("c")} WHERE c.workspace_id=$1 AND c.id=$2`, [w, contactId]);
}

/** Each contact's values (`{name: value}`), for several contacts at once. */
export async function readContactAttributes(db: Sql, w: string, contactIds: string[]) {
  const rows = (
    await db.query<{ id: string; values: Record<string, unknown> }>(`SELECT c.id,${contactAttributesJson("c")} AS values FROM contacts c WHERE c.workspace_id=$1 AND c.id=ANY($2::text[])`, [
      w,
      contactIds,
    ])
  ).rows;
  return Object.fromEntries(rows.map((r) => [r.id, r.values])) as Record<string, Record<string, unknown>>;
}
