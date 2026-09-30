import test from "node:test";
import assert from "node:assert/strict";
import {
  ALWAYS_OPEN,
  businessBetween,
  clock,
  dueAt,
  validCalendar,
  type Calendar,
  type Window,
} from "../server/business-time";

/**
 * The SLA clock acceptance matrix (phase 05, step B1): office-hours boundaries, holidays,
 * timezones, daylight saving, snooze and reopen, all to the millisecond. Expected values are
 * worked out by hand from the calendar rules; a minute-by-minute reference implementation
 * then checks the engine on generated cases.
 */
const H = 3_600_000,
  M = 60_000;
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString();
const weekdays = (windows: Window[], days = ["1", "2", "3", "4", "5"]) =>
  Object.fromEntries(days.map((d) => [d, windows]));
const office = (timezone: string, extra: Partial<Calendar> = {}): Calendar => ({
  timezone,
  weekly: weekdays([["09:00", "17:00"]]),
  ...extra,
});
const london = office("Europe/London");
const due = (c: Calendar, start: string, ms: number) =>
  iso(dueAt(c, at(start), ms));
const between = (c: Calendar, a: string, b: string) =>
  businessBetween(c, at(a), at(b));

test("office-hours boundaries (Europe/London, Mon–Fri 09:00–17:00)", () => {
  // The phase prompt's example: four hours from 17:00 Friday is due Monday morning.
  assert.equal(
    due(london, "2026-01-09T17:00:00Z", 4 * H),
    "2026-01-12T13:00:00.000Z",
  );
  assert.equal(
    due(london, "2026-01-09T16:00:00Z", 4 * H),
    "2026-01-12T12:00:00.000Z",
  );
  assert.equal(
    due(london, "2026-01-10T11:00:00Z", 1 * H),
    "2026-01-12T10:00:00.000Z",
    "from a Saturday",
  );
  assert.equal(
    due(london, "2026-01-12T07:30:00Z", 30 * M),
    "2026-01-12T09:30:00.000Z",
    "before opening",
  );
  assert.equal(
    due(london, "2026-01-12T09:00:00Z", 8 * H),
    "2026-01-12T17:00:00.000Z",
    "due exactly at closing",
  );
  assert.equal(
    due(london, "2026-01-12T17:00:00Z", 1),
    "2026-01-13T09:00:00.001Z",
    "from exactly at closing",
  );
  assert.equal(
    due(london, "2026-01-12T09:00:00Z", 8 * H + 1),
    "2026-01-13T09:00:00.001Z",
  );
  assert.equal(
    due(london, "2026-01-12T16:59:59.500Z", 1000),
    "2026-01-13T09:00:00.500Z",
    "millisecond precision",
  );
  assert.equal(
    between(london, "2026-01-09T12:00:00Z", "2026-01-12T12:00:00Z"),
    8 * H,
  );
  assert.equal(
    between(london, "2026-01-10T00:00:00Z", "2026-01-11T23:59:59Z"),
    0,
    "weekend",
  );
  assert.equal(
    between(london, "2026-01-12T17:00:00Z", "2026-01-13T09:00:00Z"),
    0,
    "overnight closed",
  );
  assert.equal(
    due(london, "2026-01-12T10:00:00Z", 0),
    "2026-01-12T10:00:00.000Z",
    "zero target",
  );
  assert.equal(
    due(london, "2026-01-10T10:00:00Z", 0),
    "2026-01-10T10:00:00.000Z",
    "zero target while closed",
  );
});

