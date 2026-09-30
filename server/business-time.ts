import { assert, DomainError, tenant, type Connect } from "./db";
import type { Job } from "./jobs";
import { validTimeZone } from "./snooze";

/**
 * Business time (phase 05, step B1). A calendar is a timezone plus weekly opening hours, full-
 * day holidays and special days with their own hours. Hours are wall-clock times in the
 * calendar's timezone: an instant is "open" when the local clock then reads inside a window.
 * So across daylight saving, a window's real length changes (00:00–04:00 is 3 hours on a
 * spring-forward night and 5 on a fall-back night), and a skipped local hour is never open.
 *
 * Open time is computed as intervals of real instants, exact to the millisecond. Nothing here
 * reads the clock or the database; callers pass instants in.
 */
export type Window = [string, string];
export type BusinessSchedule = {
  /** Keys "0" (Sunday) to "6" (Saturday). A window may cross midnight ("22:00"–"06:00"). */
  weekly: Record<string, Window[]>;
  /** Local dates (YYYY-MM-DD) with no opening hours. */
  holidays?: string[];
  /** Local dates with their own hours instead of the weekly ones ([] means closed). */
  special?: Record<string, Window[]>;
};
export type Calendar = BusinessSchedule & { timezone: string };

const MINUTE = 60_000,
  HOUR = 3_600_000,
  DAY = 86_400_000;
/** How far ahead a due time is searched for before the calendar is judged unusable. */
const HORIZON_DAYS = 800;

/** Open all day, every day, in UTC: the fallback when no calendar applies. */
export const ALWAYS_OPEN: Calendar = {
  timezone: "UTC",
  weekly: Object.fromEntries(
    ["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, [["00:00", "24:00"]]]),
  ) as Record<string, Window[]>,
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}
const offsets = new Map<string, number>();
/** Offset of `timeZone` from UTC at `instant` (ms). Offsets change only on whole seconds. */
export function offsetAt(instant: number, timeZone: string) {
  const second = Math.floor(instant / 1000) * 1000;
  const key = timeZone + "|" + second;
  const cached = offsets.get(key);
  if (cached !== undefined) return cached;
  const p = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(second)
      .map((x) => [x.type, Number(x.value)]),
  );
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offset = wall - second;
  if (offsets.size > 200_000) offsets.clear();
  offsets.set(key, offset);
  return offset;
}

/** [start, end, offset] runs of constant offset covering [lo, hi). */
function offsetRuns(lo: number, hi: number, timeZone: string) {
  const runs: [number, number, number][] = [];
  let runStart = lo,
    offset = offsetAt(lo, timeZone);
  // Sample hourly from an hour boundary (no zone changes offset twice within an hour), then
  // bisect to the exact second where the offset changes.
  for (let t = Math.floor(lo / HOUR) * HOUR + HOUR; t < hi; t += HOUR) {
    const next = offsetAt(t, timeZone);
    if (next === offset) continue;
    let a = Math.max(runStart, t - HOUR),
      b = t;
    while (b - a > 1000) {
      const m = a + Math.floor((b - a) / 2000) * 1000;
      if (offsetAt(m, timeZone) === offset) a = m;
      else b = m;
    }
    runs.push([runStart, b, offset]);
    runStart = b;
    offset = next;
  }
  runs.push([runStart, hi, offset]);
  return runs;
}

/**
 * The instants whose wall-clock reading lies in [localStart, localEnd), where local times are
 * expressed as if they were UTC. A skipped local hour yields nothing; a repeated one yields
 * both occurrences.
 */
function localToInstants(
  localStart: number,
  localEnd: number,
  timeZone: string,
) {
  // Real offsets lie within -12h..+14h, so matching instants lie within this range.
  const out: [number, number][] = [];
  for (const [s, e, o] of offsetRuns(
    localStart - 15 * HOUR,
    localEnd + 13 * HOUR,
    timeZone,
  )) {
    const a = Math.max(s, localStart - o),
      b = Math.min(e, localEnd - o);
    if (a < b) out.push([a, b]);
  }
  return out;
}

const minutes = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};
const isoDate = (local: number) => new Date(local).toISOString().slice(0, 10);

/** One local day's windows, as local-time ranges (a window crossing midnight belongs to its start day). */
function dayWindows(calendar: Calendar, localDay: number): [number, number][] {
  const date = isoDate(localDay);
  const windows =
    calendar.special?.[date] ??
    (calendar.holidays?.includes(date)
      ? []
      : (calendar.weekly[String(new Date(localDay).getUTCDay())] ?? []));
  return windows.map(([f, t]) => {
    const from = minutes(f);
    let to = minutes(t);
    if (to <= from) to += 24 * 60;
    return [localDay + from * MINUTE, localDay + to * MINUTE];
  });
}

/** Sorts and merges intervals. */
function merge(intervals: [number, number][]) {
  intervals.sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [a, b] of intervals) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * Open intervals of real time from `from` up to `to` (or the horizon), in order and merged,
 * clipped to [from, to).
 */
