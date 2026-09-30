import { assert, DomainError, once, type Sql } from "./db";
import { authorize, can, type Teammate } from "./policy";
import { access, command, conversation, type Command } from "./conversations";
import { SNOOZE_PRESETS } from "./snooze";
import {
  fillVariables,
  normalizeDoc,
  RichDocError,
  type RichDoc,
} from "../lib/rich-doc";

export type MacroAction =
  | { type: "assign"; teammateId?: string; teamId?: string }
  | { type: "tag_add" | "tag_remove"; tagId: string }
  | { type: "priority"; value: boolean }
  | { type: "snooze"; preset: (typeof SNOOZE_PRESETS)[number] }
  | { type: "close" | "reopen" }
  | { type: "attribute_set"; attributeId: string; value: unknown }
  | { type: "ticket_state"; stateId: string };
type Macro = {
  id: string;
  owner_id: string;
  shared: boolean;
  name: string;
  mode: "reply" | "note";
  body: RichDoc | null;
  actions: MacroAction[];
  version: string;
};
const MAX_ACTIONS = 10;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
/** Ticket state ids are `<type id>.<state key>`. */
const STATE_ID = /^[A-Za-z0-9_-]{1,100}\.[a-z0-9_-]{1,40}$/;
const invalid = (message: string): never => {
  throw new DomainError("INVALID_MACRO", message, 400);
};

/**
 * Validates an action list's shape. A ticket state action applies only to tickets of that
 * state's type; on anything else it fails like any other refused action.
 */
export function validateActions(input: unknown): MacroAction[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_ACTIONS)
    invalid("Add up to 10 actions.");
  let states = 0,
    ticketStates = 0;
  const out = (input as unknown[]).map((raw): MacroAction => {
    const a = (raw && typeof raw === "object" ? raw : {}) as Record<
      string,
      unknown
    >;
    const id = (v: unknown) =>
      typeof v === "string" && ID.test(v)
        ? v
        : invalid("Choose who or what this action uses.");
    switch (a.type) {
      case "assign":
        return {
          type: "assign",
          ...(a.teammateId !== undefined
            ? { teammateId: id(a.teammateId) }
            : {}),
          ...(a.teamId !== undefined ? { teamId: id(a.teamId) } : {}),
        };
      case "tag_add":
      case "tag_remove":
        return { type: a.type, tagId: id(a.tagId) };
      case "priority":
        if (typeof a.value !== "boolean") invalid("Choose priority on or off.");
        return { type: "priority", value: a.value as boolean };
      case "snooze":
        states++;
        if (!SNOOZE_PRESETS.includes(a.preset as never))
          invalid("Choose later today, tomorrow or next week.");
        return { type: "snooze", preset: a.preset as MacroAction & never };
      case "close":
      case "reopen":
        states++;
        return { type: a.type };
      case "attribute_set":
        return {
          type: "attribute_set",
          attributeId: id(a.attributeId),
          value: a.value,
        };
      case "ticket_state":
        ticketStates++;
        if (typeof a.stateId !== "string" || !STATE_ID.test(a.stateId))
          invalid("Choose a ticket state.");
        return { type: "ticket_state", stateId: a.stateId as string };
      default:
        return invalid("Use a supported action.");
    }
  });
  if (states > 1) invalid("Use one of close, reopen or snooze.");
  if (ticketStates > 1) invalid("Use one ticket state action.");
  return out;
}

