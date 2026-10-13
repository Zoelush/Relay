import { lazy, Suspense, useEffect, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, CircleDot, FilePen, GripVertical, History, Layers, PauseCircle, Plus, Workflow as WorkflowIcon } from "lucide-react";
import { api } from "./api";
import { ShowMenuButton, SideMenu, useSideMenu } from "./shell";
import { message } from "./settings-ui";
import { ago } from "./zoe-labels";
import { TRIGGERS, type Trigger } from "../lib/workflow-definition";
import { AlertBanners, RunLog, type Alert } from "./workflow-runs";

/** The canvas (React Flow) is its own chunk, loaded when a workflow opens. */
const WorkflowBuilder = lazy(() => import("./workflow-builder").then((m) => ({ default: m.WorkflowBuilder })));

/**
 * The Workflows area (phase 11, step W2; docs/WORKFLOWS_STEP2.md), for managers while
 * `workflows_v1` is on, at `#workflows` (one workflow at `#workflows/<id>`). The list is grouped
 * by trigger in priority order, as Intercom's is; dragging a row (or its arrows) reorders it.
 */
type Row = {
  id: string;
  name: string;
  state: "draft" | "live" | "paused";
  priority: number;
  liveVersion: number | null;
  changed: boolean;
  customerFacing: boolean;
  updatedAt: string;
  updatedBy: string | null;
  runs: { completed: number; failed: number; skipped: number; active: number; last: string | null };
  failing: boolean;
};
type Named = { id: string; name: string };
type TemplateInfo = { id: string; name: string; category: string; description: string; slots: { key: string; kind: "tag" | "team"; label: string }[] };
type List = {
  triggers: { trigger: Trigger; label: string; customer: boolean; firedBy: string; workflows: Row[] }[];
  alerts: Alert[];
  templates: TemplateInfo[];
  choices: { tags: Named[]; teams: Named[] };
};
type Filter = "all" | "live" | "draft" | "paused";
const FILTERS: { id: Filter; label: string; icon: typeof Layers; hue: string }[] = [
  { id: "all", label: "All workflows", icon: Layers, hue: "slate" },
  { id: "live", label: "Live", icon: CircleDot, hue: "green" },
  { id: "draft", label: "Drafts", icon: FilePen, hue: "amber" },
  { id: "paused", label: "Paused", icon: PauseCircle, hue: "rose" },
];
const STATE_NAMES = { draft: "Draft", live: "Live", paused: "Paused" };

