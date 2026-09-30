import type { ReactNode } from "react";
import {
  normalizeDoc,
  type RichBlock,
  type RichDoc,
  type RichInline,
} from "./rich-doc";

/**
 * Renders a rich document as React elements: text is escaped by React and never parsed as
 * HTML. The document is validated again here, so anything the server would reject falls back
 * to the plain-text body. Shared by the agent inbox and the customer messenger.
 */
export function RichText({
  doc,
  fallback,
}: {
  doc: unknown;
  fallback: string;
}) {
  let safe: RichDoc;
  try {
    safe = normalizeDoc(doc);
  } catch {
    return <p>{fallback}</p>;
  }
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

function block(n: RichBlock, i: number): ReactNode {
  switch (n.type) {
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
