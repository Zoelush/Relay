import { assert, digest, DomainError, type Sql } from "./db";
import { authorize, can } from "./policy";
import type { Conversation } from "./conversations";

/**
 * Tickets (phase 05). A ticket is a conversation with a ticket record attached: a workspace-
 * defined type, a state from that type's own set, and the type's typed fields, stored as
 * conversation attributes. States move only along the type's transitions.
 */
export const CATEGORIES = ["customer", "back_office", "tracker"] as const;
export const STATE_KINDS = [
  "submitted",
  "in_progress",
  "waiting_on_customer",
  "resolved",
] as const;
const KEY = /^[a-z0-9_-]{1,40}$/;
const MAX_STATES = 30,
  MAX_FIELDS = 30;

type Author = { type: string; id: string; name?: string };
type Append = (
  db: Sql,
  w: string,
  c: Conversation,
  author: Author,
  kind: string,
  body?: string,
  data?: Record<string, unknown>,
  audience?: string,
) => Promise<unknown>;

export type TicketState = {
  id: string;
  name: string;
  customerLabel: string;
  kind: (typeof STATE_KINDS)[number];
  position: number;
};
export type TicketField = {
  attributeId: string;
  name: string;
  valueType: string;
  options: string[];
  requiredToClose: boolean;
};
export type TicketType = {
  id: string;
  name: string;
  icon: string;
  category: (typeof CATEGORIES)[number];
  description: string;
  version: string;
  archived: boolean;
  states: TicketState[];
  transitions: [string, string][];
  fields: TicketField[];
};
type TicketRow = {
  conversation_id: string;
  number: string;
  type_id: string;
  state_id: string;
  version: string;
};

export async function ticketsEnabled(db: Sql, w: string) {
  return (
    (
      await db.query(
        "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='tickets_v1' AND enabled",
        [w],
      )
    ).rows.length > 0
  );
}
async function requireTickets(db: Sql, w: string) {
  assert(
    await ticketsEnabled(db, w),
    "TICKETS_DISABLED",
    "Tickets are not enabled for this workspace.",
    404,
  );
}

/** Ticket types with their states, transitions and fields, in one read per table. */
export async function loadTypes(db: Sql, w: string, ids?: string[]) {
  const filter = ids ? " AND id=ANY($2::text[])" : "";
  const typeFilter = ids ? " AND type_id=ANY($2::text[])" : "";
  const values = ids ? [w, ids] : [w];
  const types = (
    await db.query<{
      id: string;
      name: string;
      icon: string;
      category: TicketType["category"];
      description: string;
      version: string;
      archived: boolean;
    }>(
      "SELECT id,name,icon,category,description,version,archived FROM ticket_types WHERE workspace_id=$1" +
        filter +
        " ORDER BY name,id",
      values,
    )
  ).rows;
  const states = (
    await db.query<{
      id: string;
      type_id: string;
      name: string;
      customer_label: string;
      kind: TicketState["kind"];
      position: number;
    }>(
      "SELECT id,type_id,name,customer_label,kind,position FROM ticket_states WHERE workspace_id=$1 AND NOT archived" +
        typeFilter +
        " ORDER BY position,id",
      values,
    )
  ).rows;
  const transitions = (
    await db.query<{ type_id: string; from_state: string; to_state: string }>(
      "SELECT type_id,from_state,to_state FROM ticket_transitions WHERE workspace_id=$1" +
        typeFilter +
        " ORDER BY from_state,to_state",
      values,
    )
  ).rows;
  const fields = (
    await db.query<{
      type_id: string;
      attribute_id: string;
      name: string;
      value_type: string;
      options: string[] | null;
      required_to_close: boolean;
    }>(
      `SELECT f.type_id,f.attribute_id,a.name,a.value_type,a.options,f.required_to_close FROM ticket_type_attributes f
      JOIN attribute_definitions a ON a.workspace_id=f.workspace_id AND a.id=f.attribute_id
      WHERE f.workspace_id=$1 AND a.archived_at IS NULL${ids ? " AND f.type_id=ANY($2::text[])" : ""} ORDER BY f.position,f.attribute_id`,
      values,
    )
  ).rows;
  return types.map((t): TicketType => ({
    ...t,
    version: String(t.version),
    states: states
      .filter((s) => s.type_id === t.id)
      .map((s) => ({
        id: s.id,
        name: s.name,
        customerLabel: s.customer_label,
        kind: s.kind,
        position: s.position,
      })),
    transitions: transitions
      .filter((x) => x.type_id === t.id)
      .map((x) => [x.from_state, x.to_state]),
    fields: fields
      .filter((f) => f.type_id === t.id)
      .map((f) => ({
        attributeId: f.attribute_id,
        name: f.name,
        valueType: f.value_type,
        options: f.options ?? [],
        requiredToClose: f.required_to_close,
      })),
  }));
}
async function loadType(db: Sql, w: string, id: unknown) {
  const [type] =
    typeof id === "string" && id ? await loadTypes(db, w, [id]) : [];
  assert(type, "TICKET_TYPE_NOT_FOUND", "Ticket type unavailable.", 404);
  return type;
}

