/** @jsxImportSource react */
// The help center renders on the server; this pins React's JSX runtime even where a test runner
// compiles .tsx with its own (Playwright does, for component tests).
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tenant, type Connect, type Sql } from "./db";
import { currentSession } from "./portal";
import { resolvePath } from "./help-centers";
import { helpPath, resolveLocale } from "../lib/help-paths";
import { plainText, type RichBlock, type RichDoc } from "../lib/rich-doc";
import { ArticleText, headingsOf } from "../lib/rich-view";
import { articleMarkdown } from "../lib/rich-markdown";
import { SOCIALS, themeOf, type HelpTheme, type Localized } from "../lib/help-theme";
import type { AttachmentStorage } from "./attachments";
import { fileResponse, publicFile } from "./knowledge-files";
import { DomainError } from "./db";
import { command } from "./conversations";
import {
  linkFeedback,
  logSearch,
  openedResult,
  recordFeedback,
  searchHelp,
} from "./help-search";
import {
  centerBy,
  chainOf,
  enabled,
  first,
  loadCenter,
  type Center,
  type CenterData,
  type Node,
} from "./help-content";
import { HELP_CSS, themeCss } from "./help-style";
import { ChevronRight, Frown, Meh, Search as SearchIcon, Smile } from "lucide-react";
import { helpIcon } from "../lib/help-icons";
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
 * Files (phase 07, C1a): `{center}/files/{id}` serves the theme's images, and images inside an
 * article the visitor may read (only those its published version uses).
 * TODO(phase 17): the hosted help subdomain and certificates for custom domains.
 */
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const PUBLIC_CACHE = "public, max-age=60, stale-while-revalidate=300";

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
  /** Tells the inbox about a conversation started from "Talk to us" (phase 07, B2). */
  notify?: (workspace: string, conversationId: string) => unknown,
  /** Where article and theme images are stored (phase 07, C1a). */
  storage?: AttachmentStorage,
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
      if (/^\/(portal|v1|messenger|help-fonts)(\/|$)/.test(url.pathname))
        return load(request);
      site = customSite(mapped.workspace_id, url.origin);
      rest = url.pathname;
      return serve(
        request,
        connect,
        site,
        rest,
        mapped.brand_id,
        load,
        notify,
        storage,
      );
    }
  }
  const hosted = url.pathname.match(/^\/help\/([^/]+)(\/.*)?$/);
  if (!hosted) return load(request);
  if (!ID.test(hosted[1])) return plainNotFound();
  site = hostedSite(hosted[1], url.origin);
  rest = hosted[2] ?? "/";
  return serve(request, connect, site, rest, null, load, notify, storage);
}

