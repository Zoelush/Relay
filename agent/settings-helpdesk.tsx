import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { METHOD_HELP } from "./workload";
import { FilterEditor } from "./views";
import {
  Card,
  Field,
  Frame,
  message,
  timezones,
  type MenuState,
  type Page,
} from "./settings-ui";
import type { ViewFilter } from "../server/inbox-views";

/**
 * Settings › Helpdesk (S2a; docs/SETTINGS_STEP2.md): teams and assignment, office hours, and
 * SLAs. Each page edits through the API its feature already had (`teams`, `teammate-limits`,
 * `calendars`, `sla-policies`), which checks permissions, versions and limits; saves are
 * idempotent, and a change made elsewhere meanwhile is refused with a reason rather than
 * overwritten.
 */
type Method = "manual" | "round_robin" | "balanced";
type Team = {
  id: string;
  name: string;
  version: string;
  method: Method;
  conversationLimit: number | null;
  ticketLimit: number | null;
  ticketsCount: boolean;
  includeAway: boolean;
  unassignOnAway: boolean;
  queued: number;
  members: { id: string; name: string }[];
};
type TeammateLimits = {
  id: string;
  name: string;
  conversationLimit: number | null;
  ticketLimit: number | null;
};
const limitText = (n: number | null) => (n === null ? "No limit" : String(n));
const toLimit = (v: string) => (v.trim() ? Number(v) : null);
const fromLimit = (n: number | null) => (n === null ? "" : String(n));

/* ------------------------------------------------------------------------------------------ */
/* Teams & assignment                                                                           */

