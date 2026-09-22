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
export async function visibleView(
  db: Sql,
  w: string,
  t: Teammate,
  id: string,
  lock = false,
) {
  const v = (
    await db.query<InboxView>(
      "SELECT * FROM inbox_views WHERE workspace_id=$1 AND id=$2 AND NOT archived AND (owner_id=$3 OR shared)" +
        (lock ? " FOR UPDATE" : ""),
      [w, id, t.id],
    )
  ).rows[0];
  assert(v, "VIEW_NOT_FOUND", "View unavailable.", 404);
  return v;
}
export async function viewSnapshot(db: Sql, w: string, t: Teammate) {
  const views = (
    await db.query(
      "SELECT id,name,owner_id,shared,folder_id,position,filter,sort,builtin,revision,ready,match_count::text AS count,count_version,CASE WHEN match_count>9999 THEN '9,999+' ELSE match_count::text END AS count_label FROM inbox_views WHERE workspace_id=$1 AND NOT archived AND (owner_id=$2 OR shared) ORDER BY position,created_at,id",
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
      const ids = (
        await db.query<{ id: string }>(
          "SELECT id FROM inbox_views WHERE workspace_id=$1 AND owner_id=$2 AND NOT ready AND NOT archived",
          [w, t.id],
        )
      ).rows.map((x) => x.id);
      const jobId = await enqueueJob(
        db,
        w,
        "inbox.views.rebuild",
        { viewIds: ids },
        { teammateId: t.id },
      );
      return { jobId };
    }
    if (p.action === "folder") {
      assert(
        typeof p.name === "string" && p.name.trim() && p.name.length <= 80,
        "INVALID_NAME",
        "Name the folder.",
      );
      const id = typeof p.id === "string" ? p.id : crypto.randomUUID();
      if (p.shared) await authorize(db, w, principal, "workspace.manage");
      if (p.id)
        assert(
          (
            await db.query(
              "SELECT id FROM inbox_view_folders WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 FOR UPDATE",
              [w, id, t.id],
            )
          ).rows.length,
          "FOLDER_NOT_FOUND",
          "Folder unavailable.",
          404,
        );
      await db.query(
        "INSERT INTO inbox_view_folders(workspace_id,id,owner_id,name,shared,position) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,id) DO UPDATE SET name=EXCLUDED.name,shared=EXCLUDED.shared,position=EXCLUDED.position",
        [
          w,
          id,
          t.id,
          p.name.trim(),
          p.shared === true,
          Number.isInteger(p.position) ? p.position : 0,
        ],
      );
      return { id };
    }
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
    const shared = p.shared === true;
    if (shared) await authorize(db, w, principal, "workspace.manage");
    if (p.folderId)
      assert(
        (
          await db.query(
            "SELECT id FROM inbox_view_folders WHERE workspace_id=$1 AND id=$2 AND (owner_id=$3 OR shared) AND (NOT $4::boolean OR shared)",
            [w, p.folderId, t.id, shared],
          )
        ).rows.length,
        "FOLDER_NOT_FOUND",
        "Choose an accessible folder with compatible visibility.",
        404,
      );
    const id =
      p.action === "duplicate" || !current ? crypto.randomUUID() : current.id;
    if (current?.builtin && p.action !== "duplicate")
      assert(
        JSON.stringify(filter) === JSON.stringify(current.filter),
        "INVALID_VIEW",
        "Duplicate a default view before changing its filter.",
      );
    await db.query(
      `INSERT INTO inbox_views(workspace_id,id,owner_id,name,shared,folder_id,position,filter,sort) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(workspace_id,id) DO UPDATE SET name=EXCLUDED.name,shared=EXCLUDED.shared,folder_id=EXCLUDED.folder_id,position=EXCLUDED.position,filter=EXCLUDED.filter,sort=EXCLUDED.sort,revision=inbox_views.revision+1,ready=false`,
      [
        w,
        id,
        t.id,
        name.trim(),
        shared,
        p.folderId ?? null,
        Number.isInteger(p.position) ? p.position : 0,
        JSON.stringify(filter),
        sort,
      ],
    );
    const jobId = await enqueueJob(
      db,
      w,
      "inbox.views.rebuild",
      { viewIds: [id] },
      { teammateId: t.id },
    );
    return { id, jobId };
  });
}
export async function rebuildViews(connect: Connect, job: Job) {
  return tenant(connect, job.workspace_id, async (db) => {
    const w = job.workspace_id;
    const checkpoint = job.result ?? {},
      index = Number(checkpoint.index ?? 0),
      ids = job.payload.viewIds as string[];
    if (index >= ids.length) return { done: true, result: { ...checkpoint } };
    const v = (
      await db.query<InboxView>(
        "SELECT * FROM inbox_views WHERE workspace_id=$1 AND id=$2 AND NOT archived FOR UPDATE",
        [w, ids[index]],
      )
    ).rows[0];
    if (!v) return { done: false, result: { index: index + 1 } };
    // A definition change resets the checkpoint. Membership changes and checkpoint commit atomically.
    const after =
      checkpoint.revision === v.revision ? String(checkpoint.after ?? "") : "";
    const rows = (
      await db.query<{ id: string }>(
        "SELECT id FROM conversations WHERE workspace_id=$1 AND id>$2 ORDER BY id LIMIT 100",
        [w, after],
      )
    ).rows;
    await projectView(
      db,
      w,
      v,
      rows.map((r) => r.id),
    );
    if (rows.length < 100)
      await db.query(
        "UPDATE inbox_views SET ready=true WHERE workspace_id=$1 AND id=$2",
        [w, v.id],
      );
    const result =
      rows.length < 100
        ? { index: index + 1 }
        : { index, after: rows.at(-1)!.id, revision: v.revision };
    // Persist the checkpoint with the membership changes; safe after lost job acknowledgement.
    await db.query(
      "UPDATE jobs SET result=$3 WHERE workspace_id=$1 AND id=$2 AND lease_token=$4",
      [w, job.id, JSON.stringify(result), job.lease_token],
    );
    return { done: Number(result.index) >= ids.length, result };
  });
}
async function projectView(db: Sql, w: string, v: InboxView, ids: string[]) {
  if (!ids.length) return;
  const values: unknown[] = [w, ids],
    filter = compileFilter(v.filter, values);
  const matches = (
    await db.query<{ id: string }>(
      `SELECT c.id FROM conversations c WHERE c.workspace_id=$1 AND c.id=ANY($2::text[]) AND c.merged_into_id IS NULL AND ${filter}`,
      values,
    )
  ).rows.map((r) => r.id);
  await db.query(
    "DELETE FROM inbox_view_memberships WHERE workspace_id=$1 AND view_id=$2 AND conversation_id=ANY($3::text[]) AND NOT(conversation_id=ANY($4::text[]))",
    [w, v.id, ids, matches],
  );
  await db.query(
    "INSERT INTO inbox_view_memberships(workspace_id,view_id,conversation_id) SELECT $1,$2,unnest($3::text[]) ON CONFLICT DO NOTHING",
    [w, v.id, matches],
  );
}
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
        "SELECT conversation_id FROM inbox_projection_dirty WHERE workspace_id=$1 ORDER BY created_at,conversation_id LIMIT 100 FOR UPDATE SKIP LOCKED",
        [w],
      )
    ).rows.map((r) => r.conversation_id);
    if (!dirty.length) return false;
    const views = (
      await db.query<InboxView>(
        "SELECT * FROM inbox_views WHERE workspace_id=$1 AND NOT archived ORDER BY id FOR UPDATE",
        [w],
      )
    ).rows;
    for (const v of views) await projectView(db, w, v, dirty);
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
  const score =
    sort === "waiting"
      ? "extract(epoch from COALESCE(c.last_contact_reply_at,c.created_at))"
      : "extract(epoch from c.created_at)";
  const descending = sort === "newest",
    values: unknown[] = [w, view.id, t.id];
  const where = [
    "c.workspace_id=$1",
    "c.merged_into_id IS NULL",
    "m.workspace_id=$1",
    "m.view_id=$2",
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
      score?: string;
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
        typeof cursor.score === "string" &&
        /^\d+(\.\d+)?$/.test(cursor.score) &&
        typeof cursor.id === "string",
      "INVALID_CURSOR",
      "The view changed. Restart the list.",
    );
    where.push(
      `(${score},c.id) ${descending ? "<" : ">"} (${bind(cursor.score)}::numeric,${bind(cursor.id)})`,
    );
  }
  const rows = (
    await db.query<Conversation & { list_score: string; unread: boolean }>(
      `SELECT c.*,${score}::text AS list_score,EXISTS(SELECT 1 FROM conversation_unread u WHERE u.workspace_id=$1 AND u.conversation_id=c.id AND u.teammate_id=$3) AS unread FROM conversations c JOIN inbox_view_memberships m ON m.conversation_id=c.id WHERE ${where.join(" AND ")} ORDER BY ${score} ${descending ? "DESC" : "ASC"},c.id ${descending ? "DESC" : "ASC"} LIMIT 101`,
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
              score: last.list_score,
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
      "SELECT v.id,v.owner_id,v.shared,v.match_count::text AS count,CASE WHEN v.match_count>9999 THEN '9,999+' ELSE v.match_count::text END AS count_label,v.count_version,v.ready FROM inbox_views v JOIN workspace_features f ON f.workspace_id=v.workspace_id AND f.name='agent_inbox_views_v1' AND f.enabled WHERE v.workspace_id=$1 AND NOT v.archived AND (v.shared OR v.owner_id=ANY($2::text[])) ORDER BY v.id",
      [w, teammates],
    )
  ).rows;
}
