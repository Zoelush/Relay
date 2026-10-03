import React, { useEffect, useRef, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { language } from "./strings";
import { HelpSpace } from "./help";
import { RichText } from "../lib/rich-view";
import { palette, paletteVariables } from "../lib/brand-colours";
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
type Audience = {
  /** Messenger M3: what this audience may start and reply to (enforced by the server too). */
  inbound?: {
    oneConversation: boolean;
    talkAfterUnhelpful: boolean;
    blockClosedReplies: boolean;
    blockClosedTicketReplies: boolean;
  };
  spaces: ("home" | "messages" | "help" | "tickets")[];
  launchToConversation: boolean;
  startButton: "send" | "ask" | "chat" | "start" | "contact" | "support";
};
type Messenger3 = {
  audiences: { visitors: Audience; users: Audience };
  home: {
    id: string;
    type: "start" | "search" | "recent" | "link" | "announcement" | "tickets";
    audience: "everyone" | "visitors" | "users";
    title?: string;
    body?: string;
    url?: string;
  }[];
  welcome: Record<string, { greeting: string; intro: string }>;
  notice: { enabled: boolean; text: Record<string, string> };
  /** Messenger settings M2: Home's background, the dark-theme colour and teammates. */
  look?: {
    darkColor: string | null;
    header: {
      background: "none" | "solid" | "gradient" | "image";
      colors: string[];
      image: string;
      text: "light" | "dark";
      fade: boolean;
    };
    showTeammates: boolean;
  };
  team?: { firstName: string; initials: string }[];
  /** Messenger M3: the reply sound's default and the privacy notice. */
  general?: {
    soundDefault: boolean;
    privacy: { enabled: boolean; url: string; text: Record<string, string> };
  };
};
/** Home's welcome background, as CSS (only an https image is ever used). */
/** An image address the messenger shows: https, or an upload Relay serves (messenger M5). */
const imageAddress = (value: string | undefined, api: string) =>
  !!value && (/^https:\/\//.test(value) || value.startsWith(api + "/"));
function heroBackground(
  h: NonNullable<Messenger3["look"]>["header"],
  api: string,
) {
  if (h.background === "solid") return h.colors[0];
  if (h.background === "gradient")
    return `linear-gradient(135deg, ${h.colors.join(", ")})`;
  if (h.background === "image" && imageAddress(h.image, api))
    return `center / cover no-repeat url(${JSON.stringify(h.image)})`;
  return undefined;
}
/** A text for the customer's language: theirs, its base, the brand's, then any. */
function localized<T>(
  texts: Record<string, T>,
  locale: string,
  brandLocale = "en",
): T | undefined {
  for (const l of [
    locale,
    locale.split("-")[0],
    brandLocale,
    brandLocale.split("-")[0],
  ])
    if (texts[l] !== undefined) return texts[l];
  return Object.values(texts)[0];
}
const START_LABEL = {
  send: "startSend",
  ask: "startAsk",
  chat: "startChat",
  start: "startStart",
  contact: "startContact",
  support: "startSupport",
} as const;
type Boot = {
  token: string;
  locale: string;
  session: { workspace: string; verified: boolean };
  brand: {
    id: string;
    name: string;
    locale?: string;
    theme?: string;
    color?: string;
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
    /** Messenger settings M1: audiences, Home cards, welcome and notice (when published). */
    messenger3?: Messenger3;
  };
  /** A verified customer's first name, for the welcome greeting. */
  profile?: { firstName?: string };
  capabilities: Record<string, boolean>;
  /** From the calendar that applies; null when none does (then no hours line is shown). */
  availability?: { open: boolean; nextOpenLabel?: string } | null;
  replyTime?: { band: string } | { text: string } | null;
  realtime?: { url: string; ticket: string };
};
type Strings = ReturnType<typeof language>["strings"];
/** The expected reply time in words: a measured band, or the brand's own phrase. */
function replyTime(t: Strings, r: Boot["replyTime"]) {
  if (!r) return "";
  if ("text" in r) return r.text;
  return (
    (
      {
        few_minutes: t.replyFewMinutes,
        under_an_hour: t.replyUnderHour,
        few_hours: t.replyFewHours,
        about_a_day: t.replyDay,
      } as Record<string, string>
    )[r.band] ?? ""
  );
}
/** "You're 3rd in line" (English ordinals), or the locale's own wording with the number. */
function inLine(t: Strings, locale: string, n: number) {
  if (!locale.startsWith("en"))
    return t.queue.replace("{n}", n.toLocaleString(locale));
  const suffix = { one: "st", two: "nd", few: "rd", other: "th" }[
    new Intl.PluralRules("en", { type: "ordinal" }).select(n) as
      "one" | "two" | "few" | "other"
  ];
  return t.queue.replace("{n}", `${n}${suffix}`);
}
type Init = {
  boot: Boot;
  api: string;
  open: boolean;
  /** Settings' live preview (messenger M2): nothing is sent or fetched. */
  preview?: boolean;
  /** The preview's chosen space (messenger M4); ignored outside the preview. */
  page?: string;
};
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
function Messenger({ boot, api, open: initialOpen, preview, page }: Init) {
  const { strings: t, locale, dir } = language(boot.locale, boot.brand.locale);
  // Messenger settings M1: what this customer's audience (visitor or verified user) sees.
  const m3 = boot.brand.messenger3;
  const audience = boot.session.verified ? "users" : "visitors";
  const aud = m3?.audiences[audience];
  const direct = aud
    ? aud.launchToConversation
    : !!boot.brand.directConversation;
  const shown = preview && page ? page : null;
  const [space, setSpace] = useState<string>(
      shown ?? (direct ? "messages" : "home"),
    ),
    [composing, setComposing] = useState(direct),
    // Phase 07 B2: the last search's signed receipt ("search before contacting"), and the
    // article a "Talk to us" came from.
    [receipt, setReceipt] = useState<string | null>(null),
    [helpTalk, setHelpTalk] = useState<{
      articleId: string;
      feedbackId: string;
    } | null>(null),
    [conversations, setConversations] = useState<Conversation[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [parts, setParts] = useState<Part[]>([]),
    [draft, setDraft] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [canRetry, setCanRetry] = useState(false),
    [connected, setConnected] = useState(false),
    [typing, setTyping] = useState(false),
    [sounds, setSounds] = useState(
      !!boot.brand.messenger3?.general?.soundDefault,
    ),
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
      // The preview fetches nothing: an example conversation, and otherwise no answer.
      if (preview)
        return (
          path === "conversations"
            ? {
                conversations: [
                  {
                    id: "preview",
                    title: "Where is my order?",
                    status: "open",
                  },
                ],
              }
            : new Promise<never>(() => {})
        ) as T;
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
    [api, boot.token, t.error, preview],
  );
  /**
   * Opens the customer portal in a new tab with a one-time, 60-second code (verified customers
   * only). The tab opens first, inside the click, so pop-up blockers allow it.
   */
  async function openPortal() {
    if (preview) return;
    const tab = window.open("", "_blank");
    try {
      const { url } = await request<{ url: string }>("portal-handoff", {});
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      tab?.close();
    }
  }
  /** Waiting details per conversation, from each timeline frame (pushed when the line moves). */
  const [waiting, setWaiting] = useState<
    Record<
      string,
      {
        queue: { position: number } | null;
        availability: { open: boolean; nextOpenLabel?: string } | null;
      }
    >
  >({});
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
  // The brand's colours, light and dark (messenger M2), from the boot: a draft shows at once. Text
  // on them, and links in them, are worked out to stay readable (M4, lib/brand-colours.ts).
  const brandColor = String(boot.brand.color ?? "");
  const darkColor = boot.brand.messenger3?.look?.darkColor ?? null;
  useEffect(() => {
    for (const [name, value] of Object.entries(
      paletteVariables(palette(brandColor, darkColor)),
    ))
      document.documentElement.style.setProperty(name, value);
  }, [brandColor, darkColor]);
  // Settings' preview follows the page chosen beside it (M4).
  const [lastShown, setLastShown] = useState(shown);
  if (shown !== lastShown) {
    setLastShown(shown);
    if (shown) setSpace(shown);
  }
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
    document.documentElement.dataset.theme = boot.brand.theme ?? "auto";
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
        if (["home", "messages", "help", "tickets"].includes(data.space))
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
            if (data.waiting)
              setWaiting((w) => ({
                ...w,
                [data.conversationId]: data.waiting,
              }));
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
  /** Sends the draft, or `option` (a clarifying question's choice, phase 08). */
  async function submit(
    event?: React.FormEvent,
    retry = false,
    option?: string,
  ) {
    event?.preventDefault();
    if (preview) return;
    if (busy) return;
    const text = (option ?? draft).trim();
    if (!retry && !text) return;
    setBusy(true);
    setError("");
    if (!retry)
      pending.current = {
        body: {
          action: selected ? "reply" : "start",
          conversationId: selected ?? undefined,
          text,
          ...(selected
            ? {}
            : {
                searchReceipt: receipt ?? undefined,
                helpArticleId: helpTalk?.articleId,
                helpFeedbackId: helpTalk?.feedbackId,
              }),
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
      if (!option) setDraft("");
      setHelpTalk(null);
      if (result.conversationId !== selected) select(result.conversationId);
      await refreshList();
    } catch (e) {
      setCanRetry(true);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  /** The customer says an AI answer helped (phase 08 A3): recorded once, thanked by the agent. */
  async function helped(partId: string) {
    if (!selected || preview) return;
    setBusy(true);
    setError("");
    try {
      await request(
        "command",
        { action: "ai_helped", conversationId: selected, partId },
        crypto.randomUUID(),
      );
    } catch (e) {
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
    (!boot.brand.requireSearch || !!receipt || !!helpTalk);
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
  // Messenger M3: with one conversation at a time, an open one is continued instead.
  const openOne = aud?.inbound?.oneConversation
    ? conversations.find((c) => c.status !== "closed")
    : undefined;
  const startLabel = openOne
    ? t.continueConversation
    : aud
      ? t[START_LABEL[aud.startButton]]
      : t.start;
  const privacy = m3?.general?.privacy;
  const privacyText =
    privacy?.enabled && /^https:\/\//.test(privacy.url)
      ? localized(privacy.text, boot.locale, boot.brand.locale)
      : undefined;
  const privacyNotice = privacyText ? (
    <p className="privacy">
      {privacyText}{" "}
      <a href={privacy!.url} target="_blank" rel="noopener noreferrer">
        {t.privacyLink}
      </a>
    </p>
  ) : null;
  const selectedConversation = conversations.find((c) => c.id === selected);
  // No replies to a closed conversation, when the messenger says so (tickets: the server says).
  const closedForReplies =
    !!selectedConversation &&
    selectedConversation.status === "closed" &&
    !!aud?.inbound?.blockClosedReplies;
  const look = m3?.look;
  const hero = look ? heroBackground(look.header, api) : undefined;
  const welcome = m3 && localized(m3.welcome, boot.locale, boot.brand.locale);
  // "{first_name}" becomes the verified customer's first name, or is left out.
  const greeting = welcome?.greeting
    .replace(/\{first_name\}/g, boot.profile?.firstName ?? "")
    .replace(/\s+([,!.?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  const notice =
    m3?.notice.enabled &&
    localized(m3.notice.text, boot.locale, boot.brand.locale);
  const noticeBanner = notice ? (
    <p className="notice" role="note" aria-label={t.notice}>
      {notice}
    </p>
  ) : null;
  const spaces = (
    aud?.spaces ?? (["home", "messages", "help"] as const)
  ).filter((s) => s !== "tickets" || boot.capabilities.tickets);
  const ticketsCard = (
    <button className="card" onClick={() => void openPortal()}>
      {t.yourTickets}
    </button>
  );
  const start = () =>
    mayStart ? (
      <button
        className="primary start"
        onClick={() => select(openOne ? openOne.id : null)}
      >
        {startLabel}
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
          {imageAddress(boot.brand.logo, api) && (
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
            {noticeBanner}
            <div
              className={"intro" + (hero ? " hero" : "")}
              style={hero ? { background: hero } : undefined}
              data-text={look?.header.text}
              data-fade={look?.header.fade ? "true" : undefined}
            >
              {look?.showTeammates && !!m3?.team?.length && (
                <ul className="team" aria-label={t.team}>
                  {m3.team.map((p, i) => (
                    <li key={i} title={p.firstName}>
                      {p.initials}
                    </li>
                  ))}
                </ul>
              )}
              <span className="eyebrow">{boot.brand.teamIntroduction}</span>
              <h1>{greeting || t.welcome}</h1>
              {welcome?.intro && (
                <p className="welcome-intro">{welcome.intro}</p>
              )}
              {boot.availability && (
                <p>
                  {boot.availability.open
                    ? t.open
                    : boot.brand.outOfHours || t.away}
                </p>
              )}
              {boot.availability?.open && replyTime(t, boot.replyTime) && (
                <small data-testid="reply-time">
                  {replyTime(t, boot.replyTime)}
                </small>
              )}
              {boot.availability &&
                !boot.availability.open &&
                boot.availability.nextOpenLabel && (
                  <small data-testid="next-open">
                    {t.replyFrom} {boot.availability.nextOpenLabel}
                  </small>
                )}
            </div>
            {!m3 && boot.capabilities.tickets && (
              <section>{ticketsCard}</section>
            )}
            {m3 &&
              m3.home
                .filter(
                  (c) => c.audience === "everyone" || c.audience === audience,
                )
                .map((c) => (
                  <section key={c.id}>
                    {c.type === "start" ? (
                      start()
                    ) : c.type === "recent" ? (
                      <>
                        <h2>{t.recent}</h2>
                        {rows(3)}
                      </>
                    ) : c.type === "search" ? (
                      <button className="card" onClick={() => setSpace("help")}>
                        {t.searchHelp}
                      </button>
                    ) : c.type === "tickets" ? (
                      boot.capabilities.tickets ? (
                        ticketsCard
                      ) : null
                    ) : c.type === "announcement" ? (
                      <article className="card">
                        <h2>{c.title}</h2>
                        {c.body && <p>{c.body}</p>}
                      </article>
                    ) : c.type === "link" && /^https:\/\//.test(c.url ?? "") ? (
                      <a
                        className="card"
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <h2>{c.title}</h2>
                        {c.body && <p>{c.body}</p>}
                      </a>
                    ) : null}
                  </section>
                ))}
            {!m3 &&
              (
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
        {space === "tickets" && (
          <div className="help">
            <h1>{t.tickets}</h1>
            {boot.capabilities.tickets ? ticketsCard : <p>{t.portalSignIn}</p>}
          </div>
        )}
        {space === "messages" &&
          (selected === null && !composing ? (
            <div className="messages-index">
              <h1>{t.messages}</h1>
              {noticeBanner}
              {rows()}
              {openOne ? (
                <button className="primary" onClick={() => select(openOne.id)}>
                  {t.continueConversation}
                </button>
              ) : (
                <form onSubmit={(e) => void submit(e)}>
                  {privacyNotice}
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
              )}
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
              {selected && waiting[selected]?.queue && (
                <p className="queue" role="status" data-testid="queue-position">
                  {inLine(t, locale, waiting[selected]!.queue!.position)}
                </p>
              )}
              {selected &&
                waiting[selected]?.availability &&
                !waiting[selected]!.availability!.open &&
                waiting[selected]!.availability!.nextOpenLabel && (
                  <p className="queue" data-testid="team-next-open">
                    {t.replyFrom}{" "}
                    {waiting[selected]!.availability!.nextOpenLabel}
                  </p>
                )}
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
                  .map((p, _i, shown) => {
                    const lastPartId = shown.at(-1)?.id;
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
                              : p.kind === "system_event" &&
                                  p.data.event === "ticket_status"
                                ? `${t.ticket} #${String(p.data.number)} (${String(p.data.typeName)}): ${String(p.data.label)}`
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
                        {p.kind === "ai_reply" &&
                          Array.isArray(p.data.sources) &&
                          p.data.sources.length > 0 && (
                            // The AI agent's sources (phase 08): articles open in the help center.
                            <ul className="sources" aria-label={t.sources}>
                              {(
                                p.data.sources as {
                                  title: string;
                                  path?: string;
                                }[]
                              ).map((s, i) => (
                                <li key={i}>
                                  {s.path ? (
                                    <a
                                      href={new URL(s.path, api).href}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    >
                                      {s.title}
                                    </a>
                                  ) : (
                                    s.title
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        {p.kind === "ai_reply" &&
                          p.id === lastPartId &&
                          Array.isArray(p.data.options) &&
                          p.data.options.length > 0 && (
                            // A clarifying question's choices, sent as the customer's reply.
                            <div className="options">
                              {(p.data.options as string[]).map((o) => (
                                <button
                                  key={o}
                                  type="button"
                                  disabled={busy}
                                  onClick={() =>
                                    void submit(undefined, false, o)
                                  }
                                >
                                  {o}
                                </button>
                              ))}
                            </div>
                          )}
                        {p.kind === "ai_reply" &&
                          p.id === lastPartId &&
                          !!p.data.confirm && (
                            // An answer from content (phase 08 A3): it helped (a resolution), or a person.
                            <div
                              className="options"
                              role="group"
                              aria-label={String(
                                (p.data.confirm as { helped?: string }).helped ?? "",
                              )}
                            >
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void helped(p.id)}
                              >
                                👍{" "}
                                {String((p.data.confirm as { helped?: string }).helped)}
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void submit(
                                    undefined,
                                    false,
                                    String((p.data.confirm as { person?: string }).person),
                                  )
                                }
                              >
                                {String((p.data.confirm as { person?: string }).person)}
                              </button>
                            </div>
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
              {selected === null && privacyNotice}
              {closedForReplies ? (
                <div className="closed-note" role="status">
                  <p>{t.closedNoReply}</p>
                  {mayStart && (
                    <button className="primary" onClick={() => select(null)}>
                      {startLabel === t.continueConversation
                        ? t.start
                        : startLabel}
                    </button>
                  )}
                </div>
              ) : (
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
                          if (e.target.files?.[0])
                            void upload(e.target.files[0]);
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
              )}
            </div>
          ))}
        {space === "help" && (
          <div className="help">
            <h1>{t.help}</h1>
            {boot.capabilities.help ? (
              <HelpSpace
                request={request}
                api={api}
                t={t}
                onSearched={setReceipt}
                onTalk={
                  aud?.inbound && !aud.inbound.talkAfterUnhelpful
                    ? undefined
                    : ({ comment, ...context }) => {
                        setHelpTalk(context);
                        // What they told us they were looking for starts their message.
                        if (comment) setDraft(comment);
                        setSpace("messages");
                        select(openOne ? openOne.id : null);
                      }
                }
              />
            ) : (
              <p>{t.unavailable}</p>
            )}
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
        {spaces.map((s) => (
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
              {s === "home"
                ? "⌂"
                : s === "messages"
                  ? "▤"
                  : s === "tickets"
                    ? "▣"
                    : "⌕"}
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
  root.render(
    <Messenger
      key={event.data.boot.token}
      {...event.data}
      preview={query.get("preview") === "1"}
    />,
  );
});
sendParent("ready");
