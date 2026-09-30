import { useCallback, useEffect, useRef, useState } from "react";

type Mode = "reply" | "note";
/** What one teammate is doing in a conversation: viewing and/or writing, each until a time. */
export type Peer = { view?: number; write?: { mode: Mode; until: number } };
type Signal = {
  type?: string;
  conversationId?: string;
  teammateId?: string;
  authorType?: string;
  authorId?: string;
  mode?: string;
  active?: boolean;
  expiresAt?: number;
};
/** Refresh "viewing" this often; the server lets it expire after 45 seconds. */
export const VIEWING_REFRESH_MS = 30_000;
const TYPING_THROTTLE_MS = 2_000,
  TYPING_IDLE_MS = 4_000,
  PRUNE_MS = 1_000;

/**
 * Other teammates' activity per conversation, from pushed `viewing` and `typing` signals.
 * Entries expire at the time the signal carries; the teammate's own other tabs are ignored.
 */
export function useTeammateActivity(me: string) {
  const [all, setAll] = useState<Record<string, Record<string, Peer>>>({});
  const self = useRef(me);
  useEffect(() => {
    self.current = me;
  });
  const onSignal = useCallback((s: Signal) => {
    const conversation = s.conversationId;
    const teammate =
      s.type === "viewing"
        ? s.teammateId
        : s.authorType === "teammate"
          ? s.authorId
          : undefined;
    if (!conversation || !teammate || teammate === self.current) return;
    if (s.type !== "viewing" && s.type !== "typing") return;
    setAll((prev) => {
      const peers = { ...prev[conversation] };
      const peer: Peer = { ...peers[teammate] };
      if (s.type === "viewing") {
        if (s.active) peer.view = s.expiresAt;
        else return { ...prev, [conversation]: omit(peers, teammate) };
      } else if (s.active)
        peer.write = {
          mode: s.mode === "reply" ? "reply" : "note",
          until: s.expiresAt ?? 0,
        };
      else delete peer.write;
      return { ...prev, [conversation]: { ...peers, [teammate]: peer } };
    });
  }, []);
  // Drop expired entries on a timer (not during render).
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setAll((prev) => {
        let changed = false;
        const next: typeof prev = {};
        for (const [conversation, peers] of Object.entries(prev)) {
          const kept: Record<string, Peer> = {};
          for (const [id, p] of Object.entries(peers)) {
            const peer: Peer = {
              ...(p.view && p.view > now ? { view: p.view } : {}),
              ...(p.write && p.write.until > now ? { write: p.write } : {}),
            };
            if (peer.view !== p.view || peer.write !== p.write) changed = true;
            if (peer.view || peer.write) kept[id] = peer;
          }
          if (Object.keys(kept).length) next[conversation] = kept;
        }
        return changed ? next : prev;
      });
    }, PRUNE_MS);
    return () => clearInterval(timer);
  }, []);
  const clear = useCallback(
    (conversation: string) => setAll((prev) => omit(prev, conversation)),
    [],
  );
  return { activity: all, onSignal, clear };
}

function omit<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

/**
 * Sends this teammate's writing signal: at most every 2 seconds while typing, and "stopped"
 * after 4 idle seconds, on send, on a mode switch and when leaving the conversation.
 */
export function useWritingSignal(
  send: (frame: Record<string, unknown>) => void,
) {
  const state = useRef<{
    key: string;
    sentAt: number;
    idle?: ReturnType<typeof setTimeout>;
  } | null>(null);
  const stop = useCallback(() => {
    const current = state.current;
    if (!current) return;
    clearTimeout(current.idle);
    state.current = null;
    const [conversationId, mode] = current.key.split("\u0000");
    send({ type: "typing", conversationId, mode, active: false });
  }, [send]);
  const typed = useCallback(
    (conversationId: string, mode: Mode) => {
      const key = conversationId + "\u0000" + mode;
      if (state.current && state.current.key !== key) stop();
      const now = Date.now();
      if (!state.current || now - state.current.sentAt >= TYPING_THROTTLE_MS) {
        send({ type: "typing", conversationId, mode, active: true });
        state.current = { key, sentAt: now, idle: state.current?.idle };
      }
      clearTimeout(state.current.idle);
      state.current.idle = setTimeout(stop, TYPING_IDLE_MS);
    },
    [send, stop],
  );
  return { typed, stop };
}

/** "Grace is viewing", "Grace and Ada are writing replies", "Grace is writing a note". */
export function describeActivity(
  peers: Record<string, Peer>,
  name: (id: string) => string,
) {
  const list = (ids: string[]) =>
    ids.length === 1
      ? ids[0]
      : ids.slice(0, -1).join(", ") + " and " + ids[ids.length - 1];
  const entries = Object.entries(peers);
  const replying = entries
    .filter(([, p]) => p.write?.mode === "reply")
    .map(([id]) => name(id));
  const noting = entries
    .filter(([, p]) => p.write?.mode === "note")
    .map(([id]) => name(id));
  const viewing = entries
    .filter(([, p]) => p.view && !p.write)
    .map(([id]) => name(id));
  const parts = [
    replying.length &&
      `${list(replying)} ${replying.length === 1 ? "is writing a reply" : "are writing replies"}`,
    noting.length &&
      `${list(noting)} ${noting.length === 1 ? "is writing a note" : "are writing notes"}`,
    viewing.length &&
      `${list(viewing)} ${viewing.length === 1 ? "is viewing" : "are viewing"}`,
  ].filter(Boolean) as string[];
  return { text: parts.join(" · "), replying };
}
