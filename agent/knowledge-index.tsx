import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { api } from "./api";

/**
 * The AI index (phase 07, step C2a), in Knowledge for `knowledge.manage`: which model and version
 * the index uses, how much it holds, what waits, a re-embed in progress (search keeps using the
 * current version until the new one is complete), and "Try a question": the passages the AI agent
 * or the inbox would find, best first.
 */
type Version = {
  id: string;
  model: string;
  version: string;
  dimensions: number;
  chunks: number;
  records: number;
  done: number;
  total: number;
  startedAt: string;
  activatedAt: string | null;
};
type Status = {
  available: boolean;
  active: Version | null;
  building: Version | null;
  pending: number;
  job: { state: string; error: string | null } | null;
  model: { model: string; version: string; dimensions: number } | null;
};
type Result = {
  recordId: string;
  title: string;
  locale: string;
  source: string;
  heading: string;
  text: string;
  score: number;
};
const SOURCE_NAMES: Record<string, string> = {
  article: "Article",
  internal_article: "Internal article",
  snippet: "Snippet",
  file: "File",
  external_page: "Synced page",
};
const message = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : "";

export function AiIndex({ onOpen }: { onOpen: (recordId: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [starting, setStarting] = useState(false);
  const load = useCallback(
    () =>
      api<Status>("knowledge-index")
        .then((s) => {
          setStatus(s);
          setError("");
        })
        .catch((e) =>
          setError(message(e, "The AI index could not be loaded.")),
        ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load, reload]);
  // While indexing has work, refresh every two seconds (for up to ten minutes).
  const polls = useRef(0);
  const busy =
    !!status?.building ||
    !!status?.pending ||
    status?.job?.state === "queued" ||
    status?.job?.state === "running";
  useEffect(() => {
    if (!busy) {
      polls.current = 0;
      return;
    }
    if (++polls.current > 300) return;
    const timer = setTimeout(() => setReload((n) => n + 1), 2000);
    return () => clearTimeout(timer);
  }, [busy, status]);

  async function rebuild() {
    setStarting(true);
    try {
      await api("knowledge-index", { action: "rebuild" });
      setReload((n) => n + 1);
    } catch (e) {
      setError(message(e, "The re-embed could not start."));
    } finally {
      setStarting(false);
    }
  }
  const a = status?.active,
    b = status?.building;
  return (
    <div className="pg-help pg-ai-index">
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {status && !status.available && (
        <p className="pg-muted">
          The AI index isn&apos;t available here: no embedding model or vector
          store is connected.
        </p>
      )}
      {status && (
        <section className="pg-index-card" aria-labelledby="index-active">
          <h3 id="index-active">Current index</h3>
          {a ? (
            <dl>
              <dt>Model</dt>
              <dd>
                {a.model} · version {a.version} · {a.dimensions} dimensions
              </dd>
              <dt>Holds</dt>
              <dd>
                {a.records.toLocaleString()}{" "}
                {a.records === 1 ? "record" : "records"} in{" "}
                {a.chunks.toLocaleString()}{" "}
                {a.chunks === 1 ? "passage" : "passages"}
              </dd>
              <dt>In use since</dt>
              <dd>{when(a.activatedAt)}</dd>
            </dl>
          ) : (
            <p className="pg-muted">
              The first index is being built. Searches start working when it
              finishes.
            </p>
          )}
          <p role="status" className="pg-index-state">
            {status.pending
              ? `${status.pending.toLocaleString()} ${status.pending === 1 ? "record is" : "records are"} waiting to be indexed.`
              : "Up to date with published content."}
          </p>
          {status.job?.error && status.job.state !== "succeeded" && (
            <p role="alert" className="pg-attr-error">
              The last indexing step failed ({status.job.error}). It retries
              automatically.
            </p>
          )}
        </section>
      )}
      {b && (
        <section
          className="pg-index-card"
          aria-labelledby="index-building"
          aria-live="polite"
        >
          <h3 id="index-building">Re-embedding</h3>
          <p>
            {b.model} · version {b.version}: {b.done.toLocaleString()} of{" "}
            {b.total.toLocaleString()} records
          </p>
          <progress
            max={Math.max(b.total, 1)}
            value={b.done}
            aria-label="Re-embedding progress"
          />
          <p className="pg-muted">
            Searches keep using the current index until this finishes, then
            switch over at once.
          </p>
        </section>
      )}
      {status?.available && (
        <div className="pg-help-bar">
          <button
            type="button"
            disabled={!!b || starting}
            onClick={() => void rebuild()}
          >
            <RefreshCw size={14} aria-hidden="true" /> Re-embed everything
          </button>
          {status.model && (
            <span className="pg-muted">
              with {status.model.model} · version {status.model.version}
            </span>
          )}
        </div>
      )}
      {status?.available && <TryQuestion onOpen={onOpen} />}
    </div>
  );
}

function TryQuestion({ onOpen }: { onOpen: (recordId: string) => void }) {
  const [query, setQuery] = useState("");
  const [purpose, setPurpose] = useState<"ai" | "inbox">("ai");
  const [answer, setAnswer] = useState<{
    ready: boolean;
    results: Result[];
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function ask() {
    if (!query.trim()) return;
    setBusy(true);
    setError("");
    try {
      setAnswer(
        await api(
          "knowledge-retrieve?" +
            new URLSearchParams({ q: query.trim(), purpose }),
        ),
      );
    } catch (e) {
      setAnswer(null);
      setError(message(e, "The question could not be tried."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="pg-index-card" aria-labelledby="index-try">
      <h3 id="index-try">Try a question</h3>
      <p className="pg-muted">
        See which passages would be found, best first. The AI agent sees content
        switched on for it with a customer audience; the inbox also sees
        internal content.
      </p>
      <form
        className="pg-help-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <input
          aria-label="Question"
          placeholder="How long does a refund take?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="Search as"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value as "ai" | "inbox")}
        >
          <option value="ai">AI agent</option>
          <option value="inbox">Inbox</option>
        </select>
        <button type="submit" disabled={busy || !query.trim()}>
          <Search size={14} aria-hidden="true" /> Search
        </button>
      </form>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {answer && !answer.ready && (
        <p className="pg-muted">
          The index is still being built. Try again in a moment.
        </p>
      )}
      {answer?.ready && !answer.results.length && (
        <p className="pg-muted">Nothing found for this question.</p>
      )}
      {answer?.ready && answer.results.length > 0 && (
        <ol className="pg-index-results" aria-label="Passages found">
          {answer.results.map((r, i) => (
            <li key={r.recordId + i}>
              <header>
                <button type="button" onClick={() => onOpen(r.recordId)}>
                  {r.title || "Untitled"}
                </button>
                <span className="pg-muted">
                  {SOURCE_NAMES[r.source] ?? r.source} · {r.locale}
                  {r.heading ? ` · ${r.heading}` : ""} · match{" "}
                  {Math.round(r.score * 100)}%
                </span>
              </header>
              <p>{r.text}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
