import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import {
  AlertTriangle,
  ArrowLeft,
  History,
  List,
  Maximize,
  Minus,
  Pause,
  Play,
  Plus,
  Redo2,
  Rocket,
  Save,
  Archive,
  Trash2,
  Undo2,
  Wand2,
  Zap,
} from "lucide-react";
import { api, InboxError } from "./api";
import { ago } from "./zoe-labels";
import { describeGroup, describeStep, Duration, GroupEditor, StepsEditor, type Options } from "./workflow-parts";
import {
  LATER_TRIGGERS,
  MAX_PATHS,
  MAX_STEPS,
  TRIGGERS,
  autoLayout,
  DefinitionError,
  nextLetter,
  outlets,
  problems as graphProblems,
  validate,
  type Definition,
  type Group,
  type Layout,
  type Next,
  type Path,
  type Trigger,
} from "../lib/workflow-definition";

/**
 * The workflow builder (phase 11, step W2; docs/WORKFLOWS_STEP2.md): a canvas of the trigger and
 * its lettered paths (React Flow), where cards are dragged, ways on connected (or dropped on empty
 * canvas for a new path), zoomed and tidied, with undo and redo; a panel edits what's selected.
 * What blocks publishing is checked here with the engine's own `validate` and `problems`, and the
 * server adds what the workflow names that doesn't exist. Who it runs for shows a live estimate.
 */
export type Detail = {
  workflow: {
    id: string;
    name: string;
    state: "draft" | "live" | "paused";
    version: string;
    definition: Definition;
    layout: Layout;
    liveVersion: number | null;
    changed: boolean;
    updatedAt: string;
    updatedBy: string | null;
    problems: string[];
  };
  versions: { version: number; publishedAt: string; by: string | null; restoredFrom: number | null }[];
  options: Options;
};
type Draft = { name: string; definition: Definition; layout: Layout };
type Estimate = { sample: number; matched: number; days: number; limit: number; assumed: string[] };

const NEXT_TYPES: { type: Next["type"]; label: string }[] = [
  { type: "end", label: "End" },
  { type: "goto", label: "Go to a path" },
  { type: "branch", label: "Branch on conditions" },
  { type: "wait_until", label: "Wait until a condition holds" },
];
const STATE_NAMES = { draft: "Draft", live: "Live", paused: "Paused" };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** The draft's problems, in the words publishing would use: its shape first, then its graph. */
function localProblems(def: Definition): string[] {
  try {
    return graphProblems(validate(def));
  } catch (e) {
    if (e instanceof DefinitionError) return [e.message];
    throw e;
  }
}
/** "Path B: …" → "B", to select the card a problem is about. */
const pathOf = (problem: string) => /^Path ([A-Z]{1,2})\b/.exec(problem)?.[1] ?? null;

/* ------------------------------------------------------------------------------------------ */
/* History: undo and redo                                                                      */

type HistoryState = { past: Draft[]; present: Draft; future: Draft[]; group: string | null; at: number };
const LIMIT = 100;

function useHistory(initial: Draft) {
  const [h, setH] = useState<HistoryState>({ past: [], present: initial, future: [], group: null, at: 0 });
  /** A change. Typing into one field within a second is one step back (`group`). */
  const change = useCallback((next: Draft | ((d: Draft) => Draft), group: string | null = null) => {
    setH((s) => {
      const value = typeof next === "function" ? next(s.present) : next;
      if (same(value, s.present)) return s;
      const now = Date.now();
      if (group && group === s.group && now - s.at < 1000) return { ...s, present: value, at: now };
      return { past: [...s.past, s.present].slice(-LIMIT), present: value, future: [], group, at: now };
    });
  }, []);
  const undo = useCallback(
    () => setH((s) => (s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future], group: null, at: 0 } : s)),
    [],
  );
  const redo = useCallback(
    () => setH((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1), group: null, at: 0 } : s)),
    [],
  );
  /** What the server saved (tidied: trimmed names, step ids). Undo still reaches earlier changes. */
  const replace = useCallback((d: Draft) => setH((s) => ({ past: same(d, s.present) ? s.past : [...s.past, s.present].slice(-LIMIT), present: d, future: [], group: null, at: 0 })), []);
  return { draft: h.present, change, undo, redo, replace, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}

/* ------------------------------------------------------------------------------------------ */
/* Cards                                                                                       */

type TriggerData = { label: string; who: string; estimate: string };
type PathData = { path: Path; start: boolean; steps: string[]; flagged: boolean };

function TriggerCard({ data, selected }: NodeProps<Node<TriggerData>>) {
  return (
    <div className="pg-wf-card pg-wf-trigger" data-selected={selected ? "true" : undefined}>
      <div className="pg-wf-card-head">
        <span className="pg-wf-badge" aria-hidden="true">
          <Zap size={14} />
        </span>
        <strong>{data.label}</strong>
      </div>
      <p className="pg-wf-card-line">
        <span className="pg-muted">Runs for: </span>
        {data.who}
      </p>
      {data.estimate && <p className="pg-wf-card-line pg-muted">{data.estimate}</p>}
      <Handle type="source" position={Position.Right} id="start" className="pg-wf-handle" />
    </div>
  );
}

