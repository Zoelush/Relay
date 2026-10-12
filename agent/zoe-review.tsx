import { useEffect, useState } from "react";
import { BookOpen, ThumbsDown, ThumbsUp } from "lucide-react";
import { api } from "./api";
import type { SideMenuState } from "./shell";
import { Card, Field, Frame, message, type Page } from "./settings-ui";
import { ago } from "./zoe-labels";
import { languageName } from "../lib/zoe-voice";

/**
 * Analyze › Review (phase 08, step C2a; docs/AI_STEP11.md): a sample of Zoe's answers, and every
 * answer a customer pushed back on, for a lead to rate. A bad answer for missing or outdated content
 * becomes a content gap, listed on Knowledge gaps (`ReviewedGaps`) and in content health.
 */
export const PROBLEM_NAMES: Record<string, string> = {
  wrong: "Wrong",
  incomplete: "Incomplete",
  missing_content: "Content missing",
  outdated_content: "Content outdated",
  tone: "Tone or wording",
  should_not_answer: "Shouldn't have answered",
};
const PROBLEM_HINTS: Record<string, string> = {
  wrong: "What she said isn't right.",
  incomplete: "Right, but it leaves out something the customer needed.",
  missing_content: "Nothing she could use answers it. Becomes a content gap.",
  outdated_content: "Her source is out of date. Becomes a content gap.",
  tone: "The facts are fine; how she said it isn't.",
  should_not_answer: "A person should have taken this one.",
};
const PUSHBACK_NAMES: Record<string, string> = {
  asked_for_person: "Customer asked for a person next",
  negative_sentiment: "Customer seemed upset next",
};

type Review = {
  id: string;
  conversationId: string;
  source: "sample" | "pushback";
  pushback: string | null;
  answeredAt: string;
  question: string;
  answer: string;
  sources: { id: string; title: string }[];
  language: string | null;
  specialist: string | null;
  rating: "good" | "bad" | null;
  problem: string | null;
  note: string;
  ratedBy: string | null;
  ratedAt: string | null;
  gapId: string | null;
};
type Data = {
  days: number;
  sample: number;
  stats: {
    waiting: number;
    rated: number;
    good: number;
    bad: number;
    goodRate: number | null;
    problems: { problem: string; count: number }[];
  };
  pending: Review[];
  rated: Review[];
};