test("holidays, special days, the year boundary and a leap day", () => {
  assert.equal(
    due(
      office("Europe/London", { holidays: ["2026-01-12"] }),
      "2026-01-09T17:00:00Z",
      4 * H,
    ),
    "2026-01-13T13:00:00.000Z",
    "a Monday holiday moves Friday evening's target to Tuesday",
  );
  const christmas = office("Europe/London", {
    special: { "2026-12-24": [["09:00", "13:00"]] },
    holidays: ["2026-12-25", "2026-12-28"],
  });
  assert.equal(
    due(christmas, "2026-12-24T12:00:00Z", 3 * H),
    "2026-12-29T11:00:00.000Z",
    "short Christmas Eve, then consecutive holidays",
  );
  assert.equal(
    between(christmas, "2026-12-24T00:00:00Z", "2026-12-25T00:00:00Z"),
    4 * H,
  );
  const newYear = office("Europe/London", { holidays: ["2027-01-01"] });
  assert.equal(
    due(newYear, "2026-12-31T16:00:00Z", 2 * H),
    "2027-01-04T10:00:00.000Z",
    "across New Year",
  );
  const leap = office("Europe/London", { holidays: ["2028-02-29"] });
  assert.equal(
    due(leap, "2028-02-28T16:00:00Z", 2 * H),
    "2028-03-01T10:00:00.000Z",
    "29 February 2028 as a holiday",
  );
  assert.equal(
    between(
      office("Europe/London"),
      "2028-02-28T00:00:00Z",
      "2028-03-02T00:00:00Z",
    ),
    24 * H,
    "Mon 28, Tue 29, Wed 1 March",
  );
  // A special day can open a weekend, or close a weekday.
  const saturday = office("Europe/London", {
    special: { "2026-01-10": [["10:00", "12:00"]], "2026-01-12": [] },
  });
  assert.equal(
    due(saturday, "2026-01-09T17:00:00Z", 3 * H),
    "2026-01-13T10:00:00.000Z",
  );
});

test("timezones: half-hour, 45-minute and +14 offsets; weekdays are local", () => {
  const india: Calendar = {
    timezone: "Asia/Kolkata",
    weekly: weekdays([["09:00", "18:00"]]),
  };
  assert.equal(
    due(india, "2026-01-09T12:30:00Z", 1 * H),
    "2026-01-12T04:30:00.000Z",
    "IST +05:30",
  );
  assert.equal(
    due(office("America/St_Johns"), "2026-01-12T12:00:00Z", 1 * H),
    "2026-01-12T13:30:00.000Z",
    "NST -03:30",
  );
  assert.equal(
    due(office("Pacific/Chatham"), "2026-01-11T19:00:00Z", 30 * M),
    "2026-01-11T19:45:00.000Z",
    "CHADT +13:45",
  );
  // Monday in Kiritimati begins while it is still Sunday in UTC.
  assert.equal(
    due(office("Pacific/Kiritimati"), "2026-01-11T12:00:00Z", 8 * H),
    "2026-01-12T03:00:00.000Z",
    "+14:00",
  );
  // The same hours in a new calendar version with a different timezone give a different due
  // time; which version a clock uses is pinned when it starts (tests/calendars.test.ts).
  assert.equal(
    due(office("America/New_York"), "2026-01-09T17:00:00Z", 4 * H),
    "2026-01-09T21:00:00.000Z",
  );
});

test("daylight saving: London, New York and Lord Howe's 30-minute shift", () => {
  const sunday = (timezone: string, w: Window[]): Calendar => ({
    timezone,
    weekly: { "0": w },
  });
  // Spring forward: 00:00–04:00 is 3 real hours; a skipped hour is never open.
  assert.equal(
    between(
      sunday("Europe/London", [["00:00", "04:00"]]),
      "2026-03-28T00:00:00Z",
      "2026-03-30T00:00:00Z",
    ),
    3 * H,
  );
  assert.equal(
    between(
      sunday("Europe/London", [["01:00", "02:00"]]),
      "2026-03-28T00:00:00Z",
      "2026-03-30T00:00:00Z",
    ),
    0,
  );
  // Fall back: 5 real hours; a repeated hour counts twice.
  assert.equal(
    between(
      sunday("Europe/London", [["00:00", "04:00"]]),
      "2026-10-24T00:00:00Z",
      "2026-10-26T00:00:00Z",
    ),
    5 * H,
  );
  assert.equal(
    between(
      sunday("Europe/London", [["01:00", "02:00"]]),
      "2026-10-24T00:00:00Z",
      "2026-10-26T00:00:00Z",
    ),
    2 * H,
  );
  assert.equal(
    between(
      sunday("America/New_York", [["01:00", "04:00"]]),
      "2026-03-07T00:00:00Z",
      "2026-03-09T12:00:00Z",
    ),
    2 * H,
  );
  assert.equal(
    between(
      sunday("America/New_York", [["01:00", "04:00"]]),
      "2026-10-31T00:00:00Z",
      "2026-11-02T12:00:00Z",
    ),
    4 * H,
  );
  assert.equal(
    between(
      sunday("Australia/Lord_Howe", [["00:00", "04:00"]]),
      "2026-10-03T00:00:00Z",
      "2026-10-05T00:00:00Z",
    ),
    3.5 * H,
  );
  assert.equal(
    between(
      sunday("Australia/Lord_Howe", [["00:00", "04:00"]]),
      "2026-04-04T00:00:00Z",
      "2026-04-06T00:00:00Z",
    ),
    4.5 * H,
  );
  // Office hours across the change: the same local hours, a different UTC hour.
  assert.equal(
    due(london, "2026-03-27T16:00:00Z", 2 * H),
    "2026-03-30T09:00:00.000Z",
    "GMT Friday, BST Monday",
  );
  assert.equal(
    due(london, "2026-10-23T15:00:00Z", 3 * H),
    "2026-10-26T11:00:00.000Z",
    "BST Friday, GMT Monday",
  );
  assert.equal(
    due(office("America/New_York"), "2026-03-06T21:00:00Z", 2 * H),
    "2026-03-09T14:00:00.000Z",
    "EST Friday, EDT Monday",
  );
});