export function Workflows({
  open,
  onOpen,
  onConversation,
}: {
  /** A workflow's id (the builder), "runs" or "runs/<workflow id>" (the run log), or null (the list). */
  open: string | null;
  onOpen: (id: string | null) => void;
  onConversation?: (id: string) => void;
}) {
  const menu = useSideMenu("workflows");
  const [list, setList] = useState<List | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<{ trigger: Trigger; id: string } | null>(null);
  const runLog = open?.startsWith("runs") ? (open.split("/")[1] ?? "") : null;
  useEffect(() => {
    if (open && runLog === null) return;
    api<List>("workflows")
      .then(setList)
      .catch((e) => setError(message(e, "Workflows could not be loaded.")));
  }, [open, runLog]);
  const dismiss = async (workflowId: string) => {
    try {
      setList(await api<List>("workflow", { action: "dismiss_alert", id: workflowId }));
    } catch (e) {
      setError(message(e, "The alert couldn't be dismissed."));
    }
  };
  if (open && runLog === null)
    return (
      <section className="pg-workspace pg-wf" aria-label="Workflows">
        <Suspense fallback={<div className="pg-wf-builder" aria-busy="true" />}>
          <WorkflowBuilder id={open} onBack={() => onOpen(null)} onRuns={(id) => onOpen(`runs/${id}`)} />
        </Suspense>
      </section>
    );
  const all = list?.triggers.flatMap((t) => t.workflows) ?? [];
  const count = (f: Filter) => (f === "all" ? all.length : all.filter((w) => w.state === f).length);
  const q = search.trim().toLowerCase();
  const shown = (w: Row) => (filter === "all" || w.state === filter) && (!q || w.name.toLowerCase().includes(q));
  // Reordering needs every workflow for the trigger on screen.
  const canReorder = filter === "all" && !q;
  const reorder = async (trigger: Trigger, ids: string[]) => {
    setBusy(true);
    setError("");
    // Shown at once; the server's order replaces it.
    setList((l) => l && { ...l, triggers: l.triggers.map((t) => (t.trigger === trigger ? { ...t, workflows: ids.map((id) => t.workflows.find((w) => w.id === id)!) } : t)) });
    try {
      setList(await api<List>("workflow", { action: "reorder", trigger, ids }));
    } catch (e) {
      setError(message(e, "The order could not be changed."));
      setList(await api<List>("workflows"));
    } finally {
      setBusy(false);
    }
  };
  const move = (trigger: Trigger, rows: Row[], from: number, to: number) => {
    if (to < 0 || to >= rows.length || from === to) return;
    const ids = rows.map((r) => r.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    void reorder(trigger, ids);
  };
  return (
    <section className="pg-workspace pg-wf" aria-label="Workflows">
      <div className="pg-area">
        <SideMenu state={menu} title="Workflows" label="Workflows menu">
          <ul className="pg-menu-entries">
            {FILTERS.map((f) => (
              <li key={f.id} data-hue={f.hue}>
                <button
                  aria-current={runLog === null && filter === f.id ? "page" : undefined}
                  onClick={() => {
                    setFilter(f.id);
                    if (runLog !== null) onOpen(null);
                  }}
                >
                  <span className="pg-menu-entry-icon" aria-hidden="true">
                    <f.icon size={16} />
                  </span>
                  <span className="pg-menu-entry-name">{f.label}</span>
                  <span className="pg-menu-entry-count">{list ? count(f.id) : ""}</span>
                </button>
              </li>
            ))}
          </ul>
          <ul className="pg-menu-entries">
            <li data-hue="sky">
              <button aria-current={runLog !== null ? "page" : undefined} onClick={() => onOpen("runs")}>
                <span className="pg-menu-entry-icon" aria-hidden="true">
                  <History size={16} />
                </span>
                <span className="pg-menu-entry-name">Run log</span>
                <span className="pg-menu-entry-count">{list?.alerts.length ? <AlertTriangle size={13} aria-label={`${list.alerts.length} failing`} /> : ""}</span>
              </button>
            </li>
          </ul>
        </SideMenu>
        <div className="pg-area-main">
          <header className="pg-top pg-settings-head">
            <ShowMenuButton state={menu} />
            <div>
              <h2>{runLog !== null ? "Run log" : FILTERS.find((f) => f.id === filter)!.label}</h2>
              <p className="pg-muted">
                {runLog !== null
                  ? "Every run: each step, each condition with what it saw, and each action with its result."
                  : "Automate what happens in conversations: tag, route, prioritise, apply SLAs and hand over, by trigger and condition."}
              </p>
            </div>
            {runLog === null && (
              <div className="pg-settings-save">
                <input type="search" aria-label="Search workflows" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
                <button type="button" className="pg-primary" onClick={() => setCreating(true)}>
                  <Plus size={14} aria-hidden="true" /> New workflow
                </button>
              </div>
            )}
          </header>
          {runLog !== null ? (
            <div className="pg-settings-body wide">
              <RunLog key={runLog} workflows={all.map((w) => ({ id: w.id, name: w.name }))} initialWorkflow={runLog} onConversation={onConversation} onDismiss={dismiss} />
            </div>
          ) : (
          <div className="pg-settings-body pg-wf-list">
            <AlertBanners alerts={list?.alerts ?? []} onRuns={(id) => onOpen(`runs/${id}`)} onDismiss={(id) => void dismiss(id)} />
            {error && (
              <p role="alert" className="pg-attr-error">
                {error}
              </p>
            )}
            {creating && list && (
              <CreateForm
                templates={list.templates}
                choices={list.choices}
                onCancel={() => setCreating(false)}
                onCreated={(id) => {
                  setCreating(false);
                  onOpen(id);
                }}
              />
            )}
            {list && !all.length && !creating && (
              <div className="pg-wf-empty">
                <WorkflowIcon size={28} aria-hidden="true" />
                <p>No workflows yet. Start one to tag, route or hand over conversations automatically.</p>
              </div>
            )}
            {list?.triggers.map((t) => {
              const rows = t.workflows.filter(shown);
              if (!rows.length) return null;
              return (
                <section key={t.trigger} className="pg-wf-group-card" aria-labelledby={`wf-${t.trigger}`}>
                  <header>
                    <h3 id={`wf-${t.trigger}`}>{t.label}</h3>
                    <p className="pg-muted">
                      {t.firedBy}{" "}
                      {t.customer
                        ? "Only the highest-priority customer-facing workflow that matches runs; background workflows all run, in this order."
                        : "Every workflow that matches runs, in this order."}
                    </p>
                  </header>
                  <ol className="pg-wf-rows">
                    {rows.map((w, i) => (
                      <li
                        key={w.id}
                        className="pg-wf-row"
                        data-dragging={dragging?.id === w.id ? "true" : undefined}
                        draggable={canReorder && !busy}
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = "move";
                          setDragging({ trigger: t.trigger, id: w.id });
                        }}
                        onDragEnd={() => setDragging(null)}
                        onDragOver={(e) => dragging?.trigger === t.trigger && e.preventDefault()}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (dragging?.trigger === t.trigger) move(t.trigger, rows, rows.findIndex((r) => r.id === dragging.id), i);
                          setDragging(null);
                        }}
                      >
                        {canReorder && (
                          <span className="pg-wf-grip" aria-hidden="true" title="Drag to reorder">
                            <GripVertical size={14} />
                          </span>
                        )}
                        <span className="pg-wf-priority" title="Priority">
                          {i + 1}
                        </span>
                        <span className="pg-wf-row-main">
                          <button type="button" className="pg-wf-row-name" onClick={() => onOpen(w.id)}>
                            {w.name}
                          </button>
                          <span className="pg-muted">
                            {w.liveVersion ? `Version ${w.liveVersion}` : "Never published"}
                            {w.changed && w.liveVersion ? " · unpublished changes" : ""} · updated {ago(w.updatedAt)}
                            {w.updatedBy ? ` by ${w.updatedBy}` : ""}
                          </span>
                        </span>
                        {w.failing && (
                          <span className="pg-wf-state" data-state="failing">
                            Failing
                          </span>
                        )}
                        <span className="pg-wf-state" data-state={w.state}>
                          {STATE_NAMES[w.state]}
                        </span>
                        <span className="pg-wf-counts" aria-label={`Last 30 days: ${w.runs.completed} completed, ${w.runs.failed} failed, ${w.runs.skipped} skipped`}>
                          <span title="Completed in the last 30 days">{w.runs.completed} completed</span>
                          <span title="Failed in the last 30 days" data-bad={w.runs.failed ? "true" : undefined}>
                            {w.runs.failed} failed
                          </span>
                          <span title="Matched but didn't run, in the last 30 days">{w.runs.skipped} skipped</span>
                        </span>
                        {canReorder && rows.length > 1 && (
                          <span className="pg-wf-step-tools">
                            <button type="button" className="pg-wf-icon" aria-label={`Move ${w.name} up`} disabled={i === 0 || busy} onClick={() => move(t.trigger, rows, i, i - 1)}>
                              <ArrowUp size={14} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="pg-wf-icon"
                              aria-label={`Move ${w.name} down`}
                              disabled={i === rows.length - 1 || busy}
                              onClick={() => move(t.trigger, rows, i, i + 1)}
                            >
                              <ArrowDown size={14} aria-hidden="true" />
                            </button>
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              );
            })}
          </div>
          )}
        </div>
      </div>
    </section>
  );
}

function CreateForm({
  templates,
  choices,
  onCancel,
  onCreated,
}: {
  templates: TemplateInfo[];
  choices: { tags: Named[]; teams: Named[] };
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<Trigger>("first_message");
  const [template, setTemplate] = useState("");
  const [slots, setSlots] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosen = templates.find((t) => t.id === template);
  const categories = [...new Set(templates.map((t) => t.category))];
  const pick = (id: string) => {
    setTemplate(id);
    setSlots({});
    const t = templates.find((x) => x.id === id);
    if (t) setName(t.name);
  };
  const missing = chosen?.slots.some((s) => !slots[s.key]);
  return (
    <form
      className="pg-wf-create"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          const d = await api<{ workflow: { id: string } }>("workflow", chosen ? { action: "create", name, template, slots } : { action: "create", name, trigger });
          onCreated(d.workflow.id);
        } catch (err) {
          setError(message(err, "The workflow could not be created."));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="pg-settings-field">
        <span>Start from</span>
        <select value={template} onChange={(e) => pick(e.target.value)}>
          <option value="">A blank workflow</option>
          {categories.map((c) => (
            <optgroup key={c} label={c}>
              {templates
                .filter((t) => t.category === c)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="pg-settings-field">
        <span>Name</span>
        <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Route French conversations" />
      </label>
      {!chosen && (
        <label className="pg-settings-field">
          <span>When</span>
          <select value={trigger} onChange={(e) => setTrigger(e.target.value as Trigger)}>
            {(Object.keys(TRIGGERS) as Trigger[]).map((k) => (
              <option key={k} value={k}>
                {TRIGGERS[k].label}
              </option>
            ))}
          </select>
        </label>
      )}
      {chosen && (
        <>
          <p className="pg-muted pg-wf-template-about">{chosen.description}</p>
          {chosen.slots.map((s) => {
            const list = s.kind === "tag" ? choices.tags : choices.teams;
            return (
              <label className="pg-settings-field" key={s.key}>
                <span>{s.label}</span>
                <select value={slots[s.key] ?? ""} onChange={(e) => setSlots((x) => ({ ...x, [s.key]: e.target.value }))}>
                  <option value="">{list.length ? "Choose…" : `No ${s.kind}s yet: add one in Settings`}</option>
                  {list.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </>
      )}
      <button type="submit" className="pg-primary" disabled={busy || !name.trim() || missing}>
        Create and open
      </button>
      <button type="button" className="pg-zoe-secondary" onClick={onCancel}>
        Cancel
      </button>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
    </form>
  );
}
