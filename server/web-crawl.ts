import { Parser } from "htmlparser2";

/**
 * The pieces of website sync that read the web (phase 07, step C1b): stable page addresses,
 * exclusion patterns, robots.txt, sitemaps, the selectors that strip parts of a page, and a
 * page's text, title, language, canonical address and links.
 */

const TRACKING =
  /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_cid|mc_eid|_ga|_gl|yclid)$/i;
/** Files that are not web pages: never queued. */
const NOT_PAGES =
  /\.(pdf|png|jpe?g|gif|webp|svg|ico|bmp|tiff?|zip|gz|tgz|rar|7z|mp[34]|m4a|mov|avi|webm|wav|ogg|css|js|mjs|json|xml|txt|csv|xlsx?|docx?|pptx?|woff2?|ttf|eot|exe|dmg|apk)$/i;

/**
 * A page's stable id: its address with the fragment and tracking parameters removed and the
 * other parameters sorted. Null for anything but http(s).
 */
export function normalizeUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.username = "";
  url.password = "";
  const params = [...url.searchParams].filter(([k]) => !TRACKING.test(k));
  params.sort(([a, x], [b, y]) =>
    a === b ? x.localeCompare(y) : a.localeCompare(b),
  );
  url.search = params.length
    ? "?" + new URLSearchParams(params).toString()
    : "";
  return url.toString();
}
export const looksLikePage = (url: string) =>
  !NOT_PAGES.test(new URL(url).pathname);

/**
 * Exclusion patterns: `*` matches anything. A pattern starting with `/` is matched against the
 * path and query; any other against the address without its scheme (`example.com/blog/*`).
 */
export function excluded(url: string, patterns: string[]) {
  const u = new URL(url);
  const path = u.pathname + u.search;
  const bare = u.host + path;
  return patterns.some((p) => {
    const re = new RegExp(
      "^" + p.trim().split("*").map(escape).join(".*") + "$",
      "i",
    );
    return p.trim().startsWith("/") ? re.test(path) : re.test(bare);
  });
}
const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
export function validPattern(p: string) {
  const t = p.trim();
  return t.length > 0 && t.length <= 300 && !/\s/.test(t);
}

/* ------------------------------------------------------------------------------------------ */
/* Selectors to strip: tag, #id, .class and [attribute] or [attribute=value], combined.        */

export type Selector = {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: { name: string; value?: string }[];
};
const SELECTOR =
  /^([a-z][a-z0-9-]*|\*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:=(?:"[^"]*"|'[^']*'|[^\]"']*))?\])*)$/i;
/** A selector the stripper understands, or null (combinators and pseudo-classes are not). */
export function parseSelector(raw: string): Selector | null {
  const s = raw.trim();
  const m = SELECTOR.exec(s);
  if (!s || !m || (!m[1] && !m[2])) return null;
  const sel: Selector = {
    tag: m[1] && m[1] !== "*" ? m[1].toLowerCase() : undefined,
    classes: [],
    attrs: [],
  };
  for (const part of m[2].match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g) ?? []) {
    if (part[0] === "#") sel.id = part.slice(1);
    else if (part[0] === ".") sel.classes.push(part.slice(1));
    else {
      const [name, ...rest] = part.slice(1, -1).split("=");
      const value = rest.length
        ? rest.join("=").replace(/^["']|["']$/g, "")
        : undefined;
      sel.attrs.push({ name: name.toLowerCase(), value });
    }
  }
  return sel;
}
export function matches(
  sel: Selector,
  tag: string,
  attribs: Record<string, string>,
) {
  if (sel.tag && sel.tag !== tag) return false;
  if (sel.id && attribs.id !== sel.id) return false;
  const classes = (attribs.class ?? "").split(/\s+/);
  if (sel.classes.some((c) => !classes.includes(c))) return false;
  return sel.attrs.every((a) =>
    a.value === undefined ? a.name in attribs : attribs[a.name] === a.value,
  );
}

/* ------------------------------------------------------------------------------------------ */
/* robots.txt (RFC 9309): the group for RelayBot, else `*`; longest match wins, Allow on ties. */

export type Robots = {
  rules: { allow: boolean; pattern: string }[];
  sitemaps: string[];
};
export function parseRobots(text: string, agent = "relaybot"): Robots {
  type Group = { agents: string[]; rules: Robots["rules"] };
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") sitemaps.push(value);
    else if ((key === "allow" || key === "disallow") && current)
      // An empty Disallow allows everything: it adds no rule.
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
  }
  const mine = groups.filter((g) => g.agents.some((a) => a === agent));
  const chosen = mine.length
    ? mine
    : groups.filter((g) => g.agents.includes("*"));
  return { rules: chosen.flatMap((g) => g.rules), sitemaps };
}
export function robotsAllow(robots: Robots, url: string) {
  const u = new URL(url);
  const path = u.pathname + u.search;
  let best: { allow: boolean; length: number } | null = null;
  for (const r of robots.rules) {
    const anchored = r.pattern.endsWith("$");
    const body = anchored ? r.pattern.slice(0, -1) : r.pattern;
    const re = new RegExp(
      "^" + body.split("*").map(escape).join(".*") + (anchored ? "$" : ""),
    );
    if (!re.test(path)) continue;
    const length = r.pattern.length;
    if (!best || length > best.length || (length === best.length && r.allow))
      best = { allow: r.allow, length };
  }
  return best?.allow ?? true;
}

/* ------------------------------------------------------------------------------------------ */

/** The page addresses in a sitemap, and the sitemaps listed in a sitemap index. */
export function parseSitemap(xml: string) {
  const urls: string[] = [];
  const sitemaps: string[] = [];
  const stack: string[] = [];
  let text = "";
  const parser = new Parser(
    {
      onopentag(name) {
        stack.push(name.replace(/^.*:/, "").toLowerCase());
        text = "";
      },
      ontext(t) {
        text += t;
      },
      onclosetag() {
        const name = stack.pop();
        if (name === "loc") {
          const parent = stack[stack.length - 1];
          if (parent === "url") urls.push(text.trim());
          else if (parent === "sitemap") sitemaps.push(text.trim());
        }
        text = "";
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(xml);
  parser.end();
  return { urls, sitemaps };
}

/* ------------------------------------------------------------------------------------------ */

const SKIP = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "head",
  "object",
  "canvas",
]);
const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "nav",
  "li",
  "ul",
  "ol",
  "tr",
  "table",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "br",
  "hr",
  "blockquote",
  "pre",
  "dt",
  "dd",
  "figure",
  "figcaption",
]);