export function* openIntervals(
  calendar: Calendar,
  from: number,
  to = from + HORIZON_DAYS * DAY,
): Generator<[number, number]> {
  // Start a day early: yesterday's overnight window may still be open.
  let day =
    Math.floor((from + offsetAt(from, calendar.timezone)) / DAY) * DAY - DAY;
  const lastDay =
    Math.floor((to + offsetAt(to, calendar.timezone)) / DAY) * DAY;
  let pending: [number, number][] = [];
  for (; day <= lastDay + DAY; day += DAY) {
    for (const [ls, le] of dayWindows(calendar, day))
      for (const [a, b] of localToInstants(ls, le, calendar.timezone)) {
        const x = Math.max(a, from),
          y = Math.min(b, to);
        if (x < y) pending.push([x, y]);
      }
    pending = merge(pending);
    // Later days' windows start no earlier than their local midnight at the largest offset.
    const safe = day + DAY - 15 * HOUR;
    while (pending.length && pending[0][1] < safe) yield pending.shift()!;
  }
  yield* pending;
}

/** Business time between two instants, in milliseconds. */
export function businessBetween(
  calendar: Calendar,
  start: number,
  end: number,
) {
  let total = 0;
  if (end <= start) return 0;
  for (const [a, b] of openIntervals(calendar, start, end)) total += b - a;
  return total;
}

/**
 * The instant at which `target` ms of business time has passed since `start`. A target that
 * runs out exactly at closing is due at closing.
 */
export function dueAt(calendar: Calendar, start: number, target: number) {
  if (target <= 0) return start;
  let left = target;
  for (const [a, b] of openIntervals(calendar, start)) {
    if (b - a >= left) return a + left;
    left -= b - a;
  }
  throw new DomainError(
    "CALENDAR_UNUSABLE",
    "This calendar has no opening hours in the coming two years.",
    409,
  );
}

/** `at` if the calendar is open then, otherwise the next opening. */
function firstOpen(calendar: Calendar, at: number) {
  for (const [a] of openIntervals(calendar, at)) return a;
  return at;
}

export type ClockEvent = {
  at: number;
  /** start (or restart after stop), pause, resume, stop. */
  type: "start" | "pause" | "resume" | "stop";
};
export type ClockState = {
  state: "not_started" | "running" | "paused" | "stopped";
  elapsedMs: number;
  /** Negative once overdue. */
  remainingMs: number;
  /** When the target runs out, if the clock keeps running from now; null unless running. */
  dueAt: number | null;
  breached: boolean;
  /** The instant the target ran out, if it has. */
  breachedAt: number | null;
};

/**
 * A clock over a list of events: business time accrues only while running (between start or
 * resume and pause or stop), up to `now`. Breach means business time went past the target;
 * a clock stopped exactly at its due time has met it. Repeated events are ignored (a pause
 * while paused), and events after `now` are not yet counted.
 */
export function clock(
  calendar: Calendar,
  target: number,
  events: ClockEvent[],
  now: number,
): ClockState {
  let elapsed = 0,
    runStart: number | null = null,
    state: ClockState["state"] = "not_started",
    breachedAt: number | null = null;
  const settle = (start: number, end: number) => {
    const run = businessBetween(calendar, start, end);
    // The breach is the first open instant after the target ran out: a clock reopened after
    // its target was used, while closed, breaches only when business time next passes.
    if (breachedAt === null && elapsed + run > target)
      breachedAt = firstOpen(
        calendar,
        dueAt(calendar, start, Math.max(0, target - elapsed)),
      );
    elapsed += run;
  };
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (e.at > now) break;
    if (e.type === "start" || e.type === "resume") {
      if (runStart === null) runStart = e.at;
      state = "running";
    } else if (runStart !== null) {
      settle(runStart, e.at);
      runStart = null;
      state = e.type === "pause" ? "paused" : "stopped";
    } else if (state !== "not_started")
      state = e.type === "pause" && state === "paused" ? "paused" : "stopped";
  }
  let due: number | null = null;
  if (runStart !== null) {
    const before = elapsed;
    settle(runStart, now);
    due = breachedAt ?? dueAt(calendar, runStart, Math.max(0, target - before));
  }
  return {
    state,
    elapsedMs: elapsed,
    remainingMs: target - elapsed,
    dueAt: due,
    breached: breachedAt !== null,
    breachedAt,
  };
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const invalid = (message: string): never => {
  throw new DomainError("INVALID_CALENDAR", message, 400);
};
function windows(input: unknown, where: string): Window[] {
  if (!Array.isArray(input) || input.length > 10)
    invalid(`${where}: use up to 10 time ranges.`);
  const out = (input as unknown[]).map((w) => {
    if (
      !Array.isArray(w) ||
      w.length !== 2 ||
      !TIME.test(String(w[0])) ||
      !TIME.test(String(w[1]))
    )
      invalid(`${where}: write times as HH:MM, from 00:00 to 24:00.`);
    const [from, to] = w as [string, string];
    if (from === "24:00" || from === to)
      invalid(`${where}: a range needs a start and a different end.`);
    return [from, to] as Window;
  });
  // Within a day, ranges may not overlap (a range crossing midnight counts to 24:00).
  const spans = out
    .map(([f, t]) => [minutes(f), minutes(t) <= minutes(f) ? 1440 : minutes(t)])
    .sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < spans.length; i++)
    if (spans[i][0] < spans[i - 1][1])
      invalid(`${where}: time ranges overlap.`);
  return out;
}
const validDate = (d: unknown) =>
  typeof d === "string" &&
  DATE.test(d) &&
  new Date(d + "T00:00:00Z").toISOString().slice(0, 10) === d;