async function serve(
  request: Request,
  connect: Connect,
  site: Site,
  rest: string,
  brand: string | null,
  load: (request: Request) => Promise<Response>,
  notify?: (workspace: string, conversationId: string) => unknown,
  storage?: AttachmentStorage,
): Promise<Response> {
  const feedbackPost =
    request.method === "POST" && /\/feedback$/.test(rest.replace(/\/+$/, ""));
  if (request.method !== "GET" && request.method !== "HEAD" && !feedbackPost)
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  const url = new URL(request.url);
  let started: string | null = null;
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
    // Not live (switched off in its settings): nothing of it is served.
    if (center && !center.live) return plainNotFound();
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
    // Files: {center}/files/{id}, the theme's images and images in readable articles.
    if (center && segments[1] === "files" && segments.length === 3) {
      if (!storage || !ID.test(segments[2])) return plainNotFound();
      const session = await currentSession(
        db,
        { workspace: site.workspace, brand: center.brand_id },
        request.headers.get("cookie"),
      );
      const data = await loadCenter(db, site.workspace, center);
      const readable = (recordId: string) => {
        const a = data.articles.get(recordId);
        return (
          !!a &&
          (center.access === "public" || !!session) &&
          (a.audience === "public" || !!session)
        );
      };
      const file = await publicFile(
        db,
        site.workspace,
        center.id,
        segments[2],
        readable,
      );
      if (!file) return plainNotFound();
      const open = center.access === "public" && !session;
      return fileResponse(storage, file, {
        download: false,
        cache: open ? "public, max-age=300" : "private, max-age=300",
      });
    }
    // Search: {center}/{locale}/search?q=…, and …/search/open?r=…&a=… when a result is opened.
    if (center && segments[2] === "search" && segments.length <= 4) {
      const { locale, chain } = resolveLocale(segments[1], {
        defaultLocale: center.default_locale,
        locales: center.locales,
      });
      if (locale !== segments[1])
        return new Response(null, {
          status: 301,
          headers: {
            location:
              site.url([center.slug, locale, ...segments.slice(2)].join("/")) +
              url.search,
          },
        });
      const session = await currentSession(
        db,
        { workspace: site.workspace, brand: center.brand_id },
        request.headers.get("cookie"),
      );
      const page = new Page(
        db,
        site,
        center,
        await loadCenter(db, site.workspace, center),
        !!session,
        url,
      );
      if (center.access === "signed_in" && !session) return page.signIn(locale);
      if (segments[3] === "open") return page.openResult(locale, chain);
      if (segments[3]) return page.notFound(locale);
      return page.search(locale, chain);
    }
    // Feedback: POST {center}/{locale}/articles/{slug}/feedback.
    if (feedbackPost) {
      if (!center || segments.length !== 5 || segments[2] !== "articles")
        return plainNotFound();
      const origin = request.headers.get("origin");
      if (
        (origin && origin !== site.origin) ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        return new Response("Cross-site request refused", { status: 403 });
      const target = await resolvePath(
        db,
        site.workspace,
        segments.slice(0, 4).join("/"),
      );
      if (target.type !== "article") return plainNotFound();
      const session = await currentSession(
        db,
        { workspace: site.workspace, brand: center.brand_id },
        request.headers.get("cookie"),
      );
      if (
        (center.access === "signed_in" || target.audience === "signed_in") &&
        !session
      )
        return plainNotFound();
      const body = (await request.text()).slice(0, 4000);
      const page = new Page(
        db,
        site,
        center,
        await loadCenter(db, site.workspace, center),
        !!session,
        url,
      );
      const result = await page.feedback(
        target,
        new URLSearchParams(body),
        site.url(segments.slice(0, 4).join("/")),
        session,
      );
      started = result.conversationId;
      return result.response;
    }
    // An article as Markdown: its address with ".md" (when the help center offers it).
    const md =
      !!center &&
      segments.length === 4 &&
      segments[2] === "articles" &&
      segments[3].endsWith(".md");
    if (md) segments[3] = segments[3].slice(0, -3);
    const resolved = await resolvePath(db, site.workspace, segments.join("/"));
    if (resolved.type === "redirect")
      return new Response(null, {
        status: 301,
        headers: {
          location: site.url(resolved.path) + (md ? ".md" : ""),
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
    const page = new Page(db, site, center, data, !!session, url);
    if (resolved.type === "not_found")
      return md ? plainNotFound() : page.notFound(segments[1]);
    if (center.access === "signed_in" && !session)
      return md ? plainNotFound() : page.signIn(resolved.locale);
    if (resolved.type === "home") return page.home(resolved.locale);
    if (resolved.type !== "article")
      return page.node(resolved.id, resolved.locale, resolved.chain);
    if (resolved.audience === "signed_in" && !session)
      return md ? plainNotFound() : page.signIn(resolved.locale);
    return md
      ? page.markdown(resolved.id, resolved.locale, resolved.chain)
      : page.article(resolved.id, resolved.locale, resolved.chain);
  });
  if (!response) return load(new Request(request));
  if (started) await notify?.(site.workspace, started);
  return conditional(request, response);
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

/** The editor's live preview: a draft look, inert links, framed by the agent app. */
type PreviewMode = { fileUrl: (id: string) => string };

/**
 * A help center's page as the editor's live preview: `center` carries the draft theme and layout
 * (already checked). Shows everything a signed-in customer would see. Nothing is logged.
 */
export async function previewPage(
  db: Sql,
  w: string,
  origin: string,
  center: Center,
  show: "home" | "collection" | "article",
  wanted: string,
  fileUrl: (id: string) => string,
) {
  const { locale, chain } = resolveLocale(wanted, {
    defaultLocale: center.default_locale,
    locales: center.locales,
  });
  const page = new Page(
    db,
    hostedSite(w, origin),
    center,
    await loadCenter(db, w, center),
    true,
    new URL(origin + "/"),
    { fileUrl },
  );
  return page.previewOf(show, locale, chain);
}
/** What the preview's frame shows when the draft can't be drawn (a field that isn't valid yet). */
export function previewMessage(text: string) {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preview</title></head><body><p>${esc}</p></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; frame-ancestors 'self'",
        "cache-control": "no-store",
        "x-robots-tag": "noindex",
      },
    },
  );
}

