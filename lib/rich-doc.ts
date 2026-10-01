/**
 * Relay's restricted rich-text document. The shape matches the editor's JSON (TipTap), but only
 * the nodes, marks and attributes below are accepted, and `normalizeDoc` rebuilds the document
 * from them rather than passing anything through. Pure: shared by server, inbox and tests.
 */
export type RichMark =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "code" }
  | { type: "link"; attrs: { href: string } }
  /** Articles only: a link to another knowledge record by id, so it survives slug changes. */
  | { type: "articleLink"; attrs: { recordId: string } };
export type RichInline =
  | { type: "text"; text: string; marks?: RichMark[] }
  | { type: "hardBreak" }
  | RichMention
  | RichVariable;
/** A macro placeholder, filled with plain text on the server when the macro is applied. */
export type RichVariable = {
  type: "variable";
  attrs: { name: MacroVariable; fallback: string };
};
/** Values a macro may insert. Company fields arrive with companies in phase 1. */
export const MACRO_VARIABLES = [
  "contact.name",
  "contact.first_name",
  "contact.email",
  "conversation.title",
  "teammate.name",
  "brand.name",
] as const;
export type MacroVariable = (typeof MACRO_VARIABLES)[number];
/** A mention of a teammate or team. The server rewrites `label` from the directory at send. */
export type RichMention = {
  type: "mention";
  attrs: { kind: "teammate" | "team"; id: string; label: string };
};
export type RichBlock =
  | { type: "paragraph"; content?: RichInline[] }
  | {
      type: "codeBlock";
      attrs?: { language: string };
      content?: { type: "text"; text: string }[];
    }
  | ArticleBlock
  | { type: "blockquote"; content: RichBlock[] }
  | { type: "bulletList"; content: RichListItem[] }
  | { type: "orderedList"; attrs?: { start: number }; content: RichListItem[] }
  | RichImage;
/** An image placed in the message. It refers to a scanned upload, never to a URL. */
export type RichImage = {
  type: "image";
  attrs: { attachmentId: string; alt?: string };
};
export type RichListItem = { type: "listItem"; content: RichBlock[] };
/** Blocks only knowledge articles may contain (`normalizeDoc(…, { article: true })`). */
export type ArticleBlock =
  | { type: "heading"; attrs: { level: 2 | 3 | 4 }; content?: RichInline[] }
  | {
      type: "callout";
      attrs: { tone: "info" | "warning" | "success" };
      content: RichBlock[];
    }
  | { type: "video"; attrs: { provider: "youtube" | "vimeo"; id: string } }
  | { type: "table"; content: RichTableRow[] };
export type RichTableRow = { type: "tableRow"; content: RichTableCell[] };
export type RichTableCell = {
  type: "tableCell" | "tableHeader";
  attrs: { colspan: number; rowspan: number; colwidth: number[] | null };
  content: RichBlock[];
};
export type RichDoc = { type: "doc"; content: RichBlock[] };

export const RICH_LIMITS = {
  text: 5000,
  depth: 4,
  nodes: 2000,
  marks: 4,
  images: 10,
  alt: 200,
  mentions: 20,
  label: 100,
};
/** Larger limits for knowledge articles, which are documents rather than messages. */
export const ARTICLE_LIMITS = {
  text: 200_000,
  depth: 6,
  nodes: 50_000,
  images: 100,
  videos: 20,
  tables: 50,
};
const DIRECTORY_ID = /^[A-Za-z0-9_-]{1,100}$/;
const VIDEO_ID = {
  youtube: /^[A-Za-z0-9_-]{11}$/,
  vimeo: /^\d{1,12}$/,
} as const;
const LANGUAGE = /^[a-z0-9+#-]{1,30}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROTOCOLS = ["https:", "http:", "mailto:"];

export class RichDocError extends Error {
  constructor(
    public code: "INVALID_DOCUMENT" | "DOCUMENT_TOO_LARGE" | "INVALID_LINK",
    message: string,
  ) {
    super(message);
  }
}
const fail = (message: string): never => {
  throw new RichDocError("INVALID_DOCUMENT", message);
};
const isObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const list = (x: unknown) =>
  x === undefined ? [] : Array.isArray(x) ? x : fail("Content must be a list.");

/** A link is kept only if it parses as an absolute https, http or mailto URL. */
export function safeHref(href: unknown): string {
  if (typeof href !== "string" || href.length > 2000)
    throw new RichDocError(
      "INVALID_LINK",
      "Links must be web or email addresses.",
    );
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    throw new RichDocError(
      "INVALID_LINK",
      "Links must be web or email addresses.",
    );
  }
  if (!PROTOCOLS.includes(url.protocol))
    throw new RichDocError(
      "INVALID_LINK",
      "Links must be web or email addresses.",
    );
  return url.href;
}

