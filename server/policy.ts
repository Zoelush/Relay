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
  "conversations.assign",
  "reports.view",
  "reports.share",
  "data.export",
  "teammates.manage",
  "billing.manage",
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
}
export async function authorize(
  db: Sql,
  workspace: string,
  principal: string,
  capability: Capability,
): Promise<Teammate> {
  const t = (
    await db.query<Teammate>(
      `SELECT t.id,t.name,t.role_id FROM teammates t JOIN role_capabilities p ON p.workspace_id=t.workspace_id AND p.role_id=t.role_id
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
