import { useCallback, useEffect, useRef, useState } from "react";
import { api, InboxError } from "./api";
import { ArticleEditor } from "./article-editor";
import { HelpCenters } from "./help-centers";
import { preferredLocale, teammateLanguages } from "./locales";
import { SLUG, slugify } from "../lib/help-paths";
import type { RichDoc } from "../lib/rich-doc";

/**
 * The Knowledge section (phase 07, step A1): articles, internal articles and snippets, each with
 * one draft and one published version per language, autosave, publishing, and version history.
 * Teammates without `knowledge.manage` read what is published and available to the inbox.
 */
type Source =
  "article" | "internal_article" | "snippet" | "file" | "external_page";
type Audience = "public" | "signed_in" | "internal";
type Summary = {
  id: string;
  source: Source;
  audience: Audience;
  forAi: boolean;
  forHelpCenter: boolean;
  forInbox: boolean;
  owner: { id: string; name: string };
  lastReviewedAt: string | null;
  updatedAt: string;
  locales: { locale: string; status: string; title: string }[];
};
type Locale = {
  locale: string;
  slug: string | null;
  status: "draft" | "published" | "archived";
  draft: {
    title: string;
    body: RichDoc | null;
    version: string;
    updatedAt: string;
  } | null;
  published: {
    title: string;
    body: RichDoc | null;
    revision: number;
    publishedAt: string;
  } | null;
  changed: boolean;
};
type Detail = {
  id: string;
  source: Source;
  ownerId: string;
  audience: Audience;
  forAi: boolean;
  forHelpCenter: boolean;
  forInbox: boolean;
  faq: boolean;
  lastReviewedAt: string | null;
  version: string;
  locales: Locale[];
  revisions: {
    locale: string;
    revision: number;
    title: string;
    createdAt: string;
    by: string | null;
  }[];
  /** Phase 07 B2: readers' votes and comments (for knowledge.manage). */
  feedback: {
    helpful: number;
    unhelpful: number;
    comments: { comment: string; locale: string; createdAt: string }[];
  } | null;
  canManage: boolean;
};

export const SOURCE_NAMES: Record<Source, string> = {
  article: "Article",
  internal_article: "Internal article",
  snippet: "Snippet",
  file: "File",
  external_page: "Synced page",
};
const AUDIENCE_NAMES: Record<Audience, string> = {
  public: "Everyone",
  signed_in: "Signed-in customers",
  internal: "Teammates only (internal)",
};
const STATUS_NAMES = {
  draft: "Draft",
  published: "Published",
  archived: "Archived",
};
const message = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;
const when = (iso: string) => new Date(iso).toLocaleString();

