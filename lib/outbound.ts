import { segmentProblems, type SegmentDefinition } from "./segments";

/**
 * Outbound messages (phase 13, step O2; docs/OUTBOUND_STEP2.md): what a message is, checked here
 * once for the server and (from O3) the editor. A message is versioned; a contact who entered one
 * stays on its version.
 *
 * - **Audience:** a segment (predefined or saved) and rules (`lib/segments.ts`), evaluated when
 *   the contact is chosen; send-time rules (page, device, locale, an open conversation) when the
 *   messenger asks for what's due.
 * - **Delivery:** `once` (the audience when it goes live, fixed), `ongoing` (whoever matches, when
 *   they first match), `event` (an event, after a delay), `recurring` (daily or weekly, at a time).
 * - **Re-entry:** `once` ever, once a `period` of N days, or `every` time (which needs a cap).
 * - **Caps, quiet hours, subscription:** the workspace's cap across all outbound, the message's
 *   own, quiet hours in the contact's timezone, and the subscription type every message declares.
 * - **Goal:** an event within N days of entering, against a holdout that's never sent it.
 */
export type SendTimeRule =
  | { field: "page_url"; op: "is" | "contains" | "starts_with" | "not_contains"; value: string }
  | { field: "device"; op: "is"; value: "desktop" | "mobile" }
  | { field: "locale"; op: "is" | "starts_with"; value: string }
  | { field: "open_conversation"; op: "is"; value: boolean };
export type OutboundDefinition = {
  type: "chat";
  content: { text: string; senderId: string };
  subscriptionTypeId: string;
  audience: { segmentId: string | null; rules: SegmentDefinition; sendTime: SendTimeRule[] };
  delivery: {
    mode: "once" | "ongoing" | "event" | "recurring";
    event?: { name: string; delayMinutes: number };
    every?: { unit: "day" | "week"; at: string; weekday?: number };
  };
  reentry: { mode: "once" | "period" | "every"; days?: number };
  cap: { count: number; days: number } | null;
  quietHours: boolean;
  goal: { event: string; days: number } | null;
  holdoutPercent: number;
  startAt: string | null;
  stopAt: string | null;
};
export const OUTBOUND_TYPES = ["chat"] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const EVENT = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,99}$/;

/** A new message's definition: nobody yet, sent once, no goal. */
export function blankDefinition(type: "chat", senderId: string): OutboundDefinition {
  return {
    type,
    content: { text: "", senderId },
    subscriptionTypeId: "",
    audience: { segmentId: "all-users", rules: { match: "all", rules: [] }, sendTime: [] },
    delivery: { mode: "once" },
    reentry: { mode: "once" },
    cap: null,
    quietHours: true,
    goal: null,
    holdoutPercent: 0,
    startAt: null,
    stopAt: null,
  };
}

/** What stops a definition going live, in words (empty: nothing). */
export function outboundProblems(d: OutboundDefinition): string[] {
  const out: string[] = [];
  if (!d || typeof d !== "object") return ["A message needs content, an audience and a delivery."];
  if (!(OUTBOUND_TYPES as readonly string[]).includes(d.type)) out.push("Choose the message type.");
  if (typeof d.content?.text !== "string" || !d.content.text.trim() || d.content.text.length > 5000) out.push("Write the message (5,000 characters at most).");
  if (typeof d.content?.senderId !== "string" || !d.content.senderId) out.push("Choose who it's from.");
  if (typeof d.subscriptionTypeId !== "string" || !d.subscriptionTypeId) out.push("Choose its subscription type: every message has one.");
  if (!d.audience || typeof d.audience !== "object") out.push("Choose the audience.");
  else {
    out.push(...segmentProblems(d.audience.rules).map((p) => `Audience: ${p}`));
    if (!Array.isArray(d.audience.sendTime) || d.audience.sendTime.length > 10) out.push("Use 10 send-time rules at most.");
    else
      d.audience.sendTime.forEach((r, i) => {
        const where = `Send-time rule ${i + 1}`;
        if (r.field === "page_url") {
          if (!["is", "contains", "starts_with", "not_contains"].includes(r.op) || typeof r.value !== "string" || !r.value || r.value.length > 500) out.push(`${where}: a page address (500 characters at most).`);
        } else if (r.field === "device") {
          if (r.op !== "is" || !["desktop", "mobile"].includes(r.value)) out.push(`${where}: desktop or mobile.`);
        } else if (r.field === "locale") {
          if (!["is", "starts_with"].includes(r.op) || typeof r.value !== "string" || !/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(r.value)) out.push(`${where}: a language (en, fr-CA).`);
        } else if (r.field === "open_conversation") {
          if (r.op !== "is" || typeof r.value !== "boolean") out.push(`${where}: yes or no.`);
        } else out.push(`${where}: choose page, device, language or open conversation.`);
      });
  }
  const m = d.delivery?.mode;
  if (!["once", "ongoing", "event", "recurring"].includes(m)) out.push("Choose how it's delivered.");
  if (m === "event") {
    const e = d.delivery.event;
    if (!e || !EVENT.test(String(e.name ?? ""))) out.push("Choose the event that sends it.");
    else if (!Number.isInteger(e.delayMinutes) || e.delayMinutes < 0 || e.delayMinutes > 60 * 24 * 30) out.push("Send it 0 minutes to 30 days after the event.");
  }
  if (m === "recurring") {
    const e = d.delivery.every;
    if (!e || !["day", "week"].includes(e.unit) || !TIME.test(String(e.at ?? ""))) out.push("Choose when it recurs: daily or weekly, at a time (HH:MM).");
    else if (e.unit === "week" && (!Number.isInteger(e.weekday) || e.weekday! < 0 || e.weekday! > 6)) out.push("Choose the day of the week.");
  }
  const r = d.reentry?.mode;
  if (!["once", "period", "every"].includes(r)) out.push("Choose how often someone can get it.");
  if (r === "period" && (!Number.isInteger(d.reentry.days) || d.reentry.days! < 1 || d.reentry.days! > 365)) out.push("Once every 1 to 365 days.");
  if (r === "every" && !d.cap) out.push("Sent every time they match: give it a cap (how many times, in how many days).");
  if (d.cap !== null && (typeof d.cap !== "object" || !Number.isInteger(d.cap.count) || d.cap.count < 1 || d.cap.count > 100 || !Number.isInteger(d.cap.days) || d.cap.days < 1 || d.cap.days > 365))
    out.push("A cap is 1 to 100 times in 1 to 365 days.");
  if (typeof d.quietHours !== "boolean") out.push("Say whether quiet hours apply.");
  if (d.goal !== null && (typeof d.goal !== "object" || !EVENT.test(String(d.goal.event ?? "")) || !Number.isInteger(d.goal.days) || d.goal.days < 1 || d.goal.days > 90))
    out.push("A goal is an event within 1 to 90 days.");
  if (!Number.isInteger(d.holdoutPercent) || d.holdoutPercent < 0 || d.holdoutPercent > 50) out.push("Hold out 0 to 50% as a control group.");
  if (d.holdoutPercent > 0 && !d.goal) out.push("A control group needs a goal to compare.");
  if (d.holdoutPercent > 0 && d.reentry?.mode === "every") out.push("A control group needs someone to enter once, or once a period.");
  for (const k of ["startAt", "stopAt"] as const)
    if (d[k] !== null && (typeof d[k] !== "string" || !Number.isFinite(Date.parse(d[k]!)))) out.push(`${k === "startAt" ? "Start" : "Stop"} at a date and time.`);
  if (d.startAt && d.stopAt && Date.parse(d.stopAt) <= Date.parse(d.startAt)) out.push("Stop after it starts.");
  return out;
}

