import { companyAttributesJson, contactAttributesJson, VALUE_TEXT } from "./contact-attributes";
import { assert, DomainError, once, type Sql } from "./db";
import { authorize } from "./policy";
import { effectiveSubscriptions } from "./subscriptions";
import { recordContactView } from "./audit";
import {
  isGroup,
  PREDEFINED,
  PREDEFINED_COMPANIES,
  rulesOf,
  segmentProblems,
  type CompanyFacts,
  type ContactFacts,
  type Rule,
  type SegmentDefinition,
  type SegmentGroup,
  type SegmentTarget,
} from "../lib/segments";
import { companyPeopleSql } from "./people-sql";
import { featureOn } from "./plans";

/**
 * Segments and the People area (phase 13, step O1; docs/OUTBOUND_STEP1.md), behind `segments_v1`.
 * `compileSegment` turns `lib/segments.ts`'s rules into SQL with the same meaning as `matches`
 * (the corpus test holds them to it); `contactFacts` loads what `matches` reads. Merged contacts
 * are never listed: the one they joined is.
 */
const DAY = 86_400_000;

export async function segmentsOn(db: Sql, w: string) {
  // Phase 16 C8a: the rollout flag and the plan (`server/plans.ts`, the one gate).
  return featureOn(db, w, "segments_v1");
}

/**
 * SQL for `lib/segments.ts`'s rules, with the same meaning as `matches` and `companyMatches` (the
 * corpus test holds them to it). Values are appended to `params` (`$1` is the workspace).
 */