test("overnight shifts, across midnight, the week boundary and a DST night", () => {
  const nights: Calendar = {
    timezone: "Europe/London",
    weekly: weekdays([["22:00", "06:00"]]),
  };
  // Friday's shift runs into Saturday morning; the next starts Monday night.
  assert.equal(
    due(nights, "2026-01-10T05:00:00Z", 2 * H),
    "2026-01-12T23:00:00.000Z",
  );
  assert.equal(
    between(nights, "2026-01-09T12:00:00Z", "2026-01-10T12:00:00Z"),
    8 * H,
  );
  const sundayNight: Calendar = {
    timezone: "Europe/London",
    weekly: { "0": [["22:00", "06:00"]] },
  };
  assert.equal(
    due(sundayNight, "2026-01-11T23:00:00Z", 6 * H),
    "2026-01-12T05:00:00.000Z",
    "Sunday night into Monday",
  );
  // A shift belongs to the day it starts: a Sunday holiday cancels all of it, a Monday one none.
  assert.equal(
    between(
      { ...sundayNight, holidays: ["2026-01-11"] },
      "2026-01-11T00:00:00Z",
      "2026-01-13T00:00:00Z",
    ),
    0,
  );
  assert.equal(
    between(
      { ...sundayNight, holidays: ["2026-01-12"] },
      "2026-01-11T00:00:00Z",
      "2026-01-13T00:00:00Z",
    ),
    8 * H,
  );
  const saturdayNight: Calendar = {
    timezone: "Europe/London",
    weekly: { "6": [["22:00", "06:00"]] },
  };
  assert.equal(
    between(saturdayNight, "2026-03-28T00:00:00Z", "2026-03-30T00:00:00Z"),
    7 * H,
    "the spring-forward night is an hour short",
  );
  // Adjoining windows (a night shift and a day shift) merge into one open stretch.
  const around: Calendar = {
    timezone: "UTC",
    weekly: { "1": [["00:00", "24:00"]], "0": [["22:00", "06:00"]] },
  };
  assert.equal(
    due(around, "2026-01-11T23:00:00Z", 10 * H),
    "2026-01-12T09:00:00.000Z",
  );
});