export type PageContent = {
  text: string;
  title: string | null;
  lang: string | null;
  canonical: string | null;
  links: string[];
  noindex: boolean;
  nofollow: boolean;
};
/**
 * A page's visible text, without scripts, styles, non-content and anything matching `strip`;
 * blocks on their own lines, table cells spaced. Also its title (<title>, else the first <h1>),
 * language, canonical address, links, and robots meta directives.
 */
export function readPage(source: string, strip: Selector[] = []): PageContent {
  const out: string[] = [];
  const links: string[] = [];
  let title = "",
    inTitle = false,
    h1 = "",
    inH1 = false,
    lang: string | null = null,
    canonical: string | null = null,
    noindex = false,
    nofollow = false,
    hidden = 0;
  // Per open element: whether it started a hidden region (skipped or stripped).
  const stack: boolean[] = [];
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === "html" && attribs.lang) lang = attribs.lang;
        if (name === "title") inTitle = true;
        if (name === "h1" && !h1) inH1 = true;
        if (name === "link" && /(^|\s)canonical(\s|$)/i.test(attribs.rel ?? ""))
          canonical = attribs.href ?? null;
        if (
          name === "meta" &&
          /^(robots|relaybot)$/i.test(attribs.name ?? "")
        ) {
          const c = (attribs.content ?? "").toLowerCase();
          if (/noindex|none/.test(c)) noindex = true;
          if (/nofollow|none/.test(c)) nofollow = true;
        }
        if (
          name === "a" &&
          attribs.href &&
          !/(^|\s)nofollow(\s|$)/i.test(attribs.rel ?? "")
        )
          links.push(attribs.href);
        const hide =
          SKIP.has(name) || strip.some((s) => matches(s, name, attribs));
        stack.push(hide);
        if (hide) hidden++;
        else if (!hidden && BLOCK.has(name)) out.push("\n");
        if (!hidden && (name === "td" || name === "th")) out.push(" ");
      },
      onclosetag(name) {
        if (name === "title") inTitle = false;
        if (name === "h1") inH1 = false;
        if (stack.pop()) hidden--;
        else if (!hidden && BLOCK.has(name)) out.push("\n");
      },
      ontext(text) {
        if (inTitle) title += text;
        if (inH1) h1 += text;
        if (!hidden) out.push(text);
      },
    },
    {
      decodeEntities: true,
      lowerCaseTags: true,
      lowerCaseAttributeNames: true,
    },
  );
  parser.write(source);
  parser.end();
  const clean = (t: string) => t.replace(/\s+/g, " ").trim();
  return {
    text: out.join(""),
    title: clean(title) || clean(h1) || null,
    lang,
    canonical,
    links,
    noindex,
    nofollow,
  };
}
