import { assert, DomainError, type Sql } from "./db";
import {
  freeSlug,
  manager,
  moveSlug,
  requireKnowledge,
  validLocale,
  validSlug,
} from "./knowledge";
import { helpPath, resolveLocale, slugify } from "../lib/help-paths";

/**
 * Help center structure (phase 07, step A2). At most one help center per brand, with its
 * languages, theme and homepage layout. Collections hold optional sections (a fixed depth of
 * two), and an article can be placed in several of them. Every slug change leaves a redirect.
 *
 * Nothing is public yet: `resolvePath` turns a public path into the object to show, or a
 * redirect, for the server-rendered pages of step B1.
 * TODO(phase 07 B1): render the pages, domains, signed-in access and the portal mount.
 * TODO(phase 07 C1): a logo in the theme, once knowledge files have storage of their own.
 */
const invalid = (message: string): never => {
  throw new DomainError("INVALID_HELP_CENTER", message, 400);
};
const conflict = (version: unknown, current: string) =>
  assert(
    String(version) === current,
    "HELP_CENTER_CONFLICT",
    "This changed elsewhere. Reload and try again.",
    409,
  );
const name = (value: unknown, max = 120) => {
  const t = typeof value === "string" ? value.trim() : "";
  if (!t || t.length > max)
    invalid(`Give it a name of up to ${max} characters.`);
  return t;
};
const text = (value: unknown, max: number) => {
  const t = typeof value === "string" ? value.trim() : "";
  if (t.length > max) invalid(`Keep it under ${max} characters.`);
  return t;
};

export type Theme = {
  primaryColor: string;
  headerStyle: "solid" | "light";
  font: "system" | "serif" | "rounded";
};
export type LayoutBlock =
  | { type: "search" }
  | { type: "collections" }
  | { type: "featured"; recordIds: string[] }
  | { type: "contact" };
export const DEFAULT_THEME: Theme = {
  primaryColor: "#087a57",
  headerStyle: "solid",
  font: "system",
};
export const DEFAULT_LAYOUT: LayoutBlock[] = [
  { type: "search" },
  { type: "collections" },
  { type: "contact" },
];

function validTheme(input: unknown, current: Theme = DEFAULT_THEME): Theme {
  if (input === undefined) return current;
  const t = (input ?? {}) as Record<string, unknown>;
  const theme = { ...current, ...t } as Theme;
  if (!/^#[0-9a-f]{6}$/i.test(String(theme.primaryColor)))
    invalid("Choose a colour such as #087a57.");
  if (!["solid", "light"].includes(theme.headerStyle))
    invalid("Choose a solid or light header.");
  if (!["system", "serif", "rounded"].includes(theme.font))
    invalid("Choose a font style.");
  return {
    primaryColor: theme.primaryColor.toLowerCase(),
    headerStyle: theme.headerStyle,
    font: theme.font,
  };
}
async function validLayout(
  db: Sql,
  w: string,
  input: unknown,
): Promise<LayoutBlock[] | undefined> {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 4)
    return invalid("The homepage has up to four blocks.");
  const seen = new Set<string>();
  const out: LayoutBlock[] = [];
  for (const raw of input as Record<string, unknown>[]) {
    const type = raw?.type;
    if (
      !["search", "collections", "featured", "contact"].includes(String(type))
    )
      invalid("Unknown homepage block.");
    if (seen.has(String(type))) invalid("Each homepage block can appear once.");
    seen.add(String(type));
    if (type === "featured") {
      const ids = Array.isArray(raw.recordIds) ? raw.recordIds.map(String) : [];
      if (ids.length < 1 || ids.length > 6)
        invalid("Feature between one and six articles.");
      for (const id of ids) await placeable(db, w, id);
      out.push({ type: "featured", recordIds: [...new Set(ids)] });
    } else out.push({ type } as LayoutBlock);
  }
  return out;
}
function validLocales(input: unknown, fallback: string[]) {
  if (input === undefined) return fallback;
  if (!Array.isArray(input) || input.length < 1 || input.length > 30)
    invalid("Choose between one and 30 languages.");
  return [...new Set((input as unknown[]).map(validLocale))];
}

