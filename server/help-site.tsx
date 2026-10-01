/** @jsxImportSource react */
// The help center renders on the server; this pins React's JSX runtime even where a test runner
// compiles .tsx with its own (Playwright does, for component tests).
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tenant, type Connect, type Sql } from "./db";
import { currentSession } from "./portal";
import {
  DEFAULT_THEME,
  resolvePath,
  type LayoutBlock,
  type Theme,
} from "./help-centers";
import { helpPath, resolveLocale } from "../lib/help-paths";
import { plainText, type RichBlock, type RichDoc } from "../lib/rich-doc";
import { ArticleText } from "../lib/rich-view";
import { HELP_CSS, themeCss } from "./help-style";
import {
  helpStrings,
  isRtl,
  languageName,
  type HelpStrings,
} from "./help-strings";

/**
 * The public help center (phase 07, step B1), rendered on the server with no client script.
 *
 * Addresses: `/help/{workspace}/{center}/{locale}/…` on the Relay origin, or the root of a
 * custom domain mapped to the brand in `portal_domains` (`/{locale}/…`, with the portal at
 * `/portal`). Paths are resolved by `resolvePath` (step A2): old slugs and unsupported languages
 * redirect (301), and a page missing in a language is shown in the next one along, with that
 * language's page as canonical. The help center root picks a language from Accept-Language (302).
 *
 * Access: a help center is public or for signed-in customers, and an article can be for
 * signed-in customers. Signed in means the portal's verified customer session for the brand.
 * Restricted pages are never cached publicly, never in the sitemap, and always noindex; a visitor
 * without a session gets a sign-in page that names nothing on the page.
 *
 * TODO(phase 07 B2): search, article feedback and the messenger's Help space.
 * TODO(phase 07 C1): article images, once knowledge files have storage of their own.
 * TODO(phase 17): the hosted help subdomain and certificates for custom domains.
 */
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const PUBLIC_CACHE = "public, max-age=60, stale-while-revalidate=300";