export async function listTicketTypes(db: Sql, w: string, principal: string) {
  await authorize(db, w, principal, "conversations.read");
  await requireTickets(db, w);
  return {
    types: (await loadTypes(db, w)).filter((t) => !t.archived),
    canManage: await can(db, w, principal, "tickets.manage"),
  };
}

type StateInput = {
  key: string;
  name: string;
  customerLabel: string;
  kind: string;
};
const invalid = (message: string): never => {
  throw new DomainError("INVALID_TICKET_TYPE", message, 400);
};
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "type";

/**
 * Creates or updates a ticket type (needs `tickets.manage`). The whole definition is checked
 * before anything is stored: at least one open and one resolved state, transitions only between
 * the type's states, and every open state able to reach a resolved one. The category is fixed
 * once created. A state that tickets are currently in cannot be removed.
 */
export async function saveTicketType(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  await authorize(db, w, principal, "tickets.manage");
  await requireTickets(db, w);
  if (p.action === "archive") {
    const type = await loadType(db, w, p.id);
    assert(
      String(p.version) === type.version,
      "TICKET_TYPE_CONFLICT",
      "This ticket type changed elsewhere. Reload and try again.",
      409,
    );
    await db.query(
      "UPDATE ticket_types SET archived=true,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
      [w, type.id],
    );
    return { id: type.id };
  }
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name || name.length > 80) invalid("Give the ticket type a name.");
  const icon =
    typeof p.icon === "string" && p.icon.trim() ? p.icon.trim() : "ticket";
  if (icon.length > 32) invalid("Choose a shorter icon name.");
  const description = typeof p.description === "string" ? p.description : "";
  if (description.length > 500)
    invalid("Keep the description under 500 characters.");
  if (
    !Array.isArray(p.states) ||
    !p.states.length ||
    p.states.length > MAX_STATES
  )
    invalid(`Give the type between 1 and ${MAX_STATES} states.`);
  const states = (p.states as unknown[]).map((raw): StateInput => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const state = {
      key: String(s.key ?? ""),
      name: String(s.name ?? "").trim(),
      customerLabel: String(s.customerLabel ?? s.name ?? "").trim(),
      kind: String(s.kind ?? ""),
    };
    if (!KEY.test(state.key))
      invalid(
        "Each state needs a short key: lowercase letters, digits, - or _.",
      );
    if (
      !state.name ||
      state.name.length > 60 ||
      state.customerLabel.length > 60
    )
      invalid("Each state needs a name of up to 60 characters.");
    if (!STATE_KINDS.includes(state.kind as TicketState["kind"]))
      invalid(
        "Each state must be submitted, in progress, waiting on customer or resolved.",
      );
    return state;
  });
  const keys = new Set(states.map((s) => s.key));
  if (keys.size !== states.length) invalid("State keys must be unique.");
  if (new Set(states.map((s) => s.name.toLowerCase())).size !== states.length)
    invalid("State names must be unique.");
  const resolved = new Set(
    states.filter((s) => s.kind === "resolved").map((s) => s.key),
  );
  if (!resolved.size || resolved.size === states.length)
    invalid("A type needs at least one resolved state and one that is not.");
  const transitions = (Array.isArray(p.transitions) ? p.transitions : []).map(
    (raw) => {
      const pair = raw as unknown[];
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        !keys.has(String(pair[0])) ||
        !keys.has(String(pair[1])) ||
        pair[0] === pair[1]
      )
        invalid("Transitions must connect two different states of this type.");
      return [String(pair[0]), String(pair[1])] as [string, string];
    },
  );
  // Every open state must be able to reach a resolved state.
  for (const start of states.filter((s) => !resolved.has(s.key))) {
    const seen = new Set([start.key]),
      queue = [start.key];
    let reaches = false;
    while (queue.length && !reaches) {
      const at = queue.shift()!;
      for (const [from, to] of transitions)
        if (from === at && !seen.has(to)) {
          if (resolved.has(to)) reaches = true;
          seen.add(to);
          queue.push(to);
        }
    }
    if (!reaches) invalid(`“${start.name}” has no path to a resolved state.`);
  }
  const fieldInput = Array.isArray(p.fields)
    ? (p.fields as Record<string, unknown>[])
    : [];
  if (fieldInput.length > MAX_FIELDS)
    invalid(`A type can have up to ${MAX_FIELDS} fields.`);
  const fieldIds = fieldInput.map((f) => String(f?.attributeId ?? ""));
  if (new Set(fieldIds).size !== fieldIds.length)
    invalid("Each field can be added once.");
  if (fieldIds.length) {
    const found = (
      await db.query<{ id: string }>(
        "SELECT id FROM attribute_definitions WHERE workspace_id=$1 AND id=ANY($2::text[]) AND owner_type='conversation' AND archived_at IS NULL",
        [w, fieldIds],
      )
    ).rows.length;
    if (found !== fieldIds.length)
      invalid("A field refers to an attribute that is unavailable.");
  }

  let id: string;
  if (p.id !== undefined) {
    const current = await loadType(db, w, p.id);
    assert(
      String(p.version) === current.version,
      "TICKET_TYPE_CONFLICT",
      "This ticket type changed elsewhere. Reload and try again.",
      409,
    );
    if (p.category !== undefined && p.category !== current.category)
      invalid("A ticket type's category cannot change.");
    id = current.id;
    const kept = new Set(states.map((s) => `${id}.${s.key}`));
    const removed = current.states
      .filter((s) => !kept.has(s.id))
      .map((s) => s.id);
    if (removed.length) {
      const inUse = (
        await db.query<{ name: string }>(
          `SELECT DISTINCT s.name FROM tickets t JOIN ticket_states s ON s.workspace_id=t.workspace_id AND s.id=t.state_id
          WHERE t.workspace_id=$1 AND t.state_id=ANY($2::text[]) ORDER BY s.name`,
          [w, removed],
        )
      ).rows.map((r) => r.name);
      assert(
        !inUse.length,
        "TICKET_STATE_IN_USE",
        `Move tickets out of ${inUse.join(", ")} before removing ${inUse.length === 1 ? "it" : "them"}.`,
        409,
      );
    }
    await db.query(
      "UPDATE ticket_types SET name=$3,icon=$4,description=$5,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
      [w, id, name, icon, description],
    );
    await db.query(
      "DELETE FROM ticket_transitions WHERE workspace_id=$1 AND type_id=$2",
      [w, id],
    );
    // Removed states are archived: no ticket is in them, and history keeps their names.
    await db.query(
      "UPDATE ticket_states SET archived=true WHERE workspace_id=$1 AND type_id=$2 AND id=ANY($3::text[])",
      [w, id, removed],
    );
  } else {
    if (!CATEGORIES.includes(p.category as TicketType["category"]))
      invalid("Choose customer, back-office or tracker.");
    const base = slug(name);
    const taken = (
      await db.query(
        "SELECT 1 FROM ticket_types WHERE workspace_id=$1 AND id=$2",
        [w, base],
      )
    ).rows.length;
    id = taken ? `${base}-${crypto.randomUUID().slice(0, 6)}` : base;
    await db.query(
      "INSERT INTO ticket_types(workspace_id,id,name,icon,category,description) VALUES($1,$2,$3,$4,$5,$6)",
      [w, id, name, icon, p.category, description],
    );
  }
  for (const [position, s] of states.entries())
    await db.query(
      `INSERT INTO ticket_states(workspace_id,id,type_id,name,customer_label,kind,position) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(workspace_id,id) DO UPDATE SET name=$4,customer_label=$5,kind=$6,position=$7,archived=false`,
      [
        w,
        `${id}.${s.key}`,
        id,
        s.name,
        s.customerLabel || s.name,
        s.kind,
        position,
      ],
    );
  for (const [from, to] of transitions)
    await db.query(
      "INSERT INTO ticket_transitions(workspace_id,type_id,from_state,to_state) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [w, id, `${id}.${from}`, `${id}.${to}`],
    );
  await db.query(
    "DELETE FROM ticket_type_attributes WHERE workspace_id=$1 AND type_id=$2",
    [w, id],
  );
  for (const [position, f] of fieldInput.entries())
    await db.query(
      "INSERT INTO ticket_type_attributes(workspace_id,type_id,attribute_id,required_to_close,position) VALUES($1,$2,$3,$4,$5)",
      [w, id, String(f.attributeId), f.requiredToClose === true, position],
    );
  return { id, version: (await loadType(db, w, id)).version };
}