function sqlFor(params: unknown[], now: number) {
  const p = (v: unknown) => {
    params.push(v);
    return "$" + params.length;
  };
  const isSet = (x: string) => `(${x} IS NOT NULL AND ${x}<>'')`;
  const text = (x: string, op: Rule["op"], v: unknown) => {
    if (op === "is_set") return isSet(x);
    if (op === "is_not_set") return `NOT ${isSet(x)}`;
    if (op === "is_not") return `(NOT ${isSet(x)} OR lower(${x})<>lower(${p(String(v))}::text))`;
    if (op === "is") return `(${isSet(x)} AND lower(${x})=lower(${p(String(v))}::text))`;
    if (op === "contains") return `(${isSet(x)} AND strpos(lower(${x}),lower(${p(String(v))}::text))>0)`;
    if (op === "ends_with") {
      const v1 = p(String(v));
      return `(${isSet(x)} AND right(lower(${x}),char_length(lower(${v1}::text)))=lower(${v1}::text))`;
    }
    return "false";
  };
  const date = (x: string, op: Rule["op"], n: unknown) => {
    if (op === "is_set") return `${x} IS NOT NULL`;
    if (op === "is_not_set") return `${x} IS NULL`;
    const cutoff = p(new Date(now - Number(n) * DAY).toISOString());
    return op === "more_than_days_ago" ? `(${x} IS NOT NULL AND ${x}<${cutoff}::timestamptz)` : `(${x} IS NOT NULL AND ${x}>=${cutoff}::timestamptz)`;
  };
  const number = (x: string, op: Rule["op"], v: unknown) => {
    if (op === "is_set") return `${x} IS NOT NULL`;
    if (op === "is_not_set") return `${x} IS NULL`;
    return `COALESCE(${x}${op === "greater_than" ? ">" : "<"}${p(Number(v))}::numeric,false)`;
  };
  /** A typed attribute's value (P1a), by its exact name, for an owner row `alias.id`. */
  const attribute = (owner: "contact" | "company", alias: string, r: Rule) => {
    const table = owner === "contact" ? "contact_attribute_values" : "company_attribute_values";
    const value = (column: string) =>
      `(SELECT ${column} FROM ${table} v JOIN attribute_definitions d ON d.workspace_id=v.workspace_id AND d.id=v.attribute_id
        WHERE v.workspace_id=${alias}.workspace_id AND v.${owner}_id=${alias}.id AND d.owner_type='${owner}' AND d.archived_at IS NULL AND d.name=${p(r.key)}::text)`;
    if (r.op === "greater_than" || r.op === "less_than") return `COALESCE(${value("v.number_value")}${r.op === "greater_than" ? ">" : "<"}${p(Number(r.value))}::numeric,false)`;
    return text(value(VALUE_TEXT), r.op, r.value);
  };
  /** A company rule on a company row aliased `a` (P2a). */
  const companyRule = (r: Rule, a: string): string => {
    switch (r.field) {
      case "name":
        return text(`${a}.name`, r.op, r.value);
      case "company_id":
        return text(`${a}.company_id`, r.op, r.value);
      case "plan":
        return text(`${a}.plan`, r.op, r.value);
      case "seats":
        return number(`${a}.seats`, r.op, r.value);
      case "monthly_spend":
        return number(`${a}.monthly_spend`, r.op, r.value);
      case "people":
        return number(companyPeopleSql(a), r.op, r.value);
      case "created":
        return date(`${a}.created_at`, r.op, r.value);
      case "attribute":
        return attribute("company", a, r);
      case "tag": {
        const has = `EXISTS (SELECT 1 FROM company_tags ct WHERE ct.workspace_id=${a}.workspace_id AND ct.company_id=${a}.id AND ct.tag_id=${p(String(r.value))}::text)`;
        return r.op === "has" ? has : `NOT ${has}`;
      }
    }
    return "false";
  };
  const contactRule = (r: Rule): string => {
    switch (r.field) {
      case "role":
        return `c.role${r.op === "is" ? "=" : "<>"}${p(String(r.value))}::text`;
      case "name":
        return text("c.name", r.op, r.value);
      case "external_id":
        return text("c.external_id", r.op, r.value);
      case "email": {
        const any = (cond: string) => `EXISTS (SELECT 1 FROM contact_emails e WHERE e.workspace_id=c.workspace_id AND e.contact_id=c.id AND ${cond})`;
        if (r.op === "is_set") return any("true");
        if (r.op === "is_not_set") return `NOT ${any("true")}`;
        if (r.op === "is_not") return `NOT ${any(`lower(e.email)=lower(${p(String(r.value))}::text)`)}`;
        return any(text("e.email", r.op, r.value));
      }
      case "phone": {
        const any = `EXISTS (SELECT 1 FROM contact_phones ph WHERE ph.workspace_id=c.workspace_id AND ph.contact_id=c.id)`;
        return r.op === "is_set" ? any : `NOT ${any}`;
      }
      case "first_seen":
        return date("c.first_seen_at", r.op, r.value);
      case "last_seen":
        return date("c.last_seen_at", r.op, r.value);
      case "signed_up":
        return date("c.signed_up_at", r.op, r.value);
      case "unsubscribed":
        return `c.global_unsubscribe=${p(String(r.value) === "true")}::boolean`;
      case "attribute":
        return attribute("contact", "c", r);
      case "event": {
        const since = r.days ? ` AND ev.occurred_at>=${p(new Date(now - r.days * DAY).toISOString())}::timestamptz` : "";
        const n = `(SELECT count(*) FROM contact_events ev WHERE ev.workspace_id=c.workspace_id AND ev.contact_id=c.id AND ev.name=${p(r.key)}::text${since})`;
        return r.op === "performed" ? `${n}>=${p(r.count ?? 1)}::int` : `${n}=0`;
      }
      case "subscription": {
        const k = p(r.key);
        return `(CASE WHEN c.global_unsubscribe OR NOT EXISTS (SELECT 1 FROM subscription_types t WHERE t.workspace_id=c.workspace_id AND t.id=${k}::text AND t.archived_at IS NULL) THEN 'opted_out'
          ELSE COALESCE((SELECT s.state FROM contact_subscriptions s WHERE s.workspace_id=c.workspace_id AND s.contact_id=c.id AND s.subscription_type_id=${k}::text),
                        (SELECT CASE t.consent WHEN 'opt_out' THEN 'opted_in' ELSE 'opted_out' END FROM subscription_types t WHERE t.workspace_id=c.workspace_id AND t.id=${k}::text)) END)=${p(r.op)}::text`;
      }
      case "tag": {
        const has = `EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.workspace_id=c.workspace_id AND ct.contact_id=c.id AND ct.tag_id=${p(String(r.value))}::text)`;
        return r.op === "has" ? has : `NOT ${has}`;
      }
      case "companies": {
        const any = `EXISTS (SELECT 1 FROM contact_companies cm WHERE cm.workspace_id=c.workspace_id AND cm.contact_id=c.id)`;
        return r.op === "is_set" ? any : `NOT ${any}`;
      }
    }
    // Any one of their companies matching the company rule (decision 12).
    if (r.field.startsWith("company.")) {
      const sub = { ...r, field: r.field.slice("company.".length) };
      return `EXISTS (SELECT 1 FROM contact_companies cm JOIN companies co ON co.workspace_id=cm.workspace_id AND co.id=cm.company_id
        WHERE cm.workspace_id=c.workspace_id AND cm.contact_id=c.id AND ${companyRule(sub, "co")})`;
    }
    return "false";
  };
  const group = (g: SegmentGroup, rule: (r: Rule) => string): string => {
    if (!g.rules.length) return "true";
    return "(" + g.rules.map((r) => (isGroup(r) ? group(r, rule) : rule(r))).join(g.match === "all" ? " AND " : " OR ") + ")";
  };
  return { contacts: (def: SegmentDefinition) => group(def, contactRule), companies: (def: SegmentDefinition) => group(def, (r) => companyRule(r, "co")) };
}

