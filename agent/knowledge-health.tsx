import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "./api";

/**
 * Content health (phase 07, step C2b), in Knowledge for `knowledge.manage`: what needs attention.
 * Records never reviewed, records the AI agent and inbox haven't retrieved in 90 days, and
 * near-duplicates found with the AI index (nightly, or "Check now"). Topics customers ask about
 * with no matching content arrive with reporting (phase 14).
 */
type RecordRef = {
  id: string;
  title: string;
  source: string;
  owner: { id: string; name: string };
  firstPublishedAt: string | null;
};
type Run = {
  id: string;
  status: "running" | "done" | "failed";
  checked: number;
  total: number;
  pairs: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};
type Report = {
  neverReviewed: { total: number; records: RecordRef[] };
  notRetrieved: {
    countingSince: string | null;
    listedFrom: string | null;
    total: number;
    records: (RecordRef & {
      usedBy: ("ai" | "inbox")[];
      lastRetrievedOn: string | null;
    })[];
  };
  duplicates:
    | { available: false; reason: string }
    | {
        available: true;
        threshold: number;
        running: Run | null;
        last: Run | null;
        pairs: {
          a: { id: string; title: string; source: string };
          b: { id: string; title: string; source: string };
          similarity: number;
        }[];
      };
  gaps: { available: false; reason: string } | { available: true };
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
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString() : "";
const percent = (n: number) => `${Math.round(n * 100)}%`;
const untitled = (t: string) => t || "Untitled";

export function ContentHealth({
  onOpen,
}: {
  onOpen: (recordId: string) => void;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [reload, setReload] = useState(0);
  const load = useCallback(
    () =>
      api<Report>("knowledge-health")
        .then((r) => {
          setReport(r);
          setError("");
        })
        .catch((e) =>
          setError(message(e, "Content health could not be loaded.")),
        ),
    [],
  );
  useEffect(() => {
    void load();
  }, [load, reload]);
  // While a check runs, refresh every two seconds (for up to ten minutes).
  const running = report?.duplicates.available && !!report.duplicates.running;
  const polls = useRef(0);
  useEffect(() => {
    if (!running) {
      polls.current = 0;
      return;
    }
    if (++polls.current > 300) return;
    const timer = setTimeout(() => setReload((n) => n + 1), 2000);
    return () => clearTimeout(timer);
  }, [running, report]);

  async function act(
    key: string,
    path: string,
    body: Record<string, unknown>,
    done: string,
  ) {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await api(path, body);
      setNotice(done);
    } catch (e) {
      setError(message(e, "That didn't work."));
    } finally {
      setBusy("");
      setReload((n) => n + 1);
    }
  }
  const open = (id: string, title: string) => (
    <button
      type="button"
      className="pg-link-button"
      aria-label={`Open ${untitled(title)}`}
      onClick={() => onOpen(id)}
    >
      {untitled(title)}
    </button>
  );
  const d = report?.duplicates;
  const n = report?.notRetrieved;
  return (
    <div className="pg-help pg-ai-index pg-health">
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="pg-settings-notice">
          {notice}
        </p>
      )}
      {report && (
        <>
          <ul className="pg-health-summary" aria-label="Summary">
            <li>
              <strong>{report.neverReviewed.total}</strong>
              <small>never reviewed</small>
            </li>
            <li>
              <strong>{n!.total}</strong>
              <small>not retrieved in 90 days</small>
            </li>
            <li>
              <strong>{d!.available ? d!.pairs.length : "–"}</strong>
              <small>near-duplicate pairs</small>
            </li>
          </ul>

          <section className="pg-index-card" aria-labelledby="health-reviewed">
            <h3 id="health-reviewed">Never reviewed</h3>
            <p className="pg-muted">
              Published content nobody has checked since it was written. Read it
              through, then mark it reviewed.
            </p>
            {!report.neverReviewed.records.length ? (
              <p className="pg-muted">
                Everything published has been reviewed.
              </p>
            ) : (
              <ul className="pg-settings-list" aria-label="Never reviewed">
                {report.neverReviewed.records.map((r) => (
                  <li key={r.id}>
                    <span>
                      <strong>{open(r.id, r.title)}</strong>
                      <small className="pg-muted">
                        {SOURCE_NAMES[r.source] ?? r.source} · {r.owner.name}
                        {r.firstPublishedAt &&
                          ` · published ${day(r.firstPublishedAt)}`}
                      </small>
                    </span>
                    <button
                      type="button"
                      disabled={busy === r.id}
                      aria-label={`Mark ${untitled(r.title)} reviewed`}
                      onClick={() =>
                        void act(
                          r.id,
                          "knowledge",
                          { op: "review", id: r.id },
                          `Marked ${untitled(r.title)} reviewed.`,
                        )
                      }
                    >
                      Mark reviewed
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {report.neverReviewed.total >
              report.neverReviewed.records.length && (
              <p className="pg-muted pg-settings-small">
                Showing the oldest {report.neverReviewed.records.length} of{" "}
                {report.neverReviewed.total}.
              </p>
            )}
          </section>

          <section className="pg-index-card" aria-labelledby="health-unused">
            <h3 id="health-unused">Not retrieved in 90 days</h3>
            <p className="pg-muted">
              Content the AI agent or the inbox can use that no search has
              returned in 90 days. It may be out of date, hard to find, or no
              longer needed.
            </p>
            {!n!.countingSince ? (
              <p className="pg-muted">
                Retrievals are counted once the AI index is built.
              </p>
            ) : (
              <>
                <p className="pg-muted pg-settings-small">
                  Retrievals counted since {day(n!.countingSince)}. Content is
                  listed once it has been usable for 90 days of counting
                  {new Date(n!.listedFrom!) > new Date()
                    ? `, so the first can appear on ${day(n!.listedFrom)}`
                    : ""}
                  .
                </p>
                {!n!.records.length ? (
                  <p className="pg-muted">Nothing to show.</p>
                ) : (
                  <ul
                    className="pg-settings-list"
                    aria-label="Not retrieved in 90 days"
                  >
                    {n!.records.map((r) => (
                      <li key={r.id}>
                        <span>
                          <strong>{open(r.id, r.title)}</strong>
                          <small className="pg-muted">
                            {SOURCE_NAMES[r.source] ?? r.source} · used by{" "}
                            {r.usedBy
                              .map((u) =>
                                u === "ai" ? "the AI agent" : "the inbox",
                              )
                              .join(" and ")}{" "}
                            ·{" "}
                            {r.lastRetrievedOn
                              ? `last retrieved ${day(r.lastRetrievedOn)}`
                              : "never retrieved"}
                          </small>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          <section
            className="pg-index-card"
            aria-labelledby="health-duplicates"
          >
            <h3 id="health-duplicates">Near-duplicates</h3>
            {!d!.available ? (
              <p role="note" className="pg-muted">
                {d!.reason}
              </p>
            ) : (
              <>
                <p className="pg-muted">
                  Pairs with passages {percent(d!.threshold)} or more alike.
                  Merge them, or link one from the other, so the AI agent and
                  customers get one answer. Checked nightly.
                </p>
                <div className="pg-help-bar">
                  <button
                    type="button"
                    disabled={!!d!.running || busy === "check"}
                    onClick={() =>
                      void act(
                        "check",
                        "knowledge-health",
                        { action: "check" },
                        "Checking for near-duplicates.",
                      )
                    }
                  >
                    <RefreshCw size={14} aria-hidden="true" /> Check now
                  </button>
                  <span className="pg-muted" role="status">
                    {d!.running
                      ? `Checking… ${d!.running.checked} of ${d!.running.total} passages`
                      : d!.last
                        ? d!.last.status === "failed"
                          ? `The last check stopped: ${d!.last.error ?? "unknown error"}`
                          : `Last checked ${new Date(d!.last.finishedAt!).toLocaleString()}`
                        : "Not checked yet."}
                  </span>
                </div>
                {d!.last?.status === "done" && !d!.pairs.length && (
                  <p className="pg-muted">No near-duplicates.</p>
                )}
                {d!.pairs.length > 0 && (
                  <ul className="pg-settings-list" aria-label="Near-duplicates">
                    {d!.pairs.map((p) => (
                      <li key={p.a.id + p.b.id}>
                        <span>
                          <strong className="pg-health-pair">
                            {open(p.a.id, p.a.title)}
                            <span aria-hidden="true">↔</span>
                            {open(p.b.id, p.b.title)}
                          </strong>
                          <small className="pg-muted">
                            {percent(p.similarity)} alike ·{" "}
                            {SOURCE_NAMES[p.a.source] ?? p.a.source} and{" "}
                            {(
                              SOURCE_NAMES[p.b.source] ?? p.b.source
                            ).toLowerCase()}
                          </small>
                        </span>
                        <button
                          type="button"
                          disabled={busy === p.a.id + p.b.id}
                          aria-label={`${untitled(p.a.title)} and ${untitled(p.b.title)} are not duplicates`}
                          onClick={() =>
                            void act(
                              p.a.id + p.b.id,
                              "knowledge-health",
                              {
                                action: "dismiss",
                                recordA: p.a.id,
                                recordB: p.b.id,
                              },
                              "Dismissed. They come back only if either one changes.",
                            )
                          }
                        >
                          Not duplicates
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          <section className="pg-index-card" aria-labelledby="health-gaps">
            <h3 id="health-gaps">Topics with no content</h3>
            <p className="pg-muted">
              {report.gaps.available
                ? "Questions customers ask that nothing answers."
                : report.gaps.reason}
            </p>
          </section>
        </>
      )}
    </div>
  );
}