async function ticketOf(db: Sql, w: string, conversationId: string) {
  return (
    await db.query<TicketRow>(
      "SELECT conversation_id,number,type_id,state_id,version FROM tickets WHERE workspace_id=$1 AND conversation_id=$2",
      [w, conversationId],
    )
  ).rows[0];
}
const stateRef = (s: TicketState) => ({ id: s.id, name: s.name, kind: s.kind });
const hasValue = (v: unknown) =>
  v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length);

/** Fields the type requires before closing that this conversation has not filled. */
function missingRequired(type: TicketType, c: Conversation) {
  const values = (c.attributes ?? {}) as Record<string, unknown>;
  return type.fields.filter(
    (f) => f.requiredToClose && !hasValue(values[f.attributeId]),
  );
}
function requireFilled(type: TicketType, c: Conversation) {
  const missing = missingRequired(type, c);
  if (missing.length)
    throw new DomainError(
      "TICKET_FIELDS_REQUIRED",
      `Fill in ${missing.map((f) => f.name).join(", ")} before closing this ticket.`,
      409,
      { fields: missing.map((f) => ({ id: f.attributeId, name: f.name })) },
    );
}

/** Closing a ticket's conversation needs the same required fields as a resolved state. */
export async function assertClosable(db: Sql, w: string, c: Conversation) {
  const ticket = await ticketOf(db, w, c.id);
  if (ticket) requireFilled(await loadType(db, w, ticket.type_id), c);
}

