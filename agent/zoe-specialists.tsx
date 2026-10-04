import { useEffect, useState } from "react";
import { Plus, Send, UsersRound } from "lucide-react";
import { api } from "./api";
import { Frame, message, type Page } from "./settings-ui";
import type { SideMenuState } from "./shell";
import { ZoeMark } from "./colour";
import { ConditionRows, fresh, type Condition } from "./settings-ai";
import { MAX_SPECIALIST_KEYWORDS } from "../lib/zoe-voice";
import { OUTCOME_HUES, OUTCOME_NAMES } from "./zoe-labels";
import { skippedWords, type PreviewResult } from "./zoe-guidance";

/**
 * Train › Specialists (phase 08, step Z3a; docs/AI_STEP7.md): narrower Zoes for one job each.
 * Each has what she handles (her instructions, and how Zoe picks her), keywords checked in code,
 * optional conditions (the escalation rules' list), her knowledge, and her handover team. Each
 * saves on its own; "Try it" beside them asks as Zoe would route it, or as one specialist,
 * unsaved changes included. Customers always see Zoe.
 */
type Choice = { id: string; name: string };
type Specialist = {
  id: string;
  name: string;
  handles: string;
  keywords: string[];
  match: "all" | "any";
  conditions: Condition[];
  knowledge: {
    all: boolean;
    collections: string[];
    websites: string[];
    snippets: boolean;
    files: boolean;
  };
  handoverTeamId: string | null;
  enabled: boolean;
  version: string;
  /** The guidelines that apply only when she answers. */
  guidance: string[];
};
type Data = {
  specialists: Specialist[];
  choices: {
    collections: (Choice & { center: string })[];
    websites: Choice[];
    teams: Choice[];
    brands: Choice[];
    tags: Choice[];
    attributes: Choice[];
  };
  max: number;
};
type Draft = Omit<Specialist, "id" | "version" | "guidance"> & {
  id?: string;
  version?: string;
  guidance?: string[];
};
const blank = (): Draft => ({
  name: "",
  handles: "",
  keywords: [],
  match: "all",
  conditions: [],
  knowledge: { all: true, collections: [], websites: [], snippets: false, files: false },
  handoverTeamId: null,
  enabled: true,
});
/** What's sent: the specialist without her page-only fields. */
const body = (d: Draft) => ({
  id: d.id,
  version: d.version,
  name: d.name,
  handles: d.handles,
  keywords: d.keywords,
  match: d.match,
  conditions: d.conditions,
  knowledge: d.knowledge,
  handoverTeamId: d.handoverTeamId,
  enabled: d.enabled,
});