/** A people segment as a WHERE clause over `contacts c`, its values appended to `params` (`$1` is the workspace). */
export function compileSegment(def: SegmentDefinition, params: unknown[], now = Date.now()) {
  return sqlFor(params, now).contacts(def);
}
/** A company segment as a WHERE clause over `companies co` (P2a). */
export function compileCompanySegment(def: SegmentDefinition, params: unknown[], now = Date.now()) {
  return sqlFor(params, now).companies(def);
}

/**
 * Whether one contact is in a people segment now: one indexed query (P2a, the brief's "membership
 * for a single contact, cheaply", which targeting calls on every message). A merged-away contact
 * is never in one.
 */
export async function inSegment(db: Sql, w: string, def: SegmentDefinition, contactId: string, now = Date.now()) {
  const params: unknown[] = [w, contactId];
  return (await db.query(`SELECT 1 FROM contacts c WHERE c.workspace_id=$1 AND c.id=$2 AND c.merged_into_contact_id IS NULL AND ${compileSegment(def, params, now)}`, params)).rows.length > 0;
}

/** What `matches` reads for one contact (the events and subscriptions the definition names). */
export async function contactFacts(db: Sql, w: string, contactId: string, def: SegmentDefinition): Promise<ContactFacts> {
  const c = (
    await db.query<{
      role: string;
      name: string;
      external_id: string | null;
      first_seen_at: Date;
      last_seen_at: Date;
      signed_up_at: Date | null;
      global_unsubscribe: boolean;
      profile: Record<string, unknown>;
    }>(`SELECT c.role,c.name,c.external_id,c.first_seen_at,c.last_seen_at,c.signed_up_at,c.global_unsubscribe,${contactAttributesJson("c")} AS profile FROM contacts c WHERE c.workspace_id=$1 AND c.id=$2`, [w, contactId])
  ).rows[0];
  assert(c, "CONTACT_NOT_FOUND", "That person isn't available.", 404);
  const rules = rulesOf(def);
  const names = [...new Set(rules.filter((r) => r.field === "event").map((r) => r.key!))];
  const types = [...new Set(rules.filter((r) => r.field === "subscription").map((r) => r.key!))];
  // P2a: their tags and companies, when a rule asks for them.
  const wantsTags = rules.some((r) => r.field === "tag");
  const wantsCompanies = rules.some((r) => r.field === "companies" || r.field.startsWith("company."));
  const events: Record<string, string[]> = {};
  if (names.length)
    for (const e of (
      await db.query<{ name: string; occurred_at: Date }>("SELECT name,occurred_at FROM contact_events WHERE workspace_id=$1 AND contact_id=$2 AND name=ANY($3::text[])", [w, contactId, names])
    ).rows)
      (events[e.name] ??= []).push(new Date(e.occurred_at).toISOString());
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    role: c.role,
    name: c.name,
    emails: (await db.query<{ email: string }>("SELECT email FROM contact_emails WHERE workspace_id=$1 AND contact_id=$2", [w, contactId])).rows.map((r) => r.email),
    phones: (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM contact_phones WHERE workspace_id=$1 AND contact_id=$2", [w, contactId])).rows[0].n,
    externalId: c.external_id,
    firstSeenAt: iso(c.first_seen_at)!,
    lastSeenAt: iso(c.last_seen_at)!,
    signedUpAt: iso(c.signed_up_at),
    unsubscribed: c.global_unsubscribe,
    profile: c.profile,
    events,
    subscriptions: types.length ? await effectiveSubscriptions(db, w, contactId, types) : {},
    ...(wantsTags ? { tags: (await db.query<{ tag_id: string }>("SELECT tag_id FROM contact_tags WHERE workspace_id=$1 AND contact_id=$2", [w, contactId])).rows.map((r) => r.tag_id) } : {}),
    ...(wantsCompanies
      ? { companies: await companyFacts(db, w, (await db.query<{ company_id: string }>("SELECT company_id FROM contact_companies WHERE workspace_id=$1 AND contact_id=$2", [w, contactId])).rows.map((r) => r.company_id)) }
      : {}),
  };
}

