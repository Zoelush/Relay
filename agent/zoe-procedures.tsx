import { useEffect, useState } from "react";
import { ArrowLeft, ListChecks, Plus, Trash2 } from "lucide-react";
import { api } from "./api";
import type { SideMenuState } from "./shell";
import { Card, Frame, message, type Page } from "./settings-ui";
import { ConditionRows, useAiSettings, type Condition } from "./settings-ai";
import { ago } from "./zoe-labels";
import { blankSource, type ProcedureInput, type Source } from "../lib/procedure-plan";

/**
 * Train › Procedures (phase 09, step D2; docs/ACTIONS_STEP2.md), while `ai_actions_v1` is on. A
 * procedure is written as numbered steps, shown compiled (the fixed plan Zoe follows) before it's
 * published; her verification rules decide who connectors may run for.
 */
type Summary = { id: string; name: string; description: string; keywords: string[]; liveVersion: number | null; changed: boolean };
type VRule = {
  id?: string;
  name: string;
  enabled: boolean;
  match: "all" | "any";
  conditions: Condition[];
  requirement: "signed_in" | "none";
};
type ListData = {
  procedures: Summary[];
  verification: { rules: VRule[]; fallback: "signed_in" | "none" };
  runs: { id: string; conversationId: string; procedure: string; version: number; status: string; reason: string; startedAt: string }[];
};
type Detail = {
  procedure: { id: string; name: string; version: string; source: Source; liveVersion: number | null; changed: boolean };
  compiled: { steps: string[]; error: string | null };
  connectors: { name: string; asks: string[]; outputs: string[] }[];
  versions: { version: number; publishedAt: string; by: string | null }[];
};
const RUN_NAMES: Record<string, [string, string]> = {
  waiting: ["Waiting for the customer", "sky"],
  resolved: ["Resolved", "green"],
  escalated: ["Handed over", "rose"],
  abandoned: ["Stopped", "slate"],
};

