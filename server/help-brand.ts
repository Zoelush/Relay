import { DomainError, type Sql } from "./db";
import { enqueueJob, type Job } from "./jobs";
import { manager } from "./knowledge";
import { FetchRefused, safeFetch, type FetchPolicy } from "./safe-fetch";
import { contrast, luminance, readableOn, shade } from "../lib/help-theme";

/**
 * "Import your brand" (the November 2026 help center rebuild; docs/HELP_CENTER_DESIGN.md): a
 * website's own colours and name, suggested for the help center's look.
 *
 * The fetch is a background job (`help.brand.import`), because a stranger's site decides how long
 * it takes; the editor polls the job and puts what comes back into the draft, where the person
 * can change any of it before saving. Nothing is saved by the job itself. Only public https
 * addresses are read, through `safeFetch`, and only the page and its own stylesheets: no scripts
 * run, and nothing but colours and the site's name is kept.
 */
export type BrandSuggestion = {
  /** The address that was actually read (after redirects). */
  site: string;
  name: string;
  actionColor: string;
  bodyBackground: string;
  heroColors: string[];
  heroText: string;
};

const HEX = /#([0-9a-f]{3}|[0-9a-f]{6})\b/gi;
const RGB = /rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/gi;

/** A three or six digit hex as #rrggbb. */
function full(hex: string) {
  const h = hex.slice(1).toLowerCase();
  return "#" + (h.length === 3 ? [...h].map((c) => c + c).join("") : h);
}
const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** How colourful it is (0 grey, 1 pure): a brand's colour is never a grey. */
function saturation(hex: string) {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

/**
 * The colours a page uses, most used first. Counts every hex and rgb() in the markup and its own
 * stylesheets; greys, near-white and near-black are left out, so what remains is the brand's.
 */
export function brandColors(css: string) {
  const counts = new Map<string, number>();
  const add = (hex: string) => {
    if (saturation(hex) < 0.22) return;
    const l = luminance(hex);
    if (l > 0.82 || l < 0.02) return;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  };
  for (const m of css.matchAll(HEX)) add(full(m[0]));
  for (const m of css.matchAll(RGB)) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if (r > 255 || g > 255 || b > 255) continue;
    add("#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join(""));
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([hex]) => hex);
}

/** `<meta name="theme-color">`, which a site states on purpose: the best guess there is. */
function themeColor(html: string) {
  const m = /<meta[^>]+name=["']theme-color["'][^>]*>/i.exec(html);
  const content = m && /content=["']([^"']+)["']/i.exec(m[0])?.[1];
  const hex = content && HEX.exec(content.trim());
  HEX.lastIndex = 0;
  return hex ? full(hex[0]) : null;
}
function siteName(html: string, host: string) {
  const og = /<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']{1,120})["']/i.exec(html);
  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html);
  const text = (og?.[1] ?? title?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim()
    // "Acme | Support", "Acme - Home": the part before the separator is the name.
    .split(/\s[|–—-]\s/)[0]
    .trim();
  return (text || host.replace(/^www\./, "")).slice(0, 80);
}
/** The page's own stylesheets (same host, up to three), where most of a site's colours live. */
function stylesheets(html: string, page: URL) {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/rel=["']?stylesheet/i.test(m[0])) continue;
    const href = /href=["']([^"']+)["']/i.exec(m[0])?.[1];
    if (!href) continue;
    try {
      const url = new URL(href, page);
      if (url.host === page.host && out.length < 3) out.push(url.toString());
    } catch {
      /* not an address this page can use either */
    }
  }
  return out;
}

/** What a page suggests for the help center's look. */
export function readBrand(html: string, pageUrl: string, css = ""): BrandSuggestion {
  const page = new URL(pageUrl);
  const found = brandColors(html + css);
  const stated = themeColor(html);
  // A stated theme colour wins, unless it's a near-white page background.
  const action = (stated && saturation(stated) >= 0.22 ? stated : null) ?? found[0] ?? "#087a57";
  // The hero reads as a sweep of the brand colour; a second brand colour makes it its own.
  const second = found.find((c) => c !== action && contrast(c, action) > 1.3);
  const hero = [action, second ?? shade(action, -0.35)];
  return {
    site: page.origin,
    name: siteName(html, page.host),
    actionColor: action,
    bodyBackground: "#f6f7f8",
    heroColors: hero,
    heroText: readableOn(action),
  };
}

/** Starts the import; the editor polls the job (`/v1/agent/job`) for the suggestion. */
export async function startBrandImport(
  db: Sql,
  w: string,
  principal: string,
  p: { url: unknown },
) {
  const t = await manager(db, w, principal);
  const raw = typeof p.url === "string" ? p.url.trim() : "";
  const address = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
  if (!raw || raw.length > 300)
    throw new DomainError("INVALID_ADDRESS", "Enter your website's address.", 400);
  return {
    jobId: await enqueueJob(db, w, "help.brand.import", { url: address }, { teammateId: t.id }),
  };
}

const REFUSALS: Record<string, string> = {
  ADDRESS_NOT_ALLOWED: "That isn't a public website address.",
  TOO_MANY_REDIRECTS: "That address redirects too many times.",
  TOO_LARGE: "That page is too large to read.",
  TIMEOUT: "That website took too long to answer.",
  UNREACHABLE: "That website couldn't be reached.",
};

/** The job: read the page and its stylesheets, and keep the colours and the name. */
export async function runBrandImport(
  policy: FetchPolicy,
  job: Job,
): Promise<{ done: boolean; result: Record<string, unknown> }> {
  const url = String(job.payload.url ?? "");
  const refuse = (message: string) => ({ done: true, result: { refused: message } });
  let page;
  try {
    page = await safeFetch(url, policy, { accept: "text/html" }, { maxBytes: 2_000_000, timeoutMs: 10_000 });
  } catch (e) {
    if (e instanceof FetchRefused) return refuse(REFUSALS[e.code] ?? REFUSALS.UNREACHABLE);
    throw e;
  }
  if (page.status !== 200 || !page.body)
    return refuse("That website didn't give us a page to read.");
  let css = "";
  for (const href of stylesheets(page.body, new URL(page.url))) {
    try {
      const sheet = await safeFetch(href, policy, { accept: "text/css" }, { maxBytes: 1_000_000, timeoutMs: 8_000 });
      if (sheet.status === 200) css += sheet.body;
    } catch {
      // A stylesheet that won't load only makes the guess rougher.
    }
  }
  // Nothing is saved: the editor puts this into the draft, where it can be changed.
  return { done: true, result: { brand: readBrand(page.body, page.url, css) } };
}