export function SpecialistsPage({
  menu,
  page,
  name,
  onGuidance,
}: {
  menu: SideMenuState;
  page: Page;
  name: string;
  onGuidance: () => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    api<Data>("zoe?view=specialists")
      .then(setData)
      .catch((e) => setError(message(e, "This page could not be loaded.")));
  }, []);
  async function save(b: Record<string, unknown>, done: string) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      setData(await api<Data>("zoe-specialist", b));
      setEditing(null);
      setStatus(done);
    } catch (e) {
      setError(message(e, "The specialist could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  const saved = editing?.id ? data?.specialists.find((s) => s.id === editing.id) : undefined;
  const dirty =
    !!editing && JSON.stringify(body(editing)) !== JSON.stringify(saved ? body(saved) : body(blank()));
  return (
    <Frame menu={menu} page={page} wide>
      {data && (
        <div className="pg-zoe-split">
          <div className="pg-zoe-guidance-main">
            <div className="pg-zoe-specialists-bar">
              <span className="pg-zoe-count">
                {data.specialists.length} of {data.max}
              </span>
              <span role="status" className="pg-muted">
                {status}
              </span>
              <button
                type="button"
                className="pg-zoe-primary"
                disabled={!!editing || data.specialists.length >= data.max}
                onClick={() => {
                  setStatus("");
                  setEditing(blank());
                }}
              >
                <Plus size={14} aria-hidden="true" /> New specialist
              </button>
            </div>
            {error && (
              <p role="alert" className="pg-attr-error">
                {error}
              </p>
            )}
            {editing && !editing.id && (
              <Editor
                draft={editing}
                data={data}
                busy={busy}
                dirty={dirty}
                onChange={setEditing}
                onCancel={() => setEditing(null)}
                onSave={() => void save(body(editing), `${editing.name.trim()} is ready.`)}
              />
            )}
            {!data.specialists.length && !editing && (
              <section className="pg-zoe-empty-card" aria-label="No specialists yet">
                <span className="pg-settings-tile-icon" data-hue="blue" aria-hidden="true">
                  <UsersRound size={18} />
                </span>
                <strong>No specialists yet: {name} answers everything herself</strong>
                <p className="pg-muted">
                  Add one for a part of your business that needs its own knowledge or its own
                  team, such as Billing or Sales. Customers always see {name}.
                </p>
              </section>
            )}
            <ul className="pg-zoe-specialists" aria-label="Specialists">
              {data.specialists.map((s) =>
                editing?.id === s.id ? (
                  <li key={s.id}>
                    <Editor
                      draft={editing}
                      data={data}
                      busy={busy}
                      dirty={dirty}
                      onChange={setEditing}
                      onCancel={() => setEditing(null)}
                      onSave={() => void save(body(editing), `${editing.name.trim()} is saved.`)}
                      onRemove={() =>
                        void save({ id: s.id, version: s.version, remove: true }, `${s.name} is removed.`)
                      }
                      onGuidance={onGuidance}
                    />
                  </li>
                ) : (
                  <li key={s.id} className="pg-zoe-specialist" data-off={s.enabled ? undefined : "true"}>
                    <header>
                      <span className="pg-settings-tile-icon" data-hue="blue" aria-hidden="true">
                        <UsersRound size={16} />
                      </span>
                      <span>
                        <h3>{s.name}</h3>
                        <small className="pg-muted">{s.handles}</small>
                      </span>
                      <span className="pg-zoe-status" data-on={s.enabled ? "true" : "false"}>
                        {s.enabled ? "On" : "Off"}
                      </span>
                    </header>
                    <dl>
                      <dt>Picked by</dt>
                      <dd>
                        {s.keywords.length ? s.keywords.map((k) => `“${k}”`).join(", ") : "What she handles"}
                        {s.conditions.length
                          ? ` · only when ${s.conditions.length} ${s.conditions.length === 1 ? "condition holds" : `conditions hold (${s.match})`}`
                          : ""}
                      </dd>
                      <dt>Knowledge</dt>
                      <dd>{knowledgeSummary(s, data)}</dd>
                      <dt>Hands over to</dt>
                      <dd>
                        {data.choices.teams.find((t) => t.id === s.handoverTeamId)?.name ??
                          `${name}'s handover team`}
                      </dd>
                      {s.guidance.length > 0 && (
                        <>
                          <dt>Her guidance</dt>
                          <dd>{s.guidance.join(" · ")}</dd>
                        </>
                      )}
                    </dl>
                    <div className="pg-zoe-specialist-actions">
                      <button
                        type="button"
                        aria-label={`Edit ${s.name}`}
                        disabled={!!editing}
                        onClick={() => {
                          setStatus("");
                          setEditing({ ...s });
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        aria-label={`${s.enabled ? "Switch off" : "Switch on"} ${s.name}`}
                        disabled={!!editing || busy}
                        onClick={() =>
                          void save(
                            body({ ...s, enabled: !s.enabled }),
                            `${s.name} is ${s.enabled ? "off" : "on"}.`,
                          )
                        }
                      >
                        {s.enabled ? "Switch off" : "Switch on"}
                      </button>
                    </div>
                  </li>
                ),
              )}
            </ul>
          </div>
          <TryIt name={name} data={data} editing={editing} dirty={dirty} />
        </div>
      )}
    </Frame>
  );
}

function knowledgeSummary(s: Pick<Specialist, "knowledge">, data: Data) {
  if (s.knowledge.all) return "All of Zoe's content";
  const named = (ids: string[], list: Choice[]) =>
    ids.map((id) => list.find((x) => x.id === id)?.name ?? "A removed item");
  return [
    ...named(s.knowledge.collections, data.choices.collections),
    ...named(s.knowledge.websites, data.choices.websites),
    ...(s.knowledge.snippets ? ["Snippets"] : []),
    ...(s.knowledge.files ? ["Files"] : []),
  ].join(" · ");
}

function Editor({
  draft: d,
  data,
  busy,
  dirty,
  onChange,
  onCancel,
  onSave,
  onRemove,
  onGuidance,
}: {
  draft: Draft;
  data: Data;
  busy: boolean;
  dirty: boolean;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
  onRemove?: () => void;
  onGuidance?: () => void;
}) {
  const id = "sp-" + (d.id ?? "new");
  const set = (c: Partial<Draft>) => onChange({ ...d, ...c });
  const k = d.knowledge;
  const setK = (c: Partial<Draft["knowledge"]>) => set({ knowledge: { ...k, ...c } });
  const toggle = (list: string[], v: string, on: boolean) =>
    on ? [...new Set([...list, v])] : list.filter((x) => x !== v);
  const centers = [...new Set(data.choices.collections.map((c) => c.center))];
  return (
    <section className="pg-zoe-specialist-editor" aria-label={d.id ? `Edit ${d.name}` : "New specialist"}>
      <div className="pg-settings-field">
        <label htmlFor={id + "-name"}>Name</label>
        <input
          id={id + "-name"}
          maxLength={60}
          placeholder="Billing"
          value={d.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </div>
      <div className="pg-settings-field">
        <label htmlFor={id + "-handles"}>What she handles</label>
        <textarea
          id={id + "-handles"}
          rows={3}
          maxLength={500}
          placeholder="Invoices, payments, refunds and plan changes."
          aria-describedby={id + "-handles-hint"}
          value={d.handles}
          onChange={(e) => set({ handles: e.target.value })}
        />
        <small id={id + "-handles-hint"} className="pg-muted">
          Her instructions, and how Zoe picks her. A question outside it, she says she
          doesn&apos;t know, then hands over after your failed-answer limit.
        </small>
      </div>
      <div className="pg-settings-field">
        <label htmlFor={id + "-keywords"}>Keywords</label>
        <input
          id={id + "-keywords"}
          placeholder="invoice, refund, payment"
          aria-describedby={id + "-keywords-hint"}
          value={d.keywords.join(", ")}
          onChange={(e) =>
            set({
              keywords: e.target.value
                .split(",")
                .map((x, i, all) => (i < all.length - 1 ? x.trim() : x.trimStart()))
                .filter((x, i, all) => x || i === all.length - 1)
                .slice(0, MAX_SPECIALIST_KEYWORDS),
            })
          }
        />
        <small id={id + "-keywords-hint"} className="pg-muted">
          Separated by commas, up to {MAX_SPECIALIST_KEYWORDS}. Whole words in any language, checked
          in code, so she&apos;s picked even when the model is down.
        </small>
      </div>
      <fieldset className="pg-settings-fieldset">
        <legend>Only when</legend>
        <label className="pg-settings-toggle">
          <input
            type="radio"
            name={id + "-who"}
            checked={!d.conditions.length}
            onChange={() => set({ conditions: [] })}
          />
          <span>
            <strong>Any customer</strong>
          </span>
        </label>
        <label className="pg-settings-toggle">
          <input
            type="radio"
            name={id + "-who"}
            checked={d.conditions.length > 0}
            onChange={() =>
              !d.conditions.length && set({ conditions: [fresh("signed_in")] })
            }
          />
          <span>
            <strong>Only customers and conversations that match</strong>
            <small className="pg-muted">The same conditions as escalation rules.</small>
          </span>
        </label>
        {d.conditions.length > 0 && (
          <>
            <select
              aria-label={`${d.name || "Specialist"} needs`}
              value={d.match}
              onChange={(e) => set({ match: e.target.value as Draft["match"] })}
            >
              <option value="all">All conditions</option>
              <option value="any">Any condition</option>
            </select>
            <ConditionRows
              label={d.name.trim() || "Specialist"}
              conditions={d.conditions}
              choices={data.choices}
              min={1}
              onChange={(conditions) => set({ conditions })}
            />
            <div>
              <button
                type="button"
                disabled={d.conditions.length >= 10}
                onClick={() => set({ conditions: [...d.conditions, fresh("signed_in")] })}
              >
                Add condition
              </button>
            </div>
          </>
        )}
      </fieldset>
      <fieldset className="pg-settings-fieldset">
        <legend>Her knowledge</legend>
        <label className="pg-settings-toggle">
          <input
            type="radio"
            name={id + "-knowledge"}
            checked={k.all}
            onChange={() => setK({ all: true })}
          />
          <span>
            <strong>All of Zoe&apos;s content</strong>
          </span>
        </label>
        <label className="pg-settings-toggle">
          <input
            type="radio"
            name={id + "-knowledge"}
            checked={!k.all}
            onChange={() => setK({ all: false })}
          />
          <span>
            <strong>Only these</strong>
            <small className="pg-muted">
              She can&apos;t cite anything else, so content for another part of the business stays out.
            </small>
          </span>
        </label>
        {!k.all && (
          <div className="pg-zoe-knowledge">
            {centers.map((center) => (
              <div key={center} role="group" aria-label={`Collections in ${center}`}>
                <strong>{center}</strong>
                {data.choices.collections
                  .filter((c) => c.center === center)
                  .map((c) => (
                    <label key={c.id} className="pg-settings-inline">
                      <input
                        type="checkbox"
                        checked={k.collections.includes(c.id)}
                        onChange={(e) =>
                          setK({ collections: toggle(k.collections, c.id, e.target.checked) })
                        }
                      />
                      {c.name}
                    </label>
                  ))}
              </div>
            ))}
            <div role="group" aria-label="Other sources">
              <strong>Other sources</strong>
              {data.choices.websites.map((s) => (
                <label key={s.id} className="pg-settings-inline">
                  <input
                    type="checkbox"
                    checked={k.websites.includes(s.id)}
                    onChange={(e) => setK({ websites: toggle(k.websites, s.id, e.target.checked) })}
                  />
                  {s.name}
                </label>
              ))}
              <label className="pg-settings-inline">
                <input
                  type="checkbox"
                  checked={k.snippets}
                  onChange={(e) => setK({ snippets: e.target.checked })}
                />
                Snippets
              </label>
              <label className="pg-settings-inline">
                <input
                  type="checkbox"
                  checked={k.files}
                  onChange={(e) => setK({ files: e.target.checked })}
                />
                Files
              </label>
            </div>
          </div>
        )}
      </fieldset>
      <div className="pg-settings-row">
        <div className="pg-settings-field">
          <label htmlFor={id + "-team"}>Hands over to</label>
          <select
            id={id + "-team"}
            value={d.handoverTeamId ?? ""}
            onChange={(e) => set({ handoverTeamId: e.target.value || null })}
          >
            <option value="">Zoe&apos;s handover team</option>
            {data.choices.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <label className="pg-zoe-switch">
          <span>On</span>
          <input
            type="checkbox"
            role="switch"
            checked={d.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
        </label>
      </div>
      {!!d.guidance?.length && (
        <p className="pg-muted">
          Guidance just for her: {d.guidance.join(" · ")}.{" "}
          {onGuidance && (
            <button type="button" className="pg-link-button" onClick={onGuidance}>
              Change it on the Guidance page
            </button>
          )}
        </p>
      )}
      <div className="pg-zoe-specialist-actions">
        <button
          type="button"
          className="pg-zoe-primary"
          disabled={busy || !dirty}
          onClick={onSave}
        >
          {d.id ? "Save specialist" : "Add specialist"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        {onRemove && (
          <button type="button" className="pg-link-button" disabled={busy} onClick={onRemove}>
            Remove {d.name}
          </button>
        )}
      </div>
    </section>
  );
}

/** Beside the list: ask as Zoe would route it, or as one specialist (unsaved changes included). */
function TryIt({
  name,
  data,
  editing,
  dirty,
}: {
  name: string;
  data: Data;
  editing: Draft | null;
  dirty: boolean;
}) {
  const [as, setAs] = useState("route");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<
    (PreviewResult & { asked: string; specialist: { name: string; reason: string } | null }) | null
  >(null);
  // While one is being edited, she's asked as that one, with the changes.
  const unsaved = !!editing && dirty && editing.name.trim() && editing.handles.trim();
  async function ask() {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<PreviewResult & { specialist: { name: string; reason: string } | null }>(
        "zoe-playground",
        {
          question: q,
          ...(editing && unsaved
            ? { specialist: body(editing) }
            : editing?.id
              ? { specialistId: editing.id }
              : as !== "route"
                ? { specialistId: as }
                : {}),
        },
      );
      setResult({ ...r, asked: q });
    } catch (e) {
      setError(message(e, "She couldn't be asked just now."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="pg-zoe-try" aria-label="Try it">
      <header>
        <ZoeMark size={26} />
        <strong>Try it</strong>
        {editing ? (
          <span className="pg-zoe-badge" data-draft={unsaved ? "true" : undefined}>
            {unsaved ? `As ${editing.name.trim()}, unsaved` : `As ${editing.name.trim() || "the new specialist"}`}
          </span>
        ) : null}
      </header>
      {!editing && (
        <label className="pg-zoe-inline">
          <span>Answer as</span>
          <select value={as} onChange={(e) => setAs(e.target.value)}>
            <option value="route">Let {name} pick</option>
            {data.specialists.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="pg-zoe-askbar">
        <textarea
          aria-label="Question to try"
          rows={2}
          maxLength={2000}
          placeholder={`Ask what a customer would`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
        />
        <button
          type="button"
          className="pg-zoe-primary"
          disabled={busy || !question.trim() || (!!editing && !editing.id && !unsaved)}
          onClick={() => void ask()}
        >
          <Send size={14} aria-hidden="true" /> {busy ? "Asking…" : "Ask"}
        </button>
      </div>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <section className="pg-zoe-try-result" aria-label={`${name}'s answer`} aria-live="polite">
        {!result ? (
          <p className="pg-muted">
            Ask a customer question to see who takes it and what she says. Nothing is sent or
            recorded.
          </p>
        ) : (
          <>
            <p className="pg-zoe-asked">{result.asked}</p>
            <article className="pg-zoe-bubble">
              <header>
                <ZoeMark size={20} />
                <strong>{name}</strong>
                <span className="pg-zoe-badge">AI agent</span>
              </header>
              <p>
                {result.outcome === "ignored"
                  ? `She wouldn't reply. ${result.reason}`
                  : result.reply}
              </p>
              {!!result.sources.length && (
                <ul aria-label="Sources">
                  {result.sources.map((s) => (
                    <li key={s.title}>{s.title}</li>
                  ))}
                </ul>
              )}
            </article>
            <p className="pg-zoe-try-meta">
              <span className="pg-zoe-outcome" data-hue={OUTCOME_HUES[result.outcome] ?? "amber"}>
                {OUTCOME_NAMES[result.outcome] ?? result.outcome}
              </span>{" "}
              {result.specialist
                ? `Answered as ${result.specialist.name}: ${result.specialist.reason.charAt(0).toLowerCase()}${result.specialist.reason.slice(1)}.`
                : `${name} herself: no specialist took it.`}
            </p>
            {result.skipped.count > 0 && (
              <p className="pg-zoe-try-meta pg-zoe-skipped">{skippedWords(result.skipped)}</p>
            )}
          </>
        )}
      </section>
    </aside>
  );
}