/** What `companyMatches` reads, for several companies (P2a). */
export async function companyFacts(db: Sql, w: string, ids: string[]): Promise<CompanyFacts[]> {
  if (!ids.length) return [];
  const rows = (
    await db.query<{ id: string; name: string; company_id: string; plan: string | null; seats: number | null; monthly_spend: string | null; people: number; created_at: Date; attributes: Record<string, unknown>; tags: string[] }>(
      `SELECT co.id,co.name,co.company_id,co.plan,co.seats,co.monthly_spend::text AS monthly_spend,${companyPeopleSql("co")} AS people,co.created_at,
        ${companyAttributesJson("co")} AS attributes,
        COALESCE((SELECT array_agg(ct.tag_id) FROM company_tags ct WHERE ct.workspace_id=co.workspace_id AND ct.company_id=co.id),'{}') AS tags
       FROM companies co WHERE co.workspace_id=$1 AND co.id=ANY($2::text[]) ORDER BY co.id`,
      [w, ids],
    )
  ).rows;
  return rows.map((r) => ({
    name: r.name,
    companyId: r.company_id,
    plan: r.plan,
    seats: r.seats,
    monthlySpend: r.monthly_spend === null ? null : Number(r.monthly_spend),
    people: r.people,
    createdAt: new Date(r.created_at).toISOString(),
    attributes: r.attributes,
    tags: r.tags,
  }));
}