type Center = {
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
type Node = {
  id: string;
  kind: "collection" | "section";
  parent_id: string | null;
  names: Record<string, { name: string; description: string; slug: string }>;
  articles: string[];
};
type Article = {
  id: string;
  audience: "public" | "signed_in";
  faq: boolean;
  locales: Record<
    string,
    { title: string; slug: string; publishedAt: string; text: string }
  >;
};
/** A page's address in each language it really exists in, for hreflang. */
type Alternates = { locale: string; path: string }[];

/** How addresses look on this host. */
type Site = {
  workspace: string;
  origin: string;
  /** A path from `resolvePath` (`{center}/{locale}/…`) as a URL path on this host. */
  url: (relative: string) => string;
  custom: boolean;
};
const hostedSite = (workspace: string, origin: string): Site => ({
  workspace,
  origin,
  custom: false,
  url: (rel) => `/help/${workspace}/${rel}`,
});
const customSite = (workspace: string, origin: string): Site => ({
  workspace,
  origin,
  custom: true,
  url: (rel) => "/" + rel.split("/").slice(1).join("/"),
});

/**
 * Serves help center requests and passes everything else to `load`. `ownOrigin` is Relay's
 * own origin, where only `/help/…` is the help center; any other host is checked against the
 * custom domains.
 */
export async function helpSite(
  request: Request,
  connect: Connect,
  ownOrigin: string,
  load: (request: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  let site: Site | null = null;
  let rest = "";
  if (url.origin !== ownOrigin) {
    const mapped = await tenant(
      connect,
      "_routing",
      async (db) =>
        (
          await db.query<{ workspace_id: string; brand_id: string }>(
            "SELECT workspace_id,brand_id FROM portal_domains WHERE host=$1",
            [url.host.toLowerCase()],
          )
        ).rows[0],
    );
    if (mapped) {
      if (/^\/(portal|v1|messenger)(\/|$)/.test(url.pathname))
        return load(request);
      site = customSite(mapped.workspace_id, url.origin);
      rest = url.pathname;
      return serve(request, connect, site, rest, mapped.brand_id, load);
    }
  }
  const hosted = url.pathname.match(/^\/help\/([^/]+)(\/.*)?$/);
  if (!hosted) return load(request);
  if (!ID.test(hosted[1])) return plainNotFound();
  site = hostedSite(hosted[1], url.origin);
  rest = hosted[2] ?? "/";
  return serve(request, connect, site, rest, null, load);
}

async function serve(
  request: Request,
  connect: Connect,
  site: Site,
  rest: string,
  brand: string | null,
  load: (request: Request) => Promise<Response>,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  const response = await tenant(connect, site.workspace, async (db) => {
    if (!(await enabled(db, site.workspace))) return plainNotFound();
    const segments = rest.split("/").filter(Boolean);
    // On a custom domain the help center is the brand's; its slug is implied.
    let center: Center | undefined;
    if (brand) {
      center = await centerBy(db, site.workspace, "brand_id", brand);
      if (!center) return null;
      segments.unshift(center.slug);
    } else if (segments[0])
      center = await centerBy(db, site.workspace, "slug", segments[0]);
    if (brand && segments.length === 2 && segments[1] === "robots.txt")
      return robots(site, center!);
    if (center && segments.length === 2 && segments[1] === "sitemap.xml")
      return sitemap(db, site, center);
    // The help center root: the visitor's language, from Accept-Language.
    if (center && segments.length === 1)
      return new Response(null, {
        status: 302,
        headers: {
          location: site.url(
            helpPath.home(center.slug, negotiate(request, center)),
          ),
          vary: "accept-language",
          "cache-control": "no-store",
        },
      });
    const resolved = await resolvePath(db, site.workspace, segments.join("/"));
    if (resolved.type === "redirect")
      return new Response(null, {
        status: 301,
        headers: {
          location: site.url(resolved.path),
          "cache-control": "public, max-age=300",
        },
      });
    if (!center) return plainNotFound();
    const session = await currentSession(
      db,
      { workspace: site.workspace, brand: center.brand_id },
      request.headers.get("cookie"),
    );
    const data = await loadCenter(db, site.workspace, center);
    const page = new Page(db, site, center, data, !!session);
    if (resolved.type === "not_found") return page.notFound(segments[1]);
    if (center.access === "signed_in" && !session)
      return page.signIn(resolved.locale);
    if (resolved.type === "home") return page.home(resolved.locale);
    if (resolved.type !== "article")
      return page.node(resolved.id, resolved.locale, resolved.chain);
    if (resolved.audience === "signed_in" && !session)
      return page.signIn(resolved.locale);
    return page.article(resolved.id, resolved.locale, resolved.chain);
  });
  if (!response) return load(new Request(request));
  return conditional(request, response);
}

async function enabled(db: Sql, w: string) {
  return (
    (
      await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM workspace_features WHERE workspace_id=$1 AND name IN ('knowledge_v1','help_center_v1') AND enabled",
        [w],
      )
    ).rows[0].n === 2
  );
}
async function centerBy(
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

/** The best supported language for the visitor (Accept-Language, by weight), else the default. */
export function negotiate(
  request: Request,
  center: { default_locale: string; locales: string[] },
) {
  const wanted = (request.headers.get("accept-language") ?? "")
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      return { tag: tag.trim(), q: q ? Number(q.trim().slice(2)) || 0 : 1, i };
    })
    .filter((x) => x.tag && x.tag !== "*" && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of wanted) {
    const { locale } = resolveLocale(tag, {
      defaultLocale: center.default_locale,
      locales: center.locales,
    });
    // resolveLocale falls back to the default; only accept a real match here.
    if (
      locale !== center.default_locale ||
      tag.split("-")[0] === locale.split("-")[0]
    )
      return locale;
  }
  return center.default_locale;
}

