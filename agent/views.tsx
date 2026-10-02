import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlarmClock,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  CalendarPlus,
  CheckCircle2,
  Clock,
  Flag,
  Hourglass,
  Inbox,
  Loader,
  MoonStar,
  Send,
  Timer,
  Zap,
} from "lucide-react";
import { api } from "./api";
import { Menu } from "./menu";
import { BulkBar, type Directory } from "./bulk";
import { SlaBadge } from "./sla";
import type { ViewFilter } from "../server/inbox-views";
export type ViewCount = {
  id: string;
  count: string;
  count_label: string;
  count_version: string;
  ready: boolean;
};
type View = ViewCount & {
  name: string;
  filter: ViewFilter;
  sort: string;
  revision: string;
  shared: boolean;
  folder_id: string | null;
  position: number;
  builtin?: string;
};
type Folder = { id: string; name: string; shared: boolean; position: number };
type Row = {
  id: string;
  title: string;
  status: string;
  channel: string;
  assigned: string;
  name?: string;
  unread?: boolean;
  sla_next_due_at?: string | null;
  sla_overdue?: boolean;
};
const initial: ViewFilter = { field: "state", op: "eq", value: "open" };
/** A new view starts with every status: the list's status picker narrows it. */
const ANY_STATUS: ViewFilter = {
  field: "state",
  op: "in",
  value: ["open", "snoozed", "closed"],
};
/** Default views every teammate has; keep in step with BUILTIN_VIEWS on the server. */
const BUILTINS = ["mine", "mentions", "unassigned", "all"];

/** The status picker: conversation states, then ticket states (LIST_STATUSES on the server). */
const STATUSES = [
  ["open", "Open", Inbox],
  ["snoozed", "Snoozed", MoonStar],
  ["closed", "Closed", CheckCircle2],
  ["submitted", "Submitted", Send],
  ["in_progress", "In progress", Loader],
  ["waiting_on_customer", "Waiting on customer", Hourglass],
  ["resolved", "Resolved", CheckCircle2],
] as const;
type Status = (typeof STATUSES)[number][0];
/** The sort menu (LIST_SORTS on the server), each with the direction it starts in. */
const SORTS = [
  ["activity", "Last activity", Zap, "desc"],
  ["created", "Date started", CalendarPlus, "desc"],
  ["waiting", "Waiting since", Clock, "asc"],
  ["sla", "Next SLA", Timer, "asc"],
  ["priority", "Priority", Flag, "desc"],
  ["snoozed", "Snoozed until", AlarmClock, "asc"],
] as const;
type Sort = (typeof SORTS)[number][0];
/** Sorts saved on views before the sort menu. */
const LEGACY: Record<string, [Sort, "asc" | "desc"]> = {
  newest: ["created", "desc"],
  oldest: ["created", "asc"],
  waiting: ["waiting", "asc"],
  sla: ["sla", "asc"],
};
const savedSort = (value: string): { sort: Sort; dir: "asc" | "desc" } => {
  const legacy = LEGACY[value];
  if (legacy) return { sort: legacy[0], dir: legacy[1] };
  const known = SORTS.find((s) => s[0] === value) ?? SORTS[0];
  return { sort: known[0], dir: known[3] };
};
const countLabel = (n: number | undefined) =>
  n === undefined ? "…" : n >= 1000 ? "999+" : n.toLocaleString();