/** A ticket field may be set only on a ticket whose type has it. */
export async function assertFieldAllowed(
  db: Sql,
  w: string,
  c: Conversation,
  attributeId: string,
) {
  const owners = (
    await db.query<{ type_id: string }>(
      "SELECT type_id FROM ticket_type_attributes WHERE workspace_id=$1 AND attribute_id=$2",
      [w, attributeId],
    )
  ).rows.map((r) => r.type_id);
  if (!owners.length) return;
  const ticket = await ticketOf(db, w, c.id);
  assert(
    ticket && owners.includes(ticket.type_id),
    "TICKET_FIELD",
    "This field belongs to a ticket type this conversation does not have.",
    409,
  );
}

/** Refuses merging a ticket's conversation away, which would detach the ticket. */
export async function assertMergeable(
  db: Sql,
  w: string,
  source: Conversation,
) {
  assert(
    !(await ticketOf(db, w, source.id)),
    "TICKET_MERGE",
    "A ticket cannot be merged into another conversation. Merge the other conversation into it instead.",
    409,
  );
}

/** Turns a conversation into a ticket of a customer type, in a chosen open state. */
export async function convertToTicket(
  db: Sql,
  w: string,
  c: Conversation,
  who: Author,
  p: { typeId?: unknown; stateId?: unknown },
  append: Append,
) {
  await requireTickets(db, w);
  assert(
    !(await ticketOf(db, w, c.id)),
    "TICKET_EXISTS",
    "This conversation is already a ticket.",
    409,
  );
  const type = await loadType(db, w, p.typeId);
  assert(
    !type.archived,
    "TICKET_TYPE_NOT_FOUND",
    "Ticket type unavailable.",
    404,
  );
  // TODO(phase 05, step A2): back-office and tracker tickets are created alongside and linked
  // to conversations, not converted from them.
  assert(
    type.category === "customer",
    "TICKET_CATEGORY",
    "Back-office and tracker tickets are linked to conversations rather than converted from them.",
    409,
  );
  const state =
    type.states.find((s) => s.id === p.stateId) ??
    type.states.find((s) => s.kind !== "resolved");
  assert(
    state && state.kind !== "resolved",
    "TICKET_STATE",
    "Choose a starting state that is not resolved.",
  );
  const number = (
    await db.query<{ number: string }>(
      `INSERT INTO ticket_counters(workspace_id,next) VALUES($1,2)
      ON CONFLICT(workspace_id) DO UPDATE SET next=ticket_counters.next+1 RETURNING next-1 AS number`,
      [w],
    )
  ).rows[0].number;
  await db.query(
    "INSERT INTO tickets(workspace_id,conversation_id,number,type_id,state_id,created_by) VALUES($1,$2,$3,$4,$5,$6)",
    [w, c.id, number, type.id, state.id, who.id],
  );
  // Internal for now: customer-visible ticket updates arrive with the categories in step A2.
  await append(
    db,
    w,
    c,
    who,
    "system_event",
    "",
    {
      event: "ticket_created",
      number: Number(number),
      type: { id: type.id, name: type.name },
      state: stateRef(state),
    },
    "internal",
  );
  return { number: Number(number) };
}

