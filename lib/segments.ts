/**
 * Segments (phase 13, step O1; docs/OUTBOUND_STEP1.md): rules over contacts, with one definition.
 * `matches` evaluates a rule in code against a contact's facts (so outbound can say why someone
 * matched), and `server/segments.ts` compiles the same rules to SQL (for counts and lists); the two
 * must agree, and `tests/segments.test.ts` checks that on a generated corpus.
 *
 * Semantics, shared by both:
 * - Text compares ignore case; "is not" also matches a missing value.
 * - Emails are several: "is", "contains" and "ends with" match any of them; "is not" none.
 * - Attributes are the contact's own (`profile`). Text compares read scalars only; "greater than"
 *   and "less than" read numbers only.
 * - Dates are days before `now`: "more than N days ago" and "less than N days ago" never match
 *   an unset date.
 * - Events: performed at least N times (1 by default), within the last D days or ever; or not
 *   performed (within D days, or ever).
 * - Subscriptions: opted in or out, after the type's consent (opt-in types start out, opt-out ones
 *   in), the contact's own choice, and unsubscribing from everything.
 */
export type Op =
  | "is"
  | "is_not"
  | "contains"
  | "ends_with"
  | "is_set"
  | "is_not_set"
  | "greater_than"
  | "less_than"
  | "more_than_days_ago"
  | "less_than_days_ago"
  | "performed"
  | "not_performed"
  | "opted_in"
  | "opted_out";
export type Rule = {
  field: string;
  op: Op;
  /** The attribute's name, the event's name, or the subscription type's id. */
  key?: string;
  value?: string | number | boolean;
  /** Events: within the last N days (absent: ever), and at least N times (absent: once). */
  days?: number;
  count?: number;
};
export type SegmentDefinition = { match: "all" | "any"; rules: Rule[] };

type Field = { label: string; ops: Op[]; key?: "attribute" | "event" | "subscription"; values?: string[] };
export const SEGMENT_FIELDS: Record<string, Field> = {
  role: { label: "Type", ops: ["is", "is_not"], values: ["user", "lead", "visitor"] },
  name: { label: "Name", ops: ["is", "is_not", "contains", "is_set", "is_not_set"] },
  email: { label: "Email", ops: ["is", "is_not", "contains", "ends_with", "is_set", "is_not_set"] },
  phone: { label: "Phone", ops: ["is_set", "is_not_set"] },
  external_id: { label: "User ID", ops: ["is", "is_set", "is_not_set"] },
  first_seen: { label: "First seen", ops: ["more_than_days_ago", "less_than_days_ago"] },
  last_seen: { label: "Last seen", ops: ["more_than_days_ago", "less_than_days_ago"] },
  signed_up: { label: "Signed up", ops: ["more_than_days_ago", "less_than_days_ago", "is_set", "is_not_set"] },
  unsubscribed: { label: "Unsubscribed from everything", ops: ["is"], values: ["true", "false"] },
  attribute: { label: "Attribute", ops: ["is", "is_not", "contains", "is_set", "is_not_set", "greater_than", "less_than"], key: "attribute" },
  event: { label: "Event", ops: ["performed", "not_performed"], key: "event" },
  subscription: { label: "Subscription", ops: ["opted_in", "opted_out"], key: "subscription" },
};
/** Rules on data that later phases own: refused, naming the phase (the workflows' rule). */
const LATER: Record<string, string> = {
  company: "Companies arrive in phase 01.",
  tag: "Tags on people arrive in phase 01.",
  custom_object: "Custom objects arrive in phase 01.",
};
export const MAX_RULES = 20;
const KEY = /^[A-Za-z0-9_.:-]{1,100}$/;
const EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,99}$/;
const VALUE_OPS: Op[] = ["is", "is_not", "contains", "ends_with", "greater_than", "less_than"];

/** What's wrong with a definition, in words for the person building it (empty: nothing). */
export function segmentProblems(def: unknown): string[] {
  const out: string[] = [];
  const d = def as SegmentDefinition;
  if (!d || typeof d !== "object" || (d.match !== "all" && d.match !== "any") || !Array.isArray(d.rules)) return ["A segment matches all or any of a list of rules."];
  if (d.rules.length > MAX_RULES) out.push(`Use ${MAX_RULES} rules at most.`);
  d.rules.forEach((r, i) => {
    const where = `Rule ${i + 1}`;
    if (!r || typeof r !== "object") return out.push(`${where}: choose what to filter on.`);
    const later = LATER[String(r.field).split(".")[0]];
    if (later) return out.push(`${where}: ${later}`);
    const f = SEGMENT_FIELDS[r.field];
    if (!f) return out.push(`${where}: choose what to filter on.`);
    if (!f.ops.includes(r.op)) return out.push(`${where}: ${f.label.toLowerCase()} can't be filtered that way.`);
    if (f.key === "attribute" && !KEY.test(String(r.key ?? ""))) out.push(`${where}: name the attribute (letters, digits, . _ : -).`);
    if (f.key === "event" && !EVENT_NAME.test(String(r.key ?? ""))) out.push(`${where}: choose the event.`);
    if (f.key === "subscription" && !KEY.test(String(r.key ?? ""))) out.push(`${where}: choose the subscription.`);
    if (VALUE_OPS.includes(r.op)) {
      if (r.op === "greater_than" || r.op === "less_than") {
        if (typeof r.value !== "number" || !Number.isFinite(r.value)) out.push(`${where}: compare with a number.`);
      } else if (r.value === undefined || r.value === null || String(r.value).trim() === "" || String(r.value).length > 200) out.push(`${where}: give a value (200 characters at most).`);
      else if (f.values && !f.values.includes(String(r.value))) out.push(`${where}: choose one of ${f.values.join(", ")}.`);
    }
    if (r.field === "unsubscribed" && !["true", "false", true, false].includes(r.value as string)) out.push(`${where}: yes or no.`);
    if (r.op === "more_than_days_ago" || r.op === "less_than_days_ago")
      if (!Number.isInteger(r.value) || (r.value as number) < 0 || (r.value as number) > 3650) out.push(`${where}: a number of days (0 to 3650).`);
    if (r.op === "performed" || r.op === "not_performed") {
      if (r.days !== undefined && (!Number.isInteger(r.days) || r.days < 1 || r.days > 3650)) out.push(`${where}: within 1 to 3650 days.`);
      if (r.count !== undefined && (r.op !== "performed" || !Number.isInteger(r.count) || r.count < 1 || r.count > 10000)) out.push(`${where}: at least 1 to 10000 times.`);
    }
  });
  return out;
}