/** Validates any input and returns a rebuilt document containing only allowed content. */
export function normalizeDoc(
  input: unknown,
  options: { variables?: boolean; article?: boolean } = {},
): RichDoc {
  const article = options.article === true;
  const limits = article
    ? { ...RICH_LIMITS, ...ARTICLE_LIMITS }
    : { ...RICH_LIMITS, videos: 0, tables: 0 };
  const budget = {
    nodes: 0,
    text: 0,
    images: 0,
    mentions: 0,
    videos: 0,
    tables: 0,
  };
  const count = () => {
    if (++budget.nodes > limits.nodes)
      throw new RichDocError(
        "DOCUMENT_TOO_LARGE",
        article ? "This article is too long." : "This message is too long.",
      );
  };
  const text = (value: unknown) => {
    if (typeof value !== "string" || !value.length)
      fail("Text must not be empty.");
    budget.text += (value as string).length;
    if (budget.text > limits.text)
      throw new RichDocError(
        "DOCUMENT_TOO_LARGE",
        article
          ? "Write an article of up to 200,000 characters."
          : "Write a message of up to 5,000 characters.",
      );
    return value as string;
  };
  const marks = (input: unknown): RichMark[] | undefined => {
    const out: RichMark[] = [];
    for (const m of list(input)) {
      if (!isObject(m)) fail("Unsupported formatting.");
      if (m.type === "bold" || m.type === "italic" || m.type === "code")
        out.push({ type: m.type });
      else if (m.type === "link")
        out.push({
          type: "link",
          attrs: {
            href: safeHref(isObject(m.attrs) ? m.attrs.href : undefined),
          },
        });
      else if (m.type === "articleLink" && article) {
        const id = isObject(m.attrs) ? m.attrs.recordId : undefined;
        if (typeof id !== "string" || !UUID.test(id))
          fail("Link to an article in this workspace.");
        out.push({
          type: "articleLink",
          attrs: { recordId: (id as string).toLowerCase() },
        });
      } else fail("Unsupported formatting.");
    }
    if (out.length > RICH_LIMITS.marks)
      fail("Too much formatting on one piece of text.");
    const unique = [...new Map(out.map((m) => [m.type, m])).values()];
    return unique.length ? unique : undefined;
  };
  const inline = (input: unknown): RichInline[] | undefined => {
    const out: RichInline[] = [];
    for (const n of list(input)) {
      count();
      if (!isObject(n)) fail("Unsupported content.");
      if (n.type === "hardBreak") out.push({ type: "hardBreak" });
      else if (n.type === "variable") {
        if (!options.variables)
          fail("Fill in the macro's variables before sending.");
        const attrs = isObject(n.attrs) ? n.attrs : {};
        if (!MACRO_VARIABLES.includes(attrs.name as MacroVariable))
          fail("Use a supported variable.");
        const fallback =
          typeof attrs.fallback === "string"
            ? attrs.fallback.slice(0, 100)
            : "";
        out.push({
          type: "variable",
          attrs: { name: attrs.name as MacroVariable, fallback },
        });
      } else if (n.type === "mention") {
        const attrs = isObject(n.attrs) ? n.attrs : {};
        if (attrs.kind !== "teammate" && attrs.kind !== "team")
          fail("Mention a teammate or a team.");
        if (typeof attrs.id !== "string" || !DIRECTORY_ID.test(attrs.id))
          fail("Mention a teammate or a team.");
        if (++budget.mentions > RICH_LIMITS.mentions)
          throw new RichDocError(
            "DOCUMENT_TOO_LARGE",
            "Mention up to 20 people or teams.",
          );
        const label =
          typeof attrs.label === "string"
            ? attrs.label.trim().slice(0, RICH_LIMITS.label)
            : "";
        out.push({
          type: "mention",
          attrs: {
            kind: attrs.kind as "teammate" | "team",
            id: attrs.id as string,
            label: label || (attrs.id as string),
          },
        });
      } else if (n.type === "text") {
        const m = marks(n.marks);
        out.push(
          m
            ? { type: "text", text: text(n.text), marks: m }
            : { type: "text", text: text(n.text) },
        );
      } else fail("Unsupported content.");
    }
    return out.length ? out : undefined;
  };
  const block = (n: unknown, depth: number): RichBlock => {
    count();
    if (depth > limits.depth)
      fail(
        article
          ? "Lists, quotes, callouts and tables can nest six levels deep."
          : "Lists and quotes can nest four levels deep.",
      );
    if (!isObject(n)) fail("Unsupported content.");
    const node = n as Record<string, unknown>;
    switch (node.type) {
      case "paragraph": {
        const content = inline(node.content);
        return content ? { type: "paragraph", content } : { type: "paragraph" };
      }
      case "codeBlock": {
        const content = list(node.content).map((t) => {
          count();
          if (!isObject(t) || t.type !== "text")
            fail("Code blocks hold plain text.");
          return {
            type: "text" as const,
            text: text((t as { text: unknown }).text),
          };
        });
        // Articles may name the code's language (for display only).
        const language =
          article &&
          isObject(node.attrs) &&
          typeof node.attrs.language === "string"
            ? node.attrs.language.trim().toLowerCase()
            : "";
        if (language && !LANGUAGE.test(language))
          fail("Name the code's language in a word.");
        return {
          type: "codeBlock",
          ...(language ? { attrs: { language } } : {}),
          ...(content.length ? { content } : {}),
        };
      }
      case "heading": {
        if (!article) return fail("Unsupported content.");
        const level = isObject(node.attrs) ? node.attrs.level : undefined;
        if (level !== 2 && level !== 3 && level !== 4)
          fail("Headings are levels 2 to 4 (the title is level 1).");
        const content = inline(node.content);
        return {
          type: "heading",
          attrs: { level: level as 2 | 3 | 4 },
          ...(content ? { content } : {}),
        };
      }
      case "callout": {
        if (!article) return fail("Unsupported content.");
        const tone = isObject(node.attrs) ? node.attrs.tone : undefined;
        if (tone !== "info" && tone !== "warning" && tone !== "success")
          fail("A callout is info, warning or success.");
        return {
          type: "callout",
          attrs: { tone: tone as "info" | "warning" | "success" },
          content: blocks(node.content, depth + 1),
        };
      }
      case "video": {
        if (!article) return fail("Unsupported content.");
        const attrs = isObject(node.attrs) ? node.attrs : {};
        const provider = attrs.provider as "youtube" | "vimeo";
        if (provider !== "youtube" && provider !== "vimeo")
          fail("Embed videos from YouTube or Vimeo.");
        if (typeof attrs.id !== "string" || !VIDEO_ID[provider].test(attrs.id))
          fail("That video address is not recognised.");
        if (++budget.videos > limits.videos)
          throw new RichDocError(
            "DOCUMENT_TOO_LARGE",
            "Embed up to 20 videos in an article.",
          );
        return { type: "video", attrs: { provider, id: attrs.id as string } };
      }
      case "table": {
        if (!article) return fail("Unsupported content.");
        if (++budget.tables > limits.tables)
          throw new RichDocError(
            "DOCUMENT_TOO_LARGE",
            "Use up to 50 tables in an article.",
          );
        const rows = list(node.content).map((row): RichTableRow => {
          count();
          if (!isObject(row) || row.type !== "tableRow")
            fail("Tables hold rows.");
          const cells = list((row as { content: unknown }).content).map(
            (cell): RichTableCell => {
              count();
              if (
                !isObject(cell) ||
                (cell.type !== "tableCell" && cell.type !== "tableHeader")
              )
                fail("Table rows hold cells.");
              const a = isObject(cell.attrs) ? cell.attrs : {};
              const span = (v: unknown) =>
                Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 20
                  ? (v as number)
                  : 1;
              const widths =
                Array.isArray(a.colwidth) &&
                a.colwidth.length <= 20 &&
                a.colwidth.every(
                  (x: unknown) =>
                    Number.isInteger(x) &&
                    (x as number) > 0 &&
                    (x as number) <= 2000,
                )
                  ? (a.colwidth as number[])
                  : null;
              return {
                type: cell.type as "tableCell" | "tableHeader",
                attrs: {
                  colspan: span(a.colspan),
                  rowspan: span(a.rowspan),
                  colwidth: widths,
                },
                content: blocks(
                  (cell as { content: unknown }).content,
                  depth + 1,
                ),
              };
            },
          );
          if (!cells.length) fail("A table row needs a cell.");
          return { type: "tableRow", content: cells };
        });
        if (!rows.length) fail("A table needs a row.");
        return { type: "table", content: rows };
      }
      case "blockquote":
        return { type: "blockquote", content: blocks(node.content, depth + 1) };
      case "image": {
        const attrs = isObject(node.attrs) ? node.attrs : {};
        if (
          typeof attrs.attachmentId !== "string" ||
          !UUID.test(attrs.attachmentId)
        )
          fail("Images must refer to an uploaded file.");
        if (++budget.images > limits.images)
          throw new RichDocError(
            "DOCUMENT_TOO_LARGE",
            article
              ? "Add up to 100 images to an article."
              : "Add up to 10 images to a message.",
          );
        const alt =
          typeof attrs.alt === "string"
            ? attrs.alt.trim().slice(0, RICH_LIMITS.alt)
            : "";
        // Help center readers may rely on screen readers: article images need a description.
        if (article && !alt) fail("Describe each image (alt text).");
        return {
          type: "image",
          attrs: {
            attachmentId: (attrs.attachmentId as string).toLowerCase(),
            ...(alt ? { alt } : {}),
          },
        };
      }
      case "bulletList":
      case "orderedList": {
        const items = list(node.content).map((item): RichListItem => {
          count();
          if (!isObject(item) || item.type !== "listItem")
            fail("Lists hold list items.");
          return {
            type: "listItem",
            content: blocks((item as { content: unknown }).content, depth + 1),
          };
        });
        if (!items.length) fail("A list needs an item.");
        if (node.type === "bulletList")
          return { type: "bulletList", content: items };
        const start = isObject(node.attrs) ? node.attrs.start : undefined;
        return Number.isInteger(start) &&
          (start as number) > 1 &&
          (start as number) <= 10000
          ? {
              type: "orderedList",
              attrs: { start: start as number },
              content: items,
            }
          : { type: "orderedList", content: items };
      }
      default:
        return fail("Unsupported content.");
    }
  };
  const blocks = (input: unknown, depth: number): RichBlock[] => {
    const out = list(input).map((n) => block(n, depth));
    if (!out.length) fail("Content must not be empty.");
    return out;
  };
  if (!isObject(input) || input.type !== "doc") fail("Send a document.");
  return {
    type: "doc",
    content: blocks((input as { content: unknown }).content, 1),
  };
}