function PathCard({ data, selected }: NodeProps<Node<PathData>>) {
  const { path } = data;
  const ways = outlets(path);
  return (
    <div className="pg-wf-card pg-wf-path" data-selected={selected ? "true" : undefined} data-flagged={data.flagged ? "true" : undefined}>
      <Handle type="target" position={Position.Left} className="pg-wf-handle" />
      <div className="pg-wf-card-head">
        <span className="pg-wf-letter">{path.id}</span>
        <strong>{path.label || (data.start ? "Start" : `Path ${path.id}`)}</strong>
        {data.flagged && <AlertTriangle size={14} className="pg-wf-flag" aria-label="Has a problem" />}
      </div>
      {data.steps.length ? (
        <ol className="pg-wf-card-steps">
          {data.steps.slice(0, 6).map((s, i) => (
            <li key={i}>{s}</li>
          ))}
          {data.steps.length > 6 && <li className="pg-muted">and {data.steps.length - 6} more</li>}
        </ol>
      ) : (
        <p className="pg-wf-card-line pg-muted">No steps yet</p>
      )}
      <div className="pg-wf-outlets">
        {path.next.type === "end" ? (
          <div className="pg-wf-outlet">
            <span className="pg-wf-end">END</span>
            <Handle type="source" position={Position.Right} id="next" className="pg-wf-handle" title="Drag to another path to go on to it" />
          </div>
        ) : (
          ways.map((w) => (
            <div key={w.id} className="pg-wf-outlet" data-open={w.target ? undefined : "true"}>
              <span>
                {w.label}
                {w.target ? ` → ${w.target}` : " → not connected"}
              </span>
              <Handle type="source" position={Position.Right} id={w.id} className="pg-wf-handle" />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
const NODE_TYPES = { trigger: TriggerCard, path: PathCard };

/** A path with one way on pointed elsewhere (`""`: disconnected). */
function connect(p: Path, handle: string, target: string): Path {
  const n = p.next;
  if (handle === "next") return { ...p, next: target ? { type: "goto", path: target } : { type: "end" } };
  if (n.type === "branch" && handle === "else") return { ...p, next: { ...n, else: target } };
  if (n.type === "branch" && /^b\d+$/.test(handle)) {
    const i = Number(handle.slice(1));
    return { ...p, next: { ...n, branches: n.branches.map((b, j) => (j === i ? { ...b, path: target } : b)) } };
  }
  if (n.type === "wait_until" && (handle === "met" || handle === "timedOut")) return { ...p, next: { ...n, [handle]: target } };
  return p;
}

/* ------------------------------------------------------------------------------------------ */
/* The builder                                                                                 */

export function WorkflowBuilder(props: { id: string; onBack: () => void; onConversation?: (id: string) => void }) {
  return (
    <ReactFlowProvider>
      <Builder {...props} />
    </ReactFlowProvider>
  );
}

function Builder({ id, onBack }: { id: string; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState("");
  const load = useCallback(
    () =>
      api<Detail>(`workflows?id=${encodeURIComponent(id)}`)
        .then((d) => {
          setDetail(d);
          setLoadError("");
        })
        .catch((e) => setLoadError(errorText(e, "This workflow could not be loaded."))),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  if (!detail)
    return (
      <section className="pg-wf-builder" aria-busy={!loadError}>
        <header className="pg-wf-bar">
          <button type="button" className="pg-zoe-secondary" onClick={onBack}>
            <ArrowLeft size={14} aria-hidden="true" /> Workflows
          </button>
        </header>
        {loadError && (
          <p role="alert" className="pg-attr-error">
            {loadError}
          </p>
        )}
      </section>
    );
  return <Editor key={detail.workflow.id} initial={detail} onBack={onBack} />;
}

function Editor({ initial, onBack }: { initial: Detail; onBack: () => void }) {
  const [detail, setDetail] = useState(initial);
  const w = detail.workflow;
  const o = detail.options;
  const fromDetail = (d: Detail): Draft => ({
    name: d.workflow.name,
    definition: d.workflow.definition,
    // Cards without a saved position are tidied into place.
    layout: { ...autoLayout(d.workflow.definition), ...d.workflow.layout },
  });
  const history = useHistory(fromDetail(initial));
  const { draft, change, undo, redo } = history;
  const def = draft.definition;
  const [saved, setSaved] = useState<Draft>(() => fromDetail(initial));
  const dirty = !same(draft, saved);
  const [selected, setSelected] = useState<string>("trigger");
  const [panel, setPanel] = useState<"edit" | "versions">("edit");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const flow = useReactFlow();

  /* What blocks publishing: the draft's own problems now, and what the server found missing. */
  const local = useMemo(() => localProblems(def), [def]);
  const references = useMemo(() => {
    const savedGraph = localProblems(saved.definition);
    return w.problems.filter((p) => !savedGraph.includes(p));
  }, [w.problems, saved.definition]);
  const blockers = useMemo(() => [...local, ...references], [local, references]);
  const flagged = useMemo(() => new Set(blockers.map(pathOf).filter(Boolean) as string[]), [blockers]);

  /* The live estimate of who it runs for, a moment after it changes. */
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estimateError, setEstimateError] = useState("");
  const whenKey = JSON.stringify(def.when);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      // Unfinished conditions (an empty value) can't be estimated; say so without asking.
      try {
        validate({ trigger: { type: "manual", options: {} }, when: JSON.parse(whenKey), paths: [{ id: "A", label: "", steps: [], next: { type: "end" } }] });
      } catch {
        setEstimate(null);
        setEstimateError("Finish the conditions to see an estimate.");
        return;
      }
      api<Estimate>(`workflow-estimate?when=${encodeURIComponent(whenKey)}`)
        .then((e) => {
          if (!live) return;
          setEstimate(e);
          setEstimateError("");
        })
        .catch((e) => live && (setEstimate(null), setEstimateError(e instanceof InboxError && e.status === 400 ? "Finish the conditions to see an estimate." : "No estimate right now.")));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [whenKey]);
  const estimateLine = estimate
    ? estimate.sample
      ? `${estimate.assumed.length ? "At most " : ""}${estimate.matched} of the last ${estimate.sample} conversations (${Math.round((estimate.matched / estimate.sample) * 100)}%)`
      : `No conversations in the last ${estimate.days} days to estimate from`
    : estimateError;

  /* Edits */
  const setDef = (next: Definition, group: string | null = null) => change((d) => ({ ...d, definition: next }), group);
  const setPath = (pid: string, fn: (p: Path) => Path, group: string | null = null) =>
    change((d) => ({ ...d, definition: { ...d.definition, paths: d.definition.paths.map((p) => (p.id === pid ? fn(p) : p)) } }), group && `${pid}:${group}`);
  const addPath = (at?: { x: number; y: number }, from?: { node: string; handle: string }) => {
    if (def.paths.length >= MAX_PATHS) {
      setError(`A workflow holds at most ${MAX_PATHS} paths.`);
      return;
    }
    const letter = nextLetter(def);
    const fresh: Path = { id: letter, label: "", steps: [], next: { type: "end" } };
    change((d) => {
      const right = Math.max(...Object.values(d.layout).map((p) => p.x)) + 380;
      return {
        ...d,
        definition: {
          ...d.definition,
          paths: [...d.definition.paths.map((p) => (from && p.id === from.node ? connect(p, from.handle, letter) : p)), fresh],
        },
        layout: { ...d.layout, [letter]: at ?? { x: right, y: 0 } },
      };
    });
    setSelected(letter);
  };
  const removePaths = (ids: string[]) => {
    const gone = new Set(ids.filter((x) => x !== "trigger"));
    if (!gone.size) return;
    if (gone.size >= def.paths.length) {
      setError("A workflow needs at least one path.");
      return;
    }
    change((d) => {
      const paths = d.definition.paths
        .filter((p) => !gone.has(p.id))
        .map((p) => outlets(p).reduce((q, way) => (gone.has(way.target) ? connect(q, way.id, "") : q), p))
        // A path that only went to a removed one now ends.
        .map((p) => (p.next.type === "goto" && !p.next.path ? { ...p, next: { type: "end" as const } } : p));
      const layout = { ...d.layout };
      for (const g of gone) delete layout[g];
      return { ...d, definition: { ...d.definition, paths }, layout };
    });
    setSelected("trigger");
  };

  /* The canvas: cards and lines come from the draft; React Flow's own measurements, a card being
     dragged and the selected lines are all that's kept beside it. */
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [moving, setMoving] = useState<Record<string, { x: number; y: number }>>({});
  const [lines, setLines] = useState<ReadonlySet<string>>(new Set());
  const nodes = useMemo((): Node[] => {
    const place = (id: string, fallback: { x: number; y: number }) => moving[id] ?? draft.layout[id] ?? fallback;
    return [
      {
        id: "trigger",
        type: "trigger",
        position: place("trigger", { x: 0, y: 0 }),
        measured: measured.trigger,
        deletable: false,
        selected: selected === "trigger",
        data: { label: TRIGGERS[def.trigger.type]?.label ?? "Choose a trigger", who: describeGroup(def.when, o), estimate: estimateLine } satisfies TriggerData,
        ariaLabel: "Trigger",
      },
      ...def.paths.map((p, i) => ({
        id: p.id,
        type: "path",
        position: place(p.id, { x: 380, y: 0 }),
        measured: measured[p.id],
        selected: selected === p.id,
        data: { path: p, start: i === 0, steps: p.steps.map((s) => describeStep(s, o)), flagged: flagged.has(p.id) } satisfies PathData,
        ariaLabel: `Path ${p.id}${p.label ? `, ${p.label}` : ""}`,
      })),
    ];
  }, [draft.layout, def, moving, measured, selected, o, estimateLine, flagged]);
  const edges = useMemo((): Edge[] => {
    const out: Edge[] = def.paths.length
      ? [{ id: "trigger:start", source: "trigger", sourceHandle: "start", target: def.paths[0].id, deletable: false, className: "pg-wf-edge" }]
      : [];
    for (const p of def.paths)
      for (const way of outlets(p))
        if (way.target && def.paths.some((q) => q.id === way.target))
          out.push({
            id: `${p.id}:${way.id}`,
            source: p.id,
            sourceHandle: way.id,
            target: way.target,
            // The card names each way on beside its handle; the line stays clean.
            ariaLabel: `Path ${p.id}, ${way.label}, to path ${way.target}`,
            className: "pg-wf-edge",
            type: "smoothstep",
          });
    return out.map((e) => ({ ...e, selected: lines.has(e.id) }));
  }, [def.paths, lines]);

  const onNodesChange = (changes: NodeChange[]) => {
    for (const c of changes) {
      if (c.type === "dimensions" && c.dimensions) {
        const size = c.dimensions;
        setMeasured((m) => (m[c.id]?.width === size.width && m[c.id]?.height === size.height ? m : { ...m, [c.id]: size }));
      }
      if (c.type === "position" && c.position && c.dragging) {
        const at = c.position;
        setMoving((m) => ({ ...m, [c.id]: at }));
      }
      if (c.type === "select" && c.selected) setSelected(c.id);
    }
  };
  const onEdgesChange = (changes: EdgeChange[]) =>
    setLines((now) => {
      const next = new Set(now);
      for (const c of changes) if (c.type === "select") void (c.selected ? next.add(c.id) : next.delete(c.id));
      return next;
    });
  const onConnect = (c: Connection) => {
    if (!c.target || c.target === "trigger") return;
    if (c.source === "trigger") {
      // The trigger leads to the first path: connecting it elsewhere makes that one the start.
      setDef({ ...def, paths: [...def.paths.filter((p) => p.id === c.target), ...def.paths.filter((p) => p.id !== c.target)] });
      return;
    }
    if (c.source === c.target) {
      setError("A path can't lead back to itself.");
      return;
    }
    setPath(c.source, (p) => connect(p, c.sourceHandle ?? "next", c.target));
  };
  const onConnectEnd = (event: MouseEvent | TouchEvent, s: FinalConnectionState) => {
    // Dropped on empty canvas: a new path there, connected.
    if (s.isValid || !s.fromNode || s.fromNode.id === "trigger" || s.toNode) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    addPath(flow.screenToFlowPosition({ x: point.clientX, y: point.clientY }), { node: s.fromNode.id, handle: s.fromHandle?.id ?? "next" });
  };

  /* Keys: undo and redo outside fields (fields keep their own). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input,textarea,select,[contenteditable=true]")) return;
      if (t && t !== document.body && !t.closest(".pg-wf-builder")) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);
  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /* Saving and publishing */
  const apply = (d: Detail) => {
    setDetail(d);
    const next = fromDetail(d);
    setSaved(next);
    history.replace(next);
  };
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (e instanceof InboxError && e.code === "WORKFLOW_CHANGED") setConflict(true);
      setError(errorText(e, "That didn't work."));
    } finally {
      setBusy("");
    }
  };
  const save = async () => {
    const d = await api<Detail>("workflow", { action: "save", id: w.id, version: w.version, name: draft.name, definition: draft.definition, layout: draft.layout });
    apply(d);
    return d;
  };
  const publish = () =>
    run("Publishing…", async () => {
      const version = dirty ? (await save()).workflow.version : w.version;
      apply(await api<Detail>("workflow", { action: "publish", id: w.id, version }));
    });
  const act = (action: "pause" | "resume") => run(action === "pause" ? "Pausing…" : "Resuming…", async () => apply(await api<Detail>("workflow", { action, id: w.id, version: w.version })));
  const rollback = (to: number) =>
    run("Restoring…", async () => {
      apply(await api<Detail>("workflow", { action: "rollback", id: w.id, version: w.version, to }));
      setPanel("edit");
    });
  const [confirm, setConfirm] = useState<string | null>(null);

  /* Bottom bar: zoom and the list of paths */
  const viewport = useViewport();
  const [listOpen, setListOpen] = useState(false);
  const focusPath = (pid: string) => {
    setSelected(pid);
    setListOpen(false);
    const p = draft.layout[pid];
    if (p) void flow.setCenter(p.x + 140, p.y + 80, { zoom: Math.max(viewport.zoom, 0.8), duration: 300 });
  };
  const tidy = () => {
    change((d) => ({ ...d, layout: autoLayout(d.definition) }));
    setTimeout(() => void flow.fitView({ duration: 300, padding: 0.2 }), 50);
  };

  const current = selected === "trigger" ? null : def.paths.find((p) => p.id === selected);
  const status = busy || (dirty ? "Unsaved changes" : w.changed && w.liveVersion ? "Saved; not yet published" : w.liveVersion ? `Version ${w.liveVersion} is live` : "Saved as a draft");
  return (
    <section className="pg-wf-builder" aria-label={`Workflow ${draft.name}`}>
      <header className="pg-wf-bar">
        <button type="button" className="pg-zoe-secondary" onClick={() => (dirty && !window.confirm("Leave without saving your changes?") ? null : onBack())}>
          <ArrowLeft size={14} aria-hidden="true" /> Workflows
        </button>
        <input className="pg-wf-name" aria-label="Workflow name" maxLength={80} value={draft.name} onChange={(e) => change((d) => ({ ...d, name: e.target.value }), "name")} />
        <span className="pg-wf-state" data-state={w.state}>
          {STATE_NAMES[w.state]}
        </span>
        <span role="status" className="pg-muted pg-wf-status">
          {status}
        </span>
        <span className="pg-wf-bar-tools">
          <button type="button" className="pg-wf-icon" aria-label="Undo" title="Undo (⌘Z)" disabled={!history.canUndo} onClick={history.undo}>
            <Undo2 size={16} aria-hidden="true" />
          </button>
          <button type="button" className="pg-wf-icon" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!history.canRedo} onClick={history.redo}>
            <Redo2 size={16} aria-hidden="true" />
          </button>
          <button type="button" className="pg-zoe-secondary" aria-pressed={panel === "versions"} onClick={() => setPanel(panel === "versions" ? "edit" : "versions")}>
            <History size={14} aria-hidden="true" /> Versions
          </button>
          {w.state === "live" && (
            <button type="button" className="pg-zoe-secondary" disabled={!!busy} onClick={() => void act("pause")}>
              <Pause size={14} aria-hidden="true" /> Pause
            </button>
          )}
          {w.state === "paused" && (
            <button type="button" className="pg-zoe-secondary" disabled={!!busy} onClick={() => void act("resume")}>
              <Play size={14} aria-hidden="true" /> Resume
            </button>
          )}
          <button
            type="button"
            className="pg-zoe-secondary"
            disabled={!!busy}
            onClick={() =>
              window.confirm(`Archive ${w.name}? It stops running; its versions and runs are kept.`) &&
              void run("Archiving…", async () => {
                await api("workflow", { action: "archive", id: w.id, version: w.version });
                onBack();
              })
            }
          >
            <Archive size={14} aria-hidden="true" /> Archive
          </button>
          <button type="button" className="pg-zoe-secondary" disabled={!dirty || !!busy} onClick={() => void run("Saving…", async () => void (await save()))}>
            <Save size={14} aria-hidden="true" /> Save draft
          </button>
          <button
            type="button"
            className="pg-primary"
            disabled={!!busy || blockers.length > 0 || (!dirty && !w.changed && w.liveVersion !== null)}
            aria-describedby={blockers.length ? "pg-wf-blockers" : undefined}
            onClick={() => void publish()}
          >
            <Rocket size={14} aria-hidden="true" /> {w.liveVersion ? "Publish changes" : "Publish"}
          </button>
        </span>
      </header>
      {error && (
        <p role="alert" className="pg-attr-error pg-wf-error">
          {error}
          {conflict && (
            <button
              type="button"
              className="pg-zoe-secondary"
              onClick={() =>
                void api<Detail>(`workflows?id=${encodeURIComponent(w.id)}`).then((d) => {
                  apply(d);
                  setConflict(false);
                  setError("");
                })
              }
            >
              Reload
            </button>
          )}
        </p>
      )}
      <div className="pg-wf-body">
        <div className="pg-wf-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            onNodeDragStop={(_, __, moved) => {
              change((d) => ({ ...d, layout: { ...d.layout, ...Object.fromEntries(moved.map((n) => [n.id, { x: Math.round(n.position.x), y: Math.round(n.position.y) }])) } }));
              setMoving({});
            }}
            onNodesDelete={(gone) => removePaths(gone.map((n) => n.id))}
            onEdgesDelete={(gone) =>
              change((d) => ({
                ...d,
                definition: {
                  ...d.definition,
                  paths: d.definition.paths.map((p) => gone.filter((e) => e.source === p.id).reduce((q, e) => connect(q, e.sourceHandle ?? "next", ""), p)),
                },
              }))
            }
            onPaneClick={() => setSelected("trigger")}
            deleteKeyCode={["Backspace", "Delete"]}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.2}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
            aria-label="Workflow canvas"
          >
            <Background gap={20} size={1} className="pg-wf-dots" />
          </ReactFlow>
          {blockers.length > 0 && (
            <div className="pg-wf-blockers" id="pg-wf-blockers">
              <strong>
                <AlertTriangle size={14} aria-hidden="true" /> {blockers.length === 1 ? "1 problem blocks" : `${blockers.length} problems block`} publishing
              </strong>
              <ul>
                {blockers.map((b, i) => (
                  <li key={i}>
                    {pathOf(b) ? (
                      <button type="button" className="pg-wf-link" onClick={() => focusPath(pathOf(b)!)}>
                        {b}
                      </button>
                    ) : (
                      b
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="pg-wf-zoombar" role="toolbar" aria-label="Canvas">
            <button type="button" className="pg-wf-tool" aria-expanded={listOpen} onClick={() => setListOpen(!listOpen)}>
              <List size={14} aria-hidden="true" /> List of paths
            </button>
            <button type="button" className="pg-wf-icon" aria-label="Zoom out" onClick={() => void flow.zoomOut({ duration: 150 })}>
              <Minus size={14} aria-hidden="true" />
            </button>
            <span className="pg-wf-zoom" aria-label="Zoom">
              {Math.round(viewport.zoom * 100)}%
            </span>
            <button type="button" className="pg-wf-icon" aria-label="Zoom in" onClick={() => void flow.zoomIn({ duration: 150 })}>
              <Plus size={14} aria-hidden="true" />
            </button>
            <button type="button" className="pg-wf-icon" aria-label="Fit to screen" title="Fit to screen" onClick={() => void flow.fitView({ duration: 300, padding: 0.2 })}>
              <Maximize size={14} aria-hidden="true" />
            </button>
            <button type="button" className="pg-wf-tool" onClick={tidy}>
              <Wand2 size={14} aria-hidden="true" /> Tidy up
            </button>
            <button type="button" className="pg-wf-tool" onClick={() => addPath()}>
              <Plus size={14} aria-hidden="true" /> Path
            </button>
            {listOpen && (
              <ul className="pg-wf-pathlist" aria-label="Paths">
                <li>
                  <button type="button" onClick={() => (setSelected("trigger"), setListOpen(false))}>
                    <Zap size={13} aria-hidden="true" /> Trigger
                  </button>
                </li>
                {def.paths.map((p, i) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => focusPath(p.id)}>
                      <span className="pg-wf-letter">{p.id}</span> {p.label || (i === 0 ? "Start" : `Path ${p.id}`)}
                      <span className="pg-muted"> · {p.steps.length === 1 ? "1 step" : `${p.steps.length} steps`}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <aside className="pg-wf-panel" aria-label={panel === "versions" ? "Versions" : current ? `Path ${current.id}` : "Trigger"}>
          {panel === "versions" ? (
            <Versions
              detail={detail}
              dirty={dirty}
              busy={!!busy}
              confirm={confirm}
              setConfirm={setConfirm}
              onRestore={(v) => void rollback(v)}
            />
          ) : current ? (
            <PathPanel
              key={current.id}
              path={current}
              def={def}
              o={o}
              start={def.paths[0].id === current.id}
              onChange={(fn, group) => setPath(current.id, fn, group)}
              onRemove={def.paths.length > 1 ? () => removePaths([current.id]) : undefined}
              onSelect={focusPath}
              onAdd={(handle) => addPath(undefined, { node: current.id, handle })}
            />
          ) : (
            <TriggerPanel def={def} o={o} onChange={setDef} estimate={estimate} estimateError={estimateError} />
          )}
        </aside>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Panels                                                                                      */

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <section className="pg-wf-section">
      <h3>{title}</h3>
      {hint && <p className="pg-muted pg-wf-hint">{hint}</p>}
      {children}
    </section>
  );
}

function TriggerPanel({
  def,
  o,
  onChange,
  estimate,
  estimateError,
}: {
  def: Definition;
  o: Options;
  onChange: (d: Definition, group?: string | null) => void;
  estimate: Estimate | null;
  estimateError: string;
}) {
  const t = def.trigger;
  const setTrigger = (type: Trigger) => onChange({ ...def, trigger: { type, options: {} } });
  const setOption = (k: "tagId" | "attributeId" | "key", v: string) => {
    const options = { ...t.options };
    if (v) options[k] = v;
    else delete options[k];
    onChange({ ...def, trigger: { ...t, options } }, k === "key" ? "trigger-key" : null);
  };
  return (
    <>
      <Section title="Trigger" hint={TRIGGERS[t.type]?.firedBy}>
        <select aria-label="What starts it" value={t.type} onChange={(e) => setTrigger(e.target.value as Trigger)}>
          {(Object.keys(TRIGGERS) as Trigger[]).map((k) => (
            <option key={k} value={k}>
              {TRIGGERS[k].label}
            </option>
          ))}
          <optgroup label="Arriving later">
            {Object.entries(LATER_TRIGGERS).map(([k, when]) => (
              <option key={k} value={k} disabled>
                {k.replace(/_/g, " ")} ({when})
              </option>
            ))}
          </optgroup>
        </select>
        {t.type === "tagged" && (
          <select aria-label="Which tag" value={t.options.tagId ?? ""} onChange={(e) => setOption("tagId", e.target.value)}>
            <option value="">Any tag</option>
            {o.tags.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        )}
        {t.type === "attribute_changed" && (
          <select aria-label="Which attribute" value={t.options.attributeId ?? ""} onChange={(e) => setOption("attributeId", e.target.value)}>
            <option value="">Any attribute</option>
            {o.attributes.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        )}
        {t.type === "contact_attribute_changed" && (
          <input aria-label="Which customer attribute" placeholder="plan" value={t.options.key ?? ""} onChange={(e) => setOption("key", e.target.value)} />
        )}
        {TRIGGERS[t.type]?.customer && (
          <p className="pg-muted pg-wf-hint">For this trigger, only the highest-priority customer-facing workflow that matches runs; background workflows all run.</p>
        )}
      </Section>
      <Section title="Who it runs for">
        <GroupEditor group={def.when} onChange={(when: Group) => onChange({ ...def, when }, "when")} o={o} label="Who it runs for" />
        <p className="pg-wf-estimate" role="status">
          {estimate
            ? estimate.sample
              ? `It would have run for ${estimate.assumed.length ? "at most " : ""}${estimate.matched} of the last ${estimate.sample} conversations (${Math.round((estimate.matched / estimate.sample) * 100)}%) from the past ${estimate.days} days.`
              : `There are no conversations from the past ${estimate.days} days to estimate from.`
            : estimateError || "Estimating…"}
          {estimate && estimate.assumed.length > 0 && (
            <span className="pg-muted"> {estimate.assumed.join(", ")} depend on the moment a run starts, so they&apos;re taken to hold.</span>
          )}
        </p>
      </Section>
    </>
  );
}

function PathPanel({
  path,
  def,
  o,
  start,
  onChange,
  onRemove,
  onSelect,
  onAdd,
}: {
  path: Path;
  def: Definition;
  o: Options;
  start: boolean;
  onChange: (fn: (p: Path) => Path, group?: string | null) => void;
  onRemove?: () => void;
  onSelect: (id: string) => void;
  onAdd: (handle: string) => void;
}) {
  const others = def.paths.filter((p) => p.id !== path.id);
  const n = path.next;
  const target = (label: string, value: string, set: (v: string) => void, handle: string) => (
    <span className="pg-wf-inline">
      <select aria-label={label} value={value} onChange={(e) => (e.target.value === "+" ? onAdd(handle) : set(e.target.value))}>
        <option value="">Choose a path…</option>
        {others.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id}
            {p.label ? ` · ${p.label}` : ""}
          </option>
        ))}
        <option value="+">New path</option>
      </select>
      {value && (
        <button type="button" className="pg-wf-link" onClick={() => onSelect(value)}>
          Open {value}
        </button>
      )}
    </span>
  );
  const setNextType = (type: Next["type"]) =>
    onChange((p) => ({
      ...p,
      next:
        type === "end"
          ? { type: "end" }
          : type === "goto"
            ? { type: "goto", path: "" }
            : type === "branch"
              ? { type: "branch", branches: [{ label: "Branch 1", when: { match: "all", items: [] }, path: "" }], else: "" }
              : { type: "wait_until", when: { match: "all", items: [] }, timeoutSeconds: 86_400, met: "", timedOut: "" },
    }));
  return (
    <>
      <Section title={`Path ${path.id}${start ? " (where runs start)" : ""}`}>
        <input aria-label="Path name" placeholder={start ? "Start" : `Path ${path.id}`} maxLength={60} value={path.label} onChange={(e) => onChange((p) => ({ ...p, label: e.target.value }), "label")} />
      </Section>
      <Section title="Steps" hint="Taken in order.">
        <StepsEditor steps={path.steps} o={o} max={MAX_STEPS} onChange={(steps) => onChange((p) => ({ ...p, steps }), `steps`)} />
      </Section>
      <Section title="Then">
        <select aria-label="What happens after its steps" value={n.type} onChange={(e) => setNextType(e.target.value as Next["type"])}>
          {NEXT_TYPES.map((x) => (
            <option key={x.type} value={x.type}>
              {x.label}
            </option>
          ))}
        </select>
        {n.type === "goto" && target("Go to", n.path, (v) => onChange((p) => ({ ...p, next: { type: "goto", path: v } })), "next")}
        {n.type === "branch" && (
          <>
            <p className="pg-muted pg-wf-hint">The first branch whose conditions hold is taken; otherwise Else.</p>
            <ol className="pg-wf-branches">
              {n.branches.map((b, i) => {
                const setB = (fn: (x: typeof b) => typeof b, group: string | null = null) =>
                  onChange((p) => (p.next.type === "branch" ? { ...p, next: { ...p.next, branches: p.next.branches.map((y, j) => (j === i ? fn(y) : y)) } } : p), group);
                return (
                  <li key={i} className="pg-wf-branch">
                    <div className="pg-wf-step-head">
                      <input aria-label={`Branch ${i + 1} name`} maxLength={60} value={b.label} onChange={(e) => setB((x) => ({ ...x, label: e.target.value }), `branch-${i}`)} />
                      <button
                        type="button"
                        className="pg-wf-icon"
                        aria-label={`Remove branch ${i + 1}`}
                        title="Remove branch"
                        disabled={n.branches.length === 1}
                        onClick={() => onChange((p) => (p.next.type === "branch" ? { ...p, next: { ...p.next, branches: p.next.branches.filter((_, j) => j !== i) } } : p))}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                    <GroupEditor group={b.when} o={o} label={`Branch ${i + 1}`} onChange={(when) => setB((x) => ({ ...x, when }), `branch-when-${i}`)} />
                    {target(`Branch ${i + 1} goes to`, b.path, (v) => setB((x) => ({ ...x, path: v })), "b" + i)}
                  </li>
                );
              })}
            </ol>
            {n.branches.length < 10 && (
              <button
                type="button"
                className="pg-zoe-secondary"
                onClick={() =>
                  onChange((p) =>
                    p.next.type === "branch"
                      ? { ...p, next: { ...p.next, branches: [...p.next.branches, { label: `Branch ${p.next.branches.length + 1}`, when: { match: "all", items: [] }, path: "" }] } }
                      : p,
                  )
                }
              >
                <Plus size={14} aria-hidden="true" /> Branch
              </button>
            )}
            <div className="pg-wf-else">
              <strong>Else</strong> {target("Else goes to", n.else, (v) => onChange((p) => (p.next.type === "branch" ? { ...p, next: { ...p.next, else: v } } : p)), "else")}
            </div>
          </>
        )}
        {n.type === "wait_until" && (
          <>
            <GroupEditor group={n.when} o={o} label="Wait until" onChange={(when) => onChange((p) => (p.next.type === "wait_until" ? { ...p, next: { ...p.next, when } } : p), "wait-when")} />
            <div className="pg-wf-else">
              <strong>For at most</strong>
              <Duration
                label="Wait at most"
                value={n.timeoutSeconds}
                onChange={(s) => onChange((p) => (p.next.type === "wait_until" ? { ...p, next: { ...p.next, timeoutSeconds: s } } : p), "timeout")}
              />
            </div>
            <div className="pg-wf-else">
              <strong>When it holds</strong> {target("When it holds, go to", n.met, (v) => onChange((p) => (p.next.type === "wait_until" ? { ...p, next: { ...p.next, met: v } } : p)), "met")}
            </div>
            <div className="pg-wf-else">
              <strong>If it times out</strong>{" "}
              {target("If it times out, go to", n.timedOut, (v) => onChange((p) => (p.next.type === "wait_until" ? { ...p, next: { ...p.next, timedOut: v } } : p)), "timedOut")}
            </div>
          </>
        )}
      </Section>
      {onRemove && (
        <button type="button" className="pg-zoe-secondary pg-wf-danger" onClick={onRemove}>
          <Trash2 size={14} aria-hidden="true" /> Delete path {path.id}
        </button>
      )}
    </>
  );
}

function Versions({
  detail,
  dirty,
  busy,
  confirm,
  setConfirm,
  onRestore,
}: {
  detail: Detail;
  dirty: boolean;
  busy: boolean;
  confirm: string | null;
  setConfirm: (v: string | null) => void;
  onRestore: (version: number) => void;
}) {
  const w = detail.workflow;
  return (
    <Section
      title="Versions"
      hint="Each publish is kept. Restoring publishes that version again as the next one; runs already going finish on the version they started with."
    >
      {detail.versions.length ? (
        <ol className="pg-wf-versions">
          {detail.versions.map((v) => (
            <li key={v.version}>
              <div>
                <strong>Version {v.version}</strong>
                {v.version === w.liveVersion && <span className="pg-wf-state" data-state={w.state}>{w.state === "paused" ? "Paused" : "Live"}</span>}
                <div className="pg-muted">
                  {v.by ?? "Someone"}, {ago(v.publishedAt)}
                  {v.restoredFrom ? ` · restored from version ${v.restoredFrom}` : ""}
                </div>
              </div>
              {v.version !== w.liveVersion &&
                (confirm === String(v.version) ? (
                  <span className="pg-wf-inline">
                    <button type="button" className="pg-primary" disabled={busy} onClick={() => (setConfirm(null), onRestore(v.version))}>
                      Restore {v.version}
                    </button>
                    <button type="button" className="pg-zoe-secondary" onClick={() => setConfirm(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button type="button" className="pg-zoe-secondary" disabled={busy} onClick={() => setConfirm(String(v.version))}>
                    Restore
                  </button>
                ))}
            </li>
          ))}
        </ol>
      ) : (
        <p className="pg-muted">Nothing published yet.</p>
      )}
      {dirty && confirm && <p className="pg-attr-error">Restoring replaces your unsaved changes.</p>}
      <p className="pg-muted">
        Last saved by {w.updatedBy ?? "someone"}, {ago(w.updatedAt)}.
      </p>
    </Section>
  );
}