test("clocks: snooze across closed hours, breach, met at the deadline, reopen after close, a holiday pause", () => {
  const C = (events: [string, "start" | "pause" | "resume" | "stop"][]) =>
    events.map(([t, type]) => ({ at: at(t), type }));
  const view = (s: ReturnType<typeof clock>) => ({
    ...s,
    dueAt: iso(s.dueAt),
    breachedAt: iso(s.breachedAt),
  });
  const snoozed = C([
    ["2026-01-12T15:00:00Z", "start"],
    ["2026-01-12T16:00:00Z", "pause"],
    ["2026-01-13T11:00:00Z", "resume"],
  ]);
  assert.deepEqual(
    view(clock(london, 4 * H, snoozed, at("2026-01-13T12:00:00Z"))),
    {
      state: "running",
      elapsedMs: 2 * H,
      remainingMs: 2 * H,
      dueAt: "2026-01-13T14:00:00.000Z",
      breached: false,
      breachedAt: null,
    },
  );
  // Paused: no due time, nothing accrues (even during open hours).
  assert.deepEqual(
    view(clock(london, 4 * H, snoozed, at("2026-01-13T10:00:00Z"))),
    {
      state: "paused",
      elapsedMs: 1 * H,
      remainingMs: 3 * H,
      dueAt: null,
      breached: false,
      breachedAt: null,
    },
  );
  assert.deepEqual(
    view(clock(london, 4 * H, snoozed, at("2026-01-13T14:30:00Z"))),
    {
      state: "running",
      elapsedMs: 4.5 * H,
      remainingMs: -0.5 * H,
      dueAt: "2026-01-13T14:00:00.000Z",
      breached: true,
      breachedAt: "2026-01-13T14:00:00.000Z",
    },
  );
  const met = clock(
    london,
    4 * H,
    [...snoozed, { at: at("2026-01-13T14:00:00Z"), type: "stop" }],
    at("2026-01-14T12:00:00Z"),
  );
  assert.deepEqual(
    [met.state, met.elapsedMs, met.breached],
    ["stopped", 4 * H, false],
    "stopped exactly at the due time: met",
  );
  const late = clock(
    london,
    4 * H,
    [...snoozed, { at: at("2026-01-13T14:00:00.001Z"), type: "stop" }],
    at("2026-01-14T12:00:00Z"),
  );
  assert.deepEqual(
    [late.breached, iso(late.breachedAt)],
    [true, "2026-01-13T14:00:00.000Z"],
    "a millisecond late: breached",
  );
  // Breach is kept after the clock stops.
  // Reopen after close: the clock continues from the time already used.
  const reopened = C([
    ["2026-01-12T09:00:00Z", "start"],
    ["2026-01-12T13:00:00Z", "stop"],
    ["2026-01-14T09:00:00Z", "start"],
  ]);
  const r = clock(london, 8 * H, reopened, at("2026-01-14T10:00:00Z"));
  assert.deepEqual(
    [r.state, r.elapsedMs, iso(r.dueAt)],
    ["running", 5 * H, "2026-01-14T13:00:00.000Z"],
  );
  assert.equal(
    clock(london, 8 * H, reopened, at("2026-01-13T12:00:00Z")).state,
    "stopped",
  );
  // A pause and resume that straddle a holiday.
  const holiday = office("Europe/London", { holidays: ["2026-01-13"] });
  const straddle = C([
    ["2026-01-12T16:00:00Z", "start"],
    ["2026-01-12T16:30:00Z", "pause"],
    ["2026-01-13T10:00:00Z", "resume"],
  ]);
  const h = clock(holiday, 2 * H, straddle, at("2026-01-14T10:00:00Z"));
  assert.deepEqual(
    [h.elapsedMs, iso(h.dueAt)],
    [1.5 * H, "2026-01-14T10:30:00.000Z"],
  );
  // Repeated events are ignored; events after now are not counted; no events: not started.
  const repeated = clock(
    london,
    4 * H,
    C([
      ["2026-01-12T09:00:00Z", "start"],
      ["2026-01-12T10:00:00Z", "start"],
      ["2026-01-12T11:00:00Z", "pause"],
      ["2026-01-12T12:00:00Z", "pause"],
      ["2026-01-12T15:00:00Z", "resume"],
    ]),
    at("2026-01-12T13:00:00Z"),
  );
  assert.deepEqual([repeated.state, repeated.elapsedMs], ["paused", 2 * H]);
  assert.equal(
    clock(london, H, [], at("2026-01-12T13:00:00Z")).state,
    "not_started",
  );
  // Started while closed: nothing accrues until opening.
  const weekend = clock(
    london,
    H,
    C([["2026-01-10T10:00:00Z", "start"]]),
    at("2026-01-11T10:00:00Z"),
  );
  assert.deepEqual(
    [weekend.elapsedMs, iso(weekend.dueAt)],
    [0, "2026-01-12T10:00:00.000Z"],
  );
  // Target already used when reopened, reopened while closed: not breached until open time passes.
  const used = C([
    ["2026-01-12T09:00:00Z", "start"],
    ["2026-01-12T10:00:00Z", "stop"],
    ["2026-01-12T20:00:00Z", "start"],
  ]);
  assert.equal(
    clock(london, H, used, at("2026-01-13T08:00:00Z")).breached,
    false,
  );
  const overdue = clock(london, H, used, at("2026-01-13T09:00:01Z"));
  assert.deepEqual(
    [overdue.breached, iso(overdue.breachedAt)],
    [true, "2026-01-13T09:00:00.000Z"],
  );
});

