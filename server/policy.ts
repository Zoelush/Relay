import { assert, type Sql } from "./db";
import { LIMITED_CAPABILITIES } from "../lib/seats";
export const capabilities = [
  "conversations.reply",
  "conversations.note",
  "conversations.delete_reply",
  "conversations.delete_note",
  "macros.manage",
  "macros.use",
  "macros.create",
  "macros.edit",
  "macros.delete",
  "tickets.manage",
  "knowledge.manage",
  "conversations.assign",
  "reports.view",
  "reports.share",
  "data.export",
  "teammates.manage",
  "billing.manage",
  "security.manage",
  "workspace.manage",
  "contacts.personal_data",
  "conversations.manage",
  "conversations.read",
] as const;
export type Capability = (typeof capabilities)[number];
export interface Teammate {
  id: string;
  name: string;
  role_id: string;
  /** Phase 16 C2: a restricted role sees only conversations assigned to this teammate or their teams. */
  restricted?: boolean;
  /** Their teams, when restricted (otherwise empty: not needed). */
  teams?: string[];
  /** Phase 16 C8b: a limited seat lists no conversations (it opens them by link). */
  limited?: boolean;
}
/**
 * Phase 16 C7b (docs/SECURITY_STEP12.md): a support session's principal, `relay-support:<session>`.
 * It's a read-only teammate, "Relay support (email)", with every capability and no restricted scope,
 * only while its session is live and its workspace's grant is open; it has no `teammates` row. The
 * agent API refuses everything but reads from it (`SUPPORT_READ_ONLY`), before any route runs.
 */
export const SUPPORT_PREFIX = "relay-support:";
export const isSupport = (principal: string) => principal.startsWith(SUPPORT_PREFIX);
/** What the inbox shouldn't offer Relay support (writing): `can` says no; the API refuses them anyway. */
const WRITES: Capability[] = ["conversations.reply", "conversations.note", "conversations.delete_reply", "conversations.delete_note", "macros.create", "macros.edit", "macros.delete", "conversations.assign", "reports.share", "data.export"];
async function supportTeammate(db: Sql, workspace: string, principal: string): Promise<Teammate | null> {
  const s = (
    await db.query<{ email: string }>(
      // The audit log's actor for this transaction: Relay support, by email, via support access.
      `SELECT s.email,set_config('relay.actor_id','relay-support',true),set_config('relay.actor_name','Relay support ('||s.email||')',true),set_config('relay.actor_via','support',true)
       FROM support_sessions s JOIN support_grants g ON g.workspace_id=s.workspace_id AND g.id=s.grant_id
       WHERE s.workspace_id=$1 AND s.id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND g.revoked_at IS NULL AND g.expires_at>now()`,
      [workspace, principal.slice(SUPPORT_PREFIX.length)],
    )
  ).rows[0];
  return s ? { id: "relay-support", name: `Relay support (${s.email})`, role_id: "relay-support", restricted: false, teams: [] } : null;
}

export async function authorize(
  db: Sql,
  workspace: string,
  principal: string,
  capability: Capability,
): Promise<Teammate> {
  if (isSupport(principal)) {
    const support = await supportTeammate(db, workspace, principal);
    assert(support, "FORBIDDEN", "You do not have permission for this action.", 403);
    return support!;
  }
  const t = (
    await db.query<Teammate>(
      // Phase 16 C1: the teammate becomes this transaction's actor for the audit log (`relay.actor_*`).
      // Phase 16 C2: and the role's scope (with the teammate's teams when it's restricted).
      `SELECT t.id,t.name,t.role_id,set_config('relay.actor_id',t.id,true),set_config('relay.actor_name',t.name,true),
       r.scope='assigned' AS restricted,t.seat='limited' AS limited,
       CASE WHEN r.scope='assigned' THEN COALESCE((SELECT array_agg(m.team_id) FROM teammate_teams m WHERE m.workspace_id=t.workspace_id AND m.teammate_id=t.id),'{}') ELSE '{}' END AS teams
    FROM teammates t JOIN roles r ON r.workspace_id=t.workspace_id AND r.id=t.role_id
    JOIN role_capabilities p ON p.workspace_id=t.workspace_id AND p.role_id=t.role_id
    WHERE t.workspace_id=$1 AND t.principal_id=$2 AND p.capability=$3
      -- Phase 16 C8b: a limited seat keeps only its few capabilities, whatever its role.
      AND (t.seat<>'limited' OR p.capability=ANY($4::text[]))`,
      [workspace, principal, capability, LIMITED_CAPABILITIES],
    )
  ).rows[0];
  assert(t, "FORBIDDEN", "You do not have permission for this action.", 403);
  return t;
}
export async function can(
  db: Sql,
  workspace: string,
  principal: string,
  capability: Capability,
  resource?: { workspace_id: string },
) {
  if (resource && resource.workspace_id !== workspace) return false;
  if (isSupport(principal)) return !WRITES.includes(capability) && !!(await supportTeammate(db, workspace, principal));
  return !!(
    await db.query(
      `SELECT 1 FROM teammates t JOIN role_capabilities p ON p.workspace_id=t.workspace_id AND p.role_id=t.role_id WHERE t.workspace_id=$1 AND t.principal_id=$2 AND p.capability=$3
       AND (t.seat<>'limited' OR p.capability=ANY($4::text[]))`,
      [workspace, principal, capability, LIMITED_CAPABILITIES],
    )
  ).rows.length;
}

/**
 * Phase 16 C2: which conversations a teammate may see. Unrestricted roles see all of them; a
 * restricted role sees only those assigned to the teammate or to one of their teams. This is the
 * one definition: `visibleTo` for one conversation (used by `access`), `scopeSql` for every list,
 * search and count. A test matrix holds every route to it.
 */
export function visibleTo(t: Pick<Teammate, "id" | "restricted" | "teams">, c: { assigned?: string | null; team_id?: string | null }) {
  return !t.restricted || c.assigned === t.id || (!!c.team_id && (t.teams ?? []).includes(c.team_id));
}
/** The same rule as SQL over a conversations alias, adding its values; "true" when unrestricted. */
export function scopeSql(t: Pick<Teammate, "id" | "restricted" | "teams" | "limited">, alias: string, values: unknown[]) {
  // Phase 16 C8b: a limited seat lists, counts and searches nothing; it opens conversations by link.
  if (t.limited) return "false";
  if (!t.restricted) return "true";
  return `(${alias}.assigned=$${values.push(t.id)} OR ${alias}.team_id=ANY($${values.push(t.teams ?? [])}::text[]))`;
}
/** A teammate's scope, by principal (for paths that don't otherwise authorize). */
export async function scopeOf(db: Sql, workspace: string, principal: string) {
  return authorize(db, workspace, principal, "conversations.read");
}
