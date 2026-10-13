import { Parser } from "htmlparser2";

/**
 * Inbound email HTML, made safe once when it's received (phase 12, step E2;
 * docs/OMNICHANNEL_STEP2.md). The inbox never renders a message's own HTML: only this.
 *
 * - **An allowlist** of layout and text tags. Scripts, styles, frames, forms, embeds and their
 *   contents go; so do all event handlers, and any attribute not listed.
 * - **Links:** only http, https and mailto, opened apart (`rel="noopener noreferrer"`).
 * - **Images:** remote ones are blocked by default: their address moves to `data-remote-src`,
 *   and the inbox loads them only when a teammate asks. Inline (`cid:`) images become the data
 *   the message carried (PNG, JPEG or GIF); other `data:` images are kept only if they're those types.
 * - **Inline styles:** kept only for a list of presentational properties, and never with `url(`,
 *   `expression`, `@import` or `javascript:`.
 *
 * `htmlText` turns HTML into plain text (for messages with no text part, and for search).
 */
const ALLOWED = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "center", "code", "col", "colgroup", "dd", "del", "div", "dl", "dt",
  "em", "font", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre",
  "q", "s", "small", "span", "strike", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
  "tt", "u", "ul",
]);
/** Their contents go too. */
const DROPPED = new Set(["script", "style", "head", "title", "iframe", "object", "embed", "applet", "frame", "frameset", "noscript", "template", "svg", "math", "form", "select", "textarea", "button", "audio", "video", "canvas", "xml"]);
const VOID = new Set(["br", "hr", "img", "col"]);
const ATTRIBUTES: Record<string, Set<string>> = {
  "*": new Set(["style", "title", "dir", "lang", "align", "valign", "width", "height", "bgcolor", "color"]),
  a: new Set(["href", "name"]),
  img: new Set(["src", "alt", "width", "height", "border"]),
  td: new Set(["colspan", "rowspan", "nowrap"]),
  th: new Set(["colspan", "rowspan", "nowrap", "scope"]),
  table: new Set(["border", "cellpadding", "cellspacing"]),
  font: new Set(["face", "size", "color"]),
  ol: new Set(["start", "type"]),
  blockquote: new Set(["type"]),
};
const STYLES = new Set([
  "color", "background-color", "font", "font-family", "font-size", "font-style", "font-weight", "text-align",
  "text-decoration", "text-transform", "line-height", "letter-spacing", "white-space", "vertical-align",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding", "padding-top", "padding-right",
  "padding-bottom", "padding-left", "border", "border-top", "border-right", "border-bottom", "border-left",
  "border-color", "border-style", "border-width", "border-collapse", "border-spacing", "border-radius", "width",
  "height", "max-width", "min-width", "display", "list-style-type",
]);
const IMAGE_DATA = /^data:image\/(png|jpeg|gif);base64,[a-z0-9+/=\s]+$/i;

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");

