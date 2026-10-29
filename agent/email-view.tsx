import { useEffect, useRef, useState } from "react";
import { ShieldAlert, ShieldCheck, X } from "lucide-react";
import { api } from "./api";
import { gateHref } from "./links";

/**
 * "Show the full email" (phase 12, step E2; docs/OMNICHANNEL_STEP2.md): the whole of an email
 * behind a part, with its quoted history. Its HTML was made safe when it arrived; it's shown in a
 * sandboxed frame (no scripts, its own origin, a policy that loads nothing remote), and remote
 * images stay blocked until a teammate loads them for this view.
 */
type Email = {
  subject: string;
  from: { address: string; name: string };
  to: string[];
  cc: string[];
  sentAt: string | null;
  text: string;
  html: string | null;
  stripped: boolean;
  forwarded: boolean;
  verified: boolean;
  remoteImages: number;
  attachments: { name: string; mime: string; size: number; kept: boolean; reason: string }[];
};
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** The frame's document: the safe HTML, under a policy that loads nothing (or images, when allowed). */
function frameDoc(html: string, images: boolean, partId: string) {
  const shown = images ? html.replace(/data-remote-src="/g, 'src="') : html;
  // Phase 16 C7a: every link opens through Relay's link gate, in a new tab.
  const body = shown.replace(/(<a\b[^>]*?\bhref=")(https?:[^"]*)"/gi, (_, open: string, href: string) => {
    const url = href.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return `${open}${gateHref(partId, url).replace(/&/g, "&amp;")}"`;
  });
  const policy = `default-src 'none'; style-src 'unsafe-inline'; img-src data:${images ? " https: http:" : ""}`;
  // The frame can't read the app's tokens, so their values are copied in.
  const tokens = getComputedStyle(document.documentElement);
  const paper = tokens.getPropertyValue("--pg-email-paper").trim();
  const ink = tokens.getPropertyValue("--pg-email-ink").trim();
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><base target="_blank"><style>body{font:14px/1.5 system-ui,sans-serif;margin:12px;color:${ink};background:${paper};word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${body}</body></html>`;
}

export function EmailView({ partId, onClose }: { partId: string; onClose: () => void }) {
  const [email, setEmail] = useState<Email | null>(null);
  const [error, setError] = useState("");
  const [images, setImages] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    api<Email>(`email-message?part=${encodeURIComponent(partId)}`)
      .then(setEmail)
      .catch((e) => setError(e instanceof Error ? e.message : "The email couldn't be loaded."));
    close.current?.focus();
  }, [partId]);
  return (
    <div className="pg-modal-backdrop" onKeyDown={(e) => e.key === "Escape" && onClose()} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section role="dialog" aria-modal="true" aria-label="Full email" className="pg-dialog pg-dialog-wide pg-email-view">
        <header className="pg-email-head">
          <h2>{email?.subject || "(no subject)"}</h2>
          <button ref={close} type="button" className="pg-wf-icon" aria-label="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        {error && (
          <p role="alert" className="pg-attr-error">
            {error}
          </p>
        )}
        {email && (
          <>
            <dl className="pg-email-meta">
              <dt>From</dt>
              <dd>
                {email.from.name ? `${email.from.name} <${email.from.address}>` : email.from.address}{" "}
                {email.verified ? (
                  <span className="pg-email-verified" data-verified="true">
                    <ShieldCheck size={13} aria-hidden="true" /> Sender verified
                  </span>
                ) : (
                  <span className="pg-email-verified" title="Its domain didn't confirm it sent this (DMARC): the sender may not be who they say.">
                    <ShieldAlert size={13} aria-hidden="true" /> Sender not verified
                  </span>
                )}
              </dd>
              {email.to.length > 0 && (
                <>
                  <dt>To</dt>
                  <dd>{email.to.join(", ")}</dd>
                </>
              )}
              {email.cc.length > 0 && (
                <>
                  <dt>Cc</dt>
                  <dd>{email.cc.join(", ")}</dd>
                </>
              )}
              {email.sentAt && (
                <>
                  <dt>Sent</dt>
                  <dd>{new Date(email.sentAt).toLocaleString()}</dd>
                </>
              )}
            </dl>
            {email.remoteImages > 0 && !images && (
              <p className="pg-email-blocked">
                {email.remoteImages === 1 ? "1 remote image is" : `${email.remoteImages} remote images are`} blocked: loading them tells the sender this was opened.{" "}
                <button type="button" className="pg-wf-link" onClick={() => setImages(true)}>
                  Load images
                </button>
              </p>
            )}
            {email.html ? (
              <iframe className="pg-email-frame" title="Email content" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={frameDoc(email.html, images, partId)} />
            ) : (
              <pre className="pg-email-text">{email.text}</pre>
            )}
            {email.attachments.length > 0 && (
              <ul className="pg-email-files" aria-label="Attachments">
                {email.attachments.map((a, i) => (
                  <li key={i}>
                    {a.name} <span className="pg-muted">({size(a.size)})</span>
                    {!a.kept && <span className="pg-muted"> · not kept: {a.reason}</span>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}