export function Knowledge({
  teammates,
}: {
  teammates: { id: string; name: string; deleted?: boolean }[];
}) {
  const [records, setRecords] = useState<Summary[]>([]);
  const [tab, setTab] = useState<"content" | "help">("content");
  const [canManage, setCanManage] = useState(false);
  const [source, setSource] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams();
    if (source) q.set("source", source);
    if (query.trim()) q.set("q", query.trim());
    const timer = setTimeout(() => {
      api<{ records: Summary[]; canManage: boolean }>("knowledge?" + q)
        .then((d) => {
          if (!live) return;
          setRecords(d.records);
          setCanManage(d.canManage);
          setError("");
        })
        .catch(
          (e) => live && setError(message(e, "Knowledge could not be loaded.")),
        );
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, query, reload]);
  async function create(kind: Source) {
    try {
      const r = await api<{ id: string }>("knowledge", {
        op: "create",
        source: kind,
        locale: "en",
        title: "",
      });
      setSelected(r.id);
      setReload((n) => n + 1);
    } catch (e) {
      setError(message(e, "It could not be created."));
    }
  }
  return (
    <section className="pg-workspace pg-knowledge" aria-label="Knowledge">
      <header className="pg-top">
        <h1>Knowledge</h1>
        {canManage && (
          <div
            role="tablist"
            aria-label="Knowledge areas"
            className="pg-knowledge-tabs"
          >
            <button
              role="tab"
              aria-selected={tab === "content"}
              onClick={() => setTab("content")}
            >
              Content
            </button>
            <button
              role="tab"
              aria-selected={tab === "help"}
              onClick={() => setTab("help")}
            >
              Help centers
            </button>
          </div>
        )}
        {canManage && tab === "content" && (
          <div className="pg-knowledge-new">
            <button onClick={() => create("article")}>New article</button>
            <button onClick={() => create("internal_article")}>
              New internal article
            </button>
            <button onClick={() => create("snippet")}>New snippet</button>
          </div>
        )}
      </header>
      {error && (
        <div className="pg-error" role="alert">
          {error}
        </div>
      )}
      {tab === "help" && canManage ? (
        <HelpCenters />
      ) : (
        <div className="pg-columns">
          <section className="pg-list" aria-label="Knowledge records">
            <div className="pg-knowledge-filters">
              <input
                aria-label="Search knowledge"
                placeholder="Search titles"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select
                aria-label="Kind"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                <option value="">All kinds</option>
                {Object.entries(SOURCE_NAMES).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <ul className="pg-knowledge-list">
              {records.map((r) => (
                <li key={r.id}>
                  <button
                    aria-current={selected === r.id}
                    onClick={() => setSelected(r.id)}
                  >
                    <strong>
                      {preferredLocale(r.locales, teammateLanguages())?.title ||
                        "Untitled"}
                    </strong>
                    <span className="pg-muted">
                      {SOURCE_NAMES[r.source]} ·{" "}
                      {r.locales
                        .map(
                          (l) =>
                            `${l.locale} ${STATUS_NAMES[l.status as Locale["status"]] ?? l.status}`,
                        )
                        .join(", ")}
                    </span>
                  </button>
                </li>
              ))}
              {records.length === 0 && (
                <li className="pg-muted">Nothing here yet.</li>
              )}
            </ul>
          </section>
          <section
            className="pg-thread pg-knowledge-record"
            aria-label="Knowledge record"
          >
            {selected ? (
              <RecordView
                key={selected}
                id={selected}
                teammates={teammates}
                records={records
                  .filter((r) => r.id !== selected)
                  .map((r) => ({
                    id: r.id,
                    title:
                      preferredLocale(r.locales, teammateLanguages())?.title ??
                      "",
                  }))}
                onChanged={() => setReload((n) => n + 1)}
              />
            ) : (
              <div className="pg-welcome">
                <h2>Choose something to read or edit</h2>
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  );
}

type SaveState =
  "saved" | "saving" | "unsaved" | "conflict" | "invalid" | "failed";
const SAVE_WORDS: Record<SaveState, string> = {
  saved: "All changes saved",
  saving: "Saving…",
  unsaved: "Unsaved changes",
  conflict: "This draft changed in another tab or by another teammate.",
  invalid: "",
  failed: "Not saved. Retrying when you next type.",
};

function RecordView({
  id,
  teammates,
  records,
  onChanged,
}: {
  id: string;
  teammates: { id: string; name: string; deleted?: boolean }[];
  records: { id: string; title: string }[];
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [locale, setLocale] = useState("");
  /** Changes when the editor must reload its content (another language, a restore, a reload). */
  const [loaded, setLoaded] = useState(0);
  const [save, setSave] = useState<SaveState>("saved");
  const [invalid, setInvalid] = useState("");
  const [notice, setNotice] = useState("");
  const [title, setTitle] = useState("");
  const [newLocale, setNewLocale] = useState("");
  // The draft as typed, and the draft version it was based on (for conflict detection).
  const draft = useRef<{
    title: string;
    body: RichDoc | null;
    version: string;
    dirty: boolean;
    inFlight: Promise<void> | null;
  }>({
    title: "",
    body: null,
    version: "0",
    dirty: false,
    inFlight: null,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A conflict stops autosave until the teammate reloads, so nothing is overwritten.
  const conflicted = useRef(false);

  const show = useCallback((d: Detail, pick?: string) => {
    setDetail(d);
    const l =
      d.locales.find((x) => x.locale === pick) ??
      preferredLocale(d.locales, teammateLanguages());
    setLocale(l?.locale ?? "");
    draft.current = {
      title: l?.draft?.title ?? "",
      body: l?.draft?.body ?? null,
      version: l?.draft?.version ?? "0",
      dirty: false,
      inFlight: null,
    };
    setTitle(l?.draft?.title ?? l?.published?.title ?? "");
    conflicted.current = false;
    setSave("saved");
    setInvalid("");
    setLoaded((n) => n + 1);
  }, []);
  const fetchDetail = useCallback(
    () => api<Detail>("knowledge-record?id=" + encodeURIComponent(id)),
    [id],
  );
  const load = useCallback(
    async (pick?: string) => {
      try {
        show(await fetchDetail(), pick);
      } catch (e) {
        setNotice(message(e, "This could not be loaded."));
      }
    },
    [fetchDetail, show],
  );
  useEffect(() => {
    let live = true;
    fetchDetail()
      .then((d) => live && show(d))
      .catch((e) => live && setNotice(message(e, "This could not be loaded.")));
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [fetchDetail, show]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const d = draft.current;
    if (d.inFlight) await d.inFlight;
    if (conflicted.current) return false;
    if (!d.dirty) return true;
    d.dirty = false;
    setSave("saving");
    let ok = true;
    d.inFlight = api<{ draftVersion: string }>("knowledge", {
      op: "save",
      id,
      locale,
      title: d.title,
      body: d.body,
      draftVersion: d.version,
    })
      .then((r) => {
        d.version = String(r.draftVersion);
        // The draft now differs from what is live.
        setDetail(
          (x) =>
            x && {
              ...x,
              locales: x.locales.map((l) =>
                l.locale === locale ? { ...l, changed: true } : l,
              ),
            },
        );
        setSave(d.dirty ? "unsaved" : "saved");
      })
      .catch((e) => {
        ok = false;
        if (e instanceof InboxError && e.code === "DRAFT_CONFLICT") {
          conflicted.current = true;
          setSave("conflict");
        } else {
          d.dirty = true;
          setSave("failed");
          setNotice(message(e, "The draft could not be saved."));
        }
      })
      .finally(() => {
        d.inFlight = null;
      });
    await d.inFlight;
    return ok;
  }, [id, locale]);

  const edited = () => {
    draft.current.dirty = true;
    setSave((s) => (s === "conflict" ? s : "unsaved"));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 800);
  };

  async function run(
    body: Record<string, unknown>,
    done: string,
    pick = locale,
  ) {
    setNotice("");
    try {
      if (!(await flush())) return;
      await api("knowledge", {
        id,
        locale,
        draftVersion: draft.current.version,
        ...body,
      });
      await load(pick);
      setNotice(done);
      onChanged();
    } catch (e) {
      if (e instanceof InboxError && e.code === "DRAFT_CONFLICT") {
        conflicted.current = true;
        setSave("conflict");
      } else setNotice(message(e, "That did not work."));
    }
  }

  if (!detail) return <div className="pg-muted">{notice || "Loading…"}</div>;
  const current = detail.locales.find((l) => l.locale === locale);
  if (!detail.canManage)
    return (
      <article className="pg-knowledge-read">
        <h2>{current?.published?.title}</h2>
        {current?.published && (
          <ArticleEditor
            value={{
              key: `${id}:${locale}:${loaded}`,
              doc: current.published.body,
            }}
            editable={false}
            records={records}
            onChange={() => {}}
          />
        )}
      </article>
    );
  return (
    <div className="pg-knowledge-edit">
      <div
        role="tablist"
        aria-label="Languages"
        className="pg-knowledge-locales"
      >
        {detail.locales.map((l) => (
          <button
            key={l.locale}
            role="tab"
            aria-selected={l.locale === locale}
            onClick={async () => {
              if (l.locale === locale || !(await flush())) return;
              await load(l.locale);
            }}
          >
            {l.locale} · {STATUS_NAMES[l.status]}
            {l.status === "published" && l.changed ? " (changes)" : ""}
          </button>
        ))}
        <form
          className="pg-knowledge-add-locale"
          onSubmit={(e) => {
            e.preventDefault();
            const value = newLocale.trim();
            if (!value) return;
            setNewLocale("");
            void (async () => {
              setNotice("");
              try {
                const r = await api<{ locale: string }>("knowledge", {
                  op: "add_locale",
                  id,
                  locale: value,
                  fromLocale: locale,
                });
                await load(r.locale);
                onChanged();
              } catch (e) {
                setNotice(message(e, "That language could not be added."));
              }
            })();
          }}
        >
          <input
            aria-label="New language"
            placeholder="Add language, e.g. fr"
            value={newLocale}
            onChange={(e) => setNewLocale(e.target.value)}
          />
          <button type="submit">Add language</button>
        </form>
      </div>
      <div className="pg-knowledge-actions">
        <span
          role="status"
          className={
            save === "conflict" || save === "failed"
              ? "pg-knowledge-warn"
              : "pg-muted"
          }
        >
          {save === "invalid" ? invalid : SAVE_WORDS[save]}
        </span>
        {save === "conflict" && (
          <button onClick={() => load(locale)}>Reload the latest</button>
        )}
        <button
          disabled={
            save === "conflict" ||
            save === "invalid" ||
            (current?.status === "published" &&
              !current.changed &&
              save === "saved")
          }
          onClick={() => run({ op: "publish" }, "Published.")}
        >
          {current?.published ? "Publish changes" : "Publish"}
        </button>
        {current?.status === "published" && (
          <button onClick={() => run({ op: "unpublish" }, "Unpublished.")}>
            Unpublish
          </button>
        )}
        {current?.status !== "archived" && (
          <button onClick={() => run({ op: "archive" }, "Archived.")}>
            Archive
          </button>
        )}
      </div>
      {notice && (
        <div className="pg-knowledge-notice" role="alert">
          {notice}
        </div>
      )}
      <input
        className="pg-knowledge-title"
        aria-label="Title"
        placeholder="Title"
        value={title}
        readOnly={save === "conflict"}
        onChange={(e) => {
          setTitle(e.target.value);
          draft.current.title = e.target.value;
          edited();
        }}
      />
      <ArticleEditor
        value={{
          key: `${id}:${locale}:${loaded}`,
          doc: current?.draft?.body ?? null,
        }}
        editable={save !== "conflict"}
        records={records}
        onChange={(doc, error) => {
          if (error) {
            setInvalid(error);
            setSave("invalid");
            return;
          }
          draft.current.body = doc;
          edited();
        }}
      />
      {detail.source === "article" && current && (
        <PublicAddress
          key={`${locale}:${current.slug}`}
          id={id}
          locale={locale}
          slug={current.slug}
          onSaved={async (done) => {
            // Saved changes reload the record, which redraws these panels: the notice lives here.
            await load(locale);
            setNotice(done);
            onChanged();
          }}
        />
      )}
      <Settings
        // A fresh form whenever the saved settings change.
        key={`${detail.version}:${detail.lastReviewedAt}`}
        detail={detail}
        teammates={teammates}
        onSaved={async (done) => {
          // Saved changes reload the record, which redraws these panels: the notice lives here.
          await load(locale);
          setNotice(done);
          onChanged();
        }}
      />
      {detail.feedback && (
        <section className="pg-knowledge-feedback" aria-label="Reader feedback">
          <h3>Reader feedback</h3>
          <p>
            {detail.feedback.helpful} found it helpful ·{" "}
            {detail.feedback.unhelpful} did not
          </p>
          {detail.feedback.comments.length > 0 && (
            <ul>
              {detail.feedback.comments.map((c, i) => (
                <li key={i}>
                  <q lang={c.locale}>{c.comment}</q>{" "}
                  <span className="pg-muted">{when(c.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <section className="pg-knowledge-history" aria-label="Version history">
        <h3>Published versions</h3>
        <ul>
          {detail.revisions
            .filter((v) => v.locale === locale)
            .map((v) => (
              <li key={v.revision}>
                <span>
                  Version {v.revision}: {v.title} · {when(v.createdAt)}
                  {v.by ? ` · ${v.by}` : ""}
                </span>
                <button
                  aria-label={`Restore version ${v.revision}`}
                  onClick={() =>
                    run(
                      { op: "restore", revision: v.revision },
                      `Version ${v.revision} is now the draft. Publish to make it live.`,
                    )
                  }
                >
                  Restore
                </button>
              </li>
            ))}
          {!detail.revisions.some((v) => v.locale === locale) && (
            <li className="pg-muted">Not published yet.</li>
          )}
        </ul>
      </section>
    </div>
  );
}

function Settings({
  detail,
  teammates,
  onSaved,
}: {
  detail: Detail;
  teammates: { id: string; name: string; deleted?: boolean }[];
  onSaved: (done: string) => void;
}) {
  const [form, setForm] = useState({
    audience: detail.audience,
    forAi: detail.forAi,
    forHelpCenter: detail.forHelpCenter,
    forInbox: detail.forInbox,
    ownerId: detail.ownerId,
    faq: detail.faq,
  });
  const [notice, setNotice] = useState("");
  const internal = form.audience === "internal";
  async function send(body: Record<string, unknown>, done: string) {
    setNotice("");
    try {
      await api("knowledge", { id: detail.id, ...body });
      onSaved(done);
    } catch (e) {
      setNotice(message(e, "The settings could not be saved."));
    }
  }
  return (
    <section className="pg-knowledge-settings" aria-label="Settings">
      <h3>Settings</h3>
      <label>
        Audience
        <select
          value={form.audience}
          onChange={(e) => {
            const audience = e.target.value as Audience;
            // Internal content is never customer-facing, so those switches turn off with it.
            setForm((f) => ({
              ...f,
              audience,
              ...(audience === "internal"
                ? { forAi: false, forHelpCenter: false }
                : {}),
            }));
          }}
        >
          {Object.entries(AUDIENCE_NAMES).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={form.forAi}
          disabled={internal}
          onChange={(e) => setForm((f) => ({ ...f, forAi: e.target.checked }))}
        />
        AI agent can use it
      </label>
      {detail.source === "article" && (
        <label>
          <input
            type="checkbox"
            checked={form.forHelpCenter}
            disabled={internal}
            onChange={(e) =>
              setForm((f) => ({ ...f, forHelpCenter: e.target.checked }))
            }
          />
          Show in the help center
        </label>
      )}
      {detail.source === "article" && (
        <label>
          <input
            type="checkbox"
            checked={form.faq}
            onChange={(e) => setForm((f) => ({ ...f, faq: e.target.checked }))}
          />
          FAQ article (each H2 ending in &ldquo;?&rdquo; becomes a question for
          search engines)
        </label>
      )}
      <label>
        <input
          type="checkbox"
          checked={form.forInbox}
          onChange={(e) =>
            setForm((f) => ({ ...f, forInbox: e.target.checked }))
          }
        />
        Teammates can use it in the inbox
      </label>
      {internal && (
        <p className="pg-muted">
          Internal content is for teammates only: the help center and the AI
          agent answer customers, so they cannot use it.
        </p>
      )}
      <label>
        Owner
        <select
          value={form.ownerId}
          onChange={(e) => setForm((f) => ({ ...f, ownerId: e.target.value }))}
        >
          {teammates
            .filter((t) => !t.deleted || t.id === form.ownerId)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
      </label>
      <div className="pg-knowledge-settings-actions">
        <button
          onClick={() =>
            send(
              { op: "settings", version: detail.version, ...form },
              "Settings saved.",
            )
          }
        >
          Save settings
        </button>
        <button onClick={() => send({ op: "review" }, "Marked as reviewed.")}>
          Mark reviewed
        </button>
        <span className="pg-muted">
          {detail.lastReviewedAt
            ? `Last reviewed ${when(detail.lastReviewedAt)}`
            : "Never reviewed"}
        </span>
      </div>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

/** An article's address in the help center, per language. Old addresses keep redirecting. */
function PublicAddress({
  id,
  locale,
  slug,
  onSaved,
}: {
  id: string;
  locale: string;
  slug: string | null;
  onSaved: (done: string) => void;
}) {
  const [value, setValue] = useState(slug ?? "");
  const [notice, setNotice] = useState("");
  const typed = value.trim();
  return (
    <section className="pg-knowledge-address" aria-label="Public address">
      <h3>Public address</h3>
      {slug === null ? (
        <p className="pg-muted">
          Set from the title when this language is first published. You can
          choose one now.
        </p>
      ) : (
        <p className="pg-muted">
          If you change it, the old address keeps working and redirects here.
        </p>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setNotice("");
          try {
            await api("knowledge", { op: "slug", id, locale, slug: typed });
            onSaved("Address saved. The old address redirects here.");
          } catch (err) {
            setNotice(message(err, "The address could not be saved."));
          }
        }}
      >
        <span className="pg-muted">…/{locale}/articles/</span>
        <input
          aria-label="Address"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" disabled={!typed || typed === slug}>
          Save address
        </button>
      </form>
      {!SLUG.test(typed) && typed && (
        <p className="pg-muted">
          Use lower-case letters, digits and single hyphens, for example{" "}
          {slugify(typed) || "reset-your-password"}.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
