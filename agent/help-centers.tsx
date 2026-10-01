import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/**
 * Help center structure (phase 07, step A2), in the Knowledge section for `knowledge.manage`:
 * one help center per brand with its languages, theme and homepage, and the collection →
 * section → article tree. Reordering uses buttons (keyboard friendly; no drag library).
 * The public pages arrive in step B1.
 */
type Theme = {
  primaryColor: string;
  headerStyle: "solid" | "light";
  font: "system" | "serif" | "rounded";
};
type Block = { type: string; recordIds?: string[] };
type Center = {
  id: string;
  brandId: string;
  name: string;
  slug: string;
  defaultLocale: string;
  locales: string[];
  theme: Theme;
  layout: Block[];
  noindex: boolean;
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
};
type Brand = { id: string; name: string; centerId: string | null };

const message = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;
const BLOCKS: Record<string, string> = {
  search: "Search",
  collections: "Collections",
  featured: "Featured articles",
  contact: "Contact us",
};
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
  return (
    <div className="pg-help">
      {error && (
        <div className="pg-error" role="alert">
          {error}
        </div>
      )}
      <div className="pg-help-bar">
        {centers.length > 0 && (
          <label>
            Help center
            <select
              value={selected ?? ""}
              onChange={(e) => setSelected(e.target.value)}
            >
              {centers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} (
                  {brands.find((b) => b.id === c.brandId)?.name ?? c.brandId})
                </option>
              ))}
            </select>
          </label>
        )}
        {free.length > 0 && (
          <CreateCenter
            brands={free}
            onCreated={(id) => {
              setSelected(id);
              setReload((n) => n + 1);
            }}
          />
        )}
      </div>
      {selected ? (
        <CenterEditor
          key={selected}
          id={selected}
          onChanged={() => setReload((n) => n + 1)}
        />
      ) : (
        <p className="pg-muted">No help center yet. Create one for a brand.</p>
      )}
    </div>
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
      className="pg-help-create"
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
      <select
        aria-label="Brand"
        value={brandId}
        onChange={(e) => setBrandId(e.target.value)}
      >
        {brands.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <input
        aria-label="Help center name"
        placeholder="Help center name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        aria-label="Default language"
        value={locale}
        onChange={(e) => setLocale(e.target.value)}
        size={6}
      />
      <button type="submit" disabled={!name.trim()}>
        Create help center
      </button>
      {notice && <span role="alert">{notice}</span>}
    </form>
  );
}

