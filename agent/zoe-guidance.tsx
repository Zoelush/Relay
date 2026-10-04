import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Ban,
  BookOpen,
  CircleHelp,
  PenLine,
  Plus,
  Send,
  Shapes,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { api } from "./api";
import { Card, Frame, message, type Page } from "./settings-ui";
import type { SideMenuState } from "./shell";
import { ZoeMark } from "./colour";
import {
  AUDIENCES,
  FORMALITIES,
  GUIDANCE_CATEGORIES,
  LENGTHS,
  MAX_GUIDELINES,
  MAX_GUIDELINE_TEXT,
  MAX_GUIDELINE_TITLE,
  TONES,
  guidanceWarnings,
  type Guideline,
  type Voice,
} from "../lib/zoe-voice";
import {
  OUTCOME_HUES,
  OUTCOME_NAMES,
  ago,
  languageNote,
  voiceSummary,
} from "./zoe-labels";

/**
 * Train › Guidance (phase 08, step Z2; docs/AI_STEP6.md): how Zoe sounds (tone, length,
 * formality) and the workspace's answer guidance in Intercom's categories, with a preview beside
 * it that answers with the unsaved changes, and the saved versions to look at and restore.
 */
type Brand = { id: string; name: string };
type GuidanceData = {
  voice: Voice;
  guidance: Guideline[];
  version: number;
  versions: {
    version: number;
    restoredFrom: number | null;
    savedAt: string;
    by: string;
    guidelines: number;
    voice: Voice;
  }[];
  brands: Brand[];
  /** Her specialists (Z3a), for guidance that applies only when one answers. */
  specialists: Brand[];
};
type Form = { voice: Voice; guidance: Guideline[] };
/** What the Playground returns (Z1, with Z2's language and instructions). */
export type PreviewResult = {
  outcome: string;
  trigger: string | null;
  reason: string;
  reply: string;
  sources: { title: string; path?: string }[];
  options: string[];
  confidence: number | null;
  threshold: number;
  candidates: { title: string; heading: string; score: number | null; used: boolean }[];
  model: string | null;
  language: string;
  customerLanguage: string;
  detectedLanguage: string | null;
  languageSource: "message" | "conversation" | "browser" | "brand";
  voice: Voice;
  draft: boolean;
  guidanceVersion: number | null;
  instructions: string[];
  applied: { title: string; category: string }[];
  /** Z3a: the specialist who answered, and why (null: Zoe herself). */
  specialist: { id: string; name: string; reason: string } | null;
  latencyMs: number;
};
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  style: PenLine,
  clarification: CircleHelp,
  sources: BookOpen,
  spam: Ban,
  other: Shapes,
};
const formOf = (d: GuidanceData): Form => ({ voice: d.voice, guidance: d.guidance });
/** What the preview may send: guidelines still being written are left out. */
const draftOf = (f: Form) => ({
  ...f.voice,
  guidance: f.guidance.filter((g) => g.title.trim() && g.text.trim()),
});

