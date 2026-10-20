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
  Bell,
  PanelRight,
  BookOpen,
  MoreHorizontal,
  FileText,
  Command,
  Ticket,
  Zap,
  Sparkles,
  Workflow,
  ChartColumnBig,
  Contact,
  Settings as SettingsIcon,
} from "lucide-react";
import "../../agent/inbox.css";
import { useAgentTheme } from "../../agent/theme";
import { AccountMenu } from "../../agent/account-menu";
import { api, InboxError } from "../../agent/api";
import { InboxViews, type ViewCount } from "../../agent/views";
import { activeTags, Timeline, type Directory } from "../../agent/timeline";
import type { ComposerHandle } from "../../agent/composer";
import { useDrafts } from "../../agent/use-drafts";
import { NotificationsPanel } from "../../agent/notifications";
import { CreateInternal, requestConvert } from "../../agent/tickets";
import { Menu } from "../../agent/menu";
import { exportConversation } from "../../agent/export";
import { WorkloadBar } from "../../agent/workload";
import { ListHeader, Rail, useSideMenu } from "../../agent/shell";
import { ConversationCard, initials } from "../../agent/card";
import { AgentName, hueOf } from "../../agent/colour";
import { alertTeammate, type AlertPrefs } from "../../agent/alerts";
import { SlaBadge } from "../../agent/sla";
import type { MessagePreview } from "../../server/conversations";
import { ContextSidebar } from "../../agent/sidebar";
import { EmailCopies, ReplyTarget, SmsMeter, splitCopies, TemplatePicker, useReplyTarget, type Copies } from "../../agent/reply-target";
import { SideConversationButton } from "../../agent/side-conversations";
import {
  MacroManager,
  MacroPicker,
  type Macro,
  type MacroList,
} from "../../agent/macros";
import {
  useTeammateActivity,
  useWritingSignal,
  describeActivity,
  VIEWING_REFRESH_MS,
} from "../../agent/activity";
import { plainText, imageIds, type RichDoc } from "../../lib/rich-doc";
import {
  imageProblem,
  startImageUpload,
  type ImageStatus,
} from "../../agent/images";
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
  unread?: boolean;
  activity_at?: string;
  updated_at?: string;
  sla_next_due_at?: string | null;
  sla_overdue?: boolean;
  /** Z3a: the specialist who has it, if one does. */
  ai_specialist_id?: string | null;
  preview?: MessagePreview | null;
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
  /** The account menu: the teammate's role and the workspace's name. */
  account?: { role: string; workspace: { id: string; name: string } };
  storage: { engine: string; transport: string; workspaceId: string };
  capabilities: {
    reply: boolean;
    note: boolean;
    manage?: boolean;
    macros?: boolean;
    views?: boolean;
    knowledge?: boolean;
    settings?: boolean;
    /** Zoe's own area (phase 08 Z1): managers, while the AI agent is on. */
    zoe?: boolean;
    /** The Workflows area (phase 11 W2): managers, while workflows are on. */
    workflows?: boolean;
    /** The People area (phase 13 O1): who may see people's details, while segments are on. */
    people?: boolean;
    /** The Outbound area (phase 13 O3): managers, while outbound is on. */
    outbound?: boolean;
    /** The Reports area (phase 14 R3): who may view reports, while reporting is on. */
    reports?: boolean;
    /** The live dashboard (phase 14 R4): who may view reports; it needs no reporting store. */
    live?: boolean;
  };
  /** Zoe's name in this workspace, while the AI agent is on (Z1). */
  ai?: { name: string; enabled: boolean } | null;
  /** Your preferences (Settings › Your profile and Notifications). */
  profile?: { signature: string; notifications: AlertPrefs };
};
/** The rich editor is its own chunk (about 130 KB gzip), so the list and timeline load first. */
const Composer = lazy(() =>
  import("../../agent/composer").then((m) => ({ default: m.Composer })),
);
/** Knowledge (phase 07) loads with its own article editor, only when opened. */
const Knowledge = lazy(() =>
  import("../../agent/knowledge").then((m) => ({ default: m.Knowledge })),
);
/** Settings load on their own, only when opened. */
const Settings = lazy(() =>
  import("../../agent/settings").then((m) => ({ default: m.Settings })),
);
/** Zoe, the AI agent (phase 08 Z1), loads on her own when opened. */
const Zoe = lazy(() =>
  import("../../agent/zoe").then((m) => ({ default: m.Zoe })),
);
/** Workflows (phase 11 W2) load on their own; the canvas loads when one opens. */
const Workflows = lazy(() =>
  import("../../agent/workflows").then((m) => ({ default: m.Workflows })),
);
/** The Workflows area from the address: `#workflows` ("") or `#workflows/<id>`; null elsewhere. */
const workflowsFromHash = () => {
  if (typeof window === "undefined") return null;
  const m = /^#workflows(?:\/([A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)?))?$/.exec(window.location.hash);
  return m ? (m[1] ?? "") : null;
};
/** People (phase 13 O1): contacts and segments, loaded on their own. */
const People = lazy(() =>
  import("../../agent/people").then((m) => ({ default: m.People })),
);
/** The People area from the address: `#people` ("") or `#people/<segment>`; null elsewhere. */
const peopleFromHash = () => {
  if (typeof window === "undefined") return null;
  const m = /^#people(?:\/([A-Za-z0-9-]+))?$/.exec(window.location.hash);
  return m ? (m[1] ?? "") : null;
};
/** Outbound (phase 13 O3): messages to send, loaded on their own. */
const OutboundArea = lazy(() =>
  import("../../agent/outbound").then((m) => ({ default: m.Outbound })),
);
/** The Outbound area from the address: `#outbound` (""), `#outbound/<view>` or `#outbound/m/<id>`; null elsewhere. */
const outboundFromHash = () => {
  if (typeof window === "undefined") return null;
  const m = /^#outbound(?:\/((?:m\/)?[A-Za-z0-9-]+))?$/.exec(window.location.hash);
  return m ? (m[1] ?? "") : null;
};
/** Reports (phase 14 R3): the overview and the pre-built reports, loaded on their own. */
const ReportsArea = lazy(() =>
  import("../../agent/reports").then((m) => ({ default: m.Reports })),
);
/** The Reports area from the address: `#reports` ("") or `#reports/<report>`; null elsewhere. */
const reportsFromHash = () => {
  if (typeof window === "undefined") return null;
  const m = /^#reports(?:\/([a-z_]+))?$/.exec(window.location.hash);
  return m ? (m[1] ?? "") : null;
};
/** A page of Zoe's from the address (`#zoe/<page>`), or null when not in her area. */
const zoeFromHash = () => {
  if (typeof window === "undefined") return null;
  const m = /^#zoe(?:\/([a-z-]+))?$/.exec(window.location.hash);
  return m ? (m[1] ?? "overview") : null;
};
/** Phase 09 D4: the app was loaded by a service sending a manager back from connecting a connector. */
const oauthReturn = () =>
  typeof window !== "undefined" &&
  !!new URLSearchParams(window.location.search).get("state")?.startsWith("relay_");
