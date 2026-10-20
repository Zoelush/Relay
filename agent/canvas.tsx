import { useCallback, useEffect, useRef, useState } from "react";
import { AppWindow, ExternalLink, RotateCw, X } from "lucide-react";
import { api } from "./api";
import type { Canvas, Component, Placement } from "../lib/canvas";

/**
 * Canvas apps' cards (phase 15, step D5; docs/DEVELOPER_PLATFORM_STEP5.md). An app's answer was
 * checked on the server against `lib/canvas.ts`; here each component is drawn with Relay's own
 * controls, so no app code runs in the inbox. Pressing something asks the server, which asks the
 * app (signed, time-limited); a failure is a clear card with "Try again".
 */
export type CanvasResult =
  { status: "ready"; sessionId: string; canvas: Canvas } | { status: "insert"; text: string } | { status: "configured" } | { status: "failed"; outcome: string; message: string; detail: string };
type Values = Record<string, string | string[]>;
export type InstalledCanvas = {
  installationId: string;
  appName: string;
  placement: Placement;
};

const initialValues = (canvas: Canvas): Values => {
  const v: Values = {};
  for (const c of canvas.components) {
    if (c.type === "input" || c.type === "textarea") v[c.id] = c.value ?? "";
    else if (c.type === "dropdown") v[c.id] = c.value ?? "";
    else if (c.type === "checkbox") v[c.id] = c.value ?? [];
  }
  return v;
};

