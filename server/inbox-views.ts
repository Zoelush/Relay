import { assert, once, tenant, type Sql, type Connect } from "./db";
import { authorize, can, type Teammate } from "./policy";
import {
  agentConversation,
  listPreviews,
  type Conversation,
} from "./conversations";
import { enqueueJob, type Job } from "./jobs";

export type ViewFilter =
  | { and: ViewFilter[] }
  | { or: ViewFilter[] }
  | {
      field:
        | "state"
        | "channel"
        | "assignee"
        | "team"
        | "tag"
        | "topic"
        | "priority"
        | "brand"
        | "created_at"
        | "mentioned"
        | "sla"
        | "ticket_type"
        | "ai_state";
      op: "eq" | "ne" | "in" | "gte" | "lte";
      value: string | boolean | string[];
    };
export type InboxView = {
  id: string;
  owner_id: string;
  name: string;
  shared: boolean;
  filter: ViewFilter;
  sort: string;
  revision: string;
  builtin: string | null;
  ready: boolean;
  position: number;
  folder_id: string | null;
  set_id: string | null;
};
const columns: Record<string, string> = {
  state: "status",
  channel: "channel",
  assignee: "assigned",
  team: "team_id",
  priority: "priority",
  brand: "brand_id",
  created_at: "created_at",
  // The AI agent's state (phase 08 A2a): pending, escalated, needs_input or resolved.
  ai_state: "ai_state",
};
const AI_STATES = ["pending", "escalated", "needs_input", "resolved"];
export function validateFilter(
  input: unknown,
  depth = 0,
  budget = { nodes: 0 },
): asserts input is ViewFilter {
  assert(
    input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      depth <= 4 &&
      ++budget.nodes <= 30,
    "INVALID_FILTER",
    "Use at most 30 conditions and four group levels.",
  );
  const p = input as Record<string, unknown>;
  if ("and" in p || "or" in p) {
    const group = p.and ?? p.or;
    assert(
      Object.keys(p).length === 1 &&
        Array.isArray(group) &&
        group.length > 0 &&
        group.length <= 20,
      "INVALID_FILTER",
      "Choose conditions for this group.",
    );
    for (const child of group) validateFilter(child, depth + 1, budget);
    return;
  }
  assert(
    typeof p.field === "string" &&
      (p.field in columns ||
        ["tag", "topic", "mentioned", "sla", "ticket_type"].includes(p.field)),
    "FILTER_UNAVAILABLE",
    "This filter is unavailable. Contact and company attributes require the people service.",
  );
  assert(
    ["eq", "ne", "in", "gte", "lte"].includes(String(p.op)),
    "INVALID_FILTER",
    "Choose a supported comparison.",
  );
  if (p.field === "sla")
    assert(
      ["eq", "ne"].includes(String(p.op)) &&
        (p.value === "overdue" || p.value === "breached"),
      "INVALID_FILTER",
      "Choose overdue (running and past due) or breached (ever).",
    );
  else if (p.field === "mentioned")
    assert(
      p.op === "eq" && typeof p.value === "string" && p.value.length <= 200,
      "INVALID_FILTER",
      "Choose a teammate who was mentioned.",
    );
  else if (p.field === "ai_state")
    assert(
      ["eq", "ne", "in"].includes(String(p.op)) &&
        (Array.isArray(p.value) ? p.value : [p.value]).every((v) =>
          AI_STATES.includes(String(v)),
        ),
      "INVALID_FILTER",
      "Choose an AI agent state: pending, escalated, needs teammate input or resolved.",
    );
  else if (p.field === "priority")
    assert(
      ["eq", "ne"].includes(String(p.op)) && typeof p.value === "boolean",
      "INVALID_FILTER",
      "Priority is a boolean.",
    );
  else if (p.op === "in")
    assert(
      Array.isArray(p.value) &&
        p.value.length > 0 &&
        p.value.length <= 50 &&
        p.value.every((x) => typeof x === "string" && x.length <= 200),
      "INVALID_FILTER",
      "Choose up to 50 values.",
    );
  else
    assert(
      typeof p.value === "string" && p.value.length <= 200,
      "INVALID_FILTER",
      "Use a text value.",
    );
  if (p.field === "created_at")
    assert(
      p.op !== "in" &&
        typeof p.value === "string" &&
        /(?:Z|[+-]\d\d:\d\d)$/.test(p.value) &&
        Number.isFinite(Date.parse(p.value)),
      "INVALID_FILTER",
      "Supply a date with an explicit timezone.",
    );
  else
    assert(
      !["gte", "lte"].includes(String(p.op)),
      "INVALID_FILTER",
      "Range comparisons apply to dates.",
    );
}
/** Only fixed column/operator names enter SQL. Every user value is a bind parameter. */
export function compileFilter(filter: ViewFilter, values: unknown[]): string {
  if ("and" in filter)
    return (
      "(" + filter.and.map((f) => compileFilter(f, values)).join(" AND ") + ")"
    );
  if ("or" in filter)
    return (
      "(" + filter.or.map((f) => compileFilter(f, values)).join(" OR ") + ")"
    );
  const bind = (v: unknown) => {
    values.push(v);
    return "$" + values.length;
  };
  if (filter.field === "sla") {
    const col = filter.value === "overdue" ? "c.sla_overdue" : "c.sla_breached";
    return filter.op === "ne" ? `NOT ${col}` : col;
  }
  if (filter.field === "ticket_type") {
    const p = bind(filter.op === "in" ? filter.value : [filter.value]);
    const expression = `EXISTS(SELECT 1 FROM tickets tk WHERE tk.workspace_id=c.workspace_id AND tk.conversation_id=c.id AND tk.type_id=ANY(${p}::text[]))`;
    return filter.op === "ne" ? `NOT (${expression})` : expression;
  }
  if (filter.field === "mentioned")
    return `EXISTS(SELECT 1 FROM conversation_mentions x WHERE x.workspace_id=c.workspace_id AND x.conversation_id=c.id AND x.teammate_id=${bind(filter.value)})`;
  if (filter.field === "tag" || filter.field === "topic") {
    const p = bind(filter.op === "in" ? filter.value : [filter.value]);
    const expression =
      filter.field === "tag"
        ? `EXISTS(SELECT 1 FROM conversation_tags t WHERE t.workspace_id=c.workspace_id AND t.conversation_id=c.id AND t.tag_id=ANY(${p}::text[]))`
        : `c.topics && ${p}::text[]`;
    return filter.op === "ne" ? `NOT (${expression})` : expression;
  }
  const col = "c." + columns[filter.field];
  if (filter.op === "in") return `${col}=ANY(${bind(filter.value)}::text[])`;
  const op = {
    eq: "IS NOT DISTINCT FROM",
    ne: "IS DISTINCT FROM",
    gte: ">=",
    lte: "<=",
  }[filter.op];
  return `${col} ${op} ${bind(filter.value)}${filter.field === "created_at" ? "::timestamptz" : ""}`;
}
export async function viewsEnabled(db: Sql, w: string) {
  assert(
    (
      await db.query(
        "SELECT name FROM workspace_features WHERE workspace_id=$1 AND name='agent_inbox_views_v1' AND enabled",
        [w],
      )
    ).rows.length,
    "FEATURE_DISABLED",
    "Inbox views are not enabled.",
    404,
  );
}
/** Set id for a view's filter, derived in SQL from the normalized jsonb text. */
const setIdOf = (column: string) =>
  `encode(sha256(convert_to(${column}::text,'UTF8')),'hex')`;
