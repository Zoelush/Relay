"use client";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Inbox,
  LockKeyhole,
  MessageSquare,
  Send,
  RefreshCw,
  Clock,
  Flag,
  UserPlus,
  CheckCircle,
  RotateCcw,
  Keyboard,
} from "lucide-react";
import "../../agent/inbox.css";
import { api, InboxError } from "../../agent/api";
import { InboxViews, type ViewCount } from "../../agent/views";
import { Timeline, type Directory } from "../../agent/timeline";
import type { ComposerHandle } from "../../agent/composer";
import { useDrafts } from "../../agent/use-drafts";
import { plainText, type RichDoc } from "../../lib/rich-doc";
import {
  CommandPalette,
  ShortcutSheet,
  SnoozeMenu,
  typing,
  type PaletteCommand,
  type SnoozeChoice,
} from "../../agent/commands";

type Conversation = {
  id: string;
  title: string;
  name?: string;
  email?: string;
  status: string;
  channel: string;
  assigned: string;
  priority?: boolean;
  team_id?: string | null;
  snooze_until?: string | null;
};
type Part = {
  id: string;
  conversation_id: string;
  seq: string;
  created_at: string;
  kind: string;
  audience: string;
  body: string;
  supersedes_id?: string;
  author_type: string;
  author_id?: string;
  data: Record<string, unknown> & {
    authorName?: string;
    clientMutationId?: string;
    attachmentId?: string;
    name?: string;
    deleted?: boolean;
  };
};
type Snapshot = Directory & {
  conversations: Conversation[];
  teammate: { id: string; name: string; role_id?: string };
  storage: { engine: string; transport: string; workspaceId: string };
  capabilities: {
    reply: boolean;
    note: boolean;
    manage?: boolean;
    views?: boolean;
  };
};
/** The rich editor is its own chunk (about 130 KB gzip), so the list and timeline load first. */
const Composer = lazy(() =>
  import("../../agent/composer").then((m) => ({ default: m.Composer })),
);
/** The teammate's own IANA zone: snooze presets are resolved in it on the server. */
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** A cached timeline: parts, the live replay cursor, and the cursor for older history. */
type Entry = {
  parts: Map<string, Part>;
  cursor?: string;
  older?: string | null;
};
type FirstScreen = { parts: Part[]; cursor: string; older: string | null };
/** Conversations kept in memory. Never persisted: notes and customer details stay off disk. */
const CACHE_LIMIT = 50;
/** Timeline order shared with the server: created_at, then conversation, then seq. */
function ordered(entry?: Entry) {
  return [...(entry?.parts.values() ?? [])].sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) ||
      a.conversation_id.localeCompare(b.conversation_id) ||
      Number(a.seq) - Number(b.seq),
  );
}
type Pending = {
  id: string;
  conversationId: string;
  mode: "reply" | "note";
  body: string;
  doc: RichDoc;
};

/**
 * Authenticated core inbox. A conversation opens on its newest parts (from cache when warm),
 * older history loads on scroll, and live replay resumes from the cached cursor.
 */