/** Checks every teammate, team, tag and attribute an action names exists in this workspace. */
export async function checkTargets(db: Sql, w: string, actions: MacroAction[]) {
  const exists = async (table: string, id: string) =>
    (
      await db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND id=$2`, [
        w,
        id,
      ])
    ).rows.length > 0;
  for (const a of actions) {
    const missing =
      (a.type === "assign" &&
        a.teammateId &&
        !(await exists("teammates", a.teammateId))) ||
      (a.type === "assign" && a.teamId && !(await exists("teams", a.teamId))) ||
      ((a.type === "tag_add" || a.type === "tag_remove") &&
        !(await exists("tags", a.tagId))) ||
      (a.type === "attribute_set" &&
        !(await exists("attribute_definitions", a.attributeId))) ||
      (a.type === "ticket_state" &&
        !(
          await db.query(
            "SELECT 1 FROM ticket_states WHERE workspace_id=$1 AND id=$2 AND NOT archived",
            [w, a.stateId],
          )
        ).rows.length);
    if (missing)
      throw new DomainError(
        "MACRO_TARGET_MISSING",
        "Something this macro uses no longer exists. Edit the macro, then try again.",
        409,
      );
  }
}

function macroBody(input: unknown): RichDoc | null {
  if (input === null || input === undefined) return null;
  try {
    return normalizeDoc(input, { variables: true });
  } catch (e) {
    if (e instanceof RichDocError)
      throw new DomainError(e.code, e.message, 400);
    throw e;
  }
}

async function visibleMacro(
  db: Sql,
  w: string,
  t: Teammate,
  id: unknown,
  lock = false,
) {
  const m = (
    await db.query<Macro>(
      "SELECT id,owner_id,shared,name,mode,body,actions,version::text AS version FROM macros WHERE workspace_id=$1 AND id=$2 AND NOT archived AND (shared OR owner_id=$3)" +
        (lock ? " FOR UPDATE" : ""),
      [w, String(id ?? ""), t.id],
    )
  ).rows[0];
  assert(m, "MACRO_NOT_FOUND", "Macro unavailable.", 404);
  return m;
}

/** Macros the teammate can use: their own personal ones and every shared one. */
export async function listMacros(db: Sql, w: string, principal: string) {
  const t = await authorize(db, w, principal, "macros.use");
  const rights = {
    create: await can(db, w, principal, "macros.create"),
    edit: await can(db, w, principal, "macros.edit"),
    delete: await can(db, w, principal, "macros.delete"),
  };
  const macros = (
    await db.query<Macro>(
      "SELECT id,owner_id,shared,name,mode,body,actions,version::text AS version FROM macros WHERE workspace_id=$1 AND NOT archived AND (shared OR owner_id=$2) ORDER BY shared,lower(name),id",
      [w, t.id],
    )
  ).rows.map((m) => ({
    ...m,
    canEdit: m.shared ? rights.edit : m.owner_id === t.id,
    canDelete: m.shared ? rights.delete : m.owner_id === t.id,
  }));
  return { macros, canCreateShared: rights.create };
}

/**
 * Creates, updates or archives a macro. Personal macros belong to their owner (with
 * `macros.use`); shared ones need `macros.create`, `macros.edit` or `macros.delete`.
 * Updates carry the version they started from.
 */
export async function saveMacro(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  const t = await authorize(db, w, principal, "macros.use");
  const current =
    p.id === undefined ? null : await visibleMacro(db, w, t, p.id, true);
  const permit = async (
    capability: "macros.create" | "macros.edit" | "macros.delete",
  ) => {
    if (!(await can(db, w, principal, capability)))
      throw new DomainError(
        "FORBIDDEN",
        "You cannot change shared macros.",
        403,
      );
  };
  const owns = () =>
    assert(
      current?.owner_id === t.id,
      "FORBIDDEN",
      "Only its owner can change a personal macro.",
      403,
    );
  if (current) {
    assert(
      String(p.version) === current.version,
      "MACRO_CONFLICT",
      "This macro changed since you opened it. Reopen it and try again.",
      409,
    );
  }
  if (p.action === "archive") {
    assert(current, "MACRO_NOT_FOUND", "Macro unavailable.", 404);
    if (current.shared) await permit("macros.delete");
    else owns();
    await db.query(
      "UPDATE macros SET archived=true,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
      [w, current.id],
    );
    return { id: current.id };
  }
  assert(p.action === "save", "INVALID_MACRO", "Choose save or archive.");
  const shared =
    p.shared === undefined ? (current?.shared ?? false) : p.shared === true;
  assert(
    !current?.shared || shared,
    "MACRO_SHARING",
    "A shared macro stays shared. Duplicate it to make a personal copy.",
  );
  if (!current) {
    if (shared) await permit("macros.create");
  } else if (current.shared) await permit("macros.edit");
  else {
    owns();
    if (shared) await permit("macros.create");
  }
  const name =
    typeof p.name === "string" ? p.name.trim() : (current?.name ?? "");
  assert(
    name.length >= 1 && name.length <= 80,
    "INVALID_MACRO",
    "Name the macro using up to 80 characters.",
  );
  const mode = p.mode ?? current?.mode ?? "reply";
  assert(
    mode === "reply" || mode === "note",
    "INVALID_MACRO",
    "Choose reply or note.",
  );
  const body =
    p.body === undefined ? (current?.body ?? null) : macroBody(p.body);
  const actions =
    p.actions === undefined
      ? (current?.actions ?? [])
      : validateActions(p.actions);
  assert(
    body || actions.length,
    "INVALID_MACRO",
    "Add text or at least one action.",
  );
  await checkTargets(db, w, actions);
  const id = current?.id ?? crypto.randomUUID();
  const saved = (
    await db.query<{ version: string }>(
      `INSERT INTO macros(workspace_id,id,owner_id,shared,name,mode,body,actions) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(workspace_id,id) DO UPDATE SET shared=EXCLUDED.shared,name=EXCLUDED.name,mode=EXCLUDED.mode,body=EXCLUDED.body,actions=EXCLUDED.actions,version=macros.version+1,updated_at=now()
      RETURNING version::text AS version`,
      [
        w,
        id,
        current?.owner_id ?? t.id,
        shared,
        name,
        mode,
        body ? JSON.stringify(body) : null,
        JSON.stringify(actions),
      ],
    )
  ).rows[0];
  return { id, version: saved.version };
}

const commandFor = (a: MacroAction, timezone: unknown): Command => {
  switch (a.type) {
    case "assign":
      return { action: "assign", teammateId: a.teammateId, teamId: a.teamId };
    case "tag_add":
    case "tag_remove":
      return { action: a.type, tagId: a.tagId };
    case "priority":
      return { action: "priority", value: a.value };
    case "snooze":
      return {
        action: "snooze",
        preset: a.preset,
        timezone: timezone as string,
      };
    case "close":
    case "reopen":
      return { action: a.type };
    case "attribute_set":
      return {
        action: "attribute_set",
        attributeId: a.attributeId,
        value: a.value,
      };
    case "ticket_state":
      return { action: "ticket_state", stateId: a.stateId };
  }
};

/**
 * Applies a macro to a conversation. The whole action list is validated and its targets
 * checked before anything is written; the actions then run in this one transaction, so any
 * failure leaves the conversation unchanged, and the caller publishes only after commit.
 * Returns the macro's text with variables filled, for the teammate to review in the composer.
 */
export async function applyMacro(
  db: Sql,
  w: string,
  principal: string,
  key: string,
  p: Record<string, unknown>,
) {
  return once(db, w, "macro.apply:" + principal, key, p, async () => {
    const t = await authorize(db, w, principal, "macros.use");
    const m = await visibleMacro(db, w, t, p.macroId);
    const c = await conversation(db, w, String(p.conversationId ?? ""));
    await access(db, w, c, { type: "teammate", principal });
    const actions = validateActions(m.actions);
    await checkTargets(db, w, actions);
    const actor = { type: "teammate" as const, principal };
    // Each action runs as the applying teammate, with their own permissions: a macro never
    // lets anyone do what they could not do by hand. Any failure rolls back every action.
    try {
      for (const [i, action] of actions.entries())
        await command(db, w, actor, `${key}:${i}`, {
          ...commandFor(action, p.timezone),
          conversationId: c.id,
        });
    } catch (e) {
      if (e instanceof DomainError && e.code === "FORBIDDEN")
        throw new DomainError(
          "FORBIDDEN",
          "You don't have permission for one of this macro's actions.",
          403,
        );
      throw e;
    }
    // Personal data only for teammates allowed to see it; otherwise the fallback is used.
    const personal = await can(db, w, principal, "contacts.personal_data");
    const brand = (
      await db.query<{ name: string }>(
        "SELECT name FROM brands WHERE workspace_id=$1 AND id=$2",
        [w, c.brand_id],
      )
    ).rows[0];
    const name = typeof c.name === "string" ? c.name : "",
      email = typeof c.email === "string" ? c.email : "";
    const doc = m.body
      ? fillVariables(m.body, {
          "contact.name": personal ? name : undefined,
          "contact.first_name": personal
            ? name.trim().split(/\s+/)[0]
            : undefined,
          "contact.email": personal ? email : undefined,
          "conversation.title": c.title,
          "teammate.name": t.name,
          "brand.name": brand?.name,
        })
      : null;
    return { mode: m.mode, doc, applied: actions.length, macro: m.name };
  });
}
