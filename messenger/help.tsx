import { useEffect, useState } from "react";
import { ArticleText } from "../lib/rich-view";
import type { language } from "./strings";

/**
 * The messenger's Help space (phase 07, step B2): the brand's help center inside the messenger.
 * Browse collections, search, read articles (videos open in a new tab: the messenger loads no
 * third-party frames), and say whether an article helped. Each search hands its signed receipt
 * up, which "search before contacting" needs; "Talk to us" after a "No" starts a conversation
 * that carries the article for the teammate.
 */
type Strings = ReturnType<typeof language>["strings"];
type Request = <T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  key?: string,
) => Promise<T>;
type Home = {
  available: boolean;
  signInRequired?: boolean;
  name?: string;
  collections: {
    id: string;
    name: string;
    description: string;
    articles: number;
  }[];
};
type Listed = { id: string; title: string };
type Collection = {
  id: string;
  name: string;
  description: string;
  articles: Listed[];
  sections: { id: string; name: string; articles: Listed[] }[];
};
type Article = {
  id: string;
  locale: string;
  title: string;
  doc: unknown;
  text: string;
  /** Short-lived signed addresses of the article's images, by file id (phase 07 C1a). */
  images: Record<string, string>;
};
type View =
  | { kind: "home" }
  | { kind: "results" }
  | { kind: "collection"; id: string }
  | { kind: "article"; id: string; queryId?: string | null };