/**
 * Points a view at the shared set for its filter, creating the set if needed.
 * Returns the set id when it needs a rebuild: a new set, one that is not ready, or one no
 * other active view uses (projection skips unused sets, so its members may be stale).
 */
async function attachSet(db: Sql, w: string, viewId: string) {
  await db.query(
    `INSERT INTO inbox_filter_sets(workspace_id,id,filter) SELECT workspace_id,${setIdOf("filter")},filter FROM inbox_views WHERE workspace_id=$1 AND id=$2 ON CONFLICT DO NOTHING`,
    [w, viewId],
  );
  const set = (
    await db.query<{ id: string; ready: boolean; used: boolean }>(
      `SELECT s.id,s.ready,EXISTS(SELECT 1 FROM inbox_views o WHERE o.workspace_id=$1 AND o.set_id=s.id AND NOT o.archived AND o.id<>$2) AS used
      FROM inbox_views v JOIN inbox_filter_sets s ON s.workspace_id=v.workspace_id AND s.id=${setIdOf("v.filter")}
      WHERE v.workspace_id=$1 AND v.id=$2 FOR UPDATE OF s`,
      [w, viewId],
    )
  ).rows[0];
  await db.query(
    "UPDATE inbox_views SET set_id=$3 WHERE workspace_id=$1 AND id=$2",
    [w, viewId, set.id],
  );
  if (set.used && set.ready) return null;
  if (!set.used)
    await db.query(
      "UPDATE inbox_filter_sets SET ready=false WHERE workspace_id=$1 AND id=$2",
      [w, set.id],
    );
  return set.id;
}
async function enqueueRebuild(
  db: Sql,
  w: string,
  t: Teammate,
  setIds: (string | null)[],
) {
  const ids = [...new Set(setIds.filter((x): x is string => !!x))];
  return ids.length
    ? enqueueJob(
        db,
        w,
        "inbox.views.rebuild",
        { setIds: ids },
        { teammateId: t.id },
      )
    : null;
}
/** Default views, in display order. Missing ones are added by the idempotent initialize. */
export const BUILTIN_VIEWS = ["mine", "mentions", "unassigned", "all"] as const;
/** Built-in views from before the status picker: they filtered to one status themselves. */
const RETIRED_BUILTINS = ["open", "snoozed", "closed"];
/**
 * A teammate's default views. Status is chosen in the list's status picker, so the views say
 * whose conversations, not which status: Mine, Mentions, Unassigned and All. Views from before
 * the picker are brought up to date here (each initialize is idempotent): Mine and Unassigned
 * stop filtering to open, and All open, Snoozed and Closed are archived in favour of All.
 */