/**
 * Only public or signed-in articles with the help center switch on can be placed. Internal
 * content never reaches the help center (the database refuses the switch for it, too).
 */
async function placeable(db: Sql, w: string, id: string) {
  const r = (
    await db.query<{
      source: string;
      audience: string;
      for_help_center: boolean;
    }>(
      "SELECT source,audience,for_help_center FROM knowledge_records WHERE workspace_id=$1 AND id=$2",
      [w, id],
    )
  ).rows[0];
  assert(r, "KNOWLEDGE_NOT_FOUND", "Knowledge record unavailable.", 404);
  const refuse = (message: string) => {
    throw new DomainError("HELP_NOT_PLACEABLE", message, 409);
  };
  if (r.source === "internal_article")
    refuse(
      "Internal articles are for teammates only and can't be in the help center.",
    );
  if (r.source !== "article")
    refuse("Only articles can be in the help center.");
  if (r.audience === "internal")
    refuse("Articles for teammates only can't be in the help center.");
  if (!r.for_help_center)
    refuse('Turn on "Show in the help center" for this article first.');
}

type CenterRow = {
  id: string;
  brand_id: string;
  name: string;
  slug: string;
  default_locale: string;
  locales: string[];
  theme: Theme;
  layout: LayoutBlock[];
  noindex: boolean;
  version: string;
};
const CENTER =
  "SELECT id,brand_id,name,slug,default_locale,locales,theme,layout,noindex,version::text AS version FROM help_centers";
async function center(db: Sql, w: string, id: unknown, lock = false) {
  const c = (
    await db.query<CenterRow>(
      `${CENTER} WHERE workspace_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
      [w, String(id ?? "")],
    )
  ).rows[0];
  assert(c, "HELP_CENTER_NOT_FOUND", "Help center unavailable.", 404);
  return c;
}
type NodeRow = {
  id: string;
  center_id: string;
  kind: "collection" | "section";
  parent_id: string | null;
  position: number;
  icon: string | null;
  archived: boolean;
  version: string;
};
async function node(db: Sql, w: string, id: unknown, lock = false) {
  const n = (
    await db.query<NodeRow>(
      `SELECT id,center_id,kind,parent_id,position,icon,archived,version::text AS version FROM help_nodes
      WHERE workspace_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
      [w, String(id ?? "")],
    )
  ).rows[0];
  assert(n, "HELP_NODE_NOT_FOUND", "Collection or section unavailable.", 404);
  return n;
}
const centerView = (c: CenterRow) => ({
  id: c.id,
  brandId: c.brand_id,
  name: c.name,
  slug: c.slug,
  defaultLocale: c.default_locale,
  locales: c.locales,
  theme: { ...DEFAULT_THEME, ...c.theme },
  layout: c.layout,
  noindex: c.noindex,
  version: c.version,
});
const freeCenterSlug = (db: Sql, w: string, base: string) =>
  freeSlug(
    slugify(base),
    "help",
    async (slug) =>
      (
        await db.query(
          "SELECT 1 FROM help_centers WHERE workspace_id=$1 AND slug=$2",
          [w, slug],
        )
      ).rows.length > 0,
  );
const nodeSlugTaken =
  (db: Sql, w: string, centerId: string, kind: string, locale: string) =>
  async (slug: string) =>
    (
      await db.query(
        "SELECT 1 FROM help_node_locales WHERE workspace_id=$1 AND center_id=$2 AND kind=$3 AND locale=$4 AND slug=$5",
        [w, centerId, kind, locale, slug],
      )
    ).rows.length > 0;

