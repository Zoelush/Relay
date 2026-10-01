import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { language } from "../messenger/strings";

/**
 * The customer ticket portal (phase 05, step C). Same-origin with its API; the session is an
 * HttpOnly cookie. Sign-in material (a hand-over code or a signed identity token) arrives in the
 * URL fragment, is sent once and removed from the address bar straight away.
 */
type Request = {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  ticket: { number: number; typeName: string; label: string } | null;
};
type Part = {
  id: string;
  kind: string;
  author: string;
  authorName: string | null;
  body: string;
  createdAt: string;
  event: {
    to?: string;
    joined?: boolean;
    ticket?: { number: number; typeName: string; label: string };
  } | null;
};
type Detail = {
  id: string;
  title: string;
  status: string;
  ticket: Request["ticket"];
  parts: Part[];
};

// /portal/{workspace}/{brand}; on a mapped domain, just /portal.
const match = location.pathname.match(/^\/portal\/([^/]+)\/([^/]+)/);
const scope = match
  ? {
      workspace: decodeURIComponent(match[1]),
      brand: decodeURIComponent(match[2]),
    }
  : {};

async function api<T>(
  path: string,
  body?: Record<string, unknown>,
  query: Record<string, string> = {},
): Promise<T> {
  const params = new URLSearchParams({
    ...(scope as Record<string, string>),
    ...query,
  });
  const r = await fetch("/v1/portal/" + path + (body ? "" : "?" + params), {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    headers: body
      ? {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        }
      : {},
    ...(body ? { body: JSON.stringify({ ...scope, ...body }) } : {}),
  });
  const data = (await r.json()) as T & {
    error?: { code: string; message: string };
  };
  if (!r.ok)
    throw Object.assign(
      new Error(data.error?.message ?? "Something went wrong."),
      { code: data.error?.code },
    );
  return data;
}