/** A settings page from the address (`#settings/<page>`), or null when not in Settings. */
const settingsFromHash = () => {
  if (typeof window === "undefined") return null;
  const m = /^#settings(?:\/([a-z-]+))?$/.exec(window.location.hash);
  return m ? (m[1] ?? "home") : null;
};
/** Your signature, as paragraphs after a reply (never a note). */
function withSignature(doc: RichDoc, signature: string): RichDoc {
  if (!signature.trim()) return doc;
  return {
    ...doc,
    content: [
      ...doc.content,
      ...signature.split("\n").map((line) => ({
        type: "paragraph" as const,
        ...(line.trim()
          ? { content: [{ type: "text" as const, text: line }] }
          : {}),
      })),
    ],
  };
}
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
  /** Phase 12 E4: copies on an email reply. */
  email?: { cc: string[]; bcc: string[] };
};

/**
 * Authenticated core inbox. A conversation opens on its newest parts (from cache when warm),
 * older history loads on scroll, and live replay resumes from the cached cursor.
 */
/**
 * `hosting`: what the hosting sign-in knows that Relay does not keep: the teammate's email, and
 * where signing out goes. The local relay has neither.
 */
export default function PostgresInbox({
  hosting = {},
}: {
  hosting?: { email?: string; signOutHref?: string };
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [selected, setSelected] = useState("");
  const [parts, setParts] = useState<Part[]>([]);
  // Phase 12 E3: where a reply goes, on a conversation that isn't on the messenger.
  const replyTarget = useReplyTarget(selected, parts.length);
  // E4: Cc and Bcc on an email reply (read when it's sent; the fields start from the target's).
  const copies = useRef<Copies>({ cc: "", bcc: "" });
  const keepCopies = useCallback((c: Copies) => {
    copies.current = c;
  }, []);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  // Bumped per draft key when the composer must reload content (restore, conflict, send).
  const [seeds, setSeeds] = useState<Record<string, number>>({});
  const reseed = useCallback(
    (key: string) => setSeeds((s) => ({ ...s, [key]: (s[key] ?? 0) + 1 })),
    [],
  );
  const drafts = useDrafts(reseed);
  // Inline image uploads in this tab: status by attachment id, and scan job -> attachment id.
  const [imageStates, setImageStates] = useState<Record<string, ImageStatus>>(
    {},
  );
  const [imageError, setImageError] = useState("");
  const scanJobs = useRef(new Map<string, string>());
  const setImage = useCallback(
    (id: string, status: ImageStatus) =>
      setImageStates((s) => ({ ...s, [id]: status })),
    [],
  );
  /** Applies a scan job's state to its image; true once the job has finished. */
  const applyScan = useCallback(
    (job: {
      id: string;
      state: string;
      result?: { status?: string } | null;
    }) => {
      const id = scanJobs.current.get(job.id);
      if (!id) return true;
      if (job.state === "succeeded") {
        setImage(id, job.result?.status === "clean" ? "clean" : "rejected");
        scanJobs.current.delete(job.id);
        return true;
      }
      if (job.state === "dead_letter" || job.state === "failed") {
        setImage(id, "failed");
        scanJobs.current.delete(job.id);
        return true;
      }
      return false;
    },
    [setImage],
  );
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
  /** The section on screen. The inbox stays mounted underneath Knowledge, keeping its place. */
  // The section on screen; Settings has an address per page (`#settings/<page>`).
  const [area, setAreaState] = useState<
    "inbox" | "knowledge" | "settings" | "zoe" | "workflows" | "people" | "outbound" | "reports"
  >(() =>
    settingsFromHash()
      ? "settings"
      : zoeFromHash() || oauthReturn()
        ? "zoe"
        : workflowsFromHash() !== null
          ? "workflows"
          : peopleFromHash() !== null
            ? "people"
            : outboundFromHash() !== null
              ? "outbound"
              : reportsFromHash() !== null
                ? "reports"
                : "inbox",
  );
  // The report open (`#reports/<report>`), or null for the overview.
  const [reportOpen, setReportOpen] = useState<string | null>(() => reportsFromHash() || null);
  // The Outbound page (`#outbound/...`), or null for the list.
  const [outboundPage, setOutboundPage] = useState<string | null>(() => outboundFromHash() || null);
  // The segment shown in People (`#people/<segment>`), "all-users" by default.
  const [peopleSegment, setPeopleSegment] = useState(() => peopleFromHash() || "all-users");
  // The workflow open in the builder (`#workflows/<id>`), or null for the list.
  const [workflowOpen, setWorkflowOpen] = useState<string | null>(
    () => workflowsFromHash() || null,
  );
  const [settingsPage, setSettingsPage] = useState(
    () => settingsFromHash() ?? "home",
  );
  const [zoePage, setZoePage] = useState(() => zoeFromHash() ?? (oauthReturn() ? "actions" : "overview"));
  const [knowledgeTab, setKnowledgeTab] = useState<
    "content" | "help" | "websites" | "index" | "health"
  >("content");
  const setArea = useCallback(
    (
      next: "inbox" | "knowledge" | "settings" | "zoe" | "workflows" | "people" | "outbound" | "reports",
      page = "home",
    ) => {
      setAreaState(next);
      if (next === "settings") setSettingsPage(page);
      if (next === "zoe") setZoePage(page === "home" ? "overview" : page);
      if (next === "workflows") setWorkflowOpen(page === "home" ? null : page);
      if (next === "people") setPeopleSegment(page === "home" ? "all-users" : page);
      if (next === "outbound") setOutboundPage(page === "home" ? null : page);
      if (next === "reports") setReportOpen(page === "home" ? null : page);
      const hash =
        next === "settings"
          ? "#settings" + (page === "home" ? "" : "/" + page)
          : next === "zoe"
            ? "#zoe" + (page === "home" || page === "overview" ? "" : "/" + page)
            : next === "workflows"
              ? "#workflows" + (page === "home" ? "" : "/" + page)
              : next === "people"
                ? "#people" + (page === "home" ? "" : "/" + page)
                : next === "outbound"
                  ? "#outbound" + (page === "home" ? "" : "/" + page)
                  : next === "reports"
                    ? "#reports" + (page === "home" ? "" : "/" + page)
                    : "";
      if (window.location.hash !== hash)
        history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search + hash,
        );
    },
    [],
  );
  // Phase 09 D4: back from a service's sign-in page, finish connecting the connector it was for
  // (Zoe › Actions shows how it went). The code and state never stay in the address.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const state = q.get("state");
    if (!state?.startsWith("relay_")) return;
    const code = q.get("code");
    const refused = q.get("error");
    // The app opened on Zoe › Actions (see `oauthReturn`); the code and state leave the address.
    history.replaceState(null, "", window.location.pathname + "#zoe/actions");
    const done = (v: object) => {
      try {
        sessionStorage.setItem("relay-oauth", JSON.stringify(v));
      } catch {
        // Without storage the connector still connected; the page just can't say so.
      }
      window.dispatchEvent(new Event("relay-oauth"));
    };
    if (!code) {
      done({ error: `The service didn't connect${refused ? ` (${refused})` : ""}.` });
      return;
    }
    api<{ connector: { id: string } }>("zoe-connector", { action: "oauth_finish", state, code })
      .then((d) => done({ id: d.connector.id, ok: true }))
      .catch((e) => done({ error: e instanceof Error ? e.message : "The connection failed." }));
  }, []);
  // Back and forward, or a link to a settings page, move to it.
  useEffect(() => {
    const onHash = () => {
      const page = settingsFromHash();
      const zoe = zoeFromHash();
      const workflow = workflowsFromHash();
      const people = peopleFromHash();
      const outbound = outboundFromHash();
      const reports = reportsFromHash();
      if (page) {
        setAreaState("settings");
        setSettingsPage(page);
      } else if (zoe) {
        setAreaState("zoe");
        setZoePage(zoe);
      } else if (workflow !== null) {
        setAreaState("workflows");
        setWorkflowOpen(workflow || null);
      } else if (people !== null) {
        setAreaState("people");
        setPeopleSegment(people || "all-users");
      } else if (outbound !== null) {
        setAreaState("outbound");
        setOutboundPage(outbound || null);
      } else if (reports !== null) {
        setAreaState("reports");
        setReportOpen(reports || null);
      } else if (window.location.hash === "")
        setAreaState((a) =>
          a === "settings" || a === "zoe" || a === "workflows" || a === "people" || a === "outbound" || a === "reports" ? "inbox" : a,
        );
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const inboxMenu = useSideMenu("inbox");
  const [inboxCount, setInboxCount] = useState<string | null>(null);
  const [theme, setTheme] = useAgentTheme();
  const [overlay, setOverlay] = useState<
    | "palette"
    | "shortcuts"
    | "snooze"
    | "notifications"
    | "macros"
    | "macro-manager"
    | "tracker"
    | null
  >(null);
  const [notificationCount, setNotificationCount] = useState(0);
  const [macroList, setMacroList] = useState<MacroList | null>(null);
  const [macroNotice, setMacroNotice] = useState("");
  // Details sidebar: open by default on wide screens; the choice is remembered in this browser
  // (a UI preference only, never conversation data).
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      const saved = window.localStorage.getItem("relay.sidebar");
      if (saved) return saved === "open";
    } catch {
      // Storage may be unavailable; fall back to the screen width.
    }
    return window.innerWidth >= 1200;
  });
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => {
      try {
        window.localStorage.setItem("relay.sidebar", open ? "closed" : "open");
      } catch {
        // Not remembered; the toggle still works for this page.
      }
      return !open;
    });
  }, []);
  // Other teammates viewing or writing, and this teammate's own writing signal.
  const {
    activity,
    onSignal: onActivity,
    clear: clearActivity,
  } = useTeammateActivity(snapshot?.teammate.id ?? "");
  const sendFrame = useCallback((frame: Record<string, unknown>) => {
    if (ready.current && socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify(frame));
  }, []);
  const writing = useWritingSignal(sendFrame);
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
  // Whether the reader is at the newest message, so updates only follow it when they were.
  // Without this, any live update (even a replay with nothing new) pulled a teammate reading
  // older history back to the bottom.
  const following = useRef(true);
  // The timeline's height after the last update. Scroll events arrive a frame late, so an update
  // landing just after the reader scrolled up still sees `following` as true; comparing the
  // current position with this height catches that (a rare flake in the scroll-back test).
  const laidOut = useRef(0);
  const shown = useRef({ id: "", pending: 0 });
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
          if (frame.type === "viewing" || frame.type === "typing")
            onActivity(frame);
          if (frame.type === "unread" && frame.viewCounts)
            setViewCounts(frame.viewCounts);
          if (
            frame.type === "unread" &&
            typeof frame.notifications === "number"
          )
            setNotificationCount(frame.notifications);
          if (frame.type === "job") {
            setViewRevision((n) => n + 1);
            window.dispatchEvent(
              new CustomEvent("relay:job", { detail: frame }),
            );
            applyScan(frame);
          }
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
    applyScan,
    onActivity,
  ]);

  useLayoutEffect(() => {
    const el = timelineRef.current;
    // Follow the newest message when opening a conversation, after sending, or when the reader
    // was already there; otherwise keep their place.
    const opened = shown.current.id !== selectedRef.current,
      sent = pending.length > shown.current.pending;
    shown.current = { id: selectedRef.current, pending: pending.length };
    if (anchor.current && el) {
      el.scrollTop =
        anchor.current.top + el.scrollHeight - anchor.current.height;
      anchor.current = null;
    } else {
      // Where the reader is now, against the content as it was before this update.
      const stillAtBottom =
        !el || laidOut.current - el.scrollTop - el.clientHeight < 80;
      if (opened || sent || (following.current && stillAtBottom)) {
        bottom.current?.scrollIntoView({ block: "nearest" });
        following.current = true;
      } else following.current = false;
    }
    if (el) laidOut.current = el.scrollHeight;
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
    writing.stop();
    setMacroNotice("");
    if (selectedRef.current) clearActivity(selectedRef.current);
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
  // "Still viewing" while a conversation is open; switching mode ends the writing signal.
  useEffect(() => {
    if (!selected) return;
    const timer = setInterval(
      () => sendFrame({ type: "viewing", conversationId: selected }),
      VIEWING_REFRESH_MS,
    );
    return () => clearInterval(timer);
  }, [selected, sendFrame]);
  const { stop: stopWriting } = writing;
  useEffect(() => stopWriting, [mode, stopWriting]);
  const here = describeActivity(
    activity[selected] ?? {},
    (id) => snapshot?.teammates.find((t) => t.id === id)?.name ?? "A teammate",
  );
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
  const canMacros = !!snapshot?.capabilities.macros;
  const loadMacros = useCallback(
    () => api<MacroList>("macros").then(setMacroList).catch(report),
    [report],
  );
  useEffect(() => {
    if (canMacros) void loadMacros();
  }, [canMacros, loadMacros]);
  // Managing macros happens in Settings › Macros when the workspace has Settings.
  const manageMacros = () => {
    if (snapshot?.capabilities.settings) {
      setOverlay(null);
      setArea("settings", "macros");
    } else setOverlay("macro-manager");
  };
  // A new notification gets your attention the ways you chose (Settings › Notifications).
  const lastCount = useRef<number | null>(null);
  useEffect(() => {
    const prefs = snapshot?.profile?.notifications;
    if (
      prefs &&
      lastCount.current !== null &&
      notificationCount > lastCount.current
    )
      alertTeammate(prefs, notificationCount);
    lastCount.current = notificationCount;
  }, [notificationCount, snapshot?.profile?.notifications]);
  // Ticket states for macros and bulk actions, as "Type: State". Off (or absent) means none.
  const [ticketStates, setTicketStates] = useState<
    { id: string; name: string }[]
  >([]);
  // Open trackers, for the bulk bar's "Link to tracker".
  const [trackers, setTrackers] = useState<{ id: string; name: string }[]>([]);
  const [ticketsOn, setTicketsOn] = useState(false);
  const loadTicketStates = useCallback(
    () =>
      api<{
        types: { name: string; states: { id: string; name: string }[] }[];
      }>("ticket-types")
        .then(async (r) => {
          setTicketsOn(true);
          setTicketStates(
            r.types.flatMap((t) =>
              t.states.map((s) => ({ id: s.id, name: `${t.name}: ${s.name}` })),
            ),
          );
          const list = await api<{
            trackers: { id: string; number: number; title: string }[];
          }>("tickets");
          setTrackers(
            list.trackers.map((t) => ({
              id: t.id,
              name: `#${t.number} ${t.title}`,
            })),
          );
        })
        .catch(() => {
          setTicketsOn(false);
          setTicketStates([]);
          setTrackers([]);
        }),
    [],
  );
  useEffect(() => {
    void loadTicketStates();
  }, [loadTicketStates]);
  // Components outside the views list (the tracker broadcast) ask for job progress this way.
  useEffect(() => {
    const onSubscribe = (e: Event) => {
      if (ready.current)
        socket.current?.send(
          JSON.stringify({
            type: "subscribe_job",
            jobId: (e as CustomEvent<string>).detail,
          }),
        );
    };
    window.addEventListener("relay:subscribe-job", onSubscribe);
    return () => window.removeEventListener("relay:subscribe-job", onSubscribe);
  }, []);
  /**
   * Applies a macro: its actions run on the server at once (all or nothing), and its text, with
   * variables filled, is added to the composer in the macro's mode for review before sending.
   */
  async function applyMacro(m: Macro) {
    const conversationId = selectedRef.current;
    if (!conversationId) return;
    setMacroNotice("");
    try {
      const result = await api<{
        mode: "reply" | "note";
        doc: RichDoc | null;
        applied: number;
        macro: string;
      }>("macros", {
        action: "apply",
        macroId: m.id,
        conversationId,
        timezone: timeZone(),
      });
      setMode(result.mode);
      if (result.doc) {
        const key = drafts.keyOf(conversationId, result.mode);
        const existing = drafts.drafts[key]?.doc;
        drafts.edit(
          conversationId,
          result.mode,
          existing
            ? {
                type: "doc",
                content: [...existing.content, ...result.doc.content],
              }
            : result.doc,
        );
        reseed(key);
      }
      setMacroNotice(
        `Applied “${result.macro}”` +
          (result.applied
            ? ` · ${result.applied} action${result.applied > 1 ? "s" : ""}`
            : "") +
          (result.doc ? " · review the text, then send" : ""),
      );
      await load();
    } catch (e) {
      report(e);
    }
  }
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
          ...(snapshot ? activeTags(snapshot) : []).map((t) => ({
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
    ...(selected && canMacros
      ? (macroList?.macros ?? []).map((m) => ({
          id: "macro-" + m.id,
          group: "Macro",
          label: "Apply macro: " + m.name,
          run: () => void applyMacro(m),
        }))
      : []),
    ...(canMacros
      ? [
          {
            id: "macros",
            group: "Macro",
            label: "Manage macros",
            run: manageMacros,
          },
        ]
      : []),
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
    ...(selected
      ? [
          {
            id: "details",
            group: "Conversation",
            label: sidebarOpen
              ? "Hide conversation details"
              : "Show conversation details",
            keys: "I",
            run: toggleSidebar,
          },
        ]
      : []),
    {
      id: "notifications",
      group: "Navigate",
      label: "Open notifications",
      run: () => setOverlay("notifications"),
    },
    {
      id: "next",
      group: "Navigate",
      label: "Next conversation",
      keys: "Shift N",
      run: () => window.dispatchEvent(new CustomEvent("relay:next")),
    },
    ...(ticketsOn
      ? [
          {
            id: "tracker",
            group: "Tickets",
            label: "Create tracker ticket",
            run: () => setOverlay("tracker"),
          },
        ]
      : []),
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
      else if (key === "N")
        run(() => window.dispatchEvent(new CustomEvent("relay:next")));
      else if (!selectedRef.current) return;
      else if (key === "x")
        run(() =>
          window.dispatchEvent(
            new CustomEvent("relay:bulk-toggle", {
              detail: selectedRef.current,
            }),
          ),
        );
      else if (key === "r") run(() => focusComposer("reply"));
      else if (key === "n") run(() => focusComposer("note"));
      else if (key === "e")
        run(() => void act({ action: "close" }, { status: "closed" }));
      else if (key === "E")
        run(() => void act({ action: "reopen" }, { status: "open" }));
      else if (key === "s") run(() => setOverlay("snooze"));
      else if (key === "m" && canMacros) run(() => setOverlay("macros"));
      else if (key === "i") run(toggleSidebar);
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
  // Images must finish checking before sending; blocked ones must be removed.
  const imageHold = (draft?.doc ? imageIds(draft.doc) : [])
    .map((id) => imageStates[id])
    .find((st) => st && st !== "clean");
  /** Uploads chosen, pasted or dropped images and places each in the message at once. */
  async function addImages(files: File[]) {
    setImageError("");
    const conversationId = selected,
      audience = mode === "note" ? "internal" : "customer_visible";
    for (const file of files) {
      const problem = imageProblem(file);
      if (problem) {
        setImageError(problem);
        continue;
      }
      let id = "";
      try {
        const upload = await startImageUpload(file, conversationId, audience);
        id = upload.attachmentId;
        setImage(id, "uploading");
        composer.current?.insertImage(
          id,
          file.name.replace(/\.[a-z0-9]+$/i, ""),
        );
        const jobId = await upload.done;
        setImage(id, "scanning");
        scanJobs.current.set(jobId, id);
        if (ready.current)
          socket.current?.send(
            JSON.stringify({ type: "subscribe_job", jobId }),
          );
        void watchScan(jobId);
      } catch (e) {
        if (id) setImage(id, "failed");
        setImageError(
          e instanceof Error ? e.message : "The image could not be added.",
        );
      }
    }
  }
  /** Fallback when a pushed job update is missed: poll the job until it finishes. */
  async function watchScan(jobId: string) {
    for (let i = 0; i < 40 && scanJobs.current.has(jobId); i++) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!scanJobs.current.has(jobId)) return;
      try {
        const job = await api<{
          id: string;
          state: string;
          result?: { status?: string };
        }>("job?" + new URLSearchParams({ id: jobId }));
        if (applyScan(job)) return;
      } catch {
        // Keep waiting; the socket may still deliver the result.
      }
    }
  }
  async function send() {
    const doc = draft?.doc;
    if (
      !selected ||
      !doc ||
      imageHold ||
      pending.some((p) => p.conversationId === selected)
    )
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
            ...(mode === "reply" && replyTarget?.copies && (copies.current.cc.trim() || copies.current.bcc.trim())
              ? { email: { cc: splitCopies(copies.current.cc), bcc: splitCopies(copies.current.bcc) } }
              : {}),
          };
    const key = draftKey;
    failed.current.set(key, item);
    setPending((items) => [...items, item]);
    writing.stop();
    drafts.sent(item.conversationId, item.mode);
    reseed(key);
    setError("");
    try {
      const result = await api<{ partId: string }>(
        "command",
        {
          action: item.mode,
          conversationId: item.conversationId,
          // Your signature goes on replies as they're sent; the draft (and a failed send's
          // restored text) stays without it, so it's never added twice.
          doc:
            item.mode === "reply" && snapshot?.profile?.signature
              ? withSignature(item.doc, snapshot.profile.signature)
              : item.doc,
          // E4: copies on an email reply.
          ...(item.email ? { email: item.email } : {}),
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
  const storage = snapshot
    ? `PostgreSQL · ${snapshot.storage.transport === "local-pglite" ? "local" : "Hyperdrive"}`
    : "Connecting to PostgreSQL";
  // After the list's title: the connection (its store as a tooltip) and the workload controls.
  const listExtras = (
    <>
      <span
        className={connection === "Live" ? "pg-live" : "pg-muted"}
        role="status"
        title={storage}
      >
        ● {connection}
      </span>
      <span className="pg-visually-hidden" data-testid="storage-source">
        {storage}
      </span>
      <WorkloadBar
        revision={viewRevision}
        onOpen={(id) => pick(id)}
        onEditTeams={
          snapshot?.capabilities.settings
            ? () => setArea("settings", "teams")
            : undefined
        }
      />
    </>
  );
  return (
    <AgentName.Provider value={snapshot?.ai?.name ?? "Zoe"}>
    <main className="pg-inbox">
      <Rail
        items={[
          {
            id: "inbox",
            label: "Inbox",
            icon: <Inbox size={19} />,
            hue: "blue",
            badge: inboxCount ?? undefined,
            current: area === "inbox",
            onClick: () => setArea("inbox"),
          },
          // Zoe sits between Inbox and Knowledge, as the AI agent does in Beacon and Intercom.
          ...(snapshot?.capabilities.zoe
            ? [
                {
                  id: "zoe",
                  label: snapshot.ai?.name ?? "Zoe",
                  ariaLabel: `${snapshot.ai?.name ?? "Zoe"}, AI agent`,
                  icon: <Sparkles size={14} />,
                  hue: "zoe",
                  current: area === "zoe",
                  onClick: () => setArea("zoe", "overview"),
                },
              ]
            : []),
          // Workflows (phase 11 W2) sit beside Zoe: automation, as in Intercom's AI agent menu.
          ...(snapshot?.capabilities.workflows
            ? [
                {
                  id: "workflows",
                  label: "Workflows",
                  icon: <Workflow size={19} />,
                  hue: "sky",
                  current: area === "workflows",
                  onClick: () => setArea("workflows"),
                },
              ]
            : []),
          ...(snapshot?.capabilities.knowledge
            ? [
                {
                  id: "knowledge",
                  label: "Knowledge",
                  icon: <BookOpen size={19} />,
                  hue: "amber",
                  current: area === "knowledge",
                  onClick: () => {
                    setKnowledgeTab("content");
                    setArea("knowledge");
                  },
                },
              ]
            : []),
          // People (phase 13 O1): contacts and segments, as Intercom's Contacts.
          ...(snapshot?.capabilities.people
            ? [
                {
                  id: "people",
                  label: "People",
                  icon: <Contact size={19} />,
                  hue: "teal",
                  current: area === "people",
                  onClick: () => setArea("people", peopleSegment),
                },
              ]
            : []),
          // Reports (phase 14 R3) sit just before Outbound, as in Intercom's strip.
          ...(snapshot?.capabilities.reports || snapshot?.capabilities.live
            ? [
                {
                  id: "reports",
                  label: "Reports",
                  icon: <ChartColumnBig size={19} />,
                  hue: "violet",
                  current: area === "reports",
                  onClick: () => setArea("reports"),
                },
              ]
            : []),
          // Outbound (phase 13 O3): messages to people, as Intercom's Outbound.
          ...(snapshot?.capabilities.outbound
            ? [
                {
                  id: "outbound",
                  label: "Outbound",
                  icon: <Send size={19} />,
                  hue: "green",
                  current: area === "outbound",
                  onClick: () => setArea("outbound"),
                },
              ]
            : []),
        ]}
        tools={[
          {
            id: "notifications",
            label: "Notifications",
            ariaLabel: `Notifications, ${notificationCount} unread`,
            icon: <Bell size={19} />,
            hue: "rose",
            badge:
              notificationCount > 0
                ? notificationCount > 99
                  ? "99+"
                  : String(notificationCount)
                : undefined,
            onClick: () => setOverlay("notifications"),
          },
          {
            id: "shortcuts",
            label: "Shortcuts",
            icon: <Keyboard size={19} />,
            hue: "violet",
            onClick: () => setOverlay("shortcuts"),
          },
          ...(snapshot?.capabilities.settings
            ? [
                {
                  id: "settings",
                  label: "Settings",
                  icon: <SettingsIcon size={19} />,
                  hue: "slate",
                  current: area === "settings",
                  onClick: () => setArea("settings"),
                },
              ]
            : []),
        ]}
        account={
          snapshot ? (
            <AccountMenu
              account={{
                name: snapshot.teammate.name,
                role: snapshot.account?.role ?? "",
                workspace: snapshot.account?.workspace ?? {
                  id: snapshot.storage.workspaceId,
                  name: snapshot.storage.workspaceId,
                },
                email: hosting.email,
                signOutHref: hosting.signOutHref,
              }}
              theme={theme}
              onTheme={setTheme}
              onProfile={
                snapshot.capabilities.settings
                  ? () => setArea("settings", "profile")
                  : undefined
              }
            />
          ) : (
            <div className="pg-nav-foot" title="Authenticated inbox">
              <LockKeyhole size={16} aria-hidden="true" />
              <span className="pg-rail-label">Authenticated inbox</span>
            </div>
          )
        }
      />
      {area === "knowledge" && snapshot?.capabilities.knowledge && (
        <Suspense
          fallback={<section className="pg-workspace" aria-busy="true" />}
        >
          <Knowledge
            key={knowledgeTab}
            teammates={snapshot.teammates}
            initialTab={knowledgeTab}
          />
        </Suspense>
      )}
      {area === "zoe" && snapshot?.capabilities.zoe && (
        <Suspense
          fallback={<section className="pg-workspace" aria-busy="true" />}
        >
          <Zoe
            page={zoePage}
            onPage={(page) => setArea("zoe", page)}
            onName={(name) =>
              setSnapshot((s) => s && { ...s, ai: { ...(s.ai ?? { enabled: true }), name } })
            }
            onKnowledge={() => {
              setKnowledgeTab("content");
              setArea("knowledge");
            }}
            onMessenger={() => setArea("settings", "messenger")}
            onConversation={(id) => {
              setArea("inbox");
              pick(id);
            }}
          />
        </Suspense>
      )}
      {area === "workflows" && snapshot?.capabilities.workflows && (
        <Suspense
          fallback={<section className="pg-workspace" aria-busy="true" />}
        >
          <Workflows
            open={workflowOpen}
            onOpen={(id) => setArea("workflows", id ?? "home")}
            onConversation={(id) => {
              setArea("inbox");
              pick(id);
            }}
          />
        </Suspense>
      )}
      {area === "people" && snapshot?.capabilities.people && (
        <Suspense
          fallback={<section className="pg-workspace" aria-busy="true" />}
        >
          <People segment={peopleSegment} onSegment={(id) => setArea("people", id)} />
        </Suspense>
      )}
      {area === "outbound" && snapshot?.capabilities.outbound && (
        <Suspense
          fallback={<section className="pg-workspace" aria-busy="true" />}
        >
          <OutboundArea open={outboundPage} onOpen={(page) => setArea("outbound", page ?? "home")} />
        </Suspense>
      )}
      {area === "reports" && (snapshot?.capabilities.reports || snapshot?.capabilities.live) && (
        <Suspense
          fallback={<section className="pg-workspace" aria-busy="true" />}
        >
          <ReportsArea
            open={reportOpen}
            onOpen={(id) => setArea("reports", id ?? "home")}
            directory={{ teammates: snapshot.teammates, teams: snapshot.teams }}
            zoeName={snapshot.ai?.name ?? "Zoe"}
            history={!!snapshot.capabilities.reports}
            live={!!snapshot.capabilities.live}
            onConversation={(id) => {
              setArea("inbox");
              pick(id);
            }}
          />
        </Suspense>
      )}
      {area === "settings" && snapshot?.capabilities.settings && (
        <Suspense
          fallback={<section className="pg-workspace" aria-busy="true" />}
        >
          <Settings
            page={settingsPage}
            onPage={(page) => setArea("settings", page)}
            onDirectory={() => void load()}
            theme={theme}
            onTheme={setTheme}
            macros={{
              list: macroList,
              dir: {
                teammates: snapshot.teammates,
                teams: snapshot.teams,
                tags: snapshot.tags,
                ticketStates,
              },
              onChanged: () => void loadMacros(),
            }}
            onLink={(target) => {
              if (target === "ai-agent") {
                setArea("zoe", "overview");
                return;
              }
              if (target === "workflows") {
                setArea("workflows");
                return;
              }
              if (target === "views") {
                setArea("inbox");
                inboxMenu.setHidden(false);
                return;
              }
              setKnowledgeTab(
                target === "help-centers"
                  ? "help"
                  : target === "websites"
                    ? "websites"
                    : target === "content-health"
                      ? "health"
                      : "index",
              );
              setArea("knowledge");
            }}
            onProfile={(p) =>
              setSnapshot(
                (s) =>
                  s && {
                    ...s,
                    teammate: { ...s.teammate, name: p.name },
                    profile: {
                      signature: p.signature,
                      notifications: p.notifications,
                    },
                  },
              )
            }
          />
        </Suspense>
      )}
      <section
        className="pg-workspace"
        hidden={
          (area === "knowledge" && !!snapshot?.capabilities.knowledge) ||
          (area === "settings" && !!snapshot?.capabilities.settings) ||
          (area === "zoe" && !!snapshot?.capabilities.zoe) ||
          (area === "workflows" && !!snapshot?.capabilities.workflows) ||
          (area === "people" && !!snapshot?.capabilities.people) ||
          (area === "outbound" && !!snapshot?.capabilities.outbound) ||
          (area === "reports" && !!(snapshot?.capabilities.reports || snapshot?.capabilities.live))
        }
      >
        {error && (
          <div className="pg-error" role="alert">
            {error}
            <button onClick={() => setRetry((n) => n + 1)}>
              <RefreshCw size={14} /> Reconnect
            </button>
          </div>
        )}
        <div className="pg-columns">
          {snapshot?.capabilities.views ? (
            <InboxViews
              menu={inboxMenu}
              // Phase 14 R4: the live dashboard, reached from the inbox (the gap audit's ask).
              onLive={snapshot?.capabilities.live ? () => setArea("reports", "live") : undefined}
              headerExtras={listExtras}
              onInboxCount={setInboxCount}
              me={me}
              dir={{
                teammates: snapshot?.teammates ?? [],
                teams: snapshot?.teams ?? [],
                tags: snapshot?.tags ?? [],
                ticketStates,
                trackers,
              }}
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
            <section className="pg-list" aria-label="Conversations">
              <ListHeader title="Inbox" level={1}>
                {listExtras}
              </ListHeader>
              <h2 className="pg-list-sub">Recent conversations</h2>
              {snapshot?.conversations.map((c) => (
                <ConversationCard
                  key={c.id}
                  row={c}
                  selected={c.id === selected}
                  assignee={
                    snapshot.teammates.find((t) => t.id === c.assigned)?.name
                  }
                  me={me}
                  onOpen={() => pick(c.id)}
                  onPrefetch={() => prefetch(c.id)}
                />
              ))}
              {snapshot?.conversations.length === 0 && (
                <p className="pg-empty">
                  New conversations will appear here automatically.
                </p>
              )}
            </section>
          )}
          <section className="pg-thread" aria-label="Conversation timeline">
            {selected ? (
              <>
                <header className="pg-thread-title">
                  <div className="pg-thread-who">
                    <span
                      className="pg-avatar"
                      data-hue={hueOf(conversation?.name || "Customer")}
                      aria-hidden="true"
                    >
                      {initials(conversation?.name || "Customer")}
                    </span>
                    <div>
                      <p className="pg-thread-name">
                        <strong>{conversation?.name || "Customer"}</strong>
                        {conversation?.email && (
                          <span> · {conversation.email}</span>
                        )}
                      </p>
                      <h2 title={conversation?.title ?? "Conversation"}>
                        {conversation?.title ?? "Conversation"}
                      </h2>
                    </div>
                    <SlaBadge
                      dueAt={conversation?.sla_next_due_at ?? null}
                      overdue={!!conversation?.sla_overdue}
                      chip
                    />
                  </div>
                  <p
                    className="pg-activity"
                    role="status"
                    aria-live="polite"
                    data-testid="teammate-activity"
                  >
                    {here.text}
                  </p>
                  {mode === "reply" && here.replying.length > 0 && (
                    <p className="pg-collision" role="alert">
                      {here.replying.join(" and ")}{" "}
                      {here.replying.length === 1 ? "is" : "are"} also replying.
                      Check before you send.
                    </p>
                  )}
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
                    <span className="pg-header-icons">
                      <button
                        className="pg-icon-action"
                        aria-label="Priority"
                        title={
                          conversation?.priority
                            ? "Remove priority (P)"
                            : "Mark as priority (P)"
                        }
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
                        <Flag
                          size={16}
                          aria-hidden="true"
                          fill={
                            conversation?.priority ? "currentColor" : "none"
                          }
                        />
                      </button>
                      <Menu
                        iconOnly
                        className="align-end"
                        buttonLabel="More actions"
                        title="More actions"
                        button={<MoreHorizontal size={16} aria-hidden="true" />}
                        menuLabel="More actions"
                        items={[
                          {
                            value: "details",
                            label: sidebarOpen
                              ? "Hide conversation details"
                              : "Show conversation details",
                            icon: <PanelRight size={15} />,
                          },
                          {
                            value: "export",
                            label: "Export conversation as text",
                            icon: <FileText size={15} />,
                          },
                          {
                            value: "palette",
                            label: "Command palette",
                            icon: <Command size={15} />,
                            divider: true,
                          },
                          {
                            value: "shortcuts",
                            label: "Keyboard shortcuts",
                            icon: <Keyboard size={15} />,
                          },
                        ]}
                        onSelect={(value) => {
                          if (value === "details") toggleSidebar();
                          else if (value === "shortcuts")
                            setOverlay("shortcuts");
                          else if (value === "palette") setOverlay("palette");
                          else if (value === "export" && selected)
                            void exportConversation(
                              selected,
                              conversation?.title ?? "",
                              parts,
                              cache.current.get(selected)?.older,
                            ).catch(report);
                        }}
                      />
                      {ticketsOn && (
                        <button
                          className="pg-icon-action"
                          aria-label="Convert to ticket"
                          title="Convert to ticket"
                          onClick={() => {
                            if (!selected) return;
                            if (!sidebarOpen) toggleSidebar();
                            requestConvert(selected);
                          }}
                        >
                          <Ticket size={16} aria-hidden="true" />
                        </button>
                      )}
                      <button
                        className="pg-icon-action"
                        aria-label="Snooze"
                        title="Snooze (S)"
                        onClick={() => setOverlay("snooze")}
                      >
                        <Clock size={16} aria-hidden="true" />
                      </button>
                    </span>
                    {conversation?.status === "open" ? (
                      <button
                        className="pg-close-action"
                        title="Close (E)"
                        onClick={() =>
                          void act({ action: "close" }, { status: "closed" })
                        }
                      >
                        <CheckCircle size={14} /> Close
                      </button>
                    ) : (
                      <button
                        className="pg-close-action"
                        title="Reopen (Shift E)"
                        onClick={() =>
                          void act({ action: "reopen" }, { status: "open" })
                        }
                      >
                        <RotateCcw size={14} /> Reopen
                      </button>
                    )}
                    <button
                      className="pg-icon-action"
                      aria-label="Details"
                      title="Conversation details (I)"
                      aria-pressed={sidebarOpen}
                      onClick={toggleSidebar}
                    >
                      <PanelRight size={16} aria-hidden="true" />
                    </button>
                  </div>
                </header>
                <div
                  className="pg-timeline"
                  role="log"
                  aria-label="Messages"
                  ref={timelineRef}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    following.current =
                      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                    if (el.scrollTop < 200 && olderState === "idle")
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
                    customer={conversation?.name}
                    aiSpecialist={conversation?.ai_specialist_id ?? null}
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
                      <div key={p.id} className="pg-bubble-row team">
                        <span
                          className="pg-avatar pg-bubble-avatar"
                          data-hue={hueOf(snapshot?.teammate.name ?? "You")}
                          aria-hidden="true"
                        >
                          {initials(snapshot?.teammate.name ?? "You")}
                        </span>
                        <article
                          className={
                            p.mode === "note"
                              ? "pg-message pg-note pg-pending"
                              : "pg-message from-team pg-pending"
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
                      </div>
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
                        : replyTarget
                          ? "Visible to the customer, by email"
                          : "Visible to the customer"}
                    </small>
                    {selected && <SideConversationButton conversationId={selected} refresh={parts.length} />}
                    {canMacros && (
                      <button
                        type="button"
                        className="pg-macros-button"
                        title="Macros (M)"
                        onClick={() => setOverlay("macros")}
                      >
                        <Zap size={14} aria-hidden="true" /> Macros{" "}
                        <kbd aria-hidden="true">M</kbd>
                      </button>
                    )}
                  </div>
                  {mode === "reply" && replyTarget && (
                    // Phase 12 E3/E4: where the reply goes, and (where the channel takes them) copies.
                    <div className="pg-reply-bar">
                      <ReplyTarget target={replyTarget} />
                      {replyTarget.copies && <EmailCopies key={selected + "|" + (replyTarget.cc ?? "")} initialCc={replyTarget.cc ?? ""} onChange={keepCopies} />}
                      {replyTarget.maxSegments !== undefined && (
                        <SmsMeter text={draft?.doc ? plainText(draft.doc) : ""} max={replyTarget.maxSegments} price={replyTarget.price} />
                      )}
                      {replyTarget.templates && replyTarget.templates.length > 0 && (
                        <TemplatePicker key={selected} conversationId={selected} templates={replyTarget.templates} onSent={() => {}} />
                      )}
                    </div>
                  )}
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
                      onChange={(doc) => {
                        drafts.edit(selected, mode, doc);
                        if (doc) writing.typed(selected, mode);
                        else writing.stop();
                      }}
                      onSubmit={() => void send()}
                      onFiles={(files) => void addImages(files)}
                      imageStatus={(id) => imageStates[id]}
                      mentionables={
                        mode === "note"
                          ? [
                              ...(snapshot?.teammates ?? [])
                                .filter((t) => t.id !== me)
                                .map((t) => ({
                                  kind: "teammate" as const,
                                  id: t.id,
                                  label: t.name,
                                })),
                              ...(snapshot?.teams ?? []).map((t) => ({
                                kind: "team" as const,
                                id: t.id,
                                label: t.name,
                              })),
                            ]
                          : null
                      }
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
                    {!canSend && (
                      <span>Your role cannot perform this action.</span>
                    )}
                    {macroNotice && (
                      <small className="pg-macro-notice" role="status">
                        {macroNotice}
                      </small>
                    )}
                    {imageError && (
                      <span className="pg-image-error" role="alert">
                        {imageError}
                      </span>
                    )}
                    {imageHold && (
                      <small className="pg-image-hold" aria-live="polite">
                        {imageHold === "rejected" || imageHold === "failed"
                          ? "Remove blocked images to send"
                          : "Waiting for images to finish checking…"}
                      </small>
                    )}
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
                        !!imageHold ||
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
          {selected && sidebarOpen && (
            <ContextSidebar
              conversationId={selected}
              // Any new part can change the details: attributes, tickets, SLA clocks (a reply
              // stops a response clock).
              refresh={parts.length}
              onOpen={(id) => pick(id)}
              onError={report}
            />
          )}
        </div>
      </section>
      {overlay === "palette" && (
        <CommandPalette commands={commands} onClose={() => setOverlay(null)} />
      )}
      {overlay === "macros" && selected && (
        <MacroPicker
          list={macroList}
          onApply={(m) => void applyMacro(m)}
          onManage={manageMacros}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "macro-manager" && (
        <MacroManager
          list={macroList}
          dir={{
            teammates: snapshot?.teammates ?? [],
            teams: snapshot?.teams ?? [],
            tags: snapshot?.tags ?? [],
            ticketStates,
          }}
          onChanged={() => void loadMacros()}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "notifications" && (
        <NotificationsPanel
          onOpen={(id) => pick(id)}
          onIncident={() => setArea("zoe", "incidents")}
          onWorkflowAlert={(id) => setArea("workflows", id ? `runs/${id}` : "runs")}
          onClose={() => setOverlay(null)}
          onError={report}
        />
      )}
      {overlay === "tracker" && (
        <CreateInternal
          category="tracker"
          onCreated={(id) => {
            setOverlay(null);
            void loadTicketStates();
            pick(id);
          }}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "shortcuts" && (
        <ShortcutSheet onClose={() => setOverlay(null)} />
      )}
      {overlay === "snooze" && selected && (
        <SnoozeMenu onSnooze={snooze} onClose={() => setOverlay(null)} />
      )}
    </main>
    </AgentName.Provider>
  );
}