export async function seedInboxViews(db: Sql, w: string, t: Teammate) {
  const eq = (field: string, value: string) => ({ field, op: "eq", value });
  const defaults = [
    ["mine", "Mine", eq("assignee", t.id)],
    ["mentions", "Mentions", eq("mentioned", t.id)],
    ["unassigned", "Unassigned", eq("assignee", "")],
    [
      "all",
      "All",
      { field: "state", op: "in", value: ["open", "snoozed", "closed"] },
    ],
  ] as const;
  await db.query(
    "UPDATE inbox_views SET archived=true,revision=revision+1 WHERE workspace_id=$1 AND owner_id=$2 AND builtin=ANY($3::text[]) AND NOT archived",
    [w, t.id, RETIRED_BUILTINS],
  );
  // Built-in views start on the newest sort, last activity (the old default was newest first).
  await db.query(
    "UPDATE inbox_views SET sort='activity',revision=revision+1 WHERE workspace_id=$1 AND owner_id=$2 AND builtin IS NOT NULL AND sort='newest'",
    [w, t.id],
  );
  for (const [builtin, , filter] of defaults)
    // A changed filter detaches the view; initialize attaches it to its new set.
    await db.query(
      "UPDATE inbox_views SET filter=$4,set_id=NULL,revision=revision+1 WHERE workspace_id=$1 AND owner_id=$2 AND builtin=$3 AND filter<>$4::jsonb",
      [w, t.id, builtin, JSON.stringify(filter)],
    );
  for (const [builtin, name, filter] of defaults) {
    await db.query(
      "INSERT INTO inbox_views(workspace_id,id,owner_id,name,filter,builtin,position,sort) VALUES($1,$2,$3,$4,$5,$6,$7,'activity') ON CONFLICT DO NOTHING",
      [
        w,
        crypto.randomUUID(),
        t.id,
        name,
        JSON.stringify(filter),
        builtin,
        BUILTIN_VIEWS.indexOf(builtin),
      ],
    );
  }
  await seedTeamInboxes(db, w, t);
  await seedAiView(db, w, t);
}
/** Team inboxes are built-in views named `team:<team id>`, one for each team the teammate is on. */
export const TEAM_INBOX = "team:";
/** The teams a teammate is on, by name: the team inboxes they should have. */
export async function myTeams(db: Sql, w: string, teammateId: string) {
  return (
    await db.query<{ id: string; name: string }>(
      "SELECT t.id,t.name FROM teams t JOIN teammate_teams m ON m.workspace_id=t.workspace_id AND m.team_id=t.id WHERE t.workspace_id=$1 AND m.teammate_id=$2 ORDER BY lower(t.name),t.id",
      [w, teammateId],
    )
  ).rows;
}
/**
 * One team inbox per team the teammate is on, listing that team's conversations (the status
 * picker narrows them). Leaving a team archives its inbox; rejoining brings the same view back;
 * a renamed team renames it. Each change detaches the view so initialize attaches its set again.
 */
async function seedTeamInboxes(db: Sql, w: string, t: Teammate) {
  const teams = await myTeams(db, w, t.id);
  await db.query(
    "UPDATE inbox_views SET archived=true,set_id=NULL,revision=revision+1 WHERE workspace_id=$1 AND owner_id=$2 AND starts_with(builtin,$3) AND NOT builtin=ANY($4::text[]) AND NOT archived",
    [w, t.id, TEAM_INBOX, teams.map((x) => TEAM_INBOX + x.id)],
  );
  for (const [i, team] of teams.entries()) {
    const filter = JSON.stringify({ field: "team", op: "eq", value: team.id });
    await db.query(
      `INSERT INTO inbox_views(workspace_id,id,owner_id,name,filter,builtin,position,sort) VALUES($1,$2,$3,$4,$5,$6,$7,'activity')
       ON CONFLICT(workspace_id,owner_id,builtin) WHERE builtin IS NOT NULL DO UPDATE SET archived=false,name=EXCLUDED.name,filter=EXCLUDED.filter,position=EXCLUDED.position,
         set_id=CASE WHEN inbox_views.archived OR inbox_views.filter<>EXCLUDED.filter THEN NULL ELSE inbox_views.set_id END,revision=inbox_views.revision+1
       WHERE inbox_views.archived OR inbox_views.name<>EXCLUDED.name OR inbox_views.filter<>EXCLUDED.filter OR inbox_views.position<>EXCLUDED.position`,
      [
        w,
        crypto.randomUUID(),
        t.id,
        team.name.slice(0, 80),
        filter,
        TEAM_INBOX + team.id,
        BUILTIN_VIEWS.length + i,
      ],
    );
  }
}
const viewColumns =
  "v.id,v.owner_id,v.name,v.shared,v.folder_id,v.position,v.filter,v.sort,v.builtin,v.revision,v.set_id";
// A view's count is its open conversations (the status picker shows the rest).
const countColumns =
  "COALESCE(s.ready,false) AS ready,COALESCE(s.open_count,0)::text AS count,COALESCE(s.count_version,0)::text AS count_version,CASE WHEN s.open_count>9999 THEN '9,999+' ELSE COALESCE(s.open_count,0)::text END AS count_label";
const withSet =
  "inbox_views v LEFT JOIN inbox_filter_sets s ON s.workspace_id=v.workspace_id AND s.id=v.set_id";
export async function visibleView(
  db: Sql,
  w: string,
  t: Teammate,
  id: string,
  lock = false,
) {
  const v = (
    await db.query<InboxView>(
      `SELECT ${viewColumns},COALESCE(s.ready,false) AS ready FROM ${withSet} WHERE v.workspace_id=$1 AND v.id=$2 AND NOT v.archived AND (v.owner_id=$3 OR v.shared)` +
        (lock ? " FOR UPDATE OF v" : ""),
      [w, id, t.id],
    )
  ).rows[0];
  assert(v, "VIEW_NOT_FOUND", "View unavailable.", 404);
  return v;
}
/** The AI agent's view (phase 08 A2a): a built-in view while the agent is on. */
export const AI_VIEW = "ai:escalated";
const aiOn = async (db: Sql, w: string) =>
  (
    await db.query(
      "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='ai_agent_v1' AND enabled",
      [w],
    )
  ).rows.length > 0;
/**
 * "Escalated by AI": conversations the agent handed to the team, including those handed over
 * while the team was away. Archived while the agent is off.
 */