export default function PostgresInbox() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [selected, setSelected] = useState("");
  const [parts, setParts] = useState<Part[]>([]);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  // Bumped per draft key when the composer must reload content (restore, conflict, send).
  const [seeds, setSeeds] = useState<Record<string, number>>({});
  const reseed = useCallback(
    (key: string) => setSeeds((s) => ({ ...s, [key]: (s[key] ?? 0) + 1 })),
    [],
  );
  const drafts = useDrafts(reseed);
  // Stable callbacks from the hook; the object itself changes every render.
  const { reset: resetDrafts, retry: retryDrafts, load: loadDrafts } = drafts;
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState("");
  const [connection, setConnection] = useState("Connecting");
  const [viewRevision, setViewRevision] = useState(0);
  const [viewCounts, setViewCounts] = useState<ViewCount[]>([]);
  const [pickedConversation, setPickedConversation] = useState<Conversation>();
  const [retry, setRetry] = useState(0);
  // Optimistic conversation changes, dropped when the server confirms or rejects them.
  const [overrides, setOverrides] = useState<
    Record<string, Partial<Conversation>>
  >({});
  const [overlay, setOverlay] = useState<
    "palette" | "shortcuts" | "snooze" | null
  >(null);
  const [viewList, setViewList] = useState<{ id: string; name: string }[]>([]);
  const composer = useRef<ComposerHandle>(null);
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  const selectedRef = useRef("");
  const socket = useRef<WebSocket | null>(null);
  const ready = useRef(false);
  const cache = useRef(new Map<string, Entry>());
  // Cache owner: workspace, teammate and capabilities. A change clears the cache.
  const cacheOwner = useRef("");
  const [hasOlder, setHasOlder] = useState(false);
  const [olderState, setOlderState] = useState<"idle" | "loading" | "error">(
    "idle",
  );
  const olderLoading = useRef(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  // Set before prepending older parts, so the reader's position is kept.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const prefetchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const prefetching = useRef(false);
  // Selection timing: from pick to the frame after its first screen renders.
  const measuring = useRef<{ id: string; start: number; cached: boolean }>(
    null,
  );
  const failed = useRef(new Map<string, Pending>());
  const bottom = useRef<HTMLDivElement>(null);
  const fatal = useRef(false);
  const loadVersion = useRef(0);
  const invalidateLoads = useCallback(() => {
    ++loadVersion.current;
  }, []);
  const adopt = useCallback((data: Snapshot) => {
    const owner = JSON.stringify([
      data.storage.workspaceId,
      data.teammate,
      data.capabilities,
    ]);
    if (cacheOwner.current && cacheOwner.current !== owner)
      cache.current.clear();
    cacheOwner.current = owner;
    setSnapshot(data);
  }, []);
  /** Stores an entry as most recently used; evicts the oldest beyond the limit. */
  const remember = useCallback((id: string, entry: Entry) => {
    cache.current.delete(id);
    cache.current.set(id, entry);
    for (const key of cache.current.keys()) {
      if (cache.current.size <= CACHE_LIMIT) break;
      if (key !== selectedRef.current) cache.current.delete(key);
    }
  }, []);
  /** Renders the selected conversation from its cache entry. */
  const show = useCallback((id: string) => {
    const entry = cache.current.get(id);
    setParts(ordered(entry));
    setHasOlder(!!entry?.older);
    setOlderState("idle");
  }, []);

  const report = useCallback(
    (reason: unknown) => {
      setError(
        reason instanceof Error ? reason.message : "Reconnect to continue.",
      );
      if (
        reason instanceof InboxError &&
        ([401, 403].includes(reason.status) ||
          reason.code === "FEATURE_DISABLED")
      ) {
        fatal.current = true;
        cache.current.clear();
        failed.current.clear();
        setSnapshot(undefined);
        setViewCounts([]);
        setPickedConversation(undefined);
        setParts([]);
        setPending([]);
        resetDrafts();
        ready.current = false;
        socket.current?.close();
        setConnection("Access unavailable");
      }
    },
    [resetDrafts],
  );
  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    try {
      const data = await api<Snapshot>("inbox");
      if (!fatal.current && version === loadVersion.current) adopt(data);
    } catch (e) {
      if (version === loadVersion.current) report(e);
    }
  }, [report, adopt]);

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
        adopt(data);
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
            retryDrafts();
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
            const entry: Entry = frame.reset
              ? { parts: new Map(), older: frame.older ?? null }
              : (cache.current.get(id) ?? { parts: new Map() });
            for (const p of frame.parts as Part[]) entry.parts.set(p.id, p);
            entry.cursor = frame.cursor;
            remember(id, entry);
            if (selectedRef.current === id) show(id);
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
  }, [
    load,
    report,
    retry,
    invalidateLoads,
    adopt,
    remember,
    show,
    retryDrafts,
  ]);

  useLayoutEffect(() => {
    const el = timelineRef.current;
    if (anchor.current && el) {
      el.scrollTop =
        anchor.current.top + el.scrollHeight - anchor.current.height;
      anchor.current = null;
    } else bottom.current?.scrollIntoView({ block: "nearest" });
    const m = measuring.current;
    if (m && m.id === selectedRef.current && parts.length) {
      measuring.current = null;
      requestAnimationFrame(() =>
        performance.measure("relay:first-screen", {
          start: m.start,
          end: performance.now(),
          detail: { cached: m.cached },
        }),
      );
    }
  }, [parts, pending]);
  async function loadOlder() {
    const id = selectedRef.current,
      entry = cache.current.get(id);
    if (!entry?.older || olderLoading.current) return;
    olderLoading.current = true;
    setOlderState("loading");
    try {
      const page = await api<{ parts: Part[]; older: string | null }>(
        "history?" +
          new URLSearchParams({ conversation: id, before: entry.older }),
      );
      // A reset or eviction replaced this entry meanwhile: drop the stale page.
      if (cache.current.get(id) !== entry) return;
      for (const p of page.parts) entry.parts.set(p.id, p);
      entry.older = page.older;
      if (selectedRef.current === id) {
        const el = timelineRef.current;
        if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
        show(id);
      }
    } catch (e) {
      if (e instanceof InboxError && e.code === "CURSOR_INVALID") {
        // The conversation was merged or rewritten: reopen from its newest parts.
        cache.current.delete(id);
        if (selectedRef.current === id) pick(id);
      } else setOlderState("error");
    } finally {
      olderLoading.current = false;
    }
  }
  // A first screen shorter than the pane cannot scroll; fetch older history directly.
  useEffect(() => {
    const el = timelineRef.current;
    if (
      hasOlder &&
      olderState === "idle" &&
      el &&
      el.scrollHeight <= el.clientHeight
    )
      void loadOlder();
  });
  /** Fetches a conversation's first screen after a short hover or focus, one at a time. */
  function prefetch(id: string) {
    clearTimeout(prefetchTimer.current);
    if (cache.current.has(id) || fatal.current) return;
    prefetchTimer.current = setTimeout(async () => {
      if (prefetching.current || cache.current.has(id)) return;
      prefetching.current = true;
      const owner = cacheOwner.current;
      try {
        const data = await api<FirstScreen>(
          "history?" + new URLSearchParams({ conversation: id }),
        );
        if (!cache.current.has(id) && owner === cacheOwner.current)
          remember(id, {
            parts: new Map(data.parts.map((p) => [p.id, p])),
            cursor: data.cursor,
            older: data.older,
          });
      } catch {
        // Prefetch is best effort; opening the conversation reports real errors.
      } finally {
        prefetching.current = false;
      }
    }, 100);
  }
  function pick(id: string) {
    if (ready.current && selectedRef.current)
      socket.current?.send(
        JSON.stringify({
          type: "unsubscribe",
          conversationId: selectedRef.current,
        }),
      );
    measuring.current = {
      id,
      start: performance.now(),
      cached: cache.current.has(id),
    };
    selectedRef.current = id;
    setSelected(id);
    show(id);
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
    // The teammate's own drafts for this conversation; failures leave the composer usable.
    void loadDrafts(id).catch(() => {});
  }
  const base =
    snapshot?.conversations.find((c) => c.id === selected) ??
    (pickedConversation?.id === selected ? pickedConversation : undefined);
  const conversation = base && { ...base, ...overrides[selected] };
  /** Runs a conversation command optimistically; a rejection reverts it and shows the error. */
  async function act(
    p: Record<string, unknown>,
    optimistic: Partial<Conversation> = {},
  ) {
    const id = String(p.conversationId ?? selectedRef.current);
    if (!id) return;
    setOverrides((o) => ({ ...o, [id]: { ...o[id], ...optimistic } }));
    setError("");
    try {
      await api("command", { ...p, conversationId: id });
      await load();
    } catch (e) {
      report(e);
    } finally {
      setOverrides((o) => {
        const next = { ...o };
        delete next[id];
        return next;
      });
    }
  }
  const snooze = (choice: SnoozeChoice, unassignOnWake: boolean) =>
    void act(
      {
        action: "snooze",
        ...choice,
        timezone: timeZone(),
        ...(unassignOnWake ? { unassignOnWake } : {}),
      },
      { status: "snoozed" },
    );
  const me = snapshot?.teammate.id ?? "";
  const focusComposer = (next: "reply" | "note") => {
    setMode(next);
    requestAnimationFrame(() => composer.current?.focus());
  };
  const move = (direction: 1 | -1) => {
    if (snapshot?.capabilities.views) {
      window.dispatchEvent(
        new CustomEvent("relay:navigate", { detail: direction }),
      );
      return;
    }
    const list = snapshot?.conversations ?? [];
    const at = list.findIndex((c) => c.id === selectedRef.current);
    const next = list[at < 0 ? 0 : at + direction];
    if (next) pick(next.id);
  };
  const focusSearch = () =>
    document
      .querySelector<HTMLInputElement>('[aria-label="Search within view"]')
      ?.focus();
  const commands: PaletteCommand[] = [
    ...(selected
      ? [
          {
            id: "close",
            group: "Conversation",
            label: "Close conversation",
            keys: "E",
            run: () => void act({ action: "close" }, { status: "closed" }),
          },
          {
            id: "reopen",
            group: "Conversation",
            label: "Reopen conversation",
            keys: "Shift E",
            run: () => void act({ action: "reopen" }, { status: "open" }),
          },
          {
            id: "snooze-later",
            group: "Snooze",
            label: "Snooze until later today",
            run: () => snooze({ preset: "later_today" }, false),
          },
          {
            id: "snooze-tomorrow",
            group: "Snooze",
            label: "Snooze until tomorrow 09:00",
            run: () => snooze({ preset: "tomorrow" }, false),
          },
          {
            id: "snooze-week",
            group: "Snooze",
            label: "Snooze until next Monday 09:00",
            run: () => snooze({ preset: "next_week" }, false),
          },
          {
            id: "snooze-custom",
            group: "Snooze",
            label: "Snooze until…",
            keys: "S",
            run: () => setOverlay("snooze"),
          },
          {
            id: "assign-me",
            group: "Assign",
            label: "Assign to me",
            keys: "A",
            run: () =>
              void act({ action: "assign", teammateId: me }, { assigned: me }),
          },
          {
            id: "unassign",
            group: "Assign",
            label: "Unassign",
            run: () =>
              void act({ action: "assign" }, { assigned: "", team_id: null }),
          },
          ...(snapshot?.teammates ?? [])
            .filter((t) => t.id !== me)
            .map((t) => ({
              id: "assign-" + t.id,
              group: "Assign",
              label: "Assign to " + t.name,
              run: () =>
                void act(
                  { action: "assign", teammateId: t.id },
                  { assigned: t.id },
                ),
            })),
          ...(snapshot?.teams ?? []).map((t) => ({
            id: "team-" + t.id,
            group: "Assign",
            label: "Assign to team " + t.name,
            run: () =>
              void act(
                { action: "assign", teamId: t.id },
                { assigned: "", team_id: t.id },
              ),
          })),
          ...(snapshot?.tags ?? []).map((t) => ({
            id: "tag-" + t.id,
            group: "Tag",
            label: "Add tag " + t.name,
            run: () => void act({ action: "tag_add", tagId: t.id }),
          })),
          {
            id: "priority",
            group: "Conversation",
            label: "Toggle priority",
            keys: "P",
            run: () =>
              void act(
                { action: "priority", value: !conversation?.priority },
                { priority: !conversation?.priority },
              ),
          },
          {
            id: "reply",
            group: "Compose",
            label: "Reply",
            keys: "R",
            run: () => focusComposer("reply"),
          },
          {
            id: "note",
            group: "Compose",
            label: "Internal note",
            keys: "N",
            run: () => focusComposer("note"),
          },
        ]
      : []),
    // TODO(phase 4 step D): macros join the palette here, with their own permissions.
    ...viewList.map((v) => ({
      id: "view-" + v.id,
      group: "Go to view",
      label: v.name,
      run: () =>
        window.dispatchEvent(new CustomEvent("relay:view", { detail: v.id })),
    })),
    {
      id: "search",
      group: "Navigate",
      label: "Search this view",
      keys: "/",
      run: focusSearch,
    },
    {
      id: "shortcuts",
      group: "Help",
      label: "Keyboard shortcuts",
      keys: "?",
      run: () => setOverlay("shortcuts"),
    },
  ];
  // The listener is registered once; it always calls the latest handler.
  useEffect(() => {
    keyHandler.current = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOverlay((o) => (o === "palette" ? null : "palette"));
        return;
      }
      if (overlay || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      const run = (f: () => void) => {
        e.preventDefault();
        f();
      };
      if (key === "j") run(() => move(1));
      else if (key === "k") run(() => move(-1));
      else if (key === "/") run(focusSearch);
      else if (key === "?") run(() => setOverlay("shortcuts"));
      else if (!selectedRef.current) return;
      else if (key === "r") run(() => focusComposer("reply"));
      else if (key === "n") run(() => focusComposer("note"));
      else if (key === "e")
        run(() => void act({ action: "close" }, { status: "closed" }));
      else if (key === "E")
        run(() => void act({ action: "reopen" }, { status: "open" }));
      else if (key === "s") run(() => setOverlay("snooze"));
      else if (key === "a")
        run(
          () =>
            void act({ action: "assign", teammateId: me }, { assigned: me }),
        );
      else if (key === "p")
        run(
          () =>
            void act(
              { action: "priority", value: !conversation?.priority },
              { priority: !conversation?.priority },
            ),
        );
    };
  });
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const draftKey = drafts.keyOf(selected, mode);
  const draft = drafts.drafts[draftKey];
  async function send() {
    const doc = draft?.doc;
    if (!selected || !doc || pending.some((p) => p.conversationId === selected))
      return;
    const body = plainText(doc);
    const previous = failed.current.get(draftKey);
    // A retry of the same text reuses its key, so the server applies it once.
    const item: Pending =
      previous?.body === body
        ? previous
        : {
            id: crypto.randomUUID(),
            conversationId: selected,
            mode,
            body,
            doc,
          };
    const key = draftKey;
    failed.current.set(key, item);
    setPending((items) => [...items, item]);
    drafts.sent(item.conversationId, item.mode);
    reseed(key);
    setError("");
    try {
      const result = await api<{ partId: string }>(
        "command",
        {
          action: item.mode,
          conversationId: item.conversationId,
          doc: item.doc,
        },
        item.id,
      );
      failed.current.delete(key);
      // Keep the pending row until its committed part arrives over replay.
      if (cache.current.get(item.conversationId)?.parts.has(result.partId))
        setPending((items) => items.filter((p) => p.id !== item.id));
    } catch (e) {
      setPending((items) => items.filter((p) => p.id !== item.id));
      // Put the text back in the composer and let autosave keep it.
      drafts.edit(item.conversationId, item.mode, item.doc);
      reseed(key);
      report(e);
    }
  }
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
        <button className="pg-nav-help" onClick={() => setOverlay("shortcuts")}>
          <Keyboard size={15} /> Shortcuts <kbd>?</kbd>
        </button>
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
                onPrefetch={prefetch}
                onViews={setViewList}
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
                    onMouseEnter={() => prefetch(c.id)}
                    onFocus={() => prefetch(c.id)}
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
                  <div
                    className="pg-thread-actions"
                    role="toolbar"
                    aria-label="Conversation actions"
                  >
                    <span className="pg-state" data-testid="conversation-state">
                      {conversation?.status ?? "open"}
                      {conversation?.priority ? " · priority" : ""}
                      {conversation?.assigned
                        ? " · " +
                          (conversation.assigned === me
                            ? "you"
                            : (snapshot?.teammates.find(
                                (t) => t.id === conversation.assigned,
                              )?.name ?? "assigned"))
                        : ""}
                    </span>
                    {conversation?.status === "open" ? (
                      <button
                        title="Close (E)"
                        onClick={() =>
                          void act({ action: "close" }, { status: "closed" })
                        }
                      >
                        <CheckCircle size={14} /> Close
                      </button>
                    ) : (
                      <button
                        title="Reopen (Shift E)"
                        onClick={() =>
                          void act({ action: "reopen" }, { status: "open" })
                        }
                      >
                        <RotateCcw size={14} /> Reopen
                      </button>
                    )}
                    <button
                      title="Snooze (S)"
                      onClick={() => setOverlay("snooze")}
                    >
                      <Clock size={14} /> Snooze
                    </button>
                    {conversation?.assigned !== me && (
                      <button
                        title="Assign to me (A)"
                        onClick={() =>
                          void act(
                            { action: "assign", teammateId: me },
                            { assigned: me },
                          )
                        }
                      >
                        <UserPlus size={14} /> Assign to me
                      </button>
                    )}
                    <button
                      title="Toggle priority (P)"
                      aria-pressed={!!conversation?.priority}
                      onClick={() =>
                        void act(
                          {
                            action: "priority",
                            value: !conversation?.priority,
                          },
                          { priority: !conversation?.priority },
                        )
                      }
                    >
                      <Flag size={14} /> Priority
                    </button>
                  </div>
                </header>
                <div
                  className="pg-timeline"
                  role="log"
                  aria-label="Messages"
                  ref={timelineRef}
                  onScroll={(e) => {
                    if (
                      e.currentTarget.scrollTop < 200 &&
                      olderState === "idle"
                    )
                      void loadOlder();
                  }}
                >
                  {hasOlder && (
                    <div className="pg-older">
                      {olderState === "error" ? (
                        <>
                          <span role="alert">
                            Older messages could not be loaded.
                          </span>
                          <button onClick={() => void loadOlder()}>
                            Retry
                          </button>
                        </>
                      ) : olderState === "loading" ? (
                        <span>Loading older messages…</span>
                      ) : (
                        <button onClick={() => void loadOlder()}>
                          Load older messages
                        </button>
                      )}
                    </div>
                  )}
                  <Timeline
                    parts={parts}
                    dir={{
                      teammates: snapshot?.teammates ?? [],
                      teams: snapshot?.teams ?? [],
                      tags: snapshot?.tags ?? [],
                    }}
                  />
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
                  <Suspense
                    fallback={
                      <div className="pg-editor-shell" aria-busy="true">
                        Loading editor…
                      </div>
                    }
                  >
                    <Composer
                      handleRef={composer}
                      label={
                        mode === "note" ? "Internal note" : "Reply message"
                      }
                      placeholder={
                        mode === "note"
                          ? "Leave a private note for your team…"
                          : "Write a reply…"
                      }
                      value={{
                        key: draftKey + ":" + (seeds[draftKey] ?? 0),
                        doc: draft?.doc ?? null,
                      }}
                      disabled={!canSend}
                      onChange={(doc) => drafts.edit(selected, mode, doc)}
                      onSubmit={() => void send()}
                    />
                  </Suspense>
                  {draft?.status === "conflict" && (
                    <div className="pg-draft-conflict" role="alert">
                      This draft changed in another tab or device.
                      <button
                        type="button"
                        onClick={() => drafts.resolve(draftKey, "mine")}
                      >
                        Keep mine
                      </button>
                      <button
                        type="button"
                        onClick={() => drafts.resolve(draftKey, "theirs")}
                      >
                        Use the other version
                      </button>
                    </div>
                  )}
                  <footer>
                    <span>
                      {!canSend
                        ? "Your role cannot perform this action."
                        : mode === "note"
                          ? "Private to your team"
                          : "Messenger"}
                    </span>
                    <small className="pg-draft-status" aria-live="polite">
                      {draft?.status === "saving"
                        ? "Saving draft…"
                        : draft?.status === "saved"
                          ? "Draft saved"
                          : draft?.status === "offline"
                            ? "Offline: draft kept in this tab, retrying"
                            : ""}
                    </small>
                    <button
                      type="submit"
                      disabled={
                        !canSend ||
                        !draft?.doc ||
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
      {overlay === "palette" && (
        <CommandPalette commands={commands} onClose={() => setOverlay(null)} />
      )}
      {overlay === "shortcuts" && (
        <ShortcutSheet onClose={() => setOverlay(null)} />
      )}
      {overlay === "snooze" && selected && (
        <SnoozeMenu onSnooze={snooze} onClose={() => setOverlay(null)} />
      )}
    </main>
  );
}