function Portal() {
  const [brand, setBrand] = useState<{
    name: string;
    color: string;
    locale: string;
  } | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [helpCenter, setHelpCenter] = useState<string | null>(null);
  const [requests, setRequests] = useState<Request[] | null>(null);
  const [open, setOpen] = useState<string | null>(() =>
    new URLSearchParams(location.search).get("request"),
  );
  const [detail, setDetail] = useState<Detail | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const {
    strings: t,
    dir,
    locale,
  } = language(navigator.language, brand?.locale ?? "en");

  // Sign in from the fragment (once), then load the brand and session state.
  useEffect(() => {
    let live = true;
    (async () => {
      const fragment = new URLSearchParams(location.hash.slice(1));
      if (location.hash)
        history.replaceState(null, "", location.pathname + location.search);
      try {
        const handoff = fragment.get("handoff");
        const jwt = fragment.get("token");
        if (handoff) await api("session", { handoff });
        else if (jwt)
          await api("session", {
            user: {
              userId: fragment.get("user") ?? "",
              email: fragment.get("email") ?? "",
              jwt,
            },
          });
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
      try {
        const context = await api<{
          brand: { name: string; color: string; locale: string };
          signedIn: boolean;
          helpCenter: { slug: string } | null;
        }>("context");
        if (!live) return;
        setBrand(context.brand);
        // A section of the public help center: link back to it (phase 07, B1).
        setHelpCenter(
          context.helpCenter
            ? match
              ? `/help/${encodeURIComponent(match[1])}/${encodeURIComponent(context.helpCenter.slug)}`
              : "/"
            : null,
        );
        setSignedIn(context.signedIn);
        document.title = context.brand.name;
        document.documentElement.style.setProperty(
          "--accent",
          context.brand.color,
        );
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }, [locale, dir]);
  const loadDetail = useCallback(async (id: string) => {
    setDetail(await api<Detail>("request", undefined, { id }));
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    const fail = (e: unknown) =>
      live && setError(e instanceof Error ? e.message : String(e));
    if (open)
      api<Detail>("request", undefined, { id: open })
        .then((d) => live && setDetail(d))
        .catch(fail);
    else
      api<{ requests: Request[] }>("requests")
        .then((d) => live && setRequests(d.requests))
        .catch(fail);
    return () => {
      live = false;
    };
  }, [signedIn, open]);
  useEffect(() => {
    const onPop = () =>
      setOpen(new URLSearchParams(location.search).get("request"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = (id: string | null) => {
    history.pushState(
      null,
      "",
      location.pathname + (id ? "?request=" + encodeURIComponent(id) : ""),
    );
    setDetail(null);
    setError("");
    setOpen(id);
  };
  const send = async () => {
    if (!detail || !reply.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api("reply", { id: detail.id, text: reply });
      setReply("");
      await loadDetail(detail.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const signOut = async () => {
    await api("logout", {}).catch(() => {});
    setSignedIn(false);
    setRequests(null);
    setDetail(null);
  };
  const state = (s: string) =>
    s === "closed"
      ? t.closedState
      : s === "snoozed"
        ? t.snoozedState
        : t.openState;
  const when = (iso: string) =>
    new Date(iso).toLocaleString(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  const ticketLine = (k: NonNullable<Request["ticket"]>) =>
    `${t.ticket} #${k.number} (${k.typeName}): ${k.label}`;

  return (
    <div className="portal">
      <header>
        <strong>{brand?.name ?? ""}</strong>
        {helpCenter && <a href={helpCenter}>{t.portalHelpCenter}</a>}
        {signedIn && (
          <button type="button" className="link" onClick={() => void signOut()}>
            {t.portalSignOut}
          </button>
        )}
      </header>
      <main>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {brand && !signedIn && <p className="empty">{t.portalSignIn}</p>}
        {signedIn && !open && (
          <>
            <h1>{t.portalTitle}</h1>
            {requests && !requests.length && (
              <p className="empty">{t.portalEmpty}</p>
            )}
            <ul className="requests" aria-label={t.portalTitle}>
              {requests?.map((r) => (
                <li key={r.id}>
                  <a
                    href={"?request=" + encodeURIComponent(r.id)}
                    onClick={(e) => {
                      e.preventDefault();
                      go(r.id);
                    }}
                  >
                    <span className="title">{r.title || t.messages}</span>
                    <span className="meta">
                      {r.ticket ? ticketLine(r.ticket) : state(r.status)} ·{" "}
                      {t.portalUpdated} {when(r.updatedAt)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
        {signedIn && open && (
          <article aria-labelledby="request-title">
            <button type="button" className="link" onClick={() => go(null)}>
              ← {t.portalBack}
            </button>
            {detail && (
              <>
                <h1 id="request-title">{detail.title || t.messages}</h1>
                <p className="status" data-testid="request-status">
                  {detail.ticket
                    ? ticketLine(detail.ticket)
                    : state(detail.status)}
                </p>
                <ol className="parts" aria-label={t.messages}>
                  {detail.parts.map((p) =>
                    p.event ? (
                      <li key={p.id} className="event">
                        {p.event.ticket
                          ? ticketLine(p.event.ticket)
                          : p.event.joined
                            ? t.joined
                            : p.event.to === "closed"
                              ? t.closed
                              : p.event.to === "open"
                                ? t.reopened
                                : ""}
                      </li>
                    ) : p.body ? (
                      <li
                        key={p.id}
                        className={
                          p.author === "you" ? "message mine" : "message"
                        }
                      >
                        <span className="who">
                          {p.author === "you"
                            ? t.you
                            : p.author === "ai"
                              ? t.ai
                              : (p.authorName ?? t.teammate)}
                        </span>
                        <p>{p.body}</p>
                        <time dateTime={p.createdAt}>{when(p.createdAt)}</time>
                      </li>
                    ) : null,
                  )}
                </ol>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <label htmlFor="portal-reply">{t.portalReply}</label>
                  <textarea
                    id="portal-reply"
                    rows={4}
                    maxLength={5000}
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                  />
                  <button type="submit" disabled={busy || !reply.trim()}>
                    {t.portalSend}
                  </button>
                </form>
              </>
            )}
          </article>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("portal-root")!).render(<Portal />);