test("always open: 24/7 needs no calendar and ignores daylight saving", () => {
  assert.equal(
    iso(dueAt(ALWAYS_OPEN, at("2026-03-29T00:30:00Z"), 5 * H + 7)),
    "2026-03-29T05:30:00.007Z",
  );
  assert.equal(
    businessBetween(
      ALWAYS_OPEN,
      at("2026-01-09T17:00:00Z"),
      at("2026-01-12T17:00:00Z"),
    ),
    72 * H,
  );
});

test("calendar validation", () => {
  const bad = (input: Record<string, unknown>, message: RegExp) =>
    assert.throws(
      () => validCalendar(input),
      (e: any) => e.code === "INVALID_CALENDAR" && message.test(e.message),
    );
  bad(
    { timezone: "Mars/Olympus", weekly: weekdays([["09:00", "17:00"]]) },
    /IANA timezone/,
  );
  bad({ timezone: "UTC", weekly: {} }, /open at some time each week/);
  bad(
    {
      timezone: "UTC",
      weekly: { "1": [] },
      special: { "2026-01-10": [["09:00", "17:00"]] },
    },
    /open at some time each week/,
  );
  bad(
    {
      timezone: "UTC",
      weekly: {
        "1": [
          ["09:00", "13:00"],
          ["12:00", "17:00"],
        ],
      },
    },
    /overlap/,
  );
  bad(
    {
      timezone: "UTC",
      weekly: {
        "1": [
          ["22:00", "06:00"],
          ["23:00", "23:30"],
        ],
      },
    },
    /overlap/,
  );
  bad({ timezone: "UTC", weekly: { "1": [["25:00", "26:00"]] } }, /HH:MM/);
  bad(
    { timezone: "UTC", weekly: { "1": [["24:00", "06:00"]] } },
    /different end/,
  );
  bad(
    { timezone: "UTC", weekly: { "1": [["09:00", "09:00"]] } },
    /different end/,
  );
  bad(
    { timezone: "UTC", weekly: { "7": [["09:00", "17:00"]] } },
    /0 \(Sunday\) to 6/,
  );
  bad(
    {
      timezone: "UTC",
      weekly: { "1": [["09:00", "17:00"]] },
      holidays: ["2026-02-30"],
    },
    /YYYY-MM-DD/,
  );
  bad(
    {
      timezone: "UTC",
      weekly: { "1": [["09:00", "17:00"]] },
      special: { tomorrow: [] },
    },
    /YYYY-MM-DD/,
  );
  assert.deepEqual(
    validCalendar({
      timezone: "Europe/London",
      weekly: {
        "1": [["09:00", "17:00"]],
        "5": [["22:00", "06:00"]],
        "0": [["00:00", "24:00"]],
      },
      holidays: ["2026-12-25", "2026-12-25", "2026-01-01"],
      special: { "2026-12-24": [] },
    }),
    {
      timezone: "Europe/London",
      weekly: {
        "0": [["00:00", "24:00"]],
        "1": [["09:00", "17:00"]],
        "5": [["22:00", "06:00"]],
      },
      holidays: ["2026-01-01", "2026-12-25"],
      special: { "2026-12-24": [] },
    },
  );
});

/** A small deterministic generator, so a failing case can be reproduced. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ZONES = [
  "Europe/London",
  "America/New_York",
  "Australia/Lord_Howe",
  "Asia/Kolkata",
  "Pacific/Chatham",
  "America/St_Johns",
  "UTC",
];
/** Days near DST changes and the year boundary, where bugs live. */
const AROUND = [
  "2026-03-06",
  "2026-03-27",
  "2026-04-03",
  "2026-10-02",
  "2026-10-23",
  "2026-10-30",
  "2026-12-30",
  "2028-02-27",
];

