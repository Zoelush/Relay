import { assert, DomainError, type Sql } from "./db";
import { authorize, can } from "./policy";
import {
  ALWAYS_OPEN,
  validCalendar,
  type BusinessSchedule,
  type Calendar,
} from "./business-time";

/**
 * Named business calendars (phase 05, step B1). Each publish adds an immutable version and moves
 * the calendar's pointer to it, so anything that pinned an earlier version (a running clock, a
 * conversation's metrics) keeps computing with the hours it started under.
 */
const SCOPES = ["workspace", "brand", "team"] as const;
type Scope = (typeof SCOPES)[number];
export type ResolvedCalendar = {
  source: Scope | "brand_settings" | "default";
  calendarId: string | null;
  version: number | null;
  calendar: Calendar;
};

async function requireSla(db: Sql, w: string) {
  assert(
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='sla_v1' AND enabled",
        [w],
      )
    ).rows.length,
    "SLA_DISABLED",
    "Business hours and SLAs are not enabled for this workspace.",
    404,
  );
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "calendar";

/** A pinned calendar version, or null if it does not exist in this workspace. */
export async function calendarVersion(
  db: Sql,
  w: string,
  id: string,
  version: number,
) {
  const row = (
    await db.query<{ timezone: string; schedule: BusinessSchedule }>(
      "SELECT timezone,schedule FROM business_calendars WHERE workspace_id=$1 AND id=$2 AND version=$3",
      [w, id, version],
    )
  ).rows[0];
  return row ? ({ ...row.schedule, timezone: row.timezone } as Calendar) : null;
}

export async function listCalendars(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "conversations.read");
  await requireSla(db, w);
  const calendars = (
    await db.query<{
      id: string;
      name: string;
      version: number;
      timezone: string;
      schedule: BusinessSchedule;
      published_at: string;
    }>(
      `SELECT c.id,c.name,c.current_version AS version,b.timezone,b.schedule,b.published_at FROM calendars c
      JOIN business_calendars b ON b.workspace_id=c.workspace_id AND b.id=c.id AND b.version=c.current_version
      WHERE c.workspace_id=$1 ORDER BY c.name,c.id`,
      [w],
    )
  ).rows.map((r) => ({
    id: r.id,
    name: r.name,
    version: r.version,
    publishedAt: new Date(r.published_at).toISOString(),
    calendar: { ...r.schedule, timezone: r.timezone },
  }));
  const assignments = (
    await db.query<{ scope: Scope; scope_id: string; calendar_id: string }>(
      "SELECT scope,scope_id,calendar_id FROM calendar_assignments WHERE workspace_id=$1 ORDER BY scope,scope_id",
      [w],
    )
  ).rows.map((a) => ({
    scope: a.scope,
    scopeId: a.scope_id,
    calendarId: a.calendar_id,
  }));
  // What a calendar can be assigned to (Settings › Office hours).
  const named = async (table: "brands" | "teams") =>
    (
      await db.query<{ id: string; name: string }>(
        `SELECT id,name FROM ${table} WHERE workspace_id=$1 ORDER BY lower(name),id`,
        [w],
      )
    ).rows;
  return {
    calendars,
    assignments,
    brands: await named("brands"),
    teams: await named("teams"),
    canManage: await can(db, w, principal, "workspace.manage"),
  };
}

/**
 * Publishes a calendar: a new one, or a new version of an existing one (with the version the
 * editor started from, so two editors cannot overwrite each other). Earlier versions remain.
 */
export async function publishCalendar(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  await authorize(db, w, principal, "workspace.manage");
  await requireSla(db, w);
  const name = typeof p.name === "string" ? p.name.trim() : "";
  assert(
    name && name.length <= 80,
    "INVALID_CALENDAR",
    "Give the calendar a name of up to 80 characters.",
  );
  const calendar = validCalendar(p);
  const { timezone, ...schedule } = calendar;
  let id: string, version: number;
  if (p.id !== undefined) {
    const current = (
      await db.query<{ id: string; current_version: number }>(
        "SELECT id,current_version FROM calendars WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [w, String(p.id)],
      )
    ).rows[0];
    assert(current, "CALENDAR_NOT_FOUND", "Calendar unavailable.", 404);
    assert(
      Number(p.version) === current.current_version,
      "CALENDAR_CONFLICT",
      "This calendar changed elsewhere. Reload it and try again.",
      409,
    );
    id = current.id;
    version = current.current_version + 1;
  } else {
    const base = slug(name);
    const taken = (
      await db.query(
        "SELECT 1 FROM calendars WHERE workspace_id=$1 AND id=$2",
        [w, base],
      )
    ).rows.length;
    id = taken ? `${base}-${crypto.randomUUID().slice(0, 6)}` : base;
    version = 1;
  }
  await db.query(
    "INSERT INTO business_calendars(workspace_id,id,version,timezone,schedule) VALUES($1,$2,$3,$4,$5)",
    [w, id, version, timezone, JSON.stringify(schedule)],
  );
  if (version === 1)
    await db.query(
      "INSERT INTO calendars(workspace_id,id,name,current_version) VALUES($1,$2,$3,1)",
      [w, id, name],
    );
  else
    await db.query(
      "UPDATE calendars SET name=$3,current_version=$4,updated_at=now() WHERE workspace_id=$1 AND id=$2",
      [w, id, name, version],
    );
  return { id, version };
}

