import { assert, DomainError, once, type Sql } from "./db";
import { authorize, can } from "./policy";
import { resolveContact } from "./people";
import { recordAudit } from "./audit";
import {
  companyAttributesJson,
  deleteCompanyAttributes,
  setCompanyAttributes,
} from "./contact-attributes";

/**
 * Companies (docs/PEOPLE_STEP2.md, phase 01 P1b): a workspace's companies, with their plan, seats,
 * monthly spend and typed custom data, and contacts in many companies with a role on each.
 *
 * Who sets a person's companies: the API and teammates in the inbox, always; the messenger only
 * for a verified user, only through the signed identity token's `companies` claim, and only while
 * the workspace has turned that on (`people_settings.messenger_sets_companies`, off by default).
 * Each membership records who added it, and the portal's company visibility trusts one the
 * messenger added only while that setting is on (`TRUSTED_MEMBERSHIP`).
 *
 * This module is the only writer of `companies` and `contact_companies`, and every change bumps the
 * company's version, which is what the database's `company.updated` webhook watches.
 */
export type CompanyRow = {
  id: string;
  company_id: string;
  name: string;
  plan: string | null;
  seats: number | null;
  monthly_spend: string | null;
  website: string | null;
  custom_attributes: Record<string, unknown>;
  contact_count: number;
  created_at: Date;
  updated_at: Date;
};
export type MembershipSource = "api" | "inbox" | "messenger" | "merge";

export const COMPANY_SELECT = `SELECT co.id,co.company_id,co.name,co.plan,co.seats,co.monthly_spend::text AS monthly_spend,co.website,
  ${companyAttributesJson("co")} AS custom_attributes,
  (SELECT count(*)::int FROM contact_companies m WHERE m.workspace_id=co.workspace_id AND m.company_id=co.id) AS contact_count,
  co.created_at,co.updated_at FROM companies co`;

const iso = (d: Date | string) => new Date(d).toISOString();
/** A company in the API's shape. */
export const companyOut = (c: CompanyRow) => ({
  type: "company" as const,
  id: c.id,
  company_id: c.company_id,
  name: c.name,
  plan: c.plan,
  seats: c.seats,
  monthly_spend: c.monthly_spend === null ? null : Number(c.monthly_spend),
  website: c.website,
  custom_attributes: c.custom_attributes ?? {},
  contact_count: c.contact_count,
  created_at: iso(c.created_at),
  updated_at: iso(c.updated_at),
});

/**
 * A membership the portal may trust: one the API, a teammate or a merge added, or one the messenger
 * added while the workspace still allows the messenger to set companies. For `contact_companies`
 * aliased `m`.
 */
export const TRUSTED_MEMBERSHIP = `(m.source<>'messenger' OR EXISTS(SELECT 1 FROM people_settings ps WHERE ps.workspace_id=m.workspace_id AND ps.messenger_sets_companies))`;

const refuse = (field: string, message: string): never => {
  throw new DomainError("INVALID_FIELD", message, 400, { field });
};