/** A contact as rules see it: only what the definition asks for need be filled in. */
export type ContactFacts = {
  role: string;
  name: string;
  emails: string[];
  phones: number;
  externalId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  signedUpAt: string | null;
  unsubscribed: boolean;
  profile: Record<string, unknown>;
  /** Each event name's times (ISO). */
  events: Record<string, string[]>;
  /** Each subscription type's effective state. */
  subscriptions: Record<string, "opted_in" | "opted_out">;
};

const DAY = 86_400_000;
const lower = (s: unknown) => String(s).toLowerCase();
const set = (s: string | null | undefined) => s !== null && s !== undefined && s !== "";
const scalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
function text(op: Op, value: string | null | undefined, wanted: unknown) {
  const has = set(value);
  if (op === "is_set") return has;
  if (op === "is_not_set") return !has;
  if (op === "is_not") return !has || lower(value) !== lower(wanted);
  if (!has) return false;
  if (op === "is") return lower(value) === lower(wanted);
  if (op === "contains") return lower(value).includes(lower(wanted));
  if (op === "ends_with") return lower(value).endsWith(lower(wanted));
  return false;
}
function days(op: Op, at: string | null, n: number, now: number) {
  if (op === "is_set") return at !== null;
  if (op === "is_not_set") return at === null;
  if (at === null) return false;
  const t = Date.parse(at);
  return op === "more_than_days_ago" ? t < now - n * DAY : t >= now - n * DAY;
}

export function ruleMatches(r: Rule, c: ContactFacts, now: number): boolean {
  switch (r.field) {
    case "role":
      return r.op === "is" ? c.role === r.value : c.role !== r.value;
    case "name":
      return text(r.op, c.name, r.value);
    case "email":
      if (r.op === "is_set") return c.emails.length > 0;
      if (r.op === "is_not_set") return c.emails.length === 0;
      if (r.op === "is_not") return !c.emails.some((e) => lower(e) === lower(r.value));
      return c.emails.some((e) => text(r.op, e, r.value));
    case "phone":
      return r.op === "is_set" ? c.phones > 0 : c.phones === 0;
    case "external_id":
      return text(r.op, c.externalId, r.value);
    case "first_seen":
      return days(r.op, c.firstSeenAt, Number(r.value), now);
    case "last_seen":
      return days(r.op, c.lastSeenAt, Number(r.value), now);
    case "signed_up":
      return days(r.op, c.signedUpAt, Number(r.value), now);
    case "unsubscribed":
      return c.unsubscribed === (String(r.value) === "true");
    case "attribute": {
      const v = c.profile[r.key!];
      if (r.op === "greater_than" || r.op === "less_than") return typeof v === "number" && (r.op === "greater_than" ? v > Number(r.value) : v < Number(r.value));
      return text(r.op, scalar(v) ? String(v) : null, r.value);
    }
    case "event": {
      const since = r.days ? now - r.days * DAY : -Infinity;
      const n = (c.events[r.key!] ?? []).filter((t) => Date.parse(t) >= since).length;
      return r.op === "performed" ? n >= (r.count ?? 1) : n === 0;
    }
    case "subscription":
      return (c.subscriptions[r.key!] ?? "opted_out") === r.op;
  }
  return false;
}

export function matches(def: SegmentDefinition, c: ContactFacts, now = Date.now()) {
  if (!def.rules.length) return true;
  return def.match === "all" ? def.rules.every((r) => ruleMatches(r, c, now)) : def.rules.some((r) => ruleMatches(r, c, now));
}

/** The predefined segments (Intercom's): code, not rows, so they're never edited or archived. */
export const PREDEFINED: { id: string; name: string; definition: SegmentDefinition }[] = [
  { id: "all-users", name: "All users", definition: { match: "all", rules: [{ field: "role", op: "is", value: "user" }] } },
  { id: "all-leads", name: "All leads", definition: { match: "all", rules: [{ field: "role", op: "is", value: "lead" }] } },
  {
    id: "active",
    name: "Active",
    definition: {
      match: "all",
      rules: [
        { field: "role", op: "is", value: "user" },
        { field: "last_seen", op: "less_than_days_ago", value: 30 },
      ],
    },
  },
  {
    id: "new",
    name: "New",
    definition: {
      match: "all",
      rules: [
        { field: "role", op: "is", value: "user" },
        { field: "signed_up", op: "less_than_days_ago", value: 7 },
      ],
    },
  },
];
