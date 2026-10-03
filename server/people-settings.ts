import { assert, DomainError, type Sql } from "./db";
import { authorize, capabilities, type Capability } from "./policy";
import { requireSettings } from "./settings";

/**
 * Settings › Teammates and Roles (S3a; docs/SETTINGS_STEP4.md), for those with
 * `teammates.manage`. Teammates who already exist get a role; roles are sets of capabilities.
 *
 * Nobody can hand out more than they hold: a role you assign or edit, and the role of anyone
 * you move, must be within your own capabilities. You can't change your own role or edit the
 * role you hold, so nobody locks themselves out. The owner role is fixed (every capability) and
 * the workspace always keeps an owner, so someone can always manage teammates.
 *
 * TODO(phase 16): inviting and removing teammates, and seats (full or limited) with billing.
 */
export const BUILT_IN_ROLES = ["owner", "admin", "agent"] as const;
const invalid = (message: string): never => {
  throw new DomainError("INVALID_ROLE", message, 400);
};
const refuse = (code: string, message: string): never => {
  throw new DomainError(code, message, 409);
};

async function capsOf(db: Sql, w: string, roleId: string) {
  return new Set(
    (
      await db.query<{ capability: string }>(
        "SELECT capability FROM role_capabilities WHERE workspace_id=$1 AND role_id=$2",
        [w, roleId],
      )
    ).rows.map((r) => r.capability),
  );
}
const within = (inner: Set<string>, outer: Set<string>) =>
  [...inner].every((c) => outer.has(c));

/** The acting manager: who they are, and what they may hand out. */
async function manager(db: Sql, w: string, principal: string) {
  const self = await authorize(db, w, principal, "teammates.manage");
  await requireSettings(db, w);
  return { self, caps: await capsOf(db, w, self.role_id) };
}

export async function listTeammates(db: Sql, w: string, principal: string) {
  const { self } = await manager(db, w, principal);
  const teammates = (
    await db.query<{
      id: string;
      name: string;
      role_id: string;
      role: string;
      seat: string;
      presence: string;
      teams: string[];
    }>(
      `SELECT t.id,t.name,t.role_id,r.name AS role,t.seat,t.presence,
        COALESCE((SELECT array_agg(g.name ORDER BY g.name) FROM teammate_teams m
          JOIN teams g ON g.workspace_id=m.workspace_id AND g.id=m.team_id
          WHERE m.workspace_id=t.workspace_id AND m.teammate_id=t.id),'{}') AS teams
       FROM teammates t JOIN roles r ON r.workspace_id=t.workspace_id AND r.id=t.role_id
       WHERE t.workspace_id=$1 ORDER BY lower(t.name),t.id`,
      [w],
    )
  ).rows;
  return {
    you: self.id,
    teammates: teammates.map((t) => ({
      id: t.id,
      name: t.name,
      roleId: t.role_id,
      role: t.role,
      seat: t.seat,
      presence: t.presence,
      teams: t.teams,
    })),
    roles: (await listRoles(db, w, principal)).roles,
  };
}

/** Moves a teammate to another role, within the rules above. */
export async function setTeammateRole(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const { self, caps } = await manager(db, w, principal);
  const target = (
    await db.query<{ id: string; name: string; role_id: string }>(
      "SELECT id,name,role_id FROM teammates WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [w, String(p.teammateId ?? "")],
    )
  ).rows[0];
  assert(target, "TEAMMATE_NOT_FOUND", "Teammate unavailable.", 404);
  const role = (
    await db.query<{ id: string; name: string }>(
      "SELECT id,name FROM roles WHERE workspace_id=$1 AND id=$2",
      [w, String(p.roleId ?? "")],
    )
  ).rows[0];
  assert(role, "ROLE_NOT_FOUND", "Role unavailable.", 404);
  if (target.id === self.id)
    refuse(
      "OWN_ROLE",
      "You can't change your own role. Ask another teammate who manages teammates.",
    );
  if (target.role_id === role.id) return { id: target.id, roleId: role.id };
  if (
    !within(await capsOf(db, w, target.role_id), caps) ||
    !within(await capsOf(db, w, role.id), caps)
  )
    refuse(
      "ROLE_ABOVE_YOURS",
      "That role has permissions you don't have, so you can't hand it out or take it away.",
    );
  if (target.role_id === "owner") {
    // Lock the owners, so two managers can't each move the other last owner at once.
    const owners = (
      await db.query(
        "SELECT id FROM teammates WHERE workspace_id=$1 AND role_id='owner' FOR UPDATE",
        [w],
      )
    ).rows.length;
    if (owners <= 1)
      refuse(
        "LAST_OWNER",
        `${target.name} is the workspace's only owner. Make someone else an owner first.`,
      );
  }
  await db.query(
    "UPDATE teammates SET role_id=$3 WHERE workspace_id=$1 AND id=$2",
    [w, target.id, role.id],
  );
  return { id: target.id, roleId: role.id };
}