/** The contacts a definition matches: how many, and a page of them (latest seen first). */
export async function matching(db: Sql, w: string, def: SegmentDefinition, page = 0, now = Date.now()) {
  const params: unknown[] = [w];
  const where = `c.workspace_id=$1 AND c.merged_into_contact_id IS NULL AND ${compileSegment(def, params, now)}`;
  const count = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM contacts c WHERE ${where}`, params)).rows[0].n;
  const rows = (
    await db.query<{ id: string; name: string; role: string; email: string | null; first_seen_at: Date; last_seen_at: Date; signed_up_at: Date | null }>(
      `SELECT c.id,c.name,c.role,(SELECT min(e.email) FROM contact_emails e WHERE e.workspace_id=c.workspace_id AND e.contact_id=c.id) AS email,c.first_seen_at,c.last_seen_at,c.signed_up_at
       FROM contacts c WHERE ${where} ORDER BY c.last_seen_at DESC,c.id LIMIT 50 OFFSET ${Math.max(0, Math.min(200, Math.floor(page))) * 50}`,
      params,
    )
  ).rows;
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    count,
    contacts: rows.map((r) => ({ id: r.id, name: r.name, role: r.role, email: r.email, firstSeenAt: iso(r.first_seen_at), lastSeenAt: iso(r.last_seen_at), signedUpAt: iso(r.signed_up_at) })),
  };
}

/** The companies a company segment matches (P2a): how many, and a page of them (by name). */
export async function matchingCompanies(db: Sql, w: string, def: SegmentDefinition, page = 0, now = Date.now()) {
  const params: unknown[] = [w];
  const where = `co.workspace_id=$1 AND ${compileCompanySegment(def, params, now)}`;
  const count = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM companies co WHERE ${where}`, params)).rows[0].n;
  const rows = (
    await db.query<{ id: string; name: string; company_id: string; plan: string | null; seats: number | null; monthly_spend: string | null; people: number }>(
      `SELECT co.id,co.name,co.company_id,co.plan,co.seats,co.monthly_spend::text AS monthly_spend,${companyPeopleSql("co")} AS people
       FROM companies co WHERE ${where} ORDER BY lower(co.name),co.id LIMIT 50 OFFSET ${Math.max(0, Math.min(200, Math.floor(page))) * 50}`,
      params,
    )
  ).rows;
  return {
    count,
    companies: rows.map((r) => ({ id: r.id, name: r.name, companyId: r.company_id, plan: r.plan, seats: r.seats, monthlySpend: r.monthly_spend === null ? null : Number(r.monthly_spend), people: r.people })),
  };
}
const matchingFor = (db: Sql, w: string, target: SegmentTarget, def: SegmentDefinition, page = 0) => (target === "companies" ? matchingCompanies(db, w, def, page) : matching(db, w, def, page));

/* ------------------------------------------------------------------------------------------ */
/* The People area                                                                             */

async function allowed(db: Sql, w: string, principal: string) {
  const t = await authorize(db, w, principal, "contacts.personal_data");
  assert(await segmentsOn(db, w), "SEGMENTS_DISABLED", "Segments are not enabled for this workspace.", 404);
  return t;
}
async function saved(db: Sql, w: string) {
  return (
    await db.query<{ id: string; name: string; definition: SegmentDefinition; target: SegmentTarget }>(
      "SELECT id,name,definition,target FROM segments WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY lower(name),id",
      [w],
    )
  ).rows;
}
/** A segment's definition and what it's made of (predefined ones are people). */
export async function segmentOf(db: Sql, w: string, id: string): Promise<{ definition: SegmentDefinition; target: SegmentTarget }> {
  const pre = PREDEFINED.find((s) => s.id === id);
  if (pre) return { definition: pre.definition, target: "contacts" };
  const preCompanies = PREDEFINED_COMPANIES.find((s) => s.id === id);
  if (preCompanies) return { definition: preCompanies.definition, target: "companies" };
  const row = (await db.query<{ definition: SegmentDefinition; target: SegmentTarget }>("SELECT definition,target FROM segments WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL", [w, id])).rows[0];
  assert(row, "SEGMENT_NOT_FOUND", "That segment isn't available.", 404);
  return row;
}
const targetOf = (v: unknown): SegmentTarget => (v === "companies" ? "companies" : "contacts");
const checked = (def: unknown, target: SegmentTarget = "contacts") => {
  const problems = segmentProblems(def, target);
  if (problems.length) throw new DomainError("INVALID_SEGMENT", problems[0], 400);
  return def as SegmentDefinition;
};