/** True when link text already spells out its destination (ignoring normalisation). */
function sameDestination(text: string, href: string) {
  for (const candidate of [text, "mailto:" + text])
    try {
      if (safeHref(candidate) === href) return true;
    } catch {
      // Not a URL: the text is a label, so the destination is shown.
    }
  return false;
}
/**
 * Plain-text fallback, used for search, notifications, plain channels and the pending preview.
 * Link addresses follow their text so the fallback keeps the destination.
 */
export function plainText(doc: RichDoc): string {
  const inline = (content: RichInline[] = []) =>
    content
      .map((n) => {
        if (n.type === "hardBreak") return "\n";
        if (n.type === "mention") return "@" + n.attrs.label;
        if (n.type === "variable") return "{" + n.attrs.name + "}";
        const link = n.marks?.find((m) => m.type === "link");
        return link && !sameDestination(n.text, link.attrs.href)
          ? `${n.text} (${link.attrs.href})`
          : n.text;
      })
      .join("");
  const indent = (text: string, prefix: string) =>
    text
      .split("\n")
      .map((line, i) => (i === 0 ? prefix : " ".repeat(prefix.length)) + line)
      .join("\n");
  const block = (n: RichBlock): string => {
    switch (n.type) {
      case "paragraph":
        return inline(n.content);
      case "codeBlock":
        return (n.content ?? []).map((t) => t.text).join("");
      case "image":
        return n.attrs.alt ? `[Image: ${n.attrs.alt}]` : "[Image]";
      case "blockquote":
        return blocks(n.content)
          .split("\n")
          .map((line) => "> " + line)
          .join("\n");
      case "bulletList":
        return n.content
          .map((item) => indent(blocks(item.content), "- "))
          .join("\n");
      case "orderedList": {
        const start = n.attrs?.start ?? 1;
        return n.content
          .map((item, i) => indent(blocks(item.content), `${start + i}. `))
          .join("\n");
      }
      case "heading":
        return inline(n.content);
      case "callout":
        return blocks(n.content);
      case "video":
        return `[Video: ${n.attrs.provider === "youtube" ? "https://www.youtube.com/watch?v=" : "https://vimeo.com/"}${n.attrs.id}]`;
      case "table":
        return n.content
          .map((row) =>
            row.content
              .map((cell) => blocks(cell.content).replace(/\n+/g, " "))
              .join(" | "),
          )
          .join("\n");
    }
  };
  const blocks = (content: RichBlock[]) => content.map(block).join("\n\n");
  return blocks(doc.content).trim();
}

