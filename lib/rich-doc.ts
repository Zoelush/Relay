/**
 * Relay's restricted rich-text document. The shape matches the editor's JSON (TipTap), but only
 * the nodes, marks and attributes below are accepted, and `normalizeDoc` rebuilds the document
 * from them rather than passing anything through. Pure: shared by server, inbox and tests.
 */
export type RichMark =
  | { type: "bold" }
  | { type: "italic" }
  | { type: "code" }
  | { type: "link"; attrs: { href: string } };
export type RichInline =
  { type: "text"; text: string; marks?: RichMark[] } | { type: "hardBreak" };
export type RichBlock =
  | { type: "paragraph"; content?: RichInline[] }
  | { type: "codeBlock"; content?: { type: "text"; text: string }[] }
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
export type RichDoc = { type: "doc"; content: RichBlock[] };

export const RICH_LIMITS = {
  text: 5000,
  depth: 4,
  nodes: 2000,
  marks: 4,
  images: 10,
  alt: 200,
};
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
export function normalizeDoc(input: unknown): RichDoc {
  const budget = { nodes: 0, text: 0, images: 0 };
  const count = () => {
    if (++budget.nodes > RICH_LIMITS.nodes)
      throw new RichDocError("DOCUMENT_TOO_LARGE", "This message is too long.");
  };
  const text = (value: unknown) => {
    if (typeof value !== "string" || !value.length)
      fail("Text must not be empty.");
    budget.text += (value as string).length;
    if (budget.text > RICH_LIMITS.text)
      throw new RichDocError(
        "DOCUMENT_TOO_LARGE",
        "Write a message of up to 5,000 characters.",
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
      else fail("Unsupported formatting.");
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
      else if (n.type === "text") {
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
    if (depth > RICH_LIMITS.depth)
      fail("Lists and quotes can nest four levels deep.");
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
        return content.length
          ? { type: "codeBlock", content }
          : { type: "codeBlock" };
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
        if (++budget.images > RICH_LIMITS.images)
          throw new RichDocError(
            "DOCUMENT_TOO_LARGE",
            "Add up to 10 images to a message.",
          );
        const alt =
          typeof attrs.alt === "string"
            ? attrs.alt.trim().slice(0, RICH_LIMITS.alt)
            : "";
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
      else if (b.type === "blockquote") walk(b.content);
      else if (b.type === "bulletList" || b.type === "orderedList")
        for (const item of b.content) walk(item.content);
    }
  };
  walk(doc.content);
  return [...new Set(ids)];
}
/** A document is plain when it is one or more unformatted paragraphs. */
export function isPlain(doc: RichDoc) {
  return doc.content.every(
    (b) =>
      b.type === "paragraph" &&
      (b.content ?? []).every((n) => n.type === "hardBreak" || !n.marks),
  );
}