/** Checks and normalizes a calendar definition; a calendar must open at least once a week. */
export function validCalendar(input: Record<string, unknown>): Calendar {
  const timezone = (() => {
    try {
      return validTimeZone(input.timezone);
    } catch {
      return invalid("Choose an IANA timezone, such as Europe/London.");
    }
  })();
  const raw = (input.weekly ?? {}) as Record<string, unknown>;
  if (typeof raw !== "object" || Array.isArray(raw))
    invalid("Give weekly hours by weekday.");
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const weekly: Record<string, Window[]> = {};
  for (const key of Object.keys(raw))
    if (!/^[0-6]$/.test(key))
      invalid("Weekdays are 0 (Sunday) to 6 (Saturday).");
  for (let d = 0; d < 7; d++)
    if (raw[String(d)] !== undefined)
      weekly[String(d)] = windows(raw[String(d)], days[d]);
  if (!Object.values(weekly).some((w) => w.length))
    invalid("A calendar must be open at some time each week.");
  const holidays = [...new Set((input.holidays ?? []) as unknown[])];
  if (
    !Array.isArray(input.holidays ?? []) ||
    holidays.length > 500 ||
    !holidays.every(validDate)
  )
    invalid("List up to 500 holidays as YYYY-MM-DD.");
  const special: Record<string, Window[]> = {};
  const rawSpecial = (input.special ?? {}) as Record<string, unknown>;
  if (
    typeof rawSpecial !== "object" ||
    Array.isArray(rawSpecial) ||
    Object.keys(rawSpecial).length > 500
  )
    invalid("List up to 500 special days.");
  for (const [date, w] of Object.entries(rawSpecial)) {
    if (!validDate(date)) invalid("Special days are dates as YYYY-MM-DD.");
    special[date] = windows(w, date);
  }
  return {
    timezone,
    weekly,
    ...(holidays.length ? { holidays: (holidays as string[]).sort() } : {}),
    ...(Object.keys(special).length ? { special } : {}),
  };
}

/** Exact business milliseconds between two instants under a schedule (kept for metrics). */
export function businessMilliseconds(
  start: Date,
  end: Date,
  timezone: string,
  schedule: BusinessSchedule,
) {
  assert(
    Number.isFinite(start.getTime()) &&
      Number.isFinite(end.getTime()) &&
      end >= start,
    "INVALID_DURATION",
    "Invalid duration.",
  );
  return businessBetween(
    { ...schedule, timezone },
    start.getTime(),
    end.getTime(),
  );
}
export async function computeResponseMetrics(connect: Connect, job: Job) {
  const data = await tenant(
    connect,
    job.workspace_id,
    async (db) =>
      (
        await db.query<{
          id: string;
          created_at: string;
          first_response_ms: string | null;
          calendar_id: string | null;
          calendar_version: number | null;
          timezone: string | null;
          schedule: BusinessSchedule | null;
        }>(
          `SELECT c.id,c.created_at,c.first_response_ms,c.calendar_id,c.calendar_version,b.timezone,b.schedule FROM conversations c LEFT JOIN business_calendars b ON b.workspace_id=c.workspace_id AND b.id=c.calendar_id AND b.version=c.calendar_version WHERE c.workspace_id=$1 AND c.id=$2`,
          [job.workspace_id, job.payload.conversationId],
        )
      ).rows[0],
  );
  assert(data, "CONVERSATION_NOT_FOUND", "Conversation unavailable.", 404);
  if (data.first_response_ms === null || !data.timezone || !data.schedule)
    return {
      done: true,
      result: {
        conversationId: data.id,
        available: false,
        reason: "BUSINESS_CALENDAR_UNKNOWN",
      },
    };
  const start = new Date(data.created_at),
    end = new Date(start.getTime() + Number(data.first_response_ms)),
    businessMs = businessMilliseconds(start, end, data.timezone, data.schedule);
  await tenant(connect, job.workspace_id, (db) =>
    db.query(
      "UPDATE conversations SET first_response_business_ms=$3 WHERE workspace_id=$1 AND id=$2",
      [job.workspace_id, data.id, businessMs],
    ),
  );
  return {
    done: true,
    result: {
      conversationId: data.id,
      available: true,
      businessMs,
      wallMs: Number(data.first_response_ms),
      calendarId: data.calendar_id,
      calendarVersion: data.calendar_version,
    },
  };
}
