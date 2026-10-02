import { assert } from "./db";

export const SNOOZE_PRESETS = [
  "later_today",
  "tomorrow",
  "next_week",
  "one_week",
  "one_month",
] as const;
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number];

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((p) => [p.type, Number(p.value)]),
  );
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return wall - Math.floor(instant / 1000) * 1000;
}
/** Wall-clock fields of `instant` in `timeZone`. */
function wallClock(instant: number, timeZone: string) {
  const d = new Date(instant + offsetAt(instant, timeZone));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
  };
}
/**
 * The instant at which the wall clock in `timeZone` reads the given local time. Two passes
 * settle the offset across a daylight-saving change on that day.
 */
function atLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
) {
  const guess = Date.UTC(year, month, day, hour);
  let instant = guess - offsetAt(guess, timeZone);
  instant = guess - offsetAt(instant, timeZone);
  return instant;
}
export function validTimeZone(value: unknown): string {
  assert(
    typeof value === "string" && value.length > 0 && value.length <= 100,
    "TIMEZONE_INVALID",
    "Use an IANA timezone.",
  );
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
  } catch {
    assert(false, "TIMEZONE_INVALID", "Use an IANA timezone.");
  }
  return value;
}
/**
 * Resolves a snooze request to a UTC wake instant on the server. Presets are wall-clock times
 * in the teammate's own timezone: later today is three hours from now, tomorrow and next week
 * are 09:00 local (next week is the coming Monday), one week is seven days from now, and one
 * month is the same day next month (or its last day) at 09:00. A custom time carries its offset.
 */
export function resolveWake(
  input: { preset?: unknown; wakeAt?: unknown; timezone?: unknown },
  now = Date.now(),
) {
  if (input.preset !== undefined) {
    assert(
      SNOOZE_PRESETS.includes(input.preset as SnoozePreset),
      "INVALID_WAKE_TIME",
      "Choose later today, tomorrow, next week, one week or one month.",
    );
    const timeZone = validTimeZone(input.timezone);
    if (input.preset === "later_today")
      return { wakeAt: new Date(now + 3 * 3600_000), timeZone };
    if (input.preset === "one_week")
      return { wakeAt: new Date(now + 7 * 86_400_000), timeZone };
    const today = wallClock(now, timeZone);
    if (input.preset === "one_month") {
      // Day 0 of the month after next is the last day of next month.
      const last = new Date(
        Date.UTC(today.year, today.month + 2, 0),
      ).getUTCDate();
      return {
        wakeAt: new Date(
          atLocal(
            today.year,
            today.month + 1,
            Math.min(today.day, last),
            9,
            timeZone,
          ),
        ),
        timeZone,
      };
    }
    const days = input.preset === "tomorrow" ? 1 : (8 - today.weekday) % 7 || 7;
    return {
      wakeAt: new Date(
        atLocal(today.year, today.month, today.day + days, 9, timeZone),
      ),
      timeZone,
    };
  }
  assert(
    typeof input.wakeAt === "string" &&
      /(?:Z|[+-]\d\d:\d\d)$/.test(input.wakeAt) &&
      Number.isFinite(Date.parse(input.wakeAt)) &&
      Date.parse(input.wakeAt) > now,
    "INVALID_WAKE_TIME",
    "Choose a future wake time with an explicit timezone.",
  );
  return {
    wakeAt: new Date(Date.parse(input.wakeAt)),
    timeZone:
      input.timezone === undefined ? null : validTimeZone(input.timezone),
  };
}
