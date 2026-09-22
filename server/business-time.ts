import { assert, tenant, type Connect } from "./db";
import type { Job } from "./jobs";

export type BusinessSchedule = {
  weekly: Record<string, [string, string][]>;
  holidays?: string[];
};
/** Exact elapsed milliseconds while the versioned local calendar is open, including DST. Runs in a job. */
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
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let total = 0;
  for (let at = start.getTime(); at < end.getTime();) {
    const next = Math.min(end.getTime(), (Math.floor(at / 60000) + 1) * 60000),
      p = Object.fromEntries(
        format.formatToParts(new Date(at)).map((v) => [v.type, v.value]),
      ),
      day = String(
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
      );
    const time = p.hour + ":" + p.minute,
      date = p.year + "-" + p.month + "-" + p.day;
    if (
      !schedule.holidays?.includes(date) &&
      (schedule.weekly[day] ?? []).some(
        ([from, to]) => time >= from && time < to,
      )
    )
      total += next - at;
    at = next;
  }
  return total;
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