/** Moves a ticket along its type's transitions. Resolving needs the required fields filled. */
export async function setTicketState(
  db: Sql,
  w: string,
  c: Conversation,
  who: Author,
  p: { stateId?: unknown },
  append: Append,
) {
  await requireTickets(db, w);
  const ticket = await ticketOf(db, w, c.id);
  assert(ticket, "NOT_A_TICKET", "This conversation is not a ticket.", 409);
  if (ticket.state_id === p.stateId) return;
  const type = await loadType(db, w, ticket.type_id);
  const from = type.states.find((s) => s.id === ticket.state_id);
  const to = type.states.find((s) => s.id === p.stateId);
  assert(to, "TICKET_STATE", "Choose a state of this ticket's type.", 404);
  assert(
    type.transitions.some(([a, b]) => a === ticket.state_id && b === to.id),
    "TICKET_TRANSITION",
    `A ${type.name} ticket cannot move from ${from?.name ?? "its current state"} to ${to.name}.`,
    409,
  );
  if (to.kind === "resolved") requireFilled(type, c);
  await db.query(
    "UPDATE tickets SET state_id=$3,version=version+1,updated_at=now() WHERE workspace_id=$1 AND conversation_id=$2",
    [w, c.id, to.id],
  );
  await append(
    db,
    w,
    c,
    who,
    "system_event",
    "",
    {
      event: "ticket_state_change",
      from: from ? stateRef(from) : { id: ticket.state_id },
      to: stateRef(to),
    },
    "internal",
  );
}