export type CompanyInput = {
  company_id?: unknown;
  name?: unknown;
  plan?: unknown;
  seats?: unknown;
  monthly_spend?: unknown;
  website?: unknown;
  custom_attributes?: unknown;
};
/** The columns a request sets, checked; `undefined` leaves one as it is and `null` clears it. */
function columnsOf(input: CompanyInput) {
  const out: Record<string, unknown> = {};
  const text = (field: keyof CompanyInput, max: number, required = false) => {
    const v = input[field];
    if (v === undefined) return;
    if (v === null && !required) return void (out[field] = null);
    if (typeof v !== "string" || !v.trim())
      return refuse(field, `Give ${field} as text.`);
    if (v.trim().length > max)
      return refuse(field, `${field} is up to ${max} characters.`);
    out[field] = v.trim();
  };
  text("name", 255, true);
  text("plan", 255);
  text("website", 2000);
  if (input.seats !== undefined)
    out.seats =
      input.seats === null
        ? null
        : Number.isInteger(input.seats) &&
            (input.seats as number) >= 0 &&
            (input.seats as number) <= 2_000_000_000
          ? input.seats
          : refuse("seats", "seats is a whole number, 0 or more.");
  if (input.monthly_spend !== undefined)
    out.monthly_spend =
      input.monthly_spend === null
        ? null
        : typeof input.monthly_spend === "number" &&
            Number.isFinite(input.monthly_spend) &&
            input.monthly_spend >= 0 &&
            input.monthly_spend < 1e12
          ? Math.round(input.monthly_spend * 100) / 100
          : refuse("monthly_spend", "monthly_spend is an amount, 0 or more.");
  return out;
}
function customOf(input: CompanyInput) {
  const a = input.custom_attributes;
  if (a === undefined || a === null) return {};
  if (typeof a !== "object" || Array.isArray(a))
    return refuse(
      "custom_attributes",
      "custom_attributes is an object of names and values.",
    );
  return a as Record<string, unknown>;
}
const companyIdOf = (v: unknown) =>
  typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 200
    ? v.trim()
    : refuse(
        "company_id",
        "Give company_id: your id for the company, up to 200 characters.",
      );

/** One company, or not found. */
export async function readCompany(db: Sql, w: string, id: string) {
  const row = (
    await db.query<CompanyRow>(
      `${COMPANY_SELECT} WHERE co.workspace_id=$1 AND co.id=$2`,
      [w, id],
    )
  ).rows[0];
  assert(row, "NOT_FOUND", "No such company.", 404);
  return companyOut(row);
}

/**
 * A company created, or updated if one has its `company_id` already (so retries and syncs are
 * safe). A new one needs a name. Custom data is typed by its definitions; a name the workspace
 * hasn't defined is defined by its first value.
 */
export async function upsertCompany(db: Sql, w: string, input: CompanyInput) {
  const companyId = companyIdOf(input.company_id);
  const columns = columnsOf(input);
  const custom = customOf(input);
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    w + ":company:" + companyId,
  ]);
  const existing = (
    await db.query<{ id: string }>(
      "SELECT id FROM companies WHERE workspace_id=$1 AND company_id=$2",
      [w, companyId],
    )
  ).rows[0];
  if (existing) {
    await writeCompany(db, w, existing.id, columns, custom);
    return { id: existing.id, created: false };
  }
  if (!columns.name) refuse("name", "A new company needs a name.");
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO companies(workspace_id,id,company_id,name,plan,seats,monthly_spend,website) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      w,
      id,
      companyId,
      columns.name,
      columns.plan ?? null,
      columns.seats ?? null,
      columns.monthly_spend ?? null,
      columns.website ?? null,
    ],
  );
  if (Object.keys(custom).length)
    await setCompanyAttributes(db, w, id, custom, { define: true });
  return { id, created: true };
}

/** A company's columns and custom data changed; others are left as they are. */
export async function updateCompany(
  db: Sql,
  w: string,
  id: string,
  input: CompanyInput,
) {
  const found = (
    await db.query(
      "SELECT 1 FROM companies WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [w, id],
    )
  ).rows.length;
  assert(found, "NOT_FOUND", "No such company.", 404);
  if (input.company_id !== undefined) {
    const companyId = companyIdOf(input.company_id);
    const taken = (
      await db.query(
        "SELECT 1 FROM companies WHERE workspace_id=$1 AND company_id=$2 AND id<>$3",
        [w, companyId, id],
      )
    ).rows.length;
    if (taken)
      refuse("company_id", "Another company already has that company_id.");
    await writeCompany(
      db,
      w,
      id,
      { ...columnsOf(input), company_id: companyId },
      customOf(input),
    );
  } else await writeCompany(db, w, id, columnsOf(input), customOf(input));
}

