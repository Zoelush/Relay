"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Inbox,
  LockKeyhole,
  MessageSquare,
  Send,
  RefreshCw,
  Paperclip,
} from "lucide-react";
import "../../agent/inbox.css";
import { api, InboxError } from "../../agent/api";
import { InboxViews, type ViewCount } from "../../agent/views";

type Conversation = {
  id: string;
  title: string;
  name?: string;
  email?: string;
  status: string;
  channel: string;
  assigned: string;
};
type Part = {
  id: string;
  kind: string;
  audience: string;
  body: string;
  supersedes_id?: string;
  author_type: string;
  data: {
    authorName?: string;
    clientMutationId?: string;
    attachmentId?: string;
    name?: string;
    deleted?: boolean;
  };
};
type Snapshot = {
  conversations: Conversation[];
  teammate: { name: string };
  storage: { engine: string; transport: string; workspaceId: string };
  capabilities: { reply: boolean; note: boolean; views?: boolean };
};
type Pending = {
  id: string;
  conversationId: string;
  mode: "reply" | "note";
  body: string;
};

/** Step 1: authenticated core inbox. Saved views and rich composing are separate steps. */
export default function PostgresInbox() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [selected, setSelected] = useState("");
  const [parts, setParts] = useState<Part[]>([]);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState("Connecting");
  const [viewRevision, setViewRevision] = useState(0);
  const [viewCounts, setViewCounts] = useState<ViewCount[]>([]);
  const [pickedConversation, setPickedConversation] = useState<Conversation>();
  const [retry, setRetry] = useState(0);
  const selectedRef = useRef("");
  const socket = useRef<WebSocket | null>(null);
  const ready = useRef(false);
  const cache = useRef(
    new Map<string, { parts: Map<string, Part>; cursor?: string }>(),
  );
  const failed = useRef(new Map<string, Pending>());
  const bottom = useRef<HTMLDivElement>(null);
  const fatal = useRef(false);
  const loadVersion = useRef(0);
  const invalidateLoads = useCallback(() => {
    ++loadVersion.current;
  }, []);

  const report = useCallback((reason: unknown) => {
    setError(
      reason instanceof Error ? reason.message : "Reconnect to continue.",
    );
    if (
      reason instanceof InboxError &&
      ([401, 403].includes(reason.status) || reason.code === "FEATURE_DISABLED")
    ) {
      fatal.current = true;
      cache.current.clear();
      failed.current.clear();
      setSnapshot(undefined);
      setViewCounts([]);
      setPickedConversation(undefined);
      setParts([]);
      setPending([]);
      setDrafts({});
      ready.current = false;
      socket.current?.close();
      setConnection("Access unavailable");
    }
  }, []);
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const data = await api<Snapshot>("inbox");
      if (!fatal.current && version === loadVersion.current) setSnapshot(data);
    } catch (e) {
      if (version === loadVersion.current) report(e);
    }
  }, [report]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let listTimer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    fatal.current = false;
    async function connect() {
      try {
        const ticket = await api<{ ticket: string; url: string }>(
          "realtime-ticket",
          {},
        );
        const data = await api<Snapshot>("inbox");
        if (stopped) return;
        setSnapshot(data);
        const url = new URL(ticket.url);
        url.searchParams.set("workspace", data.storage.workspaceId);
        const ws = new WebSocket(url);
        socket.current = ws;
        ws.onopen = () =>
          ws.send(
            JSON.stringify({ type: "authenticate", ticket: ticket.ticket }),
          );
        ws.onmessage = (event) => {
          if (stopped || ws !== socket.current || fatal.current) return;
          const frame = JSON.parse(event.data);
          if (frame.type === "ready") {
            attempt = 0;
            ready.current = true;
            setConnection("Live");
            setError("");
            void load();
            if (selectedRef.current)
              ws.send(
                JSON.stringify({
                  type: "subscribe",
                  conversationId: selectedRef.current,
                  cursor: cache.current.get(selectedRef.current)?.cursor,
                }),
              );
          }
          if (frame.type === "reauthenticate") ws.close();
          if (frame.type === "unread" && frame.viewCounts)
            setViewCounts(frame.viewCounts);
          if (frame.type === "job") setViewRevision((n) => n + 1);
          if (frame.type === "inbox_changed") {
            setViewRevision((n) => n + 1);
            clearTimeout(listTimer);
            listTimer = setTimeout(() => void load(), 75);
          }
          if (frame.type === "timeline") {
            const id = String(frame.conversationId);
            const entry = frame.reset
              ? {
                  parts: new Map<string, Part>(),
                  cursor: undefined as string | undefined,
                }
              : (cache.current.get(id) ?? {
                  parts: new Map<string, Part>(),
                  cursor: undefined,
                });
            for (const p of frame.parts as Part[]) entry.parts.set(p.id, p);
            entry.cursor = frame.cursor;
            cache.current.set(id, entry);
            if (selectedRef.current === id) setParts([...entry.parts.values()]);
            const committed = new Set(
              (frame.parts as Part[]).map((p) => p.data.clientMutationId),
            );
            setPending((items) => items.filter((p) => !committed.has(p.id)));
          }
          if (frame.type === "error") {
            if (
              frame.code === "CURSOR_INVALID" ||
              frame.code === "SESSION_EXPIRED"
            ) {
              if (frame.code === "CURSOR_INVALID") cache.current.clear();
              ws.close();
            } else
              report(
                new InboxError(
                  frame.message,
                  ["FORBIDDEN", "FEATURE_DISABLED", "AUTH_REQUIRED"].includes(
                    frame.code,
                  )
                    ? 403
                    : 400,
                  frame.code,
                ),
              );
          }
        };
        ws.onclose = () => {
          if (stopped || ws !== socket.current) return;
          ready.current = false;
          if (fatal.current) return;
          setConnection("Reconnecting");
          timer = setTimeout(
            () => void connect(),
            Math.min(15000, 500 * 2 ** attempt++),
          );
        };
        ws.onerror = () => ws.close();
      } catch (e) {
        if (stopped) return;
        report(e);
        if (!fatal.current)
          timer = setTimeout(
            () => void connect(),
            Math.min(15000, 500 * 2 ** attempt++),
          );
      }
    }
    void connect();
    const heartbeat = setInterval(() => {
      if (ready.current && socket.current?.readyState === WebSocket.OPEN)
        socket.current.send(JSON.stringify({ type: "ping" }));
    }, 30000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(listTimer);
      clearInterval(heartbeat);
      ready.current = false;
      socket.current?.close();
      invalidateLoads();
    };
  }, [load, report, retry, invalidateLoads]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [parts, pending]);
  function pick(id: string) {
    if (ready.current && selectedRef.current)
      socket.current?.send(
        JSON.stringify({
          type: "unsubscribe",
          conversationId: selectedRef.current,
        }),
      );
    selectedRef.current = id;
    setSelected(id);
    setParts([...(cache.current.get(id)?.parts.values() ?? [])]);
    setError("");
    if (ready.current)
      socket.current?.send(
        JSON.stringify({
          type: "subscribe",
          conversationId: id,
          cursor: cache.current.get(id)?.cursor,
        }),
      );
    void api("command", { action: "read", conversationId: id }).catch(report);
  }
  const draftKey = selected + ":" + mode;
  const draft = drafts[draftKey] ?? "";
  async function send() {
    if (
      !selected ||
      !draft.trim() ||
      pending.some((p) => p.conversationId === selected)
    )
      return;
    const previous = failed.current.get(draftKey);
    const item: Pending =
      previous?.body === draft
        ? previous
        : {
            id: crypto.randomUUID(),
            conversationId: selected,
            mode,
            body: draft,
          };
    failed.current.set(draftKey, item);
    setPending((items) => [...items, item]);
    setDrafts((items) => ({ ...items, [draftKey]: "" }));
    setError("");
    try {
      const result = await api<{ partId: string }>(
        "command",
        {
          action: item.mode,
          conversationId: item.conversationId,
          text: item.body,
        },
        item.id,
      );
      failed.current.delete(draftKey);
      // Keep the pending row until its committed part arrives over replay.
      if (cache.current.get(item.conversationId)?.parts.has(result.partId))
        setPending((items) => items.filter((p) => p.id !== item.id));
    } catch (e) {
      setPending((items) => items.filter((p) => p.id !== item.id));
      setDrafts((items) => ({
        ...items,
        [draftKey]: items[draftKey] || item.body,
      }));
      report(e);
    }
  }
  const conversation =
    snapshot?.conversations.find((c) => c.id === selected) ??
    (pickedConversation?.id === selected ? pickedConversation : undefined);
  const superseded = new Set(parts.map((p) => p.supersedes_id).filter(Boolean));
  const visible = parts.filter((p) => !superseded.has(p.id));
  const canSend = snapshot?.capabilities[mode === "note" ? "note" : "reply"];
  return (
    <main className="pg-inbox">
      <aside className="pg-nav">
        <div className="pg-brand">
          ◈ <strong>relay</strong>
        </div>
        <p>WORKSPACE</p>
        <div className="pg-nav-active">
          <Inbox size={18} /> Inbox
        </div>
        <div className="pg-nav-foot">
          <LockKeyhole size={15} />
          <span>{snapshot?.teammate.name ?? "Authenticated inbox"}</span>
        </div>
      </aside>
      <section className="pg-workspace">
        <header className="pg-top">
          <h1>Inbox</h1>
          <span
            className={connection === "Live" ? "pg-live" : "pg-muted"}
            role="status"
          >
            ● {connection}
          </span>
          <span className="pg-storage" data-testid="storage-source">
            {snapshot
              ? `PostgreSQL · ${snapshot.storage.transport === "local-pglite" ? "local" : "Hyperdrive"}`
              : "Connecting to PostgreSQL"}
          </span>
        </header>
        {error && (
          <div className="pg-error" role="alert">
            {error}
            <button onClick={() => setRetry((n) => n + 1)}>
              <RefreshCw size={14} /> Reconnect
            </button>
          </div>
        )}
        <div className="pg-columns">
          <section className="pg-list" aria-label="Conversations">
            {snapshot?.capabilities.views ? (
              <InboxViews
                selected={selected}
                revision={viewRevision}
                counts={viewCounts}
                onError={report}
                onSelect={(c) => {
                  setPickedConversation(c);
                  pick(c.id);
                }}
                onJob={(id) => {
                  if (ready.current)
                    socket.current?.send(
                      JSON.stringify({ type: "subscribe_job", jobId: id }),
                    );
                }}
              />
            ) : (
              <>
                <h2>Recent conversations</h2>
                {snapshot?.conversations.map((c) => (
                  <button
                    key={c.id}
                    className={c.id === selected ? "pg-row selected" : "pg-row"}
                    onClick={() => pick(c.id)}
                  >
                    <span className="pg-avatar">
                      {(c.name || "C").slice(0, 1)}
                    </span>
                    <span>
                      <strong>{c.name || "Customer"}</strong>
                      <span className="pg-row-title">
                        {c.title || "Conversation"}
                      </span>
                      <small>
                        {c.status} · {c.channel}
                      </small>
                    </span>
                  </button>
                ))}
                {snapshot?.conversations.length === 0 && (
                  <p className="pg-empty">
                    New conversations will appear here automatically.
                  </p>
                )}
              </>
            )}
          </section>
          <section className="pg-thread" aria-label="Conversation timeline">
            {selected ? (
              <>
                <header className="pg-thread-title">
                  <h2>{conversation?.title ?? "Conversation"}</h2>
                  <p>
                    {conversation?.name || "Customer"}
                    {conversation?.email ? ` · ${conversation.email}` : ""}
                  </p>
                </header>
                <div className="pg-timeline" role="log" aria-label="Messages">
                  {visible.map((p) => {
                    const internal =
                      p.audience === "internal" || p.kind === "internal_note";
                    const system = ![
                      "customer_message",
                      "teammate_reply",
                      "internal_note",
                      "ai_reply",
                      "attachment",
                    ].includes(p.kind);
                    if (system)
                      return (
                        <details className="pg-event" key={p.id}>
                          <summary>{p.kind.replaceAll("_", " ")}</summary>
                          <p>{p.body || "Conversation activity"}</p>
                        </details>
                      );
                    return (
                      <article
                        key={p.id}
                        data-part-id={p.id}
                        className={
                          internal ? "pg-message pg-note" : "pg-message"
                        }
                      >
                        <header>
                          {internal && <LockKeyhole size={13} />}
                          <strong>
                            {internal
                              ? "Internal note · Team only"
                              : p.author_type === "contact"
                                ? "Customer"
                                : (p.data.authorName ??
                                  (p.author_type === "ai"
                                    ? "AI agent"
                                    : "Teammate"))}
                          </strong>
                        </header>
                        <p>
                          {p.data.deleted ? "This part was deleted." : p.body}
                        </p>
                        {p.kind === "attachment" && p.data.attachmentId && (
                          <a
                            href={
                              "/api/agent/attachment/content?id=" +
                              encodeURIComponent(p.data.attachmentId)
                            }
                            target="_blank"
                            rel="noreferrer"
                          >
                            <Paperclip size={14} />
                            {p.data.name ?? "Attachment"}
                          </a>
                        )}
                      </article>
                    );
                  })}
                  {pending
                    .filter(
                      (p) =>
                        p.conversationId === selected &&
                        !parts.some(
                          (part) => part.data.clientMutationId === p.id,
                        ),
                    )
                    .map((p) => (
                      <article
                        key={p.id}
                        className={
                          p.mode === "note"
                            ? "pg-message pg-note pg-pending"
                            : "pg-message pg-pending"
                        }
                      >
                        <header>
                          {p.mode === "note"
                            ? "Internal note · Team only"
                            : "Reply"}{" "}
                          · Sending…
                        </header>
                        <p>{p.body}</p>
                      </article>
                    ))}
                  <div ref={bottom} />
                </div>
                <form
                  className={
                    mode === "note" ? "pg-composer note" : "pg-composer"
                  }
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <div className="pg-modes">
                    <button
                      type="button"
                      aria-pressed={mode === "reply"}
                      onClick={() => setMode("reply")}
                    >
                      <MessageSquare size={15} /> Reply
                    </button>
                    <button
                      type="button"
                      aria-pressed={mode === "note"}
                      onClick={() => setMode("note")}
                    >
                      <LockKeyhole size={15} /> Internal note
                    </button>
                    <small>
                      {mode === "note"
                        ? "Only your team can see this"
                        : "Visible to the customer"}
                    </small>
                  </div>
                  <textarea
                    aria-label={
                      mode === "note" ? "Internal note" : "Reply message"
                    }
                    placeholder={
                      mode === "note"
                        ? "Leave a private note for your team…"
                        : "Write a reply…"
                    }
                    value={draft}
                    maxLength={5000}
                    disabled={!canSend}
                    onChange={(e) =>
                      setDrafts((items) => ({
                        ...items,
                        [draftKey]: e.target.value,
                      }))
                    }
                  />
                  <footer>
                    <span>
                      {!canSend
                        ? "Your role cannot perform this action."
                        : mode === "note"
                          ? "Private to your team"
                          : "Messenger"}
                    </span>
                    <button
                      type="submit"
                      disabled={
                        !canSend ||
                        !draft.trim() ||
                        pending.some((p) => p.conversationId === selected)
                      }
                    >
                      <Send size={14} />
                      {mode === "note" ? "Add internal note" : "Send reply"}
                    </button>
                  </footer>
                </form>
              </>
            ) : (
              <div className="pg-welcome">
                <MessageSquare size={36} />
                <h2>Your next conversation starts here</h2>
                <p>Select a conversation to read and reply.</p>
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