export function GuidancePage({
  menu,
  page,
  name,
}: {
  menu: SideMenuState;
  page: Page;
  name: string;
}) {
  const [data, setData] = useState<GuidanceData | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const apply = (d: GuidanceData) => {
    setData(d);
    setForm(formOf(d));
  };
  useEffect(() => {
    api<GuidanceData>("zoe?view=guidance")
      .then(apply)
      .catch((e) => setError(message(e, "This page could not be loaded.")));
  }, []);
  const dirty =
    !!data && !!form && JSON.stringify(form) !== JSON.stringify(formOf(data));
  const set = (f: Form) => {
    setSaved(false);
    setForm(f);
  };
  async function save(body: Record<string, unknown>) {
    if (!data) return;
    setBusy(true);
    setError("");
    try {
      apply(await api<GuidanceData>("zoe-guidance", { ...body, version: data.version }));
      setOpened(null);
      setSaved(true);
    } catch (e) {
      setError(message(e, "Her guidance could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  const change = (g: Guideline) =>
    form && set({ ...form, guidance: form.guidance.map((x) => (x.id === g.id ? g : x)) });
  return (
    <Frame
      menu={menu}
      page={page}
      wide
      save={{
        dirty,
        busy,
        saved,
        error,
        savedLabel: data ? `Saved as version ${data.version}` : "Saved",
        onSave: () =>
          form &&
          void save({
            tone: form.voice.tone,
            length: form.voice.length,
            formality: form.voice.formality,
            guidance: form.guidance,
          }),
      }}
      actions={
        dirty ? (
          <button type="button" onClick={() => data && (setForm(formOf(data)), setOpened(null))}>
            Discard changes
          </button>
        ) : null
      }
    >
      {data && form && (
        <div className="pg-zoe-guidance">
          <div className="pg-zoe-guidance-main">
            <VoiceCard voice={form.voice} onChange={(voice) => set({ ...form, voice })} />
            <section className="pg-zoe-guidelines" aria-labelledby="zoe-guidance-title">
              <header>
                <h3 id="zoe-guidance-title">Guidance</h3>
                <span className="pg-zoe-count">
                  {form.guidance.length} of {MAX_GUIDELINES}
                </span>
              </header>
              <p className="pg-muted">
                Plain instructions for how {name} answers. She follows them under her own
                rules: she still answers only from your content, and guidance can&apos;t let her
                do anything new.
              </p>
              {GUIDANCE_CATEGORIES.map((c) => {
                const Icon = CATEGORY_ICONS[c.id];
                const items = form.guidance.filter((g) => g.category === c.id);
                return (
                  <section
                    key={c.id}
                    className="pg-zoe-category"
                    data-hue={c.hue}
                    aria-labelledby={`zoe-cat-${c.id}`}
                  >
                    <header>
                      <span className="pg-settings-tile-icon" aria-hidden="true">
                        <Icon size={16} />
                      </span>
                      <span>
                        <h4 id={`zoe-cat-${c.id}`}>{c.label}</h4>
                        <small className="pg-muted">{c.description}</small>
                      </span>
                      <button
                        type="button"
                        className="pg-zoe-add"
                        disabled={form.guidance.length >= MAX_GUIDELINES}
                        aria-label={`Add ${c.label.toLowerCase()} guidance`}
                        onClick={() => {
                          const g: Guideline = {
                            id: crypto.randomUUID(),
                            category: c.id,
                            title: "",
                            text: "",
                            enabled: true,
                            audience: "everyone",
                            brandId: null,
                          };
                          set({ ...form, guidance: [...form.guidance, g] });
                          setOpened(g.id);
                        }}
                      >
                        <Plus size={14} aria-hidden="true" /> Add
                      </button>
                    </header>
                    {items.length ? (
                      <ul>
                        {items.map((g) => (
                          <GuidelineRow
                            key={g.id}
                            g={g}
                            example={c.example}
                            brands={data.brands}
                            specialists={data.specialists}
                            open={opened === g.id}
                            onChange={change}
                            onRemove={() =>
                              set({
                                ...form,
                                guidance: form.guidance.filter((x) => x.id !== g.id),
                              })
                            }
                          />
                        ))}
                      </ul>
                    ) : (
                      <p className="pg-zoe-example">For example: “{c.example}”</p>
                    )}
                  </section>
                );
              })}
            </section>
            <History
              data={data}
              dirty={dirty}
              busy={busy}
              onRestore={(version) => void save({ restore: version })}
            />
          </div>
          <TryIt
            name={name}
            brands={data.brands}
            draft={dirty ? draftOf(form) : null}
            version={data.version}
          />
        </div>
      )}
    </Frame>
  );
}

/** Her tone, length and formality. */
function VoiceCard({ voice, onChange }: { voice: Voice; onChange: (v: Voice) => void }) {
  return (
    <Card
      title="How she sounds"
      description="Her tone, how much she says, and how she addresses customers, in every language."
    >
      <fieldset className="pg-zoe-fieldset">
        <legend>Tone of voice</legend>
        <div className="pg-zoe-tones">
          {TONES.map((t) => (
            <label key={t.id} className="pg-zoe-tone" data-checked={voice.tone === t.id}>
              <input
                type="radio"
                name="zoe-tone"
                value={t.id}
                checked={voice.tone === t.id}
                onChange={() => onChange({ ...voice, tone: t.id })}
              />
              <strong>{t.label}</strong>
              <small>{t.description}</small>
              <q>{t.sample}</q>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="pg-zoe-fieldset">
        <legend>Answer length</legend>
        <div className="pg-zoe-segmented">
          {LENGTHS.map((l) => (
            <label key={l.id} data-checked={voice.length === l.id}>
              <input
                type="radio"
                name="zoe-length"
                value={l.id}
                checked={voice.length === l.id}
                onChange={() => onChange({ ...voice, length: l.id })}
              />
              <span>{l.label}</span>
              <small>{l.description}</small>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="pg-zoe-fieldset">
        <legend>Formality</legend>
        <div className="pg-zoe-segmented">
          {FORMALITIES.map((f) => (
            <label key={f.id} data-checked={voice.formality === f.id}>
              <input
                type="radio"
                name="zoe-formality"
                value={f.id}
                checked={voice.formality === f.id}
                onChange={() => onChange({ ...voice, formality: f.id })}
              />
              <span>{f.label}</span>
            </label>
          ))}
        </div>
        <small className="pg-muted">
          {FORMALITIES.find((f) => f.id === voice.formality)?.description} It covers her answers
          and her fixed messages (her greeting, handover and away messages), wherever a language
          makes the distinction.
        </small>
      </fieldset>
    </Card>
  );
}

function GuidelineRow({
  g,
  example,
  brands,
  specialists,
  open,
  onChange,
  onRemove,
}: {
  g: Guideline;
  example: string;
  brands: Brand[];
  specialists: Brand[];
  open: boolean;
  onChange: (g: Guideline) => void;
  onRemove: () => void;
}) {
  const warnings = guidanceWarnings(g);
  const id = "g-" + g.id;
  const brand = g.brandId
    ? (brands.find((b) => b.id === g.brandId)?.name ?? "A removed brand")
    : "All brands";
  const audience = AUDIENCES.find((a) => a.id === g.audience)?.label ?? "Everyone";
  // Z3a: only when one specialist answers (never for spam, which is about the message).
  const specialist = g.specialistId
    ? (specialists.find((s) => s.id === g.specialistId)?.name ?? "A removed specialist")
    : null;
  return (
    <li className="pg-zoe-guideline" data-off={g.enabled ? undefined : "true"}>
      <details open={open || undefined}>
        <summary>
          <span className="pg-zoe-guideline-title">{g.title.trim() || "New guideline"}</span>
          <span className="pg-zoe-guideline-meta">
            {audience} · {brand}
            {specialist ? ` · only for ${specialist}` : ""}
          </span>
          {!g.enabled && <span className="pg-zoe-off">Off</span>}
          {warnings.length > 0 && (
            <AlertTriangle size={14} className="pg-zoe-warn-icon" aria-label="Has a warning" />
          )}
        </summary>
        <div className="pg-zoe-guideline-body">
          <div className="pg-settings-field">
            <label htmlFor={id + "-title"}>Title</label>
            <input
              id={id + "-title"}
              maxLength={MAX_GUIDELINE_TITLE}
              placeholder="A short name, such as Plain words"
              value={g.title}
              onChange={(e) => onChange({ ...g, title: e.target.value })}
            />
          </div>
          <div className="pg-settings-field">
            <label htmlFor={id + "-text"}>Guidance</label>
            <textarea
              id={id + "-text"}
              rows={3}
              maxLength={MAX_GUIDELINE_TEXT}
              placeholder={example}
              aria-describedby={id + "-count"}
              value={g.text}
              onChange={(e) => onChange({ ...g, text: e.target.value })}
            />
            <small id={id + "-count"} className="pg-muted">
              {g.text.length} of {MAX_GUIDELINE_TEXT} characters
            </small>
          </div>
          <div className="pg-settings-row">
            <div className="pg-settings-field">
              <label htmlFor={id + "-who"}>Who it&apos;s for</label>
              <select
                id={id + "-who"}
                value={g.audience}
                onChange={(e) => onChange({ ...g, audience: e.target.value as Guideline["audience"] })}
              >
                {AUDIENCES.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="pg-settings-field">
              <label htmlFor={id + "-brand"}>Brand</label>
              <select
                id={id + "-brand"}
                value={g.brandId ?? ""}
                onChange={(e) => onChange({ ...g, brandId: e.target.value || null })}
              >
                <option value="">All brands</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
            {g.category !== "spam" && (specialists.length > 0 || g.specialistId) && (
              <div className="pg-settings-field">
                <label htmlFor={id + "-when"}>When</label>
                <select
                  id={id + "-when"}
                  value={g.specialistId ?? ""}
                  onChange={(e) => onChange({ ...g, specialistId: e.target.value || null })}
                >
                  <option value="">Always</option>
                  {specialists.map((s) => (
                    <option key={s.id} value={s.id}>
                      Only when {s.name} answers
                    </option>
                  ))}
                  {g.specialistId && !specialists.some((s) => s.id === g.specialistId) && (
                    <option value={g.specialistId}>For a removed specialist</option>
                  )}
                </select>
              </div>
            )}
          </div>
          {warnings.length > 0 && (
            <ul className="pg-zoe-warnings" aria-label="Warnings">
              {warnings.map((w) => (
                <li key={w}>
                  <AlertTriangle size={13} aria-hidden="true" /> {w}
                </li>
              ))}
            </ul>
          )}
          <div className="pg-zoe-guideline-actions">
            <label className="pg-zoe-switch">
              <span>On</span>
              <input
                type="checkbox"
                role="switch"
                checked={g.enabled}
                onChange={(e) => onChange({ ...g, enabled: e.target.checked })}
              />
            </label>
            <button type="button" className="pg-link-button" onClick={onRemove}>
              <Trash2 size={13} aria-hidden="true" /> Remove
            </button>
          </div>
        </div>
      </details>
    </li>
  );
}

/** The saved versions: who saved each and when, to look at and restore. */
function History({
  data,
  dirty,
  busy,
  onRestore,
}: {
  data: GuidanceData;
  dirty: boolean;
  busy: boolean;
  onRestore: (version: number) => void;
}) {
  const [shown, setShown] = useState<{ version: number; voice: Voice; guidance: Guideline[] } | null>(
    null,
  );
  const [error, setError] = useState("");
  async function view(version: number) {
    if (shown?.version === version) return setShown(null);
    setError("");
    try {
      setShown(await api("zoe?view=guidance&version=" + version));
    } catch (e) {
      setError(message(e, "That version could not be loaded."));
    }
  }
  return (
    <Card
      title="History"
      description="Every save is a version, kept as it was. Each answer records the version it was given; restoring one saves it again as the newest."
    >
      {data.versions.length ? (
        <ol className="pg-zoe-history" aria-label="Versions">
          {data.versions.map((v) => (
            <li key={v.version} data-current={v.version === data.version || undefined}>
              <span>
                <strong>
                  Version {v.version}
                  {v.version === data.version ? " · in use" : ""}
                </strong>
                <small className="pg-muted">
                  {v.by} · {ago(v.savedAt)}
                  {v.restoredFrom ? ` · restored from version ${v.restoredFrom}` : ""} ·{" "}
                  {voiceSummary(v.voice)} · {v.guidelines}{" "}
                  {v.guidelines === 1 ? "guideline" : "guidelines"}
                </small>
              </span>
              <button
                type="button"
                aria-label={`${shown?.version === v.version ? "Hide" : "View"} version ${v.version}`}
                onClick={() => void view(v.version)}
              >
                {shown?.version === v.version ? "Hide" : "View"}
              </button>
              {v.version !== data.version && (
                <button
                  type="button"
                  aria-label={`Restore version ${v.version}`}
                  disabled={dirty || busy}
                  onClick={() => onRestore(v.version)}
                >
                  Restore
                </button>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="pg-zoe-empty">
          Nothing saved yet. Until her first save she&apos;s friendly, at standard length, with
          the usual formality and no guidance.
        </p>
      )}
      {dirty && data.versions.length > 1 && (
        <small className="pg-muted">Save or discard your changes to restore a version.</small>
      )}
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {shown && (
        <section className="pg-zoe-version" aria-label={`Version ${shown.version}`}>
          <strong>{voiceSummary(shown.voice)}</strong>
          {shown.guidance.length ? (
            <ul>
              {shown.guidance.map((g) => (
                <li key={g.id} data-off={g.enabled ? undefined : "true"}>
                  <span>
                    {GUIDANCE_CATEGORIES.find((c) => c.id === g.category)?.label} ·{" "}
                    <strong>{g.title}</strong>
                    {g.enabled ? "" : " (off)"}
                  </span>
                  <small className="pg-muted">{g.text}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pg-zoe-empty">No guidance in this version.</p>
          )}
        </section>
      )}
    </Card>
  );
}

/** Beside the page: ask her a question with these settings (unsaved changes included). */
function TryIt({
  name,
  brands,
  draft,
  version,
}: {
  name: string;
  brands: Brand[];
  draft: Record<string, unknown> | null;
  version: number;
}) {
  const [question, setQuestion] = useState("");
  const [brandId, setBrandId] = useState("default");
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<(PreviewResult & { asked: string }) | null>(null);
  async function ask() {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<PreviewResult>("zoe-playground", {
        question: q,
        brandId,
        signedIn,
        ...(draft ? { draft } : {}),
      });
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
        <span className="pg-zoe-badge" data-draft={draft ? "true" : undefined}>
          {draft ? "With your unsaved changes" : version ? `As saved · version ${version}` : "As saved"}
        </span>
      </header>
      <div className="pg-settings-row">
        <label className="pg-zoe-inline">
          <span>Brand</span>
          <select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label className="pg-zoe-inline">
          <span>Customer</span>
          <select
            value={signedIn ? "user" : "visitor"}
            onChange={(e) => setSignedIn(e.target.value === "user")}
          >
            <option value="visitor">A visitor</option>
            <option value="user">A signed-in customer</option>
          </select>
        </label>
      </div>
      <div className="pg-zoe-askbar">
        <textarea
          aria-label="Question to try"
          rows={2}
          maxLength={2000}
          placeholder={`Ask ${name} what a customer would`}
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
          disabled={busy || !question.trim()}
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
            Ask a customer question to see how she answers with these settings. Nothing is sent
            or recorded.
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
              {languageNote(result.language, result.customerLanguage, result.languageSource)}
            </p>
            <details className="pg-zoe-told" open>
              <summary>What she was told</summary>
              <ul aria-label="What she was told">
                {result.instructions.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <small className="pg-muted">
                {result.model
                  ? `Answered by ${result.model}.`
                  : "The model wasn't asked: her rules decided first."}{" "}
                {result.model === "stand-in"
                  ? "The local stand-in doesn't write, so only the length changes its answer; tone, formality and guidance take effect with Claude."
                  : ""}
              </small>
            </details>
          </>
        )}
      </section>
    </aside>
  );
}