/** The segments (with counts), and what rules can name: attributes, events and subscriptions. */
export async function readPeople(db: Sql, w: string, principal: string) {
  await allowed(db, w, principal);
  const segments = [
    ...PREDEFINED.map((s) => ({ ...s, predefined: true, target: "contacts" as SegmentTarget })),
    ...PREDEFINED_COMPANIES.map((s) => ({ ...s, predefined: true, target: "companies" as SegmentTarget })),
    ...(await saved(db, w)).map((s) => ({ ...s, predefined: false })),
  ];
  const counted = [];
  for (const s of segments) {
    const target = s.target;
    counted.push({ id: s.id, name: s.name, predefined: s.predefined, target, definition: s.definition, count: (await matchingFor(db, w, target, s.definition)).count });
  }
  return {
    segments: counted,
    // P2a: what tag and company rules can name.
    tags: (await db.query<{ id: string; name: string }>("SELECT id,name FROM tags WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY lower(name),id", [w])).rows,
    companyAttributes: (
      await db.query<{ key: string }>("SELECT name AS key FROM attribute_definitions WHERE workspace_id=$1 AND owner_type='company' AND archived_at IS NULL ORDER BY lower(name) LIMIT 200", [w])
    ).rows.map((r) => r.key),
    attributes: (
      // P1a: every key in use is a defined attribute now, so the definitions are the whole list.
      await db.query<{ key: string }>(
        "SELECT name AS key FROM attribute_definitions WHERE workspace_id=$1 AND owner_type='contact' AND archived_at IS NULL ORDER BY lower(name) LIMIT 200",
        [w],
      )
    ).rows.map((r) => r.key),
    events: (await db.query<{ name: string }>("SELECT name FROM event_definitions WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY lower(name)", [w])).rows.map((r) => r.name),
    subscriptions: (
      await db.query<{ id: string; name: string; channel: string }>("SELECT id,name,channel FROM subscription_types WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY lower(name),id", [w])
    ).rows,
  };
}

/**
 * `people` actions: `list` (a segment's or a draft definition's contacts: nothing is written),
 * `contact` (one person: their attributes, latest events and subscriptions), `save` and `archive`.
 */
export async function changePeople(db: Sql, w: string, principal: string, key: string, p: Record<string, unknown>) {
  const t = await allowed(db, w, principal);
  if (p.action === "list") {
    // P2a: a segment of people or of companies.
    const { definition, target } = p.segmentId ? await segmentOf(db, w, String(p.segmentId)) : { target: targetOf(p.target), definition: null };
    return matchingFor(db, w, target, definition ?? checked(p.definition, target), Number(p.page ?? 0) || 0);
  }
  if (p.action === "contact") return contactDetails(db, w, String(p.contactId ?? ""));
  return once(db, w, "segments:" + principal, key, p, async () => {
    if (p.action === "save") {
      const name = String(p.name ?? "").trim();
      if (!name || name.length > 80) throw new DomainError("INVALID_SEGMENT", "Name the segment (80 characters at most).", 400);
      const id = p.id ? String(p.id) : null;
      assert(!id || ![...PREDEFINED, ...PREDEFINED_COMPANIES].some((s) => s.id === id), "SEGMENT_PREDEFINED", "Predefined segments can't be changed: save a copy.", 409);
      // P2a: a saved segment keeps what it's made of; a new one is people unless it says companies.
      const target = id ? (await segmentOf(db, w, id)).target : targetOf(p.target);
      const def = checked(p.definition, target);
      if ((await db.query("SELECT 1 FROM segments WHERE workspace_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL AND id IS DISTINCT FROM $3", [w, name, id])).rows.length || [...PREDEFINED, ...PREDEFINED_COMPANIES].some((s) => s.name.toLowerCase() === name.toLowerCase()))
        throw new DomainError("INVALID_SEGMENT", "A segment with that name already exists.", 400);
      if (id) {
        const r = await db.query("UPDATE segments SET name=$3,definition=$4,updated_by=$5,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id", [w, id, name, JSON.stringify(def), t.id]);
        assert(r.rows.length, "SEGMENT_NOT_FOUND", "That segment isn't available.", 404);
        return { id, ...(await readPeople(db, w, principal)) };
      }
      const created = crypto.randomUUID();
      await db.query("INSERT INTO segments(workspace_id,id,name,definition,target,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)", [w, created, name, JSON.stringify(def), target, t.id]);
      return { id: created, ...(await readPeople(db, w, principal)) };
    }
    if (p.action === "archive") {
      assert(![...PREDEFINED, ...PREDEFINED_COMPANIES].some((s) => s.id === p.id), "SEGMENT_PREDEFINED", "Predefined segments can't be archived.", 409);
      const r = await db.query("UPDATE segments SET archived_at=now(),updated_by=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id", [w, String(p.id ?? ""), t.id]);
      assert(r.rows.length, "SEGMENT_NOT_FOUND", "That segment isn't available.", 404);
      return readPeople(db, w, principal);
    }
    throw new DomainError("INVALID_SEGMENT", "Unknown change.", 400);
  });
}

