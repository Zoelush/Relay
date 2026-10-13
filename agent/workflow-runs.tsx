import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, X } from "lucide-react";
import { api } from "./api";
import { message } from "./settings-ui";
import { ago } from "./zoe-labels";
import { TRIGGERS, type Trigger } from "../lib/workflow-definition";

/**
 * The run log (phase 11, step W4; docs/WORKFLOWS_STEP4.md): every run, newest first, filtered by
 * workflow, outcome, trigger and conversation; each opens to every node visited, condition
 * evaluated (with what it saw) and action taken (with its result and time). Workflows that keep
 * failing are flagged at the top, with their last error.
 */
export type Alert = { id: string; workflowId: string; workflow: string; openedAt: string; failures: number; lastError: string; lastRunId: string | null };
type Run = {
  id: string;
  workflowId: string;
  workflow: string;
  version: number;
  conversationId: string | null;
  trigger: string;
  source: string;
  status: string;
  path: string | null;
  reason: string;
  error: string;
  steps: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  waitUntil: string | null;
};
type Step = { seq: number; at: string; path: string | null; step: number | null; kind: string; label: string; inputs: unknown; result: string; detail: unknown; durationMs: number };
const STATUS = { completed: "Completed", failed: "Failed", skipped: "Skipped", running: "Running", waiting: "Waiting" } as const;
const label = (t: string) => TRIGGERS[t as Trigger]?.label ?? t;
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const shown = (v: unknown) => (v === null || v === undefined || v === "" ? "nothing" : Array.isArray(v) ? (v.length ? v.join(", ") : "none") : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Alerts for workflows that keep failing: each says what failed, with a way to its runs. */
export function AlertBanners({ alerts, onRuns, onDismiss }: { alerts: Alert[]; onRuns?: (workflowId: string) => void; onDismiss?: (workflowId: string) => void }) {
  if (!alerts.length) return null;
  return (
    <div className="pg-wf-alerts" role="alert">
      {alerts.map((a) => (
        <div key={a.id} className="pg-wf-alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <div>
            <strong>
              “{a.workflow}” keeps failing: {a.failures} failed runs in a row
            </strong>
            <span>
              Since {ago(a.openedAt)}. Last error: {a.lastError || "none recorded"}
            </span>
          </div>
          {onRuns && (
            <button type="button" className="pg-zoe-secondary" onClick={() => onRuns(a.workflowId)}>
              See its runs
            </button>
          )}
          {onDismiss && (
            <button type="button" className="pg-zoe-secondary" onClick={() => onDismiss(a.workflowId)}>
              Dismiss
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function RunLog({
  workflows,
  initialWorkflow,
  onConversation,
  onDismiss,
}: {
  workflows: { id: string; name: string }[];
  initialWorkflow: string;
  onConversation?: (id: string) => void;
  onDismiss: (workflowId: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState({ workflow: initialWorkflow, status: "", trigger: "", conversation: "" });
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<{ run: Run; steps: Step[] } | null>(null);
  const [error, setError] = useState("");
  // An opened run is brought into view (below the table, or down the page on a narrow screen).
  const detail = useRef<HTMLElement>(null);
  const openId = open?.run.id;
  useEffect(() => {
    if (openId) detail.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [openId]);
  const query = useCallback(
    (before?: string) => {
      const q = new URLSearchParams();
      if (filter.workflow) q.set("workflow", filter.workflow);
      if (filter.status) q.set("status", filter.status);
      if (filter.trigger) q.set("trigger", filter.trigger);
      if (filter.conversation.trim()) q.set("conversation", filter.conversation.trim());
      if (before) q.set("before", before);
      return api<{ runs: Run[]; next: string | null; alerts: Alert[] }>(`workflow-runs?${q}`);
    },
    [filter],
  );
  const load = useCallback(
    () =>
      query()
        .then((d) => {
          setRuns(d.runs);
          setNext(d.next);
          setAlerts(d.alerts);
          setError("");
        })
        .catch((e) => setError(message(e, "Runs couldn't be loaded."))),
    [query],
  );
  useEffect(() => {
    const t = setTimeout(() => void load(), filter.conversation ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, filter.conversation]);
  const show = async (r: Run) => {
    try {
      setOpen(await api<{ run: Run; steps: Step[] }>(`workflow-runs?id=${encodeURIComponent(r.id)}`));
    } catch (e) {
      setError(message(e, "That run couldn't be loaded."));
    }
  };
  const set = (k: keyof typeof filter, v: string) => setFilter((f) => ({ ...f, [k]: v }));
  return (
    <div className="pg-wf-runlog">
      <AlertBanners
        alerts={alerts}
        onRuns={(id) => setFilter((f) => ({ ...f, workflow: id, status: "failed" }))}
        onDismiss={async (id) => {
          await onDismiss(id);
          await load();
        }}
      />
      <div className="pg-wf-runlog-filters" role="group" aria-label="Filter runs">
        <select aria-label="Workflow" value={filter.workflow} onChange={(e) => set("workflow", e.target.value)}>
          <option value="">All workflows</option>
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <select aria-label="Outcome" value={filter.status} onChange={(e) => set("status", e.target.value)}>
          <option value="">Any outcome</option>
          {Object.entries(STATUS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <select aria-label="Trigger" value={filter.trigger} onChange={(e) => set("trigger", e.target.value)}>
          <option value="">Any trigger</option>
          {(Object.keys(TRIGGERS) as Trigger[]).map((t) => (
            <option key={t} value={t}>
              {TRIGGERS[t].label}
            </option>
          ))}
        </select>
        <input type="search" aria-label="Conversation ID" placeholder="Conversation ID" value={filter.conversation} onChange={(e) => set("conversation", e.target.value)} />
      </div>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {runs && !runs.length && <p className="pg-muted">No runs match.</p>}
      {runs && runs.length > 0 && (
        <table className="pg-wf-runs">
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Workflow</th>
              <th scope="col">Trigger</th>
              <th scope="col">Outcome</th>
              <th scope="col">Why</th>
              <th scope="col">Took</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} data-selected={open?.run.id === r.id ? "true" : undefined}>
                <td>
                  <button type="button" className="pg-wf-link" onClick={() => void show(r)} aria-label={`Open the run of ${r.workflow} started ${time(r.startedAt)}`}>
                    {time(r.startedAt)}
                  </button>
                </td>
                <td>
                  {r.workflow} <span className="pg-muted">v{r.version}</span>
                </td>
                <td>{label(r.trigger)}</td>
                <td>
                  <span className="pg-wf-run-status" data-status={r.status}>
                    {STATUS[r.status as keyof typeof STATUS] ?? r.status}
                  </span>
                </td>
                <td className="pg-wf-run-why">{r.error || r.reason || (r.status === "waiting" && r.waitUntil ? `Until ${time(r.waitUntil)}` : "")}</td>
                <td>{r.durationMs !== null ? `${r.durationMs} ms` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && (
        <button
          type="button"
          className="pg-zoe-secondary"
          onClick={() =>
            void query(next).then((d) => {
              setRuns((r) => [...(r ?? []), ...d.runs]);
              setNext(d.next);
            })
          }
        >
          Older runs
        </button>
      )}
      {open && (
        <aside
          className="pg-wf-run-detail"
          aria-label="Run"
          ref={detail}
        >
          <header>
            <div>
              <h3>
                {open.run.workflow} <span className="pg-muted">version {open.run.version}</span>
              </h3>
              <p className="pg-muted">
                {label(open.run.trigger)} (by {open.run.source}) · {STATUS[open.run.status as keyof typeof STATUS] ?? open.run.status}
                {open.run.durationMs !== null ? ` in ${open.run.durationMs} ms` : ""}
              </p>
            </div>
            {open.run.conversationId && onConversation && (
              <button type="button" className="pg-zoe-secondary" onClick={() => onConversation(open.run.conversationId!)}>
                <ExternalLink size={14} aria-hidden="true" /> Conversation
              </button>
            )}
            <button type="button" className="pg-wf-icon" aria-label="Close the run" onClick={() => setOpen(null)}>
              <X size={16} aria-hidden="true" />
            </button>
          </header>
          {open.run.error && <p className="pg-attr-error">{open.run.error}</p>}
          <ol className="pg-wf-trace" aria-label="What it did">
            {open.steps.map((s) => (
              <li key={s.seq} data-kind={s.kind === "action" ? (s.result === "failed" ? "stop" : "action") : s.kind === "error" ? "stop" : s.kind}>
                <div className="pg-wf-trace-line">
                  <span className="pg-wf-letter" aria-hidden={!s.path}>
                    {s.path ?? "•"}
                  </span>
                  <span>
                    {s.label} <span className="pg-muted">→ {s.result}</span>
                    {s.durationMs > 0 && <span className="pg-muted"> · {s.durationMs} ms</span>}
                  </span>
                </div>
                {Array.isArray(s.inputs) && s.inputs.length > 0 && (s.inputs[0] as { field?: string })?.field && (
                  <ul className="pg-wf-checks">
                    {(s.inputs as { field: string; key?: string; op: string; value?: unknown; actual: unknown; result: boolean }[]).map((c, j) => (
                      <li key={j} data-result={c.result ? "true" : "false"}>
                        {c.result ? "✓" : "✗"} {c.field}
                        {c.key ? ` (${c.key})` : ""} {c.op.replace(/_/g, " ")} {c.value !== undefined ? shown(c.value) : ""}: it was {shown(c.actual)}
                      </li>
                    ))}
                  </ul>
                )}
                {!Array.isArray(s.inputs) && !!s.inputs && Object.keys(s.inputs as object).length > 0 ? <code className="pg-wf-io">{shown(s.inputs)}</code> : null}
                {s.detail && Object.keys(s.detail as object).length > 0 ? <code className="pg-wf-io">{shown(s.detail)}</code> : null}
              </li>
            ))}
          </ol>
        </aside>
      )}
    </div>
  );
}
