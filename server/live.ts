import { assert, type Sql } from "./db";
import { authorize } from "./policy";
import { reportsOn } from "./analytics";

/**
 * The live dashboard (phase 14, step R4; docs/REPORTING_STEP4.md): what's happening right now, for
 * who may view reports. Unlike reports it reads the inbox's own tables, because "now" can't wait
 * for the projection; but only the conversations still in play (open or snoozed, customer-facing,
 * not merged), through 0076's partial indexes, never the history. Three small queries:
 *
 * - **The live set, once:** counts by team and by teammate in one pass (GROUPING SETS).
 * - **Who has waited longest:** open conversations whose customer spoke last, in waiting order.
 * - **Teammates:** each one's presence and conversation limit (a workspace's team is small).
 *
 * Terms are the inbox's: unassigned is `assigned=''`; a conversation is waiting when its customer
 * wrote after the last teammate reply, since that message; an outbound chat counts once the person
 * replied. SLA risk is the next target due within the hour; breached is already past it.
 */
const LIVE = "c.workspace_id=$1 AND c.status IN ('open','snoozed') AND c.merged_into_id IS NULL AND c.visibility='customer'";
const ANSWERED = "NOT (c.outbound_message_id IS NOT NULL AND c.last_contact_reply_at IS NULL)";
const WAITING = "c.status='open' AND c.last_contact_reply_at IS NOT NULL AND c.last_contact_reply_at>COALESCE(c.last_teammate_reply_at,'-infinity'::timestamptz)";
const BREACHED = "c.status='open' AND (c.sla_overdue OR c.sla_next_due_at<now())";
const AT_RISK = "c.status='open' AND NOT c.sla_overdue AND c.sla_next_due_at>=now() AND c.sla_next_due_at<now()+interval '1 hour'";
const SINCE = "COALESCE(c.last_contact_reply_at,c.created_at)";

export type LiveCounts = { open: number; unassigned: number; snoozed: number; waiting: number; breached: number; atRisk: number; longestWaitMs: number | null };
export type LiveDashboard = {
  at: string;
  totals: LiveCounts;
  teams: (LiveCounts & { id: string | null; name: string })[];
  teammates: { id: string; name: string; presence: string; since: string | null; open: number; waiting: number; limit: number | null; teams: string[] }[];
  waitingLongest: { id: string; title: string; channel: string; teamId: string | null; assigned: string | null; waitingMs: number; sla: "breached" | "at_risk" | null }[];
};

/** The live set's counts, by team and by teammate, in one pass (the queries tests/live.test.ts bounds). */
export const liveQueries = {
  counts: `SELECT GROUPING(c.team_id) AS by_team,GROUPING(c.assigned) AS by_teammate,c.team_id,c.assigned,
      count(*) FILTER (WHERE c.status='open')::int AS open,
      count(*) FILTER (WHERE c.status='open' AND c.assigned='')::int AS unassigned,
      count(*) FILTER (WHERE c.status='snoozed')::int AS snoozed,
      count(*) FILTER (WHERE ${WAITING})::int AS waiting,
      count(*) FILTER (WHERE ${BREACHED})::int AS breached,
      count(*) FILTER (WHERE ${AT_RISK})::int AS at_risk,
      (extract(epoch FROM now()-min(${SINCE}) FILTER (WHERE ${WAITING}))*1000)::bigint AS longest_ms
    FROM conversations c WHERE ${LIVE} AND ${ANSWERED} AND ($2::text IS NULL OR c.team_id=$2)
    GROUP BY GROUPING SETS ((c.team_id),(c.assigned),())`,
  waiting: `SELECT c.id,c.title,c.channel,c.team_id,NULLIF(c.assigned,'') AS assigned,(extract(epoch FROM now()-${SINCE})*1000)::bigint AS waiting_ms,
      CASE WHEN c.sla_overdue OR c.sla_next_due_at<now() THEN 'breached' WHEN c.sla_next_due_at<now()+interval '1 hour' THEN 'at_risk' END AS sla
    FROM conversations c WHERE c.workspace_id=$1 AND c.status='open' AND c.merged_into_id IS NULL AND c.visibility='customer'
      AND c.last_contact_reply_at IS NOT NULL AND c.last_contact_reply_at>COALESCE(c.last_teammate_reply_at,'-infinity'::timestamptz) AND ($2::text IS NULL OR c.team_id=$2)
    ORDER BY ${SINCE} LIMIT 10`,
};

