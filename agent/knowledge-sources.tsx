import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { TargetingFields, type Condition, type TargetingChoices } from "./settings-ai";

/**
 * Websites synced into knowledge (phase 07, step C1b), in Knowledge for `knowledge.manage`: add a
 * site by its address or sitemap, see each sync and every page's state, sync now, pause, change
 * settings, or remove it. Pages become synced-page records, found in Knowledge search.
 */
type Run = {
  id: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  trigger: "manual" | "schedule";
  startedAt: string;
  finishedAt: string | null;
  seen: number;
  changed: number;
  failed: number;
  removed: number;
  failure: string | null;
  pageLimitReached: boolean;
};
type Source = {
  id: string;
  name: string;
  url: string;
  sitemap: boolean;
  locale: string;
  exclude: string[];
  strip: string[];
  renderJs: boolean;
  audience: "public" | "signed_in" | "internal";
  forAi: boolean;
  forInbox: boolean;
  status: "active" | "paused";
  intervalDays: number;
  nextRunAt: string | null;
  pageCount: number;
  version: string;
  run: Run | null;
};
type Detail = Source & {
  /** Phase 08 Z3b: who Zoe uses its pages for, and the names conditions can refer to. */
  aiMatch: "all" | "any";
  aiConditions: Condition[];
  targetingChoices: TargetingChoices;
  pages: {
    url: string;
    recordId: string | null;
    title: string | null;
    status: "active" | "removed" | "failed" | "skipped";
    reason: string | null;
    fetchedAt: string | null;
  }[];
};

/** Why a page or a sync didn't go as planned, in words a teammate can act on. */
export const SYNC_REASONS: Record<string, string> = {
  ROBOTS_DISALLOWED:
    "The site's robots.txt asks crawlers not to read this page.",
  ROBOTS_UNAVAILABLE:
    "The site's robots.txt couldn't be read (a server error), so nothing was fetched. It will try again tomorrow.",
  NOINDEX: "The page asks not to be indexed.",
  NOT_HTML: "Not a web page.",
  NO_TEXT: "No text found on the page.",
  EXCLUDED: "Matches an exclusion pattern.",
  OTHER_SITE: "On another site.",
  REDIRECTED_AWAY: "Redirects to another site.",
  TOO_LARGE: "Larger than 5 MB.",
  TIMEOUT: "Took longer than 15 seconds.",
  UNREACHABLE: "Couldn't be reached.",
  TOO_MANY_REDIRECTS: "Too many redirects.",
  ADDRESS_NOT_ALLOWED: "Not a public https:// address.",
  SITEMAP_EMPTY: "The sitemap lists no pages.",
  GONE: "The page no longer exists (404).",
  MISSING: "No longer linked or in the sitemap for two syncs.",
};
export const reason = (code: string | null) =>
  !code
    ? ""
    : (SYNC_REASONS[code] ??
      (code.startsWith("HTTP_")
        ? `The site answered with an error (${code.slice(5)}).`
        : code));
const AUDIENCES = {
  public: "Everyone",
  signed_in: "Signed-in customers",
  internal: "Teammates only (internal)",
};
const PAGE_STATUS = {
  active: "Synced",
  removed: "Removed",
  failed: "Couldn't sync",
  skipped: "Skipped",
};
const message = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : "";

function runWords(s: Source) {
  if (s.status === "paused") return "Paused";
  const r = s.run;
  if (!r) return "Not synced yet";
  if (r.status === "running") return `Syncing… ${r.seen} pages checked`;
  if (r.status === "failed") return "Last sync failed: " + reason(r.failure);
  if (r.status === "cancelled") return "Last sync stopped";
  return `Synced ${when(r.finishedAt)}`;
}

