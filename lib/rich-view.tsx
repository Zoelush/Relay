/** @jsxImportSource react */
// The help center renders on the server; this pins React's JSX runtime even where a test runner
// compiles .tsx with its own (Playwright does, for component tests).
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
  const block = (n: RichBlock, i: number) => renderBlock(n, i, { image });
  return <div className="rich">{safe.content.map(block)}</div>;
}

/** Where an internal article link goes: the record's current page, or null to show plain text. */
export type ArticleLinker = (recordId: string) => string | null;
const VIDEO_SRC = {
  // Privacy-respecting players: no tracking cookies before play (YouTube), do-not-track (Vimeo).
  youtube: (id: string) => `https://www.youtube-nocookie.com/embed/${id}`,
  vimeo: (id: string) => `https://player.vimeo.com/video/${id}?dnt=1`,
};

/**
 * A knowledge article (phase 07): the article profile (headings, callouts, tables, videos, code
 * with a language, links to other records). Validated again with the article rules; anything
 * rejected falls back to the plain text. Used by the server-rendered help center.
 */
export function ArticleText({
  doc,
  fallback,
  link,
  image = altOnly,
  videos = "embed",
}: {
  doc: unknown;
  fallback: string;
  link: ArticleLinker;
  image?: ImageRenderer;
  /** "link" where frames are not allowed (the messenger): a link that opens the video. */
  videos?: "embed" | "link";
}) {
  let safe: RichDoc;
  try {
    safe = normalizeDoc(doc, { article: true });
  } catch {
    return <p>{fallback}</p>;
  }
  const block = (n: RichBlock, i: number) =>
    renderBlock(n, i, { image, link, videos });
  return <div className="rich article">{safe.content.map(block)}</div>;
}

type Context = {
  image: ImageRenderer;
  link?: ArticleLinker;
  videos?: "embed" | "link";
};
const VIDEO_PAGE = {
  youtube: (id: string) => `https://www.youtube.com/watch?v=${id}`,
  vimeo: (id: string) => `https://vimeo.com/${id}`,
};

function inline(nodes: RichInline[] = [], link?: ArticleLinker): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === "hardBreak") return <br key={i} />;
    if (n.type === "mention")
      return (
        <span
          key={i}
          className="rich-mention"
          data-mention-kind={n.attrs.kind}
          data-mention-id={n.attrs.id}
        >
          @{n.attrs.label}
        </span>
      );
    if (n.type === "variable")
      return (
        <span key={i} className="rich-variable" data-variable={n.attrs.name}>
          {"{" + n.attrs.name + "}"}
        </span>
      );
    let node: ReactNode = n.text;
    for (const m of n.marks ?? []) {
      if (m.type === "bold") node = <strong>{node}</strong>;
      else if (m.type === "italic") node = <em>{node}</em>;
      else if (m.type === "code") node = <code>{node}</code>;
      else if (m.type === "articleLink") {
        const href = link?.(m.attrs.recordId);
        node = href ? (
          <a href={href} className="rich-article-link">
            {node}
          </a>
        ) : (
          <span data-article-link={m.attrs.recordId}>{node}</span>
        );
      } else
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

function renderBlock(n: RichBlock, i: number, context: Context): ReactNode {
  const { image, link } = context;
  const block = (b: RichBlock, j: number) => renderBlock(b, j, context);
  switch (n.type) {
    case "image":
      return (
        <figure key={i} className="rich-image">
          {image(n.attrs)}
        </figure>
      );
    case "paragraph":
      return <p key={i}>{inline(n.content, link)}</p>;
    case "codeBlock":
      return (
        <pre key={i}>
          <code
            className={
              n.attrs?.language ? "language-" + n.attrs.language : undefined
            }
          >
            {(n.content ?? []).map((t) => t.text).join("")}
          </code>
        </pre>
      );
    case "heading": {
      const Tag = (["h2", "h3", "h4"] as const)[n.attrs.level - 2];
      return <Tag key={i}>{inline(n.content, link)}</Tag>;
    }
    case "callout":
      return (
        <aside
          key={i}
          className={"callout callout-" + n.attrs.tone}
          role="note"
        >
          {n.content.map(block)}
        </aside>
      );
    case "video":
      if (context.videos === "link")
        return (
          <p key={i} className="video-link">
            <a
              href={VIDEO_PAGE[n.attrs.provider](n.attrs.id)}
              target="_blank"
              rel="noopener noreferrer"
            >
              ▶{" "}
              {n.attrs.provider === "youtube" ? "YouTube video" : "Vimeo video"}
            </a>
          </p>
        );
      return (
        <div key={i} className="video">
          <iframe
            src={VIDEO_SRC[n.attrs.provider](n.attrs.id)}
            title={
              n.attrs.provider === "youtube" ? "YouTube video" : "Vimeo video"
            }
            loading="lazy"
            allow="fullscreen; picture-in-picture"
            allowFullScreen
          />
        </div>
      );
    case "table":
      return (
        <div key={i} className="table">
          <table>
            <tbody>
              {n.content.map((row, r) => (
                <tr key={r}>
                  {row.content.map((cell, c) => {
                    const Cell = cell.type === "tableHeader" ? "th" : "td";
                    return (
                      <Cell
                        key={c}
                        colSpan={
                          cell.attrs.colspan > 1
                            ? cell.attrs.colspan
                            : undefined
                        }
                        rowSpan={
                          cell.attrs.rowspan > 1
                            ? cell.attrs.rowspan
                            : undefined
                        }
                      >
                        {cell.content.map(block)}
                      </Cell>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
