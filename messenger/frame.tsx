import React, { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { language } from "./strings";
import { RichText } from "../lib/rich-view";
import "./frame.css";

type Part = {
  id: string;
  conversation_id: string;
  kind: string;
  author_type: string;
  author_name?: string;
  body: string;
  created_at: string;
  display_time?: string;
  data: Record<string, unknown>;
  supersedes_id?: string;
};
type Conversation = {
  unread?: boolean;
  id: string;
  title: string;
  status: string;
};
type Boot = {
  token: string;
  locale: string;
  session: { workspace: string; verified: boolean };
  brand: {
    id: string;
    name: string;
    locale?: string;
    theme?: string;
    directConversation?: boolean;
    allowVisitors?: boolean;
    requireSearch?: boolean;
    logo?: string;
    teamIntroduction?: string;
    outOfHours?: string;
    homeBlocks?: {
      type: string;
      title?: string;
      body?: string;
      url?: string;
    }[];
  };
  capabilities: Record<string, boolean>;
  availability?: { open: boolean; nextOpenLabel?: string };
  realtime?: { url: string; ticket: string };
};
type Init = { boot: Boot; api: string; open: boolean };
const query = new URLSearchParams(location.search),
  parentOrigin = query.get("parent") ?? "",
  channel = query.get("channel");
const sendParent = (type: string, data: Record<string, unknown> = {}) =>
  parent.postMessage({ relay: channel, type, ...data }, parentOrigin);
const sound = () => {
  const ctx = new AudioContext(),
    osc = ctx.createOscillator(),
    gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = 660;
  gain.gain.value = 0.06;
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
  osc.start();
  osc.stop(ctx.currentTime + 0.15);
  osc.onended = () => void ctx.close();
};
function Messenger({ boot, api, open: initialOpen }: Init) {
  const { strings: t, locale, dir } = language(boot.locale, boot.brand.locale);
  const [space, setSpace] = useState(
      boot.brand.directConversation ? "messages" : "home",
    ),
    [composing, setComposing] = useState(!!boot.brand.directConversation),
    [conversations, setConversations] = useState<Conversation[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [parts, setParts] = useState<Part[]>([]),
    [draft, setDraft] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [canRetry, setCanRetry] = useState(false),
    [connected, setConnected] = useState(false),
    [typing, setTyping] = useState(false),
    [sounds, setSounds] = useState(false),
    [visible, setVisible] = useState(initialOpen),
    [documentVisible, setDocumentVisible] = useState(
      document.visibilityState !== "hidden",
    ),
    [uploadState, setUploadState] = useState(""),
    [notificationState, setNotificationState] = useState("");
  const histories = useRef(
      new Map<string, { parts: Part[]; cursor?: string }>(),
    ),
    socket = useRef<WebSocket | null>(null),
    current = useRef<string | null>(null),
    soundRef = useRef(sounds),
    renderedReads = useRef(new Set<string>()),
    list = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    pending = useRef<{ body: Record<string, unknown>; key: string } | null>(
      null,
    ),
    lastTyping = useRef(0),
    jobs = useRef(new Set<string>()),
    fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    current.current = selected;
    return () => {
      if (selected && socket.current?.readyState === WebSocket.OPEN)
        socket.current.send(
          JSON.stringify({ type: "unsubscribe", conversationId: selected }),
        );
    };
  }, [selected]);
  useEffect(() => {
    soundRef.current = sounds;
  }, [sounds]);
  useEffect(() => {
    const changed = () =>
      setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const request = useCallback(
    async <T = Record<string, unknown>,>(
      path: string,
      body?: unknown,
      key = crypto.randomUUID(),
    ) => {
      const r = await fetch(api + "/v1/messenger/" + path, {
        method: body ? "POST" : "GET",
        credentials: "omit",
        headers: {
          Authorization: "Bearer " + boot.token,
          ...(body
            ? { "Content-Type": "application/json", "Idempotency-Key": key }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = (await r.json()) as T & { error?: { message: string } };
      if (!r.ok) {
        if (r.status === 401) sendParent("identityRequired");
        throw new Error(data.error?.message || t.error);
      }
      return data;
    },
    [api, boot.token, t.error],
  );
  const refreshList = useCallback(async () => {
    const data = await request<{ conversations: Conversation[] }>(
      "conversations",
    );
    setConversations(data.conversations);
  }, [request]);
  function select(id: string | null) {
    if (
      current.current &&
      current.current !== id &&
      socket.current?.readyState === WebSocket.OPEN
    )
      socket.current.send(
        JSON.stringify({
          type: "unsubscribe",
          conversationId: current.current,
        }),
      );
    current.current = id;
    setSelected(id);
    setComposing(id === null);
    setSpace("messages");
    setError("");
    setParts(id ? (histories.current.get(id)?.parts ?? []) : []);
    if (id && socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(
        JSON.stringify({
          type: "subscribe",
          conversationId: id,
          cursor: histories.current.get(id)?.cursor,
        }),
      );
    setTimeout(() => input.current?.focus(), 0);
  }
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    document.documentElement.dataset.theme = boot.brand.theme ?? "auto";
    const theme = document.createElement("link");
    theme.rel = "stylesheet";
    theme.href =
      api +
      "/messenger/theme.css?workspace=" +
      encodeURIComponent(boot.session.workspace) +
      "&brand=" +
      encodeURIComponent(boot.brand.id);
    document.head.appendChild(theme);
    let active = true;
    void request<{ conversations: Conversation[] }>("conversations")
      .then((data) => {
        if (active) setConversations(data.conversations);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    const listener = (event: MessageEvent) => {
      if (
        event.source !== parent ||
        event.origin !== parentOrigin ||
        event.data?.relay !== channel
      )
        return;
      const data = event.data;
      if (data.type === "notificationState")
        setNotificationState(data.permission);
      if (data.type === "close") setVisible(false);
      if (data.type === "open") {
        setVisible(true);
        if (["home", "messages", "help"].includes(data.space))
          setSpace(data.space);
        setTimeout(
          () => document.querySelector<HTMLButtonElement>(".close")?.focus(),
          0,
        );
      }
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") sendParent("close");
    };
    addEventListener("message", listener);
    addEventListener("keydown", escape);
    return () => {
      active = false;
      theme.remove();
      removeEventListener("message", listener);
      removeEventListener("keydown", escape);
    };
  }, [
    api,
    boot.brand.id,
    boot.brand.theme,
    boot.session.workspace,
    dir,
    locale,
    request,
  ]);
  useEffect(() => {
    if (!boot.realtime) return;
    let stopped = false,
      attempt = 0,
      timer: ReturnType<typeof setTimeout>,
      typingTimer: ReturnType<typeof setTimeout>;
    let first = true;
    async function connect() {
      try {
        const config = first
          ? boot.realtime
          : await request<{ url: string; ticket: string }>(
              "realtime-ticket",
              {},
            );
        first = false;
        if (stopped) return;
        const url = new URL(config!.url);
        url.searchParams.set("workspace", boot.session.workspace);
        const ws = (socket.current = new WebSocket(url));
        ws.onopen = () =>
          ws.send(
            JSON.stringify({ type: "authenticate", ticket: config!.ticket }),
          );
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "ready") {
            setConnected(true);
            attempt = 0;
            for (const jobId of jobs.current)
              ws.send(JSON.stringify({ type: "subscribe_job", jobId }));
            if (current.current)
              ws.send(
                JSON.stringify({
                  type: "subscribe",
                  conversationId: current.current,
                  cursor: histories.current.get(current.current)?.cursor,
                }),
              );
          }
          if (data.type === "reauthenticate") {
            ws.close();
            return;
          }
          if (data.type === "job") {
            if (["succeeded", "dead_letter", "failed"].includes(data.state)) {
              jobs.current.delete(data.id);
              setUploadState("");
              if (
                data.state !== "succeeded" ||
                data.result?.status === "rejected"
              )
                setError(
                  t.uploadFailed +
                    " " +
                    (data.result?.reason || data.error || ""),
                );
            }
          }
          if (data.type === "error") {
            setError(data.message);
            if (data.code === "AUTH_REQUIRED") ws.close();
          }
          if (
            data.type === "typing" &&
            data.conversationId === current.current
          ) {
            setTyping(data.active);
            clearTimeout(typingTimer);
            typingTimer = setTimeout(() => setTyping(false), 5000);
          }
          if (data.type === "unread") void refreshList().catch(() => {});
          if (data.type === "timeline") {
            const previous = histories.current.get(data.conversationId),
              base = data.reset ? [] : (previous?.parts ?? []);
            const ids = new Set(base.map((p) => p.id));
            const fresh: Part[] = data.parts.filter(
              (p: Part) => !ids.has(p.id),
            );
            const merged = [...base, ...fresh];
            histories.current.set(data.conversationId, {
              parts: merged,
              cursor: data.cursor,
            });
            if (data.conversationId === current.current) setParts(merged);
            if (
              previous &&
              fresh.some(
                (p) => p.kind === "teammate_reply" || p.kind === "ai_reply",
              )
            ) {
              sendParent("newReply");
              if (soundRef.current)
                try {
                  sound();
                } catch {}
            }
          }
        };
        ws.onclose = (event) => {
          setConnected(false);
          if (stopped) return;
          if (event.code === 4401) {
            sendParent("identityRequired");
            setError(t.session);
            return;
          }
          timer = setTimeout(connect, Math.min(30000, 500 * 2 ** attempt++));
        };
      } catch (e) {
        setError((e as Error).message);
        if (!stopped) timer = setTimeout(connect, 5000);
      }
    }
    void connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(typingTimer);
      socket.current?.close();
    };
  }, [
    boot.realtime,
    boot.session.workspace,
    refreshList,
    request,
    t.session,
    t.uploadFailed,
  ]);
  useEffect(() => {
    if (!visible || !documentVisible || space !== "messages" || !selected)
      return;
    list.current?.scrollTo({
      top: list.current.scrollHeight,
      behavior: "smooth",
    });
    const latest = new Map<string, Part>();
    for (const p of parts) latest.set(p.conversation_id, p);
    for (const p of latest.values())
      if (!renderedReads.current.has(p.id)) {
        renderedReads.current.add(p.id);
        void request("read", {
          conversationId: p.conversation_id,
          partId: p.id,
        }).catch(() => renderedReads.current.delete(p.id));
      }
  }, [parts, visible, documentVisible, space, selected, request]);
  async function submit(event?: React.FormEvent, retry = false) {
    event?.preventDefault();
    if (busy) return;
    const text = draft.trim();
    if (!retry && !text) return;
    setBusy(true);
    setError("");
    if (!retry)
      pending.current = {
        body: {
          action: selected ? "reply" : "start",
          conversationId: selected ?? undefined,
          text,
        },
        key: crypto.randomUUID(),
      };
    try {
      const result = await request<{ conversationId: string }>(
        "command",
        pending.current!.body,
        pending.current!.key,
      );
      pending.current = null;
      setCanRetry(false);
      setDraft("");
      if (result.conversationId !== selected) select(result.conversationId);
      await refreshList();
    } catch (e) {
      setCanRetry(true);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File) {
    if (!selected) return;
    setUploadState(t.scanning);
    setError("");
    try {
      const prepared = await request<{
        attachmentId: string;
        url: string;
        headers: Record<string, string>;
      }>("attachment/prepare", {
        conversationId: selected,
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
      });
      const put = await fetch(prepared.url, {
        method: "PUT",
        headers: prepared.headers,
        body: file,
        credentials: "omit",
      });
      if (!put.ok) throw new Error(t.uploadFailed);
      const queued = await request<{ jobId: string }>("attachment/complete", {
        attachmentId: prepared.attachmentId,
      });
      jobs.current.add(queued.jobId);
      if (socket.current?.readyState === WebSocket.OPEN)
        socket.current.send(
          JSON.stringify({ type: "subscribe_job", jobId: queued.jobId }),
        );
    } catch (e) {
      setUploadState("");
      setError((e as Error).message);
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  const superseded = new Set(parts.map((p) => p.supersedes_id).filter(Boolean));
  const mayStart =
    (boot.brand.allowVisitors !== false || boot.session.verified) &&
    !boot.brand.requireSearch;
  const rows = (limit = 100) => (
    <div className="conversation-list">
      {conversations.slice(0, limit).map((c) => (
        <button
          key={c.id}
          className="conversation"
          onClick={() => select(c.id)}
        >
          <span className="conversation-icon" aria-hidden="true">
            ↗
          </span>
          <span>
            {c.title}
            <small>
              {{
                open: t.openState,
                snoozed: t.snoozedState,
                closed: t.closedState,
              }[c.status] ?? c.status}
              {c.unread ? " · " + t.unread : ""}
            </small>
          </span>
          <span aria-hidden="true">›</span>
        </button>
      ))}
      {!conversations.length && <p className="muted empty">{t.empty}</p>}
    </div>
  );
  const start = () =>
    mayStart ? (
      <button className="primary start" onClick={() => select(null)}>
        {t.start}
        <span aria-hidden="true">↗</span>
      </button>
    ) : (
      <p className="muted">
        {boot.brand.requireSearch ? t.searchFirst : t.signIn}
      </p>
    );
  return (
    <div
      className="shell"
      role="dialog"
      aria-label={boot.brand.name + " " + t.support}
      aria-modal="false"
    >
      <header>
        <div className="brand">
          {boot.brand.logo && (
            <img src={boot.brand.logo} alt="" width="32" height="32" />
          )}
          <span className="brand-mark" aria-hidden="true">
            ✦
          </span>
          <strong>{boot.brand.name}</strong>
        </div>
        <button
          className="icon-button close"
          aria-label={t.close}
          onClick={() => sendParent("close")}
        >
          ×
        </button>
      </header>
      <main>
        {space === "home" && (
          <div className="home">
            <div className="intro">
              <span className="eyebrow">{boot.brand.teamIntroduction}</span>
              <h1>{t.welcome}</h1>
              <p>
                {boot.availability?.open
                  ? t.open
                  : boot.brand.outOfHours || t.away}
              </p>
              {boot.availability?.nextOpenLabel && (
                <small>{boot.availability.nextOpenLabel}</small>
              )}
            </div>
            {(
              boot.brand.homeBlocks ?? [{ type: "start" }, { type: "recent" }]
            ).map((block, index: number) => (
              <section key={index}>
                {block.type === "start" ? (
                  start()
                ) : block.type === "recent" ? (
                  <>
                    <h2>{t.recent}</h2>
                    {rows(3)}
                  </>
                ) : block.type === "announcement" ? (
                  <article className="card">
                    <h2>{block.title}</h2>
                    <p>{block.body}</p>
                  </article>
                ) : block.type === "card" &&
                  /^https:\/\//.test(block.url ?? "") ? (
                  <a
                    className="card"
                    href={block.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <h2>{block.title}</h2>
                    <p>{block.body}</p>
                  </a>
                ) : block.type === "search" ? (
                  <button className="card" onClick={() => setSpace("help")}>
                    {t.help}
                  </button>
                ) : null}
              </section>
            ))}
          </div>
        )}
        {space === "messages" &&
          (selected === null && !composing ? (
            <div className="messages-index">
              <h1>{t.messages}</h1>
              {rows()}
              <form onSubmit={(e) => void submit(e)}>
                <label htmlFor="first-message">{t.write}</label>
                <textarea
                  id="first-message"
                  ref={input}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={5000}
                  disabled={!mayStart}
                />
                <button
                  className="primary"
                  disabled={busy || !mayStart || !draft.trim()}
                >
                  {t.send}
                </button>
              </form>
            </div>
          ) : (
            <div className="thread">
              <div className="thread-heading">
                <button
                  className="icon-button"
                  onClick={() => {
                    setSelected(null);
                    setComposing(false);
                    setParts([]);
                    setDraft("");
                    setSpace("home");
                  }}
                  aria-label={t.back}
                >
                  ‹
                </button>
                <div>
                  <strong>
                    {conversations.find((c) => c.id === selected)?.title ||
                      t.start}
                  </strong>
                  <small role="status">
                    {connected ? t.connected : t.disconnected}
                  </small>
                </div>
              </div>
              <div
                className="timeline"
                ref={list}
                role="log"
                aria-label={t.messages}
                aria-live="polite"
                aria-relevant="additions text"
              >
                {parts
                  .filter((p) => !superseded.has(p.id))
                  .map((p) => {
                    if (p.kind === "attachment")
                      return (
                        <article
                          className={
                            "message " +
                            (p.author_type === "contact"
                              ? "outgoing"
                              : "incoming")
                          }
                          key={p.id}
                          data-part-id={p.id}
                        >
                          <Attachment
                            part={p}
                            request={request}
                            label={t.download}
                          />
                        </article>
                      );
                    const message = [
                      "customer_message",
                      "teammate_reply",
                      "ai_reply",
                      "internal_note",
                    ].includes(p.kind);
                    if (!message) {
                      const label =
                        p.kind === "state_change"
                          ? p.data.to === "closed"
                            ? t.closed
                            : p.data.to === "open"
                              ? t.reopened
                              : null
                          : p.kind === "merge_marker"
                            ? t.merged
                            : p.kind === "system_event" &&
                                p.data.event === "human_joined"
                              ? t.joined
                              : null;
                      return label ? (
                        <p className="event" key={p.id} data-part-id={p.id}>
                          {label}
                        </p>
                      ) : null;
                    }
                    const name =
                      p.author_type === "contact"
                        ? t.you
                        : p.author_type === "ai"
                          ? t.ai
                          : p.author_type === "system"
                            ? t.automation
                            : p.author_name ||
                              String(p.data.authorName || t.teammate);
                    return (
                      <article
                        key={p.id}
                        data-part-id={p.id}
                        className={
                          "message " +
                          (p.author_type === "contact"
                            ? "outgoing"
                            : "incoming")
                        }
                      >
                        <small>{name}</small>
                        {p.data.deleted ? (
                          <p>{t.deleted}</p>
                        ) : p.data.doc ? (
                          <RichText
                            doc={p.data.doc}
                            fallback={p.body}
                            image={(image) => (
                              <InlineImage
                                id={image.attachmentId}
                                alt={image.alt ?? ""}
                                request={request}
                              />
                            )}
                          />
                        ) : (
                          <p>{p.body}</p>
                        )}
                        <time dateTime={p.created_at}>
                          {p.display_time ?? p.created_at}
                        </time>
                        {p.supersedes_id && !p.data.deleted && (
                          <small>{t.edited}</small>
                        )}
                      </article>
                    );
                  })}
                {typing && (
                  <p className="event" role="status">
                    {t.typing}
                  </p>
                )}
              </div>
              <div role="status" className="upload-status">
                {uploadState}
              </div>
              <form className="composer" onSubmit={(e) => void submit(e)}>
                <label className="sr-only" htmlFor="reply">
                  {t.write}
                </label>
                <textarea
                  ref={input}
                  id="reply"
                  placeholder={t.write}
                  value={draft}
                  maxLength={5000}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    if (
                      selected &&
                      Date.now() - lastTyping.current > 1500 &&
                      socket.current?.readyState === WebSocket.OPEN
                    ) {
                      lastTyping.current = Date.now();
                      socket.current.send(
                        JSON.stringify({
                          type: "typing",
                          conversationId: selected,
                          active: true,
                        }),
                      );
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
                {boot.capabilities.attachments && (
                  <>
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/png,image/jpeg,application/pdf,text/plain"
                      className="sr-only"
                      tabIndex={-1}
                      aria-label={t.upload}
                      onChange={(e) => {
                        if (e.target.files?.[0]) void upload(e.target.files[0]);
                      }}
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t.upload}
                      disabled={!selected || !!uploadState}
                      onClick={() => fileInput.current?.click()}
                    >
                      ＋
                    </button>
                  </>
                )}
                <button
                  className="send"
                  aria-label={t.send}
                  disabled={busy || !draft.trim()}
                >
                  ↑
                </button>
              </form>
            </div>
          ))}
        {space === "help" && (
          <div className="help">
            <h1>{t.help}</h1>
            <p>{t.unavailable}</p>
            {start()}
          </div>
        )}
      </main>
      {error && (
        <div className="error" role="alert">
          {error}
          {canRetry && (
            <button
              disabled={busy}
              onClick={() => void submit(undefined, true)}
            >
              {t.retry}
            </button>
          )}
        </div>
      )}
      <details className="preferences">
        <summary>{t.settings}</summary>
        <label>
          <input
            type="checkbox"
            checked={sounds}
            onChange={(e) => {
              setSounds(e.target.checked);
              if (e.target.checked)
                try {
                  sound();
                } catch {}
              sendParent("sound", { enabled: e.target.checked });
            }}
          />
          {t.sound}
        </label>
        <button
          type="button"
          onClick={() => sendParent("requestNotifications")}
        >
          {t.notifications}
        </button>
        <span role="status">
          {{
            granted: t.alertsGranted,
            denied: t.alertsDenied,
            default: t.alertsDefault,
            unsupported: t.alertsUnsupported,
          }[notificationState] ?? ""}
        </span>
      </details>
      <nav aria-label={t.spaces}>
        {(["home", "messages", "help"] as const).map((s) => (
          <button
            key={s}
            onClick={() => {
              setSpace(s);
              if (s === "messages") {
                setSelected(null);
                setComposing(false);
                setParts([]);
              }
            }}
            aria-current={space === s ? "page" : undefined}
          >
            <span aria-hidden="true">
              {s === "home" ? "⌂" : s === "messages" ? "▤" : "⌕"}
            </span>
            {t[s]}
          </button>
        ))}
      </nav>
      <footer>
        {t.poweredBy} <strong>Relay</strong>
      </footer>
    </div>
  );
}
/** An image inside a teammate's reply: a short-lived link from the customer attachment route. */
function InlineImage({
  id,
  alt,
  request,
}: {
  id: string;
  alt: string;
  request: (path: string) => Promise<{ url: string }>;
}) {
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void request("attachment?preview=true&id=" + encodeURIComponent(id))
      .then((d) => setSrc(d.url))
      .catch(() => setFailed(true));
  }, [id, request]);
  if (failed) return <p>[Image{alt ? ": " + alt : ""}]</p>;
  return src ? (
    <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
  ) : (
    <span className="rich-image-loading" aria-label={alt || "Image"} />
  );
}
function Attachment({
  part,
  request,
  label,
}: {
  part: Part;
  request: (path: string) => Promise<{ url: string }>;
  label: string;
}) {
  const [preview, setPreview] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    if (part.data.hasPreview)
      void request(
        "attachment?id=" +
          encodeURIComponent(String(part.data.attachmentId)) +
          "&preview=true",
      )
        .then((d) => setPreview(d.url))
        .catch(() => {});
  }, [part.id, part.data.hasPreview, part.data.attachmentId, request]);
  return (
    <div className="attachment">
      {preview && (
        <img
          src={preview}
          alt={String(part.data.name)}
          loading="lazy"
          onError={() => setPreview("")}
        />
      )}
      <button
        onClick={async () => {
          try {
            const data = await request(
              "attachment?id=" +
                encodeURIComponent(String(part.data.attachmentId)),
            );
            const a = document.createElement("a");
            a.href = data.url;
            a.download = String(part.data.name);
            a.rel = "noreferrer";
            a.click();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        {label}: {String(part.data.name)}
      </button>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
const root = createRoot(document.getElementById("root")!);
addEventListener("message", (event) => {
  if (
    event.source !== parent ||
    event.origin !== parentOrigin ||
    event.data?.relay !== channel ||
    event.data.type !== "initialize"
  )
    return;
  root.render(<Messenger key={event.data.boot.token} {...event.data} />);
});
sendParent("ready");