async function seedAiView(db: Sql, w: string, t: Teammate) {
  if (!(await aiOn(db, w))) {
    await db.query(
      "UPDATE inbox_views SET archived=true,set_id=NULL,revision=revision+1 WHERE workspace_id=$1 AND owner_id=$2 AND builtin=$3 AND NOT archived",
      [w, t.id, AI_VIEW],
    );
    return;
  }
  const filter = JSON.stringify({
    field: "ai_state",
    op: "in",
    value: ["escalated", "needs_input"],
  });
  await db.query(
    `INSERT INTO inbox_views(workspace_id,id,owner_id,name,filter,builtin,position,sort) VALUES($1,$2,$3,'Escalated by AI',$4,$5,$6,'activity')
     ON CONFLICT(workspace_id,owner_id,builtin) WHERE builtin IS NOT NULL DO UPDATE SET archived=false,
       set_id=CASE WHEN inbox_views.archived OR inbox_views.filter<>EXCLUDED.filter THEN NULL ELSE inbox_views.set_id END,filter=EXCLUDED.filter,revision=inbox_views.revision+1
     WHERE inbox_views.archived OR inbox_views.filter<>EXCLUDED.filter`,
    [w, crypto.randomUUID(), t.id, filter, AI_VIEW, BUILTIN_VIEWS.length],
  );
}
export async function viewSnapshot(db: Sql, w: string, t: Teammate) {
  const views = (
    await db.query(
      `SELECT ${viewColumns},${countColumns} FROM ${withSet} WHERE v.workspace_id=$1 AND NOT v.archived AND (v.owner_id=$2 OR v.shared) ORDER BY v.position,v.created_at,v.id`,
      [w, t.id],
    )
  ).rows;
  const folders = (
    await db.query(
      "SELECT id,name,owner_id,shared,position FROM inbox_view_folders WHERE workspace_id=$1 AND (owner_id=$2 OR shared) ORDER BY position,id",
      [w, t.id],
    )
  ).rows;
  // The client compares these with its team inboxes and runs initialize when they differ.
  return {
    views,
    folders,
    teams: await myTeams(db, w, t.id),
    // Whether "Escalated by AI" should be there, so the client can run initialize if not.
    ai: await aiOn(db, w),
  };
}
export async function mutateView(
  db: Sql,
  w: string,
  principal: string,
  key: string,
  p: Record<string, unknown>,
) {
  const t = await authorize(db, w, principal, "conversations.read");
  await viewsEnabled(db, w);
  return once(db, w, "inbox.views:" + t.id, key, p, async () => {
    if (p.action === "initialize") {
      await seedInboxViews(db, w, t);
      const unattached = (
        await db.query<{ id: string }>(
          "SELECT id FROM inbox_views WHERE workspace_id=$1 AND owner_id=$2 AND NOT archived AND set_id IS NULL ORDER BY id",
          [w, t.id],
        )
      ).rows;
      const rebuild = [];
      for (const v of unattached) rebuild.push(await attachSet(db, w, v.id));
      const pending = (
        await db.query<{ id: string }>(
          "SELECT DISTINCT s.id FROM inbox_views v JOIN inbox_filter_sets s ON s.workspace_id=v.workspace_id AND s.id=v.set_id WHERE v.workspace_id=$1 AND v.owner_id=$2 AND NOT v.archived AND NOT s.ready",
          [w, t.id],
        )
      ).rows.map((s) => s.id);
      return {
        jobId: await enqueueRebuild(db, w, t, [...rebuild, ...pending]),
      };
    }
    if (p.action === "folder") {
      assert(
        typeof p.name === "string" && p.name.trim() && p.name.length <= 80,
        "INVALID_NAME",
        "Name the folder.",
      );
      const id = typeof p.id === "string" ? p.id : crypto.randomUUID();
      if (p.shared) await authorize(db, w, principal, "workspace.manage");
      const existing = p.id
        ? (
            await db.query<{ position: number }>(
              "SELECT position FROM inbox_view_folders WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 FOR UPDATE",
              [w, id, t.id],
            )
          ).rows[0]
        : undefined;
      if (p.id)
        assert(existing, "FOLDER_NOT_FOUND", "Folder unavailable.", 404);
      await db.query(
        "INSERT INTO inbox_view_folders(workspace_id,id,owner_id,name,shared,position) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,id) DO UPDATE SET name=EXCLUDED.name,shared=EXCLUDED.shared,position=EXCLUDED.position",
        [
          w,
          id,
          t.id,
          p.name.trim(),
          p.shared === true,
          Number.isInteger(p.position)
            ? p.position
            : (existing?.position ??
              (await nextPosition(db, w, "inbox_view_folders", null))),
        ],
      );
      return { id };
    }
    if (p.action === "move") return moveView(db, w, principal, t, p);
    const current =
      typeof p.id === "string" ? await visibleView(db, w, t, p.id, true) : null;
    if (current && p.action !== "duplicate") {
      assert(
        current.owner_id === t.id ||
          (current.shared && (await can(db, w, principal, "workspace.manage"))),
        "FORBIDDEN",
        "You cannot edit this view.",
        403,
      );
      assert(
        String(p.revision) === String(current.revision),
        "VIEW_CONFLICT",
        "This view changed. Refresh before editing.",
        409,
      );
    }
    if (p.action === "archive") {
      assert(
        current && !current.builtin,
        "INVALID_VIEW",
        "Default views cannot be archived.",
      );
      await db.query(
        "UPDATE inbox_views SET archived=true,revision=revision+1 WHERE workspace_id=$1 AND id=$2",
        [w, current.id],
      );
      return { id: current.id };
    }
    assert(
      ["save", "duplicate"].includes(String(p.action)),
      "INVALID_ACTION",
      "Choose a view action.",
    );
    const filter = p.filter ?? current?.filter;
    validateFilter(filter);
    const name =
      p.name ??
      (p.action === "duplicate" ? current?.name + " copy" : current?.name);
    assert(
      typeof name === "string" && name.trim() && name.length <= 80,
      "INVALID_NAME",
      "Name the view using up to 80 characters.",
    );
    const sort = String(p.sort ?? current?.sort ?? "activity");
    assert(
      sort in LIST_SORTS || sort in LEGACY_SORTS,
      "INVALID_SORT",
      "Choose an available sort.",
    );
    // Fields left out of a save keep their current values; a duplicate starts personal.
    const keep = p.action === "save" && current;
    const shared =
      p.shared === undefined ? !!keep && current.shared : p.shared === true;
    const folderId = (
      p.folderId === undefined ? (keep ? current.folder_id : null) : p.folderId
    ) as string | null;
    if (shared) await authorize(db, w, principal, "workspace.manage");
    assert(
      !current?.builtin || p.action === "duplicate" || !shared,
      "INVALID_VIEW",
      "Default views stay personal. Duplicate one to share it.",
    );
    if (folderId)
      assert(
        (
          await db.query(
            "SELECT id FROM inbox_view_folders WHERE workspace_id=$1 AND id=$2 AND (owner_id=$3 OR shared) AND (NOT $4::boolean OR shared)",
            [w, folderId, t.id, shared],
          )
        ).rows.length,
        "FOLDER_NOT_FOUND",
        "Choose an accessible folder with compatible visibility.",
        404,
      );
    const id =
      p.action === "duplicate" || !current ? crypto.randomUUID() : current.id;
    const filterChanged =
      !current ||
      p.action === "duplicate" ||
      JSON.stringify(filter) !== JSON.stringify(current.filter);
    if (current?.builtin && p.action !== "duplicate")
      assert(
        !filterChanged,
        "INVALID_VIEW",
        "Duplicate a default view before changing its filter.",
      );
    await db.query(
      `INSERT INTO inbox_views(workspace_id,id,owner_id,name,shared,folder_id,position,filter,sort,set_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT(workspace_id,id) DO UPDATE SET name=EXCLUDED.name,shared=EXCLUDED.shared,folder_id=EXCLUDED.folder_id,position=EXCLUDED.position,filter=EXCLUDED.filter,sort=EXCLUDED.sort,revision=inbox_views.revision+1`,
      [
        w,
        id,
        t.id,
        name.trim(),
        shared,
        folderId,
        Number.isInteger(p.position)
          ? p.position
          : keep
            ? current.position
            : await nextPosition(db, w, "inbox_views", folderId),
        JSON.stringify(filter),
        sort,
        current && !filterChanged ? current.set_id : null,
      ],
    );
    // A filter another view already uses is ready immediately; only new or unused sets rebuild.
    const jobId = filterChanged
      ? await enqueueRebuild(db, w, t, [await attachSet(db, w, id)])
      : null;
    return jobId ? { id, jobId } : { id };
  });
}
async function nextPosition(
  db: Sql,
  w: string,
  table: "inbox_views" | "inbox_view_folders",
  folder: unknown,
) {
  const scope =
    table === "inbox_views"
      ? " AND NOT archived AND folder_id IS NOT DISTINCT FROM $2::text"
      : "";
  return Number(
    (
      await db.query<{ next: number }>(
        `SELECT COALESCE(max(position)+1,0) AS next FROM ${table} WHERE workspace_id=$1${scope}`,
        table === "inbox_views" ? [w, folder] : [w],
      )
    ).rows[0].next,
  );
}
/**
 * Moves a view one place up or down among the views the teammate may edit in its folder,
 * renumbering them so no two share a position. Position is display order, not part of the
 * definition: the view's revision and list cursors are unchanged.
 */
