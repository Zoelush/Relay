/**
 * The API's search grammar (phase 15, D2; docs/API.md › Search): a query is a condition
 * `{field, operator, value}` or a group `{operator: "AND"|"OR", value: [queries]}`, up to 3 groups
 * deep and 20 conditions. Each resource has its fields, each field a type, and each type its
 * operators. A query compiles to SQL over a fixed alias with every value as a parameter, never
 * spliced in; every refusal names its place in the query (`query.value[1].operator`).
 */
export type FieldType = "string" | "number" | "time" | "boolean" | "enum";
export type Field = { type: FieldType; sql: string; values?: readonly string[]; sortable?: boolean; about: string };
export const OPERATORS: Record<FieldType, readonly string[]> = {
  string: ["=", "!=", "IN", "NIN", "~", "!~", "^", "$"],
  enum: ["=", "!=", "IN", "NIN"],
  number: ["=", "!=", "<", ">", "<=", ">="],
  time: ["=", "!=", "<", ">", "<=", ">="],
  boolean: ["=", "!="],
};
export const OPERATOR_MEANING: Record<string, string> = {
  "=": "equals",
  "!=": "doesn't equal",
  IN: "is one of (a list)",
  NIN: "is none of (a list)",
  "~": "contains",
  "!~": "doesn't contain",
  "^": "starts with",
  $: "ends with",
  "<": "is before / less than",
  ">": "is after / more than",
  "<=": "at or before / at most",
  ">=": "at or after / at least",
};

/** Conversations: `c` is the conversation. */
export const CONVERSATION_FIELDS: Record<string, Field> = {
  id: { type: "string", sql: "c.id", about: "Its id." },
  status: { type: "enum", sql: "c.status", values: ["open", "snoozed", "closed"], about: "open, snoozed or closed." },
  channel: { type: "string", sql: "c.channel", about: "messenger, email, whatsapp, sms, …" },
  brand_id: { type: "string", sql: "c.brand_id", about: "Its brand." },
  assignee_id: { type: "string", sql: "NULLIF(c.assigned,'')", about: "The teammate it's assigned to." },
  team_id: { type: "string", sql: "c.team_id", about: "Its team." },
  contact_id: {
    type: "string",
    sql: "(SELECT m.contact_id FROM identity_contact_mappings m WHERE m.workspace_id=c.workspace_id AND m.identity_id=c.primary_identity_id)",
    about: "The contact who wrote in.",
  },
  tag_id: { type: "string", sql: "@tag", about: "A tag on it (= has it, != doesn't)." },
  priority: { type: "boolean", sql: "c.priority", about: "Marked as a priority." },
  created_at: { type: "time", sql: "c.created_at", sortable: true, about: "When it started." },
  updated_at: { type: "time", sql: "c.updated_at", sortable: true, about: "When it last changed." },
  waiting_since: {
    type: "time",
    sql: "(CASE WHEN c.status='open' AND c.last_contact_reply_at>COALESCE(c.last_teammate_reply_at,'-infinity'::timestamptz) THEN c.last_contact_reply_at END)",
    about: "When the customer's unanswered message came in.",
  },
};
/** Contacts: `c` is the contact. */
export const CONTACT_FIELDS: Record<string, Field> = {
  id: { type: "string", sql: "c.id", about: "Its id." },
  role: { type: "enum", sql: "c.role", values: ["visitor", "lead", "user"], about: "visitor, lead or user." },
  name: { type: "string", sql: "c.name", sortable: true, about: "Their name." },
  email: { type: "string", sql: "@email", about: "One of their email addresses." },
  external_id: { type: "string", sql: "c.external_id", about: "Your id for them." },
  first_seen_at: { type: "time", sql: "c.first_seen_at", sortable: true, about: "When they were first seen." },
  last_seen_at: { type: "time", sql: "c.last_seen_at", sortable: true, about: "When they were last seen." },
  signed_up_at: { type: "time", sql: "c.signed_up_at", sortable: true, about: "When they signed up." },
};
/** `custom_attributes.<name>` on contacts: compared as text, or as a number when the value is one. */
const CUSTOM = /^custom_attributes\.([A-Za-z0-9_.-]{1,64})$/;

export class SearchError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
  }
}
type Node = Record<string, unknown>;