/** Reference implementation: is the minute starting at `t` open? Reads the wall clock directly. */
const referenceFormats = new Map<string, Intl.DateTimeFormat>();
function openAtMinute(c: Calendar, t: number) {
  let f = referenceFormats.get(c.timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: c.timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    referenceFormats.set(c.timezone, f);
  }
  const p = Object.fromEntries(
    f.formatToParts(t).map((x) => [x.type, x.value]),
  );
  const date = `${p.year}-${p.month}-${p.day}`;
  const minute = Number(p.hour) * 60 + Number(p.minute);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    p.weekday,
  );
  const windowsOn = (d: string, wd: number) =>
    (
      c.special?.[d] ??
      (c.holidays?.includes(d) ? [] : (c.weekly[String(wd)] ?? []))
    ).map(([a, b]) => {
      const [ah, am] = a.split(":").map(Number),
        [bh, bm] = b.split(":").map(Number);
      return [ah * 60 + am, bh * 60 + bm];
    });
  const today = windowsOn(date, weekday).some(([a, b]) =>
    b > a ? minute >= a && minute < b : minute >= a,
  );
  const prev = new Date(Date.parse(date + "T00:00:00Z") - 86_400_000)
    .toISOString()
    .slice(0, 10);
  const spill = windowsOn(prev, (weekday + 6) % 7).some(
    ([a, b]) => b <= a && minute < b,
  );
  return today || spill;
}

test("generated cases agree with a minute-by-minute reference, and due times round-trip exactly", () => {
  const rand = random(20260930);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  const time = (half: number) =>
    `${String(Math.floor(half / 2)).padStart(2, "0")}:${half % 2 ? "30" : "00"}`;
  let checked = 0;
  for (let n = 0; n < 60; n++) {
    const weekly: Record<string, Window[]> = {};
    for (let d = 0; d < 7; d++) {
      if (rand() < 0.3) continue;
      // Up to two non-overlapping windows per day; the second may cross midnight.
      const a = Math.floor(rand() * 30),
        b = a + 1 + Math.floor(rand() * 10);
      const list: Window[] = [
        [time(a), time(Math.min(b, 48)).replace("24:00", "24:00")],
      ];
      if (b < 44 && rand() < 0.5)
        list.push([time(b + 2), time((b + 3 + Math.floor(rand() * 20)) % 48)]);
      weekly[String(d)] = list;
    }
    if (!Object.keys(weekly).length) weekly["3"] = [["09:00", "17:00"]];
    const base = pick(AROUND);
    const calendar = validCalendar({
      timezone: pick(ZONES),
      weekly,
      holidays: rand() < 0.5 ? [base] : [],
      special:
        rand() < 0.3
          ? {
              [AROUND[(AROUND.indexOf(base) + 1) % AROUND.length]]: [
                ["10:00", "11:30"],
              ],
            }
          : {},
    });
    for (let k = 0; k < 2; k++) {
      const start =
        Date.parse(base + "T00:00:00Z") +
        Math.floor(rand() * 72 * 60) * M -
        12 * H;
      const end = start + Math.floor(rand() * 72 * 60) * M;
      let expected = 0;
      for (let t = start; t < end; t += M)
        if (openAtMinute(calendar, t)) expected += M;
      assert.equal(
        businessBetween(calendar, start, end),
        expected,
        JSON.stringify({ calendar, start: iso(start), end: iso(end) }),
      );
      checked++;
      // Round trip at millisecond precision, and due times never move earlier as targets grow.
      const from = start + Math.floor(rand() * M);
      let last = from;
      for (const target of [1, 1000, Math.floor(rand() * 20 * H) + 1, 30 * H]) {
        const d = dueAt(calendar, from, target);
        assert.equal(
          businessBetween(calendar, from, d),
          target,
          JSON.stringify({ calendar, from: iso(from), target }),
        );
        assert(d >= last);
        last = d;
      }
    }
  }
  assert.equal(checked, 120);
});
