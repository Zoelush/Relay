import { assert, type Sql } from "./db";
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
}
export async function authorize(
  db: Sql,
  workspace: string,
  principal: string,
  capability: Capability,
): Promise<Teammate> {
  const t = (
    await db.query<Teammate>(
      // Phase 16 C1: the teammate becomes this transaction's actor for the audit log (`relay.actor_*`).
      // Phase 16 C2: and the role's scope (with the teammate's teams when it's restricted).
      `SELECT t.id,t.name,t.role_id,set_config('relay.actor_id',t.id,true),set_config('relay.actor_name',t.name,true),
       r.scope='assigned' AS restricted,
       CASE WHEN r.scope='assigned' THEN COALESCE((SELECT array_agg(m.team_id) FROM teammate_teams m WHERE m.workspace_id=t.workspace_id AND m.teammate_id=t.id),'{}') ELSE '{}' END AS teams
    FROM teammates t JOIN roles r ON r.workspace_id=t.workspace_id AND r.id=t.role_id
    JOIN role_capabilities p ON p.workspace_id=t.workspace_id AND p.role_id=t.role_id
    WHERE t.workspace_id=$1 AND t.principal_id=$2 AND p.capability=$3`,
      [workspace, principal, capability],
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
  return !!(
    await db.query(
      `SELECT 1 FROM teammates t JOIN role_capabilities p ON p.workspace_id=t.workspace_id AND p.role_id=t.role_id WHERE t.workspace_id=$1 AND t.principal_id=$2 AND p.capability=$3`,
      [workspace, principal, capability],
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
export function scopeSql(t: Pick<Teammate, "id" | "restricted" | "teams">, alias: string, values: unknown[]) {
  if (!t.restricted) return "true";
  return `(${alias}.assigned=$${values.push(t.id)} OR ${alias}.team_id=ANY($${values.push(t.teams ?? [])}::text[]))`;
}
/** A teammate's scope, by principal (for paths that don't otherwise authorize). */
export async function scopeOf(db: Sql, workspace: string, principal: string) {
  return authorize(db, workspace, principal, "conversations.read");
}
