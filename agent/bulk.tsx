import { useEffect, useRef, useState } from "react";
import { api } from "./api";

type Named = { id: string; name: string };
export type Directory = {
  teammates: Named[];
  teams: Named[];
  tags: Named[];
  ticketStates?: Named[];
};
/** Picked conversation ids, or every conversation in the view (counted by the server). */
export type Selection = { viewId: string; ids: string[]; all: boolean };
type Action =
  | { type: "assign"; teammateId?: string; teamId?: string }
  | { type: "tag_add" | "tag_remove"; tagId: string }
  | { type: "priority"; value: boolean }
  | { type: "snooze"; preset: "later_today" | "tomorrow" | "next_week" }
  | { type: "close" | "reopen" }
  | { type: "ticket_state"; stateId: string };
type Status = {
  status: "prepared" | "running" | "done" | "undoing" | "undone";
  total: number;
  undoMs: number | null;
  counts: Record<string, number>;
  conflicts: { id: string; title: string }[];
};
type Operation = {
  id: string;
  label: string;
  total: number;
  jobIds: string[];
  deadline: number;
  status?: Status;
};

const PRESETS = {
  later_today: "later today",
  tomorrow: "until tomorrow",
  next_week: "until next week",
};
function describe(action: Action, dir: Directory) {
  const name = (list: Named[], id?: string) =>
    list.find((x) => x.id === id)?.name ?? id ?? "";
  switch (action.type) {
    case "assign":
      return action.teammateId
        ? `Assign to ${name(dir.teammates, action.teammateId)}`
        : `Assign to ${name(dir.teams, action.teamId)}`;
    case "tag_add":
      return `Add tag “${name(dir.tags, action.tagId)}” to`;
    case "tag_remove":
      return `Remove tag “${name(dir.tags, action.tagId)}” from`;
    case "priority":
      return action.value ? "Mark as priority" : "Remove priority from";
    case "snooze":
      return `Snooze ${PRESETS[action.preset]}`;
    case "close":
      return "Close";
    case "reopen":
      return "Reopen";
    case "ticket_state":
      return `Set ticket state “${name(dir.ticketStates ?? [], action.stateId)}” on`;
  }
}
const plural = (n: number) =>
  `${n.toLocaleString()} conversation${n === 1 ? "" : "s"}`;

/**
 * Bulk actions on the selected conversations: the server counts the selection, the teammate
 * confirms that count, a background job applies it, and Undo is offered for ten seconds.
 */
