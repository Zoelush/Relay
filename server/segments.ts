import { assert, DomainError, once, type Sql } from "./db";
import { authorize } from "./policy";
import { effectiveSubscriptions } from "./subscriptions";
import { recordContactView } from "./audit";
import { PREDEFINED, segmentProblems, type ContactFacts, type Rule, type SegmentDefinition } from "../lib/segments";

/**
 * Segments and the People area (phase 13, step O1; docs/OUTBOUND_STEP1.md), behind `segments_v1`.
 * `compileSegment` turns `lib/segments.ts`'s rules into SQL with the same meaning as `matches`
 * (the corpus test holds them to it); `contactFacts` loads what `matches` reads. Merged contacts
 * are never listed: the one they joined is.
 */
const DAY = 86_400_000;

export async function segmentsOn(db: Sql, w: string) {
  return (await db.query("SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='segments_v1' AND enabled", [w])).rows.length > 0;
}

/** The definition as a WHERE clause over `contacts c`, its values appended to `params` (`$1` is the workspace). */
export function compileSegment(def: SegmentDefinition, params: unknown[], now = Date.now()) {
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
  const rule = (r: Rule): string => {
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
      case "attribute": {
        const k = p(r.key);
        if (r.op === "greater_than" || r.op === "less_than")
          return `(jsonb_typeof(c.profile->${k}::text)='number' AND (c.profile->>${k}::text)::numeric${r.op === "greater_than" ? ">" : "<"}${p(Number(r.value))}::numeric)`;
        return text(`(CASE WHEN jsonb_typeof(c.profile->${k}::text) IN ('string','number','boolean') THEN c.profile->>${k}::text END)`, r.op, r.value);
      }
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
    }
    return "false";
  };
  if (!def.rules.length) return "true";
  return "(" + def.rules.map(rule).join(def.match === "all" ? " AND " : " OR ") + ")";
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
    }>("SELECT role,name,external_id,first_seen_at,last_seen_at,signed_up_at,global_unsubscribe,profile FROM contacts WHERE workspace_id=$1 AND id=$2", [w, contactId])
  ).rows[0];
  assert(c, "CONTACT_NOT_FOUND", "That person isn't available.", 404);
  const names = [...new Set(def.rules.filter((r) => r.field === "event").map((r) => r.key!))];
  const types = [...new Set(def.rules.filter((r) => r.field === "subscription").map((r) => r.key!))];
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
  };
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

/* ------------------------------------------------------------------------------------------ */
/* The People area                                                                             */

async function allowed(db: Sql, w: string, principal: string) {
  const t = await authorize(db, w, principal, "contacts.personal_data");
  assert(await segmentsOn(db, w), "SEGMENTS_DISABLED", "Segments are not enabled for this workspace.", 404);
  return t;
}
async function saved(db: Sql, w: string) {
  return (
    await db.query<{ id: string; name: string; definition: SegmentDefinition }>("SELECT id,name,definition FROM segments WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY lower(name),id", [w])
  ).rows;
}
async function definitionOf(db: Sql, w: string, id: string) {
  const pre = PREDEFINED.find((s) => s.id === id);
  if (pre) return pre.definition;
  const row = (await db.query<{ definition: SegmentDefinition }>("SELECT definition FROM segments WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL", [w, id])).rows[0];
  assert(row, "SEGMENT_NOT_FOUND", "That segment isn't available.", 404);
  return row.definition;
}
const checked = (def: unknown) => {
  const problems = segmentProblems(def);
  if (problems.length) throw new DomainError("INVALID_SEGMENT", problems[0], 400);
  return def as SegmentDefinition;
};

/** The segments (with counts), and what rules can name: attributes, events and subscriptions. */
export async function readPeople(db: Sql, w: string, principal: string) {
  await allowed(db, w, principal);
  const segments = [...PREDEFINED.map((s) => ({ ...s, predefined: true })), ...(await saved(db, w)).map((s) => ({ ...s, predefined: false }))];
  const counted = [];
  for (const s of segments) counted.push({ id: s.id, name: s.name, predefined: s.predefined, definition: s.definition, count: (await matching(db, w, s.definition)).count });
  return {
    segments: counted,
    attributes: (
      await db.query<{ key: string }>(
        `SELECT DISTINCT k AS key FROM (SELECT jsonb_object_keys(profile) AS k FROM contacts WHERE workspace_id=$1 AND merged_into_contact_id IS NULL AND jsonb_typeof(profile)='object') x
         UNION SELECT name FROM attribute_definitions WHERE workspace_id=$1 AND owner_type='contact' AND archived_at IS NULL ORDER BY 1 LIMIT 200`,
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
    const def = p.segmentId ? await definitionOf(db, w, String(p.segmentId)) : checked(p.definition);
    return matching(db, w, def, Number(p.page ?? 0) || 0);
  }
  if (p.action === "contact") return contactDetails(db, w, String(p.contactId ?? ""));
  return once(db, w, "segments:" + principal, key, p, async () => {
    if (p.action === "save") {
      const name = String(p.name ?? "").trim();
      if (!name || name.length > 80) throw new DomainError("INVALID_SEGMENT", "Name the segment (80 characters at most).", 400);
      const def = checked(p.definition);
      const id = p.id ? String(p.id) : null;
      assert(!id || !PREDEFINED.some((s) => s.id === id), "SEGMENT_PREDEFINED", "Predefined segments can't be changed: save a copy.", 409);
      if ((await db.query("SELECT 1 FROM segments WHERE workspace_id=$1 AND lower(name)=lower($2) AND archived_at IS NULL AND id IS DISTINCT FROM $3", [w, name, id])).rows.length || PREDEFINED.some((s) => s.name.toLowerCase() === name.toLowerCase()))
        throw new DomainError("INVALID_SEGMENT", "A segment with that name already exists.", 400);
      if (id) {
        const r = await db.query("UPDATE segments SET name=$3,definition=$4,updated_by=$5,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL RETURNING id", [w, id, name, JSON.stringify(def), t.id]);
        assert(r.rows.length, "SEGMENT_NOT_FOUND", "That segment isn't available.", 404);
        return { id, ...(await readPeople(db, w, principal)) };
      }
      const created = crypto.randomUUID();
      await db.query("INSERT INTO segments(workspace_id,id,name,definition,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5)", [w, created, name, JSON.stringify(def), t.id]);
      return { id: created, ...(await readPeople(db, w, principal)) };
    }
    if (p.action === "archive") {
      assert(!PREDEFINED.some((s) => s.id === p.id), "SEGMENT_PREDEFINED", "Predefined segments can't be archived.", 409);
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
      "SELECT id,name,role,external_id,profile,first_seen_at,last_seen_at,signed_up_at,global_unsubscribe FROM contacts WHERE workspace_id=$1 AND id=$2 AND merged_into_contact_id IS NULL",
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