async function contactDetails(db: Sql, w: string, contactId: string) {
  const c = (
    await db.query<{ id: string; name: string; role: string; external_id: string | null; profile: Record<string, unknown>; first_seen_at: Date; last_seen_at: Date; signed_up_at: Date | null; global_unsubscribe: boolean }>(
      `SELECT c.id,c.name,c.role,c.external_id,${contactAttributesJson("c")} AS profile,c.first_seen_at,c.last_seen_at,c.signed_up_at,c.global_unsubscribe
       FROM contacts c WHERE c.workspace_id=$1 AND c.id=$2 AND c.merged_into_contact_id IS NULL`,
      [w, contactId],
    )
  ).rows[0];
  assert(c, "CONTACT_NOT_FOUND", "That person isn't available.", 404);
  // Phase 16 C1: a teammate opened this person's record (People needs personal-data access).
  await recordContactView(db, w, c.id, { where: "people", personalData: true });
  const types = (await db.query<{ id: string; name: string; channel: string }>("SELECT id,name,channel FROM subscription_types WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY lower(name),id", [w])).rows;
  const states = await effectiveSubscriptions(db, w, c.id, types.map((x) => x.id));
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    contact: {
      id: c.id,
      name: c.name,
      role: c.role,
      externalId: c.external_id,
      emails: (await db.query<{ email: string }>("SELECT email FROM contact_emails WHERE workspace_id=$1 AND contact_id=$2 ORDER BY email", [w, c.id])).rows.map((r) => r.email),
      phones: (await db.query<{ phone: string }>("SELECT phone FROM contact_phones WHERE workspace_id=$1 AND contact_id=$2 ORDER BY phone", [w, c.id])).rows.map((r) => r.phone),
      attributes: c.profile,
      firstSeenAt: iso(c.first_seen_at),
      lastSeenAt: iso(c.last_seen_at),
      signedUpAt: iso(c.signed_up_at),
      unsubscribedFromAll: c.global_unsubscribe,
    },
    events: (
      await db.query<{ name: string; metadata: Record<string, unknown>; occurred_at: Date; source: string }>(
        "SELECT name,metadata,occurred_at,source FROM contact_events WHERE workspace_id=$1 AND contact_id=$2 ORDER BY occurred_at DESC,id LIMIT 20",
        [w, c.id],
      )
    ).rows.map((e) => ({ name: e.name, metadata: e.metadata, at: iso(e.occurred_at), source: e.source })),
    subscriptions: types.map((x) => ({ id: x.id, name: x.name, channel: x.channel, state: states[x.id] })),
  };
}