export function TeamsPage({
  menu,
  page,
  onChanged,
}: {
  menu: MenuState;
  page: Page;
  /** A team was saved: the app refreshes its directory, so assignment pickers follow. */
  onChanged?: () => void;
}) {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [teammates, setTeammates] = useState<TeammateLimits[]>([]);
  const [editing, setEditing] = useState<Team | "new" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(
    () =>
      api<{ teams: Team[]; teammates?: TeammateLimits[] }>("teams")
        .then((r) => {
          setTeams(r.teams);
          setTeammates(r.teammates ?? []);
        })
        .catch((e) => setError(message(e, "Teams could not be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="pg-settings-notice">
          {notice}
        </p>
      )}
      <Card
        title="Teams"
        description="Each team has its own inbox. Its assignment method decides who gets new conversations sent to it."
      >
        {teams && !teams.length && <p className="pg-muted">No teams yet.</p>}
        <ul className="pg-settings-list" aria-label="Teams">
          {teams?.map((t) => (
            <li key={t.id}>
              <span>
                <strong>{t.name}</strong>
                <small className="pg-muted">
                  {METHOD_HELP[t.method].name} · {t.members.length}{" "}
                  {t.members.length === 1 ? "member" : "members"} · inbox limit{" "}
                  {limitText(t.conversationLimit).toLowerCase()}
                  {t.queued ? ` · ${t.queued} waiting` : ""}
                </small>
              </span>
              <button
                type="button"
                aria-label={`Edit ${t.name}`}
                onClick={() => setEditing(t)}
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
        {!editing && (
          <div>
            <button type="button" onClick={() => setEditing("new")}>
              New team
            </button>
          </div>
        )}
      </Card>
      {editing && (
        <TeamEditor
          key={editing === "new" ? "new" : editing.id}
          team={editing === "new" ? null : editing}
          teammates={teammates}
          onSaved={(name, assigned) => {
            onChanged?.();
            setEditing(null);
            setNotice(
              `Saved ${name}.` +
                (assigned
                  ? ` ${assigned} waiting ${assigned === 1 ? "conversation was" : "conversations were"} assigned.`
                  : ""),
            );
            void load();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      <Card
        title="Teammate limits"
        description="The most open conversations and tickets a teammate is given automatically. Blank means no limit of their own; their teams' limits still apply."
      >
        <table
          className="pg-table pg-settings-table"
          aria-label="Teammate limits"
        >
          <thead>
            <tr>
              <th>Teammate</th>
              <th>Conversations</th>
              <th>Tickets</th>
              <th>
                <span className="pg-visually-hidden">Save</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {teammates.map((t) => (
              <LimitRow
                key={t.id}
                teammate={t}
                onSaved={(assigned) => {
                  setNotice(
                    `Saved ${t.name}'s limits.` +
                      (assigned ? ` ${assigned} assigned to them.` : ""),
                  );
                  void load();
                }}
                onError={(e) =>
                  setError(message(e, "Limits could not be saved."))
                }
              />
            ))}
          </tbody>
        </table>
      </Card>
    </Frame>
  );
}

function TeamEditor({
  team,
  teammates,
  onSaved,
  onCancel,
}: {
  team: Team | null;
  teammates: TeammateLimits[];
  onSaved: (name: string, assigned: number) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(team?.name ?? "");
  const [members, setMembers] = useState<string[]>(
    team?.members.map((m) => m.id) ?? [],
  );
  const [method, setMethod] = useState<Method>(team?.method ?? "manual");
  const [limit, setLimit] = useState(
    fromLimit(team?.conversationLimit ?? null),
  );
  const [ticketLimit, setTicketLimit] = useState(
    fromLimit(team?.ticketLimit ?? null),
  );
  const [ticketsCount, setTicketsCount] = useState(team?.ticketsCount ?? true);
  const [includeAway, setIncludeAway] = useState(team?.includeAway ?? false);
  const [unassignOnAway, setUnassignOnAway] = useState(
    team?.unassignOnAway ?? false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ assigned: number }>("teams", {
        ...(team ? { id: team.id, version: team.version } : {}),
        name,
        members,
        method,
        conversationLimit: toLimit(limit),
        ticketLimit: toLimit(ticketLimit),
        ticketsCount,
        includeAway,
        unassignOnAway,
      });
      onSaved(name.trim(), r.assigned);
    } catch (e) {
      setError(message(e, "The team could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="pg-settings-card"
      aria-label={team ? `Edit ${team.name}` : "New team"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>{team ? `Edit ${team.name}` : "New team"}</h3>
      <Field label="Team name">
        {(id) => (
          <input
            id={id}
            value={name}
            maxLength={80}
            required
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <fieldset className="pg-settings-fieldset">
        <legend>Members</legend>
        <div className="pg-settings-checks">
          {teammates.map((t) => (
            <label key={t.id}>
              <input
                type="checkbox"
                checked={members.includes(t.id)}
                onChange={(e) =>
                  setMembers((m) =>
                    e.target.checked
                      ? [...m, t.id]
                      : m.filter((x) => x !== t.id),
                  )
                }
              />
              {t.name}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="pg-settings-fieldset">
        <legend>Assignment method</legend>
        {(Object.keys(METHOD_HELP) as Method[]).map((m) => (
          <label key={m} className="pg-settings-toggle">
            <input
              type="radio"
              name="method"
              checked={method === m}
              onChange={() => setMethod(m)}
            />
            <span>
              <strong>{METHOD_HELP[m].name}</strong>
              <small className="pg-muted">{METHOD_HELP[m].help}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="pg-settings-row">
        <Field label="Inbox limit" hint="Open conversations. Blank for none.">
          {(id, hint) => (
            <input
              id={id}
              aria-describedby={hint}
              inputMode="numeric"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          )}
        </Field>
        <Field label="Ticket limit" hint="Open tickets. Blank for none.">
          {(id, hint) => (
            <input
              id={id}
              aria-describedby={hint}
              inputMode="numeric"
              value={ticketLimit}
              onChange={(e) => setTicketLimit(e.target.value)}
            />
          )}
        </Field>
      </div>
      <label className="pg-settings-toggle">
        <input
          type="checkbox"
          checked={ticketsCount}
          onChange={(e) => setTicketsCount(e.target.checked)}
        />
        <span>Tickets count toward conversation limits</span>
      </label>
      <label className="pg-settings-toggle">
        <input
          type="checkbox"
          checked={includeAway}
          onChange={(e) => setIncludeAway(e.target.checked)}
        />
        <span>Round robin includes away teammates</span>
      </label>
      <label className="pg-settings-toggle">
        <input
          type="checkbox"
          checked={unassignOnAway}
          onChange={(e) => setUnassignOnAway(e.target.checked)}
        />
        <span>
          When a member goes away, return their open conversations to this inbox
        </span>
      </label>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <footer className="pg-settings-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="pg-primary" disabled={busy}>
          {team ? "Save team" : "Create team"}
        </button>
      </footer>
    </form>
  );
}

function LimitRow({
  teammate,
  onSaved,
  onError,
}: {
  teammate: TeammateLimits;
  onSaved: (assigned: number) => void;
  onError: (e: unknown) => void;
}) {
  const [conv, setConv] = useState(fromLimit(teammate.conversationLimit));
  const [tick, setTick] = useState(fromLimit(teammate.ticketLimit));
  const [busy, setBusy] = useState(false);
  const dirty =
    conv !== fromLimit(teammate.conversationLimit) ||
    tick !== fromLimit(teammate.ticketLimit);
  return (
    <tr>
      <th scope="row">{teammate.name}</th>
      <td>
        <input
          aria-label={`${teammate.name}: conversation limit`}
          inputMode="numeric"
          value={conv}
          placeholder="None"
          onChange={(e) => setConv(e.target.value)}
        />
      </td>
      <td>
        <input
          aria-label={`${teammate.name}: ticket limit`}
          inputMode="numeric"
          value={tick}
          placeholder="None"
          onChange={(e) => setTick(e.target.value)}
        />
      </td>
      <td>
        <button
          type="button"
          disabled={!dirty || busy}
          aria-label={`Save ${teammate.name}'s limits`}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ assigned: number }>("teammate-limits", {
                teammateId: teammate.id,
                conversationLimit: toLimit(conv),
                ticketLimit: toLimit(tick),
              });
              onSaved(r.assigned);
            } catch (e) {
              onError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save
        </button>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Office hours                                                                                 */

type Window = [string, string];
type Calendar = {
  timezone: string;
  weekly: Record<string, Window[]>;
  holidays?: string[];
  special?: Record<string, Window[]>;
};
type CalendarRow = {
  id: string;
  name: string;
  version: number;
  publishedAt: string;
  calendar: Calendar;
};
type Assignment = {
  scope: "workspace" | "brand" | "team";
  scopeId: string;
  calendarId: string;
};
type Named = { id: string; name: string };
/** Monday first, as most teams read a week; the server's keys are 0 (Sunday) to 6. */
const WEEK: [string, string][] = [
  ["1", "Monday"],
  ["2", "Tuesday"],
  ["3", "Wednesday"],
  ["4", "Thursday"],
  ["5", "Friday"],
  ["6", "Saturday"],
  ["0", "Sunday"],
];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
/** "Mon–Fri 09:00–17:00 · Sat 10:00–14:00": days with the same hours run together. */
export function weekSummary(weekly: Record<string, Window[]>) {
  const text = (ws: Window[] = []) =>
    ws.map(([a, b]) => `${a}–${b}`).join(", ");
  const parts: string[] = [];
  let i = 0;
  while (i < WEEK.length) {
    const hours = text(weekly[WEEK[i][0]]);
    let j = i;
    while (j + 1 < WEEK.length && text(weekly[WEEK[j + 1][0]]) === hours) j++;
    if (hours) {
      const from = WEEK[i][1].slice(0, 3),
        to = WEEK[j][1].slice(0, 3);
      parts.push(`${i === j ? from : `${from}–${to}`} ${hours}`);
    }
    i = j + 1;
  }
  return parts.join(" · ") || "Closed all week";
}

export function OfficeHoursPage({
  menu,
  page,
}: {
  menu: MenuState;
  page: Page;
}) {
  const [data, setData] = useState<{
    calendars: CalendarRow[];
    assignments: Assignment[];
    brands: Named[];
    teams: Named[];
  } | null>(null);
  const [editing, setEditing] = useState<CalendarRow | "new" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(
    () =>
      api<NonNullable<typeof data>>("calendars")
        .then(setData)
        .catch((e) =>
          setError(message(e, "Office hours could not be loaded.")),
        ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function assign(
    scope: Assignment["scope"],
    scopeId: string,
    calendarId: string,
    label: string,
  ) {
    setError("");
    try {
      await api("calendars", {
        op: "assign",
        scope,
        scopeId,
        calendarId: calendarId || null,
      });
      setNotice(`Saved ${label}'s office hours.`);
      void load();
    } catch (e) {
      setError(message(e, "The office hours could not be assigned."));
    }
  }
  const assigned = (scope: Assignment["scope"], scopeId: string) =>
    data?.assignments.find((a) => a.scope === scope && a.scopeId === scopeId)
      ?.calendarId ?? "";
  const choose = (
    label: string,
    scope: Assignment["scope"],
    scopeId: string,
    none: string,
  ) => (
    <Field label={label}>
      {(id) => (
        <select
          id={id}
          value={assigned(scope, scopeId)}
          onChange={(e) => void assign(scope, scopeId, e.target.value, label)}
        >
          <option value="">{none}</option>
          {data?.calendars.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="pg-settings-notice">
          {notice}
        </p>
      )}
      <Card
        title="Calendars"
        description="When your team is working. SLA targets in business hours only count time inside them. Changing a calendar publishes a new version: clocks already running keep the hours they started with."
      >
        {data && !data.calendars.length && (
          <p className="pg-muted">
            No calendars yet: everything counts as open.
          </p>
        )}
        <ul className="pg-settings-list" aria-label="Calendars">
          {data?.calendars.map((c) => (
            <li key={c.id}>
              <span>
                <strong>{c.name}</strong>
                <small className="pg-muted">
                  {c.calendar.timezone} · {weekSummary(c.calendar.weekly)}
                  {c.calendar.holidays?.length
                    ? ` · ${c.calendar.holidays.length} ${c.calendar.holidays.length === 1 ? "holiday" : "holidays"}`
                    : ""}{" "}
                  · version {c.version}
                </small>
              </span>
              <button
                type="button"
                aria-label={`Edit ${c.name}`}
                onClick={() => setEditing(c)}
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
        {!editing && (
          <div>
            <button type="button" onClick={() => setEditing("new")}>
              New calendar
            </button>
          </div>
        )}
      </Card>
      {editing && (
        <CalendarEditor
          key={editing === "new" ? "new" : editing.id + editing.version}
          row={editing === "new" ? null : editing}
          onSaved={(name) => {
            setEditing(null);
            setNotice(`Published ${name}.`);
            void load();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {data && data.calendars.length > 0 && (
        <Card
          title="Who uses which hours"
          description="A conversation uses its team's hours, else its brand's, else the workspace's. With none, it counts as always open."
        >
          {choose("Workspace", "workspace", "", "Always open")}
          {data.brands.map((b) =>
            choose(`Brand: ${b.name}`, "brand", b.id, "The workspace's hours"),
          )}
          {data.teams.map((t) =>
            choose(
              `Team: ${t.name}`,
              "team",
              t.id,
              "The brand's or workspace's hours",
            ),
          )}
        </Card>
      )}
    </Frame>
  );
}

function CalendarEditor({
  row,
  onSaved,
  onCancel,
}: {
  row: CalendarRow | null;
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const start = row?.calendar ?? {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekly: Object.fromEntries(
      ["1", "2", "3", "4", "5"].map((d) => [d, [["09:00", "17:00"] as Window]]),
    ),
    holidays: [],
  };
  const [name, setName] = useState(row?.name ?? "");
  const [timezone, setTimezone] = useState(start.timezone);
  const [weekly, setWeekly] = useState<Record<string, Window[]>>(start.weekly);
  const [holidays, setHolidays] = useState<string[]>(start.holidays ?? []);
  const [holiday, setHoliday] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const setDay = (day: string, ws: Window[]) =>
    setWeekly((w) => ({ ...w, [day]: ws }));
  async function save() {
    const bad = Object.values(weekly)
      .flat()
      .some(([a, b]) => !TIME.test(a) || !TIME.test(b));
    if (bad) {
      setError(
        "Write times as HH:MM, such as 09:00 or 17:30 (24:00 for midnight).",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("calendars", {
        ...(row ? { id: row.id, version: row.version } : {}),
        name,
        timezone,
        weekly: Object.fromEntries(
          Object.entries(weekly).filter(([, ws]) => ws.length),
        ),
        holidays,
        special: row?.calendar.special ?? {},
      });
      onSaved(name.trim());
    } catch (e) {
      setError(message(e, "The calendar could not be published."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="pg-settings-card"
      aria-label={row ? `Edit ${row.name}` : "New calendar"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>{row ? `Edit ${row.name}` : "New calendar"}</h3>
      <div className="pg-settings-row">
        <Field label="Calendar name">
          {(id) => (
            <input
              id={id}
              value={name}
              maxLength={80}
              required
              placeholder="Support hours"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="Timezone">
          {(id) => (
            <select
              id={id}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            >
              {timezones(timezone).map((z) => (
                <option key={z} value={z}>
                  {z.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <fieldset className="pg-settings-fieldset">
        <legend>Weekly hours</legend>
        <p className="pg-muted pg-settings-small">
          A closing time is exclusive: 17:00 means open until five. Hours past
          midnight, like 22:00–06:00, run into the next day.
        </p>
        {WEEK.map(([day, label]) => {
          const ws = weekly[day] ?? [];
          return (
            <div
              key={day}
              className="pg-settings-day"
              role="group"
              aria-label={label}
            >
              <label className="pg-settings-toggle">
                <input
                  type="checkbox"
                  checked={ws.length > 0}
                  onChange={(e) =>
                    setDay(day, e.target.checked ? [["09:00", "17:00"]] : [])
                  }
                />
                <span>{label}</span>
              </label>
              <div className="pg-settings-windows">
                {!ws.length && <span className="pg-muted">Closed</span>}
                {ws.map(([a, b], i) => (
                  <span key={i} className="pg-settings-window">
                    <input
                      aria-label={`${label} opens`}
                      value={a}
                      size={5}
                      onChange={(e) =>
                        setDay(
                          day,
                          ws.map((w, j) =>
                            j === i ? [e.target.value, w[1]] : w,
                          ),
                        )
                      }
                    />
                    to
                    <input
                      aria-label={`${label} closes`}
                      value={b}
                      size={5}
                      onChange={(e) =>
                        setDay(
                          day,
                          ws.map((w, j) =>
                            j === i ? [w[0], e.target.value] : w,
                          ),
                        )
                      }
                    />
                    <button
                      type="button"
                      aria-label={`Remove ${label} hours ${a} to ${b}`}
                      onClick={() =>
                        setDay(
                          day,
                          ws.filter((_, j) => j !== i),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
                {ws.length > 0 && ws.length < 6 && (
                  <button
                    type="button"
                    className="pg-link-button"
                    onClick={() => setDay(day, [...ws, ["13:00", "17:00"]])}
                  >
                    Add hours
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </fieldset>
      <fieldset className="pg-settings-fieldset">
        <legend>Holidays</legend>
        <p className="pg-muted pg-settings-small">
          Closed all day, in the calendar&apos;s timezone.
        </p>
        <div className="pg-settings-row">
          <input
            type="date"
            aria-label="Holiday date"
            value={holiday}
            onChange={(e) => setHoliday(e.target.value)}
          />
          <button
            type="button"
            disabled={!holiday || holidays.includes(holiday)}
            onClick={() => {
              setHolidays((h) => [...h, holiday].sort());
              setHoliday("");
            }}
          >
            Add holiday
          </button>
        </div>
        {holidays.length > 0 && (
          <ul className="pg-settings-chips" aria-label="Holidays">
            {holidays.map((d) => (
              <li key={d}>
                {d}
                <button
                  type="button"
                  aria-label={`Remove holiday ${d}`}
                  onClick={() => setHolidays((h) => h.filter((x) => x !== d))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <footer className="pg-settings-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="pg-primary" disabled={busy}>
          Publish
        </button>
      </footer>
    </form>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* SLAs                                                                                         */

type Metric =
  "first_response" | "next_response" | "time_to_close" | "time_to_resolve";
type Policy = {
  id: string;
  name: string;
  position: number;
  conditions: ViewFilter | null;
  targets: Partial<Record<Metric, number>>;
  hours: "business" | "always";
  pause: { snoozed?: boolean; waiting_on_customer?: boolean };
  enabled: boolean;
  version: string;
};
const METRICS: [Metric, string, string][] = [
  [
    "first_response",
    "First response",
    "From the customer's first message to your first reply.",
  ],
  [
    "next_response",
    "Next response",
    "From each later customer message to your next reply.",
  ],
  [
    "time_to_close",
    "Time to close",
    "From the start of the conversation until it's closed.",
  ],
  [
    "time_to_resolve",
    "Time to resolve",
    "Tickets: from creation until a resolved state.",
  ],
];
const UNITS: [string, number][] = [
  ["minutes", 60_000],
  ["hours", 3_600_000],
  ["days", 86_400_000],
];
/** "30m", "4h", "1d 2h": a target as people read it. */
export function duration(ms: number) {
  const d = Math.floor(ms / 86_400_000),
    h = Math.floor((ms % 86_400_000) / 3_600_000),
    m = Math.round((ms % 3_600_000) / 60_000);
  return (
    [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(" ") || "0m"
  );
}
/** The largest unit a target divides into exactly, for the editor. */
const split = (ms: number | undefined): [string, string] => {
  if (!ms) return ["", "hours"];
  for (const [unit, size] of [...UNITS].reverse())
    if (ms % size === 0) return [String(ms / size), unit];
  return [String(Math.round(ms / 60_000)), "minutes"];
};
const fields = (p: Policy) => ({
  name: p.name,
  position: p.position,
  conditions: p.conditions,
  targets: p.targets,
  hours: p.hours,
  pause: p.pause,
  enabled: p.enabled,
});

export function SlasPage({ menu, page }: { menu: MenuState; page: Page }) {
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [editing, setEditing] = useState<Policy | "new" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api<{ policies: Policy[] }>("sla-policies")
        .then((r) =>
          setPolicies([...r.policies].sort((a, b) => a.position - b.position)),
        )
        .catch((e) => setError(message(e, "SLAs could not be loaded."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  /** Reorders by saving each moved policy's new position (each from its own version). */
  async function move(index: number, by: -1 | 1) {
    if (!policies) return;
    const order = [...policies];
    const [p] = order.splice(index, 1);
    order.splice(index + by, 0, p);
    setBusy(true);
    setError("");
    try {
      for (const [i, q] of order.entries())
        if (q.position !== i)
          await api("sla-policies", {
            id: q.id,
            version: q.version,
            ...fields(q),
            position: i,
          });
      setNotice(`Moved ${p.name}.`);
    } catch (e) {
      setError(message(e, "The order could not be saved."));
    } finally {
      setBusy(false);
      void load();
    }
  }
  async function archive(p: Policy) {
    setBusy(true);
    setError("");
    try {
      await api("sla-policies", {
        op: "archive",
        id: p.id,
        version: p.version,
      });
      setNotice(`Archived ${p.name}. Open conversations are being re-checked.`);
    } catch (e) {
      setError(message(e, "The policy could not be archived."));
    } finally {
      setBusy(false);
      void load();
    }
  }
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="pg-settings-notice">
          {notice}
        </p>
      )}
      <Card
        title="Policies"
        description="Response and resolution targets. A conversation follows the first enabled policy that applies to it, from the top. Clocks pause while a conversation is snoozed or waiting on the customer, as each policy says."
      >
        {policies && !policies.length && (
          <p className="pg-muted">No SLAs yet.</p>
        )}
        <ol className="pg-settings-list" aria-label="SLA policies">
          {policies?.map((p, i) => (
            <li key={p.id}>
              <span>
                <strong>
                  {p.name}
                  {!p.enabled && <span className="pg-settings-badge">Off</span>}
                </strong>
                <small className="pg-muted">
                  {METRICS.filter(([m]) => p.targets[m])
                    .map(
                      ([m, label]) =>
                        `${label.toLowerCase()} ${duration(p.targets[m]!)}`,
                    )
                    .join(" · ")}{" "}
                  · {p.hours === "business" ? "business hours" : "all hours"} ·{" "}
                  {p.conditions
                    ? "matching conversations"
                    : "every conversation"}
                </small>
              </span>
              <span className="pg-settings-buttons">
                <button
                  type="button"
                  disabled={busy || i === 0}
                  aria-label={`Move ${p.name} up`}
                  onClick={() => void move(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={busy || i === policies.length - 1}
                  aria-label={`Move ${p.name} down`}
                  onClick={() => void move(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Edit ${p.name}`}
                  onClick={() => setEditing(p)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Archive ${p.name}`}
                  onClick={() => void archive(p)}
                >
                  Archive
                </button>
              </span>
            </li>
          ))}
        </ol>
        {!editing && (
          <div>
            <button type="button" onClick={() => setEditing("new")}>
              New SLA
            </button>
          </div>
        )}
      </Card>
      {editing && (
        <PolicyEditor
          key={editing === "new" ? "new" : editing.id + editing.version}
          policy={editing === "new" ? null : editing}
          position={
            // A new policy goes to the bottom: it applies only where none above it does.
            editing === "new"
              ? Math.max(-1, ...(policies ?? []).map((p) => p.position)) + 1
              : editing.position
          }
          onSaved={(name) => {
            setEditing(null);
            setNotice(
              `Saved ${name}. Open conversations are being re-checked.`,
            );
            void load();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </Frame>
  );
}

function PolicyEditor({
  policy,
  position,
  onSaved,
  onCancel,
}: {
  policy: Policy | null;
  position: number;
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(policy?.name ?? "");
  const [enabled, setEnabled] = useState(policy?.enabled ?? true);
  const [targets, setTargets] = useState<Record<Metric, [string, string]>>(
    () =>
      Object.fromEntries(
        METRICS.map(([m]) => [m, split(policy?.targets[m])]),
      ) as Record<Metric, [string, string]>,
  );
  const [hours, setHours] = useState<Policy["hours"]>(
    policy?.hours ?? "business",
  );
  const [snoozed, setSnoozed] = useState(policy?.pause.snoozed ?? true);
  const [waiting, setWaiting] = useState(
    policy?.pause.waiting_on_customer ?? true,
  );
  const [conditions, setConditions] = useState<ViewFilter | null>(
    policy?.conditions ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    const t: Partial<Record<Metric, number>> = {};
    for (const [m] of METRICS) {
      const [value, unit] = targets[m];
      if (!value.trim()) continue;
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        setError("Targets are positive numbers, or blank for none.");
        return;
      }
      t[m] = Math.round(n * UNITS.find(([u]) => u === unit)![1]);
    }
    setBusy(true);
    setError("");
    try {
      await api("sla-policies", {
        ...(policy ? { id: policy.id, version: policy.version } : {}),
        name,
        position,
        conditions,
        targets: t,
        hours,
        pause: { snoozed, waiting_on_customer: waiting },
        enabled,
      });
      onSaved(name.trim());
    } catch (e) {
      setError(message(e, "The SLA could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="pg-settings-card"
      aria-label={policy ? `Edit ${policy.name}` : "New SLA"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>{policy ? `Edit ${policy.name}` : "New SLA"}</h3>
      <Field label="Policy name">
        {(id) => (
          <input
            id={id}
            value={name}
            maxLength={80}
            required
            placeholder="Standard support"
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <label className="pg-settings-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>
          <strong>On</strong>
          <small className="pg-muted">
            An off policy is kept but applies to nothing.
          </small>
        </span>
      </label>
      <fieldset className="pg-settings-fieldset">
        <legend>Targets</legend>
        <p className="pg-muted pg-settings-small">
          Leave a target blank to not measure it. At least one is needed.
        </p>
        {METRICS.map(([m, label, help]) => (
          <div key={m} className="pg-settings-target">
            <span>
              <strong>{label}</strong>
              <small className="pg-muted">{help}</small>
            </span>
            <input
              aria-label={`${label} target`}
              inputMode="decimal"
              size={5}
              value={targets[m][0]}
              onChange={(e) =>
                setTargets({ ...targets, [m]: [e.target.value, targets[m][1]] })
              }
            />
            <select
              aria-label={`${label} unit`}
              value={targets[m][1]}
              onChange={(e) =>
                setTargets({ ...targets, [m]: [targets[m][0], e.target.value] })
              }
            >
              {UNITS.map(([u]) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </div>
        ))}
      </fieldset>
      <fieldset className="pg-settings-fieldset">
        <legend>Time counted</legend>
        {(
          [
            [
              "business",
              "Business hours",
              "Only time inside the conversation's office hours counts.",
            ],
            ["always", "All hours", "Every hour counts, day and night."],
          ] as const
        ).map(([value, label, help]) => (
          <label key={value} className="pg-settings-toggle">
            <input
              type="radio"
              name="hours"
              checked={hours === value}
              onChange={() => setHours(value)}
            />
            <span>
              <strong>{label}</strong>
              <small className="pg-muted">{help}</small>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="pg-settings-fieldset">
        <legend>Pause the clocks</legend>
        <label className="pg-settings-toggle">
          <input
            type="checkbox"
            checked={snoozed}
            onChange={(e) => setSnoozed(e.target.checked)}
          />
          <span>While the conversation is snoozed</span>
        </label>
        <label className="pg-settings-toggle">
          <input
            type="checkbox"
            checked={waiting}
            onChange={(e) => setWaiting(e.target.checked)}
          />
          <span>While waiting on the customer</span>
        </label>
      </fieldset>
      <fieldset className="pg-settings-fieldset">
        <legend>Applies to</legend>
        <label className="pg-settings-toggle">
          <input
            type="radio"
            name="applies"
            checked={!conditions}
            onChange={() => setConditions(null)}
          />
          <span>Every conversation</span>
        </label>
        <label className="pg-settings-toggle">
          <input
            type="radio"
            name="applies"
            checked={!!conditions}
            onChange={() =>
              setConditions({ field: "priority", op: "eq", value: true })
            }
          />
          <span>Only conversations that match</span>
        </label>
        {conditions && (
          <FilterEditor value={conditions} onChange={setConditions} />
        )}
      </fieldset>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <footer className="pg-settings-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="pg-primary" disabled={busy}>
          {policy ? "Save SLA" : "Create SLA"}
        </button>
      </footer>
    </form>
  );
}
