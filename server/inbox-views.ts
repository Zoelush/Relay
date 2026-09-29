import { assert, once, tenant, type Sql, type Connect } from "./db";
import { authorize, can, type Teammate } from "./policy";
import { agentConversation, type Conversation } from "./conversations";
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
        | "created_at";
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
};
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
      (p.field in columns || ["tag", "topic"].includes(p.field)),
    "FILTER_UNAVAILABLE",
    "This filter is unavailable. Contact/company attributes require the people service; SLA requires phase 5.",
  );
  assert(
    ["eq", "ne", "in", "gte", "lte"].includes(String(p.op)),
    "INVALID_FILTER",
    "Choose a supported comparison.",
  );
  if (p.field === "priority")
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
// TODO(phase 4 step C): add the "mentions" default view. It needs structured teammate/team
// mention records on note parts, which step C introduces; there is no data to filter on yet.
export async function seedInboxViews(db: Sql, w: string, t: Teammate) {
  const eq = (field: string, value: string) => ({ field, op: "eq", value });
  for (const [builtin, name, filter] of [
    ["mine", "Mine", { and: [eq("state", "open"), eq("assignee", t.id)] }],
    [
      "unassigned",
      "Unassigned",
      { and: [eq("state", "open"), eq("assignee", "")] },
    ],
    ["open", "All open", eq("state", "open")],
    ["snoozed", "Snoozed", eq("state", "snoozed")],
    ["closed", "Closed", eq("state", "closed")],
  ] as const) {
    await db.query(
      "INSERT INTO inbox_views(workspace_id,id,owner_id,name,filter,builtin,position) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",
      [
        w,
        crypto.randomUUID(),
        t.id,
        name,
        JSON.stringify(filter),
        builtin,
        ["mine", "unassigned", "open", "snoozed", "closed"].indexOf(builtin),
      ],
    );
  }
}
const viewColumns =
  "v.id,v.owner_id,v.name,v.shared,v.folder_id,v.position,v.filter,v.sort,v.builtin,v.revision,v.set_id";
const countColumns =
  "COALESCE(s.ready,false) AS ready,COALESCE(s.match_count,0)::text AS count,COALESCE(s.count_version,0)::text AS count_version,CASE WHEN s.match_count>9999 THEN '9,999+' ELSE COALESCE(s.match_count,0)::text END AS count_label";
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
  return { views, folders };
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
    const sort = String(p.sort ?? current?.sort ?? "newest");
    assert(
      ["newest", "oldest", "waiting"].includes(sort),
      "INVALID_SORT",
      "Choose newest, oldest or longest waiting.",
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
  const ids = (
    await db.query<{ id: string }>(
      "SELECT id FROM inbox_views WHERE workspace_id=$1 AND NOT archived AND folder_id IS NOT DISTINCT FROM $2::text AND (owner_id=$3 OR (shared AND $4::boolean)) ORDER BY position,created_at,id FOR UPDATE",
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
          `SELECT ${bind(s.id)}::text AS set_id,c.id AS conversation_id,c.created_at,COALESCE(c.last_contact_reply_at,c.created_at) AS waiting_at FROM conversations c WHERE c.workspace_id=$1 AND c.id=ANY($2::text[]) AND c.merged_into_id IS NULL AND ${compileFilter(s.filter, values)}`,
      )
      .join(" UNION ALL ");
    // DELETE and INSERT touch disjoint rows, so both see the same snapshot safely.
    await db.query(
      `WITH matches AS (${matches}),
      removed AS (DELETE FROM inbox_filter_members m WHERE m.workspace_id=$1 AND m.set_id=ANY($3::text[]) AND m.conversation_id=ANY($2::text[])
        AND NOT EXISTS(SELECT 1 FROM matches x WHERE x.set_id=m.set_id AND x.conversation_id=m.conversation_id))
      INSERT INTO inbox_filter_members(workspace_id,set_id,conversation_id,created_at,waiting_at)
      SELECT $1,set_id,conversation_id,created_at,waiting_at FROM matches
      ON CONFLICT(workspace_id,set_id,conversation_id) DO UPDATE SET created_at=EXCLUDED.created_at,waiting_at=EXCLUDED.waiting_at
      WHERE (inbox_filter_members.created_at,inbox_filter_members.waiting_at) IS DISTINCT FROM (EXCLUDED.created_at,EXCLUDED.waiting_at)`,
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
export async function viewPage(
  db: Sql,
  w: string,
  t: Teammate,
  principal: string,
  q: URLSearchParams,
) {
  const view = await visibleView(db, w, t, q.get("view") ?? "");
  const sort = q.get("sort") ?? view.sort;
  assert(
    ["newest", "oldest", "waiting"].includes(sort),
    "INVALID_SORT",
    "Choose an available sort.",
  );
  // Set members carry the sort keys, so each page is one index range scan.
  const key = sort === "waiting" ? "m.waiting_at" : "m.created_at";
  const descending = sort === "newest",
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
  const text = q.get("q") ?? "";
  assert(text.length <= 300, "INVALID_SEARCH", "Search up to 300 characters.");
  if (text.trim())
    where.push(
      `EXISTS(WITH RECURSIVE family AS (SELECT c.id UNION ALL SELECT child.id FROM conversations child JOIN family f ON child.merged_into_id=f.id WHERE child.workspace_id=$1) SELECT 1 FROM conversation_search_documents d WHERE d.workspace_id=$1 AND d.conversation_id IN(SELECT id FROM family) AND d.document @@ websearch_to_tsquery('simple',${bind(text)}))`,
    );
  if (q.get("cursor")) {
    let cursor: {
      view?: string;
      sort?: string;
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
    assert(
      cursor.view === view.id &&
        cursor.sort === sort &&
        cursor.revision === view.revision &&
        cursor.q === text &&
        typeof cursor.key === "string" &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(cursor.key) &&
        typeof cursor.id === "string",
      "INVALID_CURSOR",
      "The view changed. Restart the list.",
    );
    where.push(
      `(${key},m.conversation_id) ${descending ? "<" : ">"} (${bind(cursor.key)}::timestamptz,${bind(cursor.id)})`,
    );
  }
  const direction = descending ? "DESC" : "ASC";
  const rows = (
    await db.query<Conversation & { list_key: string; unread: boolean }>(
      `SELECT c.*,to_char(${key} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS list_key,EXISTS(SELECT 1 FROM conversation_unread u WHERE u.workspace_id=$1 AND u.conversation_id=c.id AND u.teammate_id=$3) AS unread
      FROM inbox_filter_members m JOIN conversations c ON c.workspace_id=m.workspace_id AND c.id=m.conversation_id
      WHERE ${where.join(" AND ")} ORDER BY ${key} ${direction},m.conversation_id ${direction} LIMIT 101`,
      values,
    )
  ).rows;
  const page = rows.slice(0, 100),
    last = page.at(-1),
    personal = await can(db, w, principal, "contacts.personal_data");
  return {
    conversations: page.map((c) => ({
      ...agentConversation(c, personal),
      unread: c.unread,
    })),
    ready: view.ready,
    nextCursor:
      rows.length > 100 && last
        ? btoa(
            JSON.stringify({
              view: view.id,
              sort,
              key: last.list_key,
              id: last.id,
              revision: view.revision,
              q: text,
            }),
          )
        : null,
  };
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