/** Help centers and the brands that can have one (`knowledge.manage`). */
export async function listHelpCenters(db: Sql, w: string, principal: string) {
  await manager(db, w, principal);
  const centers = (
    await db.query<CenterRow>(
      `${CENTER} WHERE workspace_id=$1 ORDER BY name,id`,
      [w],
    )
  ).rows;
  const brands = (
    await db.query<{ id: string; name: string }>(
      "SELECT id,name FROM brands WHERE workspace_id=$1 ORDER BY name,id",
      [w],
    )
  ).rows;
  return {
    centers: centers.map(centerView),
    brands: brands.map((b) => ({
      id: b.id,
      name: b.name,
      centerId: centers.find((c) => c.brand_id === b.id)?.id ?? null,
    })),
  };
}

/**
 * One help center for the editor: settings, the collection and section tree with each
 * language's name and slug, placed articles with why any of them would not show, and the old
 * slugs that redirect to each object.
 */
export async function readHelpCenter(
  db: Sql,
  w: string,
  principal: string,
  id: string,
) {
  await manager(db, w, principal);
  const c = await center(db, w, id);
  const nodes = (
    await db.query<NodeRow>(
      `SELECT id,center_id,kind,parent_id,position,icon,archived,version::text AS version FROM help_nodes
      WHERE workspace_id=$1 AND center_id=$2 ORDER BY position,id`,
      [w, c.id],
    )
  ).rows;
  const names = (
    await db.query<{
      node_id: string;
      locale: string;
      name: string;
      description: string;
      slug: string;
    }>(
      "SELECT node_id,locale,name,description,slug FROM help_node_locales WHERE workspace_id=$1 AND center_id=$2 ORDER BY locale",
      [w, c.id],
    )
  ).rows;
  const placements = (
    await db.query<{
      node_id: string;
      record_id: string;
      position: number;
      source: string;
      for_help_center: boolean;
      locales: {
        locale: string;
        status: string;
        title: string;
        slug: string | null;
      }[];
    }>(
      `SELECT p.node_id,p.record_id,p.position,r.source,r.for_help_center,
        COALESCE((SELECT json_agg(json_build_object('locale',l.locale,'status',l.status,'title',COALESCE(l.published_title,NULLIF(l.draft_title,''),''),'slug',l.slug) ORDER BY l.locale)
          FROM knowledge_locales l WHERE l.workspace_id=r.workspace_id AND l.record_id=r.id),'[]') AS locales
      FROM help_placements p JOIN help_nodes n ON n.workspace_id=p.workspace_id AND n.id=p.node_id
      JOIN knowledge_records r ON r.workspace_id=p.workspace_id AND r.id=p.record_id
      WHERE p.workspace_id=$1 AND n.center_id=$2 ORDER BY p.position,p.record_id`,
      [w, c.id],
    )
  ).rows;
  const redirects = (
    await db.query<{
      kind: string;
      locale: string;
      slug: string;
      target_id: string;
    }>(
      `SELECT kind,locale,slug,target_id FROM help_redirects WHERE workspace_id=$1
      AND ((kind IN ('collection','section') AND scope=$2) OR (kind='center' AND target_id=$2)
        OR (kind='article' AND target_id IN (SELECT record_id FROM help_placements p JOIN help_nodes n ON n.workspace_id=p.workspace_id AND n.id=p.node_id WHERE p.workspace_id=$1 AND n.center_id=$2)))
      ORDER BY created_at DESC`,
      [w, c.id],
    )
  ).rows;
  return {
    center: centerView(c),
    nodes: nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      parentId: n.parent_id,
      icon: n.icon,
      archived: n.archived,
      version: n.version,
      locales: names
        .filter((x) => x.node_id === n.id)
        .map((x) => ({
          locale: x.locale,
          name: x.name,
          description: x.description,
          slug: x.slug,
        })),
      articles: placements
        .filter((p) => p.node_id === n.id)
        .map((p) => ({
          id: p.record_id,
          locales: p.locales,
          // Why it would not show publicly, if it would not.
          hidden: !p.for_help_center
            ? "Not shown in the help center (switch off in its settings)."
            : !p.locales.some(
                  (l) =>
                    l.status === "published" && c.locales.includes(l.locale),
                )
              ? "Not published in any of this help center's languages."
              : null,
        })),
    })),
    redirects: redirects.map((r) => ({
      kind: r.kind,
      locale: r.locale,
      slug: r.slug,
      targetId: r.target_id,
    })),
  };
}