/** Attachment ids of the images a document places, in order and without repeats. */
export function imageIds(doc: RichDoc): string[] {
  const ids: string[] = [];
  const walk = (blocks: RichBlock[]) => {
    for (const b of blocks) {
      if (b.type === "image") ids.push(b.attrs.attachmentId);
      else if (b.type === "blockquote" || b.type === "callout") walk(b.content);
      else if (b.type === "table")
        for (const row of b.content)
          for (const cell of row.content) walk(cell.content);
      else if (b.type === "bulletList" || b.type === "orderedList")
        for (const item of b.content) walk(item.content);
    }
  };
  walk(doc.content);
  return [...new Set(ids)];
}
/** Every mention in a document, in order (repeats included). */
export function mentions(doc: RichDoc): RichMention[] {
  const out: RichMention[] = [];
  const walk = (blocks: RichBlock[]) => {
    for (const b of blocks) {
      if (b.type === "paragraph")
        for (const n of b.content ?? []) if (n.type === "mention") out.push(n);
      if (b.type === "blockquote") walk(b.content);
      if (b.type === "bulletList" || b.type === "orderedList")
        for (const item of b.content) walk(item.content);
    }
  };
  walk(doc.content);
  return out;
}
/** Returns a copy of the document with each mention's label replaced by `label(mention)`. */
export function relabelMentions(
  doc: RichDoc,
  label: (m: RichMention) => string,
): RichDoc {
  const inline = (content: RichInline[]) =>
    content.map((n) =>
      n.type === "mention"
        ? { ...n, attrs: { ...n.attrs, label: label(n) } }
        : n,
    );
  const block = (b: RichBlock): RichBlock => {
    switch (b.type) {
      case "paragraph":
        return b.content ? { ...b, content: inline(b.content) } : b;
      case "blockquote":
        return { ...b, content: b.content.map(block) };
      case "bulletList":
      case "orderedList":
        return {
          ...b,
          content: b.content.map((item) => ({
            ...item,
            content: item.content.map(block),
          })),
        };
      default:
        return b;
    }
  };
  return { type: "doc", content: doc.content.map(block) };
}
/**
 * Replaces each variable with plain text: its value, or its fallback when the value is empty.
 * Values become text nodes, so they can never add formatting, links or mentions.
 */
