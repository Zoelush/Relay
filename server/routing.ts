import { assert, DomainError, tenant, type Connect, type Sql } from "./db";
import { authorize, can } from "./policy";
import { append, syncUnread, type Conversation } from "./conversations";

/**
 * Routing and workload (phase 06, step A).
 *
 * A team inbox assigns conversations that reach it by one of three methods:
 * - manual: nothing is assigned automatically; teammates claim work;
 * - round robin: in rotation to active members (away ones too, if the team says so). It does NOT
 *   look at how loaded anyone is and does not respect assignment limits;
 * - balanced: to the eligible member with the fewest active conversations, only while both the
 *   teammate's limit and the inbox's limit allow it. Otherwise the conversation waits in the
 *   inbox and is picked up when capacity appears.
 *
 * "Active" means open (not snoozed or closed) and assigned. Tickets count toward conversation
 * capacity if the team says so, and may have their own limit. Limits bind automatic assignment
 * only; a teammate can still assign by hand beyond them.
 *
 * `decide` is a pure function of the team's state, the item and the rotation cursor, so the same
 * inputs always give the same assignee and simulations replay exactly. `claim` makes the
 * assignment atomic in the database: it only succeeds on a conversation that is still open,
 * unassigned and in the team, and capacity is counted with the team and teammate rows locked.
 */
export const METHODS = ["manual", "round_robin", "balanced"] as const;
export type Method = (typeof METHODS)[number];
export type Member = {
  id: string;
  presence: "active" | "away" | "away_reassigning";
  /** Open, assigned conversations that are not tickets / that are tickets. */
  conversations: number;
  tickets: number;
  conversationLimit: number | null;
  ticketLimit: number | null;
};
export type TeamState = {
  id: string;
  method: Method;
  conversationLimit: number | null;
  ticketLimit: number | null;
  ticketsCount: boolean;
  includeAway: boolean;
  cursor: string | null;
  /** The inbox's active load: its open, assigned conversations. */
  conversations: number;
  tickets: number;
  /** Sorted by id; the rotation order. */
  members: Member[];
};
export type Decision = { assignee: string | null; reason: string };

/** The load that counts toward conversation capacity. */
const load = (
  x: { conversations: number; tickets: number },
  ticketsCount: boolean,
) => x.conversations + (ticketsCount ? x.tickets : 0);
/** Members in rotation order, starting after the cursor. */
function rotation(members: Member[], cursor: string | null) {
  const start = cursor === null ? 0 : members.findIndex((m) => m.id > cursor);
  const from = start < 0 ? 0 : start;
  return [...members.slice(from), ...members.slice(0, from)];
}

/** Who gets `item` from this team, if anyone. Pure. */
export function decide(team: TeamState, item: { ticket: boolean }): Decision {
  if (team.method === "manual") return { assignee: null, reason: "manual" };
  if (team.method === "round_robin") {
    const next = rotation(team.members, team.cursor).find(
      (m) => m.presence === "active" || team.includeAway,
    );
    return next
      ? { assignee: next.id, reason: "round_robin" }
      : { assignee: null, reason: "no_one_available" };
  }
  // Balanced: the inbox first, then each teammate; both must have room.
  const countsAsConversation = !item.ticket || team.ticketsCount;
  if (
    item.ticket &&
    team.ticketLimit !== null &&
    team.tickets >= team.ticketLimit
  )
    return { assignee: null, reason: "inbox_ticket_limit" };
  if (
    countsAsConversation &&
    team.conversationLimit !== null &&
    load(team, team.ticketsCount) >= team.conversationLimit
  )
    return { assignee: null, reason: "inbox_limit" };
  const eligible = rotation(team.members, team.cursor).filter(
    (m) =>
      m.presence === "active" &&
      !(item.ticket && m.ticketLimit !== null && m.tickets >= m.ticketLimit) &&
      !(
        countsAsConversation &&
        m.conversationLimit !== null &&
        load(m, team.ticketsCount) >= m.conversationLimit
      ),
  );
  if (!eligible.length) return { assignee: null, reason: "at_capacity" };
  // Fewest active; ties go to the next in rotation, so equal loads spread evenly.
  const fewest = Math.min(...eligible.map((m) => load(m, team.ticketsCount)));
  return {
    assignee: eligible.find((m) => load(m, team.ticketsCount) === fewest)!.id,
    reason: "balanced",
  };
}