async function moveView(
  db: Sql,
  w: string,
  principal: string,
  t: Teammate,
  p: Record<string, unknown>,
) {
  assert(
    p.direction === "up" || p.direction === "down",
    "INVALID_ORDER",
    "Move a view up or down.",
  );
  const current = await visibleView(db, w, t, String(p.id ?? ""), true);
  const manage = await can(db, w, principal, "workspace.manage");
  assert(
    current.owner_id === t.id || (current.shared && manage),
    "FORBIDDEN",
    "You cannot edit this view.",
    403,
  );
  // Default views and team inboxes keep their own order; the rest move among themselves.
  assert(
    !current.builtin,
    "INVALID_VIEW",
    "Default views and team inboxes keep their place.",
  );
  const ids = (
    await db.query<{ id: string }>(
      "SELECT id FROM inbox_views WHERE workspace_id=$1 AND NOT archived AND builtin IS NULL AND folder_id IS NOT DISTINCT FROM $2::text AND (owner_id=$3 OR (shared AND $4::boolean)) ORDER BY position,created_at,id FOR UPDATE",
      [w, current.folder_id, t.id, manage],
    )
  ).rows.map((r) => r.id);
  const from = ids.indexOf(current.id),
    to = from + (p.direction === "up" ? -1 : 1);
  if (to >= 0 && to < ids.length) [ids[from], ids[to]] = [ids[to], ids[from]];
  await db.query(
    "UPDATE inbox_views v SET position=o.ord-1 FROM unnest($2::text[]) WITH ORDINALITY AS o(id,ord) WHERE v.workspace_id=$1 AND v.id=o.id AND v.position<>o.ord-1",
    [w, ids],
  );
  return { id: current.id };
}
type FilterSet = { id: string; filter: ViewFilter };
/** Conversations examined per rebuild step; each step commits with its checkpoint. */
const REBUILD_BATCH = 250;
/** A set's filter never changes (its id is the filter's hash), so a checkpoint stays valid. */
export async function rebuildViews(connect: Connect, job: Job) {
  return tenant(connect, job.workspace_id, async (db) => {
    const w = job.workspace_id;
    const checkpoint = job.result ?? {},
      index = Number(checkpoint.index ?? 0),
      ids = (job.payload.setIds ?? []) as string[];
    if (index >= ids.length) return { done: true, result: { ...checkpoint } };
    const set = (
      await db.query<FilterSet>(
        "SELECT id,filter FROM inbox_filter_sets WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [w, ids[index]],
      )
    ).rows[0];
    const rows = set
      ? (
          await db.query<{ id: string }>(
            "SELECT id FROM conversations WHERE workspace_id=$1 AND id>$2 ORDER BY id LIMIT $3",
            [w, String(checkpoint.after ?? ""), REBUILD_BATCH],
          )
        ).rows
      : [];
    if (set)
      await projectSets(
        db,
        w,
        [set],
        rows.map((r) => r.id),
      );
    const finished = rows.length < REBUILD_BATCH;
    if (set && finished)
      await db.query(
        "UPDATE inbox_filter_sets SET ready=true WHERE workspace_id=$1 AND id=$2",
        [w, set.id],
      );
    const result = finished
      ? { index: index + 1 }
      : { index, after: rows.at(-1)!.id };
    // Persist the checkpoint with the membership changes; safe after lost job acknowledgement.
    await db.query(
      "UPDATE jobs SET result=$3 WHERE workspace_id=$1 AND id=$2 AND lease_token=$4",
      [w, job.id, JSON.stringify(result), job.lease_token],
    );
    return { done: Number(result.index) >= ids.length, result };
  });
}
/** Sets evaluated per statement. Each set is one distinct filter shared by all its views. */
const SETS_PER_STATEMENT = 50;
/** Sort key for conversations without an SLA clock: after every running and paused one. */
const NO_SLA = "9999-12-31T00:00:00Z";
/**
 * What members carry for the status picker and sorts: the status, the ticket state's kind, the
 * last reply either way (tags and reads don't count as activity), priority and snooze time.
 */