function CenterEditor({
  id,
  onChanged,
}: {
  id: string;
  onChanged: () => void;
}) {
  const [tree, setTree] = useState<Tree | null>(null);
  const [locale, setLocale] = useState("");
  const [notice, setNotice] = useState("");
  const [articles, setArticles] = useState<{ id: string; title: string }[]>([]);
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
    api<{ records: { id: string; locales: { title: string }[] }[] }>(
      "knowledge?source=article",
    )
      .then(
        (d) =>
          live &&
          setArticles(
            d.records.map((r) => ({
              id: r.id,
              title: r.locales[0]?.title || "Untitled",
            })),
          ),
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
  if (!tree) return <p className="pg-muted">{notice || "Loading…"}</p>;
  const { center } = tree;
  const collections = tree.nodes.filter((n) => n.kind === "collection");
  const redirectsTo = (id: string) =>
    tree.redirects.filter(
      (r) => r.targetId === id && (r.locale === locale || r.kind === "center"),
    );
  const nodeProps = { tree, locale, articles, change, redirectsTo };
  return (
    <div className="pg-help-center">
      <CenterSettings
        key={center.version}
        center={center}
        oldSlugs={redirectsTo(center.id).map((r) => r.slug)}
        onSave={(data) =>
          change(
            {
              op: "center_settings",
              id: center.id,
              version: center.version,
              ...data,
            },
            "Settings saved.",
          ).then((ok) => ok && onChanged())
        }
      />
      <section className="pg-help-tree" aria-label="Collections">
        <header>
          <h3>Collections</h3>
          <label>
            Names in
            <select
              aria-label="Language for names"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
            >
              {center.locales.map((l) => (
                <option key={l} value={l}>
                  {l}
                  {l === center.defaultLocale ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
        </header>
        {notice && (
          <div className="pg-knowledge-notice" role="alert">
            {notice}
          </div>
        )}
        <ol className="pg-help-nodes">
          {collections.map((c, i) => (
            <NodeItem
              key={`${c.id}:${locale}:${c.version}`}
              node={c}
              index={i}
              siblings={collections}
              arrange={(order) =>
                change({
                  op: "arrange",
                  kind: "collections",
                  centerId: center.id,
                  order,
                })
              }
              {...nodeProps}
            />
          ))}
        </ol>
        <AddNode
          label="Add collection"
          onAdd={(name) =>
            change({ op: "node_create", centerId: center.id, locale, name })
          }
        />
      </section>
    </div>
  );
}

type NodeProps = {
  tree: Tree;
  locale: string;
  articles: { id: string; title: string }[];
  change: (body: Record<string, unknown>, done?: string) => Promise<boolean>;
  redirectsTo: (id: string) => Tree["redirects"];
};
function NodeItem({
  node,
  index,
  siblings,
  arrange,
  tree,
  locale,
  articles,
  change,
  redirectsTo,
}: NodeProps & {
  node: NodeView;
  index: number;
  siblings: NodeView[];
  arrange: (order: string[]) => Promise<boolean>;
}) {
  const shown = nameIn(node, locale, tree.center.defaultLocale);
  const own = node.locales.find((l) => l.locale === locale);
  const [name, setName] = useState(own?.name ?? "");
  const [slug, setSlug] = useState(own?.slug ?? "");
  const [adding, setAdding] = useState("");
  const sections = tree.nodes.filter((n) => n.parentId === node.id);
  const label = `${node.kind === "collection" ? "Collection" : "Section"} ${shown?.name ?? ""}`;
  const order = siblings.map((s) => s.id);
  const placed = new Set(node.articles.map((a) => a.id));
  const titleOf = (a: NodeView["articles"][number]) =>
    (
      a.locales.find((l) => l.locale === locale) ??
      a.locales.find((l) => l.locale === tree.center.defaultLocale) ??
      a.locales[0]
    )?.title || "Untitled";
  const old = redirectsTo(node.id).map((r) => r.slug);
  return (
    <li
      className={
        node.archived ? "pg-help-node pg-help-archived" : "pg-help-node"
      }
    >
      <article aria-label={label}>
        <header>
          <strong>{shown?.name}</strong>
          {!own && (
            <span className="pg-muted">
              {" "}
              (no {locale} name yet; shows {shown?.locale})
            </span>
          )}
          {node.archived && <span className="pg-muted"> · Archived</span>}
          <span className="pg-help-actions">
            <button
              aria-label={`Move ${shown?.name} up`}
              disabled={index === 0}
              onClick={() => arrange(move(order, index, index - 1))}
            >
              ↑
            </button>
            <button
              aria-label={`Move ${shown?.name} down`}
              disabled={index === order.length - 1}
              onClick={() => arrange(move(order, index, index + 1))}
            >
              ↓
            </button>
            <button
              onClick={() =>
                change({
                  op: node.archived ? "node_restore" : "node_archive",
                  id: node.id,
                })
              }
            >
              {node.archived ? "Restore" : "Archive"}
            </button>
          </span>
        </header>
        <form
          className="pg-help-names"
          onSubmit={(e) => {
            e.preventDefault();
            void change(
              {
                op: "node_update",
                id: node.id,
                version: node.version,
                locale,
                name,
                ...(own && slug !== own.slug ? { slug } : {}),
              },
              "Saved.",
            );
          }}
        >
          <input
            aria-label={`Name in ${locale}`}
            placeholder={`Name in ${locale}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {own && (
            <input
              aria-label={`Address in ${locale}`}
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
          )}
          <button type="submit" disabled={!name.trim()}>
            {own ? "Save" : `Add ${locale} name`}
          </button>
          {old.length > 0 && (
            <span className="pg-muted">Redirects from: {old.join(", ")}</span>
          )}
        </form>
        <ol
          className="pg-help-articles"
          aria-label={`Articles in ${shown?.name}`}
        >
          {node.articles.map((a, i) => (
            <li key={a.id}>
              <span>
                {titleOf(a)}
                {a.hidden && (
                  <em className="pg-knowledge-warn"> · {a.hidden}</em>
                )}
              </span>
              <span className="pg-help-actions">
                <button
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
                  aria-label={`Remove ${titleOf(a)}`}
                  onClick={() =>
                    change({ op: "unplace", nodeId: node.id, recordId: a.id })
                  }
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ol>
        <form
          className="pg-help-place"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              adding &&
              (await change({ op: "place", nodeId: node.id, recordId: adding }))
            )
              setAdding("");
          }}
        >
          <select
            aria-label={`Article to add to ${shown?.name}`}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
          >
            <option value="">Add an article here…</option>
            {articles
              .filter((a) => !placed.has(a.id))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
          </select>
          <button type="submit" disabled={!adding}>
            Add article
          </button>
        </form>
        {node.kind === "collection" && (
          <>
            <ol className="pg-help-nodes">
              {sections.map((s, i) => (
                <NodeItem
                  key={`${s.id}:${locale}:${s.version}`}
                  node={s}
                  index={i}
                  siblings={sections}
                  arrange={(o) =>
                    change({
                      op: "arrange",
                      kind: "sections",
                      nodeId: node.id,
                      order: o,
                    })
                  }
                  tree={tree}
                  locale={locale}
                  articles={articles}
                  change={change}
                  redirectsTo={redirectsTo}
                />
              ))}
            </ol>
            <AddNode
              label={`Add section to ${shown?.name}`}
              onAdd={(n) =>
                change({
                  op: "node_create",
                  centerId: tree.center.id,
                  parentId: node.id,
                  locale,
                  name: n,
                })
              }
            />
          </>
        )}
      </article>
    </li>
  );
}

function AddNode({
  label,
  onAdd,
}: {
  label: string;
  onAdd: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  return (
    <form
      className="pg-help-add"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await onAdd(name.trim())) setName("");
      }}
    >
      <input
        aria-label={label}
        placeholder={label}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" disabled={!name.trim()}>
        {label.startsWith("Add section") ? "Add section" : "Add collection"}
      </button>
    </form>
  );
}

function CenterSettings({
  center,
  oldSlugs,
  onSave,
}: {
  center: Center;
  oldSlugs: string[];
  onSave: (data: Record<string, unknown>) => void;
}) {
  const [form, setForm] = useState({
    name: center.name,
    slug: center.slug,
    locales: center.locales.join(", "),
    defaultLocale: center.defaultLocale,
    theme: center.theme,
    noindex: center.noindex,
    // The featured block is kept as it is; the others can be turned on and reordered here.
    layout: center.layout,
  });
  const set = (patch: Partial<typeof form>) =>
    setForm((f) => ({ ...f, ...patch }));
  const locales = form.locales.split(/[\s,]+/).filter(Boolean);
  const on = (type: string) => form.layout.some((b) => b.type === type);
  return (
    <section className="pg-help-settings" aria-label="Help center settings">
      <h3>Settings</h3>
      <label>
        Name
        <input
          value={form.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>
      <label>
        Address
        <span className="pg-muted">/help/…/</span>
        <input
          aria-label="Help center address"
          value={form.slug}
          onChange={(e) => set({ slug: e.target.value })}
        />
      </label>
      {oldSlugs.length > 0 && (
        <p className="pg-muted">
          Old addresses redirect here: {oldSlugs.join(", ")}
        </p>
      )}
      <label>
        Languages
        <input
          aria-label="Languages"
          value={form.locales}
          onChange={(e) => set({ locales: e.target.value })}
        />
      </label>
      <label>
        Default language
        <select
          value={form.defaultLocale}
          onChange={(e) => set({ defaultLocale: e.target.value })}
        >
          {locales.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <p className="pg-muted">
        A page without a version in a language is shown in the next language
        along: fr-CA, then fr, then the default.
      </p>
      <fieldset>
        <legend>Theme</legend>
        <label>
          Colour
          <input
            type="color"
            aria-label="Theme colour"
            value={form.theme.primaryColor}
            onChange={(e) =>
              set({ theme: { ...form.theme, primaryColor: e.target.value } })
            }
          />
          <span
            className="pg-help-swatch"
            style={{ background: form.theme.primaryColor }}
            aria-hidden="true"
          />
        </label>
        <label>
          Header
          <select
            value={form.theme.headerStyle}
            onChange={(e) =>
              set({
                theme: {
                  ...form.theme,
                  headerStyle: e.target.value as Theme["headerStyle"],
                },
              })
            }
          >
            <option value="solid">Solid colour</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label>
          Font
          <select
            value={form.theme.font}
            onChange={(e) =>
              set({
                theme: { ...form.theme, font: e.target.value as Theme["font"] },
              })
            }
          >
            <option value="system">System</option>
            <option value="serif">Serif</option>
            <option value="rounded">Rounded</option>
          </select>
        </label>
      </fieldset>
      <fieldset>
        <legend>Homepage</legend>
        <ol className="pg-help-blocks">
          {form.layout.map((b, i) => (
            <li key={b.type}>
              {BLOCKS[b.type] ?? b.type}
              <button
                type="button"
                aria-label={`Move ${BLOCKS[b.type]} up`}
                disabled={i === 0}
                onClick={() => set({ layout: move(form.layout, i, i - 1) })}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${BLOCKS[b.type]} down`}
                disabled={i === form.layout.length - 1}
                onClick={() => set({ layout: move(form.layout, i, i + 1) })}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={`Remove ${BLOCKS[b.type]}`}
                onClick={() =>
                  set({ layout: form.layout.filter((x) => x.type !== b.type) })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
        {["search", "collections", "contact"]
          .filter((t) => !on(t))
          .map((t) => (
            <button
              type="button"
              key={t}
              onClick={() => set({ layout: [...form.layout, { type: t }] })}
            >
              Add {BLOCKS[t]}
            </button>
          ))}
      </fieldset>
      <label>
        <input
          type="checkbox"
          checked={form.noindex}
          onChange={(e) => set({ noindex: e.target.checked })}
        />
        Hide from search engines
      </label>
      <button
        onClick={() =>
          onSave({
            name: form.name,
            slug: form.slug,
            locales,
            defaultLocale: form.defaultLocale,
            theme: form.theme,
            layout: form.layout,
            noindex: form.noindex,
          })
        }
      >
        Save settings
      </button>
    </section>
  );
}