class Page {
  constructor(
    private db: Sql,
    private site: Site,
    private center: Center,
    private data: CenterData,
    private signedIn: boolean,
    private url: URL,
    private preview: PreviewMode | null = null,
  ) {}
  private themeCache?: HelpTheme;
  private theme = () => (this.themeCache ??= themeOf(this.center.theme));
  /** A line kept per language, in this language or the next one along. */
  private text = (lines: Localized | undefined, chain: string[]) =>
    first(chain, (l) => lines?.[l])?.value ?? "";
  /** The preview's page: the home page, or the first collection or article there is. */
  async previewOf(show: "home" | "collection" | "article", locale: string, chain: string[]) {
    const collection = this.collections(chain)[0];
    if (show === "collection" && collection) return this.node(collection.id, locale, chain);
    if (show === "article") {
      const id = this.data.nodes.flatMap((n) => n.articles).find((a) => this.shown(a, chain));
      if (id) return this.article(id, locale, chain);
    }
    return this.home(locale);
  }
  /** Collections with a name and something to read, in order. */
  private collections = (chain: string[]) =>
    this.data.nodes.filter(
      (n) => n.kind === "collection" && this.nodeName(n, chain) && this.count(n, chain) > 0,
    );
  /** A collection's icon or image, as the theme asks; nothing with the text-only design. */
  private glyph(n: Node, size: number, page = false) {
    const theme = this.theme();
    if (theme.collectionDesign === "none") return null;
    const image = theme.collectionDesign === "images" ? theme.collectionImages[n.id] : null;
    if (image) {
      // eslint-disable-next-line @next/next/no-img-element
      const img = <img className={page ? undefined : "card-image"} src={this.fileUrl(image)} alt="" loading="lazy" />;
      return page ? <span className="page-icon">{img}</span> : img;
    }
    const Icon = helpIcon(n.icon);
    return (
      <span className={page ? "page-icon" : "card-icon"} aria-hidden="true">
        <Icon size={size} strokeWidth={1.75} />
      </span>
    );
  }
  private card(n: Node, locale: string, chain: string[]) {
    const style = this.theme().collectionStyle;
    const name = this.nodeName(n, chain)!.value;
    const count = <span className="count">{helpStrings(locale).articles(this.count(n, chain))}</span>;
    const glyph = this.glyph(n, style === "compact" ? 20 : style === "visual" ? 30 : 24);
    const words = (
      <>
        <strong>{name.name}</strong>
        {style !== "compact" && name.description && <p>{name.description}</p>}
        {count}
      </>
    );
    return (
      <a className="card surface" href={this.nodeUrl(n, locale, chain)!}>
        {style === "visual" ? (
          <>
            {glyph && <div className="card-visual">{glyph}</div>}
            <div className="card-text">{words}</div>
          </>
        ) : (
          <>
            {glyph}
            {words}
          </>
        )}
      </a>
    );
  }
  /** The modern template's left-hand navigation: every collection, the current one opened. */
  private sideNav(locale: string, chain: string[], at: { node?: string; article?: string }) {
    const t = helpStrings(locale);
    const collections = this.collections(chain);
    const holds = (n: Node) =>
      n.id === at.node ||
      this.sections(n).some((s) => s.id === at.node) ||
      (!!at.article && [n, ...this.sections(n)].some((x) => x.articles.includes(at.article!)));
    const open = collections.find(holds);
    const current = (yes: boolean) => (yes ? ("page" as const) : undefined);
    return (
      <nav className="side" aria-label={t.allCollections}>
        <details open>
          <summary>{t.allCollections}</summary>
          <ul>
            {collections.map((n) => (
              <li key={n.id}>
                <a className="group" href={this.nodeUrl(n, locale, chain)!} aria-current={current(n.id === at.node)}>
                  {this.nodeName(n, chain)!.value.name}
                </a>
                {n === open && (
                  <ul>
                    {this.articlesIn(n, chain).map((id) => (
                      <li key={id}>
                        <a href={this.articleUrl(id, locale, chain)!} aria-current={current(id === at.article)}>
                          {this.shown(id, chain)!.value.title}
                        </a>
                      </li>
                    ))}
                    {this.sections(n)
                      .filter((s) => this.nodeName(s, chain) && this.articlesIn(s, chain).length)
                      .map((s) => (
                        <li key={s.id}>
                          <a href={this.nodeUrl(s, locale, chain)!} aria-current={current(s.id === at.node)}>
                            {this.nodeName(s, chain)!.value.name}
                          </a>
                        </li>
                      ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </details>
      </nav>
    );
  }
  private footer(locale: string, chain: string[], portal: boolean) {
    const t = helpStrings(locale);
    const theme = this.theme();
    const logo = theme.footerLogoFileId ?? theme.logoFileId;
    const brand = (
      <span className="foot-brand">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={this.fileUrl(logo)} alt={this.center.brand_name} />
        ) : (
          this.center.brand_name
        )}
      </span>
    );
    const line = this.text(theme.footerText, chain);
    const text = line && <p className="foot-text">{line}</p>;
    const links = first(chain, (l) => (theme.footerLinks[l]?.length ? theme.footerLinks[l] : undefined))?.value ?? [];
    const own = (
      <>
        <li>
          <a href={this.homeUrl(locale)}>{t.home}</a>
        </li>
        {portal && (
          <li>
            <a href={this.portalUrl()}>{t.requests}</a>
          </li>
        )}
      </>
    );
    const out = (l: { title: string; url: string }, i: number) => (
      <li key={i}>
        <a href={l.url} rel="noopener noreferrer">
          {l.title}
        </a>
      </li>
    );
    const socials = theme.socials.length > 0 && (
      <ul className="socials">
        {theme.socials.map((s, i) => out({ title: SOCIALS[s.platform], url: s.url }, i))}
      </ul>
    );
    const powered = theme.poweredBy && <span className="powered">{t.poweredBy}</span>;
    if (theme.footerLayout === "multilevel") {
      const groups = new Map<string, typeof links>();
      for (const l of links) groups.set(l.group, [...(groups.get(l.group) ?? []), l]);
      return (
        <footer className="foot-multilevel">
          <div className="foot-inner">
            <div className="foot-top">
              <div className="foot-main">
                {brand}
                {text}
              </div>
              <nav className="foot-groups" aria-label={t.home}>
                <div>
                  <strong>{this.center.name}</strong>
                  <ul>{own}</ul>
                </div>
                {[...groups].map(([group, list]) => (
                  <div key={group}>
                    {group && <strong>{group}</strong>}
                    <ul>{list.map(out)}</ul>
                  </div>
                ))}
              </nav>
            </div>
            <div className="foot-end">
              {socials || <span />}
              {powered}
            </div>
          </div>
        </footer>
      );
    }
    const nav = (
      <nav aria-label={t.home}>
        <ul className="foot-links">
          {own}
          {links.map(out)}
        </ul>
      </nav>
    );
    if (theme.footerLayout === "classic")
      return (
        <footer className="foot-classic">
          <div className="foot-inner">
            <div className="foot-main">
              {brand}
              {text}
              {socials}
            </div>
            {nav}
            <div className="foot-end">
              <span>{this.center.brand_name}</span>
              {powered}
            </div>
          </div>
        </footer>
      );
    return (
      <footer>
        <div className="foot-inner">
          {brand}
          {text}
          {nav}
          {socials}
          {powered}
        </div>
      </footer>
    );
  }
  private searchUrl = (locale: string) =>
    this.site.url(`${this.center.slug}/${locale}/search`);
  private searchForm(locale: string, label: string, value = "") {
    const t = helpStrings(locale);
    return (
      <form
        role="search"
        className="search"
        action={this.searchUrl(locale)}
        method="get"
      >
        <SearchIcon size={18} aria-hidden="true" className="search-icon" />
        <input
          type="search"
          name="q"
          aria-label={label}
          placeholder={t.searchPlaceholder}
          defaultValue={value}
          maxLength={200}
        />
        <button type="submit">{t.search}</button>
      </form>
    );
  }
  private abs = (path: string) => this.site.origin + path;
  /** An uploaded image of this help center (theme or article image). */
  private fileUrl = (id: string) =>
    this.preview
      ? this.preview.fileUrl(id)
      : this.site.url(`${this.center.slug}/files/${id}`);

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
    const theme = this.theme();
    const collections = this.collections(chain);
    const portal = await this.portalOn();
    const blocks = this.center.layout.map((b, i) => {
      if (b.type === "collections" && collections.length)
        return (
          <section key="collections" aria-label={this.center.name}>
            <ul className={`grid style-${theme.collectionStyle}`}>
              {collections.map((n) => (
                <li key={n.id}>{this.card(n, locale, chain)}</li>
              ))}
            </ul>
          </section>
        );
      if (b.type === "featured") {
        const ids = b.recordIds.filter((id) => this.shown(id, chain));
        if (!ids.length) return null;
        return (
          <section key={i}>
            <h2>{this.text(b.title, chain) || t.featured}</h2>
            {this.articleList(ids, locale, chain, { columns: true })}
          </section>
        );
      }
      if (b.type === "content") {
        const title = this.text(b.title, chain);
        const description = this.text(b.description, chain);
        const label = this.text(b.buttonLabel, chain);
        if (!title && !description) return null;
        return (
          <section key={i} className={b.design === "full" ? "content-block content-full" : "content-block"}>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
            {label && b.buttonUrl && (
              <a className="button" href={b.buttonUrl} rel="noopener noreferrer">
                {label}
              </a>
            )}
          </section>
        );
      }
      if (b.type === "contact" && portal)
        return (
          <section key="contact" className="contact surface">
            <div>
              <h2>{t.contactTitle}</h2>
              <p>{t.contactBody}</p>
            </div>
            <a className="button" href={this.portalUrl()}>
              {t.contactLink}
            </a>
          </section>
        );
      // The first design's search block: the search box is the hero's now.
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
      title: this.text(theme.pageTitle, chain) || this.center.name,
      heading: this.welcome(locale),
      description: this.center.name,
      home: true,
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
      icon: n.kind === "collection" ? this.glyph(n, 26, true) : null,
      side: { node: n.id },
      lead: name.value.description || undefined,
      meta: t.articles(this.count(n, chain)),
      body: (
        <>
          {direct.length > 0 && this.articleList(direct, locale, chain, { descriptions: true })}
          {sections.map((s) => (
            <section key={s.id}>
              <div className="section-title">
                <h2>
                  <a href={this.nodeUrl(s, locale, chain)!}>
                    {this.nodeName(s, chain)!.value.name}
                  </a>
                </h2>
                <small>{t.articles(this.articlesIn(s, chain).length)}</small>
              </div>
              {this.articleList(this.articlesIn(s, chain), locale, chain, { descriptions: true })}
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
    const theme = this.theme();
    const related = theme.related
      ? await this.related(id, where ?? null, shown.value.title, chain)
      : [];
    const headings = theme.toc ? headingsOf(body.published_body) : [];
    const toc = headings.length > 1;
    const articlePath = this.site.url(
      helpPath.article(this.center.slug, locale, shown.value.slug),
    );
    const initials = a.author
      .split(/\s+/)
      .map((w) => w[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase();
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
          ...(theme.showAuthors && a.author
            ? { author: { "@type": "Person", name: a.author } }
            : {}),
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
      side: { article: id },
      byline: (
        <p className="byline">
          {theme.showAuthors && a.author && (
            <>
              <span className="avatar" aria-hidden="true">
                {initials}
              </span>
              <span>{t.writtenBy(a.author)}</span>
            </>
          )}
          <span>{t.updated(date)}</span>
          {theme.markdown && <a href={articlePath + ".md"}>{t.viewMarkdown}</a>}
        </p>
      ),
      body: (
        <div className={toc ? "article-layout" : "article-layout no-toc"}>
          <article
            className="article"
            lang={shown.locale}
            dir={isRtl(shown.locale) ? "rtl" : undefined}
          >
            <ArticleText
              doc={body.published_body}
              fallback={body.published_text}
              anchors={toc}
              link={(recordId) => this.articleUrl(recordId, locale, chain)}
              image={(image) => (
                // Server-rendered static markup, not a Next.js page.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={this.fileUrl(image.attachmentId)}
                  alt={image.alt ?? ""}
                  loading="lazy"
                />
              )}
            />
            {related.length > 0 && (
              <section className="related" aria-label={t.related}>
                <h2>{t.related}</h2>
                {this.articleList(related, locale, chain)}
              </section>
            )}
            {this.feedbackForm(locale, articlePath)}
          </article>
          {toc && (
            <nav className="toc" aria-label={t.onThisPage}>
              <strong>{t.onThisPage}</strong>
              <ol>
                {headings.map((h) => (
                  <li key={h.id} className={"l" + h.level}>
                    <a href={"#" + h.id}>{h.text}</a>
                  </li>
                ))}
              </ol>
            </nav>
          )}
        </div>
      ),
    });
  }

  /** An article as Markdown, for readers who paste it into another tool (when the theme offers it). */
  async markdown(id: string, locale: string, chain: string[]) {
    const a = this.data.articles.get(id);
    const shown = this.shown(id, chain);
    if (!a || !shown || !this.theme().markdown) return plainNotFound();
    const body = (
      await this.db.query<{ published_body: RichDoc; published_text: string }>(
        "SELECT published_body,published_text FROM knowledge_locales WHERE workspace_id=$1 AND record_id=$2 AND locale=$3",
        [this.site.workspace, id, shown.locale],
      )
    ).rows[0];
    const text = articleMarkdown(shown.value.title, body.published_body, body.published_text, {
      link: (recordId) => {
        const href = this.articleUrl(recordId, locale, chain);
        return href && this.abs(href);
      },
      image: (attachmentId) => this.abs(this.fileUrl(attachmentId)),
    });
    const closed = this.center.access === "signed_in" || a.audience === "signed_in" || this.signedIn;
    return new Response(text, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": closed ? "private, no-store" : PUBLIC_CACHE,
        vary: "cookie",
        "content-language": shown.locale,
        "x-content-type-options": "nosniff",
        // The page is the one to index, not its Markdown.
        "x-robots-tag": "noindex",
      },
    });
  }

  /**
   * Up to five related articles: the others where this one is placed, then (when those are few)
   * what a search for its title finds. Never the article itself, nor one the visitor can't read.
   */
  private async related(id: string, where: Node | null, title: string, chain: string[]) {
    const out: string[] = [];
    const add = (candidate: string) => {
      if (candidate !== id && !out.includes(candidate) && this.shown(candidate, chain)) out.push(candidate);
    };
    if (where) for (const other of this.articlesIn(where, chain)) add(other);
    if (out.length < 3)
      for (const r of await searchHelp(this.db, this.site.workspace, this.center.id, chain, title, this.signedIn, 8)) add(r.id);
    return out.slice(0, 5);
  }

  /** "Was this helpful?", the comment after a "No", or the thanks, depending on the URL. */
  private feedbackForm(locale: string, articlePath: string) {
    const t = helpStrings(locale);
    const state = this.url.searchParams.get("feedback") ?? "";
    const action = articlePath + "/feedback";
    let content: ReactNode;
    if (state === "thanks" || state === "talk")
      content = (
        <p role="status">
          {t.thanks}
          {state === "talk" && (
            <>
              {" "}
              {t.talkElsewhere(this.center.brand_name)}{" "}
              <a href={this.portalUrl()}>{t.requests}</a>
            </>
          )}
        </p>
      );
    else if (/^[0-9a-f-]{36}$/.test(state))
      content = (
        <form method="post" action={action}>
          <input type="hidden" name="feedback" value={state} />
          <label>
            {t.tellUs}
            <textarea name="comment" rows={3} maxLength={1000} />
          </label>
          <p className="buttons">
            <button type="submit" name="action" value="send">
              {t.send}
            </button>
            <button type="submit" name="action" value="talk">
              {t.sendAndTalk}
            </button>
          </p>
        </form>
      );
    else
      content = (
        <>
          <p className="question" id="feedback-question">
            {t.question}
          </p>
          <form method="post" action={action} className="vote" aria-labelledby="feedback-question">
            <button type="submit" name="helpful" value="no" aria-label={t.reactNo} title={t.reactNo}>
              <Frown size={26} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button type="submit" name="helpful" value="no" aria-label={t.reactPartly} title={t.reactPartly}>
              <Meh size={26} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button type="submit" name="helpful" value="yes" aria-label={t.reactYes} title={t.reactYes}>
              <Smile size={26} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </form>
        </>
      );
    return (
      <section id="feedback" className="feedback surface" aria-label={t.question}>
        {content}
      </section>
    );
  }

  /**
   * A feedback form's POST. A vote; then, after a "No", an optional comment and "Talk to us": a
   * signed-in customer starts a conversation (the article and their comment go to the teammate)
   * and lands on it in the portal. Anyone else is told how to reach the team.
   */
  async feedback(
    target: { id: string; locale: string; chain: string[] },
    form: URLSearchParams,
    articlePath: string,
    session: { identityId: string } | null,
  ): Promise<{ response: Response; conversationId: string | null }> {
    const back = (state: string) => ({
      response: new Response(null, {
        status: 303,
        headers: {
          location: `${articlePath}?feedback=${state}#feedback`,
          "cache-control": "no-store",
        },
      }),
      conversationId: null,
    });
    const shown = this.shown(target.id, target.chain);
    if (!shown) return { response: plainNotFound(), conversationId: null };
    const w = this.site.workspace;
    const helpful = form.get("helpful");
    if (helpful === "yes" || helpful === "no") {
      const { id } = await recordFeedback(this.db, w, {
        recordId: target.id,
        locale: shown.locale,
        surface: "help_center",
        helpful: helpful === "yes",
        identityId: session?.identityId ?? null,
      });
      return back(helpful === "yes" ? "thanks" : id);
    }
    const feedbackId = form.get("feedback") ?? "";
    if (!/^[0-9a-f-]{36}$/.test(feedbackId)) return back("thanks");
    const comment = (form.get("comment") ?? "").trim().slice(0, 1000);
    if (comment)
      await recordFeedback(this.db, w, {
        recordId: target.id,
        locale: shown.locale,
        surface: "help_center",
        feedbackId,
        comment,
      }).catch((e) => {
        // An old or already-commented vote: keep the visitor's flow going.
        if (!(e instanceof DomainError)) throw e;
      });
    if (form.get("action") !== "talk") return back("thanks");
    if (!session) return back("talk");
    const t = helpStrings(target.locale);
    // The saved comment, not the form's: a repeated post (a double click) is the same request,
    // so the conversation is started once.
    const saved = (
      await this.db.query<{ comment: string | null }>(
        "SELECT comment FROM knowledge_feedback WHERE workspace_id=$1 AND id=$2 AND record_id=$3",
        [w, feedbackId, target.id],
      )
    ).rows[0];
    if (!saved) return back("thanks");
    const result = (await command(
      this.db,
      w,
      {
        type: "contact",
        identityId: session.identityId,
        brandId: this.center.brand_id,
        verified: true,
      },
      "help-talk-" + feedbackId,
      {
        action: "start",
        text: saved.comment || t.talkDefault(shown.value.title),
        helpContext: {
          article: { id: target.id, title: shown.value.title },
          feedback: "not_helpful",
        },
      },
    )) as { conversationId: string };
    await linkFeedback(
      this.db,
      w,
      feedbackId,
      result.conversationId,
      session.identityId,
    );
    return {
      response: new Response(null, {
        status: 303,
        headers: {
          location: `${this.portalUrl()}?request=${encodeURIComponent(result.conversationId)}`,
          "cache-control": "no-store",
        },
      }),
      conversationId: result.conversationId,
    };
  }

  /** Search results: logged (without personal details) so the team learns what's missing. */
  async search(locale: string, chain: string[]) {
    const t = helpStrings(locale);
    const q = (this.url.searchParams.get("q") ?? "").trim().slice(0, 200);
    const results = q
      ? await searchHelp(
          this.db,
          this.site.workspace,
          this.center.id,
          chain,
          q,
          this.signedIn,
        )
      : [];
    const queryId = q
      ? await logSearch(this.db, this.site.workspace, {
          centerId: this.center.id,
          locale,
          surface: "help_center",
          query: q,
          results: results.length,
        })
      : null;
    const href = (id: string) =>
      queryId
        ? `${this.searchUrl(locale)}/open?r=${queryId}&a=${encodeURIComponent(id)}`
        : this.articleUrl(id, locale, chain)!;
    return this.render({
      status: 200,
      locale,
      contentLocale: locale,
      title: `${t.searchTitle} | ${this.center.name}`,
      heading: t.searchTitle,
      description: t.searchTitle,
      canonical: null,
      // The switcher keeps the search in another language (no hreflang: search pages are noindex).
      alternates: this.center.locales.map((l) => ({
        locale: l,
        path: this.searchUrl(l) + (q ? "?q=" + encodeURIComponent(q) : ""),
      })),
      ogType: "website",
      crumbs: [
        { name: t.home, url: this.homeUrl(locale) },
        { name: t.searchTitle, url: this.searchUrl(locale) },
      ],
      jsonLd: [],
      portal: await this.portalOn(),
      // Search pages are for people, not search engines, and are never cached (each is logged).
      restricted: true,
      query: q,
      body: (
        <>
          {q && (
            <p role="status" className="lead">
              {results.length ? t.results(results.length, q) : t.noResults(q)}
            </p>
          )}
          {results.length > 0 && (
            <ol className="rows results surface">
              {results.map((r) => (
                <li key={r.id}>
                  <a href={href(r.id)} lang={r.locale}>
                    <span>
                      {r.title}
                      {r.excerpt && <p>{r.excerpt}</p>}
                    </span>
                    <ChevronRight size={18} aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ol>
          )}
        </>
      ),
    });
  }

  /** A search result opened: noted against the search, then on to the article. */
  async openResult(locale: string, chain: string[]) {
    const article = this.url.searchParams.get("a") ?? "";
    const href = this.articleUrl(article, locale, chain);
    if (!href) return this.notFound(locale);
    const queryId = this.url.searchParams.get("r");
    if (queryId)
      await openedResult(this.db, this.site.workspace, queryId, article);
    return new Response(null, {
      status: 302,
      headers: { location: href, "cache-control": "no-store" },
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
            <a className="button" href={this.theme().loginUrl || this.portalUrl()}>
              {this.theme().loginUrl ? t.signIn : t.signInLink}
            </a>
          </p>
        </>
      ),
    });
  }

  private articleList(
    ids: string[],
    locale: string,
    chain: string[],
    as: { descriptions?: boolean; columns?: boolean } = {},
  ) {
    const descriptions = as.descriptions && this.theme().showDescriptions;
    return (
      <ul className={as.columns ? "rows surface columns" : "rows surface"}>
        {ids.map((id) => {
          const shown = this.shown(id, chain)!.value;
          const text = descriptions ? summary(shown.text) : "";
          return (
            <li key={id}>
              <a href={this.articleUrl(id, locale, chain)!}>
                <span>
                  {shown.title}
                  {text && <p>{text}</p>}
                </span>
                <ChevronRight size={18} aria-hidden="true" />
              </a>
            </li>
          );
        })}
      </ul>
    );
  }

  /** The hero's line on the home page: the theme's, in this language, else the default. */
  private welcome(locale: string) {
    return (
      this.text(this.theme().welcome, chainOf(this.center, locale)) ||
      helpStrings(locale).welcome(this.center.brand_name)
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
    /** The search page: the hero's box shows the query. */
    query?: string;
    /** The home page: the heading is the hero's welcome line. */
    home?: boolean;
    /** A collection's icon, a description, and a line under the heading (a date, a count). */
    icon?: ReactNode;
    lead?: string;
    meta?: string;
    /** An article's line under its heading: who wrote it, when, and its Markdown. */
    byline?: ReactNode;
    /** Where the page is, for the modern template's navigation; none on pages without it. */
    side?: { node?: string; article?: string };
    notice?: string;
    body: ReactNode;
  }) {
    const t: HelpStrings = helpStrings(p.locale);
    const noindex =
      this.center.noindex || p.restricted || p.status !== 200 || !!this.preview;
    const theme_ = this.theme();
    const theme = themeCss(theme_, this.center.layout, this.fileUrl);
    const chain = chainOf(this.center, p.locale);
    const headerLinks =
      first(chain, (l) =>
        theme_.headerLinks[l]?.length ? theme_.headerLinks[l] : undefined,
      )?.value ?? [];
    const modern =
      theme_.template === "modern" && !!p.side && p.status === 200;
    const content = (
      <>
        {!p.home && (
          <div className="page-head">
            {p.icon}
            <h1>{p.heading}</h1>
            {p.lead && <p className="lead">{p.lead}</p>}
            {p.byline ?? (p.meta && <p className="meta">{p.meta}</p>)}
          </div>
        )}
        {p.body}
      </>
    );
    const bodyClass =
      [theme_.designStyle === "floating" && "floating", this.preview && "preview"]
        .filter(Boolean)
        .join(" ") || undefined;
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
            {theme_.socialImageFileId && (
              <meta
                property="og:image"
                content={this.abs(this.fileUrl(theme_.socialImageFileId))}
              />
            )}
            <meta
              name="twitter:card"
              content={
                theme_.socialImageFileId ? "summary_large_image" : "summary"
              }
            />
            {theme_.faviconFileId && (
              <link rel="icon" href={this.fileUrl(theme_.faviconFileId)} />
            )}
            <style dangerouslySetInnerHTML={{ __html: HELP_CSS }} />
            <style dangerouslySetInnerHTML={{ __html: theme }} />
            {jsonLd && (
              <script
                type="application/ld+json"
                dangerouslySetInnerHTML={{ __html: jsonLd }}
              />
            )}
          </head>
          <body className={bodyClass}>
            <a className="skip" href="#main">
              {p.heading}
            </a>
            <div
              className={
                "hero" +
                (p.home ? " hero-home" : "") +
                (theme_.heroFade ? " hero-fade" : "")
              }
            >
              <header className="top">
                <div className="wrap top-inner">
                  <a className="brand" href={this.homeUrl(p.locale)}>
                    {theme_.logoFileId ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={this.fileUrl(theme_.logoFileId)}
                        alt={this.center.name}
                      />
                    ) : (
                      this.center.name
                    )}
                  </a>
                  <nav aria-label={this.center.name}>
                    {headerLinks.map((l, i) => (
                      <a key={i} href={l.url} rel="noopener noreferrer">
                        {l.title}
                      </a>
                    ))}
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
              <div className="wrap hero-body">
                <div className="hero-inner">
                  {p.home && <h1 className="hero-line">{p.heading}</h1>}
                  {p.status !== 401 &&
                    this.searchForm(p.locale, t.searchPlaceholder, p.query)}
                </div>
              </div>
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
              {modern ? (
                <div className="with-nav">
                  {this.sideNav(p.locale, chain, p.side!)}
                  <div>{content}</div>
                </div>
              ) : (
                content
              )}
            </main>
            {this.footer(p.locale, chain, p.portal)}
          </body>
        </html>,
      );
    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": [
        "default-src 'none'",
        `style-src '${await sha256(HELP_CSS)}' '${await sha256(theme)}'`,
        "img-src 'self' data:",
        "font-src 'self'",
        "frame-src https://www.youtube-nocookie.com https://player.vimeo.com",
        "base-uri 'none'",
        // Search (GET) and feedback (POST) forms go to this help center only.
        "form-action 'self'",
        // Only the editor's preview is ever framed, and only by the app that asked for it.
        this.preview ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
      ].join("; "),
      "x-content-type-options": "nosniff",
      // YouTube's player needs the page's origin as referrer.
      "referrer-policy": "strict-origin-when-cross-origin",
      "cache-control":
        p.restricted ||
        this.signedIn ||
        this.preview ||
        this.url.searchParams.has("feedback")
          ? "private, no-store"
          : PUBLIC_CACHE,
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