const MEMBER_KEYS = `c.status,(SELECT ts.kind FROM tickets k JOIN ticket_states ts ON ts.workspace_id=k.workspace_id AND ts.type_id=k.type_id AND ts.id=k.state_id
  WHERE k.workspace_id=c.workspace_id AND k.conversation_id=c.id) AS ticket_kind,
  COALESCE(GREATEST(c.last_contact_reply_at,c.last_teammate_reply_at),c.created_at) AS activity_at,c.priority,c.snooze_until`;
/**
 * Reconciles membership of `ids` in `sets`: removes non-matching rows, inserts new matches
 * and refreshes sort keys of existing ones. One statement per chunk of sets.
 */
async function projectSets(
  db: Sql,
  w: string,
  sets: FilterSet[],
  ids: string[],
) {
  if (!ids.length) return;
  for (let i = 0; i < sets.length; i += SETS_PER_STATEMENT) {
    const chunk = sets.slice(i, i + SETS_PER_STATEMENT),
      values: unknown[] = [w, ids, chunk.map((s) => s.id)];
    const bind = (v: unknown) => {
      values.push(v);
      return "$" + values.length;
    };
    const matches = chunk
      .map(
        (s) =>
          `SELECT ${bind(s.id)}::text AS set_id,c.id AS conversation_id,c.created_at,COALESCE(c.last_contact_reply_at,c.created_at) AS waiting_at,COALESCE(c.sla_sort_at,'${NO_SLA}'::timestamptz) AS sla_sort_at,${MEMBER_KEYS} FROM conversations c WHERE c.workspace_id=$1 AND c.id=ANY($2::text[]) AND c.merged_into_id IS NULL AND ${compileFilter(s.filter, values)}`,
      )
      .join(" UNION ALL ");
    // DELETE and INSERT touch disjoint rows, so both see the same snapshot safely.
    await db.query(
      `WITH matches AS (${matches}),
      removed AS (DELETE FROM inbox_filter_members m WHERE m.workspace_id=$1 AND m.set_id=ANY($3::text[]) AND m.conversation_id=ANY($2::text[])
        AND NOT EXISTS(SELECT 1 FROM matches x WHERE x.set_id=m.set_id AND x.conversation_id=m.conversation_id))
      INSERT INTO inbox_filter_members(workspace_id,set_id,conversation_id,created_at,waiting_at,sla_sort_at,status,ticket_kind,activity_at,priority,snooze_until)
      SELECT $1,set_id,conversation_id,created_at,waiting_at,sla_sort_at,status,ticket_kind,activity_at,priority,snooze_until FROM matches
      ON CONFLICT(workspace_id,set_id,conversation_id) DO UPDATE SET created_at=EXCLUDED.created_at,waiting_at=EXCLUDED.waiting_at,sla_sort_at=EXCLUDED.sla_sort_at,
        status=EXCLUDED.status,ticket_kind=EXCLUDED.ticket_kind,activity_at=EXCLUDED.activity_at,priority=EXCLUDED.priority,snooze_until=EXCLUDED.snooze_until
      WHERE (inbox_filter_members.created_at,inbox_filter_members.waiting_at,inbox_filter_members.sla_sort_at,inbox_filter_members.status,inbox_filter_members.ticket_kind,
        inbox_filter_members.activity_at,inbox_filter_members.priority,inbox_filter_members.snooze_until)
        IS DISTINCT FROM (EXCLUDED.created_at,EXCLUDED.waiting_at,EXCLUDED.sla_sort_at,EXCLUDED.status,EXCLUDED.ticket_kind,EXCLUDED.activity_at,EXCLUDED.priority,EXCLUDED.snooze_until)`,
      values,
    );
  }
}
/** Dirty conversations projected per step. */
const PROJECTION_BATCH = 100;
export async function projectInboxChanges(connect: Connect, w: string) {
  return tenant(connect, w, async (db) => {
    if (
      !(
        await db.query(
          "SELECT name FROM workspace_features WHERE workspace_id=$1 AND name='agent_inbox_views_v1' AND enabled",
          [w],
        )
      ).rows.length
    )
      return false;
    const dirty = (
      await db.query<{ conversation_id: string }>(
        "SELECT conversation_id FROM inbox_projection_dirty WHERE workspace_id=$1 ORDER BY created_at,conversation_id LIMIT $2 FOR UPDATE SKIP LOCKED",
        [w, PROJECTION_BATCH],
      )
    ).rows.map((r) => r.conversation_id);
    if (!dirty.length) return false;
    // Only sets some active view uses; attaching an unused set marks it for rebuild instead.
    // FOR SHARE: a rebuild step (FOR UPDATE) of the same set waits for this batch.
    const sets = (
      await db.query<FilterSet>(
        "SELECT s.id,s.filter FROM inbox_filter_sets s WHERE s.workspace_id=$1 AND EXISTS(SELECT 1 FROM inbox_views v WHERE v.workspace_id=$1 AND v.set_id=s.id AND NOT v.archived) ORDER BY s.id FOR SHARE OF s",
        [w],
      )
    ).rows;
    await projectSets(db, w, sets, dirty);
    await db.query(
      "DELETE FROM inbox_projection_dirty WHERE workspace_id=$1 AND conversation_id=ANY($2::text[])",
      [w, dirty],
    );
    return true;
  });
}
/** The list's sorts and the direction each starts in (most useful first). */
export const LIST_SORTS = {
  activity: "desc",
  created: "desc",
  waiting: "asc",
  sla: "asc",
  priority: "desc",
  snoozed: "asc",
} as const;
export type ListSort = keyof typeof LIST_SORTS;
/** Sorts saved before the sort menu, as a sort and a direction. */
const LEGACY_SORTS: Record<string, [ListSort, "asc" | "desc"]> = {
  newest: ["created", "desc"],
  oldest: ["created", "asc"],
  waiting: ["waiting", "asc"],
  sla: ["sla", "asc"],
};
export function listSort(
  value: string | null | undefined,
  dir?: string | null,
) {
  const legacy = value ? LEGACY_SORTS[value] : undefined;
  const sort: ListSort = legacy
    ? legacy[0]
    : value && value in LIST_SORTS
      ? (value as ListSort)
      : (assert(!value, "INVALID_SORT", "Choose an available sort."),
        "activity");
  const direction =
    dir === "asc" || dir === "desc" ? dir : (legacy?.[1] ?? LIST_SORTS[sort]);
  return { sort, direction };
}
/** The status picker: conversation states, then ticket state kinds. */
export const LIST_STATUSES = [
  "open",
  "snoozed",
  "closed",
  "submitted",
  "in_progress",
  "waiting_on_customer",
  "resolved",
] as const;
const CONVERSATION_STATUSES = ["open", "snoozed", "closed"];
/** Status counts stop at this many, so they stay fast on any view (shown as "999+"). */
export const STATUS_COUNT_CAP = 1000;

