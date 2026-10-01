import { type Sql } from "./db";
import { openIntervals, type Calendar } from "./business-time";
import { resolveCalendar } from "./calendars";

/**
 * Office hours for the messenger (phase 06, step C), read from the one source SLAs use: the
 * calendar that applies (team, then brand, then workspace; B1). Holidays and special days count.
 * When no calendar applies, there is no hours line at all (SLAs then count all hours).
 * TODO(phase 11): out-of-hours automations call `openNow`. TODO(phase 14): reporting durations
 * read the same calendars.
 */
export function openNow(calendar: Calendar, at: number) {
  for (const [a] of openIntervals(calendar, at))
    return { open: a <= at, nextOpenAt: a <= at ? null : a };
  return { open: false, nextOpenAt: null };
}

export type Availability = {
  open: boolean;
  nextOpenAt?: string;
  nextOpenLabel?: string;
} | null;

/** Whether the team is open now, and if not, when it next opens, in the calendar's timezone. */
export async function availabilityFor(
  db: Sql,
  w: string,
  at: { brandId: string; teamId?: string | null },
  locale: string,
  now = Date.now(),
): Promise<Availability> {
  const resolved = await resolveCalendar(db, w, at);
  if (!resolved.calendarId) return null;
  const { open, nextOpenAt } = openNow(resolved.calendar, now);
  if (open || nextOpenAt === null) return { open };
  let label: string;
  try {
    label = new Intl.DateTimeFormat(locale, {
      timeZone: resolved.calendar.timezone,
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(nextOpenAt));
  } catch {
    label = new Date(nextOpenAt).toISOString();
  }
  return {
    open: false,
    nextOpenAt: new Date(nextOpenAt).toISOString(),
    nextOpenLabel: label,
  };
}

/** Bands the measured reply time is shown in. */
const BANDS = [
  { under: 10 * 60_000, key: "few_minutes" },
  { under: 60 * 60_000, key: "under_an_hour" },
  { under: 4 * 3_600_000, key: "few_hours" },
  { under: Infinity, key: "about_a_day" },
] as const;
export type ReplyTime =
  { band: (typeof BANDS)[number]["key"] } | { text: string } | null;

/**
 * The expected reply time: the median first response (in business hours) over the last 14 days,
 * from at least 20 conversations, shown as a band; otherwise the brand's own phrase; otherwise
 * nothing.
 */
export async function expectedReply(
  db: Sql,
  w: string,
  brandId: string,
  now = Date.now(),
): Promise<ReplyTime> {
  const measured = (
    await db.query<{ median: number | null; n: string }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY first_response_business_ms) AS median,count(*) AS n
      FROM conversations WHERE workspace_id=$1 AND brand_id=$2 AND first_response_business_ms IS NOT NULL
      AND created_at>=$3 AND merged_into_id IS NULL`,
      [w, brandId, new Date(now - 14 * 86_400_000).toISOString()],
    )
  ).rows[0];
  if (Number(measured.n) >= 20 && measured.median !== null)
    return { band: BANDS.find((b) => Number(measured.median) < b.under)!.key };
  const phrase = (
    await db.query<{ phrase: unknown }>(
      "SELECT settings->'replyTime' AS phrase FROM brands WHERE workspace_id=$1 AND id=$2",
      [w, brandId],
    )
  ).rows[0]?.phrase;
  return typeof phrase === "string" && phrase.trim() && phrase.length <= 80
    ? { text: phrase.trim() }
    : null;
}