export function ProceduresPage({ menu, page }: { menu: SideMenuState; page: Page }) {
  const [data, setData] = useState<ListData | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open)
      api<ListData>("zoe?view=procedures")
        .then(setData)
        .catch((e) => setError(message(e, "This page could not be loaded.")));
  }, [open]);
  if (open)
    return (
      <Frame menu={menu} page={page} wide>
        <ProcedureEditor id={open} onBack={() => setOpen(null)} />
      </Frame>
    );
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <form
        className="pg-zoe-connector-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const d = await api<Detail>("zoe-procedure", { action: "create", name });
            setName("");
            setOpen(d.procedure.id);
          } catch (err) {
            setError(message(err, "The procedure could not be created."));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="pg-settings-field">
          <span>New procedure</span>
          <input value={name} maxLength={60} placeholder="Where's my order" onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" className="pg-zoe-primary" disabled={busy || !name.trim()}>
          <Plus size={14} aria-hidden="true" /> Create
        </button>
      </form>
      {data && (
        <>
          {data.procedures.length ? (
            <ul className="pg-zoe-monitors" aria-label="Procedures">
              {data.procedures.map((p) => (
                <li key={p.id} className="pg-zoe-monitor" aria-label={p.name}>
                  <header>
                    <ListChecks size={16} aria-hidden="true" />
                    <strong>{p.name}</strong>
                    <span className="pg-zoe-review-why" data-hue={p.liveVersion ? "green" : "slate"}>
                      {p.liveVersion ? `Live, version ${p.liveVersion}` : "Not published"}
                    </span>
                    {p.liveVersion && p.changed && (
                      <span className="pg-zoe-review-why" data-hue="amber">
                        Unpublished changes
                      </span>
                    )}
                  </header>
                  {p.description && <p className="pg-muted">{p.description}</p>}
                  <div className="pg-zoe-review-actions">
                    <small className="pg-muted">
                      {p.keywords.length ? `Starts on: ${p.keywords.join(", ")}` : "No keywords yet"}
                    </small>
                    <button type="button" className="pg-zoe-secondary" onClick={() => setOpen(p.id)}>
                      Open
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pg-zoe-empty">
              No procedures yet. A procedure is a task Zoe carries out step by step, like finding an
              order, using your connectors.
            </p>
          )}
          <Verification initial={data.verification} onSaved={(v) => setData((d) => d && { ...d, verification: v })} />
          <Card title="Recent runs" description="Procedures Zoe ran in conversations, and how each ended.">
            {data.runs.length ? (
              <ul className="pg-settings-list" aria-label="Recent runs">
                {data.runs.map((r) => (
                  <li key={r.id}>
                    <span>
                      <strong>
                        {r.procedure} <small className="pg-muted">version {r.version}</small>
                      </strong>
                      <small className="pg-muted">
                        {ago(r.startedAt)} · conversation {r.conversationId} · {r.reason}
                      </small>
                    </span>
                    <span className="pg-zoe-review-why" data-hue={RUN_NAMES[r.status]?.[1] ?? "slate"}>
                      {RUN_NAMES[r.status]?.[0] ?? r.status}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pg-zoe-empty">None yet.</p>
            )}
          </Card>
        </>
      )}
    </Frame>
  );
}

function Verification({
  initial,
  onSaved,
}: {
  initial: ListData["verification"];
  onSaved: (v: ListData["verification"]) => void;
}) {
  const ai = useAiSettings();
  const [rules, setRules] = useState(initial.rules);
  const [fallback, setFallback] = useState(initial.fallback);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const dirty = JSON.stringify(rules) !== JSON.stringify(initial.rules) || fallback !== initial.fallback;
  const change = (i: number, c: Partial<VRule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...c } : r)));
  return (
    <Card
      title="Verification"
      description="Who connectors may run for. Checked before every look-up, in order; the first rule that matches decides, otherwise the fallback. Signed in means your website verified who they are."
    >
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <p role="status" className="pg-muted pg-zoe-review-status">
        {status}
      </p>
      {ai.data &&
        rules.map((r, i) => (
          <fieldset key={r.id ?? i} className="pg-settings-fieldset" aria-label={`Verification rule ${i + 1}`}>
            <legend>Rule {i + 1}, on the messenger</legend>
            <div className="pg-settings-row">
              <input
                aria-label={`Verification rule ${i + 1} name`}
                maxLength={120}
                placeholder="Visitors"
                value={r.name}
                onChange={(e) => change(i, { name: e.target.value })}
              />
              <select aria-label={`Verification rule ${i + 1} needs`} value={r.match} onChange={(e) => change(i, { match: e.target.value as VRule["match"] })}>
                <option value="all">All of these</option>
                <option value="any">Any of these</option>
              </select>
              <select
                aria-label={`Verification rule ${i + 1} requires`}
                value={r.requirement}
                onChange={(e) => change(i, { requirement: e.target.value as VRule["requirement"] })}
              >
                <option value="signed_in">Requires a signed-in customer</option>
                <option value="none">Anyone</option>
              </select>
              <button type="button" className="pg-link-button" aria-label={`Remove verification rule ${i + 1}`} onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
            <ConditionRows
              label={`Verification rule ${i + 1}`}
              conditions={r.conditions}
              choices={ai.data!.choices}
              onChange={(conditions) => change(i, { conditions })}
            />
          </fieldset>
        ))}
      <div className="pg-zoe-review-actions">
        <button
          type="button"
          className="pg-zoe-secondary"
          onClick={() =>
            setRules((rs) => [
              ...rs,
              { name: "", enabled: true, match: "all", conditions: [{ field: "signed_in", op: "is", value: false } as Condition], requirement: "none" },
            ])
          }
        >
          <Plus size={14} aria-hidden="true" /> Add a rule
        </button>
        <label className="pg-settings-inline">
          Otherwise
          <select aria-label="Verification fallback" value={fallback} onChange={(e) => setFallback(e.target.value as VRule["requirement"])}>
            <option value="signed_in">Require a signed-in customer</option>
            <option value="none">Anyone</option>
          </select>
        </label>
        <button
          type="button"
          className="pg-zoe-primary"
          disabled={busy || !dirty}
          onClick={async () => {
            setBusy(true);
            setError("");
            setStatus("");
            try {
              const d = await api<ListData>("zoe-procedure", { action: "verification", rules, fallback });
              setRules(d.verification.rules);
              setFallback(d.verification.fallback);
              onSaved(d.verification);
              setStatus("Verification saved.");
            } catch (e) {
              setError(message(e, "Verification could not be saved."));
            } finally {
              setBusy(false);
            }
          }}
        >
          Save verification
        </button>
      </div>
    </Card>
  );
}

function ProcedureEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [name, setName] = useState("");
  const [source, setSource] = useState<Source>(blankSource());
  const [keywords, setKeywords] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const show = (d: Detail) => {
    setData(d);
    setName(d.procedure.name);
    setSource(d.procedure.source);
    setKeywords(d.procedure.source.keywords.join(", "));
  };
  useEffect(() => {
    api<Detail>(`zoe?view=procedure&id=${encodeURIComponent(id)}`)
      .then((d) => {
        setData(d);
        setName(d.procedure.name);
        setSource(d.procedure.source);
        setKeywords(d.procedure.source.keywords.join(", "));
      })
      .catch((e) => setError(message(e, "This procedure could not be loaded.")));
  }, [id]);
  if (!data)
    return error ? (
      <p role="alert" className="pg-attr-error">
        {error}
      </p>
    ) : null;
  const p = data.procedure;
  const draft: Source = {
    ...source,
    keywords: keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  };
  const dirty = name !== p.name || JSON.stringify(draft) !== JSON.stringify(p.source);
  async function change(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const d = await api<Detail>("zoe-procedure", { id, ...body });
      if (body.action === "archive") return onBack();
      show(d);
      setStatus(done);
    } catch (e) {
      setError(message(e, "That could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  const setInput = (i: number, c: Partial<ProcedureInput>) =>
    setSource((s) => ({ ...s, inputs: s.inputs.map((x, j) => (j === i ? { ...x, ...c } : x)) }));
  return (
    <section className="pg-zoe-connector" aria-label={`Procedure ${p.name}`}>
      <div className="pg-zoe-review-actions">
        <button type="button" className="pg-link-button" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" /> All procedures
        </button>
      </div>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <p role="status" className="pg-muted pg-zoe-review-status">
        {status}
      </p>
      <header className="pg-zoe-connector-head">
        <label className="pg-settings-field">
          <span>Name</span>
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <span className="pg-zoe-review-why" data-hue={p.liveVersion ? "green" : "slate"}>
          {p.liveVersion ? `Live, version ${p.liveVersion}` : "Not published"}
        </span>
        <div className="pg-zoe-review-actions">
          <button
            type="button"
            className="pg-zoe-secondary"
            disabled={busy || !dirty}
            onClick={() => void change({ action: "save", version: p.version, name, source: draft }, "Draft saved.")}
          >
            Save draft
          </button>
          <button
            type="button"
            className="pg-zoe-primary"
            disabled={busy || dirty || !p.changed || !!data.compiled.error}
            title={dirty ? "Save the draft first" : data.compiled.error ?? undefined}
            onClick={() => void change({ action: "publish", version: p.version }, "Published.")}
          >
            Publish
          </button>
          <button
            type="button"
            className="pg-zoe-secondary"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Archive ${p.name}? Runs waiting in conversations stop.`))
                void change({ action: "archive", version: p.version }, "Archived.");
            }}
          >
            Archive
          </button>
        </div>
      </header>

      <Card title="When it starts" description="Words or phrases in a customer's message that start it, checked in code. Separate them with commas.">
        <input aria-label="Keywords" value={keywords} placeholder="where is my order, order status" onChange={(e) => setKeywords(e.target.value)} />
        <textarea
          aria-label="What it's for"
          rows={2}
          maxLength={500}
          placeholder="Tells customers where their order is."
          value={source.description}
          onChange={(e) => setSource((s) => ({ ...s, description: e.target.value }))}
        />
      </Card>

      <Card
        title="What to collect"
        description="What she must have before the steps that need it. With a pattern, she finds the value inside a longer message (and in the first one)."
      >
        {source.inputs.length > 0 && (
          <table className="pg-zoe-rows" aria-label="What to collect">
            <thead>
              <tr>
                <th>Name</th>
                <th>Label</th>
                <th>Question she asks</th>
                <th>Pattern</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {source.inputs.map((x, i) => (
                <tr key={i}>
                  <td>
                    <input aria-label="Collect name" value={x.name} placeholder="order_id" onChange={(e) => setInput(i, { name: e.target.value })} />
                  </td>
                  <td>
                    <input aria-label="Collect label" value={x.label} placeholder="Order number" onChange={(e) => setInput(i, { label: e.target.value })} />
                  </td>
                  <td>
                    <input aria-label="Collect question" value={x.question} placeholder="What's your order number?" onChange={(e) => setInput(i, { question: e.target.value })} />
                  </td>
                  <td>
                    <input aria-label="Collect pattern" value={x.pattern} placeholder="[A-Z]\d{4}" onChange={(e) => setInput(i, { pattern: e.target.value })} />
                  </td>
                  <td>
                    <button type="button" className="pg-link-button" aria-label={`Remove row ${i + 1}`} onClick={() => setSource((s) => ({ ...s, inputs: s.inputs.filter((_, j) => j !== i) }))}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <button
          type="button"
          className="pg-zoe-secondary"
          onClick={() => setSource((s) => ({ ...s, inputs: [...s.inputs, { name: "", label: "", question: "", pattern: "" }] }))}
        >
          <Plus size={14} aria-hidden="true" /> Add something to collect
        </button>
      </Card>

      <div className="pg-zoe-split">
        <Card
          title="Steps"
          description="Numbered, one action each: Ask for <name>. Look up <connector>. If <value> is / is not / contains &quot;text&quot; (or is empty), go to step <n>. Say &quot;text with {{value}}&quot;. Go to step <n>. Resolve. Hand over. Stop."
        >
          <textarea
            aria-label="Procedure steps"
            className="pg-zoe-mono"
            rows={12}
            value={source.steps}
            onChange={(e) => setSource((s) => ({ ...s, steps: e.target.value }))}
          />
          <label className="pg-settings-field">
            <span>If a look-up fails, she says</span>
            <input
              value={source.onFailure}
              maxLength={500}
              placeholder="Sorry, I couldn't look that up just now."
              onChange={(e) => setSource((s) => ({ ...s, onFailure: e.target.value }))}
            />
          </label>
          <small className="pg-muted">Then she hands over to your team.</small>
        </Card>
        <Card title="What Zoe will do" description="The saved draft, compiled. This is the plan she follows; she never decides the steps herself.">
          {dirty && <p className="pg-muted">Save the draft to see your changes compiled.</p>}
          {data.compiled.error ? (
            <p role="alert" className="pg-attr-error">
              {data.compiled.error}
            </p>
          ) : (
            <ol className="pg-zoe-plan" aria-label="Compiled plan">
              {data.compiled.steps.map((s, i) => (
                <li key={i}>{s.replace(/^\d+\.\s*/, "")}</li>
              ))}
            </ol>
          )}
          <h4 className="pg-zoe-connector-sub">Published connectors</h4>
          {data.connectors.length ? (
            <ul className="pg-zoe-plan-connectors" aria-label="Published connectors">
              {data.connectors.map((c) => (
                <li key={c.name}>
                  <strong>{c.name}</strong>
                  <small className="pg-muted">
                    {c.asks.length ? `needs ${c.asks.join(", ")}` : "needs nothing from the customer"} · gives{" "}
                    {c.outputs.join(", ") || "nothing"}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pg-muted">None yet: publish one under Actions.</p>
          )}
        </Card>
      </div>

      <Card title="Versions" description="Published versions are never changed; a conversation keeps the one it started.">
        {data.versions.length ? (
          <ul className="pg-settings-list" aria-label="Versions">
            {data.versions.map((v) => (
              <li key={v.version}>
                <span>
                  <strong>Version {v.version}</strong>
                  <small className="pg-muted">
                    Published {ago(v.publishedAt)}
                    {v.by ? ` by ${v.by}` : ""}
                  </small>
                </span>
                {v.version === p.liveVersion && (
                  <span className="pg-zoe-review-why" data-hue="green">
                    Live
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="pg-zoe-empty">Not published yet.</p>
        )}
      </Card>
    </section>
  );
}