export function BulkBar({
  selection,
  count,
  dir,
  onClear,
  onJob,
}: {
  selection: Selection;
  /** What the list shows as selected; the confirmation uses the server's count. */
  count: string;
  dir: Directory;
  onClear: () => void;
  onJob: (id: string) => void;
}) {
  const [confirm, setConfirm] = useState<{
    id: string;
    action: Action;
    total: number;
  } | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [now, setNow] = useState(() => Date.now());
  const confirmButton = useRef<HTMLButtonElement>(null);
  const opId = operation?.id,
    jobKey = operation?.jobIds.join(",");

  // Progress arrives as pushed job frames; each one re-reads the operation's counts.
  useEffect(() => {
    if (!opId || !jobKey) return;
    let live = true;
    const read = () =>
      api<Status>("bulk?" + new URLSearchParams({ id: opId }))
        .then((status) => {
          if (!live) return;
          setOperation((o) =>
            o && o.id === opId
              ? {
                  ...o,
                  status,
                  deadline:
                    status.undoMs === null
                      ? o.deadline
                      : Date.now() + status.undoMs,
                }
              : o,
          );
        })
        .catch((e) => live && setError(e.message));
    const ids = jobKey.split(",");
    const listener = (e: Event) => {
      if (ids.includes(String((e as CustomEvent<{ id: string }>).detail?.id)))
        void read();
    };
    window.addEventListener("relay:job", listener);
    void read();
    return () => {
      live = false;
      window.removeEventListener("relay:job", listener);
    };
  }, [opId, jobKey]);
  const deadline = operation?.deadline ?? 0;
  useEffect(() => {
    if (!deadline) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() > deadline) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [deadline]);
  useEffect(() => {
    if (!confirm) return;
    confirmButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        setConfirm(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm]);

  const prepare = async (action: Action) => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ operationId: string; total: number }>("bulk", {
        op: "prepare",
        action,
        ...(selection.all
          ? { viewId: selection.viewId }
          : { conversationIds: selection.ids }),
      });
      setConfirm({ id: r.operationId, action, total: r.total });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk action unavailable.");
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const r = await api<{ jobId: string; undoMs: number }>("bulk", {
        op: "commit",
        operationId: confirm.id,
      });
      onJob(r.jobId);
      setOperation({
        id: confirm.id,
        label: describe(confirm.action, dir),
        total: confirm.total,
        jobIds: [r.jobId],
        deadline: Date.now() + r.undoMs,
      });
      setNow(Date.now());
      setConfirm(null);
      onClear();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk action unavailable.");
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };
  const undo = async () => {
    if (!operation) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ jobId: string }>("bulk", {
        op: "undo",
        operationId: operation.id,
      });
      onJob(r.jobId);
      setOperation({
        ...operation,
        jobIds: [...operation.jobIds, r.jobId],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Undo unavailable.");
    } finally {
      setBusy(false);
    }
  };

  const picked = selection.all || selection.ids.length > 0;
  if (!picked && !operation && !error) return null;
  const s = operation?.status,
    n = (k: string) => s?.counts[k] ?? 0;
  const remaining = operation
    ? Math.max(0, Math.ceil((operation.deadline - now) / 1000))
    : 0;
  const canUndo =
    !!operation &&
    remaining > 0 &&
    (!s || s.status === "running" || s.status === "done");
  const select = (
    label: string,
    options: [string, string][],
    toAction: (value: string) => Action,
  ) => (
    <select
      aria-label={label}
      value=""
      disabled={busy || !picked}
      onChange={(e) => e.target.value && void prepare(toAction(e.target.value))}
    >
      <option value="">{label}…</option>
      {options.map(([value, text]) => (
        <option key={value} value={value}>
          {text}
        </option>
      ))}
    </select>
  );

  return (
    <section className="pg-bulk" aria-label="Bulk actions">
      {picked && (
        <div role="toolbar" aria-label="Bulk action choices">
          <strong>{count} selected</strong>
          <button
            disabled={busy}
            onClick={() => void prepare({ type: "close" })}
          >
            Close
          </button>
          <button
            disabled={busy}
            onClick={() => void prepare({ type: "reopen" })}
          >
            Reopen
          </button>
          {select(
            "Assign",
            [
              ...dir.teammates.map((t): [string, string] => [
                "t:" + t.id,
                t.name,
              ]),
              ...dir.teams.map((t): [string, string] => [
                "g:" + t.id,
                "Team: " + t.name,
              ]),
            ],
            (v) =>
              v.startsWith("t:")
                ? { type: "assign", teammateId: v.slice(2) }
                : { type: "assign", teamId: v.slice(2) },
          )}
          {select(
            "Add tag",
            dir.tags.map((t) => [t.id, t.name]),
            (v) => ({ type: "tag_add", tagId: v }),
          )}
          {select(
            "Remove tag",
            dir.tags.map((t) => [t.id, t.name]),
            (v) => ({ type: "tag_remove", tagId: v }),
          )}
          {select(
            "Priority",
            [
              ["on", "Mark as priority"],
              ["off", "Remove priority"],
            ],
            (v) => ({ type: "priority", value: v === "on" }),
          )}
          {select(
            "Snooze",
            [
              ["later_today", "Later today"],
              ["tomorrow", "Tomorrow"],
              ["next_week", "Next week"],
            ],
            (v) => ({ type: "snooze", preset: v as "later_today" }),
          )}
          {!!dir.ticketStates?.length &&
            select(
              "Ticket state",
              dir.ticketStates.map((t) => [t.id, t.name]),
              (v) => ({ type: "ticket_state", stateId: v }),
            )}
          <button disabled={busy} onClick={onClear}>
            Clear selection
          </button>
        </div>
      )}
      {operation && (
        <div
          className="pg-bulk-status"
          role="status"
          aria-label="Bulk progress"
        >
          <span>
            {!s || s.status === "running"
              ? `${operation.label} ${plural(operation.total)}… ${n("applied") + n("failed")} of ${operation.total.toLocaleString()} done`
              : s.status === "done"
                ? `${operation.label} ${plural(n("applied"))}.` +
                  (n("failed")
                    ? ` ${plural(n("failed"))} could not be changed.`
                    : "")
                : s.status === "undoing"
                  ? "Undoing…"
                  : `Undone: ${plural(n("undone"))} restored.` +
                    (n("conflict")
                      ? ` ${plural(n("conflict"))} changed since and left alone.`
                      : "") +
                    (n("cancelled")
                      ? ` ${plural(n("cancelled"))} not reached.`
                      : "")}
          </span>
          {canUndo && (
            <button disabled={busy} onClick={() => void undo()}>
              Undo ({remaining}s)
            </button>
          )}
          {s &&
            (s.status === "undone" || (s.status === "done" && !canUndo)) && (
              <button onClick={() => setOperation(null)}>Dismiss</button>
            )}
          {s?.status === "undone" && s.conflicts.length > 0 && (
            <ul aria-label="Left alone">
              {s.conflicts.map((c) => (
                <li key={c.id}>{c.title || "Conversation"}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="pg-bulk-error">
          {error} <button onClick={() => setError("")}>Dismiss</button>
        </p>
      )}
      {confirm && (
        <div className="pg-modal-backdrop">
          <section
            role="alertdialog"
            aria-modal="true"
            aria-label="Confirm bulk action"
            className="pg-view-dialog pg-bulk-confirm"
          >
            <p>
              {describe(confirm.action, dir)}{" "}
              <strong>{plural(confirm.total)}</strong>?
            </p>
            <p className="pg-empty">You can undo this for 10 seconds.</p>
            <footer>
              <button onClick={() => setConfirm(null)}>Cancel</button>
              <button
                ref={confirmButton}
                disabled={busy}
                onClick={() => void commit()}
              >
                Apply to {plural(confirm.total)}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