/** Applies an assignment to the in-memory state, as `claim` does in the database. */
function record(team: TeamState, assignee: string, item: { ticket: boolean }) {
  const m = team.members.find((x) => x.id === assignee);
  if (m) {
    if (item.ticket) m.tickets++;
    else m.conversations++;
  }
  if (item.ticket) team.tickets++;
  else team.conversations++;
  team.cursor = assignee;
}

export async function routingEnabled(db: Sql, w: string) {
  return (
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='routing_v1' AND enabled",
        [w],
      )
    ).rows.length > 0
  );
}

/**
 * Reads a team's state, locking the team row and its members' rows (in id order, so two teams
 * sharing members cannot deadlock). Held until the transaction ends, so counts stay true while
 * assignments are made.
 */
export async function loadTeam(
  db: Sql,
  w: string,
  teamId: string,
): Promise<TeamState | null> {
  const team = (
    await db.query<{
      id: string;
      method: Method;
      conversation_limit: number | null;
      ticket_limit: number | null;
      tickets_count: boolean;
      include_away: boolean;
      rotation_cursor: string | null;
    }>(
      "SELECT id,method,conversation_limit,ticket_limit,tickets_count,include_away,rotation_cursor FROM teams WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [w, teamId],
    )
  ).rows[0];
  if (!team) return null;
  const members = (
    await db.query<{
      id: string;
      presence: Member["presence"];
      conversation_limit: number | null;
      ticket_limit: number | null;
    }>(
      `SELECT t.id,t.presence,t.conversation_limit,t.ticket_limit FROM teammates t
      JOIN teammate_teams m ON m.workspace_id=t.workspace_id AND m.teammate_id=t.id
      WHERE t.workspace_id=$1 AND m.team_id=$2 ORDER BY t.id FOR UPDATE OF t`,
      [w, teamId],
    )
  ).rows;
  // A teammate's capacity is across every team; the inbox's is its own conversations.
  const counts = (
    await db.query<{
      assigned: string;
      conversations: string;
      tickets: string;
    }>(
      `SELECT c.assigned,count(*) FILTER (WHERE tk.conversation_id IS NULL) AS conversations,count(tk.conversation_id) AS tickets
      FROM conversations c LEFT JOIN tickets tk ON tk.workspace_id=c.workspace_id AND tk.conversation_id=c.id
      WHERE c.workspace_id=$1 AND c.assigned=ANY($2::text[]) AND c.status='open' AND c.merged_into_id IS NULL GROUP BY c.assigned`,
      [w, members.map((m) => m.id)],
    )
  ).rows;
  const inbox = (
    await db.query<{ conversations: string; tickets: string }>(
      `SELECT count(*) FILTER (WHERE tk.conversation_id IS NULL) AS conversations,count(tk.conversation_id) AS tickets
      FROM conversations c LEFT JOIN tickets tk ON tk.workspace_id=c.workspace_id AND tk.conversation_id=c.id
      WHERE c.workspace_id=$1 AND c.team_id=$2 AND c.assigned<>'' AND c.status='open' AND c.merged_into_id IS NULL`,
      [w, teamId],
    )
  ).rows[0];
  return {
    id: team.id,
    method: team.method,
    conversationLimit: team.conversation_limit,
    ticketLimit: team.ticket_limit,
    ticketsCount: team.tickets_count,
    includeAway: team.include_away,
    cursor: team.rotation_cursor,
    conversations: Number(inbox.conversations),
    tickets: Number(inbox.tickets),
    members: members.map((m) => {
      const c = counts.find((x) => x.assigned === m.id);
      return {
        id: m.id,
        presence: m.presence,
        conversations: Number(c?.conversations ?? 0),
        tickets: Number(c?.tickets ?? 0),
        conversationLimit: m.conversation_limit,
        ticketLimit: m.ticket_limit,
      };
    }),
  };
}

const isTicket = async (db: Sql, w: string, id: string) =>
  (
    await db.query(
      "SELECT 1 FROM tickets WHERE workspace_id=$1 AND conversation_id=$2",
      [w, id],
    )
  ).rows.length > 0;

/**
 * Assigns a queued conversation to a teammate, atomically: the update only matches a
 * conversation that is still open, unassigned and in this team, so a second attempt (a
 * concurrent router, a teammate claiming it) changes nothing and reports false.
 */