/** A canvas, drawn: its fields keep what's typed; `onSubmit` sends a pressed id with every value. */
export function CanvasView({ canvas, busy, onSubmit }: { canvas: Canvas; busy: boolean; onSubmit: (componentId: string, values: Values) => void }) {
  const [values, setValues] = useState<Values>(() => initialValues(canvas));
  const set = (id: string, v: string | string[]) => setValues((all) => ({ ...all, [id]: v }));
  const submit = (id: string) => !busy && onSubmit(id, values);
  const opens = (url: string, children: React.ReactNode, className: string) => (
    <a className={className} href={url} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
  const draw = (c: Component, i: number) => {
    switch (c.type) {
      case "text":
        return (
          <p key={i} className="pg-cv-text" data-style={c.style ?? "paragraph"} style={c.align ? { textAlign: c.align } : undefined}>
            {c.text}
          </p>
        );
      case "image":
        // An app's image, drawn as given (https only, checked on the server).
        // eslint-disable-next-line @next/next/no-img-element
        return <img key={i} className="pg-cv-image" src={c.url} alt={c.alt} width={c.width} height={c.height} data-rounded={c.rounded ? "" : undefined} loading="lazy" referrerPolicy="no-referrer" />;
      case "button":
        return c.action.type === "url" ? (
          <span key={i}>
            {opens(
              c.action.url,
              <>
                {c.label} <ExternalLink size={12} aria-hidden="true" />
              </>,
              "pg-cv-button",
            )}
          </span>
        ) : (
          <button key={i} type="button" className="pg-cv-button" data-style={c.style ?? "primary"} disabled={c.disabled} onClick={() => submit(c.id)}>
            {c.label}
          </button>
        );
      case "link":
        return (
          <p key={i}>
            {opens(
              c.url,
              <>
                {c.text} <ExternalLink size={12} aria-hidden="true" />
              </>,
              "pg-cv-link",
            )}
          </p>
        );
      case "input":
      case "textarea": {
        const errorId = `cv-${c.id}-error`;
        const common = {
          value: String(values[c.id] ?? ""),
          placeholder: c.placeholder,
          disabled: c.disabled,
          "aria-invalid": c.error ? true : undefined,
          "aria-describedby": c.error ? errorId : undefined,
        };
        return (
          <label key={i} className="pg-cv-field">
            <span>{c.label}</span>
            {c.type === "input" ? (
              <input
                {...common}
                onChange={(e) => set(c.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && c.action) {
                    e.preventDefault();
                    submit(c.id);
                  }
                }}
              />
            ) : (
              <textarea {...common} rows={3} onChange={(e) => set(c.id, e.target.value)} />
            )}
            {c.error && (
              <small id={errorId} className="pg-attr-error">
                {c.error}
              </small>
            )}
          </label>
        );
      }
      case "dropdown":
        return (
          <label key={i} className="pg-cv-field">
            <span>{c.label}</span>
            <select value={String(values[c.id] ?? "")} disabled={c.disabled} onChange={(e) => set(c.id, e.target.value)}>
              {!c.value && <option value="">Choose…</option>}
              {c.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.text}
                </option>
              ))}
            </select>
          </label>
        );
      case "checkbox": {
        const chosen = (values[c.id] as string[] | undefined) ?? [];
        return (
          <fieldset key={i} className="pg-cv-checks" disabled={c.disabled}>
            <legend>{c.label}</legend>
            {c.options.map((o) => (
              <label key={o.id}>
                <input type="checkbox" checked={chosen.includes(o.id)} onChange={(e) => set(c.id, e.target.checked ? [...chosen, o.id] : chosen.filter((x) => x !== o.id))} />
                {o.text}
              </label>
            ))}
          </fieldset>
        );
      }
      case "list":
        return (
          <ul key={i} className="pg-cv-list">
            {c.items.map((item) => {
              const body = (
                <>
                  <strong>{item.title}</strong>
                  {item.subtitle && <span>{item.subtitle}</span>}
                  {item.tertiary && <small>{item.tertiary}</small>}
                </>
              );
              return (
                <li key={item.id}>
                  {item.action?.type === "submit" ? (
                    <button type="button" disabled={item.disabled} onClick={() => submit(item.id)}>
                      {body}
                    </button>
                  ) : item.action?.type === "url" ? (
                    opens(item.action.url, body, "pg-cv-item")
                  ) : (
                    <div className="pg-cv-item">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        );
      case "data_table":
        return (
          <dl key={i} className="pg-cv-table">
            {c.items.map((row, j) => (
              <div key={j}>
                <dt>{row.field}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        );
      case "divider":
        return <hr key={i} className="pg-cv-divider" />;
      case "spacer":
        return <div key={i} className="pg-cv-spacer" data-size={c.size ?? "m"} aria-hidden="true" />;
    }
  };
  return (
    <fieldset className="pg-cv" disabled={busy} aria-busy={busy || undefined}>
      {canvas.components.map(draw)}
    </fieldset>
  );
}

/**
 * One app in one placement: initialized when shown (and again for another conversation), then
 * each press is a submit. Text for the reply (composer) and "configured" (settings) go to the caller.
 */
export function CanvasApp({ app, conversationId, onInsert, onConfigured }: { app: InstalledCanvas; conversationId?: string; onInsert?: (text: string) => void; onConfigured?: () => void }) {
  const [state, setState] = useState<{
    result: CanvasResult | { status: "loading" };
    busy: boolean;
    version: number;
  }>({ result: { status: "loading" }, busy: false, version: 0 });
  // The callers' handlers change as they render; the card is initialized again only for another app or conversation.
  const handlers = useRef({ onInsert, onConfigured });
  useEffect(() => {
    handlers.current = { onInsert, onConfigured };
  });
  /** Asks the server (which asks the app); a refusal becomes a failure card too. */
  const request = useCallback(
    (body: Record<string, unknown>): Promise<CanvasResult> =>
      api<CanvasResult>("canvas", { installationId: app.installationId, placement: app.placement, conversationId, ...body }).catch((e: unknown) => ({
        status: "failed" as const,
        outcome: "error",
        message: e instanceof Error ? e.message : "The card couldn't be loaded.",
        detail: "",
      })),
    [app.installationId, app.placement, conversationId],
  );
  const show = (result: CanvasResult) => {
    setState((s) => ({ result, busy: false, version: s.version + 1 }));
    if (result.status === "insert") handlers.current.onInsert?.(result.text);
    if (result.status === "configured") handlers.current.onConfigured?.();
  };
  const ask = (body: Record<string, unknown>) => request(body).then(show);
  // Callers key a card by its app and conversation, so it starts afresh (loading) for each.
  useEffect(() => {
    let live = true;
    void request({ action: "initialize" }).then((result) => {
      if (!live) return;
      setState((s) => ({ result, busy: false, version: s.version + 1 }));
    });
    return () => {
      live = false;
    };
  }, [request]);
  /** A teammate's press: the card is busy until the app answers. */
  const press = (body: Record<string, unknown>) => {
    setState((s) => ({ ...s, busy: true }));
    void ask(body);
  };
  const r = state.result;
  if (r.status === "loading")
    return (
      <p className="pg-cv-loading" aria-busy="true">
        Loading {app.appName}…
      </p>
    );
  if (r.status === "failed")
    return (
      <div className="pg-cv-failed" role="alert">
        <strong>{r.message}</strong>
        {r.detail && <small>{r.detail}</small>}
        <button type="button" className="pg-cv-button" data-style="secondary" disabled={state.busy} onClick={() => press({ action: "initialize" })}>
          <RotateCw size={12} aria-hidden="true" /> Try again
        </button>
      </div>
    );
  if (r.status === "configured")
    return (
      <p className="pg-cv-done" role="status">
        {app.appName} is set up.
      </p>
    );
  if (r.status === "insert")
    return (
      <p className="pg-cv-done" role="status">
        Added to your reply.
      </p>
    );
  return (
    <CanvasView
      key={r.sessionId + ":" + state.version}
      canvas={r.canvas}
      busy={state.busy}
      onSubmit={(componentId, inputValues) =>
        void ask({
          action: "submit",
          sessionId: r.sessionId,
          componentId,
          inputValues,
        })
      }
    />
  );
}

/** The apps installed here for a placement in a conversation (none while the API is off). */
function useCanvasApps(placement: Placement, conversationId: string) {
  const [apps, setApps] = useState<{
    key: string;
    list: InstalledCanvas[];
  } | null>(null);
  const key = placement + ":" + conversationId;
  useEffect(() => {
    let live = true;
    api<{ apps: InstalledCanvas[] }>("canvas-apps?" + new URLSearchParams({ placement, conversation: conversationId }))
      .then((r) => live && setApps({ key, list: r.apps }))
      .catch(() => live && setApps({ key, list: [] }));
    return () => {
      live = false;
    };
  }, [placement, conversationId, key]);
  return apps?.key === key ? apps.list : [];
}

/** The conversation sidebar's app cards, one per installed app. */
export function CanvasCards({ placement, conversationId }: { placement: "conversation.sidebar"; conversationId: string }) {
  const apps = useCanvasApps(placement, conversationId);
  if (!apps.length) return null;
  return (
    <section aria-labelledby="ctx-apps" className="pg-cv-cards">
      <h3 id="ctx-apps">Apps</h3>
      {apps.map((a) => (
        <article key={a.installationId + conversationId} className="pg-app-card" aria-label={a.appName}>
          <h4>
            <AppWindow size={13} aria-hidden="true" /> {a.appName}
          </h4>
          <CanvasApp app={a} conversationId={conversationId} />
        </article>
      ))}
    </section>
  );
}

/** The composer's Apps button: an installed app's card, whose answer can go into the reply. */
export function ComposerApps({ conversationId, onInsert }: { conversationId: string; onInsert: (appName: string, text: string) => void }) {
  const apps = useCanvasApps("composer", conversationId);
  const [open, setOpen] = useState<InstalledCanvas | "menu" | null>(null);
  // The composer clips what overflows it, so the card floats above the page, anchored to the button.
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const [shownFor, setShownFor] = useState(conversationId);
  if (shownFor !== conversationId) {
    setShownFor(conversationId);
    setOpen(null);
  }
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  const insert = useCallback(
    (text: string) => {
      if (open && open !== "menu") onInsert(open.appName, text);
      setOpen(null);
    },
    [open, onInsert],
  );
  if (!apps.length) return null;
  return (
    <span className="pg-cv-composer">
      <button
        type="button"
        className="pg-macros-button"
        aria-expanded={!!open}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor({ left: Math.max(8, Math.min(r.left, window.innerWidth - 336)), bottom: window.innerHeight - r.top + 8 });
          setOpen(open ? null : apps.length === 1 ? apps[0] : "menu");
        }}
      >
        <AppWindow size={14} aria-hidden="true" /> Apps
      </button>
      {open && (
        <div className="pg-cv-popover" role="dialog" aria-label={open === "menu" ? "Apps" : open.appName} style={anchor ?? undefined}>
          <header>
            <strong>{open === "menu" ? "Apps" : open.appName}</strong>
            <button type="button" aria-label="Close" onClick={() => setOpen(null)}>
              <X size={14} aria-hidden="true" />
            </button>
          </header>
          {open === "menu" ? (
            <ul className="pg-cv-list">
              {apps.map((a) => (
                <li key={a.installationId}>
                  <button type="button" onClick={() => setOpen(a)}>
                    <strong>{a.appName}</strong>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <CanvasApp key={open.installationId + conversationId} app={open} conversationId={conversationId} onInsert={insert} />
          )}
        </div>
      )}
    </span>
  );
}
