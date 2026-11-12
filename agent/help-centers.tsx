import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChevronRight,
  ExternalLink,
  Monitor,
  MoreHorizontal,
  Plus,
  Smartphone,
  Tablet,
} from "lucide-react";
import { api } from "./api";
import { ThemeImage } from "./knowledge-files";
import { preferredLocale, teammateLanguages } from "./locales";
import {
  BackgroundField,
  Choice,
  Colour,
  Fold,
  Font,
  IconPicker,
  Line,
  LinkList,
  Row,
  Slider,
  SocialList,
  Switch,
} from "./help-theme-fields";
import {
  DEFAULT_HELP_THEME,
  LIMITS,
  type HelpTheme,
  type LayoutBlock,
} from "../lib/help-theme";

/**
 * The help center editor (the November 2026 rebuild; docs/HELP_CENTER_DESIGN.md), in Knowledge
 * for `knowledge.manage`.
 *
 * Two screens, as Intercom has them: the collections manager beside a live preview of the help
 * center, and "Configure and style", where everything about the look is edited with the same
 * preview alongside. The preview is the real help center, drawn by the server from the draft
 * (`/api/agent/help-preview`), so what it shows is what saving would publish. Nothing is saved
 * until "Save and set live".
 */
type Center = {
  id: string;
  brandId: string;
  name: string;
  slug: string;
  defaultLocale: string;
  locales: string[];
  theme: HelpTheme;
  layout: LayoutBlock[];
  noindex: boolean;
  access: "public" | "signed_in";
  live: boolean;
  version: string;
};
type NodeView = {
  id: string;
  kind: "collection" | "section";
  parentId: string | null;
  icon: string | null;
  archived: boolean;
  version: string;
  locales: {
    locale: string;
    name: string;
    description: string;
    slug: string;
  }[];
  articles: {
    id: string;
    locales: {
      locale: string;
      status: string;
      title: string;
      slug: string | null;
    }[];
    hidden: string | null;
  }[];
};
type Tree = {
  center: Center;
  nodes: NodeView[];
  redirects: { kind: string; locale: string; slug: string; targetId: string }[];
  /** Where the help center is served from, and under which workspace: the link to the live pages. */
  origin?: string;
  workspace?: string;
};
type Brand = { id: string; name: string; centerId: string | null };
type Draft = { theme: HelpTheme; layout: LayoutBlock[] };

const message = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;
const move = <T,>(list: T[], from: number, to: number) => {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};
/** The name shown for a language: its own, or the first one it falls back to. */
const nameIn = (n: NodeView, locale: string, fallback: string) =>
  n.locales.find((l) => l.locale === locale) ??
  n.locales.find((l) => l.locale === fallback) ??
  n.locales[0];
const BLOCKS: Record<LayoutBlock["type"], string> = {
  search: "Search",
  collections: "Collections",
  featured: "Articles",
  content: "Content",
  contact: "Customer portal",
};

export function HelpCenters() {
  const [centers, setCenters] = useState<Center[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    api<{ centers: Center[]; brands: Brand[] }>("help-centers")
      .then((d) => {
        if (!live) return;
        setCenters(d.centers);
        setBrands(d.brands);
        setSelected((s) => s ?? d.centers[0]?.id ?? null);
      })
      .catch(
        (e) =>
          live && setError(message(e, "Help centers could not be loaded.")),
      );
    return () => {
      live = false;
    };
  }, [reload]);
  const free = brands.filter((b) => !b.centerId);
  if (selected)
    return (
      <CenterWorkspace
        key={selected}
        id={selected}
        centers={centers}
        brands={brands}
        onSelect={setSelected}
        onChanged={() => setReload((n) => n + 1)}
      />
    );
  return (
    <section className="pg-hc pg-hc-empty" aria-label="Help center">
      {error && (
        <div className="pg-error" role="alert">
          {error}
        </div>
      )}
      <h2>Help center</h2>
      <p className="pg-muted">
        A help center for each brand: collections of articles, in every language
        you write them in, on your own address.
      </p>
      {free.length > 0 ? (
        <CreateCenter
          brands={free}
          onCreated={(id) => {
            setSelected(id);
            setReload((n) => n + 1);
          }}
        />
      ) : (
        <p className="pg-muted">Every brand already has one.</p>
      )}
    </section>
  );
}

function CreateCenter({
  brands,
  onCreated,
}: {
  brands: Brand[];
  onCreated: (id: string) => void;
}) {
  const [brandId, setBrandId] = useState(brands[0]?.id ?? "");
  const [name, setName] = useState("");
  const [locale, setLocale] = useState("en");
  const [notice, setNotice] = useState("");
  return (
    <form
      className="pg-hc-create"
      aria-label="New help center"
      onSubmit={async (e) => {
        e.preventDefault();
        setNotice("");
        try {
          const r = await api<{ id: string }>("help-centers", {
            op: "center_create",
            brandId,
            name,
            defaultLocale: locale,
          });
          setName("");
          onCreated(r.id);
        } catch (err) {
          setNotice(message(err, "The help center could not be created."));
        }
      }}
    >
      <label>
        Brand
        <select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Name
        <input
          aria-label="Help center name"
          placeholder="Acme Help Center"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        Default language
        <input
          aria-label="Default language"
          value={locale}
          onChange={(e) => setLocale(e.target.value)}
          size={6}
        />
      </label>
      <button type="submit" className="pg-primary" disabled={!name.trim()}>
        Create help center
      </button>
      {notice && <span role="alert">{notice}</span>}
    </form>
  );
}