export async function claim(
  db: Sql,
  w: string,
  conversationId: string,
  teamId: string,
  teammateId: string,
  reason: string,
) {
  const c = (
    await db.query<Conversation>(
      `UPDATE conversations SET assigned=$4 WHERE workspace_id=$1 AND id=$2 AND team_id=$3 AND assigned='' AND status='open' AND merged_into_id IS NULL
      RETURNING *`,
      [w, conversationId, teamId, teammateId],
    )
  ).rows[0];
  if (!c) return false;
  const who = { type: "system", id: "routing" };
  await append(db, w, c, who, "system_event", "", {
    event: "human_joined",
    teammateId,
  });
  await append(
    db,
    w,
    c,
    who,
    "assignment_change",
    "",
    {
      before: { teammate: "", team: teamId },
      after: { teammate: teammateId, team: teamId },
      reason,
    },
    "internal",
  );
  await syncUnread(db, w, c);
  const { syncSla } = await import("./sla");
  await syncSla(db, w, c.id);
  return true;
}

/**
 * Assigns waiting conversations in a team's inbox while the method and capacity allow: highest
 * priority first, then the soonest SLA due time, then longest waiting. A conversation that cannot
 * be placed stays queued. Returns what was assigned.
 */
export async function drainTeam(db: Sql, w: string, teamId: string, max = 50) {
  if (!(await routingEnabled(db, w))) return [];
  const team = await loadTeam(db, w, teamId);
  if (!team || team.method === "manual") return [];
  const queued = (
    await db.query<{ id: string; ticket: boolean }>(
      `SELECT c.id,EXISTS(SELECT 1 FROM tickets tk WHERE tk.workspace_id=c.workspace_id AND tk.conversation_id=c.id) AS ticket
      FROM conversations c WHERE c.workspace_id=$1 AND c.team_id=$2 AND c.assigned='' AND c.status='open' AND c.merged_into_id IS NULL
      ORDER BY c.priority DESC,COALESCE(c.sla_sort_at,'9999-12-31'::timestamptz),COALESCE(c.last_contact_reply_at,c.created_at),c.id
      LIMIT $3`,
      [w, teamId, max],
    )
  ).rows;
  const assigned: { conversationId: string; teammateId: string }[] = [];
  for (const item of queued) {
    const decision = decide(team, item);
    if (!decision.assignee) continue;
    if (
      await claim(db, w, item.id, teamId, decision.assignee, decision.reason)
    ) {
      record(team, decision.assignee, item);
      assigned.push({ conversationId: item.id, teammateId: decision.assignee });
    }
  }
  if (assigned.length)
    await db.query(
      "UPDATE teams SET rotation_cursor=$3 WHERE workspace_id=$1 AND id=$2",
      [w, teamId, team.cursor],
    );
  return assigned;
}

/** Capacity may have appeared for this teammate: drain each of their teams' inboxes. */
export async function drainForTeammate(db: Sql, w: string, teammateId: string) {
  if (!(await routingEnabled(db, w))) return [];
  const teams = (
    await db.query<{ team_id: string }>(
      "SELECT team_id FROM teammate_teams WHERE workspace_id=$1 AND teammate_id=$2 ORDER BY team_id",
      [w, teammateId],
    )
  ).rows;
  const out = [];
  for (const t of teams) out.push(...(await drainTeam(db, w, t.team_id)));
  return out;
}

/**
 * Called after anything that may change who works on a conversation or how much they have:
 * a conversation arriving in (or reopening in) a team inbox is routed, and a teammate who lost
 * an active conversation gets the chance of their teams' queues.
 */
export async function afterChange(
  db: Sql,
  w: string,
  id: string,
  before: { assigned: string; status: string; team_id: string | null },
) {
  if (!(await routingEnabled(db, w))) return;
  const after = (
    await db.query<{
      assigned: string;
      status: string;
      team_id: string | null;
    }>(
      // A merged-away conversation is no longer anyone's active work.
      "SELECT assigned,CASE WHEN merged_into_id IS NULL THEN status ELSE 'merged' END AS status,team_id FROM conversations WHERE workspace_id=$1 AND id=$2",
      [w, id],
    )
  ).rows[0];
  if (!after) return;
  if (after.team_id && after.assigned === "" && after.status === "open")
    await drainTeam(db, w, after.team_id);
  if (
    before.assigned &&
    (before.assigned !== after.assigned ||
      (before.status === "open" && after.status !== "open"))
  )
    await drainForTeammate(db, w, before.assigned);
}