/** What the messenger knows when it asks for what's due. */
export type PageContext = { pageUrl: string; device: "desktop" | "mobile"; locale: string; openConversation: boolean };
export function sendTimeMatches(rules: SendTimeRule[], ctx: PageContext) {
  return rules.every((r) => {
    if (r.field === "page_url") {
      const u = ctx.pageUrl;
      return r.op === "is" ? u === r.value : r.op === "contains" ? u.includes(r.value) : r.op === "starts_with" ? u.startsWith(r.value) : !u.includes(r.value);
    }
    if (r.field === "device") return ctx.device === r.value;
    if (r.field === "locale") return r.op === "is" ? ctx.locale.toLowerCase() === r.value.toLowerCase() : ctx.locale.toLowerCase().startsWith(r.value.toLowerCase());
    if (r.field === "open_conversation") return ctx.openConversation === r.value;
    return false;
  });
}
export const deviceOf = (userAgent: string): "desktop" | "mobile" => (/Mobi|Android|iPhone|iPad/i.test(userAgent) ? "mobile" : "desktop");

/** The control group: a stable 0–99 from the contact and message, so nobody switches group. */
export async function bucket(contactId: string, messageId: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${messageId}:${contactId}`)));
  return ((h[0] << 8) | h[1]) % 100;
}

/** Whether `now` is within quiet hours (start to end, crossing midnight if need be) in `timezone`. */
export function inQuietHours(now: Date, timezone: string, start: string, end: string) {
  let local: string;
  try {
    local = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  } catch {
    local = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  }
  if (start === end) return false;
  return start < end ? local >= start && local < end : local >= start || local < end;
}

/**
 * The goal against the control group, said honestly: a lift is reported only once each group has
 * at least 100 people, with its 95% interval; until then, "too few to say".
 */
export const MIN_GROUP = 100;
export function goalReadout(sent: { n: number; converted: number }, control: { n: number; converted: number }) {
  const rate = (g: { n: number; converted: number }) => (g.n ? g.converted / g.n : 0);
  const a = rate(sent);
  const b = rate(control);
  if (sent.n < MIN_GROUP || control.n < MIN_GROUP)
    return { sentRate: a, controlRate: b, lift: null, low: null, high: null, verdict: `Too few to say: each group needs ${MIN_GROUP} people.` };
  const lift = a - b;
  const se = Math.sqrt((a * (1 - a)) / sent.n + (b * (1 - b)) / control.n);
  const low = lift - 1.96 * se;
  const high = lift + 1.96 * se;
  const pct = (x: number) => `${(x * 100).toFixed(1)} points`;
  return {
    sentRate: a,
    controlRate: b,
    lift,
    low,
    high,
    verdict:
      low > 0
        ? `It helps: ${pct(lift)} more reached the goal (between ${pct(low)} and ${pct(high)}).`
        : high < 0
          ? `It hurts: ${pct(-lift)} fewer reached the goal (between ${pct(-high)} and ${pct(-low)}).`
          : `No clear difference yet (between ${pct(low)} and ${pct(high)}).`,
  };
}