type Preview = {
  conversationId: string;
  from: { id: string; name: string };
  to: { id: string; name: string };
  state: { id: string; name: string };
  kept: { id: string; name: string }[];
  moved: {
    from: { id: string; name: string };
    to: { id: string; name: string };
  }[];
  lost: { id: string; name: string; value: unknown }[];
  token: string;
};

/**
 * What changing a ticket's type would do: fields both types share are kept, a field mapped to
 * a compatible field of the new type moves, and every other filled field is lost. The token
 * binds the change to this exact preview and ticket version.
 */
async function preview(
  db: Sql,
  w: string,
  c: Conversation,
  p: { typeId?: unknown; stateId?: unknown; mapping?: unknown },
): Promise<Preview & { toType: TicketType; ticket: TicketRow }> {
  const ticket = await ticketOf(db, w, c.id);
  assert(ticket, "NOT_A_TICKET", "This conversation is not a ticket.", 409);
  const from = await loadType(db, w, ticket.type_id),
    to = await loadType(db, w, p.typeId);
  assert(
    !to.archived,
    "TICKET_TYPE_NOT_FOUND",
    "Ticket type unavailable.",
    404,
  );
  assert(
    to.id !== from.id,
    "TICKET_TYPE_SAME",
    "The ticket already has this type.",
  );
  assert(
    to.category === from.category,
    "TICKET_CATEGORY",
    "Choose a type of the same category.",
    409,
  );
  const state =
    to.states.find((s) => s.id === p.stateId) ??
    to.states.find((s) => s.kind !== "resolved")!;
  assert(
    state.kind !== "resolved",
    "TICKET_STATE",
    "Choose a state that is not resolved.",
  );
  const values = (c.attributes ?? {}) as Record<string, unknown>;
  const mapping = (
    p.mapping && typeof p.mapping === "object" ? p.mapping : {}
  ) as Record<string, unknown>;
  const toIds = new Set(to.fields.map((f) => f.attributeId));
  const kept: Preview["kept"] = [],
    moved: Preview["moved"] = [],
    lost: Preview["lost"] = [];
  const used = new Set<string>();
  for (const f of from.fields) {
    const ref = { id: f.attributeId, name: f.name };
    if (toIds.has(f.attributeId)) {
      kept.push(ref);
      continue;
    }
    const value = values[f.attributeId];
    if (!hasValue(value)) continue;
    const target = to.fields.find(
      (t) => t.attributeId === mapping[f.attributeId],
    );
    const compatible =
      target &&
      !used.has(target.attributeId) &&
      !from.fields.some((x) => x.attributeId === target.attributeId) &&
      !hasValue(values[target.attributeId]) &&
      target.valueType === f.valueType &&
      (target.valueType !== "options" ||
        (value as string[]).every((v) => target.options.includes(v)));
    if (mapping[f.attributeId] !== undefined)
      assert(
        compatible,
        "TICKET_MAPPING",
        `${f.name} cannot be moved to that field.`,
      );
    if (compatible) {
      used.add(target.attributeId);
      moved.push({
        from: ref,
        to: { id: target.attributeId, name: target.name },
      });
    } else lost.push({ ...ref, value });
  }
  const body = {
    conversationId: c.id,
    from: { id: from.id, name: from.name },
    to: { id: to.id, name: to.name },
    state: { id: state.id, name: state.name },
    kept,
    moved,
    lost,
  };
  return {
    ...body,
    token: await digest({ ...body, version: String(ticket.version) }),
    toType: to,
    ticket,
  };
}