/** Everything visible in a help center: live collections and sections, and placed articles. */
async function loadCenter(db: Sql, w: string, c: Center) {
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
type CenterData = Awaited<ReturnType<typeof loadCenter>>;

const chainOf = (c: Center, locale: string) =>
  resolveLocale(locale, { defaultLocale: c.default_locale, locales: c.locales })
    .chain;
const first = <T,>(chain: string[], pick: (l: string) => T | undefined) => {
  for (const l of chain) {
    const v = pick(l);
    if (v) return { locale: l, value: v };
  }
  return null;
};

class Page {
  constructor(
    private db: Sql,
    private site: Site,
    private center: Center,
    private data: CenterData,
    private signedIn: boolean,
  ) {}
  private theme = (): Theme => ({ ...DEFAULT_THEME, ...this.center.theme });
  private abs = (path: string) => this.site.origin + path;

  /** An article as shown in a language: its version there, or the next one along. */
  private shown(id: string, chain: string[]) {
    const a = this.data.articles.get(id);
    if (!a || (a.audience === "signed_in" && !this.signedIn)) return null;
    return first(chain, (l) => a.locales[l]);
  }
  private articleUrl(id: string, locale: string, chain: string[]) {
    const s = this.shown(id, chain);
    return (
      s &&
      this.site.url(helpPath.article(this.center.slug, locale, s.value.slug))
    );
  }
  private nodeName(n: Node, chain: string[]) {
    return first(chain, (l) => n.names[l]);
  }
  private nodeUrl(n: Node, locale: string, chain: string[]) {
    const name = this.nodeName(n, chain);
    if (!name) return null;
    const path =
      n.kind === "collection"
        ? helpPath.collection(this.center.slug, locale, name.value.slug)
        : helpPath.section(this.center.slug, locale, name.value.slug);
    return this.site.url(path);
  }
  /** Articles in a collection or section (directly), visible to this visitor. */
  private articlesIn(n: Node, chain: string[]) {
    return n.articles.filter((id) => this.shown(id, chain));
  }
  private sections(n: Node) {
    return this.data.nodes.filter((s) => s.parent_id === n.id);
  }
  /** Visible articles in a collection, including its sections. */
  private count(n: Node, chain: string[]) {
    const ids = new Set(this.articlesIn(n, chain));
    for (const s of this.sections(n))
      for (const id of this.articlesIn(s, chain)) ids.add(id);
    return ids.size;
  }
  private homeUrl = (locale: string) =>
    this.site.url(helpPath.home(this.center.slug, locale));
  private portalUrl() {
    return this.site.custom
      ? "/portal"
      : `/portal/${this.site.workspace}/${this.center.brand_id}`;
  }
  private async portalOn() {
    return (
      (
        await this.db.query(
          "SELECT 1 FROM workspace_features WHERE workspace_id=$1 AND name='portal_v1' AND enabled",
          [this.site.workspace],
        )
      ).rows.length > 0
    );
  }

  async home(locale: string) {
    const chain = chainOf(this.center, locale);
    const t = helpStrings(locale);
    const collections = this.data.nodes.filter(
      (n) =>
        n.kind === "collection" &&
        this.nodeName(n, chain) &&
        this.count(n, chain) > 0,
    );
    const portal = await this.portalOn();
    const blocks = this.center.layout.map((b) => {
      if (b.type === "collections" && collections.length)
        return (
          <section key="collections" aria-label={this.center.name}>
            <ul className="grid">
              {collections.map((n) => {
                const name = this.nodeName(n, chain)!.value;
                return (
                  <li key={n.id}>
                    <a className="card" href={this.nodeUrl(n, locale, chain)!}>
                      <strong>{name.name}</strong>
                      {name.description && <p>{name.description}</p>}
                      <p>{t.articles(this.count(n, chain))}</p>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      if (b.type === "featured") {
        const ids = b.recordIds.filter((id) => this.shown(id, chain));
        if (!ids.length) return null;
        return (
          <section key="featured">
            <h2>{t.featured}</h2>
            {this.articleList(ids, locale, chain)}
          </section>
        );
      }
      if (b.type === "contact" && portal)
        return (
          <section key="contact" className="contact">
            <h2>{t.contactTitle}</h2>
            <p>{t.contactBody}</p>
            <a href={this.portalUrl()}>{t.contactLink}</a>
          </section>
        );
      // TODO(phase 07 B2): the search block.
      return null;
    });
    if (!collections.length && !blocks.some(Boolean))
      blocks.push(
        <p key="empty" className="lead">
          {t.empty}
        </p>,
      );
    return this.render({
      status: 200,
      locale,
      contentLocale: locale,
      title: this.center.name,
      heading: this.center.name,
      description: this.center.name,
      canonical: this.homeUrl(locale),
      alternates: this.center.locales.map((l) => ({
        locale: l,
        path: this.homeUrl(l),
      })),
      ogType: "website",
      crumbs: [],
      jsonLd: [
        {
          "@type": "WebSite",
          name: this.center.name,
          url: this.abs(this.homeUrl(locale)),
          inLanguage: locale,
        },
      ],
      portal,
      restricted: this.center.access === "signed_in",
      body: <>{blocks}</>,
    });
  }

  async node(id: string, locale: string, chain: string[]) {
    const n = this.data.nodes.find((x) => x.id === id);
    if (!n) return this.notFound(locale);
    const t = helpStrings(locale);
    const name = this.nodeName(n, chain)!;
    const parent = n.parent_id
      ? this.data.nodes.find((x) => x.id === n.parent_id)
      : null;
    const sections = this.sections(n).filter(
      (s) => this.nodeName(s, chain) && this.articlesIn(s, chain).length,
    );
    const direct = this.articlesIn(n, chain);
    const crumbs = [
      { name: t.home, url: this.homeUrl(locale) },
      ...(parent && this.nodeName(parent, chain)
        ? [
            {
              name: this.nodeName(parent, chain)!.value.name,
              url: this.nodeUrl(parent, locale, chain)!,
            },
          ]
        : []),
      { name: name.value.name, url: this.nodeUrl(n, locale, chain)! },
    ];
    const canonical =
      n.kind === "collection"
        ? helpPath.collection(this.center.slug, name.locale, name.value.slug)
        : helpPath.section(this.center.slug, name.locale, name.value.slug);
    return this.render({
      status: 200,
      locale,
      contentLocale: name.locale,
      title: `${name.value.name} | ${this.center.name}`,
      heading: name.value.name,
      description: name.value.description || name.value.name,
      canonical: this.site.url(canonical),
      alternates: this.center.locales
        .filter((l) => n.names[l])
        .map((l) => ({ locale: l, path: this.nodeUrl(n, l, [l])! })),
      ogType: "website",
      crumbs,
      jsonLd: [],
      portal: await this.portalOn(),
      restricted: this.center.access === "signed_in",
      notice:
        name.locale !== locale
          ? t.notTranslated(languageName(name.locale, locale, false))
          : undefined,
      body: (
        <>
          {name.value.description && (
            <p className="lead">{name.value.description}</p>
          )}
          {direct.length > 0 && this.articleList(direct, locale, chain)}
          {sections.map((s) => (
            <section key={s.id}>
              <h2>
                <a href={this.nodeUrl(s, locale, chain)!}>
                  {this.nodeName(s, chain)!.value.name}
                </a>
              </h2>
              {this.articleList(this.articlesIn(s, chain), locale, chain)}
            </section>
          ))}
          {!direct.length && !sections.length && (
            <p className="lead">{t.empty}</p>
          )}
        </>
      ),
    });
  }

  async article(id: string, locale: string, chain: string[]) {
    const a = this.data.articles.get(id);
    const shown = this.shown(id, chain);
    if (!a || !shown) return this.notFound(locale);
    const t = helpStrings(locale);
    const body = (
      await this.db.query<{ published_body: RichDoc; published_text: string }>(
        "SELECT published_body,published_text FROM knowledge_locales WHERE workspace_id=$1 AND record_id=$2 AND locale=$3",
        [this.site.workspace, id, shown.locale],
      )
    ).rows[0];
    // Breadcrumbs follow the first place the article is in.
    const home = { name: t.home, url: this.homeUrl(locale) };
    const where = this.data.nodes.find(
      (n) => n.articles.includes(id) && this.nodeName(n, chain),
    );
    const parent = where?.parent_id
      ? this.data.nodes.find((x) => x.id === where.parent_id)
      : null;
    const crumbs = [
      home,
      ...[parent, where]
        .filter((n): n is Node => !!n && !!this.nodeName(n, chain))
        .map((n) => ({
          name: this.nodeName(n, chain)!.value.name,
          url: this.nodeUrl(n, locale, chain)!,
        })),
    ];
    const canonical = this.site.url(
      helpPath.article(this.center.slug, shown.locale, shown.value.slug),
    );
    const description = summary(
      firstParagraph(body.published_body) ||
        body.published_text ||
        shown.value.text,
    );
    const date = new Intl.DateTimeFormat(locale, {
      dateStyle: "long",
      timeZone: "UTC",
    }).format(new Date(shown.value.publishedAt));
    const faq = a.faq ? faqPairs(body.published_body) : [];
    const restricted =
      this.center.access === "signed_in" || a.audience === "signed_in";
    return this.render({
      status: 200,
      locale,
      contentLocale: shown.locale,
      title: `${shown.value.title} | ${this.center.name}`,
      heading: shown.value.title,
      description,
      canonical,
      alternates: this.center.locales
        .filter((l) => a.locales[l])
        .map((l) => ({
          locale: l,
          path: this.site.url(
            helpPath.article(this.center.slug, l, a.locales[l].slug),
          ),
        })),
      ogType: "article",
      crumbs: [...crumbs, { name: shown.value.title, url: canonical }],
      jsonLd: [
        {
          "@type": "Article",
          headline: shown.value.title,
          description,
          inLanguage: shown.locale,
          dateModified: shown.value.publishedAt,
          mainEntityOfPage: this.abs(canonical),
          publisher: { "@type": "Organization", name: this.center.brand_name },
        },
        ...(faq.length
          ? [
              {
                "@type": "FAQPage",
                inLanguage: shown.locale,
                mainEntity: faq.map((q) => ({
                  "@type": "Question",
                  name: q.question,
                  acceptedAnswer: { "@type": "Answer", text: q.answer },
                })),
              },
            ]
          : []),
      ],
      portal: await this.portalOn(),
      restricted,
      notice:
        shown.locale !== locale
          ? t.notTranslated(languageName(shown.locale, locale, false))
          : undefined,
      body: (
        <article
          className="article"
          lang={shown.locale}
          dir={isRtl(shown.locale) ? "rtl" : undefined}
        >
          <p className="meta">{t.updated(date)}</p>
          <ArticleText
            doc={body.published_body}
            fallback={body.published_text}
            link={(recordId) => this.articleUrl(recordId, locale, chain)}
          />
        </article>
      ),
    });
  }

  async notFound(locale = this.center.default_locale) {
    const l = this.center.locales.includes(locale)
      ? locale
      : this.center.default_locale;
    const t = helpStrings(l);
    return this.render({
      status: 404,
      locale: l,
      contentLocale: l,
      title: `${t.notFoundTitle} | ${this.center.name}`,
      heading: t.notFoundTitle,
      description: t.notFoundTitle,
      canonical: null,
      alternates: [],
      ogType: "website",
      crumbs: [{ name: t.home, url: this.homeUrl(l) }],
      jsonLd: [],
      portal: await this.portalOn(),
      restricted: true,
      body: (
        <p className="lead">
          {t.notFoundBody} <a href={this.homeUrl(l)}>{t.home}</a>
        </p>
      ),
    });
  }

  /** For a visitor without a session: names nothing about the page they asked for. */
  async signIn(locale: string) {
    const t = helpStrings(locale);
    return this.render({
      status: 401,
      locale,
      contentLocale: locale,
      title: `${t.signInTitle} | ${this.center.name}`,
      heading: t.signInTitle,
      description: t.signInTitle,
      canonical: null,
      alternates: [],
      ogType: "website",
      crumbs: [],
      jsonLd: [],
      portal: true,
      restricted: true,
      body: (
        <>
          <p className="lead">{t.signInBody(this.center.brand_name)}</p>
          <p>
            <a href={this.portalUrl()}>{t.signInLink}</a>
          </p>
        </>
      ),
    });
  }

  private articleList(ids: string[], locale: string, chain: string[]) {
    return (
      <ul className="list">
        {ids.map((id) => (
          <li key={id}>
            <a href={this.articleUrl(id, locale, chain)!}>
              {this.shown(id, chain)!.value.title}
            </a>
          </li>
        ))}
      </ul>
    );
  }

  private async render(p: {
    status: number;
    locale: string;
    contentLocale: string;
    title: string;
    heading: string;
    description: string;
    canonical: string | null;
    alternates: Alternates;
    ogType: "website" | "article";
    crumbs: { name: string; url: string }[];
    jsonLd: Record<string, unknown>[];
    portal: boolean;
    /** Signed-in only, or an error page: never indexed or cached publicly. */
    restricted: boolean;
    notice?: string;
    body: ReactNode;
  }) {
    const t: HelpStrings = helpStrings(p.locale);
    const noindex = this.center.noindex || p.restricted || p.status !== 200;
    const theme = themeCss(this.theme());
    const defaultAlternate =
      p.alternates.find((a) => a.locale === this.center.default_locale) ??
      p.alternates[0];
    const graph = [
      ...p.jsonLd,
      ...(p.crumbs.length > 1
        ? [
            {
              "@type": "BreadcrumbList",
              itemListElement: p.crumbs.map((c, i) => ({
                "@type": "ListItem",
                position: i + 1,
                name: c.name,
                item: this.abs(c.url),
              })),
            },
          ]
        : []),
    ];
    const jsonLd =
      graph.length && !noindex
        ? JSON.stringify({
            "@context": "https://schema.org",
            "@graph": graph,
          }).replace(/</g, "\\u003c")
        : null;
    const switcher = this.center.locales.length > 1 && p.status === 200;
    const html =
      "<!doctype html>" +
      renderToStaticMarkup(
        <html lang={p.locale} dir={isRtl(p.locale) ? "rtl" : "ltr"}>
          {/* A server-rendered document, not a Next.js page. */}
          {/* eslint-disable-next-line @next/next/no-head-element */}
          <head>
            <meta charSet="utf-8" />
            <meta
              name="viewport"
              content="width=device-width, initial-scale=1"
            />
            <title>{p.title}</title>
            <meta name="description" content={p.description} />
            {noindex && <meta name="robots" content="noindex, nofollow" />}
            {p.canonical && (
              <link rel="canonical" href={this.abs(p.canonical)} />
            )}
            {!noindex &&
              p.alternates.map((a) => (
                <link
                  key={a.locale}
                  rel="alternate"
                  hrefLang={a.locale}
                  href={this.abs(a.path)}
                />
              ))}
            {!noindex && defaultAlternate && (
              <link
                rel="alternate"
                hrefLang="x-default"
                href={this.abs(defaultAlternate.path)}
              />
            )}
            <meta property="og:type" content={p.ogType} />
            <meta property="og:title" content={p.heading} />
            <meta property="og:description" content={p.description} />
            <meta property="og:site_name" content={this.center.name} />
            <meta
              property="og:locale"
              content={p.contentLocale.replace("-", "_")}
            />
            {p.canonical && (
              <meta property="og:url" content={this.abs(p.canonical)} />
            )}
            <meta name="twitter:card" content="summary" />
            <style dangerouslySetInnerHTML={{ __html: HELP_CSS }} />
            <style dangerouslySetInnerHTML={{ __html: theme }} />
            {jsonLd && (
              <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{ __html: jsonLd }}
              />
            )}
          </head>
          <body>
            <a className="skip" href="#main">
              {p.heading}
            </a>
            <header className="top">
              <div className="top-inner">
                <a className="brand" href={this.homeUrl(p.locale)}>
                  {this.center.name}
                </a>
                <nav aria-label={this.center.name}>
                  {p.portal && <a href={this.portalUrl()}>{t.requests}</a>}
                  {switcher && (
                    <ul className="langs" aria-label={t.language}>
                      {this.center.locales.map((l) => (
                        <li key={l}>
                          <a
                            href={this.localeUrl(l, p)}
                            hrefLang={l}
                            lang={l}
                            aria-current={l === p.locale ? "page" : undefined}
                          >
                            {languageName(l)}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </nav>
              </div>
            </header>
            <div className="hero">
              <h1>{p.heading}</h1>
            </div>
            <main id="main">
              {p.crumbs.length > 1 && (
                <nav className="crumbs" aria-label="Breadcrumb">
                  <ol>
                    {p.crumbs.map((c, i) => (
                      <li key={i}>
                        {i === p.crumbs.length - 1 ? (
                          <span aria-current="page">{c.name}</span>
                        ) : (
                          <a href={c.url}>{c.name}</a>
                        )}
                      </li>
                    ))}
                  </ol>
                </nav>
              )}
              {p.notice && (
                <p className="notice" role="note">
                  {p.notice}
                </p>
              )}
              {p.body}
            </main>
            <footer>
              <div>{this.center.brand_name}</div>
            </footer>
          </body>
        </html>,
      );
    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": [
        "default-src 'none'",
        `style-src '${await sha256(HELP_CSS)}' '${await sha256(theme)}'`,
        "img-src 'self' data:",
        "frame-src https://www.youtube-nocookie.com https://player.vimeo.com",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
      "x-content-type-options": "nosniff",
      // YouTube's player needs the page's origin as referrer.
      "referrer-policy": "strict-origin-when-cross-origin",
      "cache-control":
        p.restricted || this.signedIn ? "private, no-store" : PUBLIC_CACHE,
      vary: "cookie",
      "content-language": p.contentLocale,
    });
    if (noindex) headers.set("x-robots-tag", "noindex, nofollow");
    return new Response(html, { status: p.status, headers });
  }

  /** The same page in another language: what that language's visitors would see. */
  private localeUrl(
    l: string,
    p: { canonical: string | null; alternates: Alternates },
  ) {
    const own = p.alternates.find((a) => a.locale === l);
    if (own) return own.path;
    // Not in that language: its fallback page, under that language's address.
    const canonical = p.canonical ?? "";
    const prefix = this.site.url(`${this.center.slug}/`);
    const rest = canonical.startsWith(prefix)
      ? canonical.slice(prefix.length).split("/").slice(1).join("/")
      : "";
    return rest
      ? this.site.url(`${this.center.slug}/${l}/${rest}`)
      : this.homeUrl(l);
  }
}

/** The first sentence or so of an article, for search results and link previews. */
export function summary(text: string) {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= 160) return t;
  const cut = t.slice(0, 157);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 120)).trimEnd() + "…";
}

/** The first paragraph's text: a better description than the whole text run together. */
function firstParagraph(doc: RichDoc | null) {
  const p = doc?.content.find((b) => b.type === "paragraph");
  return p ? plainText({ type: "doc", content: [p] }).trim() : "";
}

/** An FAQ article's questions: each level-2 heading ending in "?" and what follows it. */
export function faqPairs(doc: RichDoc | null) {
  const pairs: { question: string; answer: string }[] = [];
  let current: { question: string; blocks: RichBlock[] } | null = null;
  const flush = () => {
    if (current) {
      const answer = plainText({ type: "doc", content: current.blocks }).trim();
      if (answer) pairs.push({ question: current.question, answer });
    }
  };
  for (const block of doc?.content ?? []) {
    if (block.type === "heading" && block.attrs.level === 2) {
      flush();
      const text = plainText({ type: "doc", content: [block] }).trim();
      current = /[?？؟]$/.test(text) ? { question: text, blocks: [] } : null;
    } else current?.blocks.push(block);
  }
  flush();
  return pairs;
}

/** The sitemap: every public page in each language it exists in, with its alternates. */
async function sitemap(db: Sql, site: Site, center: Center) {
  const urls: { loc: string; lastmod?: string; alternates: Alternates }[] = [];
  if (!center.noindex && center.access === "public") {
    const data = await loadCenter(db, site.workspace, center);
    const home = (l: string) => site.url(helpPath.home(center.slug, l));
    const homes = center.locales.map((l) => ({ locale: l, path: home(l) }));
    for (const l of center.locales)
      urls.push({ loc: home(l), alternates: homes });
    for (const n of data.nodes) {
      const visible = [
        n,
        ...data.nodes.filter((s) => s.parent_id === n.id),
      ].some((x) =>
        x.articles.some((id) => data.articles.get(id)?.audience === "public"),
      );
      if (!visible) continue;
      const alts = center.locales
        .filter((l) => n.names[l])
        .map((l) => ({
          locale: l,
          path: site.url(
            n.kind === "collection"
              ? helpPath.collection(center.slug, l, n.names[l].slug)
              : helpPath.section(center.slug, l, n.names[l].slug),
          ),
        }));
      for (const a of alts) urls.push({ loc: a.path, alternates: alts });
    }
    for (const a of data.articles.values()) {
      if (a.audience !== "public") continue;
      const alts = center.locales
        .filter((l) => a.locales[l])
        .map((l) => ({
          locale: l,
          path: site.url(helpPath.article(center.slug, l, a.locales[l].slug)),
        }));
      for (const alt of alts)
        urls.push({
          loc: alt.path,
          lastmod: a.locales[alt.locale].publishedAt,
          alternates: alts,
        });
    }
  }
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const abs = (p: string) => esc(site.origin + p);
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    urls
      .map(
        (u) =>
          `<url><loc>${abs(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}${
            u.alternates.length > 1
              ? u.alternates
                  .map(
                    (a) =>
                      `<xhtml:link rel="alternate" hreflang="${esc(a.locale)}" href="${abs(a.path)}"/>`,
                  )
                  .join("")
              : ""
          }</url>`,
      )
      .join("\n") +
    "\n</urlset>\n";
  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

/** robots.txt on a custom domain (on Relay's own origin, the origin's own file applies). */
function robots(site: Site, center: Center) {
  const closed = center.noindex || center.access === "signed_in";
  const body = closed
    ? "User-agent: *\nDisallow: /\n"
    : `User-agent: *\nAllow: /\nDisallow: /portal\nDisallow: /v1/\nSitemap: ${site.origin}/sitemap.xml\n`;
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

function plainNotFound() {
  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}

async function sha256(text: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return "sha256-" + btoa(String.fromCharCode(...new Uint8Array(hash)));
}

/** ETag on successful pages; a matching If-None-Match gets 304. HEAD gets no body. */
async function conditional(request: Request, response: Response) {
  if (
    response.status !== 200 ||
    !response.headers.get("content-type")?.startsWith("text/html")
  ) {
    return request.method === "HEAD" ? new Response(null, response) : response;
  }
  const body = await response.text();
  const tag = `"${(await sha256(body)).slice(7, 34)}"`;
  const headers = new Headers(response.headers);
  headers.set("etag", tag);
  if (request.headers.get("if-none-match") === tag)
    return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers,
  });
}