export function HelpSpace({
  request,
  api,
  t,
  onSearched,
  onTalk,
}: {
  request: Request;
  /** The Relay API origin, which serves article images. */
  api: string;
  t: Strings;
  /** A search happened: its signed receipt (for "search before contacting"). */
  onSearched: (receipt: string) => void;
  /** "Talk to us" after a "No": start a conversation about this article. */
  onTalk: (context: {
    articleId: string;
    feedbackId: string;
    comment: string;
  }) => void;
}) {
  const [home, setHome] = useState<Home | null>(null);
  const [view, setView] = useState<View>({ kind: "home" });
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{
    query: string;
    queryId: string | null;
    items: (Listed & { excerpt: string })[];
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    request<Home>("help")
      .then((h) => live && setHome(h))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [request]);
  async function search(event: React.FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    setError("");
    try {
      const r = await request<{
        results: (Listed & { excerpt: string })[];
        queryId: string | null;
        receipt: string | null;
      }>("help/search?" + new URLSearchParams({ q }));
      setResults({ query: q, queryId: r.queryId, items: r.results });
      if (r.receipt) onSearched(r.receipt);
      setView({ kind: "results" });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!home) return <p className="muted">{error}</p>;
  if (!home.available) return <p>{t.unavailable}</p>;
  if (home.signInRequired) return <p>{t.helpSignIn}</p>;
  const back =
    view.kind === "home" ? null : (
      <button
        type="button"
        className="link help-back"
        onClick={() =>
          setView(
            view.kind === "article" && results
              ? { kind: "results" }
              : { kind: "home" },
          )
        }
      >
        ‹ {t.helpBack}
      </button>
    );
  const list = (items: Listed[], queryId?: string | null) => (
    <ul className="help-list">
      {items.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => setView({ kind: "article", id: a.id, queryId })}
          >
            {a.title}
          </button>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="help-space">
      {view.kind !== "article" && (
        <form role="search" className="help-search" onSubmit={search}>
          <input
            type="search"
            aria-label={t.searchHelp}
            placeholder={t.searchHelp}
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit">{t.searchButton}</button>
        </form>
      )}
      {back}
      {error && <p role="alert">{error}</p>}
      {view.kind === "home" && (
        <ul className="help-collections">
          {home.collections.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="card"
                onClick={() => setView({ kind: "collection", id: c.id })}
              >
                <strong>{c.name}</strong>
                {c.description && <span>{c.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {view.kind === "results" && results && (
        <section aria-label={t.searchHelp}>
          {results.items.length ? (
            list(results.items, results.queryId)
          ) : (
            <p role="status">{t.noHelpResults}</p>
          )}
        </section>
      )}
      {view.kind === "collection" && (
        <CollectionView id={view.id} request={request} list={list} />
      )}
      {view.kind === "article" && (
        <ArticleView
          key={view.id}
          id={view.id}
          queryId={view.queryId}
          request={request}
          api={api}
          t={t}
          onTalk={onTalk}
        />
      )}
    </div>
  );
}

function CollectionView({
  id,
  request,
  list,
}: {
  id: string;
  request: Request;
  list: (items: Listed[]) => React.ReactNode;
}) {
  const [c, setC] = useState<Collection | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    request<Collection>("help/collection?" + new URLSearchParams({ id }))
      .then((x) => live && setC(x))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [id, request]);
  if (!c) return <p className="muted">{error}</p>;
  return (
    <section aria-label={c.name}>
      <h2>{c.name}</h2>
      {c.description && <p className="muted">{c.description}</p>}
      {c.articles.length > 0 && list(c.articles)}
      {c.sections.map((s) => (
        <section key={s.id} aria-label={s.name}>
          <h3>{s.name}</h3>
          {list(s.articles)}
        </section>
      ))}
    </section>
  );
}

function ArticleView({
  id,
  queryId,
  request,
  api,
  t,
  onTalk,
}: {
  id: string;
  queryId?: string | null;
  request: Request;
  api: string;
  t: Strings;
  onTalk: (context: {
    articleId: string;
    feedbackId: string;
    comment: string;
  }) => void;
}) {
  const [article, setArticle] = useState<Article | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState<
    { state: "ask" } | { state: "comment"; id: string } | { state: "thanks" }
  >({ state: "ask" });
  const [comment, setComment] = useState("");
  useEffect(() => {
    let live = true;
    request<Article>(
      "help/article?" +
        new URLSearchParams({ id, ...(queryId ? { query: queryId } : {}) }),
    )
      .then((a) => live && setArticle(a))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [id, queryId, request]);
  async function vote(helpful: boolean) {
    setError("");
    try {
      const r = await request<{ id: string }>("help/feedback", {
        articleId: id,
        helpful,
      });
      setFeedback(
        helpful ? { state: "thanks" } : { state: "comment", id: r.id },
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function sendComment(talk: boolean) {
    if (feedback.state !== "comment") return;
    setError("");
    try {
      if (comment.trim())
        await request("help/feedback", {
          articleId: id,
          feedbackId: feedback.id,
          comment: comment.trim(),
        });
      if (talk)
        onTalk({
          articleId: id,
          feedbackId: feedback.id,
          comment: comment.trim(),
        });
      else setFeedback({ state: "thanks" });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!article) return <p className="muted">{error}</p>;
  return (
    <article className="help-article" lang={article.locale}>
      <h2>{article.title}</h2>
      <ArticleText
        doc={article.doc}
        fallback={article.text}
        // Links between articles open in the Help space's own help center pages later; for now
        // they read as plain text inside the messenger.
        link={() => null}
        videos="link"
        image={(image) =>
          article.images?.[image.attachmentId] ? (
            <img
              src={api + article.images[image.attachmentId]}
              alt={image.alt ?? ""}
              loading="lazy"
            />
          ) : (
            <span className="muted">{image.alt}</span>
          )
        }
      />
      <section className="help-feedback" aria-label={t.helpfulQuestion}>
        {feedback.state === "ask" && (
          <>
            <span>{t.helpfulQuestion}</span>
            <button type="button" onClick={() => void vote(true)}>
              {t.yes}
            </button>
            <button type="button" onClick={() => void vote(false)}>
              {t.no}
            </button>
          </>
        )}
        {feedback.state === "comment" && (
          <>
            <label>
              {t.feedbackTellUs}
              <textarea
                rows={3}
                maxLength={1000}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </label>
            <div className="help-feedback-actions">
              <button type="button" onClick={() => void sendComment(false)}>
                {t.feedbackSend}
              </button>
              <button
                type="button"
                className="help-talk"
                onClick={() => void sendComment(true)}
              >
                {t.talkToUs}
              </button>
            </div>
          </>
        )}
        {feedback.state === "thanks" && <p role="status">{t.feedbackThanks}</p>}
      </section>
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