export async function listRoles(db: Sql, w: string, principal: string) {
  const { self, caps } = await manager(db, w, principal);
  const roles = (
    await db.query<{
      id: string;
      name: string;
      capabilities: string[];
      teammates: number;
    }>(
      `SELECT r.id,r.name,
        COALESCE((SELECT array_agg(c.capability ORDER BY c.capability) FROM role_capabilities c
          WHERE c.workspace_id=r.workspace_id AND c.role_id=r.id),'{}') AS capabilities,
        (SELECT count(*) FROM teammates t WHERE t.workspace_id=r.workspace_id AND t.role_id=r.id)::int AS teammates
       FROM roles r WHERE r.workspace_id=$1
       ORDER BY array_position(ARRAY['owner','admin','agent'],r.id) NULLS LAST,lower(r.name)`,
      [w],
    )
  ).rows;
  return {
    roles: roles.map((r) => ({
      ...r,
      builtIn: (BUILT_IN_ROLES as readonly string[]).includes(r.id),
      // Whether this manager may edit it: not the owner role, not their own, nothing above them.
      editable:
        r.id !== "owner" &&
        r.id !== self.role_id &&
        within(new Set(r.capabilities), caps),
    })),
    yours: [...caps].sort(),
  };
}

/**
 * Creates a role, or renames one and sets its capabilities. Every role can read conversations
 * (that's what lets a teammate open Relay). Built-in roles keep their names.
 */
export async function saveRole(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const { self, caps } = await manager(db, w, principal);
  const existing =
    p.id === undefined
      ? null
      : (
          await db.query<{ id: string; name: string }>(
            "SELECT id,name FROM roles WHERE workspace_id=$1 AND id=$2",
            [w, String(p.id)],
          )
        ).rows[0];
  assert(
    p.id === undefined || existing,
    "ROLE_NOT_FOUND",
    "Role unavailable.",
    404,
  );
  if (existing?.id === "owner")
    refuse("ROLE_FIXED", "The owner role always has every permission.");
  if (existing && existing.id === self.role_id)
    refuse(
      "OWN_ROLE",
      "You can't edit the role you hold. Ask another teammate who manages teammates.",
    );
  if (existing && !within(await capsOf(db, w, existing.id), caps))
    refuse(
      "ROLE_ABOVE_YOURS",
      "That role has permissions you don't have, so you can't change it.",
    );
  if (p.action === "delete") {
    assert(existing, "ROLE_NOT_FOUND", "Role unavailable.", 404);
    if ((BUILT_IN_ROLES as readonly string[]).includes(existing.id))
      refuse("ROLE_FIXED", "Built-in roles can't be deleted.");
    const holders = (
      await db.query(
        "SELECT 1 FROM teammates WHERE workspace_id=$1 AND role_id=$2 LIMIT 1",
        [w, existing.id],
      )
    ).rows.length;
    if (holders)
      refuse(
        "ROLE_IN_USE",
        `Move everyone out of ${existing.name} before deleting it.`,
      );
    await db.query(
      "DELETE FROM role_capabilities WHERE workspace_id=$1 AND role_id=$2",
      [w, existing.id],
    );
    await db.query("DELETE FROM roles WHERE workspace_id=$1 AND id=$2", [
      w,
      existing.id,
    ]);
    return { id: existing.id };
  }
  if (!Array.isArray(p.capabilities)) invalid("Choose the role's permissions.");
  const wanted = new Set((p.capabilities as unknown[]).map((c) => String(c)));
  if (
    ![...wanted].every((c) => (capabilities as readonly string[]).includes(c))
  )
    invalid("A permission isn't recognised.");
  if (!wanted.has("conversations.read"))
    invalid(
      "Every role can see conversations: it's what lets a teammate open Relay.",
    );
  if (!within(wanted, caps))
    refuse(
      "ROLE_ABOVE_YOURS",
      "You can only give a role permissions you have yourself.",
    );
  let id: string;
  if (existing && (BUILT_IN_ROLES as readonly string[]).includes(existing.id))
    id = existing.id;
  else {
    const name =
      typeof p.name === "string" ? p.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > 40)
      invalid("Give the role a name of up to 40 characters.");
    const clash = (
      await db.query<{ name: string }>(
        "SELECT name FROM roles WHERE workspace_id=$1 AND lower(name)=lower($2) AND id<>$3",
        [w, name, existing?.id ?? ""],
      )
    ).rows[0];
    if (clash)
      refuse("ROLE_EXISTS", `There's already a role called “${clash.name}”.`);
    if (existing) {
      id = existing.id;
      await db.query(
        "UPDATE roles SET name=$3 WHERE workspace_id=$1 AND id=$2",
        [w, id, name],
      );
    } else {
      const base =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "")
          .slice(0, 30) || "role";
      const taken = (
        await db.query("SELECT 1 FROM roles WHERE workspace_id=$1 AND id=$2", [
          w,
          base,
        ])
      ).rows.length;
      id = taken ? `${base}_${crypto.randomUUID().slice(0, 6)}` : base;
      await db.query(
        "INSERT INTO roles(workspace_id,id,name) VALUES($1,$2,$3)",
        [w, id, name],
      );
    }
  }
  // Capabilities this page doesn't offer (none today) are left as they are.
  await db.query(
    "DELETE FROM role_capabilities WHERE workspace_id=$1 AND role_id=$2 AND capability=ANY($3::text[])",
    [w, id, capabilities.filter((c) => !wanted.has(c))],
  );
  for (const c of wanted)
    await db.query(
      "INSERT INTO role_capabilities(workspace_id,role_id,capability) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [w, id, c as Capability],
    );
  return { id };
}