export function fillVariables(
  doc: RichDoc,
  values: Partial<Record<MacroVariable, string>>,
): RichDoc {
  const inline = (content: RichInline[]): RichInline[] =>
    content.flatMap((n) => {
      if (n.type !== "variable") return [n];
      const text = (values[n.attrs.name]?.trim() || n.attrs.fallback).slice(
        0,
        500,
      );
      return text ? [{ type: "text" as const, text }] : [];
    });
  const block = (b: RichBlock): RichBlock => {
    switch (b.type) {
      case "paragraph": {
        const content = b.content ? inline(b.content) : undefined;
        return content?.length ? { ...b, content } : { type: "paragraph" };
      }
      case "blockquote":
        return { ...b, content: b.content.map(block) };
      case "bulletList":
      case "orderedList":
        return {
          ...b,
          content: b.content.map((item) => ({
            ...item,
            content: item.content.map(block),
          })),
        };
      default:
        return b;
    }
  };
  return { type: "doc", content: doc.content.map(block) };
}
/** A document is plain when it is one or more unformatted paragraphs. */
export function isPlain(doc: RichDoc) {
  return doc.content.every(
    (b) =>
      b.type === "paragraph" &&
      (b.content ?? []).every(
        (n) => n.type === "hardBreak" || (n.type === "text" && !n.marks),
      ),
  );
}