export async function viewPage(
  db: Sql,
  w: string,
  t: Teammate,
  principal: string,
  q: URLSearchParams,
) {
  const view = await visibleView(db, w, t, q.get("view") ?? "");
  const { sort, direction: dir } = listSort(
    q.get("sort") ?? view.sort,
    q.get("dir"),
  );
  const status = q.get("status") ?? "open";
  assert(
    status === "all" || (LIST_STATUSES as readonly string[]).includes(status),
    "INVALID_STATUS",
    "Choose an available status.",
  );
  // Set members carry the sort keys, so each page is one index range scan.
  // Members projected before a key existed sort as if they had none.
  const activity = "COALESCE(m.activity_at,m.created_at)";
  const key =
    sort === "waiting"
      ? "m.waiting_at"
      : sort === "sla"
        ? `COALESCE(m.sla_sort_at,'${NO_SLA}'::timestamptz)`
        : sort === "snoozed"
          ? `COALESCE(m.snooze_until,'${NO_SLA}'::timestamptz)`
          : sort === "created"
            ? "m.created_at"
            : activity;
  // Priority sorts priority conversations first, then by last activity.
  const ranked = sort === "priority";
  const descending = dir === "desc",
    values: unknown[] = [w, view.set_id, t.id];
  const where = [
    "m.workspace_id=$1",
    "m.set_id=$2",
    "c.merged_into_id IS NULL",
  ];
  const bind = (v: unknown) => {
    values.push(v);
    return "$" + values.length;
  };
  if (status !== "all")
    where.push(
      `${CONVERSATION_STATUSES.includes(status) ? "m.status" : "m.ticket_kind"}=${bind(status)}`,
    );
  const text = q.get("q") ?? "";
  assert(text.length <= 300, "INVALID_SEARCH", "Search up to 300 characters.");
  if (text.trim())
    where.push(
      `EXISTS(WITH RECURSIVE family AS (SELECT c.id UNION ALL SELECT child.id FROM conversations child JOIN family f ON child.merged_into_id=f.id WHERE child.workspace_id=$1) SELECT 1 FROM conversation_search_documents d WHERE d.workspace_id=$1 AND d.conversation_id IN(SELECT id FROM family) AND d.document @@ websearch_to_tsquery('simple',${bind(text)}))`,
    );
  const stamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
  if (q.get("cursor")) {
    let cursor: {
      view?: string;
      sort?: string;
      dir?: string;
      status?: string;
      key?: string;
      id?: string;
      revision?: string;
      q?: string;
    } = {};
    try {
      cursor = JSON.parse(atob(q.get("cursor")!));
    } catch {
      assert(false, "INVALID_CURSOR", "Invalid list cursor.");
    }
    const [rank, at] = ranked
      ? (cursor.key ?? "").split("|")
      : [null, cursor.key ?? ""];
    assert(
      cursor.view === view.id &&
        cursor.sort === sort &&
        cursor.dir === dir &&
        cursor.status === status &&
        cursor.revision === view.revision &&
        cursor.q === text &&
        stamp.test(at) &&
        (!ranked || rank === "0" || rank === "1") &&
        typeof cursor.id === "string",
      "INVALID_CURSOR",
      "The view changed. Restart the list.",
    );
    where.push(
      ranked
        ? `(m.priority::int,${key},m.conversation_id) ${descending ? "<" : ">"} (${bind(Number(rank))}::int,${bind(at)}::timestamptz,${bind(cursor.id)})`
        : `(${key},m.conversation_id) ${descending ? "<" : ">"} (${bind(at)}::timestamptz,${bind(cursor.id)})`,
    );
  }
  const direction = descending ? "DESC" : "ASC";
  const stampOf = `to_char(${key} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const rows = (
    await db.query<
      Conversation & { list_key: string; unread: boolean; activity_at: string }
    >(
      `SELECT c.*,m.activity_at,${ranked ? `(CASE WHEN m.priority THEN '1' ELSE '0' END)||'|'||${stampOf}` : stampOf} AS list_key,EXISTS(SELECT 1 FROM conversation_unread u WHERE u.workspace_id=$1 AND u.conversation_id=c.id AND u.teammate_id=$3) AS unread
      FROM inbox_filter_members m JOIN conversations c ON c.workspace_id=m.workspace_id AND c.id=m.conversation_id
      WHERE ${where.join(" AND ")} ORDER BY ${ranked ? `m.priority ${direction},` : ""}${key} ${direction},m.conversation_id ${direction} LIMIT 101`,
      values,
    )
  ).rows;
  const page = rows.slice(0, 100),
    last = page.at(-1),
    personal = await can(db, w, principal, "contacts.personal_data"),
    previews = await listPreviews(
      db,
      w,
      page.map((c) => c.id),
    );
  return {
    conversations: page.map((c) => ({
      ...agentConversation(c, personal),
      unread: c.unread,
      activity_at: c.activity_at,
      preview: previews.get(c.id) ?? null,
    })),
    ready: view.ready,
    sort,
    dir,
    status,
    // The status picker's counts, with the first page of a list.
    counts: q.get("cursor") ? null : await statusCounts(db, w, view.set_id),
    nextCursor:
      rows.length > 100 && last
        ? btoa(
            JSON.stringify({
              view: view.id,
              sort,
              dir,
              status,
              key: last.list_key,
              id: last.id,
              revision: view.revision,
              q: text,
            }),
          )
        : null,
  };
}
/** How many of a view's conversations are in each status, up to the cap. */
async function statusCounts(db: Sql, w: string, setId: string | null) {
  if (!setId) return Object.fromEntries(LIST_STATUSES.map((s) => [s, 0]));
  const counted = LIST_STATUSES.map(
    (s, i) =>
      `(SELECT count(*) FROM (SELECT 1 FROM inbox_filter_members m WHERE m.workspace_id=$1 AND m.set_id=$2 AND ${
        CONVERSATION_STATUSES.includes(s) ? "m.status" : "m.ticket_kind"
      }=$${i + 3} LIMIT ${STATUS_COUNT_CAP}) x)::int AS "${s}"`,
  );
  return (
    await db.query<Record<string, number>>(`SELECT ${counted.join(",")}`, [
      w,
      setId,
      ...LIST_STATUSES,
    ])
  ).rows[0];
}
export async function scheduleInboxProjection(connect: Connect, w: string) {
  return tenant(connect, w, async (db) => {
    const id = crypto.randomUUID();
    const row = await db.query(
      `INSERT INTO jobs(workspace_id,id,kind,state,payload)
      SELECT $1,$2,'inbox.views.project','queued','{}'::jsonb
      WHERE EXISTS(SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='agent_inbox_views_v1' AND enabled)
      AND EXISTS(SELECT 1 FROM inbox_projection_dirty WHERE workspace_id=$1) ON CONFLICT DO NOTHING RETURNING id`,
      [w, id],
    );
    if (row.rows.length)
      await db.query(
        "INSERT INTO outbox(workspace_id,id,kind,resource_id,payload) VALUES($1,$2,'job',$2,$3)",
        [w, id, JSON.stringify({ jobId: id })],
      );
  });
}
export async function projectionJob(
  connect: Connect,
  job: Job,
  notify: (w: string) => Promise<void>,
) {
  const changed = await projectInboxChanges(connect, job.workspace_id);
  if (changed) await notify(job.workspace_id);
  return { done: !changed, result: { processed: changed } };
}

export async function viewCounts(db: Sql, w: string, teammates: string[]) {
  return (
    await db.query<{
      id: string;
      owner_id: string;
      shared: boolean;
      count: string;
      count_label: string;
      count_version: string;
      ready: boolean;
    }>(
      `SELECT v.id,v.owner_id,v.shared,${countColumns} FROM ${withSet} JOIN workspace_features f ON f.workspace_id=v.workspace_id AND f.name='agent_inbox_views_v1' AND f.enabled WHERE v.workspace_id=$1 AND NOT v.archived AND (v.shared OR v.owner_id=ANY($2::text[])) ORDER BY v.id`,
      [w, teammates],
    )
  ).rows;
}