export async function liveDashboard(db: Sql, w: string, principal: string, q: { team?: string | null }): Promise<LiveDashboard> {
  await authorize(db, w, principal, "reports.view");
  assert(await reportsOn(db, w), "REPORTS_DISABLED", "Reports are not enabled for this workspace.", 404);
  const team = q.team ? String(q.team) : null;
  type Row = { by_team: number; by_teammate: number; team_id: string | null; assigned: string | null; open: number; unassigned: number; snoozed: number; waiting: number; breached: number; at_risk: number; longest_ms: string | null };
  const rows = (await db.query<Row>(liveQueries.counts, [w, team])).rows;
  const counts = (r: Row | undefined): LiveCounts => ({
    open: r?.open ?? 0,
    unassigned: r?.unassigned ?? 0,
    snoozed: r?.snoozed ?? 0,
    waiting: r?.waiting ?? 0,
    breached: r?.breached ?? 0,
    atRisk: r?.at_risk ?? 0,
    longestWaitMs: r?.longest_ms == null ? null : Number(r.longest_ms),
  });
  const teamRows = (await db.query<{ id: string; name: string }>("SELECT id,name FROM teams WHERE workspace_id=$1 ORDER BY name", [w])).rows;
  const members = (await db.query<{ teammate_id: string; team_id: string }>("SELECT teammate_id,team_id FROM teammate_teams WHERE workspace_id=$1", [w])).rows;
  const people = (
    await db.query<{ id: string; name: string; presence: string; presence_changed_at: Date | null; conversation_limit: number | null }>(
      "SELECT id,name,presence,presence_changed_at,conversation_limit FROM teammates WHERE workspace_id=$1 ORDER BY name",
      [w],
    )
  ).rows;
  const byTeam = rows.filter((r) => r.by_team === 0 && r.by_teammate === 1);
  const byTeammate = new Map(rows.filter((r) => r.by_team === 1 && r.by_teammate === 0).map((r) => [r.assigned, r]));
  const waiting = (await db.query<{ id: string; title: string; channel: string; team_id: string | null; assigned: string | null; waiting_ms: string; sla: "breached" | "at_risk" | null }>(liveQueries.waiting, [w, team])).rows;
  // Every team appears (an empty queue is news too); conversations without a team come last.
  const teams = [
    ...teamRows.filter((t) => !team || t.id === team).map((t) => ({ id: t.id as string | null, name: t.name, ...counts(byTeam.find((r) => r.team_id === t.id)) })),
    ...byTeam.filter((r) => r.team_id === null).map((r) => ({ id: null, name: "No team", ...counts(r) })),
  ];
  return {
    at: new Date().toISOString(),
    totals: counts(rows.find((r) => r.by_team === 1 && r.by_teammate === 1)),
    teams,
    teammates: people
      .map((p) => {
        const mine = byTeammate.get(p.id);
        return {
          id: p.id,
          name: p.name,
          presence: p.presence,
          since: p.presence_changed_at ? new Date(p.presence_changed_at).toISOString() : null,
          open: mine?.open ?? 0,
          waiting: mine?.waiting ?? 0,
          limit: p.conversation_limit,
          teams: members.filter((m) => m.teammate_id === p.id).map((m) => m.team_id),
        };
      })
      .filter((p) => !team || p.teams.includes(team)),
    waitingLongest: waiting.map((r) => ({ id: r.id, title: r.title, channel: r.channel, teamId: r.team_id, assigned: r.assigned, waitingMs: Number(r.waiting_ms), sla: r.sla })),
  };
}