function CenterWorkspace({
  id,
  centers,
  brands,
  onSelect,
  onChanged,
}: {
  id: string;
  centers: Center[];
  brands: Brand[];
  onSelect: (id: string) => void;
  onChanged: () => void;
}) {
  const [tree, setTree] = useState<Tree | null>(null);
  const [locale, setLocale] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<"content" | "style" | "insights">("content");
  const [page, setPage] = useState<"home" | "collection" | "article">("home");
  const [device, setDevice] = useState<"desktop" | "tablet" | "mobile">(
    "desktop",
  );
  const [records, setRecords] = useState<
    { id: string; locales: { locale: string; title: string }[] }[]
  >([]);
  const fetchTree = useCallback(
    () => api<Tree>("help-center?id=" + encodeURIComponent(id)),
    [id],
  );
  const show = useCallback((t: Tree) => {
    setTree(t);
    setLocale((l) =>
      t.center.locales.includes(l) ? l : t.center.defaultLocale,
    );
  }, []);
  useEffect(() => {
    let live = true;
    fetchTree()
      .then((t) => live && show(t))
      .catch(
        (e) =>
          live &&
          setNotice(message(e, "This help center could not be loaded.")),
      );
    api<{
      records: { id: string; locales: { locale: string; title: string }[] }[];
    }>("knowledge?source=article")
      .then(
        (d) =>
          live &&
          setRecords(d.records.map((r) => ({ id: r.id, locales: r.locales }))),
      )
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [fetchTree, show]);
  const refresh = async () => show(await fetchTree());
  /** Runs a change, then reloads; a refusal is shown with its reason. */
  const change = async (body: Record<string, unknown>, done = "") => {
    setNotice("");
    try {
      await api("help-centers", body);
      if (done) setNotice(done);
      await refresh();
      return true;
    } catch (e) {
      setNotice(message(e, "That did not work."));
      await refresh().catch(() => {});
      return false;
    }
  };
  if (!tree)
    return <p className="pg-muted pg-hc-loading">{notice || "Loading…"}</p>;
  const { center } = tree;
  const articles = records.map((r) => ({
    id: r.id,
    title:
      preferredLocale(r.locales, [center.defaultLocale, ...teammateLanguages()])
        ?.title || "Untitled",
  }));
  const preview = (draft?: Draft) => (
    <Preview
      centerId={center.id}
      locale={locale}
      page={page}
      setPage={setPage}
      device={device}
      setDevice={setDevice}
      draft={draft}
    />
  );
  const liveUrl =
    tree.origin && tree.workspace
      ? `${tree.origin}/help/${encodeURIComponent(tree.workspace)}/${encodeURIComponent(center.slug)}/${encodeURIComponent(locale)}`
      : null;
  return (
    <section className="pg-hc" aria-label="Help center">
      <header className="pg-hc-top">
        <div className="pg-hc-title">
          {centers.length > 1 ? (
            <select
              aria-label="Help center"
              value={center.id}
              onChange={(e) => onSelect(e.target.value)}
            >
              {centers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <h2>{center.name}</h2>
          )}
          <span className="pg-hc-brand">
            {brands.find((b) => b.id === center.brandId)?.name ?? ""}
          </span>
          <span
            className={center.live ? "pg-hc-state pg-hc-live" : "pg-hc-state"}
          >
            {center.live ? "Live" : "Not live"}
          </span>
        </div>
        <div className="pg-hc-top-actions">
          <select
            aria-label="Language"
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
            disabled={center.locales.length < 2}
          >
            {center.locales.map((l) => (
              <option key={l} value={l}>
                {l}
                {l === center.defaultLocale ? " (default)" : ""}
              </option>
            ))}
          </select>
          <select
            aria-label="Live"
            value={center.live ? "live" : "off"}
            onChange={(e) =>
              void change(
                {
                  op: "center_settings",
                  id: center.id,
                  version: center.version,
                  live: e.target.value === "live",
                },
                e.target.value === "live"
                  ? "The help center is live."
                  : "The help center is no longer served.",
              ).then((ok) => ok && onChanged())
            }
          >
            <option value="live">Live</option>
            <option value="off">Not live</option>
          </select>
          {liveUrl && center.live && (
            <a
              className="pg-secondary pg-hc-visit"
              href={liveUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={14} aria-hidden="true" /> Visit
            </a>
          )}
          {view !== "style" && (
            <button
              type="button"
              className="pg-primary"
              onClick={() => setView("style")}
            >
              Configure and style
            </button>
          )}
        </div>
      </header>
      <nav className="pg-hc-tabs" aria-label="Help center">
        {(["content", "insights"] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-current={view === v ? "page" : undefined}
            onClick={() => setView(v)}
          >
            {v === "content" ? "Content" : "Insights"}
          </button>
        ))}
      </nav>
      {notice && (
        <div className="pg-hc-notice" role="status">
          {notice}
        </div>
      )}
      {view === "insights" ? (
        <Insights centerId={center.id} />
      ) : view === "style" ? (
        <Configure
          center={center}
          locale={locale}
          articles={articles}
          preview={preview}
          onClose={() => setView("content")}
          onSave={(data, done) =>
            change(
              {
                op: "center_settings",
                id: center.id,
                version: center.version,
                ...data,
              },
              done,
            ).then((ok) => {
              if (ok) onChanged();
              return ok;
            })
          }
        />
      ) : (
        <div className="pg-hc-split">
          <Collections
            tree={tree}
            locale={locale}
            articles={articles}
            change={change}
          />
          {preview()}
        </div>
      )}
    </section>
  );
}

/** The collections manager: the tree as a table, with the preview beside it. */
function Collections({
  tree,
  locale,
  articles,
  change,
}: {
  tree: Tree;
  locale: string;
  articles: { id: string; title: string }[];
  change: (body: Record<string, unknown>, done?: string) => Promise<boolean>;
}) {
  const { center } = tree;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const collections = tree.nodes.filter((n) => n.kind === "collection");
  return (
    <section className="pg-hc-pane" aria-label="Collections">
      <header className="pg-hc-pane-head">
        <h3>Collections</h3>
        <button
          type="button"
          className="pg-primary"
          onClick={() => setAdding((a) => !a)}
        >
          <Plus size={14} aria-hidden="true" /> New collection
        </button>
      </header>
      {adding && (
        <form
          className="pg-hc-add"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await change({
                op: "node_create",
                centerId: center.id,
                locale,
                name: name.trim(),
              })
            ) {
              setName("");
              setAdding(false);
            }
          }}
        >
          <input
            aria-label="New collection name"
            placeholder={`Collection name in ${locale}`}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="pg-primary" disabled={!name.trim()}>
            Create
          </button>
          <button
            type="button"
            className="pg-secondary"
            onClick={() => setAdding(false)}
          >
            Cancel
          </button>
        </form>
      )}
      {collections.length === 0 ? (
        <p className="pg-muted">
          No collections yet. A collection groups the articles a reader browses.
        </p>
      ) : (
        <ol className="pg-hc-rows">
          {collections.map((c, i) => (
            <NodeRow
              key={`${c.id}:${locale}`}
              node={c}
              index={i}
              siblings={collections}
              tree={tree}
              locale={locale}
              articles={articles}
              change={change}
              arrange={(order) =>
                change({
                  op: "arrange",
                  kind: "collections",
                  centerId: center.id,
                  order,
                })
              }
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function NodeRow({
  node,
  index,
  siblings,
  tree,
  locale,
  articles,
  change,
  arrange,
}: {
  node: NodeView;
  index: number;
  siblings: NodeView[];
  tree: Tree;
  locale: string;
  articles: { id: string; title: string }[];
  change: (body: Record<string, unknown>, done?: string) => Promise<boolean>;
  arrange: (order: string[]) => Promise<boolean>;
}) {
  const shown = nameIn(node, locale, tree.center.defaultLocale);
  const own = node.locales.find((l) => l.locale === locale);
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState<"article" | "section" | null>(null);
  const [name, setName] = useState(own?.name ?? "");
  const [description, setDescription] = useState(own?.description ?? "");
  const [pick, setPick] = useState("");
  const [slug, setSlug] = useState(own?.slug ?? "");
  const sections = tree.nodes.filter((n) => n.parentId === node.id);
  const oldSlugs = tree.redirects
    .filter((r) => r.targetId === node.id && r.locale === locale)
    .map((r) => r.slug);
  const order = siblings.map((s) => s.id);
  const placed = new Set(node.articles.map((a) => a.id));
  const titleOf = (a: NodeView["articles"][number]) =>
    (
      a.locales.find((l) => l.locale === locale) ??
      a.locales.find((l) => l.locale === tree.center.defaultLocale) ??
      a.locales[0]
    )?.title || "Untitled";
  const save = (patch: Record<string, unknown>) =>
    change({
      op: "node_update",
      id: node.id,
      version: node.version,
      locale,
      name: name.trim() || shown?.name,
      ...patch,
    });
  const total =
    node.articles.length + sections.reduce((n, s) => n + s.articles.length, 0);
  const label = `${node.kind === "collection" ? "Collection" : "Section"} ${shown?.name ?? ""}`;
  return (
    <li className={node.archived ? "pg-hc-row pg-hc-row-off" : "pg-hc-row"}>
      <article aria-label={label}>
        <div className="pg-hc-row-main">
          <button
            type="button"
            className="pg-hc-expand"
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} what is in ${shown?.name ?? "this collection"}`}
            onClick={() => setOpen((o) => !o)}
          >
            <ChevronRight size={15} aria-hidden="true" />
          </button>
          <IconPicker
            name={shown?.name ?? ""}
            value={node.icon}
            onPick={(icon) =>
              void change(
                { op: "node_update", id: node.id, version: node.version, icon },
                "Icon saved.",
              )
            }
          />
          <span className="pg-hc-row-text">
            <input
              className="pg-hc-inline-input"
              aria-label={`Name in ${locale}`}
              placeholder={`Name in ${locale}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && name !== own?.name && void save({})}
            />
            <input
              className="pg-hc-inline-input pg-hc-inline-sub"
              aria-label={`Description in ${locale}`}
              placeholder="Describe this collection"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() =>
                description !== (own?.description ?? "") &&
                void save({ description })
              }
            />
            {!own && (
              <span className="pg-muted pg-hc-row-note">
                No {locale} name yet; shows {shown?.locale}
              </span>
            )}
          </span>
          <span className="pg-hc-count">
            {total === 1 ? "1 article" : `${total} articles`}
          </span>
          <span className="pg-hc-menu">
            <button
              type="button"
              aria-label={`More for ${shown?.name ?? "this collection"}`}
              aria-expanded={menu}
              onClick={() => setMenu((m) => !m)}
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
            {menu && (
              <div className="pg-hc-menu-list" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setAdding("article");
                    setOpen(true);
                    setMenu(false);
                  }}
                >
                  Add articles
                </button>
                {node.kind === "collection" && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAdding("section");
                      setOpen(true);
                      setMenu(false);
                    }}
                  >
                    Add section
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  disabled={index === 0}
                  onClick={() => {
                    setMenu(false);
                    void arrange(move(order, index, index - 1));
                  }}
                >
                  Move up
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={index === order.length - 1}
                  onClick={() => {
                    setMenu(false);
                    void arrange(move(order, index, index + 1));
                  }}
                >
                  Move down
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    void change({
                      op: node.archived ? "node_restore" : "node_archive",
                      id: node.id,
                    });
                  }}
                >
                  {node.archived ? "Restore" : "Archive"}
                </button>
              </div>
            )}
          </span>
        </div>
        {open && (
          <div className="pg-hc-row-body">
            {own && (
              <form
                className="pg-hc-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save({ slug });
                }}
              >
                <label className="pg-hc-slug">
                  <span className="pg-hc-row-label">Address in {locale}</span>
                  <input
                    aria-label={`Address in ${locale}`}
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  className="pg-secondary"
                  disabled={!slug.trim() || slug === own.slug}
                >
                  Save address
                </button>
                {oldSlugs.length > 0 && (
                  <span className="pg-muted">
                    Redirects from: {oldSlugs.join(", ")}
                  </span>
                )}
              </form>
            )}
            <ol
              className="pg-hc-articles"
              aria-label={`Articles in ${shown?.name ?? ""}`}
            >
              {node.articles.map((a, i) => (
                <li key={a.id}>
                  <span>
                    {titleOf(a)}
                    {a.hidden && (
                      <em className="pg-knowledge-warn"> · {a.hidden}</em>
                    )}
                  </span>
                  <span className="pg-hc-row-actions">
                    <button
                      type="button"
                      aria-label={`Move ${titleOf(a)} up`}
                      disabled={i === 0}
                      onClick={() =>
                        change({
                          op: "arrange",
                          kind: "articles",
                          nodeId: node.id,
                          order: move(
                            node.articles.map((x) => x.id),
                            i,
                            i - 1,
                          ),
                        })
                      }
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${titleOf(a)} down`}
                      disabled={i === node.articles.length - 1}
                      onClick={() =>
                        change({
                          op: "arrange",
                          kind: "articles",
                          nodeId: node.id,
                          order: move(
                            node.articles.map((x) => x.id),
                            i,
                            i + 1,
                          ),
                        })
                      }
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      aria-label={`Remove ${titleOf(a)}`}
                      onClick={() =>
                        change({
                          op: "unplace",
                          nodeId: node.id,
                          recordId: a.id,
                        })
                      }
                    >
                      Remove
                    </button>
                  </span>
                </li>
              ))}
              {node.articles.length === 0 && (
                <li className="pg-muted">No articles here yet.</li>
              )}
            </ol>
            {adding === "article" && (
              <form
                className="pg-hc-add"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (
                    pick &&
                    (await change({
                      op: "place",
                      nodeId: node.id,
                      recordId: pick,
                    }))
                  )
                    setPick("");
                }}
              >
                <select
                  aria-label={`Article to add to ${shown?.name ?? ""}`}
                  value={pick}
                  onChange={(e) => setPick(e.target.value)}
                >
                  <option value="">Choose an article…</option>
                  {articles
                    .filter((a) => !placed.has(a.id))
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.title}
                      </option>
                    ))}
                </select>
                <button type="submit" className="pg-primary" disabled={!pick}>
                  Add article
                </button>
                <button
                  type="button"
                  className="pg-secondary"
                  onClick={() => setAdding(null)}
                >
                  Done
                </button>
              </form>
            )}
            {adding === "section" && (
              <AddSection
                label={`Section name in ${locale}`}
                onAdd={async (value) => {
                  const ok = await change({
                    op: "node_create",
                    centerId: tree.center.id,
                    parentId: node.id,
                    locale,
                    name: value,
                  });
                  if (ok) setAdding(null);
                  return ok;
                }}
                onCancel={() => setAdding(null)}
              />
            )}
            {sections.length > 0 && (
              <ol className="pg-hc-rows pg-hc-sections">
                {sections.map((s, i) => (
                  <NodeRow
                    key={`${s.id}:${locale}`}
                    node={s}
                    index={i}
                    siblings={sections}
                    tree={tree}
                    locale={locale}
                    articles={articles}
                    change={change}
                    arrange={(o) =>
                      change({
                        op: "arrange",
                        kind: "sections",
                        nodeId: node.id,
                        order: o,
                      })
                    }
                  />
                ))}
              </ol>
            )}
          </div>
        )}
      </article>
    </li>
  );
}

function AddSection({
  label,
  onAdd,
  onCancel,
}: {
  label: string;
  onAdd: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  return (
    <form
      className="pg-hc-add"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await onAdd(name.trim())) setName("");
      }}
    >
      <input
        aria-label={label}
        placeholder={label}
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" className="pg-primary" disabled={!name.trim()}>
        Add section
      </button>
      <button type="button" className="pg-secondary" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

const DEVICES = {
  desktop: { label: "Desktop", width: 0, icon: Monitor },
  tablet: { label: "Tablet", width: 834, icon: Tablet },
  mobile: { label: "Mobile", width: 390, icon: Smartphone },
} as const;

/** The draft as the address the preview frame is given. */
function draftParam(draft: Draft | null) {
  if (!draft) return "";
  const bytes = new TextEncoder().encode(JSON.stringify(draft));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The live preview: the help center's own pages, drawn by the server from the draft. The frame is
 * on this app's address (the bridge passes the request through), so its fonts and images load as
 * they do on the public pages. It redraws a moment after a change, not on every keystroke.
 */
function Preview({
  centerId,
  locale,
  page,
  setPage,
  device,
  setDevice,
  draft,
}: {
  centerId: string;
  locale: string;
  page: "home" | "collection" | "article";
  setPage: (p: "home" | "collection" | "article") => void;
  device: keyof typeof DEVICES;
  setDevice: (d: keyof typeof DEVICES) => void;
  draft?: Draft | null;
}) {
  const [settled, setSettled] = useState(() => draftParam(draft ?? null));
  const wanted = draftParam(draft ?? null);
  useEffect(() => {
    const t = setTimeout(() => setSettled(wanted), 350);
    return () => clearTimeout(t);
  }, [wanted]);
  const src = useMemo(() => {
    const params = new URLSearchParams({ centerId, page, locale });
    if (settled) params.set("draft", settled);
    return "/api/agent/help-preview?" + params;
  }, [centerId, page, locale, settled]);
  const width = DEVICES[device].width;
  return (
    <section className="pg-hc-preview" aria-label="Preview">
      <header className="pg-hc-preview-head">
        <span className="pg-hc-choice" role="radiogroup" aria-label="Page">
          {(["home", "collection", "article"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={p === page}
              onClick={() => setPage(p)}
            >
              {p === "home"
                ? "Homepage"
                : p === "collection"
                  ? "Collection"
                  : "Article"}
            </button>
          ))}
        </span>
        <span
          className="pg-hc-choice"
          role="radiogroup"
          aria-label="Screen size"
        >
          {(Object.keys(DEVICES) as (keyof typeof DEVICES)[]).map((d) => {
            const Icon = DEVICES[d].icon;
            return (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={d === device}
                aria-label={DEVICES[d].label}
                title={DEVICES[d].label}
                onClick={() => setDevice(d)}
              >
                <Icon size={15} aria-hidden="true" />
              </button>
            );
          })}
        </span>
      </header>
      <div className="pg-hc-frame">
        <iframe
          title="Help center preview"
          src={src}
          style={width ? { width, maxWidth: "100%" } : undefined}
        />
      </div>
    </section>
  );
}

/** "Configure and style": General and Styling, with the preview beside them. */
function Configure({
  center,
  locale,
  articles,
  preview,
  onClose,
  onSave,
}: {
  center: Center;
  locale: string;
  articles: { id: string; title: string }[];
  /** The live preview, given this screen's draft. */
  preview: (draft: Draft) => ReactNode;
  onClose: () => void;
  onSave: (data: Record<string, unknown>, done: string) => Promise<boolean>;
}) {
  const [tab, setTab] = useState<"general" | "styling">("styling");
  const [open, setOpen] = useState<string>("shared");
  const [theme, setTheme] = useState<HelpTheme>({
    ...DEFAULT_HELP_THEME,
    ...center.theme,
  });
  const [layout, setLayout] = useState<LayoutBlock[]>(center.layout);
  const [general, setGeneral] = useState({
    name: center.name,
    slug: center.slug,
    locales: center.locales.join(", "),
    defaultLocale: center.defaultLocale,
    noindex: center.noindex,
    access: center.access,
  });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const set = (patch: Partial<HelpTheme>) =>
    setTheme((t) => ({ ...t, ...patch }));
  const fold = (id: string) => ({
    open: open === id,
    onToggle: () => setOpen((o) => (o === id ? "" : id)),
  });
  const locales = general.locales.split(/[\s,]+/).filter(Boolean);
  // The preview is given this screen's draft, not the saved help center.
  const draft: Draft = { theme, layout };
  return (
    <div className="pg-hc-configure">
      <div className="pg-hc-editor">
        <header className="pg-hc-editor-head">
          <nav className="pg-hc-tabs" aria-label="Configure and style">
            {(["general", "styling"] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-current={tab === t ? "page" : undefined}
                onClick={() => setTab(t)}
              >
                {t === "general" ? "General" : "Styling"}
              </button>
            ))}
          </nav>
        </header>
        {notice && (
          <p className="pg-hc-notice" role="alert">
            {notice}
          </p>
        )}
        <div className="pg-hc-editor-body">
          {tab === "general" ? (
            <GeneralTab
              center={center}
              locale={locale}
              theme={theme}
              set={set}
              general={general}
              setGeneral={setGeneral}
              locales={locales}
              fold={fold}
            />
          ) : (
            <StylingTab
              center={center}
              locale={locale}
              theme={theme}
              set={set}
              layout={layout}
              setLayout={setLayout}
              articles={articles}
              fold={fold}
              onBrand={(brand) => {
                set({
                  actionColor: brand.actionColor,
                  iconColor: brand.actionColor,
                  bodyBackground: brand.bodyBackground,
                  heroBackground: {
                    type: "gradient",
                    colors: brand.heroColors,
                  },
                  heroText: brand.heroText,
                });
                setNotice(
                  `Colours from ${brand.name}. Change anything you like, then save.`,
                );
              }}
            />
          )}
        </div>
        <footer className="pg-hc-editor-foot">
          <button
            type="button"
            className="pg-secondary"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="pg-primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              setNotice("");
              const ok = await onSave(
                {
                  name: general.name,
                  slug: general.slug,
                  locales,
                  defaultLocale: general.defaultLocale,
                  noindex: general.noindex,
                  access: general.access,
                  theme,
                  layout,
                  live: true,
                },
                "Saved and set live.",
              );
              setSaving(false);
              if (ok) onClose();
            }}
          >
            {saving ? "Saving…" : "Save and set live"}
          </button>
        </footer>
      </div>
      {preview(draft)}
    </div>
  );
}

function GeneralTab({
  center,
  locale,
  theme,
  set,
  general,
  setGeneral,
  locales,
  fold,
}: {
  center: Center;
  locale: string;
  theme: HelpTheme;
  set: (patch: Partial<HelpTheme>) => void;
  general: {
    name: string;
    slug: string;
    locales: string;
    defaultLocale: string;
    noindex: boolean;
    access: "public" | "signed_in";
  };
  setGeneral: (f: (g: GeneralTabState) => GeneralTabState) => void;
  locales: string[];
  fold: (id: string) => { open: boolean; onToggle: () => void };
}) {
  const g = (patch: Partial<GeneralTabState>) =>
    setGeneral((old) => ({ ...old, ...patch }));
  return (
    <>
      <Fold title="Name and address" {...fold("name")}>
        <Row label="Name">
          <input
            aria-label="Name"
            value={general.name}
            onChange={(e) => g({ name: e.target.value })}
          />
        </Row>
        <Row
          label="Address"
          hint="The last part of the help center's web address."
        >
          <span className="pg-hc-inline">
            <span className="pg-muted">/help/…/</span>
            <input
              aria-label="Help center address"
              value={general.slug}
              onChange={(e) => g({ slug: e.target.value })}
            />
          </span>
        </Row>
      </Fold>
      <Fold
        title="Languages"
        hint="A page without a version in a language is shown in the next language along: fr-CA, then fr, then the default."
        {...fold("languages")}
      >
        <Row label="Supported languages">
          <input
            aria-label="Supported languages"
            value={general.locales}
            onChange={(e) => g({ locales: e.target.value })}
          />
        </Row>
        <Row label="Default language">
          <select
            aria-label="Default language"
            value={general.defaultLocale}
            onChange={(e) => g({ defaultLocale: e.target.value })}
          >
            {locales.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </Row>
      </Fold>
      <Fold title="Who can read it" {...fold("access")}>
        <Choice
          label="Audience"
          value={general.access}
          options={[
            { value: "public", label: "Everyone" },
            { value: "signed_in", label: "Signed-in customers" },
          ]}
          onChange={(access) => g({ access })}
        />
        {general.access === "signed_in" && (
          <Row
            label="Sign-in page"
            hint="Where a reader without a session is sent. Left empty, they are sent to their requests in the portal."
          >
            <input
              aria-label="Sign-in page"
              placeholder="https://example.com/login"
              value={theme.loginUrl}
              onChange={(e) => set({ loginUrl: e.target.value })}
            />
          </Row>
        )}
        <Switch
          label="Hide from search engines"
          checked={general.noindex}
          onChange={(noindex) => g({ noindex })}
          hint="Signed-in pages are never shown to search engines, whatever this says."
        />
      </Fold>
      <Fold title="Browser tab and sharing" {...fold("meta")}>
        <Line
          label="Page title"
          locale={locale}
          max={80}
          value={theme.pageTitle}
          onChange={(pageTitle) => set({ pageTitle })}
          placeholder={center.name}
        />
        <ThemeImage
          label="Favicon"
          purpose="theme_favicon"
          centerId={center.id}
          value={theme.faviconFileId}
          onChange={(faviconFileId) => set({ faviconFileId })}
        />
        <ThemeImage
          label="Social image"
          purpose="social_image"
          centerId={center.id}
          value={theme.socialImageFileId}
          onChange={(socialImageFileId) => set({ socialImageFileId })}
        />
        <p className="pg-muted">
          The social image is shown when a page is shared. 1200 × 630 works
          everywhere.
        </p>
      </Fold>
    </>
  );
}
type GeneralTabState = {
  name: string;
  slug: string;
  locales: string;
  defaultLocale: string;
  noindex: boolean;
  access: "public" | "signed_in";
};

function StylingTab({
  center,
  locale,
  theme,
  set,
  layout,
  setLayout,
  articles,
  fold,
  onBrand,
}: {
  center: Center;
  locale: string;
  theme: HelpTheme;
  set: (patch: Partial<HelpTheme>) => void;
  layout: LayoutBlock[];
  setLayout: (l: LayoutBlock[]) => void;
  articles: { id: string; title: string }[];
  fold: (id: string) => { open: boolean; onToggle: () => void };
  onBrand: (brand: {
    name: string;
    actionColor: string;
    bodyBackground: string;
    heroColors: string[];
    heroText: string;
  }) => void;
}) {
  return (
    <>
      <Fold title="Template" {...fold("template")}>
        <Choice
          label="Template"
          value={theme.template}
          options={[
            { value: "classic", label: "Classic" },
            { value: "modern", label: "Modern" },
          ]}
          onChange={(template) => set({ template })}
          hint="Classic puts the search first and browses by collection. Modern keeps a list of collections beside every page, like documentation."
        />
        <ImportBrand onBrand={onBrand} />
      </Fold>
      <Fold title="Shared elements" {...fold("shared")}>
        <Colour
          label="Body background"
          value={theme.bodyBackground}
          onChange={(c) => c && set({ bodyBackground: c })}
        />
        <Colour
          label="Action colour"
          value={theme.actionColor}
          onChange={(c) => c && set({ actionColor: c })}
          hint="Buttons and links. Relay darkens it where it would be hard to read."
        />
        <Choice
          label="Design style"
          value={theme.designStyle}
          options={[
            { value: "card", label: "Card" },
            { value: "floating", label: "Floating" },
          ]}
          onChange={(designStyle) => set({ designStyle })}
        />
        <Slider
          label="Corner radius"
          value={theme.radius}
          range={LIMITS.radius}
          onChange={(radius) => set({ radius })}
        />
        <Font
          label="Primary font"
          value={theme.fontPrimary}
          onChange={(fontPrimary) => set({ fontPrimary })}
        />
        <Font
          label="Secondary font"
          value={theme.fontSecondary}
          onChange={(fontSecondary) => set({ fontSecondary })}
        />
        <p className="pg-muted">
          Fonts are served by Relay from your own address, so no one else is
          told who is reading.
        </p>
        <Switch
          label="Show article authors"
          checked={theme.showAuthors}
          onChange={(showAuthors) => set({ showAuthors })}
          hint="The teammate who owns the article is named under its title."
        />
      </Fold>
      <Fold title="Header" {...fold("header")}>
        <ThemeImage
          label="Logo"
          purpose="theme_logo"
          centerId={center.id}
          value={theme.logoFileId}
          onChange={(logoFileId) => set({ logoFileId })}
        />
        <Colour
          label="Header background"
          value={theme.headerBackground}
          clearable
          onChange={(headerBackground) => set({ headerBackground })}
          hint="Left empty, the header sits on the hero."
        />
        <LinkList
          label="Header links"
          locale={locale}
          max={LIMITS.headerLinks}
          value={theme.headerLinks}
          onChange={(headerLinks) => set({ headerLinks })}
        />
      </Fold>
      <Fold title="Hero block" {...fold("hero")}>
        <Line
          label="Welcome message"
          locale={locale}
          value={theme.welcome}
          onChange={(welcome) => set({ welcome })}
          placeholder={`Advice and answers from the ${center.name} team`}
        />
        <BackgroundField
          label="Hero background"
          centerId={center.id}
          value={theme.heroBackground}
          onChange={(b) => b && set({ heroBackground: b })}
        />
        <Switch
          label="Fade into the page"
          checked={theme.heroFade}
          onChange={(heroFade) => set({ heroFade })}
        />
        <Colour
          label="Hero text"
          value={theme.heroText}
          onChange={(c) => c && set({ heroText: c })}
        />
        <Slider
          label="Height"
          value={theme.heroHeight}
          range={LIMITS.heroHeight}
          onChange={(heroHeight) => set({ heroHeight })}
        />
        <Choice
          label="Search bar length"
          value={theme.searchLength}
          options={[
            { value: "short", label: "Short" },
            { value: "medium", label: "Medium" },
            { value: "long", label: "Long" },
          ]}
          onChange={(searchLength) => set({ searchLength })}
        />
        <Choice
          label="Alignment"
          value={theme.searchAlign}
          options={[
            { value: "left", label: "Left" },
            { value: "center", label: "Centre" },
          ]}
          onChange={(searchAlign) => set({ searchAlign })}
        />
        <Choice
          label="Position"
          value={theme.searchPosition}
          options={[
            { value: "top", label: "Top" },
            { value: "center", label: "Middle" },
            { value: "bottom", label: "Bottom" },
          ]}
          onChange={(searchPosition) => set({ searchPosition })}
        />
        <Slider
          label="Search bar corners"
          value={theme.searchRadius}
          range={LIMITS.searchRadius}
          onChange={(searchRadius) => set({ searchRadius })}
        />
      </Fold>
      <Fold title="Layout and sections" {...fold("layout")}>
        <Sections
          center={center}
          locale={locale}
          layout={layout}
          setLayout={setLayout}
          articles={articles}
          theme={theme}
          set={set}
        />
      </Fold>
      <Fold title="Collection page" {...fold("collection")}>
        <Switch
          label="Show article descriptions"
          checked={theme.showDescriptions}
          onChange={(showDescriptions) => set({ showDescriptions })}
          hint="The first line of each article, under its title."
        />
      </Fold>
      <Fold title="Article page" {...fold("article")}>
        <Switch
          label="Table of contents"
          checked={theme.toc}
          onChange={(toc) => set({ toc })}
          hint="Built from the article's own headings."
        />
        <Switch
          label="Related articles"
          checked={theme.related}
          onChange={(related) => set({ related })}
        />
        <Switch
          label="Offer the article as Markdown"
          checked={theme.markdown}
          onChange={(markdown) => set({ markdown })}
          hint="A link readers can use to copy the article into another tool, at the article's address with .md."
        />
      </Fold>
      <Fold title="Footer" {...fold("footer")}>
        <Choice
          label="Layout"
          value={theme.footerLayout}
          options={[
            { value: "simple", label: "Simple" },
            { value: "classic", label: "Classic" },
            { value: "multilevel", label: "Multi level" },
          ]}
          onChange={(footerLayout) => set({ footerLayout })}
        />
        <ThemeImage
          label="Footer logo"
          purpose="theme_image"
          centerId={center.id}
          value={theme.footerLogoFileId}
          onChange={(footerLogoFileId) => set({ footerLogoFileId })}
        />
        <Line
          label="Footer text"
          locale={locale}
          max={300}
          rows={3}
          value={theme.footerText}
          onChange={(footerText) => set({ footerText })}
        />
        <LinkList
          label="Footer links"
          locale={locale}
          max={LIMITS.footerLinks}
          groups={theme.footerLayout === "multilevel"}
          value={theme.footerLinks}
          onChange={(links) =>
            set({
              footerLinks: Object.fromEntries(
                Object.entries(links).map(([l, list]) => [
                  l,
                  list.map((x) => ({ ...x, group: x.group ?? "" })),
                ]),
              ),
            })
          }
        />
        <SocialList
          value={theme.socials}
          onChange={(socials) => set({ socials })}
        />
        <Colour
          label="Footer background"
          value={theme.footerBackground}
          clearable
          onChange={(footerBackground) => set({ footerBackground })}
        />
        <Colour
          label="Footer text colour"
          value={theme.footerTextColor}
          clearable
          onChange={(footerTextColor) => set({ footerTextColor })}
        />
        <Switch
          label="Show “Powered by Relay”"
          checked={theme.poweredBy}
          onChange={(poweredBy) => set({ poweredBy })}
        />
      </Fold>
    </>
  );
}

/** "Import your brand": a website's colours, fetched in the background and put into the draft. */
function ImportBrand({
  onBrand,
}: {
  onBrand: (brand: {
    name: string;
    actionColor: string;
    bodyBackground: string;
    heroColors: string[];
    heroText: string;
  }) => void;
}) {
  const [url, setUrl] = useState("");
  const [state, setState] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const watch = (jobId: string, left: number) => {
    timer.current = setTimeout(async () => {
      try {
        const job = await api<{
          state: string;
          result: {
            brand?: Parameters<typeof onBrand>[0];
            refused?: string;
          } | null;
        }>("job?id=" + encodeURIComponent(jobId));
        if (job.state === "done" || job.state === "failed") {
          const brand = job.result?.brand;
          if (brand) {
            onBrand(brand);
            setState("");
          } else
            setState(job.result?.refused ?? "That website couldn't be read.");
          return;
        }
      } catch {
        setState("The import didn't finish.");
        return;
      }
      if (left > 0) watch(jobId, left - 1);
      else setState("That website is taking too long.");
    }, 1200);
  };
  return (
    <Row
      label="Import your brand"
      hint="We read your website's colours. Nothing is saved until you save."
    >
      <span className="pg-hc-inline">
        <input
          aria-label="Your website"
          placeholder="example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          type="button"
          className="pg-secondary"
          disabled={!url.trim() || state === "Reading your website…"}
          onClick={async () => {
            setState("Reading your website…");
            try {
              const r = await api<{ jobId: string }>("help-centers", {
                op: "center_brand_import",
                url,
              });
              watch(r.jobId, 12);
            } catch (e) {
              setState(message(e, "That address couldn't be read."));
            }
          }}
        >
          Import
        </button>
        {state && <span className="pg-muted">{state}</span>}
      </span>
    </Row>
  );
}

/** The homepage's sections: which are shown, in what order, and what each one holds. */
function Sections({
  center,
  locale,
  layout,
  setLayout,
  articles,
  theme,
  set,
}: {
  center: Center;
  locale: string;
  layout: LayoutBlock[];
  setLayout: (l: LayoutBlock[]) => void;
  articles: { id: string; title: string }[];
  theme: HelpTheme;
  set: (patch: Partial<HelpTheme>) => void;
}) {
  const [editing, setEditing] = useState<string>("");
  const shown = layout.filter((b) => b.type !== "search");
  const has = (type: LayoutBlock["type"]) => shown.some((b) => b.type === type);
  const put = (i: number, block: LayoutBlock) =>
    setLayout(layout.map((b, j) => (j === i ? block : b)));
  return (
    <div className="pg-hc-sections">
      <ol>
        {layout.map((b, i) => {
          if (b.type === "search") return null;
          const fixed = b.type === "collections";
          return (
            <li key={b.type}>
              <div className="pg-hc-section-row">
                <strong>{BLOCKS[b.type]}</strong>
                <span className="pg-hc-row-actions">
                  <button
                    type="button"
                    aria-label={`Move ${BLOCKS[b.type]} up`}
                    disabled={i === 0}
                    onClick={() => setLayout(move(layout, i, i - 1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${BLOCKS[b.type]} down`}
                    disabled={i === layout.length - 1}
                    onClick={() => setLayout(move(layout, i, i + 1))}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setEditing((e) => (e === b.type ? "" : b.type))
                    }
                  >
                    {editing === b.type ? "Done" : "Edit"}
                  </button>
                  {!fixed && (
                    <button
                      type="button"
                      aria-label={`Remove ${BLOCKS[b.type]}`}
                      onClick={() =>
                        setLayout(layout.filter((_, j) => j !== i))
                      }
                    >
                      Remove
                    </button>
                  )}
                </span>
              </div>
              {editing === b.type && (
                <div className="pg-hc-section-body">
                  {b.type === "collections" && (
                    <>
                      <Choice
                        label="Columns"
                        value={theme.collectionColumns}
                        options={[
                          { value: 1, label: "1" },
                          { value: 2, label: "2" },
                          { value: 3, label: "3" },
                        ]}
                        onChange={(collectionColumns) =>
                          set({ collectionColumns })
                        }
                      />
                      <Choice
                        label="Style"
                        value={theme.collectionStyle}
                        options={[
                          { value: "classic", label: "Classic" },
                          { value: "visual", label: "Visual" },
                          { value: "compact", label: "Compact" },
                        ]}
                        onChange={(collectionStyle) => set({ collectionStyle })}
                      />
                      <Choice
                        label="Design"
                        value={theme.collectionDesign}
                        options={[
                          { value: "icons", label: "Icons" },
                          { value: "images", label: "Images" },
                          { value: "none", label: "Text only" },
                        ]}
                        onChange={(collectionDesign) =>
                          set({ collectionDesign })
                        }
                        hint="Icons are chosen on each collection. Images are uploaded there too."
                      />
                      {theme.collectionDesign === "icons" && (
                        <>
                          <Colour
                            label="Icon colour"
                            value={theme.iconColor}
                            onChange={(c) => c && set({ iconColor: c })}
                          />
                          <BackgroundField
                            label="Icon background"
                            centerId={center.id}
                            clearable
                            value={theme.iconBackground}
                            onChange={(iconBackground) =>
                              set({ iconBackground })
                            }
                          />
                        </>
                      )}
                    </>
                  )}
                  {b.type === "featured" && (
                    <FeaturedSection
                      block={b}
                      locale={locale}
                      articles={articles}
                      onChange={(next) => put(i, next)}
                    />
                  )}
                  {b.type === "content" && (
                    <ContentSection
                      block={b}
                      locale={locale}
                      centerId={center.id}
                      onChange={(next) => put(i, next)}
                    />
                  )}
                  {b.type === "contact" && (
                    <p className="pg-muted">
                      “Still need help?”, with a link to the customer&apos;s own
                      requests in the portal. It shows only where the portal is
                      on.
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="pg-hc-inline">
        {(["featured", "content", "contact"] as const)
          .filter((t) => !has(t))
          .map((t) => (
            <button
              key={t}
              type="button"
              className="pg-secondary"
              onClick={() =>
                setLayout([
                  ...layout,
                  t === "featured"
                    ? { type: "featured", recordIds: [], title: {}, columns: 1 }
                    : t === "content"
                      ? {
                          type: "content",
                          title: {},
                          description: {},
                          buttonLabel: {},
                          buttonUrl: "",
                          design: "card",
                          background: { type: "color", color: "#ffffff" },
                          textColor: "#161a1d",
                        }
                      : { type: "contact" },
                ])
              }
            >
              <Plus size={13} aria-hidden="true" /> Add{" "}
              {BLOCKS[t].toLowerCase()}
            </button>
          ))}
      </div>
    </div>
  );
}

function FeaturedSection({
  block,
  locale,
  articles,
  onChange,
}: {
  block: Extract<LayoutBlock, { type: "featured" }>;
  locale: string;
  articles: { id: string; title: string }[];
  onChange: (b: LayoutBlock) => void;
}) {
  const [pick, setPick] = useState("");
  const chosen = block.recordIds;
  return (
    <>
      <Line
        label="Section title"
        locale={locale}
        max={80}
        value={block.title ?? {}}
        onChange={(title) => onChange({ ...block, title })}
        placeholder="Popular articles"
      />
      <Choice
        label="Columns"
        value={block.columns ?? 1}
        options={[
          { value: 1, label: "1" },
          { value: 2, label: "2" },
          { value: 3, label: "3" },
        ]}
        onChange={(columns) => onChange({ ...block, columns })}
      />
      <ol className="pg-hc-chosen" aria-label="Chosen articles">
        {chosen.map((id, i) => (
          <li key={id}>
            <span>{articles.find((a) => a.id === id)?.title ?? id}</span>
            <span className="pg-hc-row-actions">
              <button
                type="button"
                aria-label="Move up"
                disabled={i === 0}
                onClick={() =>
                  onChange({ ...block, recordIds: move(chosen, i, i - 1) })
                }
              >
                ↑
              </button>
              <button
                type="button"
                aria-label="Move down"
                disabled={i === chosen.length - 1}
                onClick={() =>
                  onChange({ ...block, recordIds: move(chosen, i, i + 1) })
                }
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...block,
                    recordIds: chosen.filter((x) => x !== id),
                  })
                }
              >
                Remove
              </button>
            </span>
          </li>
        ))}
        {!chosen.length && (
          <li className="pg-muted">No articles chosen yet.</li>
        )}
      </ol>
      {chosen.length < LIMITS.articles && (
        <span className="pg-hc-inline">
          <select
            aria-label="Article to feature"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
          >
            <option value="">Choose an article…</option>
            {articles
              .filter((a) => !chosen.includes(a.id))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
          </select>
          <button
            type="button"
            className="pg-secondary"
            disabled={!pick}
            onClick={() => {
              onChange({ ...block, recordIds: [...chosen, pick] });
              setPick("");
            }}
          >
            Add
          </button>
        </span>
      )}
      <p className="pg-muted">
        An article shows here only when it is also placed in a collection.
      </p>
    </>
  );
}

function ContentSection({
  block,
  locale,
  centerId,
  onChange,
}: {
  block: Extract<LayoutBlock, { type: "content" }>;
  locale: string;
  centerId: string;
  onChange: (b: LayoutBlock) => void;
}) {
  return (
    <>
      <Line
        label="Title"
        locale={locale}
        max={120}
        value={block.title}
        onChange={(title) => onChange({ ...block, title })}
      />
      <Line
        label="Description"
        locale={locale}
        max={600}
        rows={3}
        value={block.description}
        onChange={(description) => onChange({ ...block, description })}
      />
      <Line
        label="Button"
        locale={locale}
        max={40}
        value={block.buttonLabel}
        onChange={(buttonLabel) => onChange({ ...block, buttonLabel })}
      />
      <Row label="Button link">
        <input
          aria-label="Button link"
          placeholder="https://example.com"
          value={block.buttonUrl}
          onChange={(e) => onChange({ ...block, buttonUrl: e.target.value })}
        />
      </Row>
      <Choice
        label="Design"
        value={block.design}
        options={[
          { value: "card", label: "Card" },
          { value: "full", label: "Full width" },
        ]}
        onChange={(design) => onChange({ ...block, design })}
      />
      <BackgroundField
        label="Background"
        centerId={centerId}
        value={block.background}
        onChange={(background) =>
          background && onChange({ ...block, background })
        }
      />
      <Colour
        label="Text colour"
        value={block.textColor}
        onChange={(c) => c && onChange({ ...block, textColor: c })}
      />
    </>
  );
}

type InsightRow = { query: string; searches: number; last: string };
type InsightData = {
  days: number;
  totals: { searches: number; empty: number; opened: number };
  noResults: InsightRow[];
  noClicks: InsightRow[];
  unhelpful: {
    id: string;
    title: string;
    helpful: number;
    unhelpful: number;
  }[];
};
/**
 * What readers couldn't find (phase 07, B2): searches with no results, searches whose results
 * nobody opened, and the articles most often marked "not helpful".
 */
function Insights({ centerId }: { centerId: string }) {
  const [data, setData] = useState<InsightData | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api<InsightData>(
      "help-insights?" + new URLSearchParams({ centerId, days: "30" }),
    )
      .then((d) => live && setData(d))
      .catch(
        (e) => live && setError(message(e, "The report could not be loaded.")),
      );
    return () => {
      live = false;
    };
  }, [centerId]);
  const table = (rows: InsightRow[], label: string) =>
    rows.length ? (
      <table className="pg-help-insights-table" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Search</th>
            <th scope="col">Times</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.query}>
              <td>{r.query}</td>
              <td>{r.searches}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <p className="pg-muted">None.</p>
    );
  return (
    <section className="pg-help-insights" aria-label="Search and feedback">
      <h3>Search and feedback, last {data?.days ?? 30} days</h3>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p className="pg-muted">
            {data.totals.searches} searches · {data.totals.empty} with no
            results · {data.totals.opened} led to an article
          </p>
          <h4>Searches with no results</h4>
          {table(data.noResults, "Searches with no results")}
          <h4>Searches where no result was opened</h4>
          {table(data.noClicks, "Searches where no result was opened")}
          <h4>Most often “not helpful”</h4>
          {data.unhelpful.length ? (
            <ul>
              {data.unhelpful.map((a) => (
                <li key={a.id}>
                  {a.title || "Untitled"}: {a.unhelpful} not helpful,{" "}
                  {a.helpful} helpful
                </li>
              ))}
            </ul>
          ) : (
            <p className="pg-muted">None.</p>
          )}
          <p className="pg-muted">
            Searches are kept for 180 days, without email addresses or long
            numbers.
          </p>
        </>
      )}
    </section>
  );
}