/**
 * The routing interface for rule-based routing (phase 11): given a conversation, who would get
 * it from its team right now. Reads only; `drainTeam` makes the assignment.
 * TODO(phase 11): workflow rules choose the team, then call this.
 */
export async function assigneeFor(
  db: Sql,
  w: string,
  conversationId: string,
): Promise<Decision & { teamId: string | null }> {
  const c = (
    await db.query<{ team_id: string | null; assigned: string }>(
      "SELECT team_id,assigned FROM conversations WHERE workspace_id=$1 AND id=$2",
      [w, conversationId],
    )
  ).rows[0];
  assert(c, "CONVERSATION_NOT_FOUND", "Conversation unavailable.", 404);
  if (!c.team_id) return { teamId: null, assignee: null, reason: "no_team" };
  const team = await loadTeam(db, w, c.team_id);
  if (!team) return { teamId: null, assignee: null, reason: "no_team" };
  return {
    teamId: team.id,
    ...decide(team, { ticket: await isTicket(db, w, conversationId) }),
  };
}

/** A sweep for queues left waiting (a missed trigger, a limit raised elsewhere): every team, once. */
export async function drainAll(connect: Connect, w: string) {
  const teams = await tenant(connect, w, async (db) =>
    (await routingEnabled(db, w))
      ? (
          await db.query<{ id: string }>(
            `SELECT DISTINCT team_id AS id FROM conversations WHERE workspace_id=$1 AND team_id IS NOT NULL AND assigned='' AND status='open' AND merged_into_id IS NULL`,
            [w],
          )
        ).rows
      : [],
  );
  const assigned = [];
  for (const t of teams)
    assigned.push(
      ...(await tenant(connect, w, (db) => drainTeam(db, w, t.id))),
    );
  return assigned;
}

/** Whether assigning this teammate by hand puts them over their limit (a warning, not a refusal). */
export async function overLimit(db: Sql, w: string, teammateId: string) {
  const t = (
    await db.query<{ conversation_limit: number | null; open: string }>(
      `SELECT t.conversation_limit,(SELECT count(*) FROM conversations c WHERE c.workspace_id=t.workspace_id AND c.assigned=t.id AND c.status='open' AND c.merged_into_id IS NULL) AS open
      FROM teammates t WHERE t.workspace_id=$1 AND t.id=$2`,
      [w, teammateId],
    )
  ).rows[0];
  return (
    !!t &&
    t.conversation_limit !== null &&
    Number(t.open) > t.conversation_limit
  );
}

const invalid = (message: string): never => {
  throw new DomainError("INVALID_TEAM", message, 400);
};
const limit = (v: unknown, max: number) => {
  if (v === undefined || v === null) return null;
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > max)
    invalid(`Limits are whole numbers from 1 to ${max}.`);
  return v as number;
};

/**
 * Creates or updates a team's routing settings and members (needs `workspace.manage`), from the
 * version the editor started from. A change that may free capacity drains the inbox at once.
 */