function FilterEditor({
  value,
  onChange,
  depth = 0,
}: {
  value: ViewFilter;
  onChange: (v: ViewFilter) => void;
  depth?: number;
}) {
  if ("and" in value || "or" in value) {
    const all = "and" in value,
      items = all ? value.and : value.or;
    const update = (children: ViewFilter[]) =>
      onChange(all ? { and: children } : { or: children });
    return (
      <fieldset className="pg-filter-group">
        <legend>
          <select
            aria-label="Group operator"
            value={all ? "and" : "or"}
            onChange={(e) =>
              onChange(
                e.target.value === "and" ? { and: items } : { or: items },
              )
            }
          >
            <option value="and">Match all</option>
            <option value="or">Match any</option>
          </select>
        </legend>
        {items.map((v, i) => (
          <div key={i}>
            <FilterEditor
              value={v}
              depth={depth + 1}
              onChange={(child) =>
                update(items.map((old, j) => (i === j ? child : old)))
              }
            />
            {items.length > 1 && (
              <button
                type="button"
                onClick={() => update(items.filter((_, j) => j !== i))}
              >
                Remove condition
              </button>
            )}
          </div>
        ))}
        <button type="button" onClick={() => update([...items, initial])}>
          Add condition
        </button>
        {depth < 3 && (
          <button
            type="button"
            onClick={() => update([...items, { or: [initial] }])}
          >
            Add group
          </button>
        )}
      </fieldset>
    );
  }
  return (
    <div className="pg-filter-row">
      <select
        aria-label="Filter field"
        value={value.field}
        onChange={(e) =>
          onChange({
            field: e.target.value as typeof value.field,
            op: "eq",
            value:
              e.target.value === "priority"
                ? true
                : e.target.value === "sla"
                  ? "overdue"
                  : "",
          })
        }
      >
        {[
          "state",
          "channel",
          "assignee",
          "team",
          "tag",
          "topic",
          "priority",
          "brand",
          "created_at",
          "sla",
          "ticket_type",
        ].map((f) => (
          <option key={f} value={f}>
            {f === "sla" ? "SLA" : f.replaceAll("_", " ")}
          </option>
        ))}
      </select>
      <select
        aria-label="Comparison"
        value={value.op}
        onChange={(e) =>
          onChange({ ...value, op: e.target.value as typeof value.op })
        }
      >
        <option value="eq">is</option>
        <option value="ne">is not</option>
        {value.field === "created_at" && (
          <>
            <option value="gte">on or after</option>
            <option value="lte">on or before</option>
          </>
        )}
      </select>
      {value.field === "priority" ? (
        <select
          aria-label="Priority value"
          value={String(value.value)}
          onChange={(e) =>
            onChange({ ...value, value: e.target.value === "true" })
          }
        >
          <option value="true">Priority</option>
          <option value="false">Normal</option>
        </select>
      ) : value.field === "sla" ? (
        <select
          aria-label="SLA value"
          value={String(value.value)}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        >
          <option value="overdue">Overdue</option>
          <option value="breached">Breached (ever)</option>
        </select>
      ) : value.field === "state" ? (
        <select
          aria-label="State value"
          value={Array.isArray(value.value) ? "any" : String(value.value)}
          onChange={(e) =>
            onChange(
              e.target.value === "any"
                ? ANY_STATUS
                : { ...value, op: "eq", value: e.target.value },
            )
          }
        >
          <option value="any">any status</option>
          {["open", "snoozed", "closed"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      ) : (
        <input
          aria-label="Filter value"
          placeholder={
            value.field === "created_at"
              ? "2026-09-22T00:00:00Z"
              : "Value or identifier"
          }
          value={String(value.value)}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        />
      )}
    </div>
  );
}
/** The view to show: the teammate's own choice, else "All", else the first view. */
function pickView(old: string, views: View[], chosen: boolean) {
  const open = views.find((v) => v.builtin === "all")?.id;
  if (
    old &&
    views.some((v) => v.id === old) &&
    (chosen || !open || old === open)
  )
    return old;
  return open ?? views[0]?.id ?? "";
}
export function InboxViews({
  selected,
  revision,
  counts,
  onSelect,
  onPrefetch,
  onViews,
  onError,
  onJob,
  dir,
}: {
  dir: Directory;
  selected: string;
  revision: number;
  counts: ViewCount[];
  onSelect: (row: Row) => void;
  onPrefetch?: (id: string) => void;
  /** Receives the teammate's views, for the command palette. */
  onViews?: (views: { id: string; name: string }[]) => void;
  onError: (error: unknown) => void;
  onJob: (id: string) => void;
}) {
  const [views, setViews] = useState<View[]>([]),
    [folders, setFolders] = useState<Folder[]>([]),
    [viewId, setViewId] = useState("");
  // Whether the teammate picked the current view. An automatic pick moves to "All" once it
  // exists: on a first visit the default views are created after the first list of views, and
  // the shared views that already existed must not stay selected (they looked like an empty inbox).
  const chosen = useRef(false);
  const [rows, setRows] = useState<Row[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState<Sort>("activity"),
    [order, setOrder] = useState<"asc" | "desc">("desc"),
    [status, setStatus] = useState<Status>("open"),
    [statusCounts, setStatusCounts] = useState<Partial<
      Record<Status, number>
    > | null>(null);
  /** A view's own sort, as the sort menu shows it. */
  const applySaved = (value: string) => {
    const s = savedSort(value);
    setSort(s.sort);
    setOrder(s.dir);
  };
  const [pageLoading, setPageLoading] = useState(false);
  const [scroll, setScroll] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [editing, setEditing] = useState<Partial<View> | null>(null);
  // Optimistic views survive server refreshes until their own mutation settles.
  const pending = useRef(new Map<string, View>());
  const withPending = (fetched: View[]) => [
    ...fetched.filter((v) => !pending.current.has(v.id)),
    ...pending.current.values(),
  ];
  const viewport = useRef<HTMLDivElement>(null),
    generation = useRef(0),
    loading = useRef(false),
    loadToken = useRef(0),
    queryRef = useRef("");
  const [height, setHeight] = useState(500);
  // Bulk selection belongs to one list (view, sort and search); changing the list drops it.
  const listKey = `${viewId}|${status}|${sort}|${order}|${query}`;
  const [picked, setPicked] = useState<{
    key: string;
    ids: string[];
    all: boolean;
  }>({ key: "", ids: [], all: false });
  const selection =
    picked.key === listKey ? picked : { key: listKey, ids: [], all: false };
  const pickedSet = new Set(selection.ids);
  const anchor = useRef<string | null>(null);
  /** Checks or unchecks a row; Shift extends from the last row clicked to this one. */
  const toggle = (id: string, range: boolean) => {
    const on = !pickedSet.has(id);
    let ids = [id];
    const from = anchor.current
      ? rows.findIndex((r) => r.id === anchor.current)
      : -1;
    const to = rows.findIndex((r) => r.id === id);
    if (range && from >= 0 && to >= 0)
      ids = rows
        .slice(Math.min(from, to), Math.max(from, to) + 1)
        .map((r) => r.id);
    anchor.current = id;
    const next = new Set(selection.ids);
    for (const x of ids)
      if (on) next.add(x);
      else next.delete(x);
    setPicked({ key: listKey, ids: [...next], all: false });
  };
  const refresh = useCallback(async () => {
    const data = await api<{ views: View[]; folders: Folder[] }>("views");
    setViews(withPending(data.views));
    setFolders(data.folders);
    const keep = chosen.current;
    setViewId((old) => pickView(old, data.views, keep));
  }, []);
  useEffect(() => {
    let live = true;
    api<{ views: View[]; folders: Folder[] }>("views")
      .then((data) => {
        if (!live) return;
        setViews(withPending(data.views));
        setFolders(data.folders);
        const keep = chosen.current;
        setViewId((old) => pickView(old, data.views, keep));
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [revision]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setHeight(entries[0].contentRect.height),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const loadPage = useCallback(
    async (next: string | null, version: number) => {
      if (!viewId || (next && loading.current)) return;
      // The latest request owns the loading flag, even across list generations.
      const token = ++loadToken.current;
      loading.current = true;
      setPageLoading(true);
      const q = new URLSearchParams({
        view: viewId,
        sort,
        dir: order,
        status,
        q: queryRef.current,
      });
      if (next) q.set("cursor", next);
      try {
        const data = await api<{
          conversations: Row[];
          nextCursor: string | null;
          counts: Record<Status, number> | null;
        }>("view-page?" + q);
        if (version !== generation.current) return;
        if (data.counts) setStatusCounts(data.counts);
        setRows((old) => {
          if (!next) return data.conversations;
          const seen = new Set(old.map((x) => x.id));
          return [...old, ...data.conversations.filter((c) => !seen.has(c.id))];
        });
        setCursor(data.nextCursor);
      } catch (e) {
        if (version === generation.current) {
          setError(e instanceof Error ? e.message : "Unable to load view.");
          onError(e);
        }
      } finally {
        if (token === loadToken.current) {
          loading.current = false;
          setPageLoading(false);
        }
      }
    },
    [viewId, sort, order, status, onError],
  );
  useEffect(() => {
    const version = ++generation.current;
    queryRef.current = query;
    const timer = setTimeout(
      () => void loadPage(null, version),
      query ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      ++generation.current;
    };
  }, [viewId, sort, order, status, query, loadPage]);
  // Workspace activity (`revision`) refreshes only the first page, merged in front of the
  // deeper rows already loaded, so a teammate scrolled deep keeps their place and cursor.
  // Resetting here instead reloaded from page one on every notification in the workspace.
  const rowsLoaded = useRef(0);
  useEffect(() => {
    rowsLoaded.current = rows.length;
  }, [rows]);
  useEffect(() => {
    if (!revision || !viewId) return;
    const version = generation.current;
    const timer = setTimeout(async () => {
      const q = new URLSearchParams({
        view: viewId,
        sort,
        dir: order,
        status,
        q: queryRef.current,
      });
      try {
        const data = await api<{
          conversations: Row[];
          nextCursor: string | null;
          counts: Record<Status, number> | null;
        }>("view-page?" + q);
        if (version !== generation.current) return;
        if (data.counts) setStatusCounts(data.counts);
        const deep = rowsLoaded.current > data.conversations.length;
        setRows((old) => {
          const top = new Set(data.conversations.map((c) => c.id));
          return [
            ...data.conversations,
            ...old
              .slice(data.conversations.length)
              .filter((c) => !top.has(c.id)),
          ];
        });
        if (!deep) setCursor(data.nextCursor);
      } catch {
        // A failed background refresh keeps the rows already shown.
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [revision, viewId, sort, order, status]);
  useEffect(() => {
    setScroll(0);
    if (viewport.current) viewport.current.scrollTop = 0;
  }, [viewId, sort, order, status, query]);
  useEffect(() => {
    onViews?.(views.map((v) => ({ id: v.id, name: v.name })));
  }, [views, onViews]);
  // A teammate set up before a default view existed (such as Mentions) gets it added once,
  // through the idempotent initialize action.
  const toppedUp = useRef(false);
  useEffect(() => {
    if (toppedUp.current || !views.length) return;
    const have = new Set(views.map((v) => v.builtin).filter(Boolean));
    if (BUILTINS.every((b) => have.has(b))) return;
    toppedUp.current = true;
    api<{ jobId?: string }>("views", { action: "initialize" })
      .then((result) => {
        if (result.jobId) onJob(result.jobId);
        return refresh();
      })
      .catch(onError);
  }, [views, refresh, onJob, onError]);
  // Keyboard navigation (J/K) and palette view switching arrive as window events from the inbox.
  useEffect(() => {
    const navigate = (e: Event) => {
      const direction = (e as CustomEvent<number>).detail;
      const at = rows.findIndex((r) => r.id === selected);
      const next = rows[at < 0 ? 0 : at + direction];
      if (!next) return;
      onSelect(next);
      const el = viewport.current;
      const index = rows.indexOf(next);
      if (el) {
        const top = index * 86;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + 86 > el.scrollTop + el.clientHeight)
          el.scrollTop = top + 86 - el.clientHeight;
      }
    };
    const switchView = (e: Event) => {
      const v = views.find((x) => x.id === (e as CustomEvent<string>).detail);
      if (!v) return;
      chosen.current = true;
      setViewId(v.id);
      applySaved(v.sort);
    };
    window.addEventListener("relay:navigate", navigate);
    window.addEventListener("relay:view", switchView);
    return () => {
      window.removeEventListener("relay:navigate", navigate);
      window.removeEventListener("relay:view", switchView);
    };
  }, [rows, selected, views, onSelect]);
  // X checks or unchecks the open conversation's row.
  const toggleRef = useRef(toggle);
  useEffect(() => {
    toggleRef.current = toggle;
  });
  useEffect(() => {
    const onToggle = (e: Event) =>
      toggleRef.current((e as CustomEvent<string>).detail, false);
    window.addEventListener("relay:bulk-toggle", onToggle);
    return () => window.removeEventListener("relay:bulk-toggle", onToggle);
  }, []);
  const current = views.find((v) => v.id === viewId),
    countMap = new Map(counts.map((c) => [c.id, c]));
  async function mutate(
    p: Record<string, unknown>,
    optimistic?: View,
    optimisticList?: View[],
  ) {
    const before = views.find((v) => v.id === p.id),
      previous = views;
    setBusy(true);
    setError("");
    if (optimisticList) setViews(optimisticList);
    if (optimistic) pending.current.set(optimistic.id, optimistic);
    if (optimistic)
      setViews((old) =>
        old.some((v) => v.id === optimistic.id)
          ? old.map((v) => (v.id === optimistic.id ? optimistic : v))
          : [...old, optimistic],
      );
    if (p.action === "archive")
      setViews((old) => old.filter((v) => v.id !== p.id));
    try {
      const result = await api<{ id?: string; jobId?: string }>("views", p);
      if (optimistic) pending.current.delete(optimistic.id);
      if (result.jobId) onJob(result.jobId);
      await refresh();
      if (result.id && p.action !== "folder" && p.action !== "archive") {
        chosen.current = true;
        setViewId(result.id);
      }
      setEditing(null);
    } catch (e) {
      if (optimistic) pending.current.delete(optimistic.id);
      if (optimisticList) setViews(previous);
      if (optimistic)
        setViews((old) => old.filter((v) => v.id !== optimistic.id));
      if (before)
        setViews((old) =>
          [...old.filter((v) => v.id !== before.id), before].sort(
            (a, b) => a.position - b.position,
          ),
        );
      setError(e instanceof Error ? e.message : "Action failed.");
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  /** Swaps with the neighbouring view in the same folder; the server renumbers the folder. */
  function move(view: View, direction: "up" | "down") {
    const group = views
        .filter((v) => v.folder_id === view.folder_id)
        .sort((a, b) => a.position - b.position),
      from = group.findIndex((v) => v.id === view.id),
      neighbour = group[from + (direction === "up" ? -1 : 1)];
    const swapped = neighbour
      ? views.map((v) =>
          v.id === view.id
            ? { ...v, position: neighbour.position }
            : v.id === neighbour.id
              ? { ...v, position: view.position }
              : v,
        )
      : views;
    void mutate({ action: "move", id: view.id, direction }, undefined, swapped);
  }
  // A scroll that arrived while a page was loading was ignored: continue if still at the bottom.
  useEffect(() => {
    const el = viewport.current;
    if (
      el &&
      cursor &&
      !pageLoading &&
      el.scrollHeight - el.scrollTop - el.clientHeight < 500
    )
      void loadPage(cursor, generation.current);
  }, [rows, cursor, pageLoading, loadPage]);
  const statusName = STATUSES.find((x) => x[0] === status)![1];
  const sortName = SORTS.find((x) => x[0] === sort)![1];
  const rowHeight = 86,
    start = Math.max(0, Math.floor(scroll / rowHeight) - 5),
    end = Math.min(rows.length, start + Math.ceil(height / rowHeight) + 10);
  return (
    <div className="pg-views">
      <header>
        <h2>Conversations</h2>
        <button
          aria-label="Create view"
          onClick={() =>
            setEditing({
              name: "",
              filter: ANY_STATUS,
              sort: "activity",
              shared: false,
            })
          }
        >
          ＋ View
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {!views.length && (
        <button
          disabled={busy}
          onClick={() => void mutate({ action: "initialize" })}
        >
          Set up my default views
        </button>
      )}
      <nav aria-label="Inbox views">
        {[null, ...folders].map((folder) => (
          <div key={folder?.id ?? "ungrouped"}>
            {folder && <strong>{folder.name}</strong>}
            {views
              .filter((v) => v.folder_id === (folder?.id ?? null))
              .sort((a, b) => a.position - b.position)
              .map((v) => {
                const live = countMap.get(v.id) ?? v;
                return (
                  <button
                    key={v.id}
                    aria-pressed={viewId === v.id}
                    onClick={() => {
                      chosen.current = true;
                      setViewId(v.id);
                      applySaved(v.sort);
                      setStatusCounts(null);
                    }}
                  >
                    {v.name}
                    <span>{live.ready ? live.count_label : "Updating…"}</span>
                  </button>
                );
              })}
          </div>
        ))}
      </nav>
      {current && (
        <div className="pg-view-tools">
          <button disabled={busy} onClick={() => setEditing({ ...current })}>
            Edit
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void mutate(
                { action: "duplicate", id: current.id },
                {
                  ...current,
                  id: crypto.randomUUID(),
                  name: current.name + " copy",
                  ready: false,
                },
              )
            }
          >
            Duplicate
          </button>
          <button
            disabled={busy || !!current.builtin}
            onClick={() =>
              void mutate({
                action: "archive",
                id: current.id,
                revision: current.revision,
              })
            }
          >
            Archive
          </button>
          <button disabled={busy} onClick={() => move(current, "up")}>
            Move up
          </button>
          <button disabled={busy} onClick={() => move(current, "down")}>
            Move down
          </button>
        </div>
      )}
      <div className="pg-list-controls">
        <Menu
          className="pg-status-menu"
          buttonLabel={`Status: ${statusName}, ${current?.ready === false ? "updating" : countLabel(statusCounts?.[status]) + " conversations"}`}
          button={
            <>
              <span className="pg-status-count">
                {current?.ready === false
                  ? "…"
                  : countLabel(statusCounts?.[status])}
              </span>{" "}
              {statusName}
            </>
          }
          menuLabel="Status"
          items={STATUSES.map(([value, label, Icon], i) => ({
            value,
            label,
            icon: <Icon size={15} aria-hidden="true" />,
            detail:
              current?.ready === false
                ? "…"
                : countLabel(statusCounts?.[value]),
            checked: status === value,
            divider: i === 3,
          }))}
          onSelect={(value) => setStatus(value as Status)}
        />
        <Menu
          className="pg-sort-menu"
          buttonLabel={`Sort: ${sortName}`}
          button={sortName}
          menuLabel="Sort by"
          searchable
          items={SORTS.map(([value, label, Icon]) => ({
            value,
            label,
            icon: <Icon size={15} aria-hidden="true" />,
            checked: sort === value,
          }))}
          onSelect={(value) => {
            const s = SORTS.find((x) => x[0] === value)!;
            setSort(s[0]);
            setOrder(s[3]);
          }}
        />
        <button
          type="button"
          className="pg-sort-direction"
          aria-label={
            order === "desc"
              ? "Descending order. Switch to ascending"
              : "Ascending order. Switch to descending"
          }
          title={order === "desc" ? "Descending" : "Ascending"}
          onClick={() => setOrder((d) => (d === "desc" ? "asc" : "desc"))}
        >
          {order === "desc" ? (
            <ArrowDownWideNarrow size={16} aria-hidden="true" />
          ) : (
            <ArrowUpNarrowWide size={16} aria-hidden="true" />
          )}
        </button>
      </div>
      <div className="pg-view-query">
        <input
          aria-label="Search within view"
          placeholder="Search this view…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {(selection.ids.length > 0 || selection.all) && current && !query && (
        <div className="pg-select-all">
          {selection.all ? (
            <button
              onClick={() => setPicked({ key: listKey, ids: [], all: false })}
            >
              Clear selection
            </button>
          ) : (
            <button
              onClick={() => setPicked({ key: listKey, ids: [], all: true })}
            >
              Select all {countLabel(statusCounts?.[status])}{" "}
              {statusName.toLowerCase()} in this view
            </button>
          )}
        </div>
      )}
      <BulkBar
        selection={{
          viewId,
          ids: selection.ids,
          all: selection.all,
          status,
        }}
        count={
          selection.all
            ? `All ${countLabel(statusCounts?.[status])} ${statusName.toLowerCase()}`
            : selection.ids.length.toLocaleString()
        }
        dir={dir}
        onClear={() => setPicked({ key: listKey, ids: [], all: false })}
        onJob={onJob}
      />
      <div
        ref={viewport}
        className="pg-virtual-list"
        data-testid="virtual-conversations"
        onScroll={(e) => {
          const el = e.currentTarget;
          setScroll(el.scrollTop);
          if (
            el.scrollHeight - el.scrollTop - el.clientHeight < 500 &&
            cursor &&
            !loading.current
          )
            void loadPage(cursor, generation.current);
        }}
      >
        <div style={{ height: rows.length * rowHeight, position: "relative" }}>
          {rows.slice(start, end).map((c, index) => (
            <div
              key={c.id}
              className="pg-row-wrap"
              style={{
                position: "absolute",
                top: (start + index) * rowHeight,
                height: rowHeight,
                width: "100%",
              }}
            >
              <input
                type="checkbox"
                className="pg-row-check"
                aria-label={`Select ${c.name || "Customer"}: ${c.title}`}
                checked={selection.all || pickedSet.has(c.id)}
                onChange={() => {}}
                onClick={(e) => {
                  if (selection.all)
                    setPicked({ key: listKey, ids: [], all: false });
                  else toggle(c.id, e.shiftKey);
                }}
              />
              <button
                className={c.id === selected ? "pg-row selected" : "pg-row"}
                onClick={() => onSelect(c)}
                onMouseEnter={() => onPrefetch?.(c.id)}
                onFocus={() => onPrefetch?.(c.id)}
              >
                <span className="pg-avatar">
                  {c.unread ? "●" : (c.name || "C").slice(0, 1)}
                </span>
                <span>
                  <strong>{c.name || "Customer"}</strong>
                  <span className="pg-row-title">{c.title}</span>
                  <small>
                    {c.status} · {c.channel}
                    <SlaBadge
                      dueAt={c.sla_next_due_at ?? null}
                      overdue={!!c.sla_overdue}
                    />
                  </small>
                </span>
              </button>
            </div>
          ))}
        </div>
        {cursor && (
          <button
            disabled={pageLoading}
            onClick={() => void loadPage(cursor, generation.current)}
          >
            Load more conversations
          </button>
        )}
        {!rows.length && current?.ready && (
          <p className="pg-empty">
            No {statusName.toLowerCase()} conversations in this view.
          </p>
        )}
        {current && !current.ready && (
          <p className="pg-empty" aria-live="polite">
            This view is being prepared. Its conversations and counts appear in
            a moment.
          </p>
        )}
      </div>
      {editing && (
        <div className="pg-modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Edit inbox view"
            className="pg-view-dialog"
          >
            <h2>{editing.id ? "Edit view" : "New view"}</h2>
            <label>
              Name
              <input
                value={editing.name ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, name: e.target.value })
                }
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={editing.shared ?? false}
                onChange={(e) =>
                  setEditing({ ...editing, shared: e.target.checked })
                }
              />{" "}
              Shared with workspace
            </label>
            <label>
              Folder
              <select
                value={editing.folder_id ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, folder_id: e.target.value || null })
                }
              >
                <option value="">No folder</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setEditing({ ...editing, folder_id: "__new" })}
            >
              New folder
            </button>
            {editing.folder_id === "__new" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  void mutate({
                    action: "folder",
                    name: form.get("name"),
                    shared: editing.shared,
                  });
                }}
              >
                <input name="name" aria-label="New folder name" required />
                <button disabled={busy}>Create folder</button>
              </form>
            )}
            <FilterEditor
              value={editing.filter ?? initial}
              onChange={(filter) => setEditing({ ...editing, filter })}
            />
            <p>
              Dates use explicit timezones. Unavailable people/SLA filters are
              omitted.
            </p>
            <footer>
              <button onClick={() => setEditing(null)}>Cancel</button>
              <button
                disabled={
                  busy || !editing.name?.trim() || editing.folder_id === "__new"
                }
                onClick={() => {
                  // New views have no folder or position yet: show them last, ungrouped.
                  const optimistic = {
                    ...editing,
                    id: editing.id ?? crypto.randomUUID(),
                    folder_id: editing.folder_id ?? null,
                    position: editing.position ?? Number.MAX_SAFE_INTEGER,
                    ready: false,
                  } as View;
                  void mutate(
                    { action: "save", ...editing, folderId: editing.folder_id },
                    optimistic,
                  );
                }}
              >
                Save view
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
