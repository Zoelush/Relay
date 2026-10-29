import { Fragment, useEffect, useRef, useState } from "react";
import { ShieldAlert, ShieldX, X } from "lucide-react";
import { api } from "./api";
import { findLinks } from "../lib/links";

/**
 * Link safety in the inbox (phase 16, step C7a; docs/SECURITY_STEP11.md). A customer's links go
 * through the gate: the server judges each click (`link-verdict`), so a policy change applies at
 * once. Trusted links open straight away; untrusted ones are shown in full first; malicious ones
 * need the risk acknowledged; blocked ones don't open. `/link` is the same gate as a page, for the
 * links inside an email's frame.
 */
type Judged = { url: string; host: string; verdict: "trusted" | "untrusted" | "malicious" | "blocked"; reasons: { id: string; text: string }[] };
const verdictPath = (partId: string, url: string) => `link-verdict?part=${encodeURIComponent(partId)}&url=${encodeURIComponent(url)}`;
const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** Where a customer's link goes in the gate page (used by the email frame). */
export const gateHref = (partId: string, url: string) => `${window.location.origin}/link?part=${encodeURIComponent(partId)}&url=${encodeURIComponent(url)}`;

/** A customer's plain text, with its http(s) addresses as links through the gate. */
export function LinkedText({ text, partId }: { text: string; partId: string }) {
  const [gate, setGate] = useState<string | null>(null);
  const links = findLinks(text);
  if (!links.length) return <>{text}</>;
  const pieces: React.ReactNode[] = [];
  let at = 0;
  for (const l of links) {
    pieces.push(<Fragment key={`t${l.start}`}>{text.slice(at, l.start)}</Fragment>);
    pieces.push(
      <a
        key={`l${l.start}`}
        href={l.url}
        className="pg-customer-link"
        rel="noopener noreferrer"
        onClick={(e) => {
          e.preventDefault();
          setGate(l.url);
        }}
      >
        {l.text}
      </a>,
    );
    at = l.end;
  }
  pieces.push(<Fragment key="end">{text.slice(at)}</Fragment>);
  return (
    <>
      {pieces}
      {gate && <LinkGate partId={partId} url={gate} onClose={() => setGate(null)} />}
    </>
  );
}

/** Opens a judged link (recorded first when it needed acknowledging). */
async function openLink(partId: string, judged: Judged, acknowledged: boolean, here: boolean) {
  await api<Judged>("link-verdict", { partId, url: judged.url, acknowledged });
  if (here) window.location.assign(judged.url);
  else window.open(judged.url, "_blank", "noopener,noreferrer");
}

/** What the gate shows for a verdict: nothing to decide for trusted links. */
function GateBody({ partId, judged, here, onDone }: { partId: string; judged: Judged; here: boolean; onDone: () => void }) {
  const [understood, setUnderstood] = useState(false);
  const [error, setError] = useState("");
  const open = () =>
    openLink(partId, judged, understood, here)
      .then(onDone)
      .catch((e) => setError(errorText(e, "The link couldn't be opened.")));
  return (
    <>
      {judged.verdict === "blocked" ? (
        <p className="pg-link-verdict" data-verdict="blocked">
          <ShieldX size={16} aria-hidden="true" /> Your workspace blocks links to <strong>{judged.host}</strong>. It can’t be opened from Relay.
        </p>
      ) : judged.verdict === "malicious" ? (
        <>
          <p className="pg-link-verdict" data-verdict="malicious">
            <ShieldAlert size={16} aria-hidden="true" /> This link may be dangerous.
          </p>
          <ul className="pg-link-reasons" aria-label="Why it was flagged">
            {judged.reasons.map((r) => (
              <li key={r.id}>{r.text}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="pg-link-verdict" data-verdict="untrusted">
          This link goes to <strong>{judged.host}</strong>, which isn’t on your workspace’s trusted list. Check the full address before opening it.
        </p>
      )}
      <p className="pg-link-address">
        <code>{judged.url}</code>
      </p>
      {judged.verdict === "malicious" && (
        <label className="pg-settings-check">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          <span>I understand the risk and want to open it</span>
        </label>
      )}
      {error && (
        <p role="alert" className="pg-attr-error">
          {error}
        </p>
      )}
      {judged.verdict !== "blocked" && (
        <span className="pg-settings-buttons">
          <button type="button" className={judged.verdict === "malicious" ? "pg-primary pg-danger" : "pg-primary"} disabled={judged.verdict === "malicious" && !understood} onClick={() => void open()}>
            Open link
          </button>
        </span>
      )}
    </>
  );
}

/** The gate as a dialog. A trusted link opens without one. */
export function LinkGate({ partId, url, onClose }: { partId: string; url: string; onClose: () => void }) {
  const [judged, setJudged] = useState<Judged | null>(null);
  const [error, setError] = useState("");
  const close = useRef<HTMLButtonElement>(null);
  const done = useRef(onClose);
  useEffect(() => {
    done.current = onClose;
  });
  useEffect(() => {
    let live = true;
    api<Judged>(verdictPath(partId, url))
      .then(async (j) => {
        if (!live) return;
        if (j.verdict === "trusted") {
          await openLink(partId, j, false, false);
          done.current();
        } else setJudged(j);
      })
      .catch((e) => live && setError(errorText(e, "The link couldn't be checked.")));
    return () => {
      live = false;
    };
  }, [partId, url]);
  useEffect(() => close.current?.focus(), [judged, error]);
  if (!judged && !error) return null;
  return (
    <div className="pg-modal-backdrop" onKeyDown={(e) => e.key === "Escape" && onClose()} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section role="dialog" aria-modal="true" aria-label="Open link" className="pg-dialog">
        <header className="pg-email-head">
          <h2>{judged?.verdict === "blocked" ? "Link blocked" : judged?.verdict === "malicious" ? "Dangerous link" : "Check this link"}</h2>
          <button ref={close} type="button" className="pg-wf-icon" aria-label="Close" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        {error ? (
          <p role="alert" className="pg-attr-error">
            {error}
          </p>
        ) : (
          <GateBody partId={partId} judged={judged!} here={false} onDone={onClose} />
        )}
      </section>
    </div>
  );
}

/** `/link?part=…&url=…`: the gate as a page (an email's links open here, in a new tab). */
export function LinkGatePage() {
  const params = new URLSearchParams(window.location.search);
  const partId = params.get("part") ?? "";
  const url = params.get("url") ?? "";
  const [judged, setJudged] = useState<Judged | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Judged>(verdictPath(partId, url))
      .then((j) => (j.verdict === "trusted" ? openLink(partId, j, false, true) : setJudged(j)))
      .catch((e) => setError(errorText(e, "The link couldn't be checked.")));
  }, [partId, url]);
  return (
    <main className="pg-link-page">
      <section className="pg-dialog" aria-label="Open link">
        <h1>{judged?.verdict === "blocked" ? "Link blocked" : judged?.verdict === "malicious" ? "Dangerous link" : "Check this link"}</h1>
        {error ? (
          <p role="alert" className="pg-attr-error">
            {error}
          </p>
        ) : judged ? (
          <GateBody partId={partId} judged={judged} here onDone={() => undefined} />
        ) : (
          <p className="pg-muted">Checking the link…</p>
        )}
      </section>
    </main>
  );
}