function style(value: string) {
  return value
    .split(";")
    .map((d) => {
      const at = d.indexOf(":");
      if (at < 0) return null;
      const prop = d.slice(0, at).trim().toLowerCase();
      const v = d.slice(at + 1).trim();
      if (!STYLES.has(prop) || !v || /url\s*\(|expression|@import|javascript:|behavior|-moz-binding|[<>\\]/i.test(v)) return null;
      // Nothing escapes the message's own box.
      if (prop === "display" && !/^(block|inline|inline-block|none|table|table-row|table-cell|list-item)$/i.test(v)) return null;
      return `${prop}: ${v}`;
    })
    .filter(Boolean)
    .join("; ");
}

/** Safe HTML from an email's own, with inline images as data and remote ones blocked. */
export function sanitizeEmailHtml(html: string, inline: Map<string, string> = new Map()): { html: string; remoteImages: number } {
  let out = "";
  let dropping = 0;
  const open: string[] = [];
  let remoteImages = 0;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        name = name.toLowerCase();
        if (DROPPED.has(name)) {
          if (!VOID.has(name)) dropping++;
          return;
        }
        if (dropping || !ALLOWED.has(name)) return;
        const allowed = new Set([...ATTRIBUTES["*"], ...(ATTRIBUTES[name] ?? [])]);
        const kept: string[] = [];
        for (const [rawKey, rawValue] of Object.entries(attrs)) {
          const key = rawKey.toLowerCase();
          const value = rawValue.trim();
          if (!allowed.has(key) || key.startsWith("on")) continue;
          if (key === "href") {
            if (/^(https?:|mailto:)/i.test(value)) kept.push(`href="${escapeAttr(value)}"`, 'rel="noopener noreferrer"', 'target="_blank"');
            continue;
          }
          if (key === "src" && name === "img") {
            const cid = /^cid:(.+)$/i.exec(value);
            if (cid) {
              const data = inline.get(cid[1].replace(/^<|>$/g, ""));
              if (data) kept.push(`src="${escapeAttr(data)}"`);
            } else if (IMAGE_DATA.test(value)) kept.push(`src="${escapeAttr(value)}"`);
            else if (/^https?:\/\//i.test(value)) {
              kept.push(`data-remote-src="${escapeAttr(value)}"`);
              remoteImages++;
            }
            continue;
          }
          if (key === "style") {
            const s = style(value);
            if (s) kept.push(`style="${escapeAttr(s)}"`);
            continue;
          }
          if ((key === "width" || key === "height" || key === "border" || key === "colspan" || key === "rowspan" || key === "start" || key === "cellpadding" || key === "cellspacing" || key === "size") && !/^\d{1,4}%?$/.test(value)) continue;
          kept.push(`${key}="${escapeAttr(value.slice(0, 500))}"`);
        }
        out += `<${name}${kept.length ? " " + kept.join(" ") : ""}>`;
        if (!VOID.has(name)) open.push(name);
      },
      ontext(text) {
        if (!dropping) out += escapeText(text);
      },
      onclosetag(name) {
        name = name.toLowerCase();
        if (DROPPED.has(name)) {
          if (!VOID.has(name) && dropping) dropping--;
          return;
        }
        if (dropping || !ALLOWED.has(name) || VOID.has(name)) return;
        const at = open.lastIndexOf(name);
        if (at < 0) return;
        while (open.length > at) out += `</${open.pop()}>`;
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true },
  );
  parser.write(html);
  parser.end();
  while (open.length) out += `</${open.pop()}>`;
  return { html: out, remoteImages };
}

const BLOCK = new Set(["p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table", "hr", "ul", "ol", "dl", "dt", "dd"]);
/**
 * HTML as plain text: blocks on their own lines, list items marked, links as their text. Quoted
 * history in the common containers (Gmail's, Apple's, Yahoo's, Outlook's, Thunderbird's) is left
 * out when `withoutQuotes`.
 */
export function htmlText(html: string, withoutQuotes = false): string {
  let out = "";
  let dropping = 0;
  let quoting = 0;
  let quoteDepthAt: number[] = [];
  let depth = 0;
  let stopped = false;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (stopped) return;
        depth++;
        if (DROPPED.has(name)) {
          dropping++;
          return;
        }
        const cls = (attrs.class ?? "").toLowerCase();
        const id = (attrs.id ?? "").toLowerCase();
        if (
          withoutQuotes &&
          (cls.includes("gmail_quote") || cls.includes("yahoo_quoted") || cls.includes("moz-cite-prefix") || (name === "blockquote" && (attrs.type ?? "").toLowerCase() === "cite") || cls.includes("protonmail_quote"))
        ) {
          quoting++;
          quoteDepthAt.push(depth);
        }
        // Outlook's reply header (and everything after it) ends the new part.
        if (withoutQuotes && (id === "divrplyfwdmsg" || id === "appendonsend" || id === "mail-editor-reference-message-container")) stopped = true;
        if (!dropping && !quoting && BLOCK.has(name)) out += "\n";
        if (!dropping && !quoting && name === "li") out += "- ";
      },
      ontext(text) {
        if (!stopped && !dropping && !quoting) out += text.replace(/\s+/g, " ");
      },
      onclosetag(name) {
        if (stopped) return;
        if (DROPPED.has(name) && dropping) dropping--;
        if (quoteDepthAt.length && quoteDepthAt.at(-1) === depth) {
          quoteDepthAt = quoteDepthAt.slice(0, -1);
          quoting--;
        }
        depth--;
        if (!dropping && !quoting && BLOCK.has(name) && name !== "br") out += "\n";
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true },
  );
  parser.write(html);
  parser.end();
  return out
    .split("\n")
    .map((l) => l.replace(/^ +| +$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