export function Websites() {
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const load = useCallback(
    () =>
      api<{ sources: Source[] }>("knowledge-sources")
        .then((d) => {
          setSources(d.sources);
          setError("");
          return d.sources;
        })
        .catch((e) => {
          setError(message(e, "Websites could not be loaded."));
          return [] as Source[];
        }),
    [],
  );
  useEffect(() => {
    void load();
  }, [load, reload]);
  // While a sync runs, refresh every two seconds (for up to ten minutes).
  const polls = useRef(0);
  const running = sources.some((s) => s.run?.status === "running");
  useEffect(() => {
    if (!running) {
      polls.current = 0;
      return;
    }
    if (++polls.current > 300) return;
    const timer = setTimeout(() => setReload((n) => n + 1), 2000);
    return () => clearTimeout(timer);
  }, [running, sources]);

  return (
    <div className="pg-help pg-websites">
      <div className="pg-help-bar">
        <p className="pg-muted">
          Sync a website into knowledge: its pages are read weekly and found in
          Knowledge search. Public https:// sites only.
        </p>
        <button type="button" onClick={() => setAdding(true)}>
          Add a website
        </button>
      </div>
      {error && (
        <div className="pg-error" role="alert">
          {error}
        </div>
      )}
      {adding && (
        <AddWebsite
          onCancel={() => setAdding(false)}
          onAdded={(id) => {
            setAdding(false);
            setSelected(id);
            setReload((n) => n + 1);
          }}
        />
      )}
      <ul className="pg-websites-list" aria-label="Websites">
        {sources.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              aria-current={selected === s.id}
              onClick={() => setSelected(s.id)}
            >
              <strong>{s.name}</strong>
              <span className="pg-muted">{s.url}</span>
              <span
                role="status"
                className={
                  s.run?.status === "failed" ? "pg-knowledge-warn" : "pg-muted"
                }
              >
                {runWords(s)} · {s.pageCount} pages
              </span>
            </button>
          </li>
        ))}
        {!sources.length && !adding && (
          <li className="pg-muted">No websites yet.</li>
        )}
      </ul>
      {selected && sources.some((s) => s.id === selected) && (
        <WebsiteDetail
          key={selected}
          id={selected}
          revision={reload}
          onChanged={() => setReload((n) => n + 1)}
          onRemoved={() => {
            setSelected(null);
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

function AccessFields({
  value,
  onChange,
}: {
  value: { audience: Source["audience"]; forAi: boolean; forInbox: boolean };
  onChange: (v: {
    audience: Source["audience"];
    forAi: boolean;
    forInbox: boolean;
  }) => void;
}) {
  const internal = value.audience === "internal";
  return (
    <fieldset>
      <legend>Who can use its pages</legend>
      <label>
        Audience
        <select
          value={value.audience}
          onChange={(e) => {
            const audience = e.target.value as Source["audience"];
            onChange({
              ...value,
              audience,
              forAi: audience === "internal" ? false : value.forAi,
            });
          }}
        >
          {Object.entries(AUDIENCES).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={value.forAi}
          disabled={internal}
          onChange={(e) => onChange({ ...value, forAi: e.target.checked })}
        />
        AI agent can use them
      </label>
      <label>
        <input
          type="checkbox"
          checked={value.forInbox}
          onChange={(e) => onChange({ ...value, forInbox: e.target.checked })}
        />
        Teammates can use them in the inbox
      </label>
      {internal && (
        <p className="pg-muted">
          Internal content is for teammates only: the AI agent answers
          customers, so it can&apos;t use it.
        </p>
      )}
    </fieldset>
  );
}

const splitLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function AddWebsite({
  onCancel,
  onAdded,
}: {
  onCancel: () => void;
  onAdded: (id: string) => void;
}) {
  const [form, setForm] = useState({
    url: "",
    name: "",
    locale: "en",
    exclude: "",
    strip: "",
    renderJs: false,
    audience: "internal" as Source["audience"],
    forAi: false,
    forInbox: true,
  });
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof form>) =>
    setForm((f) => ({ ...f, ...patch }));
  return (
    <form
      className="pg-help-settings pg-website-form"
      aria-label="Add a website"
      onSubmit={(e) => {
        e.preventDefault();
        setProblem("");
        setBusy(true);
        void api<{ id: string }>("knowledge-sources", {
          op: "create",
          url: form.url,
          name: form.name.trim() || undefined,
          locale: form.locale,
          exclude: splitLines(form.exclude),
          strip: splitLines(form.strip),
          renderJs: form.renderJs,
          audience: form.audience,
          forAi: form.forAi,
          forInbox: form.forInbox,
        })
          .then((r) => onAdded(r.id))
          .catch((err) => setProblem(message(err, "It could not be added.")))
          .finally(() => setBusy(false));
      }}
    >
      <h3>Add a website</h3>
      <label>
        Address or sitemap
        <input
          required
          type="url"
          placeholder="https://help.example.com/ or …/sitemap.xml"
          value={form.url}
          onChange={(e) => set({ url: e.target.value })}
        />
      </label>
      <label>
        Name
        <input
          placeholder="Defaults to the site's address"
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>
      <label>
        Language
        <input
          aria-label="Language"
          value={form.locale}
          size={6}
          onChange={(e) => set({ locale: e.target.value.trim() })}
        />
      </label>
      <label className="pg-website-lines">
        Don&apos;t sync addresses matching (one per line, * matches anything)
        <textarea
          rows={3}
          placeholder={"/blog/*\n/careers/*"}
          value={form.exclude}
          onChange={(e) => set({ exclude: e.target.value })}
        />
      </label>
      <label className="pg-website-lines">
        Leave out page parts matching (one selector per line)
        <textarea
          rows={3}
          placeholder={"nav\n.cookie-banner\n#footer"}
          value={form.strip}
          onChange={(e) => set({ strip: e.target.value })}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={form.renderJs}
          onChange={(e) => set({ renderJs: e.target.checked })}
        />
        The site needs JavaScript to show its content
      </label>
      <AccessFields value={form} onChange={(v) => set(v)} />
      {problem && (
        <p role="alert" className="pg-knowledge-warn">
          {problem}
        </p>
      )}
      <div className="pg-knowledge-actions">
        <button type="submit" disabled={busy}>
          Add and sync
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function WebsiteDetail({
  id,
  revision,
  onChanged,
  onRemoved,
}: {
  id: string;
  /** Changes when the list reloads (a sync's progress), to reload in place. */
  revision: number;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [notice, setNotice] = useState("");
  const [edit, setEdit] = useState<{
    name: string;
    exclude: string;
    strip: string;
    audience: Source["audience"];
    forAi: boolean;
    forInbox: boolean;
    aiMatch: "all" | "any";
    aiConditions: Condition[];
  } | null>(null);
  useEffect(() => {
    let live = true;
    api<Detail>("knowledge-source?" + new URLSearchParams({ id }))
      .then((x) => live && setD(x))
      .catch((e) => live && setNotice(message(e, "It could not be loaded.")));
    return () => {
      live = false;
    };
  }, [id, revision]);
  async function act(body: Record<string, unknown>, done: string) {
    setNotice("");
    try {
      await api("knowledge-sources", { id, ...body });
      if (body.op === "remove") return onRemoved();
      setNotice(done);
      onChanged();
    } catch (e) {
      setNotice(message(e, "That did not work."));
    }
  }
  if (!d) return <p className="pg-muted">{notice || "Loading…"}</p>;
  const syncing = d.run?.status === "running";
  return (
    <section className="pg-website" aria-label={`Website ${d.name}`}>
      <header className="pg-help-bar">
        <h3>{d.name}</h3>
        <a href={d.url} target="_blank" rel="noopener noreferrer">
          {d.url}
        </a>
      </header>
      <p
        role="status"
        className={d.run?.status === "failed" ? "pg-knowledge-warn" : undefined}
      >
        {runWords(d)}
        {d.run && d.run.status !== "running" && d.run.status !== "failed"
          ? ` · ${d.run.seen} checked, ${d.run.changed} updated, ${d.run.removed} removed, ${d.run.failed} couldn't sync`
          : ""}
        {d.run?.pageLimitReached ? " · stopped at 2,000 pages" : ""}
      </p>
      {d.status === "active" && d.nextRunAt && !syncing && (
        <p className="pg-muted">
          Next sync {when(d.nextRunAt)} (every {d.intervalDays} days).
        </p>
      )}
      <div className="pg-knowledge-actions">
        <button
          type="button"
          disabled={syncing || d.status === "paused"}
          onClick={() => void act({ op: "sync" }, "Syncing now.")}
        >
          Sync now
        </button>
        <button
          type="button"
          onClick={() =>
            void act(
              { op: d.status === "paused" ? "resume" : "pause" },
              d.status === "paused" ? "Resumed." : "Paused.",
            )
          }
        >
          {d.status === "paused" ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          onClick={() =>
            setEdit({
              name: d.name,
              exclude: d.exclude.join("\n"),
              strip: d.strip.join("\n"),
              audience: d.audience,
              forAi: d.forAi,
              forInbox: d.forInbox,
              aiMatch: d.aiMatch,
              aiConditions: d.aiConditions,
            })
          }
        >
          Settings
        </button>
        <button
          type="button"
          onClick={() => {
            if (
              window.confirm(
                "Remove this website? Its pages leave search and every surface.",
              )
            )
              void act({ op: "remove" }, "Removed.");
          }}
        >
          Remove
        </button>
      </div>
      {notice && (
        <p className="pg-knowledge-notice" role="alert">
          {notice}
        </p>
      )}
      {edit && (
        <form
          className="pg-help-settings pg-website-form"
          aria-label="Website settings"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              {
                op: "update",
                version: d.version,
                name: edit.name,
                exclude: splitLines(edit.exclude),
                strip: splitLines(edit.strip),
                audience: edit.audience,
                forAi: edit.forAi,
                forInbox: edit.forInbox,
                aiMatch: edit.aiMatch,
                aiConditions: edit.aiConditions,
              },
              "Settings saved. Exclusions and stripped parts apply from the next sync.",
            );
          }}
        >
          <label>
            Name
            <input
              value={edit.name}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            />
          </label>
          <label className="pg-website-lines">
            Don&apos;t sync addresses matching
            <textarea
              rows={3}
              value={edit.exclude}
              onChange={(e) => setEdit({ ...edit, exclude: e.target.value })}
            />
          </label>
          <label className="pg-website-lines">
            Leave out page parts matching
            <textarea
              rows={3}
              value={edit.strip}
              onChange={(e) => setEdit({ ...edit, strip: e.target.value })}
            />
          </label>
          <AccessFields
            value={edit}
            onChange={(v) => setEdit({ ...edit, ...v })}
          />
          {edit.forAi && (
            <TargetingFields
              value={{ match: edit.aiMatch, conditions: edit.aiConditions }}
              choices={d.targetingChoices}
              onChange={(t) => setEdit({ ...edit, aiMatch: t.match, aiConditions: t.conditions })}
            />
          )}
          <div className="pg-knowledge-actions">
            <button type="submit">Save settings</button>
            <button type="button" onClick={() => setEdit(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <table className="pg-help-insights-table pg-website-pages">
        <caption className="pg-visually-hidden">Pages</caption>
        <thead>
          <tr>
            <th scope="col">Page</th>
            <th scope="col">State</th>
            <th scope="col">Last read</th>
          </tr>
        </thead>
        <tbody>
          {d.pages.map((p) => (
            <tr key={p.url}>
              <td>
                <span className="pg-website-title">
                  {p.title ?? new URL(p.url).pathname}
                </span>
                {p.title && (
                  <span className="pg-muted">{new URL(p.url).pathname}</span>
                )}
              </td>
              <td>
                {PAGE_STATUS[p.status]}
                {p.reason && p.status !== "active"
                  ? `: ${reason(p.reason)}`
                  : ""}
              </td>
              <td className="pg-muted">{when(p.fetchedAt)}</td>
            </tr>
          ))}
          {!d.pages.length && (
            <tr>
              <td colSpan={3} className="pg-muted">
                {syncing ? "Reading the site…" : "No pages yet."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

/** A synced page's record: where it comes from. Its settings are the website's. */
export function PagePanel({
  page,
}: {
  page: {
    url: string;
    sourceName: string;
    fetchedAt: string | null;
    status: string;
    reason: string | null;
    excerpt: string | null;
  } | null;
}) {
  if (!page) return null;
  return (
    <section className="pg-knowledge-file" aria-label="Synced page">
      <h3>Synced page</h3>
      <p>
        From <strong>{page.sourceName}</strong>:{" "}
        <a href={page.url} target="_blank" rel="noopener noreferrer">
          {page.url}
        </a>
      </p>
      <p className="pg-muted">
        Last read {when(page.fetchedAt)}
        {page.status !== "active" && page.reason
          ? ` · ${reason(page.reason)}`
          : ""}
      </p>
      {page.excerpt && (
        <blockquote className="pg-knowledge-excerpt">
          {page.excerpt}
          {page.excerpt.length >= 1200 ? "…" : ""}
        </blockquote>
      )}
      <p className="pg-muted">
        Its content comes from the website and updates when the site is synced.
        Who can use it is set on the website, in the Websites tab.
      </p>
    </section>
  );
}