export function ReviewPage({ menu, page, onGaps }: { menu: SideMenuState; page: Page; onGaps: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"pending" | "rated">("pending");
  const [sample, setSample] = useState("");
  const load = () =>
    api<Data>("zoe?view=review")
      .then((d) => {
        setData(d);
        setSample(String(d.sample));
      })
      .catch((e) => setError(message(e, "This page could not be loaded.")));
  useEffect(() => {
    void load();
  }, []);
  async function change(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const d = await api<Data>("zoe-review", body);
      setData(d);
      setSample(String(d.sample));
      setStatus(done);
    } catch (e) {
      setError(message(e, "That could not be saved."));
      // Someone else rated it first: show what's there now.
      void load();
    } finally {
      setBusy(false);
    }
  }
  const list = data ? (tab === "pending" ? data.pending : data.rated) : [];
  const worst = data ? Math.max(1, ...data.stats.problems.map((p) => p.count)) : 1;
  return (
    <Frame menu={menu} page={page}>
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <p role="status" className="pg-muted pg-zoe-review-status">
        {status}
      </p>
      {data && (
        <>
          <div className="pg-zoe-stats" aria-label={`Last ${data.days} days`}>
            <div className="pg-zoe-stat featured">
              <span>Rated good</span>
              <strong>{data.stats.goodRate === null ? "—" : `${data.stats.goodRate}%`}</strong>
              <small>
                {data.stats.good} of {data.stats.rated} rated in the last {data.days} days
              </small>
            </div>
            <div className="pg-zoe-stat">
              <span>To review</span>
              <strong>{data.stats.waiting}</strong>
              <small>Sampled, or pushed back on</small>
            </div>
            <div className="pg-zoe-stat">
              <span>Rated bad</span>
              <strong>{data.stats.bad}</strong>
              <small>Last {data.days} days</small>
            </div>
          </div>
          {data.stats.problems.length > 0 && (
            <Card title="What was wrong" description="Bad answers in the last 30 days, by what the reviewer said.">
              <ul className="pg-zoe-bars" aria-label="What was wrong">
                {data.stats.problems.map((p) => (
                  <li key={p.problem} data-hue="rose">
                    <span>{PROBLEM_NAMES[p.problem] ?? p.problem}</span>
                    <span className="pg-zoe-bar">
                      <span style={{ width: `${Math.max(2, Math.round((p.count / worst) * 100))}%` }} />
                    </span>
                    <strong>{p.count}</strong>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card
            title="Daily sample"
            description="Once a day is over, this many of its answers join the queue at random. Answers a customer pushed back on always join."
          >
            <form
              className="pg-zoe-review-sample"
              onSubmit={(e) => {
                e.preventDefault();
                void change({ action: "sample", size: Number(sample) }, "Sample size saved.");
              }}
            >
              <Field label="Answers a day" hint="0 to 50. 0 stops sampling.">
                {(id, hint) => (
                  <input
                    id={id}
                    aria-describedby={hint}
                    type="number"
                    min={0}
                    max={50}
                    value={sample}
                    onChange={(e) => setSample(e.target.value)}
                  />
                )}
              </Field>
              <button type="submit" className="pg-zoe-secondary" disabled={busy || sample === String(data.sample)}>
                Save sample size
              </button>
            </form>
          </Card>
          <div className="pg-settings-tabs" role="tablist" aria-label="Answers">
            <button type="button" role="tab" aria-selected={tab === "pending"} onClick={() => setTab("pending")}>
              To review ({data.stats.waiting})
            </button>
            <button type="button" role="tab" aria-selected={tab === "rated"} onClick={() => setTab("rated")}>
              Rated
            </button>
          </div>
          {list.length ? (
            <ul className="pg-zoe-reviews" aria-label={tab === "pending" ? "Answers to review" : "Rated answers"}>
              {list.map((r) => (
                <ReviewItem
                  key={r.id}
                  review={r}
                  busy={busy}
                  onGaps={onGaps}
                  onRate={(body, done) => change({ action: "rate", reviewId: r.id, ...body }, done)}
                />
              ))}
            </ul>
          ) : (
            <p className="pg-zoe-empty">
              {tab === "pending"
                ? "Nothing to review. Each day's sample arrives once the day is over."
                : "No answers rated yet."}
            </p>
          )}
        </>
      )}
    </Frame>
  );
}

function ReviewItem({
  review: r,
  busy,
  onRate,
  onGaps,
}: {
  review: Review;
  busy: boolean;
  onRate: (body: Record<string, unknown>, done: string) => Promise<void>;
  onGaps: () => void;
}) {
  const [bad, setBad] = useState(false);
  const [problem, setProblem] = useState("");
  const [note, setNote] = useState("");
  const question = r.question.length > 80 ? r.question.slice(0, 79) + "…" : r.question;
  return (
    <li className="pg-zoe-review" aria-label={`Answer to “${question}”`}>
      <header>
        <span className="pg-zoe-review-why" data-hue={r.source === "pushback" ? "rose" : "slate"}>
          {r.source === "pushback" ? (PUSHBACK_NAMES[r.pushback ?? ""] ?? "Pushed back on") : "Sampled"}
        </span>
        <small className="pg-muted">
          {ago(r.answeredAt)} · conversation {r.conversationId}
          {r.specialist ? ` · ${r.specialist}` : ""}
          {r.language ? ` · ${languageName(r.language)}` : ""}
        </small>
      </header>
      <div className="pg-zoe-review-turn">
        <span className="pg-muted">Customer</span>
        <p>{r.question}</p>
      </div>
      <div className="pg-zoe-review-turn" data-zoe="true">
        <span className="pg-muted">Zoe</span>
        <p>{r.answer}</p>
      </div>
      {r.sources.length > 0 && (
        <ul className="pg-zoe-review-sources" aria-label="Sources">
          {r.sources.map((s) => (
            <li key={s.id}>
              <BookOpen size={13} aria-hidden="true" /> {s.title}
            </li>
          ))}
        </ul>
      )}
      {r.rating ? (
        <p className="pg-zoe-review-rated" data-rating={r.rating}>
          {r.rating === "good" ? <ThumbsUp size={14} aria-hidden="true" /> : <ThumbsDown size={14} aria-hidden="true" />}
          <span>
            Rated {r.rating}
            {r.problem ? `: ${PROBLEM_NAMES[r.problem]?.toLowerCase() ?? r.problem}` : ""}
            {r.ratedBy ? ` by ${r.ratedBy}` : ""}
            {r.ratedAt ? `, ${ago(r.ratedAt)}` : ""}.
            {r.note ? ` “${r.note}”` : ""}
          </span>
          {r.gapId && (
            <button type="button" className="pg-link-button" onClick={onGaps}>
              In knowledge gaps
            </button>
          )}
        </p>
      ) : bad ? (
        <form
          className="pg-zoe-review-form"
          onSubmit={(e) => {
            e.preventDefault();
            void onRate({ rating: "bad", problem, note }, "Rated bad.");
          }}
        >
          <fieldset>
            <legend>What was wrong?</legend>
            {Object.entries(PROBLEM_NAMES).map(([k, label]) => (
              <label key={k}>
                <input
                  type="radio"
                  name={"problem-" + r.id}
                  value={k}
                  checked={problem === k}
                  onChange={() => setProblem(k)}
                />
                <span>
                  {label}
                  <small className="pg-muted">{PROBLEM_HINTS[k]}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="pg-zoe-review-note">
            <span>Note (optional)</span>
            <textarea value={note} maxLength={1000} rows={2} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="pg-zoe-review-actions">
            <button type="submit" className="pg-zoe-primary" disabled={busy || !problem}>
              Save rating
            </button>
            <button type="button" className="pg-zoe-secondary" onClick={() => setBad(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="pg-zoe-review-actions">
          <button
            type="button"
            className="pg-zoe-secondary"
            disabled={busy}
            onClick={() => void onRate({ rating: "good" }, "Rated good.")}
          >
            <ThumbsUp size={14} aria-hidden="true" /> Good
          </button>
          <button type="button" className="pg-zoe-secondary" disabled={busy} onClick={() => setBad(true)}>
            <ThumbsDown size={14} aria-hidden="true" /> Bad
          </button>
        </div>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Knowledge gaps: the ones reviewers found                                                    */

export type ReviewedGapsData = {
  open: {
    id: string;
    version: string;
    conversationId: string;
    question: string;
    answer: string;
    problem: string;
    note: string;
    createdBy: string | null;
    createdAt: string;
  }[];
  fixed: number;
};

export function ReviewedGaps({ initial }: { initial: ReviewedGapsData }) {
  const [gaps, setGaps] = useState(initial);
  const [fixing, setFixing] = useState<string | null>(null);
  const [record, setRecord] = useState("");
  const [records, setRecords] = useState<{ recordId: string; title: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (fixing && !records)
      api<{ records: { recordId: string; title: string }[] }>("zoe?view=content")
        .then((c) => setRecords(c.records))
        .catch(() => setRecords([]));
  }, [fixing, records]);
  async function move(g: ReviewedGapsData["open"][number], to: "fixed" | "dismissed", done: string) {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const r = await api<{ gaps: ReviewedGapsData }>("zoe-review", {
        action: "gap",
        gapId: g.id,
        version: g.version,
        status: to,
        ...(to === "fixed" && record ? { recordId: record } : {}),
      });
      setGaps(r.gaps);
      setFixing(null);
      setRecord("");
      setStatus(done);
    } catch (e) {
      setError(message(e, "The gap could not be changed."));
    } finally {
      setBusy(false);
    }
  }
  const n = gaps.open.length;
  return (
    <Card
      title="Found in review"
      description={`Answers reviewers rated as missing or outdated content: ${n} open${gaps.fixed ? `, ${gaps.fixed} fixed in the last 30 days` : ""}. Fix the content, then mark the gap fixed.`}
    >
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      <p role="status" className="pg-muted">
        {status}
      </p>
      {n ? (
        <ul className="pg-settings-list pg-zoe-review-gaps" aria-label="Content gaps from review">
          {gaps.open.map((g) => (
            <li key={g.id}>
              <span>
                <strong>{g.question}</strong>
                <small className="pg-muted">
                  {PROBLEM_NAMES[g.problem]}
                  {g.createdBy ? ` · ${g.createdBy}` : ""} · {ago(g.createdAt)} · conversation {g.conversationId}
                </small>
                {g.note && <small>“{g.note}”</small>}
                {fixing === g.id && (
                  <span className="pg-zoe-review-fix">
                    <label>
                      <span>Content that fixes it (optional)</span>
                      <select value={record} onChange={(e) => setRecord(e.target.value)}>
                        <option value="">Not named</option>
                        {(records ?? []).map((r) => (
                          <option key={r.recordId} value={r.recordId}>
                            {r.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className="pg-zoe-primary"
                      disabled={busy}
                      onClick={() => void move(g, "fixed", "Marked fixed.")}
                    >
                      Mark fixed
                    </button>
                    <button type="button" className="pg-zoe-secondary" onClick={() => setFixing(null)}>
                      Cancel
                    </button>
                  </span>
                )}
              </span>
              {fixing !== g.id && (
                <span className="pg-zoe-review-actions">
                  <button type="button" className="pg-zoe-secondary" disabled={busy} onClick={() => setFixing(g.id)}>
                    Fixed…
                  </button>
                  <button
                    type="button"
                    className="pg-zoe-secondary"
                    disabled={busy}
                    onClick={() => void move(g, "dismissed", "Dismissed.")}
                  >
                    Dismiss
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="pg-zoe-empty">No open gaps from review.</p>
      )}
    </Card>
  );
}