export async function saveTeam(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  await authorize(db, w, principal, "workspace.manage");
  assert(
    await routingEnabled(db, w),
    "ROUTING_DISABLED",
    "Routing is not enabled for this workspace.",
    404,
  );
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name || name.length > 80)
    invalid("Give the team a name of up to 80 characters.");
  const method = (p.method ?? "manual") as Method;
  if (!METHODS.includes(method))
    invalid("Choose manual, round robin or balanced.");
  const settings = {
    conversationLimit: limit(p.conversationLimit, 100000),
    ticketLimit: limit(p.ticketLimit, 100000),
    ticketsCount: p.ticketsCount !== false,
    includeAway: p.includeAway === true,
  };
  let id: string;
  if (p.id !== undefined) {
    const current = (
      await db.query<{ version: string }>(
        "SELECT version::text AS version FROM teams WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [w, String(p.id)],
      )
    ).rows[0];
    assert(current, "INVALID_TEAM", "Team unavailable.", 404);
    assert(
      String(p.version) === current.version,
      "TEAM_CONFLICT",
      "This team changed elsewhere. Reload and try again.",
      409,
    );
    id = String(p.id);
    await db.query(
      `UPDATE teams SET name=$3,method=$4,conversation_limit=$5,ticket_limit=$6,tickets_count=$7,include_away=$8,version=version+1 WHERE workspace_id=$1 AND id=$2`,
      [
        w,
        id,
        name,
        method,
        settings.conversationLimit,
        settings.ticketLimit,
        settings.ticketsCount,
        settings.includeAway,
      ],
    );
  } else {
    id = crypto.randomUUID();
    await db.query(
      `INSERT INTO teams(workspace_id,id,name,method,conversation_limit,ticket_limit,tickets_count,include_away) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        w,
        id,
        name,
        method,
        settings.conversationLimit,
        settings.ticketLimit,
        settings.ticketsCount,
        settings.includeAway,
      ],
    );
  }
  if (p.members !== undefined) {
    if (
      !Array.isArray(p.members) ||
      p.members.length > 500 ||
      !p.members.every((m) => typeof m === "string")
    )
      invalid("List up to 500 member teammate ids.");
    const members = [...new Set(p.members as string[])];
    const found = (
      await db.query<{ id: string }>(
        "SELECT id FROM teammates WHERE workspace_id=$1 AND id=ANY($2::text[])",
        [w, members],
      )
    ).rows.length;
    if (found !== members.length)
      invalid("A member is not a teammate in this workspace.");
    await db.query(
      "DELETE FROM teammate_teams WHERE workspace_id=$1 AND team_id=$2 AND NOT teammate_id=ANY($3::text[])",
      [w, id, members],
    );
    await db.query(
      "INSERT INTO teammate_teams(workspace_id,teammate_id,team_id) SELECT $1,x,$2 FROM unnest($3::text[]) x ON CONFLICT DO NOTHING",
      [w, id, members],
    );
  }
  const assigned = await drainTeam(db, w, id);
  return { id, assigned: assigned.length };
}

/** Sets a teammate's own limits (needs `workspace.manage`); raising one may drain their queues. */
export async function saveTeammateLimits(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  await authorize(db, w, principal, "workspace.manage");
  assert(
    await routingEnabled(db, w),
    "ROUTING_DISABLED",
    "Routing is not enabled for this workspace.",
    404,
  );
  const updated = (
    await db.query(
      "UPDATE teammates SET conversation_limit=$3,ticket_limit=$4 WHERE workspace_id=$1 AND id=$2 RETURNING id",
      [
        w,
        String(p.teammateId ?? ""),
        limit(p.conversationLimit, 10000),
        limit(p.ticketLimit, 10000),
      ],
    )
  ).rows.length;
  assert(updated, "INVALID_ASSIGNEE", "Teammate unavailable.", 404);
  return {
    assigned: (await drainForTeammate(db, w, String(p.teammateId))).length,
  };
}

/** Teams with their settings and capacity (used against limit) for the team and each member. */
export async function listTeams(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "conversations.read");
  assert(
    await routingEnabled(db, w),
    "ROUTING_DISABLED",
    "Routing is not enabled for this workspace.",
    404,
  );
  const ids = (
    await db.query<{ id: string }>(
      "SELECT id FROM teams WHERE workspace_id=$1 ORDER BY name,id",
      [w],
    )
  ).rows;
  const teams = [];
  for (const { id } of ids) {
    const t = (await loadTeam(db, w, id))!;
    const meta = (
      await db.query<{ name: string; version: string; queued: string }>(
        `SELECT name,version::text AS version,(SELECT count(*) FROM conversations c WHERE c.workspace_id=t.workspace_id AND c.team_id=t.id AND c.assigned='' AND c.status='open' AND c.merged_into_id IS NULL) AS queued
        FROM teams t WHERE workspace_id=$1 AND id=$2`,
        [w, id],
      )
    ).rows[0];
    teams.push({
      id,
      name: meta.name,
      version: meta.version,
      method: t.method,
      conversationLimit: t.conversationLimit,
      ticketLimit: t.ticketLimit,
      ticketsCount: t.ticketsCount,
      includeAway: t.includeAway,
      queued: Number(meta.queued),
      used: { conversations: t.conversations, tickets: t.tickets },
      members: t.members.map((m) => ({
        id: m.id,
        presence: m.presence,
        used: { conversations: m.conversations, tickets: m.tickets },
        conversationLimit: m.conversationLimit,
        ticketLimit: m.ticketLimit,
      })),
    });
  }
  return { teams, canManage: await can(db, w, principal, "workspace.manage") };
}
