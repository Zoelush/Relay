import type { Sql } from "./db";
import type { LayoutBlock, Theme } from "./help-centers";
import { resolveLocale } from "../lib/help-paths";

/**
 * What a help center shows (phase 07): its live collections and sections, and the articles placed
 * in them that are switched on for the help center and published. Shared by the server-rendered
 * help center (B1) and the messenger's Help space (B2).
 */
export type Center = {
  id: string;
  brand_id: string;
  brand_name: string;
  name: string;
  slug: string;
  default_locale: string;
  locales: string[];
  theme: Partial<Theme>;
  layout: LayoutBlock[];
  noindex: boolean;
  access: "public" | "signed_in";
};
export type Node = {
  id: string;
  kind: "collection" | "section";
  parent_id: string | null;
  names: Record<string, { name: string; description: string; slug: string }>;
  articles: string[];
};
export type Article = {
  id: string;
  audience: "public" | "signed_in";
  faq: boolean;
  locales: Record<
    string,
    { title: string; slug: string; publishedAt: string; text: string }
  >;
};
/** A page's address in each language it really exists in, for hreflang. */

export async function enabled(db: Sql, w: string) {
  return (
    (
      await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM workspace_features WHERE workspace_id=$1 AND name IN ('knowledge_v1','help_center_v1') AND enabled",
        [w],
      )
    ).rows[0].n === 2
  );
}
export async function centerBy(
  db: Sql,
  w: string,
  column: "slug" | "brand_id",
  value: string,
) {
  return (
    await db.query<Center>(
      `SELECT c.id,c.brand_id,b.name AS brand_name,c.name,c.slug,c.default_locale,c.locales,c.theme,c.layout,c.noindex,c.access
      FROM help_centers c JOIN brands b ON b.workspace_id=c.workspace_id AND b.id=c.brand_id
      WHERE c.workspace_id=$1 AND c.${column}=$2`,
      [w, value],
    )
  ).rows[0];
}

/** Everything visible in a help center: live collections and sections, and placed articles. */
export async function loadCenter(db: Sql, w: string, c: Center) {
  const nodes = (
    await db.query<{
      id: string;
      kind: "collection" | "section";
      parent_id: string | null;
      names: Node["names"] | null;
      articles: string[] | null;
    }>(
      `SELECT n.id,n.kind,n.parent_id,
        (SELECT json_object_agg(l.locale,json_build_object('name',l.name,'description',l.description,'slug',l.slug))
          FROM help_node_locales l WHERE l.workspace_id=n.workspace_id AND l.node_id=n.id) AS names,
        (SELECT array_agg(p.record_id ORDER BY p.position,p.record_id) FROM help_placements p WHERE p.workspace_id=n.workspace_id AND p.node_id=n.id) AS articles
      FROM help_nodes n LEFT JOIN help_nodes parent ON parent.workspace_id=n.workspace_id AND parent.id=n.parent_id
      WHERE n.workspace_id=$1 AND n.center_id=$2 AND NOT n.archived AND NOT COALESCE(parent.archived,false)
      ORDER BY n.position,n.id`,
      [w, c.id],
    )
  ).rows.map((n): Node => ({
    ...n,
    names: n.names ?? {},
    articles: n.articles ?? [],
  }));
  const ids = [...new Set(nodes.flatMap((n) => n.articles))];
  const featured = c.layout.flatMap((b) =>
    b.type === "featured" ? b.recordIds : [],
  );
  const rows = (
    await db.query<{
      id: string;
      audience: "public" | "signed_in";
      faq: boolean;
      locale: string;
      title: string;
      slug: string;
      published_at: string;
      text: string;
    }>(
      `SELECT r.id,r.audience,r.faq,l.locale,l.published_title AS title,l.slug,l.published_at,left(COALESCE(l.published_text,''),400) AS text
      FROM knowledge_records r JOIN knowledge_locales l ON l.workspace_id=r.workspace_id AND l.record_id=r.id
      WHERE r.workspace_id=$1 AND r.id=ANY($2::text[]) AND r.source='article' AND r.for_help_center
        AND r.audience IN ('public','signed_in') AND l.status='published' AND l.slug IS NOT NULL AND l.locale=ANY($3::text[])`,
      [w, [...new Set([...ids, ...featured])], c.locales],
    )
  ).rows;
  const articles = new Map<string, Article>();
  for (const r of rows) {
    const a = articles.get(r.id) ?? {
      id: r.id,
      audience: r.audience,
      faq: r.faq,
      locales: {},
    };
    a.locales[r.locale] = {
      title: r.title,
      slug: r.slug,
      publishedAt: new Date(r.published_at).toISOString(),
      text: r.text,
    };
    articles.set(r.id, a);
  }
  // Featured articles show only if they are placed somewhere live.
  const placed = new Set(ids);
  for (const id of featured) if (!placed.has(id)) articles.delete(id);
  return { nodes, articles, featured };
}
export type CenterData = Awaited<ReturnType<typeof loadCenter>>;

export const chainOf = (c: Center, locale: string) =>
  resolveLocale(locale, { defaultLocale: c.default_locale, locales: c.locales })
    .chain;
export const first = <T>(
  chain: string[],
  pick: (l: string) => T | undefined,
) => {
  for (const l of chain) {
    const v = pick(l);
    if (v) return { locale: l, value: v };
  }
  return null;
};
