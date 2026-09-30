import type { ReactNode } from "react";
import {
  normalizeDoc,
  type RichBlock,
  type RichDoc,
  type RichImage,
  type RichInline,
} from "./rich-doc";

/** How a surface shows an inline image: always from an attachment id, never a URL in the doc. */
export type ImageRenderer = (image: RichImage["attrs"]) => ReactNode;
const altOnly: ImageRenderer = (image) => (
  <p className="rich-image-missing">
    [Image{image.alt ? ": " + image.alt : ""}]
  </p>
);

/**
 * Renders a rich document as React elements: text is escaped by React and never parsed as
 * HTML. The document is validated again here, so anything the server would reject falls back
 * to the plain-text body. Shared by the agent inbox and the customer messenger.
 */
export function RichText({
  doc,
  fallback,
  image = altOnly,
}: {
  doc: unknown;
  fallback: string;
  image?: ImageRenderer;
}) {
  let safe: RichDoc;
  try {
    safe = normalizeDoc(doc);
  } catch {
    return <p>{fallback}</p>;
  }
  const block = (n: RichBlock, i: number) => renderBlock(n, i, image);
  return <div className="rich">{safe.content.map(block)}</div>;
}

function inline(nodes: RichInline[] = []): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === "hardBreak") return <br key={i} />;
    let node: ReactNode = n.text;
    for (const m of n.marks ?? []) {
      if (m.type === "bold") node = <strong>{node}</strong>;
      else if (m.type === "italic") node = <em>{node}</em>;
      else if (m.type === "code") node = <code>{node}</code>;
      else
        node = (
          <a
            href={m.attrs.href}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
          >
            {node}
          </a>
        );
    }
    return <span key={i}>{node}</span>;
  });
}

function renderBlock(n: RichBlock, i: number, image: ImageRenderer): ReactNode {
  const block = (b: RichBlock, j: number) => renderBlock(b, j, image);
  switch (n.type) {
    case "image":
      return (
        <figure key={i} className="rich-image">
          {image(n.attrs)}
        </figure>
      );
    case "paragraph":
      return <p key={i}>{inline(n.content)}</p>;
    case "codeBlock":
      return (
        <pre key={i}>
          <code>{(n.content ?? []).map((t) => t.text).join("")}</code>
        </pre>
      );
    case "blockquote":
      return <blockquote key={i}>{n.content.map(block)}</blockquote>;
    case "bulletList":
      return (
        <ul key={i}>
          {n.content.map((item, j) => (
            <li key={j}>{item.content.map(block)}</li>
          ))}
        </ul>
      );
    case "orderedList":
      return (
        <ol key={i} start={n.attrs?.start}>
          {n.content.map((item, j) => (
            <li key={j}>{item.content.map(block)}</li>
          ))}
        </ol>
      );
  }
}