async function writeCompany(
  db: Sql,
  w: string,
  id: string,
  columns: Record<string, unknown>,
  custom: Record<string, unknown>,
) {
  const names = Object.keys(columns);
  if (!names.length && !Object.keys(custom).length) return;
  if (Object.keys(custom).length)
    await setCompanyAttributes(db, w, id, custom, { define: true });
  // Every change bumps the version (the `company.updated` webhook), custom data included.
  await db.query(
    `UPDATE companies SET ${names.map((n, i) => `${n}=$${i + 3}`).join(",")}${names.length ? "," : ""}version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
    [w, id, ...names.map((n) => columns[n])],
  );
}

/** A company deleted with its memberships and custom data; the deletion goes in the audit log. */
export async function deleteCompany(db: Sql, w: string, id: string) {
  const c = (
    await db.query<{ company_id: string; name: string }>(
      "SELECT company_id,name FROM companies WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [w, id],
    )
  ).rows[0];
  assert(c, "NOT_FOUND", "No such company.", 404);
  // Its memberships go without a "detached" webhook each: the one "deleted" says it all.
  await db.query("SELECT set_config('relay.deleting_company',$1,true)", [id]);
  const members = (
    await db.query<{ contact_id: string }>(
      "DELETE FROM contact_companies WHERE workspace_id=$1 AND company_id=$2 RETURNING contact_id",
      [w, id],
    )
  ).rows.length;
  await db.query("SELECT set_config('relay.deleting_company','',true)");
  await deleteCompanyAttributes(db, w, id);
  await db.query("DELETE FROM companies WHERE workspace_id=$1 AND id=$2", [
    w,
    id,
  ]);
  await recordAudit(
    db,
    w,
    "company.deleted",
    { type: "company", id, name: c.name },
    { companyId: c.company_id, members },
  );
  return { id, deleted: true };
}

/**
 * A contact in a company, with their role there (a role given replaces theirs; none keeps it).
 * Who added it is kept from the first time: a later write doesn't make a messenger membership
 * trusted, or the reverse.
 */
export async function attachCompany(
  db: Sql,
  w: string,
  contactId: string,
  companyId: string,
  role: unknown,
  source: MembershipSource,
) {
  if (
    role !== undefined &&
    role !== null &&
    (typeof role !== "string" || role.trim().length > 100)
  )
    refuse("role", "role is up to 100 characters of text.");
  const company = (
    await db.query("SELECT 1 FROM companies WHERE workspace_id=$1 AND id=$2", [
      w,
      companyId,
    ])
  ).rows.length;
  assert(company, "NOT_FOUND", "No such company.", 404);
  const r = typeof role === "string" ? role.trim() : null;
  const added = (
    await db.query(
      `INSERT INTO contact_companies(workspace_id,contact_id,company_id,role,source) VALUES($1,$2,$3,COALESCE($4,''),$5)
       ON CONFLICT(workspace_id,contact_id,company_id) DO UPDATE SET role=COALESCE($4,contact_companies.role)
       RETURNING (xmax=0) AS inserted`,
      [w, contactId, companyId, r, source],
    )
  ).rows[0] as { inserted: boolean };
  if (added.inserted) await touch(db, w, companyId);
}

/** A contact taken out of a company. */
export async function detachCompany(
  db: Sql,
  w: string,
  contactId: string,
  companyId: string,
) {
  const gone = (
    await db.query(
      "DELETE FROM contact_companies WHERE workspace_id=$1 AND contact_id=$2 AND company_id=$3 RETURNING company_id",
      [w, contactId, companyId],
    )
  ).rows.length;
  assert(gone, "NOT_FOUND", "That contact isn't in that company.", 404);
  await touch(db, w, companyId);
}
const touch = (db: Sql, w: string, companyId: string) =>
  db.query(
    "UPDATE companies SET updated_at=now() WHERE workspace_id=$1 AND id=$2",
    [w, companyId],
  );

export type Membership = ReturnType<typeof companyOut> & {
  role: string;
  source: MembershipSource;
  trusted: boolean;
};
/** Each contact's companies, with their role in each, for several contacts at once. */
export async function companiesOf(db: Sql, w: string, contactIds: string[]) {
  const rows = (
    await db.query<
      CompanyRow & {
        contact: string;
        role: string;
        source: MembershipSource;
        trusted: boolean;
      }
    >(
      `SELECT m.contact_id AS contact,m.role,m.source,${TRUSTED_MEMBERSHIP} AS trusted,x.* FROM contact_companies m
       JOIN LATERAL (${COMPANY_SELECT} WHERE co.workspace_id=m.workspace_id AND co.id=m.company_id) x ON true
       WHERE m.workspace_id=$1 AND m.contact_id=ANY($2::text[]) ORDER BY lower(x.name),x.id`,
      [w, contactIds],
    )
  ).rows;
  const out: Record<string, Membership[]> = Object.fromEntries(
    contactIds.map((id) => [id, []]),
  );
  for (const r of rows)
    out[r.contact].push({
      ...companyOut(r),
      role: r.role,
      source: r.source,
      trusted: r.trusted,
    });
  return out;
}

/**
 * A merge's companies: the survivor keeps its memberships and gains the loser's it hasn't (marked
 * as added by the merge). Returns the ones added, so the merge's reversal takes exactly those away.
 */
export async function mergeCompanies(
  db: Sql,
  w: string,
  loserId: string,
  survivorId: string,
) {
  return (
    await db.query<{ company_id: string }>(
      `INSERT INTO contact_companies(workspace_id,contact_id,company_id,role,source)
       SELECT workspace_id,$3,company_id,role,CASE WHEN source='messenger' THEN 'messenger' ELSE 'merge' END FROM contact_companies WHERE workspace_id=$1 AND contact_id=$2
       ON CONFLICT DO NOTHING RETURNING company_id`,
      [w, loserId, survivorId],
    )
  ).rows.map((r) => r.company_id);
}
/** A merge reversed: the memberships it gave the survivor are taken away again. */
export async function unmergeCompanies(
  db: Sql,
  w: string,
  survivorId: string,
  added: string[] | undefined,
) {
  if (added?.length)
    await db.query(
      "DELETE FROM contact_companies WHERE workspace_id=$1 AND contact_id=$2 AND company_id=ANY($3::text[])",
      [w, survivorId, added],
    );
}

/** Whether the messenger may set a verified user's companies (off by default). */
export async function messengerSetsCompanies(db: Sql, w: string) {
  return (
    (
      await db.query<{ on: boolean }>(
        "SELECT messenger_sets_companies AS on FROM people_settings WHERE workspace_id=$1",
        [w],
      )
    ).rows[0]?.on === true
  );
}

/**
 * The signed identity token's `companies` claim, for a verified user: up to 10 of
 * `{company_id, name?, role?}`. Each company is found by its `company_id`, or made with the name
 * given; the user joins those they aren't in. Nothing else about a company is set from the
 * messenger, and nobody is taken out of one: the API and teammates do that. Does nothing unless
 * the workspace allows it; an entry that isn't well formed is skipped.
 */
export async function applyCompanyClaim(
  db: Sql,
  w: string,
  contactId: string,
  claim: unknown,
) {
  if (!Array.isArray(claim) || !(await messengerSetsCompanies(db, w))) return 0;
  let joined = 0;
  for (const entry of claim.slice(0, 10)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.company_id !== "string" ||
      !e.company_id.trim() ||
      e.company_id.length > 200
    )
      continue;
    const companyId = e.company_id.trim();
    let id = (
      await db.query<{ id: string }>(
        "SELECT id FROM companies WHERE workspace_id=$1 AND company_id=$2",
        [w, companyId],
      )
    ).rows[0]?.id;
    if (!id) {
      if (
        typeof e.name !== "string" ||
        !e.name.trim() ||
        e.name.trim().length > 255
      )
        continue;
      id = (await upsertCompany(db, w, { company_id: companyId, name: e.name }))
        .id;
    }
    const role =
      typeof e.role === "string" && e.role.trim().length <= 100
        ? e.role
        : undefined;
    const before = (
      await db.query(
        "SELECT 1 FROM contact_companies WHERE workspace_id=$1 AND contact_id=$2 AND company_id=$3",
        [w, contactId, id],
      )
    ).rows.length;
    if (before) continue;
    await attachCompany(db, w, contactId, id, role, "messenger");
    joined++;
  }
  return joined;
}

/* ------------------------------------------------------------------------------------------ */
/* The inbox: a teammate's view and changes                                                    */
/* ------------------------------------------------------------------------------------------ */

/** Companies whose name or id starts with `q`, for the sidebar's picker (20 at most). */
export async function findCompanies(
  db: Sql,
  w: string,
  principal: string,
  q: string,
) {
  await authorize(db, w, principal, "contacts.personal_data");
  const term = q.trim().toLowerCase().slice(0, 100);
  const rows = (
    await db.query<CompanyRow>(
      `${COMPANY_SELECT} WHERE co.workspace_id=$1 AND ($2='' OR lower(co.name) LIKE $3 OR lower(co.company_id) LIKE $3) ORDER BY lower(co.name),co.id LIMIT 20`,
      [w, term, term.replace(/[\\%_]/g, "\\$&") + "%"],
    )
  ).rows;
  return {
    companies: rows.map(companyOut),
    canManage: await can(db, w, principal, "workspace.manage"),
    messengerSetsCompanies: await messengerSetsCompanies(db, w),
  };
}

/**
 * A teammate's change to a customer's companies: join one (an existing company, or a new one made
 * with its name and an id of the teammate's choosing), leave one, or change their role there.
 */
export async function changeCompanies(
  db: Sql,
  w: string,
  principal: string,
  key: string,
  p: Record<string, unknown>,
) {
  await authorize(db, w, principal, "contacts.personal_data");
  return once(db, w, "companies:" + principal, key, p, async () => {
    const contactId = await resolveContact(db, w, String(p.contactId ?? ""));
    if (p.action === "attach") {
      let companyId = typeof p.companyId === "string" ? p.companyId : "";
      if (!companyId)
        companyId = (
          await upsertCompany(db, w, {
            company_id: p.newCompanyId ?? crypto.randomUUID(),
            name: p.name,
          })
        ).id;
      await attachCompany(
        db,
        w,
        contactId,
        companyId,
        p.role ?? undefined,
        "inbox",
      );
    } else if (p.action === "role")
      await attachCompany(
        db,
        w,
        contactId,
        String(p.companyId ?? ""),
        p.role ?? "",
        "inbox",
      );
    else if (p.action === "detach")
      await detachCompany(db, w, contactId, String(p.companyId ?? ""));
    else
      throw new DomainError(
        "INVALID_REQUEST",
        "Choose attach, role or detach.",
        400,
      );
    return { companies: (await companiesOf(db, w, [contactId]))[contactId] };
  });
}

/** Whether the messenger may set companies: read by teammates, changed by who manages the workspace. */
export async function changePeopleSettings(
  db: Sql,
  w: string,
  principal: string,
  p?: Record<string, unknown>,
) {
  if (p) {
    const t = await authorize(db, w, principal, "workspace.manage");
    if (typeof p.messengerSetsCompanies !== "boolean")
      throw new DomainError(
        "INVALID_REQUEST",
        "Say whether the messenger may set companies.",
        400,
      );
    await db.query(
      `INSERT INTO people_settings(workspace_id,messenger_sets_companies,updated_by) VALUES($1,$2,$3)
       ON CONFLICT(workspace_id) DO UPDATE SET messenger_sets_companies=$2,updated_by=$3,updated_at=now()`,
      [w, p.messengerSetsCompanies, t.id],
    );
  } else await authorize(db, w, principal, "workspace.manage");
  return { messengerSetsCompanies: await messengerSetsCompanies(db, w) };
}