/** Assigns a calendar to the workspace, a brand or a team; `calendarId: null` removes it. */
export async function assignCalendar(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  await authorize(db, w, principal, "workspace.manage");
  await requireSla(db, w);
  const scope = p.scope as Scope;
  if (!SCOPES.includes(scope))
    throw new DomainError(
      "INVALID_ASSIGNMENT",
      "Assign to the workspace, a brand or a team.",
      400,
    );
  const scopeId = scope === "workspace" ? "" : String(p.scopeId ?? "");
  if (scope !== "workspace")
    assert(
      (
        await db.query(
          `SELECT 1 FROM ${scope === "brand" ? "brands" : "teams"} WHERE workspace_id=$1 AND id=$2`,
          [w, scopeId],
        )
      ).rows.length,
      "INVALID_ASSIGNMENT",
      scope === "brand" ? "Brand unavailable." : "Team unavailable.",
      404,
    );
  if (p.calendarId === null) {
    await db.query(
      "DELETE FROM calendar_assignments WHERE workspace_id=$1 AND scope=$2 AND scope_id=$3",
      [w, scope, scopeId],
    );
    return { scope, scopeId, calendarId: null };
  }
  assert(
    (
      await db.query(
        "SELECT 1 FROM calendars WHERE workspace_id=$1 AND id=$2",
        [w, String(p.calendarId ?? "")],
      )
    ).rows.length,
    "CALENDAR_NOT_FOUND",
    "Calendar unavailable.",
    404,
  );
  await db.query(
    `INSERT INTO calendar_assignments(workspace_id,scope,scope_id,calendar_id) VALUES($1,$2,$3,$4)
    ON CONFLICT(workspace_id,scope,scope_id) DO UPDATE SET calendar_id=$4,updated_at=now()`,
    [w, scope, scopeId, p.calendarId],
  );
  return { scope, scopeId, calendarId: String(p.calendarId) };
}

/**
 * The calendar that applies now: the team's, else the brand's (an assignment, else the older
 * brand setting), else the workspace default, else open 24/7. The current version is returned;
 * a clock pins it when it starts.
 */
export async function resolveCalendar(
  db: Sql,
  w: string,
  at: { teamId?: string | null; brandId?: string | null },
): Promise<ResolvedCalendar> {
  const candidates: [Scope, string][] = [];
  if (at.teamId) candidates.push(["team", at.teamId]);
  if (at.brandId) candidates.push(["brand", at.brandId]);
  for (const [scope, scopeId] of candidates) {
    const found = await assigned(db, w, scope, scopeId);
    if (found) return found;
    if (scope === "brand") {
      const legacy = (
        await db.query<{
          settings: { calendarId?: string; calendarVersion?: number };
        }>("SELECT settings FROM brands WHERE workspace_id=$1 AND id=$2", [
          w,
          scopeId,
        ])
      ).rows[0]?.settings;
      if (legacy?.calendarId && legacy.calendarVersion) {
        const calendar = await calendarVersion(
          db,
          w,
          legacy.calendarId,
          Number(legacy.calendarVersion),
        );
        if (calendar)
          return {
            source: "brand_settings",
            calendarId: legacy.calendarId,
            version: Number(legacy.calendarVersion),
            calendar,
          };
      }
    }
  }
  return (
    (await assigned(db, w, "workspace", "")) ?? {
      source: "default",
      calendarId: null,
      version: null,
      calendar: ALWAYS_OPEN,
    }
  );
}
async function assigned(db: Sql, w: string, scope: Scope, scopeId: string) {
  const row = (
    await db.query<{
      id: string;
      version: number;
      timezone: string;
      schedule: BusinessSchedule;
    }>(
      `SELECT c.id,c.current_version AS version,b.timezone,b.schedule FROM calendar_assignments a
      JOIN calendars c ON c.workspace_id=a.workspace_id AND c.id=a.calendar_id
      JOIN business_calendars b ON b.workspace_id=c.workspace_id AND b.id=c.id AND b.version=c.current_version
      WHERE a.workspace_id=$1 AND a.scope=$2 AND a.scope_id=$3`,
      [w, scope, scopeId],
    )
  ).rows[0];
  return row
    ? ({
        source: scope,
        calendarId: row.id,
        version: row.version,
        calendar: { ...row.schedule, timezone: row.timezone },
      } as ResolvedCalendar)
    : null;
}

/** For a conversation: the calendar that applies now, and the version its metrics pinned. */
export async function conversationCalendar(
  db: Sql,
  w: string,
  principal: string,
  c: {
    team_id: string | null;
    brand_id: string;
    calendar_id?: unknown;
    calendar_version?: unknown;
  },
) {
  await authorize(db, w, principal, "conversations.read");
  await requireSla(db, w);
  const resolved = await resolveCalendar(db, w, {
    teamId: c.team_id,
    brandId: c.brand_id,
  });
  return {
    current: resolved,
    pinned:
      c.calendar_id && c.calendar_version
        ? {
            calendarId: String(c.calendar_id),
            version: Number(c.calendar_version),
          }
        : null,
  };
}