export async function previewTypeChange(
  db: Sql,
  w: string,
  c: Conversation,
  p: { typeId?: unknown; stateId?: unknown; mapping?: unknown },
): Promise<Preview> {
  await requireTickets(db, w);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { toType, ticket, ...result } = await preview(db, w, c, p);
  return result;
}

/** Applies a previewed type change; a different or stale preview is refused. */
export async function changeTicketType(
  db: Sql,
  w: string,
  c: Conversation,
  who: Author,
  p: {
    typeId?: unknown;
    stateId?: unknown;
    mapping?: unknown;
    token?: unknown;
  },
  append: Append,
) {
  await requireTickets(db, w);
  const change = await preview(db, w, c, p);
  assert(
    p.token === change.token,
    "TICKET_PREVIEW_STALE",
    "The ticket changed since you reviewed this. Review the change again.",
    409,
  );
  for (const m of change.moved) {
    await db.query(
      "UPDATE conversation_attribute_values SET attribute_id=$4,updated_at=now() WHERE workspace_id=$1 AND conversation_id=$2 AND attribute_id=$3",
      [w, c.id, m.from.id, m.to.id],
    );
    await db.query(
      "UPDATE conversations SET attributes=(attributes-$3::text)||jsonb_build_object($4::text,attributes->$3::text) WHERE workspace_id=$1 AND id=$2",
      [w, c.id, m.from.id, m.to.id],
    );
  }
  for (const l of change.lost) {
    await db.query(
      "DELETE FROM conversation_attribute_values WHERE workspace_id=$1 AND conversation_id=$2 AND attribute_id=$3",
      [w, c.id, l.id],
    );
    await db.query(
      "UPDATE conversations SET attributes=attributes-$3::text WHERE workspace_id=$1 AND id=$2",
      [w, c.id, l.id],
    );
  }
  await db.query(
    "UPDATE tickets SET type_id=$3,state_id=$4,version=version+1,updated_at=now() WHERE workspace_id=$1 AND conversation_id=$2",
    [w, c.id, change.to.id, change.state.id],
  );
  // The lost values are kept in the (internal) timeline event, so the change is auditable.
  await append(
    db,
    w,
    c,
    who,
    "system_event",
    "",
    {
      event: "ticket_type_change",
      from: change.from,
      to: change.to,
      state: change.state,
      moved: change.moved,
      lost: change.lost,
    },
    "internal",
  );
}

/** The ticket panel for the conversation sidebar. */
export async function ticketContext(db: Sql, w: string, c: Conversation) {
  if (!(await ticketsEnabled(db, w))) return { enabled: false, ticket: null };
  const ticket = await ticketOf(db, w, c.id);
  if (!ticket) return { enabled: true, ticket: null };
  const type = await loadType(db, w, ticket.type_id);
  const state = type.states.find((s) => s.id === ticket.state_id);
  const values = (c.attributes ?? {}) as Record<string, unknown>;
  return {
    enabled: true,
    ticket: {
      number: Number(ticket.number),
      version: String(ticket.version),
      type: {
        id: type.id,
        name: type.name,
        icon: type.icon,
        category: type.category,
      },
      state: state
        ? { ...stateRef(state), customerLabel: state.customerLabel }
        : { id: ticket.state_id, name: ticket.state_id, kind: "in_progress" },
      nextStates: type.transitions
        .filter(([from]) => from === ticket.state_id)
        .map(([, to]) => type.states.find((s) => s.id === to))
        .filter((s): s is TicketState => !!s)
        .map(stateRef),
      fields: type.fields.map((f) => ({
        id: f.attributeId,
        name: f.name,
        valueType: f.valueType,
        options: f.options,
        requiredToClose: f.requiredToClose,
        value: values[f.attributeId] ?? null,
      })),
    },
  };
}