/**
 * Changes to help centers (`knowledge.manage`): center_create, center_settings, node_create,
 * node_update (a name, description or slug in one language, or the icon), node_archive,
 * node_restore, arrange (the order of collections, sections or articles), place and unplace.
 */
export async function changeHelpCenter(
  db: Sql,
  w: string,
  principal: string,
  p: Record<string, unknown>,
) {
  await manager(db, w, principal);
  switch (p.op) {
    case "center_create": {
      const brand = String(p.brandId ?? "");
      assert(
        (
          await db.query(
            "SELECT 1 FROM brands WHERE workspace_id=$1 AND id=$2",
            [w, brand],
          )
        ).rows.length,
        "INVALID_HELP_CENTER",
        "Choose a brand from this workspace.",
      );
      assert(
        !(
          await db.query(
            "SELECT 1 FROM help_centers WHERE workspace_id=$1 AND brand_id=$2",
            [w, brand],
          )
        ).rows.length,
        "HELP_CENTER_EXISTS",
        "This brand already has a help center.",
        409,
      );
      const title = name(p.name);
      const defaultLocale = validLocale(p.defaultLocale ?? "en");
      const locales = validLocales(p.locales, [defaultLocale]);
      if (!locales.includes(defaultLocale)) locales.unshift(defaultLocale);
      const slug =
        p.slug === undefined
          ? await freeCenterSlug(db, w, title)
          : validSlug(p.slug);
      await centerSlugFree(db, w, slug, "");
      const id = crypto.randomUUID();
      await db.query(
        `INSERT INTO help_centers(workspace_id,id,brand_id,name,slug,default_locale,locales,theme,layout)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          w,
          id,
          brand,
          title,
          slug,
          defaultLocale,
          locales,
          JSON.stringify(validTheme(p.theme)),
          JSON.stringify(
            (await validLayout(db, w, p.layout)) ?? DEFAULT_LAYOUT,
          ),
        ],
      );
      await moveSlug(db, w, "center", "", "", null, slug, id);
      return { id, slug };
    }
    case "center_settings": {
      const c = await center(db, w, p.id, true);
      conflict(p.version, c.version);
      const title = p.name === undefined ? c.name : name(p.name);
      const defaultLocale =
        p.defaultLocale === undefined
          ? c.default_locale
          : validLocale(p.defaultLocale);
      const locales = validLocales(p.locales, c.locales);
      if (!locales.includes(defaultLocale))
        invalid(
          "The default language must be one of the help center's languages.",
        );
      const slug = p.slug === undefined ? c.slug : validSlug(p.slug);
      if (slug !== c.slug) await centerSlugFree(db, w, slug, c.id);
      const layout = (await validLayout(db, w, p.layout)) ?? c.layout;
      await db.query(
        `UPDATE help_centers SET name=$3,slug=$4,default_locale=$5,locales=$6,theme=$7,layout=$8,noindex=$9,version=version+1,updated_at=now()
        WHERE workspace_id=$1 AND id=$2`,
        [
          w,
          c.id,
          title,
          slug,
          defaultLocale,
          locales,
          JSON.stringify(validTheme(p.theme, { ...DEFAULT_THEME, ...c.theme })),
          JSON.stringify(layout),
          p.noindex === undefined ? c.noindex : p.noindex === true,
        ],
      );
      if (slug !== c.slug)
        await moveSlug(db, w, "center", "", "", c.slug, slug, c.id);
      return { id: c.id, slug, version: String(Number(c.version) + 1) };
    }
    case "node_create": {
      const c = await center(db, w, p.centerId);
      const kind = p.parentId ? "section" : "collection";
      if (p.parentId) {
        const parent = await node(db, w, p.parentId, true);
        assert(
          parent.center_id === c.id && parent.kind === "collection",
          "INVALID_HELP_CENTER",
          "Sections go inside a collection of the same help center.",
        );
      }
      const locale = centerLocale(c, p.locale);
      const title = name(p.name);
      const id = crypto.randomUUID();
      const position = (
        await db.query<{ n: number }>(
          "SELECT COALESCE(max(position)+1,0)::int AS n FROM help_nodes WHERE workspace_id=$1 AND center_id=$2 AND parent_id IS NOT DISTINCT FROM $3",
          [w, c.id, p.parentId ? String(p.parentId) : null],
        )
      ).rows[0].n;
      await db.query(
        "INSERT INTO help_nodes(workspace_id,id,center_id,kind,parent_id,position,icon) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          w,
          id,
          c.id,
          kind,
          p.parentId ? String(p.parentId) : null,
          position,
          icon(p.icon),
        ],
      );
      const slug = await freeSlug(
        slugify(title),
        kind,
        nodeSlugTaken(db, w, c.id, kind, locale),
      );
      await db.query(
        "INSERT INTO help_node_locales(workspace_id,node_id,center_id,kind,locale,name,description,slug) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [w, id, c.id, kind, locale, title, text(p.description, 500), slug],
      );
      await moveSlug(db, w, kind, c.id, locale, null, slug, id);
      return { id, slug };
    }
    case "node_update": {
      const n = await node(db, w, p.id, true);
      conflict(p.version, n.version);
      const c = await center(db, w, n.center_id);
      if (p.icon !== undefined)
        await db.query(
          "UPDATE help_nodes SET icon=$3 WHERE workspace_id=$1 AND id=$2",
          [w, n.id, icon(p.icon)],
        );
      let slug: string | undefined;
      if (p.locale !== undefined) {
        const locale = centerLocale(c, p.locale);
        const current = (
          await db.query<{ name: string; description: string; slug: string }>(
            "SELECT name,description,slug FROM help_node_locales WHERE workspace_id=$1 AND node_id=$2 AND locale=$3",
            [w, n.id, locale],
          )
        ).rows[0];
        const title =
          p.name === undefined && current ? current.name : name(p.name);
        const description =
          p.description === undefined
            ? (current?.description ?? "")
            : text(p.description, 500);
        const taken = nodeSlugTaken(db, w, c.id, n.kind, locale);
        if (p.slug !== undefined) {
          slug = validSlug(p.slug);
          assert(
            slug === current?.slug || !(await taken(slug)),
            "SLUG_TAKEN",
            `Another ${n.kind} in this language already uses that address.`,
            409,
          );
        } else
          slug =
            current?.slug ?? (await freeSlug(slugify(title), n.kind, taken));
        await db.query(
          `INSERT INTO help_node_locales(workspace_id,node_id,center_id,kind,locale,name,description,slug) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT(workspace_id,node_id,locale) DO UPDATE SET name=$6,description=$7,slug=$8`,
          [w, n.id, c.id, n.kind, locale, title, description, slug],
        );
        await moveSlug(
          db,
          w,
          n.kind,
          c.id,
          locale,
          current?.slug ?? null,
          slug,
          n.id,
        );
      }
      await bump(db, w, n.id);
      return { id: n.id, slug, version: String(Number(n.version) + 1) };
    }
    case "node_archive":
    case "node_restore": {
      // Archiving a collection hides its sections and articles too; nothing is deleted.
      const n = await node(db, w, p.id, true);
      await db.query(
        "UPDATE help_nodes SET archived=$3,version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
        [w, n.id, p.op === "node_archive"],
      );
      return { id: n.id, archived: p.op === "node_archive" };
    }
    case "arrange": {
      // The new order must name exactly the current members, so a concurrent add or remove
      // is not silently lost.
      const order = Array.isArray(p.order) ? p.order.map(String) : [];
      let current: string[];
      let table: "help_nodes" | "help_placements";
      let key: string;
      if (p.kind === "collections") {
        const c = await center(db, w, p.centerId, true);
        current = (
          await db.query<{ id: string }>(
            "SELECT id FROM help_nodes WHERE workspace_id=$1 AND center_id=$2 AND parent_id IS NULL",
            [w, c.id],
          )
        ).rows.map((r) => r.id);
        table = "help_nodes";
        key = "id";
      } else if (p.kind === "sections" || p.kind === "articles") {
        const n = await node(db, w, p.nodeId, true);
        current = (
          p.kind === "sections"
            ? await db.query<{ id: string }>(
                "SELECT id FROM help_nodes WHERE workspace_id=$1 AND parent_id=$2",
                [w, n.id],
              )
            : await db.query<{ id: string }>(
                "SELECT record_id AS id FROM help_placements WHERE workspace_id=$1 AND node_id=$2",
                [w, n.id],
              )
        ).rows.map((r) => r.id);
        table = p.kind === "sections" ? "help_nodes" : "help_placements";
        key = p.kind === "sections" ? "id" : "record_id";
        await bump(db, w, n.id);
      } else
        return invalid("Choose collections, sections or articles to arrange.");
      assert(
        order.length === current.length &&
          new Set(order).size === order.length &&
          order.every((id) => current.includes(id)),
        "HELP_CENTER_CONFLICT",
        "This list changed elsewhere. Reload and try again.",
        409,
      );
      await db.query(
        `UPDATE ${table} t SET position=o.n FROM unnest($2::text[]) WITH ORDINALITY AS o(id,n)
        WHERE t.workspace_id=$1 AND t.${key}=o.id${table === "help_placements" ? " AND t.node_id=$3" : ""}`,
        table === "help_placements" ? [w, order, String(p.nodeId)] : [w, order],
      );
      return { order };
    }
    case "place": {
      const n = await node(db, w, p.nodeId, true);
      const recordId = String(p.recordId ?? "");
      await placeable(db, w, recordId);
      await db.query(
        `INSERT INTO help_placements(workspace_id,node_id,record_id,position)
        VALUES($1,$2,$3,(SELECT COALESCE(max(position)+1,0) FROM help_placements WHERE workspace_id=$1 AND node_id=$2))
        ON CONFLICT DO NOTHING`,
        [w, n.id, recordId],
      );
      await bump(db, w, n.id);
      return { nodeId: n.id, recordId };
    }
    case "unplace": {
      const n = await node(db, w, p.nodeId, true);
      await db.query(
        "DELETE FROM help_placements WHERE workspace_id=$1 AND node_id=$2 AND record_id=$3",
        [w, n.id, String(p.recordId ?? "")],
      );
      await bump(db, w, n.id);
      return { nodeId: n.id, recordId: String(p.recordId ?? "") };
    }
  }
  return invalid("Unknown help center change.");
}
const bump = (db: Sql, w: string, id: string) =>
  db.query(
    "UPDATE help_nodes SET version=version+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",
    [w, id],
  );
const icon = (value: unknown) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[a-z-]{1,40}$/.test(value))
    invalid("Choose an icon from the list.");
  return value as string;
};
function centerLocale(c: CenterRow, value: unknown) {
  const locale = validLocale(value ?? c.default_locale);
  if (!c.locales.includes(locale))
    invalid("Add this language to the help center first.");
  return locale;
}
async function centerSlugFree(db: Sql, w: string, slug: string, self: string) {
  assert(
    !(
      await db.query(
        "SELECT 1 FROM help_centers WHERE workspace_id=$1 AND slug=$2 AND id<>$3",
        [w, slug, self],
      )
    ).rows.length,
    "SLUG_TAKEN",
    "Another help center already uses that address.",
    409,
  );
}

export type Resolved =
  | { type: "redirect"; path: string }
  | { type: "not_found" }
  | {
      type: "home";
      centerId: string;
      locale: string;
      chain: string[];
      canonical: string;
    }
  | {
      type: "collection" | "section";
      centerId: string;
      id: string;
      locale: string;
      /** The language its name is shown in (a fallback when it has no name in `locale`). */
      contentLocale: string;
      chain: string[];
      canonical: string;
    }
  | {
      type: "article";
      centerId: string;
      id: string;
      locale: string;
      /** The language shown: `locale`, or the first fallback it is published in. */
      contentLocale: string;
      chain: string[];
      /** The page in the language shown, which search engines should index. */
      canonical: string;
      audience: "public" | "signed_in";
    };

/**
 * A public help center path (`{center}/{locale}/articles/{slug}`, relative to the workspace's
 * help root) as the object to show, or a redirect to its current path. Old slugs redirect, an
 * unsupported language goes to the nearest supported one, and an article without a version in
 * the requested language is shown in the first fallback language it is published in, with that
 * language's page as canonical. For step B1, which renders it.
 */
export async function resolvePath(
  db: Sql,
  w: string,
  path: string,
): Promise<Resolved> {
  await requireKnowledge(db, w);
  const [centerSlug = "", requested = "", kind = "", slug = "", ...rest] = path
    .split("/")
    .filter(Boolean);
  if (rest.length) return { type: "not_found" };
  let c = (
    await db.query<CenterRow>(`${CENTER} WHERE workspace_id=$1 AND slug=$2`, [
      w,
      centerSlug,
    ])
  ).rows[0];
  if (!c) {
    const moved = await redirectTarget(db, w, "center", "", "", centerSlug);
    if (!moved) return { type: "not_found" };
    c = await center(db, w, moved);
    return {
      type: "redirect",
      path: [c.slug, requested, kind, slug].filter(Boolean).join("/"),
    };
  }
  const { locale, chain } = resolveLocale(requested || c.default_locale, {
    defaultLocale: c.default_locale,
    locales: c.locales,
  });
  if (requested !== locale)
    return {
      type: "redirect",
      path: [c.slug, locale, kind, slug].filter(Boolean).join("/"),
    };
  if (!kind)
    return {
      type: "home",
      centerId: c.id,
      locale,
      chain,
      canonical: helpPath.home(c.slug, locale),
    };
  if (!slug) return { type: "not_found" };
  if (kind === "collections" || kind === "sections") {
    const nodeKind = kind === "collections" ? "collection" : "section";
    let id = await firstLive(
      chain,
      async (l) =>
        (
          await db.query<{ node_id: string }>(
            "SELECT node_id FROM help_node_locales WHERE workspace_id=$1 AND center_id=$2 AND kind=$3 AND locale=$4 AND slug=$5",
            [w, c.id, nodeKind, l, slug],
          )
        ).rows[0]?.node_id,
    );
    let redirected = false;
    if (!id) {
      id = await firstLive(chain, (l) =>
        redirectTarget(db, w, nodeKind, c.id, l, slug),
      );
      redirected = true;
    }
    if (!id) return { type: "not_found" };
    const shown = (
      await db.query<{ locale: string; slug: string }>(
        `SELECT l.locale,l.slug FROM help_node_locales l JOIN help_nodes n ON n.workspace_id=l.workspace_id AND n.id=l.node_id
        LEFT JOIN help_nodes parent ON parent.workspace_id=n.workspace_id AND parent.id=n.parent_id
        WHERE l.workspace_id=$1 AND l.node_id=$2 AND n.center_id=$3 AND NOT n.archived AND NOT COALESCE(parent.archived,false)`,
        [w, id, c.id],
      )
    ).rows;
    const contentLocale = chain.find((l) => shown.some((x) => x.locale === l));
    if (!contentLocale) return { type: "not_found" };
    const expected = shown.find((x) => x.locale === contentLocale)!.slug;
    const page =
      nodeKind === "collection"
        ? helpPath.collection(c.slug, locale, expected)
        : helpPath.section(c.slug, locale, expected);
    if (redirected || expected !== slug)
      return { type: "redirect", path: page };
    return {
      type: nodeKind,
      centerId: c.id,
      id,
      locale,
      contentLocale,
      chain,
      canonical:
        nodeKind === "collection"
          ? helpPath.collection(c.slug, contentLocale, expected)
          : helpPath.section(c.slug, contentLocale, expected),
    };
  }
  if (kind !== "articles") return { type: "not_found" };
  let id = await firstLive(
    chain,
    async (l) =>
      (
        await db.query<{ record_id: string }>(
          "SELECT record_id FROM knowledge_locales WHERE workspace_id=$1 AND locale=$2 AND slug=$3",
          [w, l, slug],
        )
      ).rows[0]?.record_id,
  );
  let redirected = false;
  if (!id) {
    id = await firstLive(chain, (l) =>
      redirectTarget(db, w, "article", "", l, slug),
    );
    redirected = true;
  }
  if (!id) return { type: "not_found" };
  // Shown only when placed in a live collection or section of this help center, with the help
  // center switch on, and published in one of the languages in the chain.
  const visible = (
    await db.query<{ audience: "public" | "signed_in" }>(
      `SELECT r.audience FROM knowledge_records r WHERE r.workspace_id=$1 AND r.id=$2 AND r.source='article' AND r.for_help_center
      AND EXISTS(SELECT 1 FROM help_placements p JOIN help_nodes n ON n.workspace_id=p.workspace_id AND n.id=p.node_id
        LEFT JOIN help_nodes parent ON parent.workspace_id=n.workspace_id AND parent.id=n.parent_id
        WHERE p.workspace_id=r.workspace_id AND p.record_id=r.id AND n.center_id=$3 AND NOT n.archived AND NOT COALESCE(parent.archived,false))`,
      [w, id, c.id],
    )
  ).rows[0];
  if (!visible) return { type: "not_found" };
  const published = (
    await db.query<{ locale: string; slug: string | null }>(
      "SELECT locale,slug FROM knowledge_locales WHERE workspace_id=$1 AND record_id=$2 AND status='published'",
      [w, id],
    )
  ).rows;
  const contentLocale = chain.find((l) =>
    published.some((x) => x.locale === l && x.slug),
  );
  if (!contentLocale) return { type: "not_found" };
  const expected = published.find((x) => x.locale === contentLocale)!.slug!;
  if (redirected || expected !== slug)
    return {
      type: "redirect",
      path: helpPath.article(c.slug, locale, expected),
    };
  return {
    type: "article",
    centerId: c.id,
    id,
    locale,
    contentLocale,
    chain,
    canonical: helpPath.article(c.slug, contentLocale, expected),
    audience: visible.audience,
  };
}
async function firstLive(
  chain: string[],
  find: (locale: string) => Promise<string | undefined | null>,
) {
  for (const l of chain) {
    const id = await find(l);
    if (id) return id;
  }
  return null;
}
async function redirectTarget(
  db: Sql,
  w: string,
  kind: string,
  scope: string,
  locale: string,
  slug: string,
) {
  return (
    (
      await db.query<{ target_id: string }>(
        "SELECT target_id FROM help_redirects WHERE workspace_id=$1 AND kind=$2 AND scope=$3 AND locale=$4 AND slug=$5",
        [w, kind, scope, locale, slug],
      )
    ).rows[0]?.target_id ?? null
  );
}