/** A query as SQL (a boolean expression) with its parameters appended to `params`. */
export function compileSearch(query: unknown, fields: Record<string, Field>, params: unknown[], resource: "conversation" | "contact"): string {
  let conditions = 0;
  const p = (v: unknown) => {
    params.push(v);
    return "$" + params.length;
  };
  const walk = (n: unknown, at: string, depth: number): string => {
    if (!n || typeof n !== "object" || Array.isArray(n)) throw new SearchError(at, "Expected a condition or a group.");
    const node = n as Node;
    const op = node.operator;
    if (op === "AND" || op === "OR") {
      if (depth >= 3) throw new SearchError(at, "Groups go up to 3 deep.");
      if (!Array.isArray(node.value) || node.value.length < 1 || node.value.length > 20) throw new SearchError(`${at}.value`, "A group holds 1 to 20 queries.");
      return "(" + node.value.map((v, i) => walk(v, `${at}.value[${i}]`, depth + 1)).join(` ${op} `) + ")";
    }
    if (++conditions > 20) throw new SearchError(at, "A query has up to 20 conditions.");
    const name = node.field;
    if (typeof name !== "string") throw new SearchError(`${at}.field`, "Name a field.");
    const custom = resource === "contact" ? CUSTOM.exec(name) : null;
    const f: Field | undefined = custom ? { type: typeof node.value === "number" ? "number" : "string", sql: "@custom", about: "" } : fields[name];
    if (!f) throw new SearchError(`${at}.field`, `There's no field ${name} here.`);
    if (typeof op !== "string" || !OPERATORS[f.type].includes(op)) throw new SearchError(`${at}.operator`, `${name} takes ${OPERATORS[f.type].join(" ")}.`);
    const value = node.value;
    const one = (v: unknown, where: string): unknown => {
      if (f.type === "string") {
        if (typeof v !== "string" || v.length > 255) throw new SearchError(where, "Expected text of up to 255 characters.");
        return v;
      }
      if (f.type === "enum") {
        if (!f.values!.includes(v as string)) throw new SearchError(where, `Expected one of: ${f.values!.join(", ")}.`);
        return v;
      }
      if (f.type === "number") {
        if (typeof v !== "number" || !Number.isFinite(v)) throw new SearchError(where, "Expected a number.");
        return v;
      }
      if (f.type === "time") {
        if (typeof v !== "string" || Number.isNaN(Date.parse(v)) || !/[zZ]|[+-]\d{2}:\d{2}$/.test(v)) throw new SearchError(where, "Expected a date and time with an offset.");
        return new Date(v).toISOString();
      }
      if (typeof v !== "boolean") throw new SearchError(where, "Expected true or false.");
      return v;
    };
    const list = op === "IN" || op === "NIN";
    if (list && (!Array.isArray(value) || value.length < 1 || value.length > 100)) throw new SearchError(`${at}.value`, "Expected a list of 1 to 100 values.");
    const vals = list ? (value as unknown[]).map((v, i) => one(v, `${at}.value[${i}]`)) : [one(value, `${at}.value`)];
    const like = (v: string) => v.replace(/[\\%_]/g, (c) => "\\" + c);
    /** One comparison of a column, by operator; every value a parameter. */
    const cond = (operator: string, column: string, values = vals): string => {
      const v = values[0];
      switch (operator) {
        case "=":
          return `${column} = ${p(v)}`;
        case "!=":
          return `${column} IS DISTINCT FROM ${p(v)}`;
        case "IN":
          return `${column} = ANY(${p(values)})`;
        case "NIN":
          return `NOT (${column} = ANY(${p(values)}))`;
        case "~":
          return `${column} ILIKE ${p("%" + like(String(v)) + "%")}`;
        case "!~":
          return `NOT (${column} ILIKE ${p("%" + like(String(v)) + "%")})`;
        case "^":
          return `${column} ILIKE ${p(like(String(v)) + "%")}`;
        case "$":
          return `${column} ILIKE ${p("%" + like(String(v)))}`;
        default:
          return `${column} ${operator} ${p(v)}${f.type === "time" ? "::timestamptz" : ""}`;
      }
    };
    /** A membership (a tag, an email): "has one that matches", or for != NIN !~, "has none that would". */
    const member = (from: string, column: string, values = vals) => {
      const negated: Record<string, string> = { "!=": "=", NIN: "IN", "!~": "~" };
      const positive = negated[op as string] ?? (op as string);
      return `${negated[op as string] ? "NOT " : ""}EXISTS (SELECT 1 FROM ${from} AND ${cond(positive, column, values)})`;
    };
    if (f.sql === "@tag") return member("conversation_tags t WHERE t.workspace_id=c.workspace_id AND t.conversation_id=c.id", "t.tag_id");
    if (f.sql === "@email")
      return member(
        "contact_emails e WHERE e.workspace_id=c.workspace_id AND e.contact_id=c.id",
        "lower(e.email)",
        vals.map((v) => String(v).toLowerCase()),
      );
    if (f.sql === "@custom") {
      const key = p(custom![1]);
      return cond(op as string, f.type === "number" ? `(CASE WHEN jsonb_typeof(c.profile->${key})='number' THEN (c.profile->>${key})::numeric END)` : `(c.profile->>${key})`);
    }
    return cond(op as string, f.sql);
  };
  return walk(query, "query", 0);
}

/** The sort's column and direction (default: the resource's own), checked against the fields. */
export function compileSort(sort: unknown, fields: Record<string, Field>, fallback: string): { field: string; sql: string; desc: boolean } {
  if (sort === undefined) return { field: fallback, sql: fields[fallback].sql, desc: true };
  const s = sort as { field?: string; order?: string };
  const f = s.field ? fields[s.field] : undefined;
  if (!f || !f.sortable) throw new SearchError("sort.field", `Sort by one of: ${Object.entries(fields).filter(([, x]) => x.sortable).map(([k]) => k).join(", ")}.`);
  return { field: s.field!, sql: f.sql, desc: s.order !== "asc" };
}
