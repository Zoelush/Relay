/** @jsxImportSource react */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RichText } from "../lib/rich-view";

/**
 * The words of an outgoing email (phase 12, step E3; docs/OMNICHANNEL_STEP3.md): each as HTML
 * and as plain text, so every HTML mail has a plain-text alternative. A reply's rich document is
 * rendered by the inbox's own `RichText` (text escaped, never parsed as HTML); images in it show
 * as their alt text. Email clients ignore stylesheets, so the few styles are inline, and the
 * colours are email's own, not the app's tokens (an email can't read them).
 */
export type Said = { author: string; doc?: unknown; body: string };
export type Quote = { name: string; at: string; text: string } | null;
const PAPER = "#ffffff";
const INK = "#1f2933";
const MUTED = "#5f6b7a";
const RULE = "#d9dee5";

function page(children: ReactNode, footer: string) {
  return (
    "<!doctype html>" +
    renderToStaticMarkup(
      <html>
        {/* An email's document, rendered on the server: not a Next page. */}
        {/* eslint-disable-next-line @next/next/no-head-element */}
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width" />
        </head>
        <body style={{ margin: 0, padding: "16px", background: PAPER, color: INK, font: "15px/1.5 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif" }}>
          <div style={{ maxWidth: "600px" }}>{children}</div>
          <p style={{ color: MUTED, fontSize: "12px", borderTop: `1px solid ${RULE}`, paddingTop: "8px", marginTop: "24px" }}>{footer}</p>
        </body>
      </html>,
    )
  );
}
const said = (s: Said) => <RichText doc={s.doc} fallback={s.body} />;
const quoted = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => "> " + l)
    .join("\n");

/** A reply on an email conversation, with the customer's last message quoted below. */
export function composeReply(m: { brand: string; said: Said; quote: Quote; footer?: string }) {
  const footer = m.footer ?? `Reply to this email to answer ${m.brand}.`;
  const html = page(
    <>
      {said(m.said)}
      {m.quote && (
        <>
          <p style={{ color: MUTED, marginTop: "24px" }}>
            On {m.quote.at}, {m.quote.name} wrote:
          </p>
          <blockquote style={{ margin: 0, paddingLeft: "12px", borderLeft: `3px solid ${RULE}`, color: MUTED, whiteSpace: "pre-wrap" }}>{m.quote.text}</blockquote>
        </>
      )}
    </>,
    footer,
  );
  const text = [m.said.body, ...(m.quote ? ["", `On ${m.quote.at}, ${m.quote.name} wrote:`, quoted(m.quote.text)] : []), "", "--", footer].join("\n");
  return { html, text };
}

/**
 * An away email: the replies a messenger customer hasn't read. With the brand's switch off it
 * carries none of them, only that there's a reply.
 */
export function composeAway(m: { brand: string; replies: Said[]; content: boolean }) {
  const n = m.replies.length;
  const lead = n === 1 ? `You have a new reply from ${m.brand}.` : `You have ${n} new replies from ${m.brand}.`;
  const footer = `Reply to this email, or open the chat on ${m.brand}'s website, to answer.`;
  const html = page(
    <>
      <p>{lead}</p>
      {m.content &&
        m.replies.map((r, i) => (
          <div key={i} style={{ borderTop: `1px solid ${RULE}`, paddingTop: "8px", marginTop: "8px" }}>
            <p style={{ color: MUTED, margin: "0 0 4px", fontSize: "13px" }}>{r.author}</p>
            {said(r)}
          </div>
        ))}
    </>,
    footer,
  );
  const text = [lead, ...(m.content ? m.replies.flatMap((r) => ["", `${r.author}:`, r.body]) : []), "", "--", footer].join("\n");
  return { html, text };
}
